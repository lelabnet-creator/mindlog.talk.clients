/* ============================================================================
 * Plugin : Conversation éphémère (chat) chiffrée de bout en bout
 * ----------------------------------------------------------------------------
 * S'enregistre via le registre de plugins de app.js et expose ses capacités
 * sous `host.chat` : { open }. La conversation s'ouvre comme une colonne
 * fermable du deck éditeur (host.openDeckColumn). N'importe RIEN de app.js :
 * toutes les primitives partagées (esc, api, toast, SSE, E2E, helpers…)
 * arrivent par l'objet `host` injecté.
 *
 * Correctifs apportés lors de l'extraction :
 *  - Tempête de rafraîchissements : l'accusé de lecture (POST /ack) n'est plus
 *    envoyé qu'en présence d'un message REÇU non lu. Auparavant chaque refresh
 *    acquittait → SSE « ack » au pair → son refresh → son ack → … boucle infinie
 *    (~600 req/s) qui reconstruisait le journal en continu, rendant les boutons
 *    emoji/✕ inopérants (clic sur un nœud déjà détruit) et la suppression
 *    « impossible ».
 *  - Erreurs serveur (react/delete) désormais remontées à l'utilisateur.
 *  - Compte à rebours avant suppression au clic sur l'heure d'un message.
 * ========================================================================== */

import { icon as svgIcon } from "../ui/icons.js";
import { t } from "../i18n.js";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// Historique d'appel : message E2E sentinel « call:{json} » écrit par l'appelant en
// fin d'appel (cf. plugins/call.js). Rendu comme une ligne d'info dans la conversation.
const CALL_PREFIX = "call:";
function parseCallLog(t) {
  if (typeof t !== "string") return null;
  if (t.charCodeAt(0) === 6) t = t.slice(1); // tolère un  hérité (ancien bug de préfixe)
  if (!t.startsWith(CALL_PREFIX)) return null;
  try {
    const c = JSON.parse(t.slice(CALL_PREFIX.length));
    return c && (c.s === "answered" || c.s === "missed" || c.s === "declined") ? c : null;
  } catch { return null; }
}
function callLabel(c, mine, time) {
  const video = c.k === "video";
  const kind = video ? t("chat_call_video") : t("chat_call_audio");
  const icon = c.s === "answered" ? (video ? "🎥" : "📞") : c.s === "declined" ? "🚫" : "📵";
  const dir = mine ? t("chat_call_out") : t("chat_call_in");
  let detail;
  if (c.s === "answered") { const d = Math.max(0, c.d | 0); detail = `${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}`; }
  else if (c.s === "declined") detail = t("chat_call_declined");
  else detail = mine ? t("chat_call_noanswer") : t("chat_call_missed");
  return `${icon} ${kind} ${dir} · ${detail}${time ? " · " + time : ""}`;
}

// État « échange impossible » : illustration (deux profils dont le lien est rompu)
// + explication de la raison. `reasonHtml` est du HTML déjà échappé.
function chatBlockedHtml(reasonHtml) {
  return `<div class="chat-blocked">
    <svg viewBox="0 0 120 64" width="124" height="66" fill="none" aria-hidden="true" class="chat-blocked-svg">
      <circle cx="28" cy="34" r="13" stroke="currentColor" stroke-width="2"/>
      <circle cx="28" cy="29" r="4.5" stroke="currentColor" stroke-width="2"/>
      <path d="M19 43c1.6-4 5-6 9-6s7.4 2 9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <circle cx="92" cy="34" r="13" stroke="currentColor" stroke-width="2"/>
      <circle cx="92" cy="29" r="4.5" stroke="currentColor" stroke-width="2"/>
      <path d="M83 43c1.6-4 5-6 9-6s7.4 2 9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M46 34h9M65 34h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 5"/>
      <path d="M54 27l12 14M66 27l-12 14" stroke="var(--danger)" stroke-width="2.2" stroke-linecap="round"/>
    </svg>
    <p class="chat-blocked-text">${reasonHtml}</p>
  </div>`;
}

export default function register(host) {
  const {
    esc, api, toast, confirmDialog,
    connectSSE, onSSE, ensureE2E, e2eEncrypt, e2eDecrypt,
    storedKey, storedHandle, logFailure,
  } = host;
  // Double Ratchet (forward secrecy) : v2 si dispo, repli v1 sinon.
  const ratchet = host.ratchet;
  const verify = host.verify; // vérification d'identité anti-MITM
  const attach = host.attach; // pièces jointes chiffrées éphémères

  // Délai (ms) avant suppression d'un message, calculé depuis expires_at (UTC).
  function countdownText(expIso) {
    if (!expIso) return "";
    const ms = new Date(expIso).getTime() - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return t("chat_del_imminent");
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    if (totalMin < 1) return t("chat_del_in_sec").replace("{s}", Math.ceil(ms / 1000));
    if (h < 1) return t("chat_del_in_min").replace("{min}", min);
    return t("chat_del_in_hmin").replace("{h}", h).replace("{min}", pad(min));
  }
  const pad = (n) => String(n).padStart(2, "0");

  /* --------------------------- Colonne de chat --------------------------- */
  // Ouvre la conversation comme une colonne fermable du deck éditeur, insérée
  // juste à droite de la colonne « Identité » (Profil). Le host gère l'unicité
  // par correspondant (clé `chat:<handle>`) et la navigation.
  function openChat(handle, myKey, myHandle) {
    myKey = myKey || storedKey();
    myHandle = myHandle || storedHandle();

    const colHtml = `
      <div class="card chat-card" role="region" aria-label="${t("chat_region").replace("{handle}", esc(handle))}">
        <button type="button" class="close" id="ch-close" aria-label="${t("chat_close_conv")}">✕</button>
        <div class="section-title chat-head" style="border-top:none;padding-top:0;margin-top:0"><span class="chat-head-name">@${esc(handle)}</span> <button type="button" class="btn sm" id="ch-page" title="${t("chat_view_page")}" aria-label="${t("chat_view_page")}">${svgIcon("user", 15)}</button> <button type="button" class="btn sm" id="ch-verify" title="${t("chat_verify_contact")}" aria-label="${t("chat_verify_short")}">${svgIcon("shield", 15)}</button> <button type="button" class="btn sm" id="ch-timer" title="${t("chat_timer_label")}" aria-label="${t("chat_timer_label")}" style="gap:.2rem">${svgIcon("clock", 15)}<span id="ch-timer-label" style="font-size:.6rem;font-weight:700;line-height:1;display:none"></span></button> <button type="button" class="btn sm" id="ch-archive" title="${t("chat_archive_tt")}" aria-label="${t("chat_archive_short")}" aria-pressed="false">${svgIcon("archive", 15)}</button> <span id="ch-vbadge" class="deg"></span></div>
        <p class="sub" id="ch-note">${t("chat_note_e2e")}</p>
        <div class="chat-log" id="ch-log"><p class="empty">${t("com_loading")}</p></div>
        <form id="ch-form" class="chat-form">
          <div class="chat-actions">
            <button type="button" class="btn" id="ch-attach" title="${t("chat_attach_file")}" aria-label="${t("chat_attach_file")}">📎</button>
            <button type="button" class="btn" id="ch-mic" title="${t("chat_rec_voice")}" aria-label="${t("chat_voice_msg")}">🎤</button>
            <button type="button" class="btn" id="ch-once" title="${t("chat_once")}" aria-label="${t("chat_once_short")}" aria-pressed="false">👁</button>
            <input type="file" id="ch-file" hidden />
            <button type="button" class="btn chat-call-btn" id="ch-call" title="${t("chat_call_tt")}" aria-label="${t("chat_call_short")}">${svgIcon("phone", 16)}</button>
          </div>
          <div class="chat-input-row">
            <input id="ch-input" placeholder="${t("chat_input_ph")}" autocomplete="off" maxlength="1000" />
            <button class="btn primary" type="submit" title="${t("chat_send")}" aria-label="${t("chat_send")}">${svgIcon("send", 18)}</button>
          </div>
        </form>
      </div>`;

    const col = host.openDeckColumn(
      { key: `chat:${handle}`, label: `@${handle}`, html: colHtml, wire: wireChat }
      // pas de label → la conversation s'ouvre juste à droite de la colonne active
    );
    if (col) col.querySelector("#ch-input")?.focus({ preventScroll: true });

  function wireChat(overlay) {
    // Teinte personnalisée pour les bulles "theirs" : hash du handle → hue CSS.
    const _hue = [...handle].reduce((h, x) => (h * 31 + x.charCodeAt(0)) % 360, 0);
    overlay.querySelector("#ch-log")?.style.setProperty("--bbl-theirs-tint", _hue);

    // x-device-id : permet au serveur de filtrer les enveloppes fan-out destinées
    // À CET appareil (lecture) et d'attribuer l'appareil émetteur (envoi).
    const authH = { "x-access-key": myKey, ...(host.md ? { "x-device-id": host.md.deviceId() } : {}) };
    let peerPub = null;
    const expandedTimes = new Set(); // ids des messages dont le compte à rebours est déplié
    const attCache = {}; // mid → métadonnée de pièce jointe (pour téléchargement à la demande)
    const TMR_PREFIX = "tmr"; // message de contrôle : minuterie de disparition partagée
    const TMR_PRESETS = [86400, 28800, 3600, 1800, 300]; // 24h, 8h, 1h, 30min, 5min (≤ 24h)
    const tmrKey = `mindlog.timer:${myHandle}:${handle}`;
    let activeTtl = Number(localStorage.getItem(tmrKey)) || 86400; // minuterie active (secondes)
    let pendingOnce = false; // « lecture unique » armé pour le prochain message (un-coup)
    const revealed = new Set(); // ids de messages lecture-unique révélés dans cette session
    const fmtTtl = (s) => (s >= 86400 ? t("chat_ttl_disabled_low") : s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`);

    // Archivage : copie déchiffrée durable dans le localStorage + lecture seule.
    // Les messages sont éphémères côté serveur ; l'archive en conserve une trace
    // sur CE navigateur et fige la conversation (plus d'envoi possible).
    const arcKey = `mindlog.archive:${myHandle}:${handle}`;
    const loadArchive = () => { try { return JSON.parse(localStorage.getItem(arcKey) || "null"); } catch { return null; } };
    const isArchived = () => !!loadArchive();
    const archivedBannerHtml = () =>
      `<div class="chat-archived-banner">${t("chat_archived_banner")}</div>`;
    const renderArcBubble = (m) =>
      `<div class="bubble ${m.mine ? "mine" : "theirs"} archived">` +
      `<span class="b-text">${esc(m.text || "")}</span>` +
      `<span class="t"><span class="t-time">${esc(m.time || "")}</span></span></div>`;
    function setReadOnly(ro) {
      const form = overlay.querySelector("#ch-form");
      if (!form) return;
      form.classList.toggle("readonly", ro);
      form.querySelectorAll("input,button").forEach((el) => (el.disabled = ro));
    }
    function updateArchiveBtn() {
      const btn = overlay.querySelector("#ch-archive");
      if (btn) btn.setAttribute("aria-pressed", String(isArchived()));
    }

    // Animation d'arrivée : on n'anime QUE les messages réellement nouveaux
    // (refresh() reconstruit tout le journal ; sans ce suivi, tout clignoterait
    // à chaque rafraîchissement / SSE / accusé de lecture).
    const seenBubbles = new Set();
    let firstPaint = true;

    const close = () => {
      clearInterval(timer);
      clearInterval(cdTimer);
      unsub();
      unsubAck();
      host.closeDeckColumn(overlay);
    };
    overlay.querySelector("#ch-close").addEventListener("click", close);
    connectSSE(myKey);
    const unsub = onSSE("message", (d) => {
      if (!d || d.from === handle || d.from === undefined) refresh();
    });
    const log = overlay.querySelector("#ch-log");
    const input = overlay.querySelector("#ch-input");
    // Défilement vers le bas : fluide (natif, se coalesce avec les refresh fréquents)
    // à l'arrivée d'un message ; instantané au 1er rendu / réagencement de média.
    const _reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scrollDown = (smooth) =>
      log.scrollTo({ top: log.scrollHeight, behavior: smooth && !_reduceMotion ? "smooth" : "auto" });

    // Badge de vérification d'identité (✓ vérifié / ⚠️ clé changée).
    async function refreshVerifyBadge() {
      const badge = overlay.querySelector("#ch-vbadge");
      if (!badge || !verify || !peerPub) return;
      try {
        const st = await verify.status(handle);
        if (!st.safety) { badge.textContent = ""; return; }
        const sn = await verify.safetyNumber(myHandle, host.e2e.myPub(), handle, peerPub);
        const cur = await verify.sha256hex(sn);
        if (cur === st.safety) { badge.textContent = t("chat_verified"); badge.style.color = "var(--success)"; }
        else { badge.textContent = t("chat_key_changed"); badge.style.color = "var(--danger)"; }
      } catch { badge.textContent = ""; }
    }
    overlay.querySelector("#ch-page")?.addEventListener("click", () => {
      window.open(`/@${encodeURIComponent(handle)}`, "_blank", "noopener");
    });
    // Appel P2P : utilise la clé publique du pair déjà chargée (peerPub). Bouton vert
    // sur la rangée d'actions — disponible quel que soit le mode d'ouverture du chat.
    overlay.querySelector("#ch-call")?.addEventListener("click", () => {
      if (!peerPub) { host.toast?.(t("chat_call_unavailable")); return; }
      // Appel AUDIO par défaut ; la vidéo s'active en cours d'appel (bouton caméra).
      host.call?.start(handle, peerPub, { video: false });
    });
    overlay.querySelector("#ch-verify")?.addEventListener("click", () => {
      if (!peerPub) { host.toast?.(t("chat_no_key_yet")); return; }
      verify?.open(myHandle, handle, peerPub, refreshVerifyBadge);
    });

    // Archiver / désarchiver la conversation.
    overlay.querySelector("#ch-archive")?.addEventListener("click", async () => {
      if (isArchived()) {
        if (!(await confirmDialog(t("chat_unarchive_confirm"), { ok: t("chat_unarchive_ok") }))) return;
        try { localStorage.removeItem(arcKey); } catch {}
        toast(t("chat_unarchived"));
      } else {
        if (!(await confirmDialog(t("chat_archive_confirm"), { ok: t("chat_archive_ok") }))) return;
        const snap = [...log.querySelectorAll(".bubble[data-mid]")].map((b) => ({
          mine: b.classList.contains("mine"),
          time: b.querySelector(".t-time")?.textContent.trim() || "",
          text: (b.querySelector(".b-text") || b.querySelector(".b-att"))?.textContent.trim() || "",
        }));
        try { localStorage.setItem(arcKey, JSON.stringify({ archivedAt: new Date().toISOString(), messages: snap })); }
        catch { toast(t("chat_archive_fail")); return; }
        toast(t("chat_archived"));
      }
      updateArchiveBtn();
      refresh();
    });
    updateArchiveBtn();

    async function refresh() {
      // Colonne fermée (retirée du DOM) → on coupe les timers et on s'arrête.
      if (!overlay.isConnected) { clearInterval(timer); clearInterval(cdTimer); return; }
      try {
        const d = await api(`/api/messages/${encodeURIComponent(handle)}`, { headers: authH });
        peerPub = d.peerPubkey;
        const form = overlay.querySelector("#ch-form");
        if (form) form.style.display = ""; // ré-affiche le composer si un refresh précédent l'avait masqué
        if (!peerPub) {
          // Le correspondant n'a pas encore de clé publique (jamais connecté).
          overlay.querySelector("#ch-note").textContent = t("chat_no_pubkey");
          log.innerHTML = '<p class="empty">' + t("chat_needs_login").replace("{handle}", esc(handle)) + "</p>";
          form.querySelectorAll("input,button").forEach((el) => (el.disabled = true));
          return;
        }
        overlay.querySelector("#ch-note").textContent = t("chat_e2e_ttl").replace("{h}", d.ttlHours);
        refreshVerifyBadge();
        // Conversation archivée → lecture seule + bandeau ; sans message vivant on
        // ré-affiche la copie locale durable.
        const archived = isArchived();
        setReadOnly(archived);
        const archBanner = archived ? archivedBannerHtml() : "";
        // Clé absente sur ce navigateur mais coffre disponible → proposer la restauration.
        if (host.e2e && host.e2e.needsRestore()) {
          log.innerHTML =
            '<div class="chat-restore"><p>' + t("chat_restore_keys_note") + '</p>' +
            '<button type="button" class="btn sm primary" id="ch-restore">' + t("chat_restore_keys_btn") + '</button></div>';
          log.querySelector("#ch-restore").addEventListener("click", () => host.e2e.openRestore());
          return;
        }
        // Clé présente mais pas dans le coffre → bandeau non bloquant invitant à
        // la sauvegarder (sinon messages illisibles sur les autres appareils).
        const backupBanner =
          host.e2e && host.e2e.needsBackup()
            ? '<div class="chat-backup"><span>' + t("chat_backup_note") + '</span>' +
              '<button type="button" class="btn sm" id="ch-backup">' + t("chat_backup_btn") + '</button></div>'
            : "";
        const wireBackup = () =>
          log.querySelector("#ch-backup")?.addEventListener("click", () => host.e2e.openBackup(refresh));
        if (!d.messages.length) {
          const arc = archived && loadArchive();
          if (arc && arc.messages && arc.messages.length) {
            log.innerHTML = archBanner + arc.messages.map(renderArcBubble).join("");
          } else {
            log.innerHTML = backupBanner + archBanner + '<p class="empty">' + t("chat_no_messages") + '</p>';
            wireBackup();
          }
          return;
        }
        const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
        // Chaque message est déchiffré avec MA clé privée actuelle + la clé
        // publique du PAIR figée à l'envoi (sender_pub si reçu, recipient_pub
        // si c'est le mien). L'historique reste lisible même si l'autre partie
        // a changé de clé depuis. Repli sur la clé publiée courante (peerPub)
        // pour les anciens messages sans clé stockée.
        const decodeOne = (m) => {
          const mine = m.sender_id === d.me;
          // Multi-appareils (fan-out) : message LOGIQUE ; le serveur a renvoyé MON
          // enveloppe (ciphertext destiné à cet appareil), ou vide pour mon propre
          // envoi (relu localement via recallSent keyé par clientMsgId).
          if (m.client_msg_id && host.md) {
            // « Mien à relire localement » = envoyé par CET appareil (sender_device_id ==
            // mon device-id). Un message d'un AUTRE de mes appareils (sync) a sender_id == moi
            // mais un device-id différent → il faut déchiffrer SON enveloppe, pas recallSent.
            const sentHere = m.sender_device_id && m.sender_device_id === host.md.deviceId();
            if (sentHere) return host.md.recallSent(myHandle, m.client_msg_id).catch(() => null);
            // Message d'un AUTRE de MES appareils (sync) → clé self partagée (pas de ratchet
            // entre mes propres appareils). Sinon (pair) → ratchet par-appareil.
            if (mine) return host.md.selfDecrypt(m.iv, m.ciphertext).catch(() => null);
            return host.md.decryptEnvelope(myHandle, myKey, m.sender_device_id, m.iv, m.ciphertext).catch(() => null);
          }
          // v2 (Double Ratchet) legacy : ciphertext empaqueté « header.ct ». Le ratchet
          // n'avance que sur les messages REÇUS (les miens sont relus du cache).
          if (ratchet && ratchet.isV2(m.ciphertext)) {
            if (mine) return ratchet.recallSent(myHandle, myKey, m.iv).catch(() => null);
            return ratchet.decrypt(myHandle, myKey, handle, m.iv, m.ciphertext).catch(() => null);
          }
          const pub = (mine ? m.recipient_pub : m.sender_pub) || peerPub;
          return e2eDecrypt(pub, m.iv, m.ciphertext);
        };
        // SÉQUENTIEL (pas Promise.all) : le Double Ratchet mute un état partagé par session.
        // Déchiffrer en parallèle ferait courir plusieurs messages d'une même session sur le
        // même état → certains échoueraient (cas observé : 3 messages reçus d'un coup d'un
        // autre appareil → seul le 1er passait). On avance donc message par message, dans l'ordre.
        const texts = [];
        for (const m of d.messages) texts.push(await decodeOne(m));
        // Minuterie partagée : la valeur active = dernier message de contrôle « tmr<n> ».
        const tmrRe = /^tmr(\d+)$/;
        for (let i = 0; i < texts.length; i++) {
          const mt = typeof texts[i] === "string" && texts[i].match(tmrRe);
          if (mt) activeTtl = Number(mt[1]);
        }
        try { localStorage.setItem(tmrKey, String(activeTtl)); } catch {}
        overlay.querySelector("#ch-note").textContent =
          activeTtl >= 86400
            ? t("chat_e2e_ephemeral").replace("{h}", d.ttlHours)
            : t("chat_e2e_disappear").replace("{ttl}", fmtTtl(activeTtl));

        log.innerHTML = backupBanner + archBanner + d.messages
          .map((m, i) => {
            const txt = texts[i];
            const mine = m.sender_id === d.me;
            // Messages de contrôle (Sender Key Distribution pour les groupes) :
            // jamais affichés dans la conversation 1:1, ce sont des paquets de
            // protocole consommés silencieusement par crypto/groups.js::gSyncKeys.
            if (typeof txt === "string" && txt.startsWith("skd")) return "";
            // Message de contrôle de minuterie → note système centrée (pas une bulle).
            const tm = typeof txt === "string" && txt.match(tmrRe);
            if (tm) {
              const sec = Number(tm[1]);
              const label = sec >= 86400 ? t("chat_timer_disabled") : t("chat_ephemeral_msgs").replace("{ttl}", fmtTtl(sec));
              return `<div class="sys-note" style="text-align:center;color:var(--muted);font-size:.85em;margin:.4rem 0">⏲ ${esc(label)}</div>`;
            }
            const time = new Date(m.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
            // ✓ envoyé · ✓✓ reçu · ✓✓ (vert) lu
            const ticks = mine
              ? `<span class="ticks ${m.read ? "read" : ""}">${m.read || m.delivered ? "✓✓" : "✓"}</span>`
              : "";
            const reacts = (m.reactions || [])
              .map((r) => `<button type="button" class="react ${r.mine ? "mine" : ""}" data-react="${esc(r.emoji)}" data-mid="${m.id}">${r.emoji}${r.count > 1 ? " " + r.count : ""}</button>`)
              .join("");
            const open = expandedTimes.has(m.id);
            // Pièce jointe : le texte déchiffré est une métadonnée sentinelle.
            const att = attach && txt ? attach.parse(txt) : null;
            const callLog = txt ? parseCallLog(txt) : null;
            const isOnce = m.read_once === 1 || m.read_once === true;
            let body;
            if (callLog) {
              body = `<span class="b-text b-call">${esc(callLabel(callLog, mine, time))}</span>`;
            } else if (isOnce && mine) {
              // Mes messages lecture-unique : tombstone (non re-lisible).
              body = `<span class="b-text" style="opacity:.7">${t("chat_once_tombstone")}</span>`;
            } else if (isOnce && !revealed.has(m.id)) {
              // Reçu, pas encore révélé : cache « toucher pour voir » → révèle + brûle.
              body = `<span class="b-att b-once" data-reveal="${m.id}" style="cursor:pointer">${t("chat_once_reveal")}</span>`;
            } else if (att) {
              attCache[m.id] = att;
              const sz = att.size > 0 ? ` · ${(att.size / 1024 < 1024 ? (att.size / 1024).toFixed(0) + " " + t("chat_unit_kb") : (att.size / 1048576).toFixed(1) + " " + t("chat_unit_mb"))}` : "";
              const mime = att.mime || "";
              if (mime.startsWith("image/")) {
                body = `<span class="b-att b-att-img" data-mid="${m.id}" title="${esc(att.name)}">${t("chat_att_img_loading").replace("{name}", esc(att.name))}</span>`;
              } else if (mime.startsWith("audio/")) {
                const dur = att.dur ? ` · ${Math.round(att.dur / 1000)} s` : "";
                body = `<span class="b-att b-att-audio" data-mid="${m.id}">${t("chat_att_audio_loading").replace("{dur}", dur)}</span>`;
              } else {
                body = `<span class="b-att b-att-file" data-mid="${m.id}">📎 ${esc(att.name)}${sz} <button type="button" class="btn sm" data-attdl="${m.id}">${t("chat_download")}</button></span>`;
              }
            } else {
              body = txt === null
                ? `<button type="button" class="b-text b-undec" data-undec="1" title="${t("chat_undec_title")}">${t("chat_undec_btn")}</button>`
                : `<span class="b-text">${esc(txt)}</span>`;
            }
            return `<div class="bubble ${mine ? "mine" : "theirs"}" data-mid="${m.id}">
              ${body}
              ${reacts ? `<div class="b-reacts">${reacts}</div>` : ""}
              <span class="t">
                <span class="t-time" data-exp="${esc(m.expires_at)}" data-mid="${m.id}" role="button" tabindex="0" title="${t("chat_time_title")}">${esc(time)} ${ticks}</span>
                <button type="button" class="b-react-btn" data-reactbtn="${m.id}" title="${t("chat_react")}" aria-label="${t("chat_react")}">🙂</button>
                ${mine ? `<button type="button" class="b-del" data-del="${m.id}" title="${t("com_delete")}" aria-label="${t("com_delete")}">✕</button>` : ""}
              </span>
              <span class="b-countdown" data-exp="${esc(m.expires_at)}" ${open ? "" : "hidden"}>${open ? esc(countdownText(m.expires_at)) : ""}</span>
            </div>`;
          })
          .join("");
        wireBackup();
        // Animation d'arrivée : on marque les bulles déjà connues, et on n'anime
        // que celles dont l'id est nouveau (le 1er rendu ne fait que peupler le set).
        const wasFirst = firstPaint;
        let hadNew = false;
        log.querySelectorAll(".bubble[data-mid]").forEach((b) => {
          const id = b.dataset.mid;
          if (firstPaint) { seenBubbles.add(id); return; }
          if (!seenBubbles.has(id)) { seenBubbles.add(id); b.classList.add("bubble-enter"); hadNew = true; }
        });
        firstPaint = false;
        // Chargement différé des aperçus image (téléchargement + déchiffrement à la demande).
        for (const el of log.querySelectorAll(".b-att-img")) {
          const meta = attCache[el.dataset.mid];
          if (!meta) continue;
          attach.download(handle, meta)
            .then((url) => { el.innerHTML = `<img src="${url}" alt="${esc(meta.name)}" style="max-width:min(78%,340px);width:auto;border-radius:12px;display:block" />`; if (atBottom) scrollDown(false); })
            .catch(() => { el.textContent = t("chat_att_unavailable"); });
        }
        // Chargement différé des messages vocaux → lecteur <audio> inline.
        for (const el of log.querySelectorAll(".b-att-audio")) {
          const meta = attCache[el.dataset.mid];
          if (!meta) continue;
          attach.download(handle, meta)
            .then((url) => {
              const aud = document.createElement("audio");
              aud.controls = true;
              aud.preload = "metadata";
              aud.style.cssText = "vertical-align:middle;width:280px;max-width:100%";
              aud.src = url;
              // Chrome : MediaRecorder webm ne contient pas la durée — forcer le scan
              aud.addEventListener("loadedmetadata", () => {
                if (!isFinite(aud.duration) || aud.duration === 0) aud.currentTime = 1e101;
              }, { once: true });
              aud.addEventListener("timeupdate", function fix() {
                if (isFinite(aud.duration) && aud.duration > 0) {
                  aud.removeEventListener("timeupdate", fix);
                  aud.currentTime = 0;
                }
              });
              el.innerHTML = "🎤 ";
              el.appendChild(aud);
              // Le lecteur webm (Chrome) affiche « 0:00 » tant que la durée n'est pas
              // connue. On montre donc la durée ENREGISTRÉE (att.dur, figée à l'envoi)
              // tant que le message n'a pas été lu ; dès la 1re lecture le lecteur prend
              // le relais avec le temps réel et on retire le badge.
              const durMs = meta.dur || 0;
              if (durMs >= 1000) {
                const s = Math.round(durMs / 1000);
                const durLabel = document.createElement("span");
                durLabel.className = "b-att-dur";
                durLabel.style.cssText = "margin-left:.35rem;font-size:.72rem;color:var(--muted);font-variant-numeric:tabular-nums";
                durLabel.textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
                durLabel.title = t("chat_voice_dur_title");
                el.appendChild(durLabel);
                aud.addEventListener("play", () => durLabel.remove(), { once: true });
              }
              if (atBottom) scrollDown(false);
            })
            .catch(() => { el.textContent = t("chat_voice_unavailable"); });
        }
        // Auto-défilement vers le bas si on y était déjà : fluide à l'arrivée d'un
        // nouveau message, instantané au 1er rendu / simple rafraîchissement.
        if (atBottom) scrollDown(hadNew && !wasFirst);

        // Accusé de lecture UNIQUEMENT s'il existe un message REÇU non lu.
        // Sans cette garde, l'ack est renvoyé à chaque refresh et déclenche un
        // ping-pong SSE infini entre les deux fenêtres (tempête de rafraîchissements).
        const hasUnreadIncoming = d.messages.some((m) => m.sender_id !== d.me && !m.read);
        if (hasUnreadIncoming) {
          api(`/api/messages/${encodeURIComponent(handle)}/ack`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authH },
            body: JSON.stringify({ read: true }),
          })
            .then(() => host.updateChatBadge?.()) // conversation lue → badge nav à jour
            .catch(() => {});
        }
      } catch (e) {
        const form = overlay.querySelector("#ch-form");
        // Échange impossible (403 accès / 402 premium) : on explique POURQUOI, avec une
        // illustration, et on masque le composer (impossible d'écrire de toute façon).
        if (e?.status === 403 || e?.status === 402) {
          const reason = /contact/i.test(e.message)
            ? t("chat_blocked_contact").replaceAll("{handle}", esc(handle))
            : /abonn/i.test(e.message)
              ? t("chat_blocked_premium").replace("{handle}", esc(handle))
              : t("chat_blocked_disabled").replace("{handle}", esc(handle));
          log.innerHTML = chatBlockedHtml(reason);
          if (form) form.style.display = "none";
        } else {
          if (form) form.style.display = "";
          log.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
        }
      }
    }

    async function react(mid, emoji) {
      try {
        await api(`/api/messages/${encodeURIComponent(handle)}/react`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authH },
          body: JSON.stringify({ messageId: Number(mid), emoji }),
        });
      } catch (e) {
        toast(e.message);
      }
      refresh();
    }

    // Sélecteur d'emoji : un seul popover au niveau de la fenêtre (pas dans le log,
    // pour qu'il ne soit pas effacé par le rafraîchissement → plus de clignotement).
    const picker = document.createElement("div");
    picker.className = "react-pick";
    picker.hidden = true;
    picker.innerHTML = QUICK_EMOJIS.map((em) => `<button type="button" data-emoji="${em}">${em}</button>`).join("");
    overlay.querySelector(".chat-card").appendChild(picker);
    let pickMid = null;
    const hidePicker = () => (picker.hidden = true);

    // Un seul écouteur délégué sur la carte : couvre boutons des bulles ET du
    // sélecteur, quels que soient les rafraîchissements (délégation = robuste).
    overlay.querySelector(".chat-card").addEventListener("click", async (e) => {
      const t = e.target.closest && e.target.closest("[data-emoji],[data-react],[data-del],[data-reactbtn],[data-exp][data-mid],[data-attdl],[data-reveal],[data-undec]");
      if (!t) return;
      // Message indéchiffrable → workflow de récupération de clé.
      if (t.hasAttribute("data-undec")) {
        e.stopPropagation();
        host.e2e?.recoverKeys?.(refresh);
        return;
      }
      // Révélation d'un message à lecture unique → afficher puis brûler côté serveur.
      if (t.hasAttribute("data-reveal")) {
        e.stopPropagation();
        const id = Number(t.dataset.reveal);
        revealed.add(id);
        await refresh(); // ré-rendu : le contenu s'affiche (déjà déchiffré localement)
        burn(id); // suppression serveur (disparaîtra au prochain refresh)
        return;
      }
      // Téléchargement d'une pièce jointe (fichier non-image)
      if (t.hasAttribute("data-attdl")) {
        e.stopPropagation();
        const meta = attCache[t.dataset.attdl];
        if (!meta) return;
        try {
          const url = await attach.download(handle, meta);
          const a = document.createElement("a");
          a.href = url; a.download = meta.name || "fichier"; a.click();
        } catch (x) { toast(x.message); }
        return;
      }
      // Emoji choisi dans le popover
      if (t.dataset.emoji !== undefined) {
        e.stopPropagation();
        hidePicker();
        return react(pickMid, t.dataset.emoji);
      }
      // Bascule d'une réaction existante
      if (t.hasAttribute("data-react")) {
        e.stopPropagation();
        return react(t.dataset.mid, t.dataset.react);
      }
      // Suppression d'un message (réservé à l'émetteur)
      if (t.hasAttribute("data-del")) {
        e.stopPropagation();
        if (!(await confirmDialog("Supprimer ce message ?", { ok: "Supprimer", danger: true }))) return;
        try {
          await api(`/api/messages/${encodeURIComponent(handle)}/${t.dataset.del}`, { method: "DELETE", headers: authH });
        } catch (x) {
          toast(x.message);
        }
        return refresh();
      }
      // Ouverture du popover d'emoji
      if (t.hasAttribute("data-reactbtn")) {
        e.stopPropagation();
        pickMid = t.dataset.reactbtn;
        const pr = picker.parentElement.getBoundingClientRect();
        const br = t.getBoundingClientRect();
        picker.style.left = Math.max(8, br.left - pr.left - 60) + "px";
        picker.style.top = br.bottom - pr.top + 6 + "px";
        picker.hidden = false;
        return;
      }
      // Clic sur l'heure → (dé)plie le compte à rebours avant suppression
      if (t.classList.contains("t-time")) {
        e.stopPropagation();
        const mid = Number(t.dataset.mid);
        const cd = t.closest(".bubble")?.querySelector(".b-countdown");
        if (!cd) return;
        if (expandedTimes.has(mid)) {
          expandedTimes.delete(mid);
          cd.hidden = true;
        } else {
          expandedTimes.add(mid);
          cd.textContent = countdownText(cd.dataset.exp);
          cd.hidden = false;
        }
      }
    });
    overlay.addEventListener("click", (e) => {
      if (!picker.hidden && !picker.contains(e.target) && !e.target.closest("[data-reactbtn]")) hidePicker();
    });

    // Met à jour chaque seconde les comptes à rebours dépliés.
    const cdTimer = setInterval(() => {
      overlay.querySelectorAll(".b-countdown:not([hidden])").forEach((cd) => {
        cd.textContent = countdownText(cd.dataset.exp);
      });
    }, 1000);

    // L'expéditeur rafraîchit ses accusés quand l'autre lit.
    const unsubAck = onSSE("ack", (d) => {
      if (!d || d.from === handle) refresh();
    });
    // Envoi d'un plaintext (texte OU métadonnée de pièce jointe) : v2 (Double
    // Ratchet) si le pair a un bundle, sinon repli v1 (ECDH statique).
    async function sendPlaintext(text, ttl, once) {
      let body = null;
      // Multi-appareils : fan-out vers TOUS les appareils du pair + mes autres appareils.
      // Renvoie null si le pair n'a aucun appareil enrôlé → repli ratchet/v1 ci-dessous.
      if (host.md) {
        const fo = await host.md.fanoutEncrypt(myHandle, myKey, handle, text).catch(() => null);
        if (fo) body = { clientMsgId: fo.clientMsgId, envelopes: fo.envelopes };
      }
      if (!body && ratchet) {
        const r = await ratchet.send(myHandle, myKey, handle, peerPub, text);
        if (r) body = { iv: r.iv, ciphertext: r.ciphertext, senderPub: "", recipientPub: "" };
      }
      if (!body) {
        const enc = await e2eEncrypt(peerPub, text); // repli v1
        body = { ...enc, senderPub: host.e2e.myPub() || "", recipientPub: peerPub };
      }
      // Minuterie de disparition : on joint le ttl actif (le serveur le borne à 24 h).
      if (ttl && ttl < 86400) body.ttl = ttl;
      if (once) body.readOnce = true; // message à lecture unique
      await api(`/api/messages/${encodeURIComponent(handle)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authH },
        body: JSON.stringify(body),
      });
      refresh();
    }

    // Lecture unique (un-coup) : renvoie l'état armé et le réinitialise.
    const onceBtn = overlay.querySelector("#ch-once");
    const renderOnce = () => { if (onceBtn) { onceBtn.classList.toggle("armed", pendingOnce); onceBtn.setAttribute("aria-pressed", String(pendingOnce)); } };
    const takeOnce = () => { const v = pendingOnce; pendingOnce = false; renderOnce(); return v; };
    onceBtn?.addEventListener("click", () => { pendingOnce = !pendingOnce; renderOnce(); if (pendingOnce) toast(t("chat_next_once")); });

    // Brûle un message lecture-unique côté serveur (après révélation).
    async function burn(id) {
      try { await api(`/api/messages/${encodeURIComponent(handle)}/${id}/burn`, { method: "POST", headers: authH }); }
      catch { /* déjà supprimé / expiré */ }
    }

    // Change la minuterie de disparition : persiste + message de contrôle partagé
    // (envoyé en 24 h pour rester récupérable dans l'historique).
    function updateTimerLabel(sec) {
      const lbl = overlay.querySelector("#ch-timer-label");
      if (!lbl) return;
      if (sec >= 86400) {
        lbl.style.display = "none";
        lbl.textContent = "";
      } else {
        lbl.textContent = fmtTtl(sec);
        lbl.style.color = "var(--accent-ink)";
        lbl.style.display = "inline";
      }
    }

    async function setTimer(sec) {
      activeTtl = sec;
      updateTimerLabel(sec);
      try { localStorage.setItem(tmrKey, String(sec)); } catch {}
      try { await sendPlaintext(TMR_PREFIX + sec); } catch (e) { toast(e.message); }
    }

    // Popover de choix de minuterie (préréglages bornés à 24 h).
    const tmrPicker = document.createElement("div");
    tmrPicker.className = "react-pick";
    tmrPicker.hidden = true;
    tmrPicker.style.flexDirection = "column";
    updateTimerLabel(activeTtl); // initialise le label avec la valeur sauvegardée
    tmrPicker.innerHTML = TMR_PRESETS
      .map((s) => `<button type="button" data-tmr="${s}">${s >= 86400 ? t("chat_ttl_disabled_cap") : fmtTtl(s)}</button>`)
      .join("");
    overlay.querySelector(".chat-card").appendChild(tmrPicker);
    overlay.querySelector("#ch-timer")?.addEventListener("click", (e) => {
      if (!peerPub) { toast(t("chat_no_key_yet")); return; }
      const br = e.currentTarget.getBoundingClientRect();
      const pr = tmrPicker.parentElement.getBoundingClientRect();
      tmrPicker.style.left = Math.max(8, br.left - pr.left - 40) + "px";
      tmrPicker.style.top = br.bottom - pr.top + 6 + "px";
      tmrPicker.hidden = !tmrPicker.hidden;
    });
    tmrPicker.addEventListener("click", (e) => {
      const b = e.target.closest("[data-tmr]");
      if (!b) return;
      tmrPicker.hidden = true;
      setTimer(Number(b.dataset.tmr));
    });
    overlay.addEventListener("click", (e) => {
      if (!tmrPicker.hidden && !tmrPicker.contains(e.target) && !e.target.closest("#ch-timer")) tmrPicker.hidden = true;
    });

    overlay.querySelector("#ch-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim().slice(0, 1000);
      if (!text) return;
      input.value = "";
      try {
        await sendPlaintext(text, activeTtl, takeOnce());
      } catch (err) {
        toast(err.message);
        logFailure?.("chat", t("chat_msg_not_sent").replace("{handle}", handle), err, handle);
        input.value = text;
      }
    });

    // Pièce jointe : chiffrer + uploader le blob, puis envoyer la métadonnée
    // (clé incluse) comme message E2E normal.
    overlay.querySelector("#ch-attach")?.addEventListener("click", () => overlay.querySelector("#ch-file").click());
    overlay.querySelector("#ch-file")?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file || !attach) return;
      if (file.size > 10 * 1024 * 1024) { toast(t("chat_file_too_large")); return; }
      try {
        const meta = await attach.upload(handle, file);
        await sendPlaintext(attach.payload(meta), activeTtl, takeOnce());
      } catch (err) { toast(err.message || t("chat_send_fail")); logFailure?.("chat", t("chat_att_not_sent").replace("{handle}", handle), err, handle); }
    });

    // Message vocal : enregistre via MediaRecorder, chiffre + uploade comme pièce
    // jointe audio. Appui = démarrer, nouvel appui = arrêter & envoyer.
    const micBtn = overlay.querySelector("#ch-mic");
    if (!attach || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      micBtn?.remove(); // navigateur sans enregistrement audio
    }
    let rec = null, recChunks = [], recStream = null, recStart = 0, recTimer = null;
    const MAX_REC_MS = 5 * 60 * 1000;
    const pickAudioMime = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const resetMic = () => {
      clearInterval(recTimer);
      if (micBtn) { micBtn.textContent = "🎤"; micBtn.classList.remove("rec"); }
      recStream?.getTracks().forEach((t) => t.stop());
      rec = null; recStream = null; recChunks = [];
    };
    async function startRec() {
      try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { toast(t("chat_mic_unavailable")); return; }
      const mime = pickAudioMime();
      rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
      recChunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      rec.onstop = onRecStop;
      rec.start();
      recStart = Date.now();
      micBtn.classList.add("rec");
      recTimer = setInterval(() => {
        const s = Math.floor((Date.now() - recStart) / 1000);
        micBtn.textContent = `⏹ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        if (Date.now() - recStart >= MAX_REC_MS) rec.stop();
      }, 250);
    }
    async function onRecStop() {
      const dur = Date.now() - recStart;
      const type = (rec && rec.mimeType) || "audio/webm";
      const chunks = recChunks;
      resetMic();
      if (!chunks.length) { toast(t("chat_rec_empty")); return; }
      if (dur < 500) return; // trop court → ignoré
      const ext = type.includes("mp4") ? "m4a" : "webm";
      const file = new File(chunks, `voix.${ext}`, { type });
      if (file.size > 10 * 1024 * 1024) { toast(t("chat_voice_too_long")); return; }
      try {
        const meta = await attach.upload(handle, file);
        await sendPlaintext(attach.payload({ ...meta, dur }), activeTtl, takeOnce());
      } catch (err) { toast(err.message || t("chat_send_fail")); logFailure?.("chat", t("chat_voice_not_sent").replace("{handle}", handle), err, handle); }
    }
    micBtn?.addEventListener("click", () => { if (rec && rec.state === "recording") rec.stop(); else startRec(); });

    input.focus({ preventScroll: true });
    // refresh() est lancé quoi qu'il arrive : même si la clé E2E échoue, la
    // conversation se charge (messages éventuellement non déchiffrés).
    ensureE2E(myHandle, myKey)
      .then(() => ratchet && ratchet.ensurePrekeys(myHandle, myKey).catch(() => {}))
      .catch(() => {})
      .then(refresh);
    const timer = setInterval(refresh, 20000); // repli lent (le SSE gère le temps réel)
  }
  }

  /* ----------------------------- Groupes ------------------------------- */
  const groups = host.groups;

  // Liste des groupes + création (colonne du deck).
  function openGroups(myKey, myHandle) {
    myKey = myKey || storedKey();
    myHandle = myHandle || storedHandle();
    const html = `
      <div class="card" role="region" aria-label="${t("chat_groups")}">
        <button type="button" class="close" id="g-close" aria-label="${t("com_close")}">✕</button>
        <div class="section-title" style="border-top:none;padding-top:0;margin-top:0">${t("chat_groups_title")}</div>
        <div id="g-list"><p class="empty">${t("com_loading")}</p></div>
        <div class="section-title">${t("chat_new_group")}</div>
        <form id="g-new" style="display:flex;flex-direction:column;gap:.5rem;margin-top:.4rem">
          <input id="g-name" placeholder="${t("chat_group_name_ph")}" maxlength="80" />
          <input id="g-members" placeholder="${t("chat_group_members_ph")}" />
          <button class="btn primary sm" type="submit" style="align-self:flex-start">${t("chat_create")}</button>
        </form>
      </div>`;
    const col = host.openDeckColumn({ key: "groups", label: t("chat_groups"), html, wire: wire });
    function wire(overlay) {
      overlay.querySelector("#g-close").addEventListener("click", () => host.closeDeckColumn(overlay));
      const list = overlay.querySelector("#g-list");
      async function refresh() {
        try {
          const { groups: gs } = await groups.api.list();
          list.innerHTML = gs.length
            ? gs.map((g) => `<button type="button" class="btn" data-gid="${g.id}" style="display:block;width:100%;text-align:left;margin:.25rem 0">👥 ${esc(g.name || t("chat_group"))} <span class="deg">${t("chat_members_dot").replace("{n}", g.members.length)}</span></button>`).join("")
            : '<p class="empty">' + t("chat_no_groups") + '</p>';
          list.querySelectorAll("[data-gid]").forEach((b) =>
            b.addEventListener("click", () => openGroup(b.dataset.gid, myKey, myHandle)));
        } catch (e) { list.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
      }
      overlay.querySelector("#g-new").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = overlay.querySelector("#g-name").value.trim();
        const members = overlay.querySelector("#g-members").value.split(/[,\s]+/).map((s) => s.replace(/^@/, "").trim()).filter(Boolean);
        if (!members.length) { toast(t("chat_add_contact_min")); return; }
        try {
          const g = await groups.api.create(name, members);
          await groups.syncKeys(myHandle, myKey, g.id, g.members.map((m) => m.handle));
          toast(t("chat_group_created"));
          openGroup(g.id, myKey, myHandle);
          refresh();
        } catch (err) { toast(err.message || t("er_fail")); }
      });
      refresh();
    }
    if (col) col.querySelector("#g-name")?.focus({ preventScroll: true });
  }

  // Conversation de groupe (parité fonctionnelle complète avec openChat 1:1) :
  // sender keys + pièces jointes chiffrées + message vocal + lecture unique +
  // réactions + suppression. Les paquets de contrôle (att*, skd*) sont relayés
  // dans le ciphertext sender-key — le serveur ne voit que des blobs.
  function openGroup(gid, myKey, myHandle) {
    myKey = myKey || storedKey();
    myHandle = myHandle || storedHandle();
    const html = `
      <div class="card chat-card" role="region" aria-label="${t("chat_group")}">
        <button type="button" class="close" id="gc-close" aria-label="${t("com_close")}">✕</button>
        <div class="section-title chat-head" style="border-top:none;padding-top:0;margin-top:0" id="gc-title">${t("chat_group_head")}</div>
        <p class="sub" id="gc-note"></p>
        <div class="chat-log" id="gc-log"><p class="empty">${t("com_loading")}</p></div>
        <form id="gc-form" class="chat-form">
          <div class="chat-actions">
            <button type="button" class="btn" id="gc-attach" title="${t("chat_attach_file")}" aria-label="${t("chat_attach_file")}">📎</button>
            <button type="button" class="btn" id="gc-mic" title="${t("chat_rec_voice")}" aria-label="${t("chat_voice_msg")}">🎤</button>
            <button type="button" class="btn" id="gc-once" title="${t("chat_once")}" aria-label="${t("chat_once_short")}" aria-pressed="false">👁</button>
            <input type="file" id="gc-file" hidden />
          </div>
          <div class="chat-input-row">
            <input id="gc-input" placeholder="${t("chat_group_input_ph")}" autocomplete="off" maxlength="1000" />
            <button class="btn primary" type="submit" title="${t("chat_send")}" aria-label="${t("chat_send")}">${svgIcon("send", 18)}</button>
          </div>
        </form>
      </div>`;
    host.openDeckColumn({ key: `group:${gid}`, label: t("chat_group"), html, wire });
    function wire(overlay) {
      let group = null;
      const log = overlay.querySelector("#gc-log");
      const input = overlay.querySelector("#gc-input");
      const attachBtn = overlay.querySelector("#gc-attach");
      const fileInp = overlay.querySelector("#gc-file");
      const micBtn = overlay.querySelector("#gc-mic");
      const onceBtn = overlay.querySelector("#gc-once");
      const expandedTimes = new Set();
      const attCache = {}; // mid → meta pièce jointe
      const revealed = new Set(); // ids de messages lecture-unique révélés
      let pendingOnce = false; // « lecture unique » armé pour le prochain envoi
      const takeOnce = () => { const v = pendingOnce; pendingOnce = false; onceBtn.setAttribute("aria-pressed", "false"); return v; };
      const close = () => { clearInterval(timer); clearInterval(cdTimer); unsub(); host.closeDeckColumn(overlay); };
      overlay.querySelector("#gc-close").addEventListener("click", close);
      connectSSE(myKey);
      const unsub = onSSE("group", (d) => { if (!d || d.gid === gid) refresh(); });

      async function sendPlaintext(payload, opts = {}) {
        try { await groups.send(myHandle, myKey, gid, payload, opts); refresh(); }
        catch (err) { toast(err.message || t("er_fail")); }
      }

      async function refresh() {
        if (!overlay.isConnected) { clearInterval(timer); return; }
        try {
          group = await groups.api.get(gid);
          const canManage = group.role === "owner" || group.role === "admin";
          overlay.querySelector("#gc-title").innerHTML =
            `👥 ${esc(group.name || t("chat_group"))} <span class="deg">${t("chat_group_members_enc").replace("{n}", group.members.length)}</span>` +
            (canManage ? ` <button type="button" class="btn sm" id="gc-manage">${t("chat_manage")}</button>` : "");
          // S'assurer d'avoir/diffuser les sender keys, puis charger.
          await groups.syncKeys(myHandle, myKey, gid, group.members.map((m) => m.handle));
          const d = await groups.load(myHandle, myKey, gid);
          overlay.querySelector("#gc-note").textContent = t("chat_e2e_ephemeral").replace("{h}", d.ttlHours);
          const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
          log.innerHTML = d.messages.length
            ? d.messages.map((m) => {
                const time = new Date(m.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
                const who = m.mine ? "" : `<span class="deg" style="font-size:.78em">@${esc(m.sender)}</span><br>`;
                const att = m.text && attach ? attach.parse(m.text) : null;
                const isOnce = m.read_once;
                let body;
                if (m.pending) {
                  body = `<span class="b-text">🔑 <span class="deg">${t("chat_awaiting_key").replace("{sender}", esc(m.sender))}</span></span>`;
                } else if (isOnce && m.mine) {
                  body = `<span class="b-text" style="opacity:.7">${t("chat_once_tombstone")}</span>`;
                } else if (isOnce && !revealed.has(m.id)) {
                  body = `<span class="b-att b-once" data-reveal="${m.id}" style="cursor:pointer">${t("chat_once_reveal")}</span>`;
                } else if (att) {
                  attCache[m.id] = att;
                  const sz = att.size > 0 ? ` · ${(att.size / 1024 < 1024 ? (att.size / 1024).toFixed(0) + " " + t("chat_unit_kb") : (att.size / 1048576).toFixed(1) + " " + t("chat_unit_mb"))}` : "";
                  const mime = att.mime || "";
                  if (mime.startsWith("image/")) {
                    body = `<span class="b-att b-att-img" data-mid="${m.id}" title="${esc(att.name)}">${t("chat_att_img_loading").replace("{name}", esc(att.name))}</span>`;
                  } else if (mime.startsWith("audio/")) {
                    const dur = att.dur ? ` · ${Math.round(att.dur / 1000)} s` : "";
                    body = `<span class="b-att b-att-audio" data-mid="${m.id}">${t("chat_att_audio_loading").replace("{dur}", dur)}</span>`;
                  } else {
                    body = `<span class="b-att b-att-file" data-mid="${m.id}">📎 ${esc(att.name)}${sz} <button type="button" class="btn sm" data-attdl="${m.id}">${t("chat_download")}</button></span>`;
                  }
                } else {
                  body = m.text === null
                    ? `<span class="b-text">${t("chat_undecipherable")}</span>`
                    : `<span class="b-text">${esc(m.text)}</span>`;
                }
                const reacts = (m.reactions || [])
                  .map((r) => `<button type="button" class="react ${r.mine ? "mine" : ""}" data-react="${esc(r.emoji)}" data-mid="${m.id}">${r.emoji}${r.count > 1 ? " " + r.count : ""}</button>`)
                  .join("");
                const open = expandedTimes.has(m.id);
                return `<div class="bubble ${m.mine ? "mine" : "theirs"}" data-mid="${m.id}">${who}${body}
                  ${reacts ? `<div class="b-reacts">${reacts}</div>` : ""}
                  <span class="t">
                    <span class="t-time" data-exp="${esc(m.expires_at)}" data-mid="${m.id}" role="button" tabindex="0" title="${t("chat_time_title")}">${esc(time)}</span>
                    <button type="button" class="b-react-btn" data-reactbtn="${m.id}" title="${t("chat_react")}" aria-label="${t("chat_react")}">🙂</button>
                    ${m.mine ? `<button type="button" class="b-del" data-del="${m.id}" title="${t("com_delete")}" aria-label="${t("com_delete")}">✕</button>` : ""}
                  </span>
                  <span class="b-countdown" data-exp="${esc(m.expires_at)}" ${open ? "" : "hidden"}>${open ? esc(countdownText(m.expires_at)) : ""}</span>
                </div>`;
              }).join("")
            : '<p class="empty">' + t("chat_no_messages") + '</p>';
          // Téléchargement différé des images.
          for (const el of log.querySelectorAll(".b-att-img")) {
            const meta = attCache[el.dataset.mid];
            if (!meta) continue;
            groups.attachDownload(gid, meta)
              .then((url) => { el.innerHTML = `<img src="${url}" alt="${esc(meta.name)}" style="max-width:min(78%,340px);width:auto;border-radius:12px;display:block" />`; if (atBottom) log.scrollTop = log.scrollHeight; })
              .catch(() => { el.textContent = t("chat_att_unavailable"); });
          }
          // Téléchargement différé des messages vocaux.
          for (const el of log.querySelectorAll(".b-att-audio")) {
            const meta = attCache[el.dataset.mid];
            if (!meta) continue;
            groups.attachDownload(gid, meta)
              .then((url) => {
                const aud = document.createElement("audio");
                aud.controls = true; aud.preload = "metadata";
                aud.style.cssText = "vertical-align:middle;width:280px;max-width:100%";
                aud.src = url;
                el.innerHTML = "🎤 ";
                el.appendChild(aud);
                if (atBottom) log.scrollTop = log.scrollHeight;
              })
              .catch(() => { el.textContent = t("chat_voice_unavailable"); });
          }
          if (atBottom) log.scrollTop = log.scrollHeight;
        } catch (e) { log.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
      }

      // Picker emoji partagé (un seul popover par groupe pour ne pas clignoter au refresh).
      const picker = document.createElement("div");
      picker.className = "react-pick"; picker.hidden = true;
      picker.innerHTML = QUICK_EMOJIS.map((em) => `<button type="button" data-emoji="${em}">${em}</button>`).join("");
      overlay.querySelector(".chat-card").appendChild(picker);
      let pickMid = null;
      const hidePicker = () => (picker.hidden = true);

      async function react(mid, emoji) {
        try { await groups.api.react(gid, Number(mid), emoji); } catch (e) { toast(e.message); }
        refresh();
      }
      async function burn(mid) {
        try { await groups.api.burnMessage(gid, mid); } catch {}
      }

      // Délégation : couvre boutons des bulles + sélecteur, robuste aux rafraîchissements.
      overlay.querySelector(".chat-card").addEventListener("click", async (e) => {
        const t = e.target.closest && e.target.closest("[data-emoji],[data-react],[data-del],[data-reactbtn],[data-exp][data-mid],[data-attdl],[data-reveal]");
        if (!t) return;
        if (t.hasAttribute("data-reveal")) {
          e.stopPropagation();
          const id = Number(t.dataset.reveal);
          revealed.add(id);
          await refresh();
          burn(id);
          return;
        }
        if (t.hasAttribute("data-attdl")) {
          e.stopPropagation();
          const meta = attCache[t.dataset.attdl]; if (!meta) return;
          try { const url = await groups.attachDownload(gid, meta); const a = document.createElement("a"); a.href = url; a.download = meta.name || "fichier"; a.click(); }
          catch (x) { toast(x.message); }
          return;
        }
        if (t.dataset.emoji !== undefined) { e.stopPropagation(); hidePicker(); return react(pickMid, t.dataset.emoji); }
        if (t.hasAttribute("data-react")) { e.stopPropagation(); return react(t.dataset.mid, t.dataset.react); }
        if (t.hasAttribute("data-del")) {
          e.stopPropagation();
          if (!(await confirmDialog("Supprimer ce message ?", { ok: "Supprimer", danger: true }))) return;
          try { await groups.api.deleteMessage(gid, t.dataset.del); } catch (x) { toast(x.message); }
          return refresh();
        }
        if (t.hasAttribute("data-reactbtn")) {
          e.stopPropagation();
          pickMid = t.dataset.reactbtn;
          const pr = picker.parentElement.getBoundingClientRect();
          const br = t.getBoundingClientRect();
          picker.style.left = Math.max(8, br.left - pr.left - 60) + "px";
          picker.style.top = br.bottom - pr.top + 6 + "px";
          picker.hidden = false;
          return;
        }
        // Clic sur l'heure → (dé)plie le compte à rebours avant suppression.
        if (t.classList.contains("t-time")) {
          e.stopPropagation();
          const mid = Number(t.dataset.mid);
          const cd = t.closest(".bubble")?.querySelector(".b-countdown");
          if (!cd) return;
          if (expandedTimes.has(mid)) { expandedTimes.delete(mid); cd.hidden = true; }
          else { expandedTimes.add(mid); cd.textContent = countdownText(cd.dataset.exp); cd.hidden = false; }
        }
      });
      overlay.addEventListener("click", (e) => {
        if (!picker.hidden && !picker.contains(e.target) && !e.target.closest("[data-reactbtn]")) hidePicker();
      });
      const cdTimer = setInterval(() => {
        overlay.querySelectorAll(".b-countdown:not([hidden])").forEach((cd) => { cd.textContent = countdownText(cd.dataset.exp); });
      }, 1000);

      // Le bouton « Gérer » est intercepté en capture par editor/index.js
      // (openManageGroupInline) — on garde le handler local en repli si l'UI
      // hors-Échanges l'utilise (deck column standalone).
      overlay.addEventListener("click", (e) => {
        if (e.target.closest("#gc-manage") && !e.defaultPrevented) {
          e.stopPropagation();
          legacyManage();
        }
      });
      async function legacyManage() {
        if (!group) return;
        const handle = await host.promptDialog(t("chat_add_member_prompt"), { placeholder: "@handle", ok: t("chat_add") });
        if (!handle) return;
        try { await groups.api.addMember(gid, handle.replace(/^@/, "").trim()); refresh(); }
        catch (e) { toast(e.message || t("er_fail")); }
      }

      // ── Pièces jointes (fichier + image) ──────────────────────────────
      attachBtn?.addEventListener("click", () => fileInp.click());
      fileInp?.addEventListener("change", async () => {
        const file = fileInp.files?.[0]; if (!file) return;
        fileInp.value = "";
        if (file.size > 10 * 1024 * 1024) { toast(t("chat_file_too_large")); return; }
        try {
          const meta = await groups.attachUpload(gid, file);
          await sendPlaintext(attach.payload(meta), { readOnce: takeOnce() });
        } catch (err) { toast(err.message || t("chat_send_fail")); }
      });

      // ── Lecture unique ─────────────────────────────────────────────────
      onceBtn?.addEventListener("click", () => {
        pendingOnce = !pendingOnce;
        onceBtn.setAttribute("aria-pressed", String(pendingOnce));
      });

      // ── Message vocal (MediaRecorder, mêmes contraintes que 1:1) ──────
      let rec = null, recChunks = [], recStream = null, recStart = 0, recTimer = null;
      const MAX_REC_MS = 5 * 60 * 1000;
      const pickAudioMime = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const resetMic = () => {
        clearInterval(recTimer);
        if (micBtn) { micBtn.textContent = "🎤"; micBtn.classList.remove("rec"); }
        recStream?.getTracks().forEach((t) => t.stop());
        rec = null; recStream = null; recChunks = [];
      };
      async function startRec() {
        try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch { toast(t("chat_mic_unavailable")); return; }
        const mime = pickAudioMime();
        rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
        recChunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
        rec.onstop = onRecStop;
        rec.start(); recStart = Date.now();
        micBtn.classList.add("rec");
        recTimer = setInterval(() => {
          const s = Math.floor((Date.now() - recStart) / 1000);
          micBtn.textContent = `⏹ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
          if (Date.now() - recStart >= MAX_REC_MS) rec.stop();
        }, 250);
      }
      async function onRecStop() {
        const dur = Date.now() - recStart;
        const type = (rec && rec.mimeType) || "audio/webm";
        const chunks = recChunks;
        resetMic();
        if (!chunks.length) { toast(t("chat_rec_empty_short")); return; }
        if (dur < 500) return;
        const ext = type.includes("mp4") ? "m4a" : "webm";
        const file = new File(chunks, `voix.${ext}`, { type });
        if (file.size > 10 * 1024 * 1024) { toast(t("chat_voice_too_long")); return; }
        try {
          const meta = await groups.attachUpload(gid, file);
          await sendPlaintext(attach.payload({ ...meta, dur }), { readOnce: takeOnce() });
        } catch (err) { toast(err.message || t("chat_send_fail")); }
      }
      micBtn?.addEventListener("click", () => { if (rec && rec.state === "recording") rec.stop(); else startRec(); });

      // ── Envoi texte ────────────────────────────────────────────────────
      overlay.querySelector("#gc-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = input.value.trim().slice(0, 1000);
        if (!text) return;
        input.value = "";
        const opts = { readOnce: takeOnce() };
        try { await groups.send(myHandle, myKey, gid, text, opts); refresh(); }
        catch (err) { toast(err.message); input.value = text; }
      });
      input.focus({ preventScroll: true });
      refresh();
      const timer = setInterval(refresh, 20000);
    }
  }

  // La conversation s'ouvre depuis une notification de message, le bouton
  // « Discuter » d'un profil public, ou un appel à host.chat.open(handle).
  host.registerPlugin({ name: "chat" });

  host.chat = { open: openChat, openGroup, openGroups };
}
