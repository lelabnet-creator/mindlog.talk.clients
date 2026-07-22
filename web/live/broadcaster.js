// Broadcaster — capture caméra/écran, chiffre les segments, seed dans le mesh.
//
// Encodage : MediaRecorder en WebM/VP8 (universel, simple) avec timeslice court
// → segments fragmentés que l'on chiffre tels quels et injecte dans le mesh.
//
// ABR (adaptive bitrate) — priorité DIFFUSION > qualité :
//   On surveille le `bufferedAmount` des DataChannels media de chaque peer.
//   Tant qu'aucun peer n'accumule un retard significatif, on reste sur le tier
//   le plus élevé que sa caméra/écran fournit. Dès qu'un peer ne suit plus, on
//   rétrograde immédiatement (track.applyConstraints({ frameRate, width, height })
//   — pas de restart MediaRecorder, le flux WebM continue sans coupure). On
//   remonte lentement (15 s d'accalmie minimum) pour éviter le yoyo.

import { generateStreamKey, exportRawKey, encryptChunk, wrapStreamKey, b64u } from "./crypto.js";
import { Mesh } from "./mesh.js";
import { openSignalChannel, sendHeartbeat, leave, joinStream, fetchRoster } from "./signal.js";

const TIMESLICE_MS = 1000;     // segments d'environ 1 s
const HEARTBEAT_MS = 10_000;
const QUALITY_TICK_MS = 1500;  // évaluation ABR (réactivité +2× vs 3 s)
const UPGRADE_COOLDOWN_MS = 15_000; // patience avant de re-monter d'un tier
// Tiers ordonnés du plus exigeant au plus économe. La 1re ligne sert d'init
// MediaRecorder (videoBitsPerSecond) ; les suivantes ne changent que les
// contraintes track (résolution + frameRate). Le bitrate effectif baisse alors
// mécaniquement car VP8/VP9 encode moins de pixels par seconde.
const QUALITY_TIERS = [
  { name: "HD",     width: 1280, height: 720, frameRate: 30, bitrate: 1_200_000 },
  { name: "SD",     width: 854,  height: 480, frameRate: 24, bitrate: 700_000 },
  { name: "LD",     width: 640,  height: 360, frameRate: 18, bitrate: 400_000 },
  { name: "POTATO", width: 426,  height: 240, frameRate: 12, bitrate: 200_000 },
];
// Seuil de congestion : bufferedAmount du DataChannel media au-delà duquel
// on rétrograde. 96 KB = ~0.7 s de retard à 1.2 Mbps. Le précédent (256 KB)
// laissait s'installer ~1.7 s avant de réagir, ce qui figeait le viewer.
const CONGESTION_BUFFERED_BYTES = 96 * 1024;
// Hard-drop : si un peer accumule plus que ça, on saute le chunk pour lui
// (on garde l'ordre média en envoyant un HAVE — il pourra le redemander).
// Évite que le bufferedAmount explose en cas de pic réseau.
const HARD_DROP_BUFFERED_BYTES = 512 * 1024;

// Presets exposés dans l'UI broadcaster (dropdown "Qualité"). Distinct de
// QUALITY_TIERS qui est l'échelle interne de l'ABR : ici, sélectionner un
// preset autre que "auto" DÉSACTIVE l'ABR et applique des contraintes track
// fixes. "audio" coupe la track vidéo (track.enabled=false) sans la stopper,
// pour pouvoir repasser à une qualité vidéo sans restart MediaRecorder.
export const QUALITY_PRESETS = {
  auto:    { label: "AUTO",  abr: true },
  "1080p": { label: "1080p", width: 1920, height: 1080, frameRate: 30 },
  "720p":  { label: "720p",  width: 1280, height: 720,  frameRate: 30 },
  "480p":  { label: "480p",  width: 854,  height: 480,  frameRate: 30 },
  "360p":  { label: "360p",  width: 640,  height: 360,  frameRate: 24 },
  audio:   { label: "Audio seulement", audioOnly: true },
};

export class Broadcaster {
  constructor({ stream, key, deviceId, broadcasterEcdhPriv, onState, onLog, onChat }) {
    this.stream = stream;            // MediaStream local (cam/mic)
    this.streamId = null;            // l'id remonte de /api/live/start
    this.key = key;                  // CryptoKey AES-GCM (Ks)
    this.keyRaw = null;
    this.deviceId = deviceId;
    this.ecdhPriv = broadcasterEcdhPriv; // CryptoKey ECDH P-256 priv
    this.onState = onState || (() => { });
    this.onLog = onLog || (() => { });
    this.onChat = onChat || (() => { });
    this.mesh = null;
    this.recorder = null;
    this.chunkIdx = 0;
    this.epoch = 0;
    this.viewerPubs = new Map();     // deviceId → ECDH pub JWK (récupérée via signal)
    this.signal = null;
    this.heartbeatTimer = null;
    this.rosterTimer = null;
    this.qualityTimer = null;
    this.thumbTimer = null;
    this.totalBytes = 0;          // octets bruts émis (encryptés)
    this.startedAt = 0;           // ts du premier chunk émis
    /** @type {Map<string, {handle: string|null, hasPhoto: boolean}>} device_id → identité (pour panel viewers). */
    this.viewerIdentities = new Map();
    this.qualityIdx = 0;              // index dans QUALITY_TIERS (0 = HD)
    this.lastDowngradeAt = 0;
    this.forcedPreset = null;         // null = AUTO/ABR ; sinon clé de QUALITY_PRESETS
    this.ended = false;
    this._seenChat = new Set();       // dédup local pour ne pas réafficher
  }

  async start({ title }) {
    this.onLog("Broadcaster build=2026-06-07-mesh-fix");
    this.keyRaw = await exportRawKey(this.key);

    // 1. Publier la clé publique ECDH du broadcaster dans le manifest pour que
    //    les viewers puissent ECDH-dériver le wrap (et chiffrer leurs `pub`
    //    vers nous au moment du join).
    const broadcasterPubJwk = await crypto.subtle.exportKey("jwk", this._publicOf(this.ecdhPriv));
    const manifest = {
      v: 1,
      codec: "video/webm; codecs=vp8,opus",
      timeslice_ms: TIMESLICE_MS,
      window_chunks: 8,
      created_at: new Date().toISOString(),
      ecdh_pub: broadcasterPubJwk,
    };
    // Pas de signature détachée : la confiance vient du fait que /api/live/start
    // est authentifié par session → le serveur lie owner_identity_id ↔ ecdh_pub.

    // 2. Créer le live côté serveur. key_wrap_json est laissé vide ici : on
    //    posera l'enveloppe pour chaque viewer à la volée via /signal (kind=wrap).
    const r = await fetch("/api/live/start", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: title || "",
        broadcaster_pub: b64u.enc(new TextEncoder().encode(JSON.stringify(broadcasterPubJwk))),
        manifest,
        key_wrap: {},
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `start failed (${r.status})`);
    }
    const { id } = await r.json();
    this.streamId = id;
    this.onState({ phase: "live", streamId: id });
    this.onLog(`Live ${id} démarré`);

    // 3. S'inscrire dans le roster en tant que broadcaster.
    await joinStream(this.streamId, this.deviceId, 90);

    // 4. Ouvrir le mesh + le canal signal.
    this.mesh = new Mesh({
      streamId: this.streamId, deviceId: this.deviceId, role: "broadcaster",
      onChat: (m) => this._onChat(m),
      onLog: (m) => this.onLog(m),
    });
    this.mesh.addEventListener("peer-open", () => this._reportPeers());
    this.mesh.addEventListener("peer-close", () => this._reportPeers());
    this.signal = openSignalChannel(this.streamId, this.deviceId,
      (p) => this._onSignal(p),
      () => this.onLog("Signal prêt"),
      () => this.onLog("Signal: erreur (reconnexion auto)"),
    );

    // 5. Démarrer la capture+encodage.
    this._startRecorder();

    // 6. Heartbeat + sync roster.
    this.heartbeatTimer = setInterval(() => {
      sendHeartbeat(this.streamId, this.deviceId, this.mesh.computeScore());
      this._reportPeers();
    }, HEARTBEAT_MS);
    this.rosterTimer = setInterval(() => this._syncRoster(), 6000);
    this.qualityTimer = setInterval(() => this._adjustQuality(), QUALITY_TICK_MS);
    // Vignette : snapshot du flux poussé toutes les 60 s (utilisé par la grille
    // « EN DIRECT MAINTENANT » et la page /live/:id en attendant la 1re frame).
    this.thumbTimer = setInterval(() => void this._pushThumbnail(), 60_000);
    void this._pushThumbnail(); // 1er upload au démarrage
    void this._syncRoster();
    this._reportPeers();
  }

  async _pushThumbnail() {
    if (!this.streamId || this.ended) return;
    const track = this.stream?.getVideoTracks?.()[0];
    if (!track || track.readyState !== "live") return;
    try {
      const settings = track.getSettings?.() || {};
      const srcW = settings.width || 1280;
      const srcH = settings.height || 720;
      // Cible 480 px de large max, ratio préservé.
      const W = Math.min(480, srcW);
      const H = Math.round(srcH * (W / srcW));
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // ImageCapture est dispo dans Chromium ; fallback via <video> caché.
      let bitmap = null;
      if (typeof ImageCapture !== "undefined") {
        try { bitmap = await new ImageCapture(track).grabFrame(); } catch { /* fallback */ }
      }
      if (!bitmap) {
        const v = document.createElement("video");
        v.srcObject = new MediaStream([track]);
        v.muted = true;
        await v.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 60));
        ctx.drawImage(v, 0, 0, W, H);
        try { v.srcObject = null; } catch { /* noop */ }
      } else {
        ctx.drawImage(bitmap, 0, 0, W, H);
        try { bitmap.close(); } catch { /* noop */ }
      }
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
      if (!blob || blob.size > 300_000) return;
      await fetch(`/api/live/${encodeURIComponent(this.streamId)}/thumbnail`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "image/jpeg" },
        body: blob,
      });
    } catch { /* on log silencieusement — la vignette est best-effort */ }
  }

  // Compte les peers ouverts (RTCDataChannel établie) — c'est-à-dire les
  // viewers actuellement capables de recevoir le flux. Le roster serveur peut
  // contenir d'autres entrées en cours de négociation ; on remonte les deux.
  _reportPeers() {
    const connected = [...(this.mesh?.peers.values() || [])].filter((p) => p.open).length;
    const total = (this.mesh?.peers.size || 0);
    this.onState({
      phase: "live", streamId: this.streamId,
      viewers: connected, viewersTotal: total,
      quality: QUALITY_TIERS[this.qualityIdx]?.name || "?",
      diag: this._diagSnapshot(),
    });
  }

  // Snapshot pour panneau debug côté broadcaster : par viewer, état ICE +
  // canaux + congestion sortante, plus stats globales (bitrate effectif,
  // durée, total octets).
  _diagSnapshot() {
    const peers = [...(this.mesh?.peers.values() || [])].map((p) => {
      const ident = this.viewerIdentities.get(p.id);
      return {
        id: p.id.slice(0, 6),
        handle: ident?.handle || null,
        hasPhoto: !!ident?.hasPhoto,
        conn: p.pc?.connectionState || "—",
        ice: p.pc?.iceConnectionState || "—",
        channels: ["control", "media", "chat"].filter((k) => p[k]?.readyState === "open").length,
        mediaBuf: p.media?.bufferedAmount || 0,
        rtt: p.rtt || 0,
      };
    });
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const kbps = elapsedMs > 0 ? Math.round((this.totalBytes * 8) / elapsedMs) : 0; // octets→bits / ms = kbits/s
    return {
      chunks: this.chunkIdx,
      totalBytes: this.totalBytes,
      kbps,
      elapsedSec: Math.round(elapsedMs / 1000),
      peers,
      epoch: this.epoch,
      qualityTier: this.forcedPreset
        ? `${QUALITY_PRESETS[this.forcedPreset]?.label || this.forcedPreset} (forcé)`
        : QUALITY_TIERS[this.qualityIdx]?.name || "?",
      forcedPreset: this.forcedPreset,
    };
  }

  // ABR — surveille la pression sur le canal media de chaque peer et choisit
  // un tier qualité. Logique :
  //   - Si AU MOINS un peer a > CONGESTION_BUFFERED_BYTES en attente d'envoi,
  //     il ne suit pas : on rétrograde d'un cran (priorité à la continuité).
  //   - Sinon, si on est rétrogradé ET qu'il s'est écoulé UPGRADE_COOLDOWN_MS
  //     depuis la dernière baisse, on tente de remonter d'un cran.
  _adjustQuality() {
    if (this.ended || !this.mesh) return;
    if (this.forcedPreset) return; // qualité verrouillée par l'utilisateur
    const openPeers = [...this.mesh.peers.values()].filter((p) => p.open && p.media);
    if (openPeers.length === 0) return; // rien à servir, pas d'ajustement
    const congested = openPeers.some((p) => (p.media.bufferedAmount || 0) > CONGESTION_BUFFERED_BYTES);
    if (congested && this.qualityIdx < QUALITY_TIERS.length - 1) {
      this.qualityIdx += 1;
      this.lastDowngradeAt = performance.now();
      this._applyQualityTier();
      this.onLog(`Qualité ↓ ${QUALITY_TIERS[this.qualityIdx].name} (un viewer ne suivait pas)`);
      this._reportPeers();
      return;
    }
    if (!congested && this.qualityIdx > 0 && performance.now() - this.lastDowngradeAt > UPGRADE_COOLDOWN_MS) {
      this.qualityIdx -= 1;
      this._applyQualityTier();
      this.onLog(`Qualité ↑ ${QUALITY_TIERS[this.qualityIdx].name} (réseau calme)`);
      this._reportPeers();
    }
  }

  // Applique le tier courant à la piste vidéo via applyConstraints. C'est sans
  // restart MediaRecorder : VP8/VP9 encode simplement moins de pixels par
  // seconde. Échoue silencieusement si la source (écran, caméra capricieuse)
  // ne supporte pas la contrainte demandée.
  async _applyQualityTier() {
    const tier = QUALITY_TIERS[this.qualityIdx];
    const tracks = this.stream?.getVideoTracks?.() || [];
    for (const t of tracks) {
      try {
        await t.applyConstraints({
          width: { ideal: tier.width },
          height: { ideal: tier.height },
          frameRate: { ideal: tier.frameRate, max: tier.frameRate },
        });
      } catch { /* contraintes refusées par la source — on continue */ }
    }
  }

  // Force un preset depuis l'UI (dropdown "Qualité"). `preset` = clé de
  // QUALITY_PRESETS ("auto" | "1080p" | "720p" | "480p" | "360p" | "audio").
  // "auto" rétablit l'ABR. Tout autre preset désactive l'ABR et applique des
  // contraintes track fixes (pas de restart MediaRecorder — applyConstraints
  // suffit, VP8/VP9 encode moins de pixels et adapte le bitrate effectif).
  // "audio" coupe la track vidéo (track.enabled=false) sans la stopper.
  async setQualityPreset(preset) {
    const p = QUALITY_PRESETS[preset];
    if (!p) { this.onLog(`Preset inconnu: ${preset}`); return; }
    if (p.abr || preset === "auto") {
      this.forcedPreset = null;
      // Réactive la vidéo si on revient d'audio-only.
      this.stream?.getVideoTracks?.().forEach((t) => { t.enabled = true; });
      this.onLog("Qualité: AUTO (ABR active)");
      this._reportPeers();
      return;
    }
    this.forcedPreset = preset;
    if (p.audioOnly) {
      this.stream?.getVideoTracks?.().forEach((t) => { t.enabled = false; });
      this.onLog("Qualité: audio seulement");
      this._reportPeers();
      return;
    }
    // Vidéo forcée — réactive la track au cas où on quittait audio-only.
    this.stream?.getVideoTracks?.().forEach((t) => { t.enabled = true; });
    const tracks = this.stream?.getVideoTracks?.() || [];
    for (const t of tracks) {
      try {
        await t.applyConstraints({
          width: { ideal: p.width },
          height: { ideal: p.height },
          frameRate: { ideal: p.frameRate, max: p.frameRate },
        });
      } catch (e) { this.onLog(`Contrainte refusée (${p.label}): ${e?.message || e}`); }
    }
    this.onLog(`Qualité: ${p.label} forcée`);
    this._reportPeers();
  }

  _startRecorder() {
    const mime = pickMime();
    if (!mime) throw new Error("Aucun encodeur WebM/MP4 dispo");
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime, videoBitsPerSecond: 1_200_000 });
    this.recorder.ondataavailable = async (ev) => {
      if (!ev.data || ev.data.size === 0 || this.ended) return;
      const buf = new Uint8Array(await ev.data.arrayBuffer());
      const idx = this.chunkIdx++;
      const ct = await encryptChunk(this.key, this.streamId, this.epoch, idx, buf);
      // Le broadcaster diffuse dans le mesh ; il sera aussi son propre playback
      // local si on l'affiche (preview vidéo natif déjà branché sur la balise <video>).
      this.mesh.publishChunk(idx, ct);
      this.totalBytes += ct.byteLength;
      if (!this.startedAt) this.startedAt = Date.now();
      this.onState({ phase: "live", streamId: this.streamId, chunk: idx, mime, diag: this._diagSnapshot() });
    };
    this.recorder.start(TIMESLICE_MS);
  }

  async _onSignal(packet) {
    if (packet.kind === "join-req") {
      // Un viewer nous demande Ks : il joint sa pub ECDH éphémère.
      const { device_id, ecdh_pub } = packet.payload || {};
      if (!device_id || !ecdh_pub) return;
      this.viewerPubs.set(device_id, ecdh_pub);
      const env = await wrapStreamKey(this.ecdhPriv, ecdh_pub, this.keyRaw);
      await this._sendSignal(device_id, "wrap", { epoch: this.epoch, env });
      this.onLog(`Clé délivrée à ${device_id.slice(0, 6)}…`);
      // Si on a un peer stale pour ce viewer (handshake précédente coincée ou
      // failed), on le détruit AVANT d'en recréer un. Un re-join-req signale
      // que le viewer veut repartir à zéro — `ensurePeer` seul réutiliserait
      // l'ancien peer cassé sans relancer la négociation.
      const existing = this.mesh?.peers.get(device_id);
      const cs = existing?.pc?.connectionState;
      if (existing && (!existing.open || cs === "failed" || cs === "closed" || cs === "connecting")) {
        this.onLog(`Re-join-req → reset peer ${device_id.slice(0, 6)} (état=${cs || "?"})`);
        try { existing.close("re-join"); } catch { /* ignore */ }
      }
      // Ouvre tout de suite la connexion mesh vers ce viewer — sans attendre
      // le prochain tick _syncRoster (jusqu'à 6 s d'écran noir sinon).
      this.mesh?.ensurePeer(device_id, { initiate: true });
      return;
    }
    // Sinon : signaux WebRTC pour le mesh.
    await this.mesh?.handleSignal(packet);
  }

  _onChat(msg) {
    // Affichage local côté host. Le fan-out vers les autres viewers est déjà
    // assuré par mesh._onChat (reflood TTL, qui exclut bien le sender) — un
    // reflood supplémentaire ici renvoyait le message à son auteur, qui le
    // voyait apparaître en double dans son chat.
    if (!msg || !msg.id) return;
    if (this._seenChat.has(msg.id)) return;
    this._seenChat.add(msg.id);
    if (this._seenChat.size > 2000) this._seenChat = new Set();
    this.onChat(msg);
  }

  // Publie un message du broadcaster lui-même : flood vers les peers et
  // affichage local. Pas de TTL : le broadcaster est la racine.
  publishChat(text, fromHandle) {
    if (!this.mesh) return;
    const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const msg = { id, from: fromHandle || "host", text: String(text).slice(0, 400), ts: Date.now(), ttl: 0 };
    this._seenChat.add(id);
    this.mesh.publishChat(msg);
    this.onChat(msg);
  }

  async _sendSignal(to, kind, payload) {
    const { sendSignal } = await import("./signal.js");
    return sendSignal(this.streamId, this.deviceId, to, kind, payload);
  }

  async _syncRoster() {
    if (!this.streamId) return;
    try {
      const roster = await fetchRoster(this.streamId);
      // Met à jour la map device_id → identité pour le panneau "Viewers".
      for (const m of roster) {
        if (m.device_id) this.viewerIdentities.set(m.device_id, { handle: m.handle || null, hasPhoto: !!m.has_photo });
      }
      await this.mesh.syncRoster(roster);
    } catch { /* ignore */ }
  }

  // Rotation de Ks : génère une nouvelle clé symétrique, re-chiffre pour les
  // viewers encore actifs, et bumpe epoch côté serveur. Tout chunk passé sous
  // l'ancien Ki devient illisible pour qui n'aurait pas la nouvelle.
  async rotate() {
    const newKey = await generateStreamKey();
    const newRaw = await exportRawKey(newKey);
    this.key = newKey;
    this.keyRaw = newRaw;
    this.epoch += 1;
    this.chunkIdx = 0;
    // Notifie le serveur.
    await fetch(`/api/live/${encodeURIComponent(this.streamId)}/rotate`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key_wrap: {} }),
    });
    // Renvoie les enveloppes individuelles à chaque viewer encore connu.
    for (const [vid, pub] of this.viewerPubs) {
      try {
        const env = await wrapStreamKey(this.ecdhPriv, pub, newRaw);
        await this._sendSignal(vid, "wrap", { epoch: this.epoch, env });
      } catch { /* ignore */ }
    }
  }

  _publicOf(privKey) {
    // SubtleCrypto ne dérive pas direct la clé pub d'une priv ; on stockera la
    // pub à part. Le composant amont nous passe ECDH déjà sous forme keyPair —
    // s'il a donné une CryptoKey priv seule, on s'attend à ce qu'il fournisse
    // un attribut .publicKey adjoint (cf. broadcaster.html: keyPair.publicKey).
    return privKey._publicKey;
  }

  async stop() {
    this.ended = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.rosterTimer);
    clearInterval(this.qualityTimer);
    clearInterval(this.thumbTimer);
    try { this.recorder?.stop(); } catch { /* ignore */ }
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.signal?.close();
    this.mesh?.destroy();
    if (this.streamId) {
      try { await fetch(`/api/live/${encodeURIComponent(this.streamId)}/end`, { method: "POST", credentials: "include" }); } catch { /* ignore */ }
      await leave(this.streamId, this.deviceId);
    }
    this.onState({ phase: "ended" });
  }
}

function pickMime() {
  const tries = [
    "video/webm; codecs=vp8,opus",
    "video/webm; codecs=vp9,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const m of tries) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}
