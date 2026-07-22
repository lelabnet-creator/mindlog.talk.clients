// Mesh BitTorrent-like sur DataChannel WebRTC.
//
// Topologie : chaque viewer ouvre une RTCPeerConnection avec quelques peers
// (jusqu'à MAX_PEERS) annoncés par le roster du serveur. Chaque peer expose
// trois canaux logiques :
//   - control : "HAVE" / "WANT" / "BITFIELD" / "PING"
//   - media   : chunks (fragmented MP4 / WebM segments) — datachannel non
//               fiable / non ordonné, tolérance à la perte
//   - chat    : messages texte signés (fiable)
//
// Le broadcaster est le seed initial. Tout chunk reçu est rediffusé via HAVE
// à tous les peers ouverts. Sur WANT, on envoie le chunk si on l'a. Stratégie
// de sélection : "rarest-first" dans la fenêtre live des 8 derniers chunks.
//
// Scoring : on mesure RTT (PING), succès des WANT, bytes/s reçus. Composite
// envoyé au serveur via heartbeat (0..100). Les peers < 30 sont rétrogradés
// en "leech-only" : on ne les annonce plus comme seeds aux autres.

import { sendSignal } from "./signal.js";

const RTC_CFG = {
  iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }],
};

const MAX_PEERS = 6;
const WINDOW = 8;                 // taille de la fenêtre live
const PING_INTERVAL = 3000;
const PEER_TIMEOUT = 15000;
// Pacing : si bufferedAmount du DataChannel media dépasse ce seuil, on
// saute l'envoi du chunk pour ce peer (il pourra le redemander via WANT
// plus tard). Évite que le backlog explose côté envoi et qu'un peer lent
// fige le broadcaster en accumulant 5 Mo de retard.
const MEDIA_CONGEST_DROP_BYTES = 512 * 1024;

export class Mesh extends EventTarget {
  /**
   * @param {{ streamId:string, deviceId:string, role:'broadcaster'|'viewer',
   *           onChunk:(idx:number, payload:Uint8Array) => void,
   *           onChat:(msg:object) => void, onLog?:(msg:string) => void }} opts
   */
  constructor(opts) {
    super();
    this.streamId = opts.streamId;
    this.deviceId = opts.deviceId;
    this.role = opts.role;
    this.onChunk = opts.onChunk || (() => { });
    this.onChat = opts.onChat || (() => { });
    this.onLog = opts.onLog || ((m) => console.debug("[mesh]", m));
    this.onLog(`Mesh build=2026-06-07-mesh-fix role=${this.role}`);

    /** @type {Map<string, PeerLink>} */
    this.peers = new Map();
    /** @type {Map<number, Uint8Array>} */
    this.have = new Map();             // chunkIndex → payload (fenêtre WINDOW)
    /** @type {Map<number, Set<string>>} */
    this.peerHas = new Map();          // chunkIndex → set(deviceId)
    this.lastIndex = -1;
    this.score = 60;
  }

  // Ajoute un peer venant du roster initial. `polite` (= notre deviceId est
  // lexicographiquement plus petit) sert UNIQUEMENT à la résolution de glare
  // dans consumeSignal — pas à décider qui initie. Sinon les deux côtés
  // initiaient et la négociation pétait en silence (peers restaient à 0).
  // Si le peer EXISTE déjà mais n'a pas encore initié et qu'on nous demande
  // d'initier, on lance initiate() — cas typique : le broadcaster a ajouté
  // un peer en passif au tick syncRoster, puis le join-req arrive et lui
  // demande d'initier réellement.
  ensurePeer(remoteDeviceId, { initiate } = {}) {
    if (remoteDeviceId === this.deviceId) return null;
    let link = this.peers.get(remoteDeviceId);
    if (!link) {
      if (this.peers.size >= MAX_PEERS) return null;
      const polite = this.deviceId < remoteDeviceId;
      link = new PeerLink(this, remoteDeviceId, polite);
      this.peers.set(remoteDeviceId, link);
      this.onLog(`ensurePeer NEW ${remoteDeviceId.slice(0, 6)} polite=${polite} initiate=${!!initiate}`);
    } else {
      this.onLog(`ensurePeer existing ${remoteDeviceId.slice(0, 6)} hasControl=${!!link.control} initiate=${!!initiate}`);
    }
    if (initiate && !link.control) link.initiate();
    return link;
  }

  // Réception d'un paquet signalisation (offer/answer/ice) du backend.
  async handleSignal(packet) {
    if (packet.to !== this.deviceId) return;
    const peer = this.ensurePeer(packet.from, { initiate: false });
    if (!peer) return;
    await peer.consumeSignal(packet);
  }

  // Met à jour le roster (élargit ou élague la liste de peers).
  // Convention de négociation, pensée pour éviter qu'une offer parte avant
  // que la SSE de l'autre côté ne soit enregistrée (offer perdue, peer bloqué
  // en have-local-offer) :
  //   - BROADCASTER : ne lance JAMAIS de négociation depuis syncRoster. Il
  //     initie seulement à la réception d'un `join-req` (preuve que la SSE
  //     viewer est up). Les viewers présents en roster sont juste pré-trackés.
  //   - VIEWER : n'initie pas vers le broadcaster (attend l'offer après son
  //     `join-req`). Initie vers les autres viewers, la perfect-negotiation
  //     gère le glare via `polite`.
  async syncRoster(roster) {
    const wanted = new Set();
    for (const entry of roster) {
      if (!entry?.device_id || entry.device_id === this.deviceId) continue;
      wanted.add(entry.device_id);
      const peerIsBroadcaster = entry.role === "broadcaster";
      let shouldInitiate;
      if (this.role === "broadcaster") shouldInitiate = false;
      else if (peerIsBroadcaster) shouldInitiate = false;
      else shouldInitiate = true; // viewer ↔ viewer
      this.ensurePeer(entry.device_id, { initiate: shouldInitiate });
    }
    // Élague les peers qui ne sont plus dans le roster (offline).
    for (const id of [...this.peers.keys()]) {
      if (!wanted.has(id)) this.peers.get(id)?.close("not-in-roster");
    }
  }

  // Le broadcaster pousse un nouveau chunk (déjà chiffré). Annonce HAVE à
  // tous les peers ouverts ; ne sert pas spontanément (les peers feront WANT).
  publishChunk(index, encrypted) {
    this._cacheChunk(index, encrypted);
    for (const peer of this.peers.values()) peer.sendHave(index);
  }

  // Cache un chunk dans la fenêtre live ; les anciens sont oubliés.
  // EXCEPTION : on conserve TOUJOURS le chunk #0, qui contient l'init segment
  // WebM (EBML header + Tracks). Sans lui, `SourceBuffer.appendBuffer()` côté
  // viewer rejette tous les segments média — un viewer qui rejoint après le
  // chunk #9 ne pourrait jamais démarrer la lecture.
  _cacheChunk(index, encrypted) {
    this.have.set(index, encrypted);
    if (index > this.lastIndex) this.lastIndex = index;
    const minKept = this.lastIndex - WINDOW;
    for (const k of [...this.have.keys()]) if (k < minKept && k !== 0) this.have.delete(k);
  }

  // Reçu un HAVE d'un peer : on note qu'il l'a, et on déclenche un WANT si on
  // ne l'a pas et qu'il est dans la fenêtre.
  _onHave(peer, index) {
    let s = this.peerHas.get(index);
    if (!s) this.peerHas.set(index, (s = new Set()));
    s.add(peer.id);
    if (this.have.has(index)) return;
    // Le chunk #0 (init segment WebM) est toujours désiré, même hors fenêtre.
    if (index === 0 || index > this.lastIndex - WINDOW) {
      this._scheduleWant(index);
    }
  }

  _scheduleWant(index) {
    // Rarest-first : on prend le peer ayant ce chunk avec le moins d'autres
    // sources connues. À défaut, premier peer dispo.
    const owners = [...(this.peerHas.get(index) || [])];
    if (!owners.length) return;
    owners.sort((a, b) => (this.peers.get(a)?.served || 0) - (this.peers.get(b)?.served || 0));
    const peer = this.peers.get(owners[0]);
    if (!peer) return;
    peer.sendWant(index);
  }

  _onWant(peer, index) {
    const data = this.have.get(index);
    if (!data) return;
    peer.sendChunk(index, data);
  }

  _onChunk(peer, index, payload) {
    if (this.have.has(index)) return; // déjà reçu (course)
    this._cacheChunk(index, payload);
    peer.served += 1;
    this.onChunk(index, payload);
    for (const p of this.peers.values()) if (p !== peer) p.sendHave(index);
  }

  // Envoie un message de chat (réplique à tous les peers, TTL géré côté
  // payload — le broadcaster a un canal `chat` qui réceptionne aussi les
  // messages des viewers et les retransmet).
  publishChat(msg) {
    const j = JSON.stringify(msg);
    for (const p of this.peers.values()) p.sendChat(j);
  }

  _onChat(peer, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    // dédup par id (le broadcaster reflood, on ignore les doublons)
    if (msg.id && this._seenChat && this._seenChat.has(msg.id)) return;
    this._seenChat ||= new Set();
    if (msg.id) this._seenChat.add(msg.id);
    if (this._seenChat.size > 2000) this._seenChat = new Set();
    this.onChat(msg);
    // Repropagation TTL.
    if (typeof msg.ttl === "number" && msg.ttl > 0) {
      const next = { ...msg, ttl: msg.ttl - 1 };
      for (const p of this.peers.values()) if (p !== peer) p.sendChat(JSON.stringify(next));
    }
  }

  // Calcule un score 0..100 selon RTT moyen, bytes/s reçus, % WANT honorés.
  computeScore() {
    const peers = [...this.peers.values()].filter((p) => p.open);
    if (!peers.length) return this.role === "broadcaster" ? 90 : 30;
    const avgRtt = peers.reduce((a, p) => a + (p.rtt || 200), 0) / peers.length;
    const rttScore = Math.max(0, 100 - avgRtt / 4);    // 100→100, 400→0
    const bw = peers.reduce((a, p) => a + p.bytesIn, 0);
    const bwScore = Math.min(100, bw / 1024 / 4);      // 400 ko/s → 100
    const composite = Math.round(0.4 * bwScore + 0.4 * rttScore + 0.2 * 60);
    this.score = Math.max(10, Math.min(100, composite));
    return this.score;
  }

  destroy() {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
  }
}

class PeerLink {
  constructor(mesh, id, polite) {
    this.mesh = mesh;
    this.id = id;
    this.polite = polite;
    this.pc = new RTCPeerConnection(RTC_CFG);
    this.open = false;
    this.served = 0;
    this.rtt = 0;
    this.bytesIn = 0;
    this.lastSeen = Date.now();
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.remoteSet = false;       // setRemoteDescription a-t-il été appelé ?
    this.pendingIce = [];         // ICE candidates arrivés avant remote desc
    /** @type {RTCDataChannel|null} */ this.control = null;
    /** @type {RTCDataChannel|null} */ this.media = null;
    /** @type {RTCDataChannel|null} */ this.chat = null;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this._send("ice", e.candidate.toJSON());
    };
    this.pc.onnegotiationneeded = () => this._negotiate();
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      this.mesh.onLog(`peer ${this.id.slice(0, 6)} state=${st}`);
      // « disconnected » est souvent TRANSITOIRE (perte de keep-alive, mDNS
      // qui rafraîchit). On ne ferme que sur « failed » ou « closed », sinon
      // on tuait des connexions qui pouvaient encore se rétablir.
      if (["failed", "closed"].includes(st)) this.close(st);
    };
    this.pc.oniceconnectionstatechange = () => {
      this.mesh.onLog(`peer ${this.id.slice(0, 6)} ice=${this.pc.iceConnectionState}`);
    };
    this.pc.ondatachannel = (ev) => this._wireChannel(ev.channel);
  }

  initiate() {
    if (this.control) return;
    this.mesh.onLog(`peer ${this.id.slice(0, 6)} initiate() — création des DataChannels`);
    // Côté initiateur : on crée les DataChannels, l'autre les recevra via ondatachannel.
    this.control = this.pc.createDataChannel("control", { ordered: true });
    // Media ORDERED + RELIABLE : MediaRecorder produit un flux WebM monolithique
    // fragmenté en chunks dépendants (chunk #0 = EBML+Tracks+début de cluster ;
    // suivants = continuation/clusters). MediaSource refuse tout si un seul
    // chunk manque ou si l'ordre est cassé. Un canal non-fiable garantissait des
    // pertes et un viewer figé sur l'écran noir.
    this.media = this.pc.createDataChannel("media", { ordered: true });
    this.chat = this.pc.createDataChannel("chat", { ordered: true });
    this._wireChannel(this.control);
    this._wireChannel(this.media);
    this._wireChannel(this.chat);
  }

  _wireChannel(ch) {
    if (ch.label === "control") this.control = ch;
    else if (ch.label === "media") this.media = ch;
    else if (ch.label === "chat") this.chat = ch;
    ch.binaryType = "arraybuffer";
    ch.onopen = () => {
      this.mesh.onLog(`peer ${this.id.slice(0, 6)} ch=${ch.label} OPEN`);
      this._maybeOpen();
    };
    ch.onclose = () => { this.mesh.onLog(`peer ${this.id.slice(0, 6)} ch=${ch.label} closed`); };
    ch.onerror = (e) => { this.mesh.onLog(`peer ${this.id.slice(0, 6)} ch=${ch.label} ERR ${e?.error?.message || ""}`); };
    ch.onmessage = (ev) => this._onMessage(ch, ev.data);
  }

  _maybeOpen() {
    const allOpen = ["control", "media", "chat"].every((k) => this[k] && this[k].readyState === "open");
    if (!allOpen) return;
    this.open = true;
    this.mesh.onLog(`peer ${this.id.slice(0, 6)} ALL channels open`);
    this.mesh.dispatchEvent(new CustomEvent("peer-open", { detail: { id: this.id } }));
    // Ping périodique pour mesurer le RTT.
    this.pingTimer = setInterval(() => this._ping(), PING_INTERVAL);
    // Annonce ce qu'on a en cache (catch-up).
    for (const idx of this.mesh.have.keys()) this.sendHave(idx);
  }

  async _negotiate() {
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      this.mesh.onLog(`peer ${this.id.slice(0, 6)} → offer envoyé`);
      this._send("offer", this.pc.localDescription);
    } catch (e) {
      this.mesh.onLog(`peer ${this.id.slice(0, 6)} negotiate KO: ${e?.message || e}`);
    } finally {
      this.makingOffer = false;
    }
  }

  async consumeSignal(p) {
    try {
      if (p.kind !== "ice") this.mesh.onLog(`peer ${this.id.slice(0, 6)} ← ${p.kind}`);
      if (p.kind === "offer") {
        const offerCollision = this.makingOffer || this.pc.signalingState !== "stable";
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(p.payload);
        this.remoteSet = true;
        await this._flushPendingIce();
        await this.pc.setLocalDescription();
        this._send("answer", this.pc.localDescription);
      } else if (p.kind === "answer") {
        if (this.pc.signalingState === "have-local-offer") {
          await this.pc.setRemoteDescription(p.payload);
          this.remoteSet = true;
          await this._flushPendingIce();
        }
      } else if (p.kind === "ice") {
        // Si remoteDescription n'est pas encore posée, on met en file —
        // sinon addIceCandidate throw et les candidats sont perdus, ce qui
        // sabote l'ICE et laisse la connexion "new"/"failed".
        if (!this.remoteSet) {
          this.pendingIce.push(p.payload);
          return;
        }
        try { await this.pc.addIceCandidate(p.payload); } catch (e) { if (!this.ignoreOffer) throw e; }
      } else if (p.kind === "bye") {
        this.close();
      }
    } catch (e) {
      console.warn("[mesh] signal handling failed", e);
    }
  }

  async _flushPendingIce() {
    const queue = this.pendingIce;
    this.pendingIce = [];
    for (const c of queue) {
      try { await this.pc.addIceCandidate(c); } catch { /* candidat obsolète */ }
    }
  }

  _send(kind, payload) {
    sendSignal(this.mesh.streamId, this.mesh.deviceId, this.id, kind, payload).catch(() => { /* ignore */ });
  }

  _onMessage(ch, data) {
    this.lastSeen = Date.now();
    if (ch.label === "control") {
      const msg = parseControl(data);
      if (!msg) return;
      if (msg.t === "have") this.mesh._onHave(this, msg.i);
      else if (msg.t === "want") this.mesh._onWant(this, msg.i);
      else if (msg.t === "ping") this._send_control({ t: "pong", n: msg.n });
      else if (msg.t === "pong") {
        const now = performance.now();
        const start = this._pingMap?.get(msg.n);
        if (start !== undefined) {
          this.rtt = Math.round(now - start);
          this._pingMap.delete(msg.n);
        }
      }
    } else if (ch.label === "media") {
      // Frame binaire : [u32 BE: index][bytes: ciphertext]
      if (!(data instanceof ArrayBuffer)) return;
      this.bytesIn += data.byteLength;
      const view = new DataView(data);
      const idx = view.getUint32(0);
      const payload = new Uint8Array(data, 4);
      this.mesh._onChunk(this, idx, payload);
    } else if (ch.label === "chat") {
      this.mesh._onChat(this, data);
    }
  }

  _send_control(obj) {
    if (this.control?.readyState !== "open") return;
    try { this.control.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }

  sendHave(idx) { this._send_control({ t: "have", i: idx }); }
  sendWant(idx) { this._send_control({ t: "want", i: idx }); }

  sendChunk(idx, payload) {
    if (this.media?.readyState !== "open") return;
    // Pacing : skip si le peer est congestionné — sinon le bufferedAmount
    // monte indéfiniment et toute la pipeline encode→envoie ralentit.
    if ((this.media.bufferedAmount || 0) > MEDIA_CONGEST_DROP_BYTES) {
      this.dropped = (this.dropped || 0) + 1;
      return;
    }
    const buf = new ArrayBuffer(4 + payload.byteLength);
    new DataView(buf).setUint32(0, idx);
    new Uint8Array(buf, 4).set(payload);
    try { this.media.send(buf); } catch { /* ignore */ }
  }

  sendChat(raw) {
    if (this.chat?.readyState !== "open") return;
    try { this.chat.send(raw); } catch { /* ignore */ }
  }

  _ping() {
    if (this.control?.readyState !== "open") return;
    const n = (this._pingSeq = (this._pingSeq || 0) + 1);
    this._pingMap ||= new Map();
    this._pingMap.set(n, performance.now());
    this._send_control({ t: "ping", n });
    // Détection de peer mort
    if (Date.now() - this.lastSeen > PEER_TIMEOUT) this.close();
  }

  close(reason) {
    if (this._closed) return;
    this._closed = true;
    this.mesh.onLog(`peer ${this.id.slice(0, 6)} CLOSE${reason ? ` (${reason})` : ""}`);
    clearInterval(this.pingTimer);
    try { this.pc.close(); } catch { /* ignore */ }
    this.mesh.peers.delete(this.id);
    this.mesh.dispatchEvent(new CustomEvent("peer-close", { detail: { id: this.id } }));
  }
}

function parseControl(data) {
  if (typeof data !== "string") return null;
  try { return JSON.parse(data); } catch { return null; }
}
