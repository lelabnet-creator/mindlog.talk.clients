/* ============================================================================
 * Plugin : Appel audio/vidéo PAIR-À-PAIR (WebRTC)
 * ----------------------------------------------------------------------------
 * Le média (audio + vidéo) circule en P2P DIRECT entre les deux navigateurs :
 * il ne traverse jamais le serveur. Seule la SIGNALISATION (offer/answer/ICE)
 * passe par le serveur, et uniquement sous forme de blobs chiffrés de bout en
 * bout (même clé partagée ECDH que le chat) — le serveur ne peut donc rien lire
 * ni de la signalisation ni du média. Aucun blob n'est stocké : le serveur n'est
 * qu'un tuyau temps réel (bus SSE, événement « signal »).
 *
 * Traversée de NAT : STUN pour la découverte d'IP (P2P direct privilégié), et
 * si le serveur en fournit un (GET /api/call/ice), relais TURN en DERNIER
 * recours (NAT symétrique : 4G/5G, Wi-Fi d'entreprise). Même relayé, le média
 * reste chiffré (DTLS-SRTP) : le relais ne voit que des paquets opaques.
 * Sans TURN configuré, comportement historique : STUN seuls.
 *
 * S'enregistre via le registre de plugins de app.js et expose `host.call.start`,
 * appelé par le bouton 📞/🎥 de la fenêtre de chat. Les appels ENTRANTS sont
 * captés globalement via onSSE(« signal ») dès la connexion.
 * ========================================================================== */

import { t } from "../i18n.js";

// Config ICE de REPLI (STUN publics) si /api/call/ice est injoignable.
const FALLBACK_ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export default function register(host) {
  const { esc, api, toast, onSSE, ensureE2E, e2eEncrypt, e2eDecrypt, avatarHtml, logFailure, logActivity } = host;

  // Clé d'accès / handle du compte courant (éditeur d'abord, visiteur ensuite).
  const myKey = () => host.currentKey() || host.myKey();
  const myHandle = () => host.myHandle();

  // Un seul appel à la fois. `call` = état courant ou null.
  let call = null;

  // Historique d'appel : l'APPELANT journalise l'appel dans la conversation en fin
  // d'appel, sous forme de message E2E (sentinel call:) — passe par le fan-out
  // (sync tous mes appareils + le pair), rendu comme une ligne d'info par le chat.
  const CALL_PREFIX = "call:";
  async function sendCallLog(handle, peerPub, info) {
    try {
      const text = CALL_PREFIX + JSON.stringify(info);
      let body = null;
      if (host.md) {
        const fo = await host.md.fanoutEncrypt(myHandle(), myKey(), handle, text).catch(() => null);
        if (fo) body = { clientMsgId: fo.clientMsgId, envelopes: fo.envelopes };
      }
      if (!body) {
        const enc = await e2eEncrypt(peerPub, text);
        body = { ...enc, senderPub: host.e2e?.myPub?.() || "", recipientPub: peerPub };
      }
      await api(`/api/messages/${encodeURIComponent(handle)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-access-key": myKey(), ...(host.md ? { "x-device-id": host.md.deviceId() } : {}) },
        body: JSON.stringify(body),
      });
    } catch { /* best-effort : l'appel reste fonctionnel sans historique */ }
  }

  /* -------- Multi-appareils : « appel pris/refusé ici » (Partie A) --------
   * Quand JE décroche/refuse sur CET appareil, on prévient MES AUTRES appareils
   * (bus SSE de mon identité) pour qu'ils cessent de sonner. Payload self-chiffré
   * (clé partagée entre mes appareils) → le serveur ne lit rien ; il ne fait que
   * relayer. `peer` = handle de l'appelant, pour ne couper que le bon entrant. */
  async function notifyOtherDevices(peer, action) {
    try {
      const enc = await host.md?.selfEncrypt?.(JSON.stringify({ peer, action }));
      if (!enc || !host.md) return;
      await api("/api/call/handled", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-access-key": myKey(), "x-device-id": host.md.deviceId() },
        body: JSON.stringify(enc),
      });
    } catch { /* best-effort : sans réseau, les autres appareils s'arrêteront à l'expiration */ }
  }

  /* ----------------------- Signalisation chiffrée ------------------------ */
  async function sendSignal(handle, peerPub, obj) {
    const enc = await e2eEncrypt(peerPub, JSON.stringify(obj)); // chiffré dans le navigateur
    // Le gating (allow_call/premium) est appliqué côté serveur à la 1re
    // signalisation du couple (l'offre) puis un « permis d'appel » laisse passer
    // l'answer/ICE en retour — l'appel peut donc aboutir et on décroche une fois.
    // x-device-id : permet au serveur d'identifier l'appareil répondant et de
    // diffuser lui-même le « call-handled » à mes autres appareils (ring-stop
    // fiable, indépendant du client) en s'excluant de la coupure.
    await api(`/api/signal/${encodeURIComponent(handle)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-access-key": myKey(), ...(host.md ? { "x-device-id": host.md.deviceId() } : {}) },
      body: JSON.stringify(enc),
    });
  }

  /* ----------------------------- Sonnerie -------------------------------- */
  // Sonnerie d'appel = fichier audio bouclé. Repli sur un bip WebAudio si la
  // lecture échoue (autoplay bloqué côté destinataire, fichier indisponible…).
  const RINGTONE_URL = "/static/sounds/call-ring.mp3";
  function makeRinger() {
    let audio = null, ctx = null, timer = null, stopped = false;

    const startBeepFallback = () => {
      // Ne JAMAIS (re)démarrer après stop() : pause() interrompt le play() en cours
      // et fait rejeter sa promesse (AbortError) ; sans ce garde-fou, le repli bip
      // se lancerait juste après que le destinataire a décroché → sonnerie qui
      // ne s'arrête pas.
      if (stopped || timer || ctx) return;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch { return; }
      const beep = () => {
        if (!ctx) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 520;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
        o.start();
        o.stop(ctx.currentTime + 0.5);
      };
      beep();
      timer = setInterval(beep, 1800);
    };

    return {
      start() {
        stopped = false;
        try {
          audio = new Audio(RINGTONE_URL);
          audio.loop = true;
          audio.volume = 0.8;
          audio.preload = "auto";
          const p = audio.play();
          // play() peut être rejetée : autoplay bloqué / fichier introuvable → repli
          // bip ; mais PAS si on a déjà appelé stop() (rejet dû à notre pause()).
          if (p && typeof p.catch === "function") p.catch(() => { if (!stopped) startBeepFallback(); });
          audio.addEventListener("error", () => { if (!stopped) startBeepFallback(); }, { once: true });
        } catch {
          startBeepFallback();
        }
      },
      stop() {
        stopped = true;
        if (audio) {
          try { audio.pause(); audio.currentTime = 0; } catch { /* ignoré */ }
          audio = null;
        }
        clearInterval(timer);
        timer = null;
        if (ctx) { ctx.close().catch(() => {}); ctx = null; }
      },
    };
  }

  /* ------------------ Serveurs ICE (STUN + TURN éphémère) ---------------- */
  // Récupérés au moment de l'appel : le serveur joint des identifiants TURN
  // éphémères si un relais est configuré (sinon STUN seuls). Mis en cache
  // jusqu'à 5 min avant leur expiration. Échec réseau → repli STUN.
  let iceCache = null; // { config, until }
  async function getIceConfig() {
    if (iceCache && Date.now() < iceCache.until) return iceCache.config;
    try {
      const d = await api("/api/call/ice", { headers: { "x-access-key": myKey() } });
      if (Array.isArray(d?.iceServers) && d.iceServers.length) {
        const until = d.expiresAt ? new Date(d.expiresAt).getTime() - 5 * 60 * 1000 : Date.now() + 10 * 60 * 1000;
        iceCache = { config: { iceServers: d.iceServers }, until };
        return iceCache.config;
      }
    } catch { /* injoignable → repli STUN, l'appel reste tentable en direct */ }
    return FALLBACK_ICE;
  }

  /* --------------------------- Connexion WebRTC -------------------------- */
  function makePC(ice) {
    const pc = new RTCPeerConnection(ice || FALLBACK_ICE);
    pc.onicecandidate = (e) => {
      if (e.candidate && call) sendSignal(call.handle, call.peerPub, { k: "ice", cand: e.candidate }).catch(() => {});
    };
    pc.ontrack = (e) => {
      if (!call) return;
      call.remoteStream = e.streams[0];
      const v = call.overlay?.querySelector("#call-remote");
      if (v && v.srcObject !== call.remoteStream) {
        v.srcObject = call.remoteStream;
        // Brave (Shields) et Chromium bloquent l'autoplay du flux distant (audio+vidéo) :
        // sans appel explicite à play(), on n'a NI son NI image. play() est lancé dans la
        // continuité du geste utilisateur (clic Appeler/Accepter) → autorisé.
        v.play?.().catch(() => {});
      }
      // L'avatar/halo reste affiché tant qu'aucune vidéo distante n'arrive (appel
      // audio) ; on bascule sur la vidéo dès qu'une piste vidéo est active. Suit
      // aussi l'activation/coupure de la caméra du pair en cours d'appel.
      const syncRemoteVideo = () => {
        const hasVideo = (call.remoteStream?.getVideoTracks() || []).some((t) => t.readyState === "live" && !t.muted);
        call.overlay?.querySelector(".call-stage")?.classList.toggle("has-remote-video", hasVideo);
      };
      syncRemoteVideo();
      call.remoteStream.onaddtrack = syncRemoteVideo;
      call.remoteStream.onremovetrack = syncRemoteVideo;
      e.track.onunmute = syncRemoteVideo;
      e.track.onmute = syncRemoteVideo;
      setStage("connected");
    };
    // Renégociation (perfect negotiation) : déclenchée quand on ajoute une piste
    // en cours d'appel (ex. activation de la caméra). Inactive pendant le
    // handshake initial (canRenegotiate posé une fois l'appel établi).
    pc.onnegotiationneeded = async () => {
      if (!call || call.pc !== pc || !call.canRenegotiate) return;
      try {
        call.makingOffer = true;
        await pc.setLocalDescription();
        await sendSignal(call.handle, call.peerPub, { k: "offer", sdp: pc.localDescription });
      } catch { /* ignoré */ } finally {
        call.makingOffer = false;
      }
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") setStage("connected");
      else if (s === "failed") {
        toast(t("call_p2p_failed"));
        logFailure?.("call", t("call_log_interrupted_title").replace("{handle}", call?.handle || "?"), t("call_log_interrupted_detail"), call?.handle);
        endCall(false);
      }
      else if (s === "disconnected") setStage("disconnected");
    };
    return pc;
  }

  // Applique les candidats ICE reçus avant la description distante.
  async function flushPendingIce() {
    if (!call?.pc || !call.pendingIce.length) return;
    for (const cand of call.pendingIce) {
      try { await call.pc.addIceCandidate(cand); } catch { /* ignoré */ }
    }
    call.pendingIce = [];
  }

  /* ------------------------------- UI ------------------------------------ */
  function callOverlayHtml(handle, ringing, outgoing) {
    const status = ringing
      ? (outgoing ? t("call_status_outgoing") : t("call_status_incoming"))
      : t("call_status_connecting");
    return `
      <div class="panel call-panel" role="dialog" aria-label="${t("call_dialog_label").replace("{handle}", esc(handle))}">
        <div class="call-stage" data-stage="${ringing ? "ringing" : "connecting"}">
          <video id="call-remote" class="call-video" autoplay playsinline></video>
          <video id="call-self" class="call-self" autoplay playsinline muted hidden></video>
          <div class="call-ring">
            <!-- Animation : halo de cercles pulsés autour de l'avatar + petit
                 égaliseur animé une fois en communication (appel audio par défaut). -->
            <div class="call-orb" aria-hidden="true">
              <span class="call-orb-ring"></span>
              <span class="call-orb-ring"></span>
              <span class="call-orb-ring"></span>
              ${avatarHtml(handle, false, "call-av")}
            </div>
            <span class="call-name">@${esc(handle)}</span>
            <span class="call-status">${esc(status)}</span>
            <svg class="call-eq" viewBox="0 0 36 24" aria-hidden="true">
              <rect x="2"  y="2" width="4" height="20" rx="2"/><rect x="9"  y="2" width="4" height="20" rx="2"/>
              <rect x="16" y="2" width="4" height="20" rx="2"/><rect x="23" y="2" width="4" height="20" rx="2"/>
              <rect x="30" y="2" width="4" height="20" rx="2"/>
            </svg>
            <span class="call-e2e">${esc(t("call_e2e_label"))}</span>
            ${!ringing || outgoing ? "" : `
              <div class="call-ring-actions">
                <button type="button" class="btn call-accept" id="call-accept">${esc(t("call_answer"))}</button>
                <button type="button" class="btn danger" id="call-decline">${esc(t("call_decline"))}</button>
              </div>`}
          </div>
        </div>
        <div class="call-controls">
          <button type="button" class="btn call-ctl" id="call-mic" title="${esc(t("call_mic_title"))}" aria-label="${esc(t("call_mic_label"))}">🎙️</button>
          <button type="button" class="btn call-ctl off" id="call-cam" title="${esc(t("call_cam_enable"))}" aria-label="${esc(t("call_cam_enable"))}">🎥</button>
          <button type="button" class="btn danger call-ctl" id="call-hangup" title="${esc(t("call_hangup"))}" aria-label="${esc(t("call_hangup"))}">📞</button>
        </div>
      </div>`;
  }

  function setStage(stage) {
    const el = call?.overlay?.querySelector(".call-stage");
    if (!el) return;
    if (stage === "connected") {
      if (call && !call.connectedAt) call.connectedAt = Date.now(); // début de communication (durée)
      clearTimeout(call?.connectTimer); // connecté → plus de garde-fou « connexion »
      el.dataset.stage = "connected";
      const st = call.overlay.querySelector(".call-status");
      if (st) st.textContent = t("call_status_connected");
    } else if (stage === "disconnected") {
      const st = call.overlay.querySelector(".call-status");
      if (st) st.textContent = t("call_status_reconnecting");
    }
  }

  function mountOverlay(handle, ringing, outgoing) {
    const overlay = document.createElement("aside");
    overlay.className = "call-dock";
    overlay.innerHTML = callOverlayHtml(handle, ringing, outgoing);
    document.body.appendChild(overlay);
    overlay.querySelector("#call-hangup").addEventListener("click", () => endCall(true));
    overlay.querySelector("#call-mic").addEventListener("click", () => toggleTrack("audio"));
    overlay.querySelector("#call-cam").addEventListener("click", () => toggleCamera());
    overlay.querySelector("#call-accept")?.addEventListener("click", () => acceptIncoming());
    overlay.querySelector("#call-decline")?.addEventListener("click", () => {
      sendSignal(handle, call.peerPub, { k: "decline" }).catch(() => {});
      notifyOtherDevices(handle, "declined"); // coupe la sonnerie sur mes autres appareils
      endCall(false);
    });
    return overlay;
  }

  function toggleTrack(kind) {
    if (!call?.localStream) return;
    const tracks = kind === "audio" ? call.localStream.getAudioTracks() : call.localStream.getVideoTracks();
    if (!tracks.length) return;
    const on = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = on));
    const btn = call.overlay.querySelector(kind === "audio" ? "#call-mic" : "#call-cam");
    if (btn) btn.classList.toggle("off", !on);
  }

  // Bouton caméra : l'appel démarre en AUDIO seul → le 1er clic acquiert la caméra,
  // ajoute la piste (→ renégociation perfect-negotiation) et affiche l'aperçu.
  // Les clics suivants coupent/réactivent simplement la vidéo.
  // Force la VIDÉO à ON sur l'appel en cours (bascule AUDIO→VIDÉO en place, sans
  // relancer d'appel) : acquiert la caméra si besoin, sinon réactive la piste coupée.
  async function enableVideo() {
    if (!call) return;
    const vtracks = call.localStream?.getVideoTracks() || [];
    if (vtracks.length) { if (!vtracks[0].enabled) toggleTrack("video"); return; }
    await toggleCamera(); // acquisition caméra + renégociation perfect-negotiation
  }

  async function toggleCamera() {
    if (!call?.pc || !call.localStream) return;
    if (call.localStream.getVideoTracks().length) { toggleTrack("video"); return; }
    let vTrack;
    try {
      const vs = await navigator.mediaDevices.getUserMedia({ video: true });
      vTrack = vs.getVideoTracks()[0];
    } catch {
      toast(t("call_cam_unavailable"));
      return;
    }
    if (!vTrack || !call?.pc) { vTrack?.stop(); return; }
    call.localStream.addTrack(vTrack);
    call.pc.addTrack(vTrack, call.localStream); // → onnegotiationneeded → renégociation
    attachLocal();
    const selfV = call.overlay?.querySelector("#call-self");
    if (selfV) selfV.hidden = false;
    call.wantVideo = true;
    call.overlay?.querySelector("#call-cam")?.classList.remove("off");
  }

  async function getMedia(wantVideo = true) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
    } catch (e) {
      // Repli audio seul si pas/refus de caméra.
      try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch { throw e; }
    }
  }

  function attachLocal() {
    const v = call.overlay?.querySelector("#call-self");
    if (v) { v.srcObject = call.localStream; v.play?.().catch(() => {}); }
  }

  /* --------------------------- Cycle de vie ------------------------------ */
  // Délai max d'attente d'une réponse côté appelant avant d'abandonner. DOIT être
  // inférieur à CALLEE_RING_MS : c'est l'appelant qui annonce l'abandon (hangup),
  // le timeout de sonnerie de l'appelé n'est qu'un filet si ce hangup se perd.
  const NO_ANSWER_MS = 35000;
  // Délai max de sonnerie côté APPELÉ : sans ce garde-fou, un appel non décroché
  // laissait un `call` zombie qui sonnait sans fin ET déclinait les appels suivants.
  const CALLEE_RING_MS = 45000;
  // Délai max entre le décroché (answer envoyée/reçue) et la connexion média :
  // au-delà, le P2P n'aboutira pas (NAT symétrique…) → on coupe au lieu de
  // laisser un appel « connexion… » zombie que seul un échec ICE tardif fermait.
  const CONNECT_GUARD_MS = 20000;
  // ⚠ PAS de retransmission périodique de l'offre pendant la sonnerie : un
  // client PÉRIMÉ (PWA/SW en cache, version d'avant le remplacement d'offre)
  // prend la 2e offre pour un nouvel appel alors qu'il sonne déjà → sa branche
  // « occupé » répond DECLINE → rejet auto chez l'appelant + ring-stop serveur
  // qui coupe les autres appareils. Le rattrapage d'un trou SSE devra se faire
  // côté serveur (replay/Last-Event-ID), invisible pour les vieux clients.

  // Dernier appel entrant terminé (refusé/manqué) : une offre du même essai
  // encore en vol (livraison SSE dupliquée/retardée) ne doit pas re-sonner.
  let lastEndedCid = null;

  function armRingTimeout() {
    if (!call) return;
    clearTimeout(call.ringTimer);
    call.ringTimer = setTimeout(() => {
      if (call && call.role === "callee" && !call.pc) {
        console.info(`[call] appel de @${call.handle} manqué (sonnerie expirée)`);
        logActivity?.({ kind: "call", level: "warn", text: t("call_log_missed_title").replace("{handle}", call.handle), detail: t("call_log_missed_detail"), peer: call.handle });
        endCall(false);
      }
    }, CALLEE_RING_MS);
  }

  function armConnectTimeout() {
    if (!call) return;
    clearTimeout(call.connectTimer);
    call.connectTimer = setTimeout(() => {
      if (call && !call.connectedAt) {
        toast(t("call_p2p_failed"));
        logFailure?.("call", t("call_log_interrupted_title").replace("{handle}", call?.handle || "?"), t("call_log_interrupted_detail"), call?.handle);
        endCall(true); // prévient le pair : lui aussi attend peut-être en « connexion »
      }
    }, CONNECT_GUARD_MS);
  }

  function endCall(notifyPeer) {
    if (!call) return;
    clearTimeout(call.noAnswerTimer); // garde-fou « sans réponse » (appelant)
    clearTimeout(call.ringTimer);     // garde-fou sonnerie (appelé)
    clearTimeout(call.connectTimer);  // garde-fou « connexion » post-décroché
    if (call.role === "callee" && call.cid) lastEndedCid = call.cid;
    const { pc, localStream, ringer, handle, peerPub, role, wantVideo, connectedAt, declined } = call;
    if (notifyPeer) sendSignal(handle, peerPub, { k: "hangup" }).catch(() => {});
    ringer?.stop();
    try { pc?.close(); } catch { /* ignoré */ }
    localStream?.getTracks().forEach((t) => t.stop());
    // L'APPELANT journalise l'appel (un seul côté écrit → pas de doublon ; le pair le voit).
    if (role === "caller") {
      const status = connectedAt ? "answered" : (declined ? "declined" : "missed");
      const dur = connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0;
      sendCallLog(handle, peerPub, { k: wantVideo ? "video" : "audio", s: status, d: dur });
    }
    call.overlay?.remove();
    call = null;
  }

  // APPEL SORTANT (déclenché depuis la fenêtre de chat).
  // Par DÉFAUT : appel AUDIO seul. La vidéo s'active en cours d'appel via le bouton
  // caméra (renégociation). `opts.video === true` force la vidéo dès le départ.
  async function startCall(handle, peerPub, opts = {}) {
    if (call) {
      // Déjà en appel : si c'est le MÊME pair et qu'on (re)demande la vidéo, on
      // BASCULE l'appel courant en vidéo (renégociation) au lieu d'en relancer un.
      if (opts.video === true && call.handle === handle) { enableVideo(); return; }
      toast(t("call_already"));
      return;
    }
    if (!peerPub) { toast(t("call_no_e2e")); return; }
    const wantVideo = opts.video === true;
    // cid : identifiant de CET essai d'appel, joint à l'offre. Permet à l'appelé de
    // distinguer une RETRANSMISSION (même cid → même sonnerie) d'un NOUVEL essai.
    const cid = Math.random().toString(36).slice(2, 10);
    call = { handle, peerPub, cid, role: "caller", polite: false, pendingIce: [], remoteDescSet: false, canRenegotiate: false, makingOffer: false, ignoreOffer: false, ringer: makeRinger(), wantVideo };
    call.overlay = mountOverlay(handle, true, true);
    if (wantVideo) call.overlay.querySelector("#call-cam")?.classList.remove("off");
    try {
      call.localStream = await getMedia(wantVideo);
      attachLocal();
      call.pc = makePC(await getIceConfig());
      call.localStream.getTracks().forEach((t) => call.pc.addTrack(t, call.localStream));
      const offer = await call.pc.createOffer();
      await call.pc.setLocalDescription(offer);
      await sendSignal(handle, peerPub, { k: "offer", sdp: offer, cid });
      call.ringer.start();
      // Sans réponse au bout de NO_ANSWER_MS (correspondant absent ou answer
      // jamais reçue) → on arrête ET on le SIGNALE (hangup) : l'appelé cesse de
      // sonner tout de suite et journalise « manqué », au lieu de sonner dans le
      // vide (un décroché après cet instant partait vers un appel déjà clos).
      call.noAnswerTimer = setTimeout(() => {
        if (call && call.role === "caller" && !call.remoteDescSet && !call.connectedAt) {
          toast(t("call_no_answer").replace("{handle}", handle));
          logActivity?.({ kind: "call", level: "warn", text: t("call_log_no_answer_title").replace("{handle}", handle), detail: t("call_log_no_answer_detail"), peer: handle });
          endCall(true);
        }
      }, NO_ANSWER_MS);
    } catch (e) {
      toast(t("call_start_fail") + (e?.message || e));
      logFailure?.("call", t("call_log_start_fail_title").replace("{handle}", handle), e, handle);
      endCall(false);
    }
  }

  // ACCEPTATION d'un appel ENTRANT.
  async function acceptIncoming() {
    if (!call || call.role !== "callee" || !call.pendingOffer) return;
    call.ringer?.stop();
    clearTimeout(call.ringTimer); // décroché → plus de garde-fou sonnerie
    try {
      call.localStream = await getMedia(!!call.wantVideo); // respecte audio vs vidéo de l'offre
    } catch (e) {
      // Micro refusé/indisponible → REFUS explicite : l'appelant cesse de sonner
      // immédiatement au lieu d'attendre son timeout dans le vide. (Avant : on
      // coupait en silence, et on avait déjà annoncé « answered » aux autres
      // appareils → l'appel était perdu partout sans que personne ne le sache.)
      sendSignal(call.handle, call.peerPub, { k: "decline" }).catch(() => {});
      toast(t("call_accept_fail") + (e?.message || e));
      logFailure?.("call", t("call_log_accept_fail_title").replace("{handle}", call?.handle || "?"), e, call?.handle);
      endCall(false);
      return;
    }
    // Seulement une fois le micro acquis : tant que le décroché peut échouer, les
    // autres appareils doivent continuer de sonner (ils restent un recours).
    notifyOtherDevices(call.handle, "answered");
    try {
      attachLocal();
      call.pc = makePC(await getIceConfig());
      call.localStream.getTracks().forEach((t) => call.pc.addTrack(t, call.localStream));
      await call.pc.setRemoteDescription(call.pendingOffer);
      call.remoteDescSet = true;
      await flushPendingIce();
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      await sendSignal(call.handle, call.peerPub, { k: "answer", sdp: answer });
      call.canRenegotiate = true; // handshake terminé → la vidéo peut s'activer ensuite
      armConnectTimeout(); // answer partie : le média doit suivre, sinon on coupe
      setStage("connecting");
      const ringEl = call.overlay.querySelector(".call-ring-actions");
      if (ringEl) ringEl.remove();
    } catch (e) {
      // Échec APRÈS le micro (setup WebRTC) : là aussi, prévenir l'appelant —
      // les autres appareils ont déjà cessé de sonner, il n'y a plus de recours.
      if (call) sendSignal(call.handle, call.peerPub, { k: "decline" }).catch(() => {});
      toast(t("call_accept_fail") + (e?.message || e));
      logFailure?.("call", t("call_log_accept_fail_title").replace("{handle}", call?.handle || "?"), e, call?.handle);
      endCall(false);
    }
  }

  /* --------------------- Réception de la signalisation ------------------- */
  onSSE("signal", async (d) => {
    if (!d || !d.from || !d.iv || !d.ciphertext) return;
    // E2E doit être prêt pour déchiffrer (utile si aucun chat n'est ouvert).
    await ensureE2E(myHandle(), myKey()).catch(() => {});
    const plain = await e2eDecrypt(d.pub, d.iv, d.ciphertext);
    if (plain === null) return; // indéchiffrable → on ignore
    let msg;
    try { msg = JSON.parse(plain); } catch { return; }

    // OFFRE entrante : soit un NOUVEL appel, soit une RENÉGOCIATION de l'appel en
    // cours avec ce même pair (ex. il vient d'activer sa caméra).
    if (msg.k === "offer") {
      // Retransmission d'une offre initiale déjà traitée ICI (décroché fait, ou
      // appel terminé) : ignorer — sinon elle serait prise pour une renégociation
      // (glare) ou relancerait une sonnerie fantôme après refus.
      if (call && msg.cid && msg.cid === call.cid && call.pc) return;
      if (!call && msg.cid && msg.cid === lastEndedCid) return;
      // Renégociation de l'appel courant (perfect negotiation).
      if (call && d.from === call.handle && call.pc) {
        const collision = call.makingOffer || call.pc.signalingState !== "stable";
        call.ignoreOffer = !call.polite && collision; // l'impoli garde son offre
        if (call.ignoreOffer) return;
        try {
          if (collision) await call.pc.setLocalDescription({ type: "rollback" });
          await call.pc.setRemoteDescription(msg.sdp);
          await call.pc.setLocalDescription(); // réponse implicite
          await sendSignal(call.handle, call.peerPub, { k: "answer", sdp: call.pc.localDescription });
        } catch { /* ignoré */ }
        return;
      }
      // MÊME appelant, sonnerie pas encore décrochée (pas de pc) :
      //  - même cid → simple RETRANSMISSION de l'offre en cours : rien à changer
      //    (ne PAS ré-armer le timeout, la sonnerie serait sans fin) ;
      //  - cid différent/absent → nouvel ESSAI d'appel : on remplace l'offre en
      //    attente et on continue de sonner. (Avant : la branche « occupé »
      //    ci-dessous DÉCLINAIT — un appareil resté en sonnerie zombie tuait
      //    tout nouvel appel du même contact.)
      if (call && d.from === call.handle && call.role === "callee" && !call.pc) {
        if (msg.cid && msg.cid === call.cid) { call.pendingOffer = msg.sdp; return; }
        console.info(`[call] nouvelle offre de @${d.from} pendant la sonnerie → offre remplacée`);
        call.cid = msg.cid;
        call.pendingOffer = msg.sdp;
        call.pendingIce = [];
        armRingTimeout();
        return;
      }
      if (call) { // déjà en appel avec QUELQU'UN D'AUTRE → occupé
        sendSignal(d.from, d.pub, { k: "decline" }).catch(() => {});
        return;
      }
      // Nouvel appel entrant. L'appel démarre en audio ; la vidéo (de part et
      // d'autre) s'active ensuite via renégociation, donc on ouvre toujours en audio.
      call = {
        handle: d.from, peerPub: d.pub, cid: msg.cid, role: "callee", polite: true,
        pendingIce: [], pendingOffer: msg.sdp, remoteDescSet: false,
        canRenegotiate: false, makingOffer: false, ignoreOffer: false,
        ringer: makeRinger(), wantVideo: false,
      };
      call.overlay = mountOverlay(d.from, true, false);
      call.ringer.start();
      armRingTimeout(); // jamais de sonnerie zombie : appel manqué au bout du délai
      return;
    }

    // Les autres messages ne concernent que l'appel courant avec ce pair.
    if (!call || d.from !== call.handle) return;

    if (msg.k === "answer") {
      try {
        await call.pc.setRemoteDescription(msg.sdp);
        if (!call.remoteDescSet) {
          // 1re réponse = fin du handshake initial (côté appelant).
          call.remoteDescSet = true;
          call.ringer?.stop();
          clearTimeout(call.noAnswerTimer); // réponse reçue → on annule le garde-fou
          await flushPendingIce();
          call.canRenegotiate = true; // la vidéo peut désormais s'activer
          armConnectTimeout(); // le média doit suivre l'answer, sinon on coupe
          setStage("connecting");
        }
      } catch { /* ignoré */ }
    } else if (msg.k === "ice") {
      if (call.pc && call.remoteDescSet) {
        try { await call.pc.addIceCandidate(msg.cand); } catch { /* ignoré */ }
      } else {
        call.pendingIce.push(msg.cand);
      }
    } else if (msg.k === "hangup") {
      if (call.role === "callee" && !call.pc) {
        // Hangup pendant MA sonnerie = l'appelant a annulé (ou son garde-fou « sans
        // réponse » a expiré) → c'est un appel MANQUÉ, pas un raccroché en cours.
        toast(t("call_log_missed_title").replace("{handle}", call.handle));
        logActivity?.({ kind: "call", level: "warn", text: t("call_log_missed_title").replace("{handle}", call.handle), detail: t("call_log_missed_detail"), peer: call.handle });
      } else {
        toast(t("call_peer_hangup").replace("{handle}", call.handle));
      }
      endCall(false);
    } else if (msg.k === "decline") {
      toast(t("call_peer_declined").replace("{handle}", call.handle));
      logActivity?.({ kind: "call", level: "warn", text: t("call_log_declined_title").replace("{handle}", call.handle), detail: t("call_log_declined_detail"), peer: call.handle });
      call.declined = true; // distingue « refusé » de « sans réponse » dans l'historique
      endCall(false);
    }
  });

  /* --- Un autre de MES appareils a pris/refusé l'appel → couper ici (Partie A) ---
   * Deux formes acceptées :
   *  - CLAIR {from, peer} : émise par le SERVEUR au 1er signal retour du couple
   *    (fiable : aucune dépendance au client répondant ni à la crypto self) ;
   *  - CHIFFRÉE {iv, ciphertext} : émise par le client répondant (self-key). */
  onSSE("call-handled", async (d) => {
    if (!d) return;
    if (d.from && host.md && d.from === host.md.deviceId()) return; // émis par moi-même → ignorer
    let peer = typeof d.peer === "string" && d.peer ? d.peer : null; // forme serveur (clair)
    if (!peer && d.iv && d.ciphertext) {
      await ensureE2E(myHandle(), myKey()).catch(() => {}); // clé self requise pour déchiffrer
      const plain = await host.md?.selfDecrypt?.(d.iv, d.ciphertext);
      if (plain) { try { peer = JSON.parse(plain).peer; } catch { /* illisible */ } }
    }
    if (!peer) return;
    console.info(`[call] appel de @${peer} pris/refusé sur un autre appareil`);
    // Ne couper que si JE fais sonner un ENTRANT de ce pair PAS ENCORE décroché ICI
    // (`!call.pc` : dès que j'ai accepté, mon pc existe → l'événement serveur déclenché
    // par MA propre answer ne doit jamais tuer mon appel).
    if (call && call.role === "callee" && call.handle === peer && !call.pc) {
      call.ringer?.stop();
      toast(t("call_taken_elsewhere").replace("{handle}", call.handle));
      endCall(false); // ne PAS notifier le pair : un autre de mes appareils gère l'appel
    }
  });

  host.call = { start: startCall, enableVideo };

  host.registerPlugin({ name: "call" });
}
