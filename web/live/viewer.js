// Viewer — rejoint le swarm, déchiffre les chunks, joue via MediaSource.
//
// Robustesse / reconnect (le live est best-effort sur un réseau mobile) :
//
//  1. Bootstrap (`_bootstrapWithRetry`) : si `joinStream` échoue sur un 5xx/
//     réseau, on retente avec backoff exponentiel (1, 2, 4, 8 s, cap 30 s).
//     Les 4xx terminaux (401/402/403) remontent à l'appelant sans retry.
//
//  2. Demande de clé (`_kickoffKeyRequest`) : indéfiniment, avec backoff
//     exponentiel capé à 10 s. On NE plus abandonner après 20 tentatives ;
//     le viewer reste prêt à recevoir la clé dès que le broadcaster re-publie.
//
//  3. Fallback initiate (`_fallbackInitiate`) : si le peer broadcaster n'est
//     pas ouvert au bout de 6 s, on initie côté viewer. Reschedule à 12, 24,
//     30 s tant que le peer reste fermé.
//
//  4. Détection de stall (`_checkStall`) : tick à chaque heartbeat. Si peer
//     broadcaster `open` mais aucun chunk depuis 15 s, on ferme le peer et
//     force une re-handshake. Cas typique : ICE encore vivant mais
//     DataChannel buggé / saturé silencieusement.
//
//  5. Revive (`_revive`) : déclenché par `online`, `visibilitychange→visible`,
//     ou SSE reconnect post-coupure. Reset des compteurs, sync roster forcé,
//     re-kickoff de la clé, ensurePeer broadcaster.

import { importRawKey, decryptChunk, unwrapStreamKey } from "./crypto.js";
import { Mesh } from "./mesh.js";
import { openSignalChannel, sendHeartbeat, sendSignal, leave, joinStream, fetchRoster } from "./signal.js";

const HEARTBEAT_MS = 10_000;
const PLAYBACK_TICK_MS = 2_000;         // watchdog playback (séparé du heartbeat lourd)
const JOIN_REQ_BASE_MS = 1500;         // 1ère re-tentative join-req
const JOIN_REQ_CAP_MS = 10_000;        // cap du backoff
const STALL_THRESHOLD_MS = 15_000;     // pas de chunk depuis 15 s = stall
const FALLBACK_INIT_DELAYS = [6_000, 12_000, 24_000, 30_000]; // backoff fallback
const BOOTSTRAP_RETRY_BASE = 1_000;
const BOOTSTRAP_RETRY_CAP = 30_000;
const BOOTSTRAP_TERMINAL_STATUSES = new Set([401, 402, 403, 404]);
// Live-edge : latence cible (s) entre le head du buffer et le currentTime.
// Au-delà de LIVE_EDGE_TARGET_SEC + LIVE_EDGE_TOLERANCE_SEC, on accélère
// doucement (playbackRate) pour rattraper sans glitch audible. Au-delà de
// LIVE_EDGE_HARD_SEC on saute carrément à la fin du buffer.
const LIVE_EDGE_TARGET_SEC = 2.5;
const LIVE_EDGE_TOLERANCE_SEC = 1.5;
const LIVE_EDGE_HARD_SEC = 12;
const LIVE_EDGE_RATE_UP = 1.12;
// Trim proactif du SourceBuffer : si on a plus de TRIM_MAX_BEHIND_SEC de
// média derrière le currentTime, on remove tout sauf TRIM_KEEP_BEHIND_SEC.
// Évite les QuotaExceeded silencieux et baisse la pression mémoire/CPU.
const TRIM_MAX_BEHIND_SEC = 12;
const TRIM_KEEP_BEHIND_SEC = 4;
// Cache local de chunks DÉCHIFFRÉS — sert (a) d'indicateur de santé pour
// l'UI (durée de buffer disponible), (b) de réservoir pour re-feed du
// SourceBuffer si MediaSource doit être recréé après un stall sévère.
// 30 chunks ≈ 60 s à 2 s/chunk. Le chunk #0 (init segment) est conservé en
// permanence (clé pour redémarrer la lecture sans attendre une rotation).
const CACHE_MAX_CHUNKS = 30;

export class Viewer {
  constructor({ streamId, deviceId, ecdhKeyPair, videoEl, onState, onLog, onChat }) {
    this.streamId = streamId;
    this.deviceId = deviceId;
    this.ecdhPriv = ecdhKeyPair.privateKey;
    this.ecdhPub = ecdhKeyPair.publicKey;
    this.videoEl = videoEl;
    this.onState = onState || (() => { });
    this.onLog = onLog || (() => { });
    this.onChat = onChat || (() => { });
    this.mesh = null;
    this.key = null;                 // CryptoKey AES-GCM
    this.epoch = 0;
    this.signal = null;
    this.broadcasterDevice = null;
    this.broadcasterPubJwk = null;
    this.heartbeatTimer = null;
    this.rosterTimer = null;
    this.ms = null;
    this.sb = null;
    this.pendingSegments = [];   // segments média en attente d'append
    this.initBuf = null;          // chunk #0 (init segment WebM) en attente
    this.initApplied = false;     // init segment appended au SourceBuffer ?
    this.mime = "";
    this.qualityScore = 50;
    this.signalReady = false;     // SSE listener bien enregistré côté serveur ?
    this._signalReadyCount = 0;    // # de fois où le canal a atteint "ready"
    this.joinReqAttempts = 0;
    this.joinReqTimer = null;
    this.fallbackAttempts = 0;
    this.fallbackTimer = null;
    this.lastChunkAt = 0;
    this.lastStallReviveAt = 0;
    this.lastSignalKind = "—";    // dernier kind reçu via SSE (debug)
    this.broadcasterSeen = false; // broadcaster présent dans le dernier roster ?
    this._lastCurrentTime = 0;    // pour la watchdog de progression
    this._lastCurrentTimeAt = 0;
    /** @type {Map<number, { buf: ArrayBuffer, ts: number }>} cache local des chunks déchiffrés */
    this.cache = new Map();
    this.cacheBytes = 0;
    this.firstChunkAt = 0;     // ts du 1er chunk reçu (pour la durée couverte)
    this.phase = "starting";
    this._reviveBound = () => this._revive("event");
  }

  async start() {
    this.onLog("Viewer build=2026-06-07-reconnect");
    // 1. Récupérer le manifest + le roster initial via /join, avec retry.
    const info = await this._bootstrapWithRetry();
    this.epoch = info.epoch;
    this.mime = info.manifest?.codec || "video/webm; codecs=vp8,opus";
    // Le manifest expose la pub ECDH du broadcaster (pour wrap/unwrap).
    this.broadcasterPubJwk = info.manifest?.ecdh_pub;
    // Le device_id du broadcaster est celui qui a le rôle "broadcaster" dans le roster.
    this.broadcasterDevice = (info.roster || []).find((m) => m.role === "broadcaster")?.device_id || null;
    if (!this.broadcasterPubJwk || !this.broadcasterDevice) {
      this.onLog("Broadcaster introuvable, attente…");
    }

    // 2. Préparer MediaSource.
    this._initPlayer();

    // 3. Ouvrir le canal signal et attendre `ready` avant d'envoyer join-req
    //    pour éviter une course : si le POST join-req part avant que le serveur
    //    n'ait abonné notre listener, la réponse `wrap` est jetée silencieusement.
    this.signal = openSignalChannel(this.streamId, this.deviceId,
      (p) => this._onSignal(p),
      () => {
        // On distingue le PREMIER `ready` (bootstrap) des suivants
        // (reconnexion après coupure). Sur le premier, surtout ne PAS
        // appeler revive() — ça referme le SSE en plein bootstrap et la
        // réponse `wrap` est jetée silencieusement.
        const isReReady = this._signalReadyCount > 0;
        this._signalReadyCount = (this._signalReadyCount || 0) + 1;
        this.signalReady = true;
        this.onLog(isReReady ? "Signal: re-prêt après coupure" : "Signal prêt");
        this._kickoffKeyRequest();
        if (isReReady) this._revive("sse-back");
      },
      (info) => {
        this.signalReady = false;
        if (info?.terminal) {
          this.onLog("Signal: connexion perdue (abandon)");
          this._setPhase("ended");
        } else {
          this.onLog(`Signal: coupure (retry #${info?.attempt} dans ${Math.round((info?.nextRetryMs || 0)/1000)}s)`);
          this._setPhase("reconnecting");
        }
      },
    );

    // 4. Mesh + roster.
    this.mesh = new Mesh({
      streamId: this.streamId, deviceId: this.deviceId, role: "viewer",
      onChunk: (idx, ct) => this._onChunk(idx, ct),
      onChat: (msg) => this.onChat(msg),
      onLog: (m) => this.onLog(m),
    });
    await this.mesh.syncRoster(info.roster || []);

    // 5. Si le SSE est déjà ready (réseau ultra-rapide), tente immédiatement.
    if (this.signalReady) this._kickoffKeyRequest();

    // 6. Heartbeat + sync roster + détection de stall.
    this.heartbeatTimer = setInterval(() => {
      this.qualityScore = this.mesh.computeScore();
      sendHeartbeat(this.streamId, this.deviceId, this.qualityScore);
      const openPeers = [...this.mesh.peers.values()].filter((p) => p.open).length;
      this.onState({
        phase: this.phase,
        score: this.qualityScore,
        peers: openPeers,
        cache: this.getCacheStats(),
        buffered: this._bufferedSec(),
        diag: this._diagSnapshot(),
      });
      this._checkStall();
    }, HEARTBEAT_MS);
    // Watchdog playback à plus haute fréquence : detecte freeze + rattrape
    // le live-edge sans attendre les 10 s du heartbeat (un retard de 15 s
    // s'installait avant la première intervention).
    this.playbackTimer = setInterval(() => {
      this._checkPlaybackProgress();
      this._trimBuffer();
    }, PLAYBACK_TICK_MS);
    this.rosterTimer = setInterval(() => this._syncRoster(), 6000);

    // 7. Fallback initiation avec backoff exponentiel.
    this._scheduleFallbackInitiate();

    // 8. Wake-up triggers — réseau qui revient ou onglet redevenu visible.
    window.addEventListener("online", this._reviveBound);
    document.addEventListener("visibilitychange", this._onVisibility = () => {
      if (document.visibilityState === "visible") this._revive("visible");
    });
  }

  // Retente l'appel /join tant qu'on tombe sur un 5xx / erreur réseau, avec
  // backoff exponentiel. Les 4xx (401/402/403/404) sont terminaux : on
  // remonte directement à l'appelant pour qu'il affiche le paywall / erreur.
  async _bootstrapWithRetry() {
    let attempt = 0;
    while (true) {
      try {
        return await joinStream(this.streamId, this.deviceId, this.qualityScore);
      } catch (e) {
        if (BOOTSTRAP_TERMINAL_STATUSES.has(e?.status)) throw e;
        if (this._stopped) throw e;
        attempt += 1;
        const delay = Math.min(BOOTSTRAP_RETRY_BASE * Math.pow(2, attempt - 1), BOOTSTRAP_RETRY_CAP);
        this.onLog(`Join KO (${e?.message || "réseau"}) — retry #${attempt} dans ${Math.round(delay/1000)}s`);
        this._setPhase("reconnecting");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  _setPhase(phase) {
    if (this.phase === phase) return;
    if (this.phase === "ended") return; // état final
    this.phase = phase;
    this.onState({ phase });
  }

  _scheduleFallbackInitiate() {
    if (this.fallbackTimer) return;
    const delay = FALLBACK_INIT_DELAYS[Math.min(this.fallbackAttempts, FALLBACK_INIT_DELAYS.length - 1)];
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this._fallbackInitiate();
    }, delay);
  }

  _fallbackInitiate() {
    if (this._stopped || !this.mesh) return;
    if (!this.broadcasterDevice) {
      this.fallbackAttempts += 1;
      this._scheduleFallbackInitiate();
      return;
    }
    const peer = this.mesh.peers.get(this.broadcasterDevice);
    if (peer?.open) {
      this.fallbackAttempts = 0;
      return;
    }
    const state = peer?.pc?.connectionState;
    this.onLog(`Fallback #${this.fallbackAttempts + 1} (peer=${peer ? state : "none"})`);

    if (!peer) {
      // Pas de peer du tout → le broadcaster n'a peut-être pas reçu notre
      // join-req. On en renvoie un (le broadcaster recréera le peer côté
      // sien). En dernier recours on initie aussi côté viewer.
      void this._resendJoinReq();
      this.mesh.ensurePeer(this.broadcasterDevice, { initiate: true });
    } else if (state === "failed" || state === "closed") {
      // Peer cassé → détruire localement + notifier le broadcaster pour qu'il
      // détruise SA copie (sinon son ensurePeer suivant retournera l'ancienne
      // peer en "failed" sans rien recréer). Puis re-join-req depuis zéro.
      this.onLog(`Peer ${state} → recréation`);
      try { peer._send?.("bye"); } catch { /* ignore */ }
      peer.close("retry");
      void this._resendJoinReq();
    } else if ((state === "connecting" || state === "new") && this.fallbackAttempts >= 2) {
      // Coincé en handshake (cas glare WebRTC : ICE OK, DTLS bloqué). On
      // détruit + on demande au broadcaster de recommencer sa moitié.
      this.onLog(`Peer bloqué en ${state} depuis trop longtemps → recréation`);
      try { peer._send?.("bye"); } catch { /* ignore */ }
      peer.close("handshake-timeout");
      // Reset compteur après destruction pour donner sa chance au nouveau peer.
      this.fallbackAttempts = -1;
      void this._resendJoinReq();
    } else {
      // Peer en cours de handshake "normal" — on attend. Pas de peer.initiate()
      // ici : appeler initiate sur un peer dont le broadcaster a déjà émis une
      // offer crée un second set de DataChannels côté viewer, désynchronise les
      // SDP et fait que DTLS reste bloqué (cause confirmée du symptôme
      // ICE=connected + canaux=0/3).
    }
    this.fallbackAttempts += 1;
    this._scheduleFallbackInitiate();
  }

  // Re-envoie un join-req au broadcaster même si on a déjà la clé. Utilisé
  // par _fallbackInitiate quand on détruit un peer stale : on a besoin que
  // le broadcaster recommence sa moitié de la handshake mesh (il ne le fait
  // que sur réception d'un join-req).
  async _resendJoinReq() {
    if (this._stopped) return;
    if (!this.broadcasterDevice || !this.broadcasterPubJwk || !this.signalReady) return;
    try {
      const myPub = await crypto.subtle.exportKey("jwk", this.ecdhPub);
      await sendSignal(this.streamId, this.deviceId, this.broadcasterDevice, "join-req", {
        device_id: this.deviceId, ecdh_pub: myPub,
      });
      this.onLog("Re-join-req envoyé");
    } catch (e) {
      this.onLog("Re-join-req KO: " + (e?.message || e));
    }
  }

  // Boucle de demande de clé : envoie join-req, retente avec backoff
  // exponentiel cap 10 s. Pas de plafond — tant que le viewer est actif et
  // sans clé, on reste prêt à recevoir le wrap si le broadcaster (re)publie.
  _kickoffKeyRequest() {
    if (this.joinReqTimer) return;
    const tick = async () => {
      this.joinReqTimer = null;
      if (this.key || this._stopped) return;
      this.joinReqAttempts += 1;
      // Tente de récupérer manifest/broadcasterDevice s'ils manquaient.
      if (!this.broadcasterPubJwk || !this.broadcasterDevice) {
        await this._refreshManifestAndRoster();
      }
      if (this.broadcasterDevice && this.broadcasterPubJwk && this.signalReady) {
        try {
          const myPub = await crypto.subtle.exportKey("jwk", this.ecdhPub);
          await sendSignal(this.streamId, this.deviceId, this.broadcasterDevice, "join-req", {
            device_id: this.deviceId, ecdh_pub: myPub,
          });
        } catch (e) {
          this.onLog("join-req KO: " + (e?.message || e));
        }
      }
      const delay = Math.min(JOIN_REQ_BASE_MS * Math.pow(1.5, this.joinReqAttempts - 1), JOIN_REQ_CAP_MS);
      this.joinReqTimer = setTimeout(tick, delay);
    };
    tick();
  }

  // Watchdog de lecture — couvre 2 cas :
  //   1. Buffer plein mais image figée (currentTime ne progresse pas) :
  //      relance play() + seek dans le buffer si currentTime est dehors.
  //   2. Retard sur le live-edge (cas réel observé : 18 s de buffer alors
  //      que le broadcaster pousse à temps réel). Stratégie :
  //        - retard > LIVE_EDGE_HARD_SEC → seek à `end - target` (snap)
  //        - retard > target + tolerance → playbackRate accéléré
  //        - retard ≤ target → playbackRate = 1
  _checkPlaybackProgress() {
    if (this._stopped || !this.videoEl) return;
    const v = this.videoEl;
    const buffered = this._bufferedSec();
    if (buffered < 1) {
      this._lastCurrentTime = v.currentTime;
      this._lastCurrentTimeAt = Date.now();
      // Pas assez de média : on s'assure de ne pas être en mode accéléré.
      if (v.playbackRate !== 1) v.playbackRate = 1;
      return;
    }
    // --- (1) détection freeze classique ---
    const advanced = v.currentTime > this._lastCurrentTime + 0.1;
    if (advanced) {
      this._lastCurrentTime = v.currentTime;
      this._lastCurrentTimeAt = Date.now();
    } else {
      const stuckMs = Date.now() - (this._lastCurrentTimeAt || Date.now());
      if (stuckMs >= 5_000) {
        this.onLog(`Watchdog lecture: currentTime=${v.currentTime.toFixed(2)} buffered=${buffered}s — relance`);
        if (v.buffered.length) {
          const start = v.buffered.start(0);
          const end = v.buffered.end(v.buffered.length - 1);
          if (v.currentTime < start || v.currentTime > end) {
            try { v.currentTime = Math.max(start, end - 0.5); } catch { /* ignore */ }
          }
        }
        v.muted = true; // garantir muted pour autoplay
        v.play().then(() => { this._lastCurrentTimeAt = Date.now(); })
          .catch((err) => this.onLog(`play() rejeté: ${err?.name || err}`));
      }
    }
    // --- (2) catch-up live-edge ---
    if (!v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    const lag = end - v.currentTime;
    if (lag > LIVE_EDGE_HARD_SEC) {
      // Trop de retard : on saute. Plus rapide qu'accélérer 10 s à 1.12×.
      try {
        v.currentTime = Math.max(v.buffered.start(0), end - LIVE_EDGE_TARGET_SEC);
        this.onLog(`Live-edge: snap (retard ${lag.toFixed(1)}s → ${LIVE_EDGE_TARGET_SEC}s)`);
      } catch { /* ignore */ }
      v.playbackRate = 1;
    } else if (lag > LIVE_EDGE_TARGET_SEC + LIVE_EDGE_TOLERANCE_SEC) {
      if (v.playbackRate !== LIVE_EDGE_RATE_UP) v.playbackRate = LIVE_EDGE_RATE_UP;
    } else if (lag <= LIVE_EDGE_TARGET_SEC) {
      if (v.playbackRate !== 1) v.playbackRate = 1;
    }
  }

  // Trim proactif du SourceBuffer : libère mémoire/CPU décodeur en éliminant
  // le passé qui ne sera jamais relu (live). Sans ça, sur une session longue,
  // sb.buffered grossit jusqu'au QuotaExceeded — qui n'évince que 10 s d'un
  // coup et stalle l'append pendant ~100 ms.
  _trimBuffer() {
    if (this._stopped || !this.sb || this.sb.updating) return;
    if (!this.sb.buffered.length) return;
    const v = this.videoEl;
    const start = this.sb.buffered.start(0);
    const behind = v.currentTime - start;
    if (behind < TRIM_MAX_BEHIND_SEC) return;
    const removeEnd = v.currentTime - TRIM_KEEP_BEHIND_SEC;
    if (removeEnd <= start + 0.5) return;
    try { this.sb.remove(start, removeEnd); } catch { /* ignore */ }
  }

  // Si peer broadcaster ouvert mais aucun chunk reçu depuis 15 s, on ferme
  // le peer pour forcer une nouvelle handshake. Cas typique : ICE vivant
  // (heartbeat OK) mais DataChannel coincé silencieusement.
  _checkStall() {
    if (this._stopped) return;
    if (!this.broadcasterDevice || !this.lastChunkAt) return;
    const peer = this.mesh?.peers.get(this.broadcasterDevice);
    if (!peer?.open) return;
    const sinceChunk = Date.now() - this.lastChunkAt;
    if (sinceChunk < STALL_THRESHOLD_MS) return;
    // Évite la boucle infernale (revive max 1×/20 s).
    if (Date.now() - this.lastStallReviveAt < 20_000) return;
    this.lastStallReviveAt = Date.now();
    this.onLog(`Stall détecté (${Math.round(sinceChunk/1000)}s sans chunk) — re-handshake`);
    this._setPhase("reconnecting");
    try { peer.close("stall"); } catch { /* ignore */ }
    // Le timer fallback prendra le relais ou un nouvel ensurePeer côté roster.
    this.fallbackAttempts = 0;
    this._scheduleFallbackInitiate();
  }

  // Re-synchronise tout après un événement réseau (online, visible, SSE
  // reconnect). Idempotent.
  _revive(reason) {
    if (this._stopped) return;
    this.onLog(`Revive (${reason})`);
    this.joinReqAttempts = 0;
    this.fallbackAttempts = 0;
    if (this.joinReqTimer) { clearTimeout(this.joinReqTimer); this.joinReqTimer = null; }
    if (this.fallbackTimer) { clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
    this.signal?.revive();
    void this._syncRoster().then(() => {
      this._kickoffKeyRequest();
      this._scheduleFallbackInitiate();
    });
  }

  async _refreshManifestAndRoster() {
    try {
      const r = await fetch(`/api/live/${encodeURIComponent(this.streamId)}`, { credentials: "include" });
      if (r.ok) {
        const j = await r.json();
        if (j?.manifest?.ecdh_pub && !this.broadcasterPubJwk) this.broadcasterPubJwk = j.manifest.ecdh_pub;
        if (j?.manifest?.codec && !this.mime) this.mime = j.manifest.codec;
      }
    } catch { /* best-effort */ }
    try {
      const roster = await fetchRoster(this.streamId);
      const bc = roster.find((r) => r.role === "broadcaster");
      if (bc && !this.broadcasterDevice) this.broadcasterDevice = bc.device_id;
      if (this.mesh) await this.mesh.syncRoster(roster);
    } catch { /* best-effort */ }
  }

  _initPlayer() {
    if (!("MediaSource" in window)) {
      this.onLog("MediaSource non supporté");
      return;
    }
    this.ms = new MediaSource();
    this.videoEl.src = URL.createObjectURL(this.ms);
    this.ms.addEventListener("sourceopen", () => {
      try {
        this.sb = this.ms.addSourceBuffer(this.mime);
        this.sb.mode = "sequence";
        this.sb.addEventListener("updateend", () => this._drainBuffer());
        this._drainBuffer();
      } catch (e) {
        this.onLog("SourceBuffer KO: " + (e?.message || e));
      }
    });
  }

  _appendSegment(idx, buf) {
    // Le chunk #0 contient l'init segment WebM (EBML header + Tracks). Sans
    // lui appended en premier, SourceBuffer rejette tous les autres segments.
    if (idx === 0) this.initBuf = buf;
    else this.pendingSegments.push(buf);
    this._drainBuffer();
  }

  _drainBuffer() {
    if (!this.sb || this.sb.updating) return;
    // Tant qu'on n'a pas appliqué l'init segment, on bloque tout autre append.
    if (!this.initApplied) {
      if (!this.initBuf) return;
      const buf = this.initBuf;
      this.initBuf = null;
      try {
        this.sb.appendBuffer(buf);
        this.initApplied = true;
      } catch (e) {
        this.onLog("init append KO: " + (e?.message || e));
      }
      return;
    }
    if (!this.pendingSegments.length) return;
    const buf = this.pendingSegments.shift();
    try {
      this.sb.appendBuffer(buf);
      // Si autoplay a échoué (MediaSource vide au moment du DOM ready), on
      // force la lecture maintenant qu'il y a des données. Idempotent — un
      // play() sur un <video> déjà en lecture est un no-op.
      if (this.videoEl?.paused) this.videoEl.play().catch(() => { /* autoplay bloqué hors-muted */ });
    }
    catch (e) {
      // QuotaExceeded : on évince une partie du buffer.
      if (e?.name === "QuotaExceededError" && this.sb.buffered.length) {
        try { this.sb.remove(0, this.sb.buffered.end(0) - 10); } catch { /* ignore */ }
        this.pendingSegments.unshift(buf);
      } else {
        this.onLog("append KO: " + (e?.message || e));
      }
    }
  }

  async _onSignal(packet) {
    if (packet?.kind) this.lastSignalKind = packet.kind;
    if (packet.kind === "wrap") {
      // Le broadcaster nous a délivré Ks pour l'epoch courant.
      const { epoch, env } = packet.payload || {};
      if (typeof epoch !== "number" || !env || !this.broadcasterPubJwk) return;
      try {
        const raw = await unwrapStreamKey(this.ecdhPriv, this.broadcasterPubJwk, env);
        this.key = await importRawKey(raw);
        this.epoch = epoch;
        this.onLog(`Clé reçue (epoch ${epoch})`);
        this._setPhase("live");
        // Vide la file de chunks reçus avant la clé.
        if (this._earlyChunks) {
          for (const [idx, ct] of this._earlyChunks) this._onChunk(idx, ct);
          this._earlyChunks = null;
        }
      } catch (e) {
        this.onLog("Déchiffrement clé KO: " + (e?.message || e));
      }
      return;
    }
    if (packet.kind === "epoch") {
      // Le broadcaster a rotaté Ks. On annule la clé courante et redéclenche
      // la boucle de demande (qui ré-enverra le join-req).
      this.key = null;
      this.joinReqAttempts = 0;
      if (this.joinReqTimer) { clearTimeout(this.joinReqTimer); this.joinReqTimer = null; }
      this._kickoffKeyRequest();
      return;
    }
    if (packet.kind === "end") {
      this._setPhase("ended");
      this.onState({ phase: "ended" });
      return;
    }
    // Sinon : signal WebRTC pour le mesh.
    await this.mesh?.handleSignal(packet);
  }

  async _onChunk(idx, ct) {
    if (!this.key) {
      // Stocker en attente si on n'a pas encore la clé.
      this._earlyChunks ||= [];
      if (this._earlyChunks.length < 16) this._earlyChunks.push([idx, ct]);
      return;
    }
    try {
      const pt = await decryptChunk(this.key, this.streamId, this.epoch, idx, ct);
      this.lastChunkAt = Date.now(); // ← marqueur anti-stall
      this._setPhase("live");
      this._cachePut(idx, pt);
      this._appendSegment(idx, pt);
    } catch (e) {
      this.onLog("decrypt KO @" + idx);
    }
  }

  // Stocke le chunk déchiffré dans le cache local et évince les plus anciens.
  // Le chunk #0 (init segment WebM) est immortel — sans lui, plus rien ne
  // peut être appended à un SourceBuffer fraîchement créé.
  _cachePut(idx, buf) {
    if (this.cache.has(idx)) return;
    const entry = { buf, ts: Date.now() };
    this.cache.set(idx, entry);
    this.cacheBytes += buf.byteLength;
    if (!this.firstChunkAt) this.firstChunkAt = entry.ts;
    // Éviction LRU sur l'index (les indices sont monotones croissants).
    const live = [...this.cache.keys()].filter((k) => k !== 0).sort((a, b) => a - b);
    while (live.length > CACHE_MAX_CHUNKS) {
      const drop = live.shift();
      const old = this.cache.get(drop);
      this.cache.delete(drop);
      if (old) this.cacheBytes -= old.buf.byteLength;
    }
  }

  // Combien de secondes de média sont jouables d'ici dans le SourceBuffer.
  // = somme des plages bufferisées. Indicateur "santé immédiate" : si ça
  // tombe à 0, on est sur le point de figer à l'écran.
  _bufferedSec() {
    if (!this.sb || !this.sb.buffered || !this.sb.buffered.length) return 0;
    let total = 0;
    for (let i = 0; i < this.sb.buffered.length; i++) {
      total += this.sb.buffered.end(i) - this.sb.buffered.start(i);
    }
    return Math.round(total * 10) / 10; // 1 décimale
  }

  // Snapshot des diagnostics de connexion — pour identifier en direct si
  // c'est le SSE, ICE, ou la handshake mesh qui coince.
  _diagSnapshot() {
    const bcPeer = this.broadcasterDevice ? this.mesh?.peers.get(this.broadcasterDevice) : null;
    return {
      key: !!this.key,
      broadcasterInRoster: this.broadcasterSeen,
      broadcasterDevice: this.broadcasterDevice ? this.broadcasterDevice.slice(0, 6) : null,
      joinReqAttempts: this.joinReqAttempts,
      fallbackAttempts: this.fallbackAttempts,
      lastSignalKind: this.lastSignalKind,
      sinceLastChunkSec: this.lastChunkAt ? Math.round((Date.now() - this.lastChunkAt) / 1000) : null,
      peerConn: bcPeer?.pc?.connectionState || "—",
      peerIce: bcPeer?.pc?.iceConnectionState || "—",
      peerChannels: bcPeer ? ["control", "media", "chat"].filter((k) => bcPeer[k]?.readyState === "open").length : 0,
    };
  }

  // Snapshot synchrone de l'état du cache — exposé via onState à chaque
  // heartbeat. Permet à l'UI d'afficher un indicateur "Cache : N chunks /
  // X KB / ~Ys" et de signaler quand le cache n'a pas l'init segment.
  getCacheStats() {
    const indices = [...this.cache.keys()].filter((k) => k !== 0).sort((a, b) => a - b);
    const firstIdx = indices[0] ?? null;
    const lastIdx = indices[indices.length - 1] ?? null;
    const spanMs = firstIdx !== null && lastIdx !== null
      ? (this.cache.get(lastIdx).ts - this.cache.get(firstIdx).ts)
      : 0;
    return {
      chunks: this.cache.size,           // inclut le chunk #0 si présent
      bytes: this.cacheBytes,
      hasInit: this.cache.has(0),
      firstIdx,
      lastIdx,
      spanSec: Math.round(spanMs / 1000),
    };
  }

  async _syncRoster() {
    try {
      const roster = await fetchRoster(this.streamId);
      // Met à jour la pub broadcaster si on l'avait ratée — et relance la
      // demande de clé immédiatement (le broadcaster a peut-être (re)joint).
      const bc = roster.find((r) => r.role === "broadcaster");
      this.broadcasterSeen = !!bc;
      const broadcasterChanged = bc && bc.device_id !== this.broadcasterDevice;
      if (bc && (broadcasterChanged || !this.broadcasterDevice)) {
        this.broadcasterDevice = bc.device_id;
        if (!this.key) {
          this.joinReqAttempts = 0;
          if (this.joinReqTimer) { clearTimeout(this.joinReqTimer); this.joinReqTimer = null; }
          this._kickoffKeyRequest();
        }
      }
      await this.mesh.syncRoster(roster);
    } catch (e) {
      // 404 → le stream est passé "ended" (broadcaster a stoppé ou relancé un
      // nouveau live). Inutile de continuer à spinner, on bascule en "ended".
      if (e?.status === 404) {
        this.onLog("Live terminé");
        this._setPhase("ended");
        this.onState({ phase: "ended" });
        await this.stop();
      }
    }
  }

  publishChat(text, fromHandle) {
    const id = crypto.randomUUID();
    const msg = { id, from: fromHandle, text: String(text).slice(0, 400), ts: Date.now(), ttl: 3 };
    this.mesh?.publishChat(msg);
    this.onChat(msg); // affichage local immédiat
  }

  async stop() {
    this._stopped = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.rosterTimer);
    clearInterval(this.playbackTimer);
    if (this.joinReqTimer) clearTimeout(this.joinReqTimer);
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    window.removeEventListener("online", this._reviveBound);
    if (this._onVisibility) document.removeEventListener("visibilitychange", this._onVisibility);
    this.signal?.close();
    this.mesh?.destroy();
    try { this.ms?.endOfStream(); } catch { /* ignore */ }
    this.cache.clear();
    this.cacheBytes = 0;
    if (this.streamId) await leave(this.streamId, this.deviceId);
    this.onState({ phase: "ended" });
  }
}
