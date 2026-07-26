// editor/index.js — éditeur privé : orchestrateur (renderPrivate) + rendu
// (renderEditor) + câblage (wireEditor) + colonne contact + aides internes.
// Importe le socle (core/state/deck/host/ui/crypto) ; quelques builders de vue
// partagés avec landing/profil viennent de ../app.js (cycle assumé, usage runtime).
// Extrait verbatim de app.js. cf. docs/web-app-split-proposal.md
import { PENDING_INVITE, connectSSE, eventsHtml, footer, headerAccount, notifItemHtml, openMiloTourPicker, openQR, periodsListHtml, profileCardHtml, relItemHtml, relationsListHtml, tagChipsHtml, wireProfileMenuBtn } from "../app.js";
import { DEFAULT_SETTINGS, DOW_LETTERS, DOW_NAMES, TOUR_SEEN_KEY, app, myHandle, myKey, normalizeAvailability, pick, relDate, setLastHandle, setMeProfile, setSessionHint, setStoredHandle, setStoredKey, storedHandle, storedKey, viewerHeaders } from "../core.js";
import { e2eDecrypt, e2eEncrypt, ensureE2E } from "../crypto/e2e.js";
import { mdDeviceId } from "../crypto/multidevice.js";
import { ratchetEnsurePrekeys } from "../crypto/ratchet.js";
import { E2E } from "../crypto/state.js";
import { e2eSaveVault, e2eVaultGet } from "../crypto/vault.js";
import { host } from "../host.js";
import { CREDIT, t, setLangCode } from "../i18n.js";
import { api, authHeaders, jsonAuth, setAccessKey } from "../net.js";
import { appState } from "../state.js";
import { ACCENT_STORE, applyAccent, applyTheme, storedAccent, toggleTheme } from "../theme.js";
import { confirmDialog, copyText, esc, promptDialog, promptPassphrase, promptPin, toast } from "../ui/dom.js";
import { SOCIALS, SOCIAL_BY_KEY, avatarHtml, genericAvatarSvg, icon, isSocialKey, miloSvg, siteHeader, socialFieldKey, socialIcon, socialUrl } from "../ui/icons.js";
import { openE2eBackup, openE2eRestore } from "../ui/modals.js";
import { openCoverEditor } from "../ui/cover-editor.js";
import { resolveMediaUrl, syncOwnerMediaKeys, uploadEncrypted } from "../premium/storage-client.js";
import { addDeckColumn, deckState, removeDeckColumn } from "./deck.js";
import { renderOptionsColumn } from "./tabs/options.js";
import { renderIdentityColumn } from "./tabs/identity.js";
import { renderAgendaColumn } from "./tabs/agenda.js";
import { renderRelationsColumn } from "./tabs/relations.js";
import { wireRelationsGraph } from "./relations-graph.js";
import { renderNotificationsColumn } from "./tabs/notifications.js";
import { renderAccountColumn, activityLogInnerHtml } from "./tabs/account.js";
import { clearActivityLog, onActivityLog } from "../activity-log.js";
import { pbRowHtml, renderPremiumPage } from "./tabs/premium.js";

export async function consumePendingInvite() {
  let token = null;
  try { token = sessionStorage.getItem(PENDING_INVITE); } catch {}
  if (!token) return;
  try { sessionStorage.removeItem(PENDING_INVITE); } catch {}
  try {
    const r = await api(`/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() } });
    toast(t("eix_invite_accepted").replace("{handle}", r.handle));
  } catch { /* invitation expirée / déjà utilisée */ }
}

export function dayLoadMap(data) {
  const load = {};
  (data.events || []).forEach((e) => {
    const d = (e.starts_at || "").slice(0, 10);
    if (d) load[d] = (load[d] || 0) + 1;
  });
  (data.requests || []).forEach((r) => {
    if (r.day && r.status === "accepted") load[r.day] = (load[r.day] || 0) + 1;
  });
  return load;
}

export async function renderPrivate(key) {
  const cookieMode = !key; // /me : auth par cookie de session ; /k/{clé} : auth par clé
  appState.key = key; // null en mode cookie (l'auth passe par le cookie)
  setAccessKey(appState.key); // reflète la clé dans net.js (authHeaders/jsonAuth)
  app.innerHTML = `<p class="loading">${t("com_loading")}</p>`;
  let data;
  try {
    data = await api("/api/me", { headers: authHeaders() });
    appState.myRelations = data?.relations?.[1] || [];
    void window.mindlogLocalPim?.save?.(data); // cache PIM hors-ligne (best-effort)
  } catch {
    // Hors-ligne (échec réseau) : si un cache PIM local existe, on affiche l'éditeur
    // depuis le cache plutôt que d'échouer. Le chat E2E reste indisponible hors-ligne.
    const cachedPim = window.mindlogLocalPim ? await window.mindlogLocalPim.load().catch(() => null) : null;
    if (cachedPim) {
      appState.myRelations = cachedPim?.relations?.[1] || [];
      if (cookieMode) setSessionHint(true);
      appState.auth = { handle: cachedPim.handle, key: appState.key };
      connectSSE(cookieMode ? null : appState.key);
      renderEditor(cachedPim);
      toast(t("rp_offline"));
      return;
    }
    if (cookieMode) {
      // Session absente/expirée : on oublie l'indice et on revient à l'accueil.
      setSessionHint(false);
      location.replace("/");
      return;
    }
    app.style.cssText = "display:flex;align-items:center;justify-content:center;min-height:100dvh";
    app.innerHTML = `
      <div class="card" style="text-align:center;max-width:340px">
        <div class="empty-milo">${miloSvg(110)}</div>
        <h1>${t("rp_invalid_key_title")}</h1>
        <p class="subtitle">${t("rp_invalid_key_sub")}</p>
        <a class="btn primary" href="/">${t("cv_home")}</a>
      </div>`;
    return;
  }
  if (!cookieMode) {
    // Lien /k/{clé} : on échange la clé contre une session cookie afin de la
    // retirer de la barre d'URL, puis on rejoint /me. La clé n'est plus en URL.
    try {
      await api("/api/auth/session-from-key", { method: "POST", headers: { "x-access-key": key } });
      setLastHandle(data.handle);
      setSessionHint(true);
      setStoredKey(null); // migration : plus besoin de conserver la clé en localStorage
      setStoredHandle(null);
      location.replace("/me");
      return;
    } catch {
      // Échec réseau : on poursuit en mode lien classique (clé dans l'URL).
    }
  }
  if (cookieMode) {
    appState.key = data.accessKey || null; // récupère la clé pour afficher le lien privé / QR / rotation
    setAccessKey(appState.key); // reflète la clé (mode cookie) dans net.js
    setSessionHint(true);
    appState.auth = { handle: data.handle, key: appState.key }; // état d'auth cohérent pour les pages suivantes
  }
  setLastHandle(data.handle); // mémorise le handle de la dernière connexion (reconnexion auto + pré-remplissage)
  if (storedKey() === appState.key) setStoredHandle(data.handle); // garde le handle associé à la clé mémorisée
  connectSSE(cookieMode ? null : appState.key); // flux temps réel (notifications, messages)
  // Premium dev : l'état réel vient de /api/me (ligne d'abonnement provider "dev"
  // posée par le toggle Options via POST /api/dev/premium) → par-utilisateur, pas
  // de simulation client. Plus de patch localStorage ici.
  renderEditor(data); // affiche l'UI immédiatement, sans attendre la clé E2E
  // E2E en arrière-plan : ne bloque pas le rendu (la clé n'est utile que pour le chat).
  // On publie aussi le bundle de prekeys dès la connexion : ainsi un contact peut
  // m'écrire en v2 (Double Ratchet) sans attendre que j'ouvre une conversation.
  const hadPubkey = !!data.pubkey;
  ensureE2E(data.handle, appState.key)
    .then(async () => {
      if (!E2E.pubStr && data.pubkey) E2E.pubStr = data.pubkey;
      if (E2E.needsRestore) {
        // Clé dans le coffre mais absente du navigateur → restauration nécessaire.
        toast(t("rp_e2e_restore"));
        openE2eRestore(data.handle, appState.key, () => renderPrivate(appState.key));
        return;
      }
      if (!hadPubkey && E2E.pubStr) toast(t("rp_e2e_enabled"));
      // Clé neuve (ou jamais sauvegardée) sans coffre → on FORCE la mise en coffre
      // dès la connexion : sans ça, perte d'appareil = messages illisibles.
      if (E2E.needsBackup) {
        openE2eBackup(data.handle, appState.key, () => renderPrivate(appState.key), { mandatory: true });
      }
      return ratchetEnsurePrekeys(data.handle, appState.key);
    })
    .catch(() => {
      if (!hadPubkey) {
        const msg = window.isSecureContext === false || !crypto.subtle
          ? t("rp_e2e_https")
          : t("rp_e2e_fail");
        toast(msg);
      }
    });
}

/* --------------------------- Abonnement Premium (P3) --------------------- */
// Intention d'upgrade mémorisée avant inscription (parcours anonyme → compte).
const PENDING_UPGRADE = "mindlog.pendingUpgrade";

// Démarre un abonnement : ouvre le Checkout Stripe (redirection).
async function startCheckout() {
  try {
    const res = await api("/api/billing/checkout", { method: "POST", headers: jsonAuth() });
    if (res?.url) { location.assign(res.url); return; }
    toast(res?.error || t("bi_subs_unavailable"));
  } catch (e) {
    toast(e?.message || t("bi_subs_unavailable"));
  }
}

// Ouvre le portail de facturation Stripe (gérer/résilier/changer de carte).
async function openBillingPortal() {
  try {
    const res = await api("/api/billing/portal", { method: "POST", headers: jsonAuth() });
    if (res?.url) { location.assign(res.url); return; }
    toast(res?.error || t("bi_unavailable"));
  } catch (e) {
    toast(e?.message || t("bi_unavailable"));
  }
}

// Retour de Stripe : le Premium est activé par le webhook (asynchrone), on
// attend que l'état serveur bascule avant de débloquer l'UI.
async function pollPremiumActivation() {
  toast(t("bi_activating"));
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const fresh = await api("/api/me", { headers: authHeaders() });
      if (fresh?.subscription?.plan === "premium" || fresh?.plan === "premium") {
        toast(t("bi_welcome"));
        renderEditor(fresh);
        return;
      }
    } catch { /* on réessaie */ }
  }
  toast(t("bi_activating_slow"));
}

// Gère les retours de paiement (?upgrade=success|cancel|start) et la reprise
// d'intention après inscription (sessionStorage). Appelé en fin de renderEditor.
function handleBilling(data) {
  let upgrade = null;
  let pending = false;
  try {
    upgrade = new URLSearchParams(location.search).get("upgrade");
    pending = sessionStorage.getItem(PENDING_UPGRADE) === "1";
  } catch { /* storage/URL indisponible */ }
  const cleanUrl = () => { try { history.replaceState(null, "", location.pathname); } catch { /* noop */ } };
  const premium = data?.subscription?.plan === "premium" || data?.plan === "premium";

  // Retour d'onboarding Stripe Connect (créateur).
  let connect = null;
  try { connect = new URLSearchParams(location.search).get("connect"); } catch { /* noop */ }
  if (connect === "done") { cleanUrl(); toast(t("bi_pay_config_saved")); return; }
  if (connect === "refresh") { cleanUrl(); toast(t("bi_pay_config_resume")); return; }

  if (upgrade === "cancel") {
    cleanUrl();
    toast(t("bi_pay_cancelled"));
    return;
  }
  if (upgrade === "success") {
    cleanUrl();
    if (premium) toast(t("bi_welcome"));
    else void pollPremiumActivation();
    return;
  }
  if (upgrade === "start" || pending) {
    try { sessionStorage.removeItem(PENDING_UPGRADE); } catch { /* noop */ }
    cleanUrl();
    if (premium) { toast(t("bi_already_premium")); return; }
    void startCheckout();
  }
}

// Icône représentant un type de page (utilisé dans la liste).
const ppTypeIcon = (t) =>
  t === "gallery" ? icon("image", 14)
  : t === "link"  ? icon("link", 14)
  : t === "file"  ? icon("download", 14)
  :                 icon("chat", 14); // markdown par défaut

// Slug auto-généré à partir du titre. Reste éditable par l'utilisateur tant
// qu'il n'a pas saisi son propre slug (suivi via dataset.touched sur l'input).
function slugifyTitle(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// HTML des champs spécifiques à un type de page. Le payload est lu plus tard
// par collectTypeContent() en relisant ces mêmes inputs.
// Auto-préfixe https:// si l'utilisateur a tapé un domaine sans schéma
// (ex. "exemple.com" → "https://exemple.com"). Conserve mailto:/tel:/data:.
// Évite le rejet serveur silencieux "URL invalide (http/https requis)".
function autoHttps(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^(https?:\/\/|mailto:|tel:|data:)/i.test(s)) return s;
  return "https://" + s;
}

function ppTypeFieldsHtml(type, current, ctx = {}) {
  if (type === "markdown") {
    const v = typeof current === "string" ? current : "";
    return `<textarea id="pp-md" rows="8" placeholder="${esc(t("pw_md_ph"))}" maxlength="50000">${esc(v)}</textarea>`;
  }
  if (type === "link") {
    const o = (current && typeof current === "object") ? current : {};
    return `<input id="pp-link-url" type="text" inputmode="url" autocomplete="off" placeholder="${t("pw_link_url_ph")}" maxlength="2000" value="${esc(o.url || "")}">
            <input id="pp-link-note" placeholder="${t("pw_link_note_ph")}" maxlength="500" value="${esc(o.note || "")}">`;
  }
  if (type === "gallery") {
    // Médias chiffrés côté client puis uploadés DIRECTEMENT vers le stockage
    // tiers du créateur (cf. premium/storage-client). Rien n'est hébergé par
    // id.mindlog ; le tiers ne voit que du chiffré. Les vignettes chiffrées sont
    // déchiffrées à l'affichage (hydrateGalThumbs).
    const items = (current && Array.isArray(current.items)) ? current.items : [];
    const handle = ctx.handle || "";
    const gridHtml = items.map((it) => galItemHtml(it)).join("");
    return `<div class="gal-grid pp-gal-grid" id="pp-gal-grid" data-handle="${esc(handle)}">${gridHtml}</div>
            <div class="gal-drop pp-gal-drop" id="pp-gal-drop">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span>${t("pw_gal_drop")}</span>
              <label class="btn sm" style="cursor:pointer">${t("pw_browse")}
                <input type="file" accept="image/*,video/*" multiple hidden id="pp-gal-file" />
              </label>
              <button type="button" class="btn sm ghost" id="pp-gal-url">${t("pw_add_url")}</button>
            </div>
            <p class="lbl-sm" id="pp-gal-hint" style="margin:.4rem 0 0;opacity:.7">${icon("lock", 12)} ${t("pw_gal_hint")}</p>`;
  }
  if (type === "file") {
    const o = (current && typeof current === "object") ? current : {};
    const handle = ctx.handle || "";
    const hasFile = !!o.url;
    return `<div class="pp-file-state" id="pp-file-state" data-handle="${esc(handle)}" data-url="${esc(o.url || "")}" data-enc="${o.enc ? "1" : ""}" data-mime="${esc(o.mime || "")}" data-name="${esc(o.name || "")}" data-size="${esc(String(o.size || 0))}">
        ${hasFile
          ? `<div class="pp-file-card">
              <span class="pp-file-ic">${icon("download", 18)}</span>
              <div class="pp-file-info">
                <b>${esc(o.name || t("pp_file_default"))}</b>
                <span class="lbl-sm">${o.size ? `${(o.size/1024).toFixed(1)} ${t("pp_kb")}` : ""} ${o.enc ? "· " + t("pw_encrypted") : ""}</span>
              </div>
              <button type="button" class="btn sm danger" id="pp-file-del">${t("pw_replace")}</button>
            </div>`
          : `<div class="pp-file-empty">
              <span class="pp-file-ic">${icon("download", 22)}</span>
              <p>${icon("lock", 12)} ${t("pw_file_empty")}</p>
              <label class="btn primary sm" style="cursor:pointer">${t("pw_choose_file")}
                <input type="file" hidden id="pp-file-input">
              </label>
            </div>`}
      </div>`;
  }
  return "";
}

// Vignette unique pour la grille galerie du wizard. L'item porte l'URL externe
// (stockage tiers) + `enc`/`mime`. Pour un média chiffré, le src est posé après
// déchiffrement par hydrateGalThumbs ; sinon directement.
function galItemHtml(it) {
  const url = String(it.url || "");
  const enc = it.enc === true || it.enc === "1";
  const isVideo = it.kind === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(url);
  const src = enc ? "" : (/^https?:\/\//i.test(url) ? ` src="${esc(url)}"` : "");
  return `<div class="gal-item${enc ? " pp-media-enc pp-gal-loading" : ""}" data-url="${esc(url)}" data-enc="${enc ? "1" : ""}" data-mime="${esc(it.mime || "")}" data-kind="${isVideo ? "video" : "image"}">
    ${isVideo
      ? `<video${src} muted playsinline preload="metadata"></video>`
      : `<img${src} alt="${esc(it.caption || "")}" loading="lazy" />`}
    <button type="button" class="gal-del" title="${t("com_delete")}">✕</button>
  </div>`;
}

// Déchiffre les vignettes chiffrées de la grille (éditeur) et pose l'objectURL.
async function hydrateGalThumbs(grid, handle) {
  const els = grid.querySelectorAll(".pp-media-enc:not([data-hydrated])");
  for (const el of els) {
    el.dataset.hydrated = "1";
    try {
      const objUrl = await resolveMediaUrl(handle, { url: el.dataset.url, enc: true, mime: el.dataset.mime, kind: el.dataset.kind });
      const media = el.querySelector("img,video");
      if (media) media.src = objUrl;
      el.classList.remove("pp-gal-loading");
    } catch {
      el.classList.add("pp-gal-error");
      el.classList.remove("pp-gal-loading");
    }
  }
}

// Lit les inputs du formulaire et reconstruit le payload `content` attendu
// par le backend (chaîne pour markdown, objet sérialisable pour les autres).
// Pour la galerie : on relit l'état persisté dans #pp-gal-grid (chaque .gal-item
// a son data-filename) — le textarea n'existe plus.
function collectTypeContent(root, type) {
  if (type === "markdown") return root.querySelector("#pp-md")?.value || "";
  if (type === "link") {
    return {
      url: autoHttps(root.querySelector("#pp-link-url")?.value),
      note: (root.querySelector("#pp-link-note")?.value || "").trim(),
    };
  }
  if (type === "gallery") {
    const grid = root.querySelector("#pp-gal-grid");
    if (!grid) return { items: [] };
    const items = [...grid.querySelectorAll(".gal-item")].map((el) => ({
      url: el.dataset.url || "",
      kind: el.dataset.kind === "video" ? "video" : "image",
      caption: "",
      enc: el.dataset.enc === "1",
      mime: el.dataset.mime || "",
    })).filter((it) => /^https?:\/\//i.test(it.url));
    return { items };
  }
  if (type === "file") {
    const st = root.querySelector("#pp-file-state");
    if (!st) return { url: "", name: "", size: 0 };
    return {
      url: st.dataset.url || "",
      name: st.dataset.name || "",
      size: Number(st.dataset.size || 0),
      enc: st.dataset.enc === "1",
      mime: st.dataset.mime || "",
    };
  }
  return null;
}

// Charge le tarif de l'espace + intro Markdown + brancher les sauvegardes.
// Idempotent : appelé à chaque rendu de la page Premium.
async function loadSpacePricing(root) {
  const priceInput = root.querySelector("#sp-price");
  const status = root.querySelector("#sp-status");
  const introTa = root.querySelector("#sp-intro");
  const introStatus = root.querySelector("#sp-intro-status");
  // Note : l'intro du profil (#sp-profile-intro) a été déplacée dans l'onglet
  // Identité (non-Premium). Câblage propre dans wireEditor.
  const benefitCbs = root.querySelectorAll(".prem-benefit-cb");
  const benefitStatus = root.querySelector("#prem-benefits-status");
  if (!priceInput && !introTa && !benefitCbs.length) return;
  let currentBenefits = { chat: true, call: true, pages: true, rdv: true, lives: true };
  try {
    const sp = await api("/api/space", { headers: authHeaders() });
    if (priceInput && sp.price_cents) priceInput.value = (sp.price_cents / 100).toFixed(2);
    if (status) status.textContent = sp.active ? t("sp_sellable") : (sp.price_cents ? t("sp_price_pending") : "");
    if (introTa && typeof sp.intro_md === "string") introTa.value = sp.intro_md;
    if (sp.benefits && typeof sp.benefits === "object") {
      currentBenefits = { ...currentBenefits, ...sp.benefits };
      benefitCbs.forEach((cb) => { cb.checked = !!currentBenefits[cb.name]; });
    }
  } catch { /* pas de prix encore */ }
  // Sauvegarde immédiate sur changement de checkbox. Une requête par toggle,
  // suffisamment rare pour ne pas justifier un debounce.
  benefitCbs.forEach((cb) => {
    cb.addEventListener("change", async () => {
      currentBenefits = { ...currentBenefits, [cb.name]: !!cb.checked };
      if (benefitStatus) benefitStatus.textContent = t("sp_saving");
      try {
        const r = await api("/api/space/benefits", {
          method: "PUT",
          headers: jsonAuth(),
          body: JSON.stringify(currentBenefits),
        });
        if (r?.benefits) currentBenefits = { ...currentBenefits, ...r.benefits };
        if (benefitStatus) benefitStatus.textContent = t("sp_saved");
      } catch (e) {
        if (benefitStatus) benefitStatus.textContent = "";
        cb.checked = !cb.checked; // revert UI
        currentBenefits = { ...currentBenefits, [cb.name]: !!cb.checked };
        toast(e?.message === "premium required" ? t("spb_premium_only") : (e?.message || t("er_fail")));
      }
    });
  });
  root.querySelector("#sp-save")?.addEventListener("click", async () => {
    const price = Math.round(parseFloat(priceInput.value) * 100);
    if (!Number.isFinite(price) || price < 100) { toast(t("sp_price_invalid")); return; }
    try {
      const sp = await api("/api/space", { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ price_cents: price }) });
      if (status) status.textContent = sp.active ? t("sp_sellable") : t("sp_saved_pending");
      toast(t("sp_price_saved"));
    } catch (e) {
      toast(e?.message === "premium required" ? t("spb_premium_only") : (e?.message || t("er_fail")));
    }
  });
  const saveIntro = async (ta, statusEl, endpoint, label) => {
    const val = ta.value || "";
    if (val.length > 4000) { toast(t("sp_intro_too_long")); return; }
    try {
      await api(endpoint, { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ intro_md: val }) });
      if (statusEl) statusEl.textContent = t("sp_saved");
      toast(t("sp_saved_named").replace("{label}", label));
    } catch (e) {
      toast(e?.message === "premium required" ? t("spb_premium_only") : (e?.message || t("er_fail")));
    }
  };
  root.querySelector("#sp-intro-save")?.addEventListener("click", () =>
    introTa && saveIntro(introTa, introStatus, "/api/space/intro", t("sp_intro_label"))
  );
}

// Stockage tiers : sélecteur de fournisseur (catalogue TOP 10) + config/test +
// OAuth. Les médias sont chiffrés côté client et uploadés directement chez le
// fournisseur ; id.mindlog n'héberge rien. `root` = la page Premium.
async function loadStorageConfig(root) {
  const wrap = root.querySelector("#sp-storage");
  const statusEl = root.querySelector("#sp-storage-status");
  if (!wrap) return;

  // Feedback retour OAuth (?storage=gdrive_ok…) puis nettoyage de l'URL.
  try {
    const sp = new URLSearchParams(location.search).get("storage");
    if (sp) {
      if (/_ok$/.test(sp)) toast(t("eix_storage_connected"));
      else if (/_denied$/.test(sp)) toast(t("eix_conn_refused"));
      else if (/(_error|_state|_unavailable|badprovider)$/.test(sp)) toast(t("eix_storage_conn_fail"));
      else if (sp === "premium") toast(t("eix_premium_required"));
      const u = new URL(location.href); u.searchParams.delete("storage"); history.replaceState(null, "", u);
    }
  } catch { /* no-op */ }

  let state;
  try {
    state = await api("/api/storage/config", { headers: authHeaders() });
  } catch (e) {
    wrap.innerHTML = `<p class="lbl-sm">${esc(e?.message || t("eix_unavailable"))}</p>`;
    return;
  }
  const catalog = state.catalog || [];
  const cfg = state.config || null;
  const curId = cfg?.providerId || cfg?.kind || "";
  if (statusEl) statusEl.textContent = state.configured ? t("eix_connected_check") : t("eix_not_connected");

  // Ré-enveloppe la clé média pour les (éventuels) nouveaux abonnés. Best-effort :
  // garantit que les abonnés récents pourront déchiffrer la galerie.
  if (state.configured) void syncOwnerMediaKeys(myHandle()).catch(() => { /* best-effort */ });

  // Regroupe pour guider : « en un clic » (OAuth grand public DISPONIBLES),
  // « avec vos identifiants » (S3-compatibles), « lien direct » (http). Les
  // fournisseurs OAuth non activés côté serveur sont MASQUÉS (pas grisés).
  const oauthReady = catalog.filter((e) => e.authType === "oauth" && e.serverReady);
  const oauthHidden = catalog.filter((e) => e.authType === "oauth" && !e.serverReady);
  const keyProviders = catalog.filter((e) => e.authType === "keys");
  const httpProviders = catalog.filter((e) => e.authType === "none");
  const advProviders = [...keyProviders, ...httpProviders];
  const labelOf = (id) => catalog.find((e) => e.id === id)?.label || id;
  const isCurrent = (e) => cfg && (cfg.providerId === e.id || cfg.kind === e.kind);

  const collect = (entry) => {
    const o = { kind: entry.kind, providerId: entry.id };
    if (entry.authType === "keys") {
      wrap.querySelectorAll("[data-field]").forEach((inp) => { o[inp.dataset.field] = inp.value.trim(); });
    } else if (entry.authType === "none") {
      const f = wrap.querySelector('[data-field="baseUrl"]'); if (f) o.baseUrl = f.value.trim();
    } else {
      o.folderId = wrap.querySelector("#sp-st-folderId")?.value.trim() || "";
    }
    return o;
  };
  const setMsg = (txt) => { const m = wrap.querySelector("#sp-st-msg"); if (m) m.textContent = txt; };
  const save = async (entry) => {
    const payload = collect(entry);
    // Garde-fou « clés inversées » : le Secret est quasi toujours plus long que
    // l'Access Key ID (R2 : 32 vs 64, AWS : 20 vs 40). Si l'utilisateur a saisi
    // de nouvelles valeurs (≠ masque) et que l'ID est plus long, on prévient —
    // cause n°1 de « access key has length 64, should be 32 ».
    if (entry.kind === "s3") {
      const ak = String(payload.accessKeyId || ""), sk = String(payload.secretAccessKey || "");
      const realAk = ak && ak !== "••••", realSk = sk && sk !== "••••";
      if (realAk && realSk && ak.length > sk.length) {
        const ok = await confirmDialog(
          t("eix_keys_swapped_warn"),
          { ok: t("eix_save_anyway"), cancel: t("eix_correct"), danger: true }
        );
        if (!ok) return;
      }
    }
    try {
      const r = await api("/api/storage/config", { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ config: payload }) });
      if (statusEl) statusEl.textContent = r.configured ? t("eix_connected_check") : t("eix_not_connected");
      const cors = r.cors ? (r.cors.ok ? t("eix_cors_ok") : t("eix_cors_unset_help").replace("{err}", r.cors.error || "?")) : "";
      setMsg(t("eix_saved_check_cors").replace("{cors}", cors));
      toast(t("eix_storage_saved"));
    } catch (e) { setMsg(e?.message || t("er_fail")); toast(e?.message || t("eix_failed")); }
  };
  const test = async () => {
    setMsg(t("eix_testing"));
    try {
      const r = await api("/api/storage/test", { method: "POST", headers: authHeaders() });
      const cors = r.cors ? (r.cors.ok ? t("eix_cors_ok") : t("eix_cors_unset_manual").replace("{err}", r.cors.error || "?")) : "";
      setMsg(r.ok ? t("eix_conn_ok_cors").replace("{cors}", cors) : (r.error || t("er_fail")));
      toast(r.ok ? t("eix_storage_conn_ok") : (r.error || t("eix_test_fail")));
    } catch (e) { setMsg(e?.message || t("er_fail")); }
  };

  // ── Bandeau « connecté à … » ───────────────────────────────────────────────
  const bannerHtml = state.configured
    ? `<div class="sp-st-connected">${icon("shield", 15)} ${t("eix_storage_connected_on").replace("{provider}", esc(labelOf(curId)))}</div>`
    : `<p class="lbl-sm" style="margin:.1rem 0 .7rem;line-height:1.5">${t("eix_storage_choose")}</p>`;

  // ── Section « en un clic » (OAuth grand public disponibles) ────────────────
  const oneClickHtml = oauthReady.length
    ? `<div class="sp-oc-grid">${oauthReady.map((e) => {
        const cur = isCurrent(e) && state.configured;
        return `<div class="sp-oc-card${cur ? " is-on" : ""}">
          <div class="sp-oc-head"><b>${esc(e.label)}</b>${e.badge ? `<span class="sp-oc-badge">${esc(e.badge)}</span>` : ""}</div>
          <p class="lbl-sm sp-oc-hint">${esc(e.hint)}</p>
          ${cur
            ? `<div class="sp-oc-on">${icon("shield", 13)} ${t("eix_connected")}</div>
               <label class="sp-st-field" style="margin:.4rem 0 .2rem"><span class="lbl-sm">${t("eix_target_folder")}</span><input id="sp-st-folderId" placeholder="${t("eix_folder_id_ph")}" value="${esc(cfg.folderId || "")}"></label>
               <div class="lt-prem-actions" style="align-items:center">
                 <button type="button" class="btn sm" data-oc-save="${esc(e.id)}">${t("eix_save_folder")}</button>
                 <button type="button" class="btn sm" id="sp-st-test">${t("eix_test")}</button>
                 <a class="btn sm" href="/api/storage/oauth/${encodeURIComponent(e.kind)}/connect">${t("eix_reconnect")}</a>
               </div>`
            : `<a class="btn primary sm sp-oc-cta" href="/api/storage/oauth/${encodeURIComponent(e.kind)}/connect">${icon("link", 14)} ${t("eix_connect_provider").replace("{label}", esc(e.label))}</a>`}
        </div>`;
      }).join("")}</div>`
    : `<div class="sp-oc-empty lbl-sm">${icon("clock", 13)} ${t("eix_no_oneclick")}</div>`;

  // ── Section « avec vos identifiants » (S3-compatibles + lien) ──────────────
  const advOptions = advProviders.map((e) =>
    `<option value="${esc(e.id)}" ${e.id === curId ? "selected" : ""}>${esc(e.label)}${e.badge ? ` — ${esc(e.badge)}` : ""}</option>`
  ).join("");

  const renderAdv = (entryId) => {
    const entry = advProviders.find((e) => e.id === entryId) || advProviders[0];
    const bodyEl = wrap.querySelector("#sp-st-adv-body");
    if (!entry || !bodyEl) return;
    const same = isCurrent(entry);
    let body = `<p class="lbl-sm" style="opacity:.8;margin:.2rem 0 .55rem;line-height:1.5">${esc(entry.hint)}${entry.helpUrl ? ` <a href="${esc(entry.helpUrl)}" target="_blank" rel="noopener">${t("eix_where_creds")}</a>` : ""}</p>`;
    let actions = "";
    if (entry.authType === "keys") {
      body += `<div class="sp-st-fields">` + (entry.fields || []).map((f) => {
        const preset = (entry.presets && entry.presets[f.name]) || "";
        const cur = same ? (cfg[f.name] ?? "") : preset;
        return `<label class="sp-st-field"><span class="lbl-sm">${esc(f.label)}${f.required ? " *" : ""}</span>
          <input data-field="${esc(f.name)}" type="${f.type === "password" ? "password" : "text"}" placeholder="${esc(f.placeholder || "")}" value="${esc(cur)}" autocomplete="off"></label>`;
      }).join("") + `</div>`;
      body += `<details class="sp-st-op" style="margin-top:.5rem" open><summary class="lbl-sm">${t("eix_cors_summary")}</summary>
        <p class="lbl-sm" style="margin:.4rem 0;line-height:1.5">${t("eix_cors_auto_note")}</p>
        <p class="lbl-sm" style="margin:.4rem 0;line-height:1.4">${t("eix_cors_r2_steps")}</p>
        <pre class="lbl-sm" style="white-space:pre-wrap;background:var(--bg-soft);border:1px solid var(--line);border-radius:8px;padding:.5rem;overflow:auto">[{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET","PUT","HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]</pre>
        <p class="lbl-sm" style="margin:.3rem 0 0;opacity:.8">${t("eix_cors_autonote2")}</p></details>`;
      actions = `<button type="button" class="btn primary sm" id="sp-st-save">${t("eix_save")}</button> <button type="button" class="btn sm" id="sp-st-test">${t("eix_test")}</button>`;
    } else {
      const cur = same ? (cfg.baseUrl || "") : "";
      body += `<label class="sp-st-field"><span class="lbl-sm">${t("eix_base_url")}</span><input data-field="baseUrl" type="text" placeholder="https://cdn.exemple.com" value="${esc(cur)}"></label>`;
      actions = `<button type="button" class="btn primary sm" id="sp-st-save">${t("eix_save")}</button>`;
    }
    bodyEl.innerHTML = body + `<div class="lt-prem-actions" style="margin-top:.6rem;align-items:center">${actions}</div>`;
    wrap.querySelector("#sp-st-save")?.addEventListener("click", () => save(entry));
    wrap.querySelector("#sp-st-test")?.addEventListener("click", () => test());
  };

  // ── Note opérateur (discrète) si des services OAuth sont masqués ────────────
  const operatorNote = oauthHidden.length
    ? `<details class="sp-st-op"><summary class="lbl-sm">${t("eix_operator_summary")}</summary>
        <p class="lbl-sm" style="margin:.4rem 0 0;line-height:1.5">${t("eix_operator_note").replace("{providers}", esc(oauthHidden.map((e) => e.label).join(", "))).replace("{origin}", esc(location.origin))}</p>
       </details>`
    : "";

  wrap.innerHTML = `${bannerHtml}
    ${oneClickHtml}
    <details class="sp-st-adv" ${state.configured && advProviders.some(isCurrent) ? "open" : ""}>
      <summary class="lbl-sm">${icon("key", 13)} ${t("eix_connect_creds")}</summary>
      <div class="sp-st-adv-inner">
        <div class="sp-st-pick" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.5rem 0 .4rem">
          <label class="lbl-sm" for="sp-st-provider" style="margin:0">${t("eix_provider")}</label>
          <select id="sp-st-provider">${advOptions}</select>
        </div>
        <div id="sp-st-adv-body"></div>
      </div>
    </details>
    <div class="lt-prem-actions" style="margin-top:.5rem"><span id="sp-st-msg" class="lbl-sm" style="opacity:.75" aria-live="polite"></span></div>
    ${operatorNote}`;

  // Wiring : sauvegarde du dossier OAuth (cartes « en un clic »), test, select avancé.
  wrap.querySelectorAll("[data-oc-save]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const entry = catalog.find((e) => e.id === btn.dataset.ocSave);
      if (entry) save(entry);
    });
  });
  wrap.querySelector("#sp-st-test")?.addEventListener("click", () => test());
  const sel = wrap.querySelector("#sp-st-provider");
  if (sel) {
    sel.addEventListener("change", () => renderAdv(sel.value));
    renderAdv(advProviders.some(isCurrent) ? curId : (advProviders[0] && advProviders[0].id));
  }
}

// Peuple les blocs « Tarif de l'espace » + « Pages de l'espace » de la page
// Premium (statut Connect, liste de pages, wizard d'ajout). `root` = la page
// Premium (hors #app), donc on requête dans `root`, pas dans `app`.
async function loadPaidPages(root, data) {
  const block = root.querySelector("#pp-block");
  if (!block) return;

  // ── Statut Stripe Connect (partagé avec le bloc tarif) ────────────────────
  const connectEl = root.querySelector("#pp-connect");
  try {
    const st = await api("/api/billing/connect/status", { headers: authHeaders() });
    if (st.chargesEnabled) {
      connectEl.innerHTML = t("pp_pay_active");
    } else {
      connectEl.innerHTML = `<button type="button" class="btn sm" id="pp-onboard">${t("pp_config_pay")}</button> <span style="opacity:.7">${t("pp_required_to_sell")}</span>`;
      root.querySelector("#pp-onboard")?.addEventListener("click", async () => {
        try {
          const r = await api("/api/billing/connect/onboard", { method: "POST", headers: jsonAuth() });
          if (r?.url) location.assign(r.url);
        } catch (e) { toast(e?.message || t("pp_unavailable")); }
      });
    }
  } catch { connectEl.innerHTML = ""; }

  // ── Tarif de l'espace ─────────────────────────────────────────────────────
  void loadSpacePricing(root);

  // Le stockage tiers se gère désormais dans Compte → Stockage (loadStorageConfig
  // y est chargé paresseusement à l'ouverture de l'onglet).

  // ── Liste des pages ──────────────────────────────────────────────────────
  const pagesEl = root.querySelector("#pp-pages");
  const countEl = root.querySelector("#pp-count");
  let pages = [];
  try {
    pages = (await api("/api/pages", { headers: authHeaders() })).pages || [];
  } catch { /* liste vide */ }
  if (countEl) countEl.textContent = pages.length ? (pages.length > 1 ? t("spx_meta_pages_pl") : t("spx_meta_pages")).replace("{n}", pages.length) : "";
  pagesEl.innerHTML = pages.length
    ? pages.map((p) =>
        `<div class="pp-row" data-slug="${esc(p.slug)}">
           <span class="pp-row-ic">${ppTypeIcon(p.type)}</span>
           <b>${esc(p.title)}</b>
           <span class="lbl-sm">/${esc(p.slug)} · ${p.published ? t("pp_published") : t("spx_draft")}</span>
           <a href="/@${esc(data.handle)}/p/${esc(p.slug)}" target="_blank" rel="noopener" style="margin-left:auto">${t("pp_view")}</a>
           <button type="button" class="btn sm" data-pp-edit>${t("pw_edit")}</button>
           <button type="button" class="btn sm danger" data-pp-del title="${t("com_delete")}">✕</button>
         </div>`
      ).join("")
    : `<p class="lbl-sm">${t("pp_no_pages_hint")}</p>`;

  // Édition / suppression d'une ligne existante : on rouvre le wizard pré-rempli.
  pagesEl.querySelectorAll("[data-pp-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const slug = btn.closest(".pp-row")?.dataset.slug;
      if (!slug) return;
      const ok = await confirmDialog(t("pp_del_confirm").replace("{slug}", slug), { danger: true, ok: t("com_delete") });
      if (!ok) return;
      try {
        await api(`/api/pages/${encodeURIComponent(slug)}`, { method: "DELETE", headers: authHeaders() });
        toast(t("pp_page_deleted"));
        void loadPaidPages(root, data);
      } catch (e) { toast(e?.message || t("er_fail")); }
    });
  });
  pagesEl.querySelectorAll("[data-pp-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slug = btn.closest(".pp-row")?.dataset.slug;
      const page = pages.find((p) => p.slug === slug);
      if (page) openWizardForm(root, data, page);
    });
  });

  // ── Wizard d'ajout ───────────────────────────────────────────────────────
  root.querySelector("#pp-add-btn")?.addEventListener("click", () => openWizardTypeChooser(root, data));
  root.querySelectorAll("[data-wiz-cancel]").forEach((b) => b.addEventListener("click", () => closeWizard(root)));
}

function openWizardTypeChooser(root, data) {
  const wiz = root.querySelector("#pp-wizard");
  if (!wiz) return;
  wiz.hidden = false;
  wiz.querySelector('[data-step="type"]').hidden = false;
  wiz.querySelector('[data-step="form"]').hidden = true;
  // Bind chaque carte de type → ouvre le formulaire dédié.
  wiz.querySelectorAll(".pp-type-card").forEach((card) => {
    if (card.disabled) return;
    card.onclick = () => {
      const type = card.dataset.type;
      openWizardForm(root, data, { type });
    };
  });
  wiz.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function openWizardForm(root, data, page) {
  const wiz = root.querySelector("#pp-wizard");
  if (!wiz) return;
  wiz.hidden = false;
  wiz.querySelector('[data-step="type"]').hidden = true;
  const formStep = wiz.querySelector('[data-step="form"]');
  formStep.hidden = false;

  const isEdit = !!page?.slug;
  const type = page?.type || "markdown";
  const head = wiz.querySelector("#pp-form-head");
  const typeLabel = type === "gallery" ? t("pw_type_gallery") : type === "link" ? t("pw_type_link") : type === "file" ? t("pw_type_file") : t("pw_type_markdown");
  head.innerHTML = `${ppTypeIcon(type)} ${isEdit ? t("pw_edit") : t("pw_new_page")} — ${typeLabel}`;

  const titleInp = wiz.querySelector("#pp-title");
  const slugInp = wiz.querySelector("#pp-slug");
  const pubInp = wiz.querySelector("#pp-pub");
  titleInp.value = page?.title || "";
  slugInp.value = page?.slug || "";
  slugInp.dataset.touched = isEdit ? "1" : "0";
  // En création : publié par défaut (sinon la page n'apparaît nulle part côté
   // visiteur et le propriétaire ne comprend pas pourquoi rien ne s'affiche).
  pubInp.checked = isEdit ? !!page?.published : true;

  // Auto-slugify : tant que l'utilisateur n'a pas édité le slug à la main,
  // on le met à jour à partir du titre.
  titleInp.oninput = () => {
    if (slugInp.dataset.touched !== "1") slugInp.value = slugifyTitle(titleInp.value);
  };
  slugInp.oninput = () => { slugInp.dataset.touched = "1"; };

  // Champs type-spécifiques : si on édite, parse le content existant.
  let parsed = page?.content;
  if (parsed && typeof parsed === "string" && type !== "markdown") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  // ctx : nécessaire pour construire les URLs servables des médias galerie/fichier.
  // En création, slug est vide → l'UI affiche un message « enregistre d'abord ».
  const ctx = { slug: page?.slug || "", handle: data.handle };
  wiz.querySelector("#pp-type-fields").innerHTML = ppTypeFieldsHtml(type, parsed, ctx);
  wirePpTypeFields(root, type, ctx);

  wiz.querySelector("[data-wiz-back]").onclick = () => openWizardTypeChooser(root, data);
  wiz.querySelector("#pp-save").onclick = async () => {
    const slug = slugInp.value.trim();
    const title = titleInp.value.trim();
    if (!title) { toast(t("pw_title_req")); return; }
    if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(slug)) { toast(t("pw_slug_invalid")); return; }
    const content = collectTypeContent(root, type);
    try {
      await api("/api/pages", {
        method: "PUT",
        headers: jsonAuth(),
        body: JSON.stringify({ slug, title, type, content, published: pubInp.checked }),
      });
      toast(t("pw_page_saved"));
      closeWizard(root);
      void loadPaidPages(root, data);
    } catch (e) {
      toast(e?.message === "premium required" ? t("spb_premium_only") : (e?.message || t("er_fail")));
    }
  };
  titleInp.focus();
  wiz.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeWizard(root) {
  const wiz = root.querySelector("#pp-wizard");
  if (wiz) wiz.hidden = true;
}

// Câble upload/drop/delete pour les types média (gallery + file). Les fichiers
// sont chiffrés côté client puis uploadés DIRECTEMENT vers le stockage tiers du
// créateur (premium/storage-client). L'item (URL externe + enc/mime) est gardé
// dans le DOM et persisté à l'enregistrement de la page (collectTypeContent).
function wirePpTypeFields(root, type, ctx) {
  if (type !== "gallery" && type !== "file") return;
  const handle = ctx.handle;
  if (!handle) return;

  if (type === "gallery") {
    const grid = root.querySelector("#pp-gal-grid");
    const drop = root.querySelector("#pp-gal-drop");
    const fileInp = root.querySelector("#pp-gal-file");
    const urlBtn = root.querySelector("#pp-gal-url");
    if (!grid || !drop || !fileInp) return;

    const addItem = (it) => {
      const tmp = document.createElement("div");
      tmp.innerHTML = galItemHtml(it);
      const node = tmp.firstElementChild;
      grid.appendChild(node);
      wireGalDelete(node);
      void hydrateGalThumbs(grid, handle);
    };

    const uploadFiles = async (files) => {
      const list = [...(files || [])];
      if (!list.length) return;
      toast(t("gg_uploading").replace("{n}", list.length));
      let ok = 0;
      for (const f of list) {
        try {
          const item = await uploadEncrypted({ file: f, handle });
          addItem(item);
          ok++;
        } catch (e) {
          toast(e?.message || t("pw_upload_fail"));
        }
      }
      if (ok) toast(t("pw_media_added").replace("{n}", ok));
    };

    fileInp.addEventListener("change", () => {
      if (fileInp.files?.length) uploadFiles(fileInp.files);
      fileInp.value = "";
    });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag-over");
      if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
    });
    urlBtn?.addEventListener("click", async () => {
      const url = await promptDialog(t("pw_media_url_prompt"), { type: "url", placeholder: "https://…" });
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) { toast(t("pw_url_required")); return; }
      const kind = /\.(mp4|webm|mov)(\?|$)/i.test(url) ? "video" : "image";
      addItem({ url, kind, enc: false, mime: "" });
    });
    grid.querySelectorAll(".gal-item").forEach((el) => wireGalDelete(el));
    void hydrateGalThumbs(grid, handle);
  }

  if (type === "file") {
    const st = root.querySelector("#pp-file-state");
    if (!st) return;
    const renderCard = (name, size, enc) => {
      st.innerHTML = `<div class="pp-file-card">
        <span class="pp-file-ic">${icon("download", 18)}</span>
        <div class="pp-file-info"><b>${esc(name)}</b><span class="lbl-sm">${size ? `${(size/1024).toFixed(1)} ${t("pp_kb")}` : ""} ${enc ? "· " + t("pw_encrypted") : ""}</span></div>
        <button type="button" class="btn sm danger" id="pp-file-del">${t("pw_replace")}</button>
      </div>`;
      wirePpTypeFields(root, "file", ctx);
    };
    const inp = root.querySelector("#pp-file-input");
    const del = root.querySelector("#pp-file-del");
    inp?.addEventListener("change", async () => {
      const file = inp.files?.[0];
      inp.value = "";
      if (!file) return;
      toast(t("pw_uploading_one"));
      try {
        const item = await uploadEncrypted({ file, handle });
        st.dataset.url = item.url;
        st.dataset.enc = item.enc ? "1" : "";
        st.dataset.mime = item.mime || "";
        st.dataset.name = file.name;
        st.dataset.size = String(file.size);
        renderCard(file.name, file.size, item.enc);
        toast(t("pw_file_uploaded"));
      } catch (e) {
        toast(e?.message || t("pw_upload_fail"));
      }
    });
    del?.addEventListener("click", () => {
      st.dataset.url = ""; st.dataset.enc = ""; st.dataset.mime = ""; st.dataset.name = ""; st.dataset.size = "0";
      st.innerHTML = `<div class="pp-file-empty">
        <span class="pp-file-ic">${icon("download", 22)}</span>
        <p>${icon("lock", 12)} ${t("pw_file_empty")}</p>
        <label class="btn primary sm" style="cursor:pointer">${t("pw_choose_file")}
          <input type="file" hidden id="pp-file-input">
        </label>
      </div>`;
      wirePpTypeFields(root, "file", ctx);
      toast(t("pw_file_removed"));
    });
  }
}

// Suppression d'une vignette : on retire juste du DOM. Le média reste sur le
// stockage tiers du créateur (à lui de le gérer) ; la page est re-persistée
// sans cet item à l'enregistrement.
function wireGalDelete(itemEl) {
  const btn = itemEl.querySelector(".gal-del");
  if (!btn) return;
  btn.addEventListener("click", () => itemEl.remove());
}

export function renderEditor(data) {
  // Invitation en attente (lien `/i/<token>` ouvert avant connexion) → accepter.
  consumePendingInvite();
  // Calendrier de l'éditeur : règle de dispo perso (jours/week-end/périodes).
  host.calendar.setAvailability((data.settings || {}).availability);
  const photo = data.hasPhoto
    ? `<img class="photo" src="/api/identities/${encodeURIComponent(data.handle)}/photo?ts=${Date.now()}" alt="${t("eix_photo")}" />`
    : data.handle === "milo"
      ? `<div class="photo milo-photo">${miloSvg(120)}</div>`
      : `<div class="photo avatar">${genericAvatarSvg(
          data.handle,
          ((data.fields.find((f) => f.key === "display_name")?.value || data.handle)[0] || "·").toUpperCase()
        )}</div>`;
  const rel = data.relations || { 1: [], 2: [], 3: [] };
  // Relations directes (degré 1) scindées : amis mis en avant dans l'onglet
  // « Amis », le reste (pro/autre + degrés étendus) dans l'onglet « Réseau ».
  const _deg1 = rel[1] || [];
  const _friends = _deg1.filter((r) => r.type === "amis");
  const _others = _deg1.filter((r) => r.type !== "amis");
  const _incoming = data.incoming || [];
  const _reseauCount = _others.length + _incoming.length + (rel[2]?.length || 0) + (rel[3]?.length || 0);

  // Charge par jour pour la heatmap du calendrier (événements + RDV acceptés).
  const dayLoad = dayLoadMap(data);

  // « Mon profil » (édition de la carte) et « Notifications » ne sont plus des
  // colonnes du deck : leur contenu est intégré comme PANNEAUX du Compte (sous-menu
  // conservé). On les construit ici et on les passe à renderAccountColumn.
  const profileHtml = renderIdentityColumn(data, { photo, fieldEditHtml, socialEditHtml });
  const notifsHtml = renderNotificationsColumn(data, { notifListHtml });
  // « Mes espaces » (gestion premium / upsell) : même contenu que la page /me/premium,
  // embarqué comme panneau du Compte (câblage paresseux via wirePremiumPage au 1er clic).
  const espacesHtml = renderPremiumPage(data);
  const cols = [
    renderAccountColumn(data, { photo, profileHtml, notifsHtml, espacesHtml }),
    renderAgendaColumn(data, { reqFilterChips, requestsHtml, dayLoad }),
    renderRelationsColumn(data, { incomingListHtml }),
  ];

  // Colonnes cœur + colonnes contribuées par les plugins (registre). Le tri par
  // `order` fixe l'ordre du deck (voir coreOrders ci-dessous) ; le Compte n'est
  // plus une colonne (déplacé dans l'onglet « Compte » de l'Identité).
  // Panneau Options
  const optCol = renderOptionsColumn(data);

  // Colonne Communications (Discuter + Appel, 2 colonnes WhatsApp-like)
  const commContacts = (() => {
    const convMap = new Map((data.conversations || []).map(c => [c.handle, c]));
    const convList = [...convMap.values()].map(c => {
      const last = (c.messages || []).reduce((mx, m) => m.created_at > mx ? m.created_at : mx, "");
      return { handle: c.handle, displayName: c.display_name || null, hasPhoto: c.has_photo, lastAt: last, unread: (c.messages || []).filter(m => !m.mine && m.read === 0).length, isConv: true };
    });
    const convHandles = new Set(convMap.keys());
    const others = _deg1.filter(r => !convHandles.has(r.handle)).map(r => ({ handle: r.handle, displayName: r.display_name || null, hasPhoto: r.has_photo, lastAt: "", unread: 0, isConv: false }));
    // Tri : non-lus d'abord, puis activité récente, puis contacts favoris, puis alphabétique.
    const favSet = new Set((_deg1 || []).filter(r => r.favorite).map(r => r.handle));
    return [...convList, ...others].sort((a, b) => {
      if ((a.unread > 0) !== (b.unread > 0)) return a.unread > 0 ? -1 : 1;
      if (a.lastAt !== b.lastAt) return b.lastAt.localeCompare(a.lastAt);
      const fa = favSet.has(a.handle), fb = favSet.has(b.handle);
      if (fa !== fb) return fa ? -1 : 1;
      return a.handle.localeCompare(b.handle);
    });
  })();

  function commContactHtml(c) {
    const init = (c.handle[0] || "?").toUpperCase();
    // L'initiale colorée est TOUJOURS rendue en fond ; la photo se superpose et,
    // si elle échoue (404 / has_photo périmé), s'efface pour révéler l'initiale.
    const bg = `hsl(${[...c.handle].reduce((h,x)=>(h*31+x.charCodeAt(0))%360,0)} 40% 46%)`;
    const initSpan = `<span class="comm-av-init" style="background:${bg};color:#fff">${esc(init)}</span>`;
    const av = c.hasPhoto
      ? `<img class="comm-av-img" src="/api/identities/${encodeURIComponent(c.handle)}/photo" alt="" loading="lazy" onerror="this.remove()" />${initSpan}`
      : initSpan;
    const timePart = c.lastAt ? `<span class="comm-time">${new Date(c.lastAt).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}</span>` : "";
    const unread = c.unread ? `<span class="comm-unread">${c.unread}</span>` : "";
    const sub = c.displayName ? esc(c.displayName) : (c.isConv ? `${icon("lock", 11)} ${t("eix_encrypted_message")}` : t("eix_direct_connection"));
    return `<div class="comm-contact-item" data-handle="${esc(c.handle)}" data-search="${esc(c.handle + " " + (c.displayName||"")).toLowerCase()}">
      <div class="comm-av">${av}</div>
      <div class="comm-contact-body">
        <div class="comm-contact-name">@${esc(c.handle)}</div>
        <div class="comm-contact-sub">${sub}</div>
      </div>
      <div class="comm-contact-meta">${timePart}${unread}</div>
    </div>`;
  }

  // Pane droit vide tant qu'aucune conversation n'est montée : la sidebar prend
  // toute la place via la règle CSS `.comm-layout:not(:has(... .chat-card)) …`.
  // On ne garde plus de placeholder texte (« Sélectionne un contact… ») qui
  // rendait un bloc noir disgracieux à côté d'une liste vide.
  appState.commEmptyHtml = "";

  // Messages non lus (Discussions) — hissé ici pour alimenter à la fois le badge
  // du sous-menu Discussions et, plus bas, l'entrée Échanges de la barre du bas.
  const chatUnread = (data.conversations || []).reduce((s, cv) => s + (cv.messages || []).filter(m => !m.mine && m.read === 0).length, 0);

  // Layout 3 colonnes : rail vertical (sous-modes) | sidebar (liste) | pane droit.
  // Le rail style WhatsApp Desktop expose les sous-modes du Chat (Discussions,
  // Groupes…) — la sidebar n'affiche QU'UN seul mode à la fois, plein-cadre,
  // pour ne plus rogner la liste des contacts.
  const commColHtml = `<div class="comm-wrapper">
    <div class="comm-layout">
      <nav class="comm-rail" id="comm-rail" role="tablist" aria-label="${t("ec_subsections_aria")}">
        <button type="button" class="comm-rail-btn is-active" id="comm-rail-chats" role="tab" aria-selected="true" aria-controls="comm-view-chats" title="${t("ec_discussions")}" aria-label="${t("ec_discussions")}">
          ${icon("chat", 22)}<span class="comm-rail-label">${t("ec_discussions")}</span>
          <span class="comm-rail-badge" data-chat-badge ${chatUnread ? "" : "hidden"}>${chatUnread ? (chatUnread > 99 ? "99+" : chatUnread) : ""}</span>
        </button>
        <button type="button" class="comm-rail-btn" id="comm-rail-groups" role="tab" aria-selected="false" aria-controls="comm-view-groups" title="${t("ec_groups")}" aria-label="${t("ec_groups")}">
          ${icon("users", 22)}<span class="comm-rail-label">${t("ec_groups")}</span>
          <span class="comm-rail-badge" id="comm-rail-groups-badge" hidden></span>
        </button>
        <button type="button" class="comm-rail-btn" id="comm-rail-live" role="tab" aria-selected="false" aria-controls="comm-view-live" title="Live" aria-label="Live">
          ${icon("radio", 22)}<span class="comm-rail-label">Live</span>
        </button>
        <button type="button" class="comm-rail-btn" id="comm-rail-relations" role="tab" aria-selected="false" aria-controls="comm-view-relations" title="${t("ec_relations")}" aria-label="${t("ec_relation_requests")}">
          ${icon("bell", 22)}<span class="comm-rail-label">${t("ec_relations")}</span>
          <span class="comm-rail-badge" id="comm-rail-relations-badge" ${data.incoming?.length ? "" : "hidden"}>${data.incoming?.length || ""}</span>
        </button>
      </nav>
      <div class="comm-sidebar">
        <div class="comm-topbar" id="comm-topbar">
          <span id="comm-topbar-title">${icon("chat",16)} ${t("ec_discussions")}</span>
          <button type="button" class="comm-topbar-btn" id="comm-new-btn" title="${t("ec_new_discussion")}" aria-label="${t("ec_new_discussion")}">＋</button>
        </div>
        <div class="comm-search-wrap">
          <input id="comm-search" placeholder="${t("ec_search_ph")}" autocomplete="off" />
        </div>
        <!-- Vue Discussions (contacts 1:1) -->
        <div class="comm-view" id="comm-view-chats" role="tabpanel" aria-labelledby="comm-rail-chats">
          <div class="comm-contacts-list" id="comm-contacts">
            ${commContacts.length
              ? (commContacts.some(c => c.isConv) ? `<div class="comm-sep">${t("ec_recent_convs")}</div>` : "")
                + commContacts.filter(c => c.isConv).map(commContactHtml).join("")
                + (commContacts.some(c => !c.isConv) ? `<div class="comm-sep">${t("ec_direct_conns")}</div>` : "")
                + commContacts.filter(c => !c.isConv).map(commContactHtml).join("")
              : `<div class="comm-empty-state"><p>${t("ec_no_contacts")}</p></div>`}
          </div>
        </div>
        <!-- Vue Groupes (liste pleine hauteur, chargée à la demande) -->
        <div class="comm-view" id="comm-view-groups" role="tabpanel" aria-labelledby="comm-rail-groups" hidden>
          <div class="comm-groups-list" id="comm-groups-list">
            <div class="comm-empty-state"><p>${t("com_loading")}</p></div>
          </div>
        </div>
        <!-- Vue Live : injection lazy du contenu du plugin live.js. -->
        <div class="comm-view" id="comm-view-live" role="tabpanel" aria-labelledby="comm-rail-live" hidden>
          <div class="comm-live-host" id="comm-live-host">
            <div class="comm-empty-state"><p>${t("com_loading")}</p></div>
          </div>
        </div>
        <!-- Vue Relations : demandes entrantes à réciproquer (simplifie la réciprocité). -->
        <div class="comm-view" id="comm-view-relations" role="tabpanel" aria-labelledby="comm-rail-relations" hidden>
          <div class="comm-relations-host">
            <p class="lbl-sm comm-relations-intro">${t("ec_relations_intro")}</p>
            <ul class="rels comm-relations-list" id="comm-relations-list">${incomingListHtml(data.incoming || [])}</ul>
          </div>
        </div>
      </div>
      <div class="comm-right" id="comm-right">${appState.commEmptyHtml}</div>
    </div>
  </div>`;

  // Ordre du menu (communication d'abord) : Accueil · Chat · Notifs · Réseau ·
  // Mon ID · Galerie (plugin, order 45) · Agenda · Options (réglages, en dernier).
  // cols = [Compte, Agenda, Relations] (+ optCol, commColHtml). Profil & Notifs sont
  // désormais des panneaux DANS Compte, plus des colonnes.
  const coreOrders = [5, 50, 30, 60, 10];
  const coreLabels = ["Compte", "Agenda", "Relations", "Options", "Chat"];
  const allCols = (() => {
    const list = [...cols, optCol, commColHtml]
      .map((html, i) => ({ order: coreOrders[i], label: coreLabels[i], html }))
      .concat(host.getPlugins().flatMap((p) => (p.editorColumns ? p.editorColumns(host, data) : [])))
      .sort((a, b) => a.order - b.order);
    // Dédoublonnage par label : garde-fou contre une colonne contribuée deux fois
    // par un plugin (ex. « Galerie » en double) → une seule colonne par onglet.
    const seen = new Set();
    return list.filter((c) => (seen.has(c.label) ? false : (seen.add(c.label), true)));
  })();

  const _displayName = data.fields.find(f => f.key === "display_name")?.value || null;
  // Source de vérité la plus riche pour le chip header : on alimente le cache
  // partagé avec le nom et la photo issus de /api/me.
  setMeProfile({ name: _displayName, hasPhoto: data.hasPhoto, plan: data.plan });
  const BNAV = {
    Identité: { label: t("nav_monid"), ic: "user" },
    Agenda: { label: t("nav_agenda"), ic: "calendar" },
    Relations: { label: t("nav_reseau"), ic: "users" },
    Notifications: { label: t("nav_notifs"), ic: "bell" },
    Compte: { label: t("nav_compte"), ic: "user" },
    Galerie: { label: t("nav_galerie"), ic: "image" },
    Options: { label: t("nav_options"), ic: "settings" },
    // « Chat » regroupe maintenant Discussions 1:1, Groupes et Live (rail interne).
    // Le label d'affichage devient « Échanges » : assez large pour couvrir les
    // 3 sous-modes (conversations + diffusion), sans casser les lookups internes
    // qui restent indexés sur la clé "Chat".
    Chat: { label: t("nav_echanges"), ic: "chat" },
    Live: { label: "Live", ic: "radio" },
  };
  app.setAttribute("data-view", "private");
  app.innerHTML = `
   ${siteHeader({
     // Logo → accueil de l'app (vue connectée), pas la landing publique.
     brandHref: "/me",
     handle: data.handle,
     left: `<a class="topbar-publink" href="/@${esc(data.handle)}" target="_blank" rel="noopener noreferrer">${icon("link", 13)} <span class="topbar-publink-label">${t("ec_open_my_page")}</span></a>`,
     // Recherche d'identités retirée du header : la découverte/ajout de contacts se
     // fait désormais dans Réseau → Ajouter (sous-menu dédié), header allégé.
     center: "",
     right: `<button class="btn sm notif-wrap" id="notif-bell" aria-label="${t("nav_notifs")}" style="display:none"><span class="notif-badge" id="notif-badge" ${data.unread ? "" : "hidden"}>${data.unread || ""}</span></button>
       ${headerAccount(data.unread || 0)}`,
   })}
   <div class="deck-viewport" id="deck-viewport">
     <div class="deck" id="deck">
       ${allCols.map((c, i) => `<section class="col" data-col="${i}" data-deck-label="${esc(c.label || "")}">${c.html}</section>`).join("")}
     </div>
   </div>
   <nav class="bottom-nav" id="bottom-nav" aria-label="${t("eix_main_nav")}">
     ${(() => {
       // Compteurs par colonne (à partir du payload). Chaque total du bas est la
       // VENTILATION de ses sous-menus : messages (Discussions) → Échanges,
       // demandes de relation → Réseau, RDV en attente → Agenda, notifs → Compte.
       // (chatUnread est calculé plus haut, réutilisé ici.)
       const incomingCount = (data.incoming || []).length;
       const rdvPending = data.pending || 0; // même source que le sous-onglet RDV (Agenda)
       const notifCount = data.unread || 0;
       const unreadFor = (label) => ({ Chat: chatUnread, Relations: incomingCount, Agenda: rdvPending, Compte: notifCount }[label] || 0);
       // Refonte 2026 — barre directe (sans menu « Plus ») : Accueil · Chat ·
       // Réseau · Agenda · Galerie · Options. « Mon ID » (Identité) est accessible
       // depuis l'Accueil (« Modifier ma carte ») ; les Notifications via la cloche
       // du header. L'ordre est fixe et chaque label n'apparaît qu'une fois.
       // « Live » est désormais un sous-mode du rail Échanges (cf. comm-rail),
       // plus une entrée principale du menu du bas.
       const NAV = ["Chat", "Relations", "Agenda", "Compte"];
       const prem = (data.subscription?.plan ?? data.plan) === "premium";
       // Couronne Premium (même dessin que sur l'avatar du header).
       const CROWN = `<span class="bnav-crown" aria-hidden="true"><svg viewBox="0 0 24 22" fill="currentColor"><path d="M2 6.5l4.2 3.6L12 2.5l5.8 7.6 4.2-3.6-1.9 10.4H3.9L2 6.5z"/><rect x="3.4" y="18.2" width="17.2" height="2.9" rx="1.3"/></svg></span>`;
       const navBtn = ({ i, label }) => {
         const cfg = BNAV[label] || { label, ic: "circle" };
         const isCompte = label === "Compte";
         const hasUnread = unreadFor(label);
         // Chaque colonne a un badge à sélecteur STABLE (masqué si 0) : la mise à
         // jour temps réel (SSE) le retrouve sans re-rendu du menu.
         const badgeAttr = { Chat: "data-chat-badge", Relations: "data-rel-badge", Agenda: "data-agenda-badge", Compte: "data-notif-badge" }[label];
         const badge = badgeAttr
           ? `<span class="bnav-badge" ${badgeAttr} ${hasUnread ? "" : "hidden"}>${hasUnread ? (hasUnread > 99 ? "99+" : hasUnread) : ""}</span>`
           : (hasUnread ? `<span class="bnav-badge">${hasUnread > 99 ? "99+" : hasUnread}</span>` : "");
         return `<button class="bnav-item${isCompte && prem ? " is-premium" : ""}" data-col="${i}" type="button" aria-label="${esc(cfg.label)}${isCompte && prem ? " · Premium" : ""}" title="${esc(cfg.label)}">
           <span class="bnav-pip" aria-hidden="true"></span>
           ${icon(cfg.ic, 22)}
           ${isCompte && prem ? CROWN : ""}
           ${badge}
           <span>${esc(cfg.label)}</span>
         </button>`;
       };
       const seen = new Set();
       return NAV
         .map((lbl) => { const i = allCols.findIndex((c) => c.label === lbl); return i >= 0 ? { i, label: lbl } : null; })
         .filter((x) => x && !seen.has(x.label) && seen.add(x.label))
         .map(navBtn)
         .join("");
     })()}
   </nav>`;
  wireEditor(data);
  wireProfileMenuBtn();
  applyTheme(document.documentElement.getAttribute("data-theme") || "dark"); // pose l'icône sur le bouton fraîchement rendu
  setupTabs();
  // Câblage des colonnes contribuées par les plugins (ex. boutons « Ouvrir » du chat).
  allCols.forEach((c, i) => c.wire && c.wire(app.querySelector(`[data-col="${i}"]`), data));
  // Abonnement : retours de paiement Stripe + reprise d'intention post-inscription.
  handleBilling(data);
}

export function setupTabs() {
  const deck = document.getElementById("deck");
  const nav = document.getElementById("bottom-nav");
  if (!deck || !nav) return;

  const cols = [...deck.querySelectorAll(".col")];
  const navItems = [...nav.querySelectorAll(".bnav-item")];
  deckState.cols = cols;
  const footer = document.getElementById("footer");

  const clamp = (i) => Math.max(0, Math.min(cols.length - 1, i));

  // Mise à jour des états actifs. La barre ne liste plus toutes les colonnes :
  // on apparie par data-col (une colonne non présente dans la barre, ex. Mon ID,
  // n'allume simplement aucune entrée).
  function applyActive(idx) {
    cols.forEach((c, ci) => c.classList.toggle("active", ci === idx));
    navItems.forEach((n) => {
      const on = n.dataset.col != null && n.dataset.col !== "" && Number(n.dataset.col) === idx;
      n.classList.toggle("active", on);
    });
  }

  function go(i) {
    const idx = clamp(i);
    deckState.index = idx;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // Transition de panneau façon 2026 (View Transitions API) : crossfade +
    // montée de la page active, header/rail figés. Repli direct si non supporté
    // ou si l'utilisateur a demandé moins de mouvement.
    if (!reduce && !document.hidden && typeof document.startViewTransition === "function") {
      const vt = document.startViewTransition(() => applyActive(idx));
      // Une transition interrompue (changements d'onglet rapprochés, init) rejette
      // .ready/.finished avec « Transition was skipped » → on absorbe ces rejets
      // pour ne pas polluer la console (la bascule a tout de même eu lieu).
      vt?.ready?.catch(() => {});
      vt?.finished?.catch(() => {});
      vt?.updateCallbackDone?.catch(() => {});
    } else {
      applyActive(idx);
    }
    // Masquer le footer quand le tab Chat est actif (comm-layout plein écran)
    const activeLabel = cols[idx]?.dataset.deckLabel;
    if (footer) footer.style.display = activeLabel === "Chat" ? "none" : "";
    // Scroll en haut de page sauf premier rendu
    if (document.readyState === "complete") window.scrollTo({ top: 0, behavior: "instant" });
  }

  deckState.go = go;
  // Navigation par label sur le closure cols/go courant de l'éditeur (jamais
  // périmé) : hook e2e + pratique au débogage. Inoffensif en prod.
  deckState.goLabel = (label) => {
    const i = cols.findIndex((c) => c.dataset.deckLabel === label);
    if (i >= 0) go(i);
    return i >= 0;
  };
  if (typeof window !== "undefined") window.__deckGoLabel = deckState.goLabel;

  navItems.forEach((btn) => {
    btn.addEventListener("click", () => go(Number(btn.dataset.col)));
  });

  // Navigation clavier (accessibilité)
  nav.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") go(deckState.index + 1);
    if (e.key === "ArrowLeft") go(deckState.index - 1);
  });

  // Indice de navigation (ex. retour depuis la page Premium → onglet Galerie).
  let hintTab = null;
  try { hintTab = sessionStorage.getItem("mindlog.openTab"); sessionStorage.removeItem("mindlog.openTab"); } catch {}
  const hintIdx = hintTab ? cols.findIndex(c => c.dataset.deckLabel === hintTab) : -1;
  if (hintIdx >= 0) {
    deckState.index = hintIdx;
  } else if (deckState.index === 0) {
    // Premier chargement → atterrir sur Chat par défaut.
    const chatIdx = cols.findIndex(c => c.dataset.deckLabel === "Chat");
    if (chatIdx >= 0) deckState.index = chatIdx;
  }
  go(clamp(deckState.index)); // restaure l'onglet actif
}

export async function openContactColumn(handle) {
  const h = String(handle).replace(/^@/, "");
  const closeBtn = `<button type="button" class="close" data-contact-close aria-label="${t("com_close")}">✕</button>`;
  const section = addDeckColumn(
    {
      key: `contact:${h}`,
      label: `@${h}`,
      html: `<div class="card profile-card" style="position:relative">${closeBtn}<p class="loading" style="padding:2.5rem 0;text-align:center">${t("eix_loading_handle").replace("{handle}", esc(h))}</p></div>`,
      wire: (overlay) =>
        overlay.querySelector("[data-contact-close]")?.addEventListener("click", () => removeDeckColumn(overlay)),
    }
    // pas d'afterLabel → s'insère juste à droite de la colonne active
  );
  if (!section || section.dataset.contactLoaded) return;

  let data;
  try {
    data = await api(`/api/identities/${encodeURIComponent(h)}`, { headers: viewerHeaders() });
  } catch {
    section.innerHTML = `<div class="card profile-card" style="position:relative">${closeBtn}<p class="empty" style="padding:2rem 0;text-align:center">${t("eix_profile_not_found").replace("{handle}", esc(h))}</p></div>`;
    section.querySelector("[data-contact-close]")?.addEventListener("click", () => removeDeckColumn(section));
    return;
  }
  section.dataset.contactLoaded = "1";

  const canChat = !!data.viewer?.isContact && data.options?.allowChat !== false;
  const canCall = !!data.viewer?.isContact && data.options?.allowCall !== false;
  // Rendu STRICTEMENT IDENTIQUE à la page individuelle (même composant), avec :
  // bouton Fermer (coin haut-droit) + actions de contact (Voir page / Discuter / Appel).
  const actions = {
    right: closeBtn,
    contact: `<div class="profile-contact-actions">
      <a class="btn sm" href="/@${encodeURIComponent(data.handle)}" target="_blank" rel="noopener noreferrer">${t("eix_view_page")} ↗</a>
      ${canChat ? `<button type="button" class="btn sm primary" data-contact-chat>${icon("chat", 15)} ${t("eix_chat_verb")}</button>` : ""}
      ${canCall ? `<button type="button" class="btn sm" data-contact-call${data.pubkey ? "" : " disabled"}>${icon("camera", 15)} ${t("eix_call")}</button>` : ""}
    </div>`,
  };
  section.innerHTML = profileCardHtml(data, actions);
  section.querySelector("[data-contact-close]")?.addEventListener("click", () => removeDeckColumn(section));
  section.querySelector("[data-contact-chat]")?.addEventListener("click", () => host.chat.open(data.handle, myKey(), myHandle()));
  section.querySelector("[data-contact-call]")?.addEventListener("click", () => {
    if (data.pubkey && host.call) host.call.start(data.handle, data.pubkey, { video: false });
  });
}

// Page « Espace Premium » : vue plein écran servie à l'URL /me/premium (vraie
// page, ni colonne du deck ni modale). Regroupe abonnement/facturation,
// couverture, boutons personnalisés, pages payantes, liens galerie. Atteinte via
// le bouton « Gérer » du bandeau (location.assign("/me/premium")) ; retour via le
// bouton « ← Retour » ou le bouton retour du navigateur.
export async function renderPremiumFull() {
  app.innerHTML = `<p class="loading">${t("com_loading")}</p>`;
  let data;
  try {
    data = await api("/api/me", { headers: authHeaders() });
  } catch {
    location.replace("/me"); // non authentifié → l'éditeur gère la connexion
    return;
  }
  appState.key = data.accessKey || appState.key || null;
  setAccessKey(appState.key);
  appState.auth = { handle: data.handle, key: appState.key };
  app.setAttribute("data-view", "premium");
  app.innerHTML = renderPremiumPage(data);
  wirePremiumPage(app, data);
}

// Câblage de la page Premium (scopé à `root` = #app). Les ids premium
// (#cover-file, #pb-*, #pp-*) ne vivent que sur cette page → pas de collision.
function wirePremiumPage(root, data) {
  if (!root) return;
  const reloadEditor = async () => renderPremiumFull(); // re-render la page Premium
  const premErr = (e) => toast(e?.message === "premium required" ? t("eix_premium_only_accounts") : (e?.message || t("eix_failed")));

  root.querySelector("#prem-back")?.addEventListener("click", () => {
    // history.back si on a un historique même origine, sinon /me (cohérent
    // avec backBtnHtml du SPA).
    const sameOrigin = document.referrer && new URL(document.referrer, location.href).origin === location.origin;
    if (window.history.length > 1 && sameOrigin) window.history.back();
    else location.assign("/me");
  });
  root.querySelector("#prem-portal")?.addEventListener("click", openBillingPortal);

  // Pane Personnalisation — compte non-Premium : bouton « Démarrer mon essai
  // gratuit ». 30 jours, sans CB, server-managed (POST /api/premium/trial/start).
  // Après succès, on re-render la page pour basculer le pane en mode Premium.
  const trialBtn = root.querySelector("#prem-upsell-trial");
  const trialStatus = root.querySelector("#prem-upsell-status");
  if (trialBtn) {
    trialBtn.addEventListener("click", async () => {
      trialBtn.disabled = true;
      if (trialStatus) trialStatus.textContent = t("eix_activating");
      try {
        const r = await api("/api/premium/trial/start", { method: "POST", headers: jsonAuth() });
        if (trialStatus) trialStatus.textContent = t("eix_premium_activated_days").replace("{days}", r.days);
        toast(t("eix_trial_started").replace("{days}", r.days));
        await reloadEditor();
      } catch (e) {
        trialBtn.disabled = false;
        if (trialStatus) trialStatus.textContent = "";
        toast(e?.message || t("eix_activation_fail"));
      }
    });
  }

  // ── Tabs Premium : bascule entre les panes (subscription / space / profile).
  // Persiste l'onglet actif dans le hash pour permettre le rechargement direct.
  (() => {
    const tabBtns = Array.from(root.querySelectorAll(".prem-tab-btn[data-prem-tab]"));
    const panes = Array.from(root.querySelectorAll("[data-prem-pane]"));
    if (!tabBtns.length || !panes.length) return;
    const activate = (key) => {
      const k = tabBtns.some(b => b.dataset.premTab === key) ? key : "premium";
      tabBtns.forEach(b => {
        const on = b.dataset.premTab === k;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      panes.forEach(p => {
        const on = p.dataset.premPane === k;
        p.hidden = !on;
        p.classList.toggle("is-active", on);
      });
      try {
        if (location.hash.replace(/^#/, "") !== k) {
          history.replaceState(null, "", `${location.pathname}${location.search}#${k}`);
        }
      } catch { /* ignore (sandbox) */ }
      // Remonte le scroll dans le body Premium pour pas atterrir au milieu.
      root.querySelector(".prem-body")?.scrollTo?.({ top: 0, behavior: "instant" });
    };
    tabBtns.forEach(b => b.addEventListener("click", () => activate(b.dataset.premTab)));
    // Back-compat hash : "subscription"/"space" → "premium", "profile" → "public".
    const HASH_ALIAS = { subscription: "premium", space: "premium", profile: "public" };
    const rawHash = (location.hash || "").replace(/^#/, "");
    const initial = HASH_ALIAS[rawHash] ?? rawHash ?? "premium";
    activate(initial || "premium");
  })();

  // Toggle « Profil hors annuaire » : inversé (case cochée = listed_in_directory false).
  const hiddenCb = root.querySelector("#prem-perk-hidden");
  const hiddenStatus = root.querySelector("#prem-perks-status");
  hiddenCb?.addEventListener("change", async () => {
    if (hiddenStatus) hiddenStatus.textContent = t("eix_saving");
    try {
      await api("/api/me/settings", {
        method: "PATCH",
        headers: jsonAuth(),
        body: JSON.stringify({ listed_in_directory: !hiddenCb.checked }),
      });
      if (hiddenStatus) hiddenStatus.textContent = hiddenCb.checked ? t("eix_profile_hidden_dir") : t("eix_profile_visible_dir");
    } catch (e) {
      if (hiddenStatus) hiddenStatus.textContent = "";
      hiddenCb.checked = !hiddenCb.checked; // revert UI
      toast(e?.message || t("eix_failed"));
    }
  });
  // Raccourci vers l'onglet Galerie (premium feature de customisation : liens
  // sur chaque photo). Pose un indice sessionStorage lu par setupTabs.
  root.querySelector("#prem-go-gallery")?.addEventListener("click", () => {
    try { sessionStorage.setItem("mindlog.openTab", "Galerie"); } catch {}
    location.assign("/me");
  });

  // ── Tags du profil (Premium) : ajout + suppression. Backend OSS (/api/tags)
  // pour l'instant ; le gating Premium côté serveur reste à faire.
  (() => {
    const input = root.querySelector("#prem-tag-input");
    const addBtn = root.querySelector("#prem-add-tag");
    const status = root.querySelector("#prem-tag-status");
    const list = root.querySelector("#prem-tags-edit");
    if (!input || !addBtn || !list) return;
    const setStatus = (txt) => { if (status) status.textContent = txt; };
    const submit = async () => {
      const tag = (input.value || "").trim();
      if (!tag) return;
      setStatus(t("eix_adding"));
      try {
        await api("/api/tags", { method: "POST", headers: jsonAuth(), body: JSON.stringify({ tag }) });
        input.value = "";
        await reloadEditor();
      } catch (e) {
        setStatus("");
        premErr(e);
      }
    };
    addBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } });
    list.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-del-tag]");
      if (!btn) return;
      setStatus(t("eix_deleting"));
      try {
        await api(`/api/tags/${encodeURIComponent(btn.dataset.delTag)}`, { method: "DELETE", headers: jsonAuth() });
        await reloadEditor();
      } catch (err) {
        setStatus("");
        premErr(err);
      }
    });
  })();

  // Couverture (Premium) : cadrage + recompression côté navigateur (1080×1920
  // WebP image, WebM VP9 10 s sans audio) avant upload. Backend `/api/cover`
  // reste OSS pour l'instant ; gating Premium côté serveur à ajouter.
  const coverInput = root.querySelector("#cover-file");
  coverInput?.addEventListener("change", async () => {
    const file = coverInput.files?.[0];
    coverInput.value = "";
    if (!file) return;
    let out;
    try { out = await openCoverEditor(file); }
    catch (e) { premErr(e); return; }
    if (!out) return;
    const fd = new FormData();
    fd.append("cover", new File([out.blob], `cover.${out.ext}`, { type: out.type }));
    try { await api("/api/cover", { method: "POST", headers: authHeaders(), body: fd }); toast(t("eix_cover_updated")); await reloadEditor(); }
    catch (e) { premErr(e); }
  });
  root.querySelector("#cover-remove")?.addEventListener("click", async () => {
    try { await api("/api/cover", { method: "DELETE", headers: authHeaders() }); toast(t("eix_cover_removed")); await reloadEditor(); }
    catch (e) { premErr(e); }
  });

  // Boutons personnalisés : édition complète (icône, libellé, URL, forme,
  // affichage du libellé). La position (pos_x/pos_y) est portée en data-attr et
  // préservée — la modification de position se fait sur la page publique (drag).
  // Save automatique (debounce 280ms) sur toute mutation.
  const pbList = root.querySelector("#pb-list");
  const pbCount = root.querySelector("#pb-count");
  const pbStatus = root.querySelector("#pb-status");
  const pbAdd = root.querySelector("#pb-add");
  if (pbList) {
    const refreshCount = () => {
      const n = pbList.querySelectorAll(".pb-row").length;
      if (pbCount) pbCount.textContent = `${n}/5`;
      if (pbAdd) pbAdd.disabled = n >= 5;
    };
    // Si l'utilisateur saisit "google.com" (sans https://), on auto-préfixe
     // pour éviter que sanitizeButtonUrl côté serveur rejette silencieusement
    // l'URL (laissant le toast "Enregistré ✓" mensonger).
    const normalizeUrl = (raw) => {
      const s = String(raw || "").trim();
      if (!s) return "";
      if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return s;
      // Heuristique : ressemble à un domaine ? Sinon, on laisse tel quel.
      if (/^[^\s/]+\.[^\s/]/.test(s)) return "https://" + s;
      return s;
    };
    const collect = () => [...pbList.querySelectorAll(".pb-row")].map((r) => {
      const urlEl = r.querySelector(".pb-url");
      const url = normalizeUrl(urlEl?.value);
      // Met à jour l'input pour montrer la normalisation à l'utilisateur.
      if (urlEl && url && urlEl.value.trim() !== url) urlEl.value = url;
      return {
        label: r.querySelector(".pb-label")?.value.trim() || "",
        url,
        icon: r.querySelector(".pb-icon")?.value.trim() || "",
        pos_x: Number(r.dataset.x ?? 0.5),
        pos_y: Number(r.dataset.y ?? 0.9),
        shape: r.querySelector(".pb-shape")?.dataset.shape === "square" ? "square" : "circle",
        show_label: r.querySelector(".pb-showlbl")?.dataset.on === "1",
      };
    });
    let saveTimer = null;
    let saveDirty = false; // y a-t-il une modif non envoyée ?
    // Envoi synchrone fire-and-forget — utilisé pour ne pas perdre une modif
    // quand l'utilisateur navigue avant la fin du debounce.
    const flushSync = () => {
      if (!saveDirty) return;
      clearTimeout(saveTimer);
      saveDirty = false;
      try {
        const buttons = collect().filter((b) => b.label && b.url);
        // keepalive : le navigateur autorise la requête à se poursuivre même
        // après que la page soit en train de se décharger.
        void fetch("/api/page/buttons", { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ buttons }), keepalive: true });
      } catch {}
    };
    const save = () => {
      saveDirty = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        if (pbStatus) pbStatus.textContent = t("eix_saving");
        try {
          const buttons = collect().filter((b) => b.label && b.url);
          const sent = buttons.length;
          const resp = await api("/api/page/buttons", { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ buttons }) });
          saveDirty = false;
          const got = Array.isArray(resp?.buttons) ? resp.buttons.length : 0;
          if (sent !== got) {
            // Le serveur a rejeté silencieusement des entrées (URL invalide…).
            const msg = (got > 1 ? t("eix_saved_partial_pl") : t("eix_saved_partial")).replace("{got}", got).replace("{sent}", sent);
            console.warn("[buttons.save] rejet silencieux", { sent, got, buttons });
            if (pbStatus) pbStatus.textContent = msg;
          } else if (pbStatus) {
            pbStatus.textContent = t("eix_saved_check");
            setTimeout(() => { if (pbStatus.textContent === t("eix_saved_check")) pbStatus.textContent = ""; }, 1500); }
        } catch (e) {
          console.error("[buttons.save] erreur", e);
          if (pbStatus) pbStatus.textContent = e?.message === "premium required" ? t("eix_premium_only_short") : (e?.message || t("eix_save_fail"));
          else toast(e?.message || t("eix_save_fail"));
        }
      }, 280);
    };
    // Flush au déchargement ou à la navigation (clic sur « Voir ma page »).
    window.addEventListener("beforeunload", flushSync);
    window.addEventListener("pagehide", flushSync);
    root.querySelector('a[href^="/@"]')?.addEventListener("click", flushSync);
    const wireRow = (row) => {
      row.querySelectorAll("input").forEach((inp) => {
        // « input » couvre frappe/coller/effacer → debounce 280ms agrège tout.
        // « blur » garde un filet de sécurité en cas de navigation rapide.
        inp.addEventListener("input", save);
        inp.addEventListener("blur", save);
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
      });
      row.querySelector(".pb-icon")?.addEventListener("input", (e) => {
        const prev = row.querySelector(".pb-prev-ic");
        if (prev) prev.innerHTML = icon(e.target.value.trim() || "link", 16);
      });
      row.querySelector(".pb-shape")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const next = btn.dataset.shape === "square" ? "circle" : "square";
        btn.dataset.shape = next;
        btn.textContent = next === "square" ? "▢" : "◯";
        save();
      });
      row.querySelector(".pb-showlbl")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const next = btn.dataset.on === "1" ? "0" : "1";
        btn.dataset.on = next;
        btn.classList.toggle("on", next === "1");
        save();
      });
      row.querySelector(".pb-del")?.addEventListener("click", () => {
        row.remove(); refreshCount(); save();
      });
    };
    pbList.querySelectorAll(".pb-row").forEach(wireRow);
    pbAdd?.addEventListener("click", () => {
      const n = pbList.querySelectorAll(".pb-row").length;
      if (n >= 5) return;
      // Position aléatoire dans la zone « visible » du hero — on évite les
      // bords (10 %) et la bande basse occupée par l'identity (avatar/nom/handle).
      const randPx = +(0.10 + Math.random() * 0.80).toFixed(3);
      const randPy = +(0.15 + Math.random() * 0.55).toFixed(3);
      // Pré-remplissage de label + URL pour que le bouton soit immédiatement
      // valide côté serveur (sanitizeButtonUrl exige http(s)://). L'utilisateur
      // les édite ensuite ; au moindre changement, save() repart.
      const tmp = document.createElement("div");
      tmp.innerHTML = pbRowHtml({
        icon: "link", shape: "circle", show_label: false,
        pos_x: randPx, pos_y: randPy,
        label: t("eix_button_n").replace("{n}", n + 1),
        url: "https://example.com",
      });
      const row = tmp.firstElementChild;
      pbList.appendChild(row);
      wireRow(row);
      refreshCount();
      // Save immédiat (pas de debounce) pour persister le bouton tout neuf,
      // même si l'utilisateur quitte la page sans le compléter.
      save();
      const lblInp = row.querySelector(".pb-label");
      lblInp?.focus(); lblInp?.select();
    });
    refreshCount();
  }

  // Pages payantes (statut Connect + liste + création).
  void loadPaidPages(root, data);
}

export function notifListHtml(list) {
  if (!list || !list.length) return `<li class="empty">${t("eix_no_notifications")}</li>`;
  return list.map(notifItemHtml).join("");
}

export function incomingListHtml(list) {
  if (!list || !list.length) return `<li class="empty">${t("eix_no_requests_received")}</li>`;
  return list.map((r) => relItemHtml(r, { incoming: true })).join("");
}

export function reqFilterChips(requests) {
  const n = { all: requests.length, pending: 0, accepted: 0, declined: 0 };
  requests.forEach((r) => { n[r.status] = (n[r.status] || 0) + 1; });
  const chip = (val, label) =>
    `<button class="req-chip${val === "pending" ? " active" : ""}" data-req-filter="${val}">${label} <span class="chip-n">${n[val]}</span></button>`;
  return (
    chip("pending", t("eix_filter_pending")) +
    chip("all", t("eix_filter_all")) +
    chip("accepted", t("eix_filter_accepted")) +
    chip("declined", t("eix_filter_declined"))
  );
}

export function requestsHtml(requests) {
  if (!requests.length) return `<li class="empty">${t("eix_no_requests")}</li>`;
  return requests
    .map((r) => {
      const badge =
        r.status === "accepted" ? "ok" : r.status === "declined" ? "no" : "pending";
      const label =
        r.status === "accepted" ? t("eix_status_accepted") : r.status === "declined" ? t("eix_status_declined") : t("eix_status_pending");
      return `
      <li class="request" data-status="${r.status}">
        <div class="req-head">
          <strong>${esc(r.name)}</strong>
          <span class="req-status ${badge}">${label}</span>
        </div>
        ${r.day ? `<div class="req-slot">${t("eix_desired_date")}${esc(host.calendar.fmtDay(r.day))}${r.time ? `${t("eix_at_prefix")}<strong>${esc(r.time)}</strong>` : ""}</div>` : ""}
        ${r.email ? `<div class="req-meta"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></div>` : ""}
        ${r.message ? `<div class="req-msg">${esc(r.message)}</div>` : ""}
        <div class="req-actions">
          ${r.status === "pending" ? `
          <button class="btn sm" data-req-accept="${r.id}">${t("eix_accept")}</button>
          <button class="btn sm" data-req-decline="${r.id}">${t("eix_refuse")}</button>` : ""}
          <button class="icon" data-req-del="${r.id}" title="${t("com_delete")}">✕</button>
        </div>
      </li>`;
    })
    .join("");
}

export function socialEditHtml(fields) {
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  return SOCIALS.map((net) => {
    const val = byKey[socialFieldKey(net.key)] || "";
    const url = socialUrl(net, val);
    return `<div class="social-edit" data-net="${net.key}">
      <span class="social-ic" style="color:${net.color}">${socialIcon(net, 18)}</span>
      <input class="social-input" value="${esc(val)}" placeholder="${esc(net.ph)}" inputmode="url" autocomplete="off" aria-label="${esc(net.label)}" />
      <a class="social-open btn-field-del" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${t("eix_open_label").replace("{label}", esc(net.label))}" aria-label="${t("eix_open_label").replace("{label}", esc(net.label))}"${url ? "" : " hidden"}>${icon("link", 13)}</a>
    </div>`;
  }).join("");
}

export function fieldEditHtml(f) {
  const vis = f.visibility || (f.is_public ? "public" : "private");
  const opt = (v, label) => `<option value="${v}" ${vis === v ? "selected" : ""}>${label}</option>`;
  const isEnc = typeof f.value === "string" && f.value.startsWith("e2e:");
  // « birthday » est un attribut permanent (date de naissance) : non supprimable.
  const canDelete = f.is_custom && f.key !== "birthday";
  // Date de naissance : sélecteur de date natif (clé canonique « birthday »,
  // valeur ISO YYYY-MM-DD). Si la valeur est chiffrée E2E (champ non public), le
  // déchiffrement à l'affichage remplit l'input dans wireFieldRow.
  const isBirthday = f.key === "birthday";
  return `
    <div class="edit-field" data-key="${esc(f.key)}">
      <span class="lbl">${esc(f.label)}</span>
      <input class="fv" ${isBirthday ? 'type="date"' : ""} value="${isEnc ? "" : esc(f.value)}" placeholder="${isEnc ? t("eix_encrypted_ph") : "—"}" data-enc="${isEnc ? esc(f.value) : ""}" />
      <select class="fvis vis-${vis}" title="${t("eix_visibility")}" aria-label="${t("eix_visibility_of").replace("{label}", esc(f.label))}">
        ${opt("public", t("eix_vis_public"))}${opt("contact", t("eix_vis_contact"))}${opt("private", t("eix_vis_private"))}
      </select>
      ${canDelete ? `<button class="btn-field-del" title="${t("eix_delete_attr")}" aria-label="${t("eix_delete_label").replace("{label}", esc(f.label))}">✕</button>` : `<span></span>`}
    </div>`;
}

export function wireEditor(data) {
  // Logo (haut-gauche) → retour à l'app (vue par défaut), en conservant l'auth
  // (clé /k/… ou cookie) et sans rechargement complet. On intercepte l'ancre du
  // header (href=/me) pour rester dans la SPA même en session par clé.
  app.querySelector(".brand")?.addEventListener("click", (e) => {
    e.preventDefault();
    // Le logo est le bouton « accueil » : navigation directe (sans re-render) vers
    // la colonne Échanges, puis bascule sur la sous-vue Discussions. Plus fiable
    // que renderPrivate (qui restaure la dernière colonne / un hint d'onglet).
    goColWith(".comm-rail");
    app.querySelector("#comm-rail-chats")?.click();
  });

  // Navigation deck par élément propre à une colonne (robuste au libellé/accent).
  const goColWith = (sel) => {
    const cols = [...document.querySelectorAll("#deck .col")];
    const i = cols.findIndex((c) => c.querySelector(sel));
    if (i >= 0 && deckState.go) deckState.go(i);
  };
  // Ouvre la colonne Compte ET active un de ses panneaux (profil / notifs / …).
  // Profil et Notifications sont des PANNEAUX du Compte (le sous-menu reste affiché).
  const goCompteTab = (tab) => {
    goColWith(".acc-rail"); // la colonne Compte contient le rail .acc-rail
    app.querySelector(`.opt-tab[data-tab="${tab}"]`)?.click();
  };

  // Retaille une image pour qu'elle tienne dans 320×320 (ratio préservé, sans
  // déformation) avant l'envoi. Best-effort : en cas d'échec on garde l'original.
  const resizePhoto = async (blob, max = 320) => {
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      return await new Promise((res) => canvas.toBlob((b) => res(b || blob), "image/jpeg", 0.9));
    } catch {
      return blob;
    }
  };

  const uploadPhotoBlob = async (blob) => {
    const resized = await resizePhoto(blob);
    const fd = new FormData();
    fd.append("photo", resized, "photo.jpg");
    await fetch("/api/photo", { method: "POST", headers: authHeaders(), body: fd });
    toast(t("msg_photo_updated"));
    renderPrivate(appState.key);
  };

  app.querySelector('#photo-form input[type=file]').addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (file) await uploadPhotoBlob(file);
  });

  app.querySelector("#take-photo-btn").addEventListener("click", async () => {
    if (!navigator.mediaDevices?.getUserMedia) return toast(t("eix_camera_unavailable"));
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } } });
    } catch {
      return toast(t("eix_camera_denied"));
    }

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true" style="max-width:480px;padding:1rem">
        <button type="button" class="close" id="cam-close" aria-label="${t("com_close")}">✕</button>
        <h2 style="margin-bottom:.75rem">${t("eix_take_photo")}</h2>
        <video id="cam-video" autoplay playsinline muted style="width:100%;border-radius:8px;background:#000;aspect-ratio:1;object-fit:cover"></video>
        <canvas id="cam-canvas" hidden></canvas>
        <div class="actions" style="margin-top:.75rem">
          <button type="button" class="btn" id="cam-cancel">${t("com_cancel")}</button>
          <button type="button" class="btn primary" id="cam-snap">${icon("camera", 15)} ${t("eix_capture")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const video = overlay.querySelector("#cam-video");
    video.srcObject = stream;

    const stop = () => { stream.getTracks().forEach((t) => t.stop()); overlay.remove(); };
    overlay.querySelector("#cam-close").addEventListener("click", stop);
    overlay.querySelector("#cam-cancel").addEventListener("click", stop);
    overlay.addEventListener("click", (e) => e.target === overlay && stop());

    overlay.querySelector("#cam-snap").addEventListener("click", async () => {
      const canvas = overlay.querySelector("#cam-canvas");
      const size = Math.min(video.videoWidth, video.videoHeight);
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, (video.videoWidth - size) / 2, (video.videoHeight - size) / 2, size, size, 0, 0, size, size);
      stop();
      canvas.toBlob(async (blob) => { if (blob) await uploadPhotoBlob(blob); }, "image/jpeg", 0.9);
    });
  });

  app.querySelectorAll(".edit-field").forEach((row) => wireFieldRow(row));

  function wireFieldRow(row) {
    const key = row.dataset.key;
    const input = row.querySelector(".fv");
    const vis = row.querySelector(".fvis");
    let saved = input.value;

    // Déchiffrement à l'affichage si la valeur stockée est chiffrée E2E.
    const encRaw = input.dataset.enc;
    if (encRaw && encRaw.startsWith("e2e:") && E2E.priv && E2E.pubStr) {
      const parts = encRaw.split(":");
      e2eDecrypt(E2E.pubStr, parts[1], parts[2]).then((plain) => {
        if (plain != null) {
          input.value = plain;
          input.placeholder = "—";
          saved = plain;
        }
      });
    }

    const save = async () => {
      if (input.value === saved && !vis._dirty) return;
      let value = input.value;
      // Chiffrement pour les champs non publics (to-self : propre clé publique).
      if (vis.value !== "public" && E2E.priv && E2E.pubStr) {
        try {
          const { iv, ciphertext } = await e2eEncrypt(E2E.pubStr, value);
          value = `e2e:${iv}:${ciphertext}`;
        } catch (err) { toast(err.message); return; }
      }
      try {
        await api("/api/card/field", {
          method: "PUT",
          headers: jsonAuth(),
          body: JSON.stringify({ key, value, visibility: vis.value }),
        });
        saved = input.value; // on mémorise le texte en clair
        vis._dirty = false;
        toast(t("msg_saved"));
      } catch (e) { toast(e.message); }
    };
    input.addEventListener("blur", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    vis.addEventListener("change", () => {
      vis.className = "fvis vis-" + vis.value;
      vis._dirty = true;
      save();
    });
    row.querySelector(".btn-field-del")?.addEventListener("click", async () => {
      try {
        await api(`/api/card/field/${encodeURIComponent(key)}`, { method: "DELETE", headers: jsonAuth() });
        row.remove();
      } catch (e) { toast(e.message); }
    });
  }

  app.querySelector("#add-field").addEventListener("click", async () => {
    const labelEl = app.querySelector("#nf-label");
    const valueEl = app.querySelector("#nf-value");
    const label = labelEl.value.trim();
    if (!label) return toast(t("msg_key_required"));
    const key = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "field";
    const value = valueEl.value.trim();
    try {
      await api("/api/card/field", {
        method: "PUT",
        headers: jsonAuth(),
        body: JSON.stringify({ key, label, value, is_custom: true }),
      });
    } catch (e) { return toast(e.message); }
    await renderPrivate(appState.key);
    app.querySelector(`.edit-field[data-key="${CSS.escape(key)}"] .fv`)?.focus();
  });

  // Notif d'anniversaire — déclenchée par le POSTE DE L'OWNER (le serveur ne connaît
  // pas la date, potentiellement chiffrée E2E). Si aujourd'hui correspond à MA date
  // de naissance, je demande au serveur de prévenir mes contacts mutuels. Dédup
  // serveur once/an + garde sessionStorage pour ne pas réémettre à chaque rendu.
  void (async () => {
    try {
      const bf = (data.fields || []).find((f) => f.key === "birthday");
      if (!bf || !bf.value) return;
      let val = bf.value;
      if (typeof val === "string" && val.startsWith("e2e:") && E2E.priv && E2E.pubStr) {
        const [, iv, ct] = val.split(":");
        val = (await e2eDecrypt(E2E.pubStr, iv, ct)) || "";
      }
      const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(val);
      if (!m) return;
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      if (m[1] !== mm || m[2] !== dd) return;
      const year = now.getFullYear();
      const guard = `bday-announced-${year}`;
      if (sessionStorage.getItem(guard)) return;
      const r = await api("/api/birthday/announce", { method: "POST", headers: jsonAuth(), body: JSON.stringify({ year }) }).catch(() => null);
      if (r) sessionStorage.setItem(guard, "1");
    } catch { /* best-effort */ }
  })();

  // Intro du profil (OSS, autosave) : texte Markdown au-dessus de la bio sur
  // /@handle. Stockage `identities.profile_intro_md` (migration 0032). Pré-rempli
  // côté template à partir de `data.profile_intro_md` ; sauvegarde débouncée à
  // 600 ms sur `input`, plus un flush sur `blur` pour ne jamais perdre la frappe.
  const introTa = app.querySelector("#sp-profile-intro");
  const introStatus = app.querySelector("#sp-profile-intro-status");
  if (introTa) {
    // Deep-link depuis /@handle (CTA « Définir mon intro ») : si l'URL arrive
    // avec #intro, on ouvre le panneau « Profil » du Compte (où vit la textarea
    // Markdown) PUIS on scroll/focus. Sans ça, la textarea est dans un panneau
    // masqué → focus invisible.
    if (location.hash === "#intro") {
      const focusIntro = () => {
        try { goCompteTab("profil"); } catch {}
        // Laisse le temps à la transition de colonne avant de scroller.
        setTimeout(() => {
          introTa.scrollIntoView({ behavior: "smooth", block: "center" });
          introTa.focus();
          // Curseur en fin de texte (pas en début si déjà du contenu).
          try { introTa.setSelectionRange(introTa.value.length, introTa.value.length); } catch {}
          try { history.replaceState(null, "", location.pathname + location.search); } catch {}
        }, 250);
      };
      requestAnimationFrame(focusIntro);
    }
    let lastSaved = introTa.value;
    let saveTimer = null;
    let fadeTimer = null;
    const setStatus = (txt, cls) => {
      if (!introStatus) return;
      introStatus.textContent = txt;
      introStatus.dataset.state = cls || "";
      if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
      if (cls === "ok") fadeTimer = setTimeout(() => setStatus("", ""), 1600);
    };
    const doSave = async () => {
      if (introTa.value === lastSaved) return;
      const sending = introTa.value;
      setStatus(t("eix_saving"), "saving");
      try {
        await api("/api/me/profile-intro", { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ intro_md: sending }) });
        lastSaved = sending;
        setStatus(t("eix_saved_f"), "ok");
      } catch (e) {
        setStatus("", "");
        toast(e?.message || t("eix_failed"));
      }
    };
    introTa.addEventListener("input", () => {
      if (saveTimer) clearTimeout(saveTimer);
      setStatus(t("eix_modifications"), "dirty");
      saveTimer = setTimeout(() => { saveTimer = null; void doSave(); }, 600);
    });
    // Flush immédiat à la perte de focus pour ne pas attendre 600 ms si l'user quitte la zone.
    introTa.addEventListener("blur", () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      void doSave();
    });
  }

  // Si le créateur est Premium ET a coché le bénéfice « Lives », la modale
  // propose un type « Live » qui rend l'événement joignable par les abonnés.
  const _liveAvailable = !!data.space?.benefits?.lives;

  // Rafraîchit l'agenda EN PLACE après ajout/édition/suppression d'un événement
  // (calendrier + liste « Mes événements »), sans recharger tout l'éditeur : on
  // conserve la vue (Jour/Semaine/Mois) et le scroll courants. `data.events` est
  // la source de vérité locale, mutée par onSaved/onDeleted.
  // Agenda affiché = mes événements + ceux d'autrui dont j'ai accepté l'invitation
  // (lecture seule, badgés « Invité par @x » via leur champ invited_by).
  const agendaEvents = () => [...(data.events || []), ...(data.invitedEvents || [])];
  const refreshAgenda = () => {
    const fill = app.querySelector(".calendar-fill");
    if (fill) fill.innerHTML = host.calendar.html(data.overrides || {}, true, dayLoadMap(data), false, agendaEvents());
    const list = app.querySelector(".agenda-events");
    if (list) list.innerHTML = eventsHtml(agendaEvents(), true);
    wireAgenda();
  };
  const onSaved = (saved) => {
    if (!saved?.id) { renderPrivate(appState.key); return; }
    const evs = (data.events ||= []);
    const i = evs.findIndex((e) => String(e.id) === String(saved.id));
    if (i >= 0) evs[i] = saved; else evs.push(saved);
    refreshAgenda();
  };
  const onDeleted = (eventId) => {
    data.events = (data.events || []).filter((e) => String(e.id) !== String(eventId));
    refreshAgenda();
  };
  // Contacts proposés à l'invitation : relations DIRECTES (sortantes) = degré 1.
  // getRelationsByDegree renvoie un objet { 1:[…], 2:[…], 3:[…] }, pas un tableau.
  // Le serveur revalide la relation de toute façon.
  const _inviteContacts = (data.relations?.[1] || [])
    .map((r) => ({ handle: r.handle, name: r.display_name || r.handle }));
  const modalOpts = () => ({ liveAvailable: _liveAvailable, onSaved, onDeleted, contacts: _inviteContacts });

  // Câblage (ré-appliqué à chaque refreshAgenda, car le DOM agenda est régénéré).
  function wireAgenda() {
    // Événements : suppression directe (corbeille sur la carte), création et
    // édition via la modale composer (façon Teams).
    app.querySelectorAll("[data-del-event]").forEach((b) =>
      b.addEventListener("click", async () => {
        const card = b.closest(".ev-card");
        const title = card?.querySelector(".ev-title")?.textContent?.trim() || t("eix_this_event");
        if (!(await confirmDialog(t("eix_delete_confirm_title").replace("{title}", title), { ok: t("com_delete"), danger: true }))) return;
        await api(`/api/agenda/${b.dataset.delEvent}`, { method: "DELETE", headers: authHeaders() });
        onDeleted(b.dataset.delEvent);
      })
    );
    app.querySelectorAll("[data-event-new]").forEach((b) =>
      b.addEventListener("click", () => openEventModal(null, modalOpts()))
    );
    app.querySelectorAll("[data-event-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        const ev = (data.events || []).find((e) => String(e.id) === b.dataset.eventEdit);
        if (ev) openEventModal(ev, modalOpts());
      })
    );

    // Disponibilités : navigation de période + bascule des jours + clics events.
    // Le plugin émet `calendar:newAt` au clic d'une case horaire vide (vues
    // Jour/Semaine) ou du bouton « + » d'une cellule (vue Mois) → modale
    // d'événement préremplie à l'heure cible.
    const calEl = app.querySelector(".calendar");
    host.calendar.wire(
      calEl,
      data.overrides || {},
      true,
      data.handle,
      dayLoadMap(data),
      false,
      agendaEvents(),
      (ev) => openEventModal(ev, modalOpts()),
    );
    calEl?.addEventListener("calendar:newAt", (e) => {
      const startsAt = e.detail?.startsAt; // "YYYY-MM-DDTHH:00" local
      if (startsAt) openEventModal(null, { ...modalOpts(), prefill: { starts_at: startsAt } });
    });
  }
  wireAgenda();

  // RSVP des invitations reçues : Accepter / Refuser. Câblé UNE fois (le bloc
  // .invites-recv n'est pas régénéré par refreshAgenda, contrairement à la liste).
  const respondInvite = async (eventId, accept) => {
    try {
      await api(`/api/agenda/invite/${encodeURIComponent(eventId)}/respond`, {
        method: "POST", headers: jsonAuth(), body: JSON.stringify({ accept }),
      });
    } catch (e) { return toast(e?.message || t("eix_failed")); }
    // Retire l'invitation de l'état local + de l'UI.
    const inv = (data.myInvites || []).find((iv) => String(iv.event.id) === String(eventId));
    data.myInvites = (data.myInvites || []).filter((iv) => String(iv.event.id) !== String(eventId));
    app.querySelector(`.invite-card[data-invite-event="${CSS.escape(String(eventId))}"]`)?.remove();
    if (!app.querySelector(".invite-card")) app.querySelector(".invites-recv")?.remove();
    if (accept && inv) {
      // L'événement accepté rejoint l'agenda (lecture seule, badgé « Invité par @x »).
      (data.invitedEvents ||= []).push({ ...inv.event, invited_by: inv.organizer_handle });
      refreshAgenda();
    }
    toast(accept ? t("eix_invite_accepted_short") : t("eix_invite_declined"));
  };
  app.querySelectorAll("[data-invite-accept]").forEach((b) =>
    b.addEventListener("click", () => respondInvite(b.dataset.inviteAccept, true)));
  app.querySelectorAll("[data-invite-decline]").forEach((b) =>
    b.addEventListener("click", () => respondInvite(b.dataset.inviteDecline, false)));

  // Aperçu façon téléphone (colonne Accueil) : swipe entre Accueil / Calendrier /
  // Galerie + pastilles de pagination, et montage de la vraie galerie (plugin).
  const ltScreens = app.querySelector("#lt-screens");
  if (ltScreens) {
    const dots = [...app.querySelectorAll("#lt-dots .lt-dot")];
    const goTo = (i) => ltScreens.scrollTo({ left: i * ltScreens.clientWidth, behavior: "smooth" });
    dots.forEach((d, i) => d.addEventListener("click", () => goTo(i)));
    ltScreens.addEventListener("scroll", () => {
      const i = Math.round(ltScreens.scrollLeft / Math.max(1, ltScreens.clientWidth));
      dots.forEach((d, k) => {
        d.classList.toggle("is-on", k === i);
        d.setAttribute("aria-selected", k === i ? "true" : "false");
      });
    }, { passive: true });
    // Galerie réelle (même source que la page publique) ; repli si vide ou erreur.
    const gslot = app.querySelector("#lt-gallery-slot");
    if (gslot) {
      Promise.resolve(host.gallery?.mountPublic?.(gslot, data.handle))
        .then((ok) => { if (!ok) gslot.innerHTML = `<p class="lt-empty">${t("eix_no_gallery_photo")}</p>`; })
        .catch(() => { gslot.innerHTML = `<p class="lt-empty">${t("eix_gallery_unavailable")}</p>`; });
    }
  }

  // QR code de la page publique
  app.querySelector("#qr-btn")?.addEventListener("click", () =>
    openQR(`${location.origin}${data.publicUrl}`, `@${data.handle}`)
  );
  app.querySelector("#lt-qr-btn")?.addEventListener("click", () =>
    openQR(`${location.origin}${data.publicUrl}`, `@${data.handle}`)
  );
  // Tous les toggles data-setting (banner + onglet Options)
  app.querySelectorAll("[data-setting]").forEach((input) => {
    input.addEventListener("change", async () => {
      const key = input.dataset.setting;
      const val = input.checked;
      try {
        await api("/api/me/settings", { method: "PATCH", headers: jsonAuth(), body: JSON.stringify({ [key]: val }) });
      } catch {
        input.checked = !val;
      }
    });
  });
  // Boutons onglet Options
  app.querySelector("#opt-e2e-backup")?.addEventListener("click", () =>
    openE2eBackup(data.handle, appState.key, refreshVaultStatus)
  );
  app.querySelector("#opt-qr-link")?.addEventListener("click", () =>
    openQR(`${location.origin}${data.publicUrl}`, `@${data.handle}`)
  );
  // Communications column wiring
  const commContactList = app.querySelector("#comm-contacts");
  const commRight = app.querySelector("#comm-right");
  if (commContactList && commRight) {
    // Search (filterSidebar plus bas couvre Discussions ET Groupes selon le mode actif).

    // Contact click → ouvre le chat INLINE dans le panneau droit
    commContactList.addEventListener("click", async (e) => {
      const item = e.target.closest(".comm-contact-item");
      if (!item) return;
      const h = item.dataset.handle;
      commContactList.querySelectorAll(".comm-contact-item").forEach(el => el.classList.toggle("selected", el === item));

      // Intercepter openDeckColumn pour monter dans commRight au lieu d'un tab
      const origOpen = host.openDeckColumn;
      const origClose = host.closeDeckColumn;
      host.openDeckColumn = ({ html, wire }) => {
        commRight.innerHTML = html;
        wire?.(commRight); // wireChat a besoin que #ch-close existe dans le DOM
        // Le bouton d'appel (#ch-call) est désormais rendu et câblé par chat.js sur la
        // rangée d'actions — présent quel que soit le mode d'ouverture (plus d'injection ici).
        return commRight;
      };
      host.closeDeckColumn = (col) => {
        if (col === commRight) {
          commRight.innerHTML = appState.commEmptyHtml;
          commContactList.querySelectorAll(".comm-contact-item").forEach(el => el.classList.remove("selected"));
          host.closeDeckColumn = origClose;
        } else {
          origClose?.(col);
        }
      };
      host.chat.open(h, appState.key, data.handle);
      host.openDeckColumn = origOpen; // restaurer immédiatement
    });

    /* ─────── Sous-modes Chat (rail vertical, style WhatsApp Desktop) ───────
     * Le rail à gauche de la sidebar bascule entre 2 vues : Discussions (1:1)
     * et Groupes. Chaque vue prend toute la sidebar — plus de section qui
     * rogne l'espace. La recherche filtre la vue active.
     */
    const commGroupsList = app.querySelector("#comm-groups-list");
    const commNewBtn = app.querySelector("#comm-new-btn");
    const railBtns = {
      chats: app.querySelector("#comm-rail-chats"),
      groups: app.querySelector("#comm-rail-groups"),
      live: app.querySelector("#comm-rail-live"),
      relations: app.querySelector("#comm-rail-relations"),
    };
    const views = {
      chats: app.querySelector("#comm-view-chats"),
      groups: app.querySelector("#comm-view-groups"),
      live: app.querySelector("#comm-view-live"),
      relations: app.querySelector("#comm-view-relations"),
    };
    const topbarTitle = app.querySelector("#comm-topbar-title");
    let activeMode = "chats";
    let groupsLoaded = false;
    let liveLoaded = false;
    const placeholders = {
      chats: t("ec_search_contact"),
      groups: t("ec_search_group"),
      live: t("ec_search_live"),
      relations: "",
    };
    const titles = {
      chats: `${icon("chat", 16)} ${t("ec_discussions")}`,
      groups: `${icon("users", 16)} ${t("ec_groups")}`,
      live: `${icon("radio", 16)} Live`,
      relations: `${icon("bell", 16)} ${t("ec_relations")}`,
    };
    // Live et Relations n'ont pas de recherche utile → on masque le champ.
    const searchHiddenIn = new Set(["live", "relations"]);
    // Action du bouton ＋ par mode — libellé + action effective (Relations : aucune).
    const newAction = {
      chats: { label: t("ec_new_discussion"), run: () => openContactPicker("chat") },
      groups: { label: t("ec_new_group"), run: () => openNewGroupFormInline() },
      live: { label: t("ec_start_live"), run: () => openLiveInRightPane("/me/broadcast", t("ec_start_live"), { broadcast: true }) },
    };
    /* Formulaire "Nouveau groupe" rendu DIRECTEMENT dans commRight, sans la
     * coquille .card + liste qu'ajoutait openGroups (la liste est déjà dans la
     * sidebar). Pas de popup : on injecte le HTML inline.
     *
     * UX: picker de contacts à puces (chips). État local en closure : `selected`
     * (Set de handles), `available` = contacts réciproques non sélectionnés. Le
     * champ de saisie sert à filtrer la liste ET à ajouter un handle libre
     * (recherche d'identité externe). */
    function openNewGroupFormInline() {
      const myKey = appState.key;
      const myHandle = data.handle;
      const mutualContacts = (data.relations?.[1] || [])
        .filter((r) => r.mutual)
        .map((r) => ({ handle: r.handle, displayName: r.display_name || null, hasPhoto: !!r.has_photo }));
      const selected = new Set();
      commRight.innerHTML = `
        <div class="comm-form-pane" role="region" aria-label="${t("ec_new_group")}">
          <div class="comm-form-head">
            <h2>${icon("users", 18)} ${t("ec_new_group")}</h2>
            <button type="button" class="btn sm" id="ng-cancel" aria-label="${t("com_cancel")}">← ${t("com_back")}</button>
          </div>
          <form id="ng-form" class="comm-form-body">
            <label class="comm-form-field">
              <span class="comm-form-label" for="ng-name">${t("ng_name")}</span>
              <input id="ng-name" placeholder="${t("ng_name_ph")}" maxlength="80" autocomplete="off" required />
            </label>
            <div class="comm-form-field">
              <span class="comm-form-label">${t("ng_members")}</span>
              <div class="ng-picker">
                <div class="ng-chips" id="ng-chips" aria-live="polite"></div>
                <input id="ng-search" type="text" placeholder="${t("ng_search_ph")}" autocomplete="off" />
              </div>
              <small class="comm-form-hint">${t("ng_hint")}</small>
            </div>
            <div class="ng-list-wrap">
              <div class="ng-list-head" id="ng-list-head">${mutualContacts.length ? t("ng_available") : t("ng_no_mutual")}</div>
              <ul class="ng-list" id="ng-list" role="listbox"></ul>
            </div>
            <div class="comm-form-actions">
              <button type="button" class="btn" id="ng-cancel2">${t("com_cancel")}</button>
              <button class="btn primary" type="submit" id="ng-submit">${t("ng_create")}</button>
            </div>
          </form>
        </div>`;
      const close = () => { commRight.innerHTML = appState.commEmptyHtml; };
      commRight.querySelector("#ng-cancel")?.addEventListener("click", close);
      commRight.querySelector("#ng-cancel2")?.addEventListener("click", close);
      const chipsEl = commRight.querySelector("#ng-chips");
      const listEl = commRight.querySelector("#ng-list");
      const listHead = commRight.querySelector("#ng-list-head");
      const search = commRight.querySelector("#ng-search");
      const initial = (h) => (h?.[0] || "?").toUpperCase();
      const hue = (h) => [...h].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 0);
      const avatarChip = (c) => c.hasPhoto
        ? `<img class="ng-av-img" src="/api/identities/${encodeURIComponent(c.handle)}/photo" alt="" loading="lazy" onerror="this.remove()" />`
        : `<span class="ng-av-init" style="background:hsl(${hue(c.handle)} 40% 46%)">${esc(initial(c.handle))}</span>`;
      function chipHtml(handle) {
        const c = mutualContacts.find((x) => x.handle === handle) || { handle, displayName: null, hasPhoto: false };
        return `<span class="ng-chip" data-h="${esc(handle)}">${avatarChip(c)}<span class="ng-chip-name">@${esc(handle)}</span><button type="button" class="ng-chip-x" aria-label="${t("ng_remove").replace("{handle}", esc(handle))}">✕</button></span>`;
      }
      function rowHtml(c) {
        const name = c.displayName ? esc(c.displayName) : `@${esc(c.handle)}`;
        const sub = c.displayName ? `@${esc(c.handle)}` : "";
        return `<li class="ng-row" data-h="${esc(c.handle)}" role="option" tabindex="0">
          ${avatarChip(c)}
          <div class="ng-row-body"><span class="ng-row-name">${name}</span>${sub ? `<span class="ng-row-sub">${sub}</span>` : ""}</div>
          <span class="ng-row-add" aria-hidden="true">+</span>
        </li>`;
      }
      function render() {
        chipsEl.innerHTML = selected.size
          ? [...selected].map(chipHtml).join("")
          : `<span class="ng-chips-empty">${t("ng_no_member")}</span>`;
        chipsEl.querySelectorAll(".ng-chip-x").forEach((b) =>
          b.addEventListener("click", () => { selected.delete(b.parentElement.dataset.h); render(); }));
        const q = (search.value || "").trim().toLowerCase().replace(/^@/, "");
        const filtered = mutualContacts
          .filter((c) => !selected.has(c.handle))
          .filter((c) => !q || c.handle.toLowerCase().includes(q) || (c.displayName || "").toLowerCase().includes(q));
        if (filtered.length) {
          listEl.innerHTML = filtered.map(rowHtml).join("");
          listEl.querySelectorAll(".ng-row").forEach((row) => {
            const add = () => { selected.add(row.dataset.h); search.value = ""; render(); search.focus({ preventScroll: true }); };
            row.addEventListener("click", add);
            row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); add(); } });
          });
          listHead.textContent = q ? (filtered.length > 1 ? t("ng_results_pl") : t("ng_results")).replace("{n}", filtered.length) : t("ng_available");
        } else if (q && /^[a-z0-9_-]{1,40}$/i.test(q)) {
          // Aucun match dans les relations — proposer d'ajouter le handle libre.
          listEl.innerHTML = `<li class="ng-row ng-row-free" data-h="${esc(q)}" role="option" tabindex="0">
            <span class="ng-av-init" style="background:hsl(${hue(q)} 40% 46%)">?</span>
            <div class="ng-row-body"><span class="ng-row-name">@${esc(q)}</span><span class="ng-row-sub">${t("ng_free_hint")}</span></div>
            <span class="ng-row-add" aria-hidden="true">+</span>
          </li>`;
          const free = listEl.querySelector(".ng-row-free");
          const add = () => { selected.add(q); search.value = ""; render(); search.focus({ preventScroll: true }); };
          free.addEventListener("click", add);
          free.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); add(); } });
          listHead.textContent = t("ng_add_handle");
        } else {
          listEl.innerHTML = `<li class="ng-list-empty">${mutualContacts.length ? t("ng_no_result") : t("ng_no_mutual_yet")}</li>`;
          listHead.textContent = mutualContacts.length ? t("ng_available") : "";
        }
      }
      search.addEventListener("input", render);
      search.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const q = search.value.trim().replace(/^@/, "");
          if (!q) return;
          if (/^[a-z0-9_-]{1,40}$/i.test(q)) { selected.add(q); search.value = ""; render(); }
        } else if (e.key === "Backspace" && !search.value && selected.size) {
          const last = [...selected].pop(); selected.delete(last); render();
        }
      });
      render();
      commRight.querySelector("#ng-name")?.focus({ preventScroll: true });
      commRight.querySelector("#ng-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = commRight.querySelector("#ng-name").value.trim();
        const members = [...selected];
        if (!members.length) { toast(t("ng_min_one")); return; }
        const submitBtn = commRight.querySelector("#ng-submit");
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = t("ng_creating"); }
        try {
          const g = await host.groups.api.create(name, members);
          await host.groups.syncKeys(myHandle, myKey, g.id, g.members.map((m) => m.handle));
          toast(t("ng_created"));
          await refreshGroupsSidebar();
          openGroupInline(g.id);
        } catch (err) {
          toast(err.message || t("ng_create_fail"));
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t("ng_create"); }
        }
      });
    }
    const setMode = (mode) => {
      if (!railBtns[mode] || !views[mode]) return;
      const prevMode = activeMode;
      activeMode = mode;
      if (prevMode !== mode) {
        // Changer d'onglet ferme le panneau contextuel ouvert à droite
        // (diffusion live, chat ouvert, formulaire nouveau groupe…).
        commRight.innerHTML = appState.commEmptyHtml;
        commContactList.querySelectorAll(".comm-contact-item").forEach((el) => el.classList.remove("selected"));
        commGroupsList?.querySelectorAll(".comm-group-item").forEach((el) => el.classList.remove("selected"));
      }
      for (const k of Object.keys(railBtns)) {
        railBtns[k]?.classList.toggle("is-active", k === mode);
        railBtns[k]?.setAttribute("aria-selected", k === mode ? "true" : "false");
        if (views[k]) views[k].hidden = k !== mode;
      }
      if (topbarTitle) topbarTitle.innerHTML = titles[mode];
      // En mode Live, le plugin live.js fournit son propre en-tête (« Live » + intro),
      // sa recherche et sa CTA « Démarrer un live » → le comm-topbar (titre + ＋) ferait
      // doublon : on le masque pour ce mode.
      // display inline (le CSS .comm-topbar { display:flex } l'emporterait sur [hidden]).
      const topbar = app.querySelector("#comm-topbar");
      if (topbar) topbar.style.display = mode === "live" ? "none" : "";
      const searchWrap = app.querySelector(".comm-search-wrap");
      const search = app.querySelector("#comm-search");
      if (searchWrap) searchWrap.hidden = searchHiddenIn.has(mode);
      if (search) search.placeholder = placeholders[mode];
      if (commNewBtn) {
        const a = newAction[mode];
        commNewBtn.title = a?.label || "";
        commNewBtn.setAttribute("aria-label", a?.label || "");
        commNewBtn.style.display = a ? "" : "none"; // pas de ＋ pour Relations (aucune action)
      }
      if (mode === "groups" && !groupsLoaded) refreshGroupsSidebar();
      if (mode === "live" && !liveLoaded) loadLiveView();
      filterSidebar();
    };
    railBtns.chats?.addEventListener("click", () => setMode("chats"));
    railBtns.groups?.addEventListener("click", () => setMode("groups"));
    railBtns.live?.addEventListener("click", () => setMode("live"));
    railBtns.relations?.addEventListener("click", () => setMode("relations"));
    // ＋ contextuel : dispatch selon le mode actif (newAction).
    commNewBtn?.addEventListener("click", () => newAction[activeMode]?.run?.());
    /* Live : récupère le descripteur de colonne contribué par le plugin live.js
     * (editorColumns hook) et injecte son HTML + wire dans la vue sidebar.
     * Une seule fois (lazy + mémorisé). */
    function loadLiveView() {
      const liveHost = app.querySelector("#comm-live-host");
      if (!liveHost) return;
      try {
        const liveCol = host.getPlugins?.()
          .find((p) => p.id === "live")
          ?.editorColumns?.(host, data)?.[0];
        if (!liveCol) {
          liveHost.innerHTML = `<div class="comm-empty-state"><p>${t("eix_live_module_unavailable")}</p></div>`;
          return;
        }
        liveHost.innerHTML = liveCol.html;
        liveCol.wire?.(liveHost);
        // Intercepte les clics sur cartes Live (démarrage, en direct, à venir,
        // ainsi que les vignettes Netflix-style .lv-tile) pour rendre la cible
        // dans commRight au lieu de naviguer en plein écran.
        liveHost.addEventListener("click", (e) => {
          const a = e.target.closest("a.live-card, a.lv-tile");
          if (!a) return;
          const href = a.getAttribute("href");
          if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // ctrl/cmd-click ouvre normalement
          e.preventDefault();
          // Titre : sur .live-card on prend le <strong>, sur .lv-tile on
          // prend .lv-tile-title (le <strong> est aussi présent).
          const title = (a.querySelector(".lv-tile-title")?.textContent
            || a.querySelector("strong")?.textContent
            || "Live").trim();
          // Le CTA « Démarrer un live » pointe vers /me/broadcast : on signale
          // l'intention de diffuser pour permettre le gate Premium en amont.
          openLiveInRightPane(href, title, { broadcast: href === "/me/broadcast" });
        });
        liveLoaded = true;
      } catch {
        liveHost.innerHTML = `<div class="comm-empty-state"><p>${t("eix_live_load_error")}</p></div>`;
      }
    }
    /* Ouvre une URL Live dans commRight via un iframe plein-cadre (caméra +
     * micro + screen-share autorisés en same-origin). Une topbar avec « Retour »
     * et « Ouvrir dans un onglet » permet de revenir à l'état vide ou d'ouvrir
     * la version standalone si besoin. */
    function openLiveInRightPane(url, title, opts = {}) {
      // Gate Premium pour la diffusion : si l'intention est de broadcast et que
      // le compte n'est pas Premium, on remplace l'iframe par un CTA inline
      // plutôt que de charger une page qui se contenterait d'afficher la même
      // chose en interne (et de prendre une frame pour rien).
      if (opts.broadcast && appState.me?.plan !== "premium") {
        commRight.innerHTML = `
          <div class="comm-iframe-wrap">
            <div class="comm-iframe-bar">
              <button type="button" class="btn sm" id="comm-iframe-close" aria-label="${t("com_back")}">← ${t("com_back")}</button>
              <span class="comm-iframe-title">${esc(title)}</span>
            </div>
            <div class="live-cta-premium">
              <div class="live-cta-icon" aria-hidden="true">📡</div>
              <h2 class="live-cta-h">${t("eix_live_premium_title")}</h2>
              <p class="live-cta-lead">${t("eix_live_premium_lead")}</p>
              <ul class="live-cta-list">
                <li>${t("eix_live_feat_hd")}</li>
                <li>${t("eix_live_feat_chat")}</li>
                <li>${t("eix_live_feat_notif")}</li>
                <li>${t("eix_live_feat_scheduled")}</li>
              </ul>
              <a class="btn primary" href="/me/premium">${icon("sparkles", 14)} ${t("eix_become_premium")}</a>
            </div>
          </div>`;
        commRight.querySelector("#comm-iframe-close")?.addEventListener("click", () => {
          commRight.innerHTML = appState.commEmptyHtml;
        });
        return;
      }
      commRight.innerHTML = `
        <div class="comm-iframe-wrap">
          <div class="comm-iframe-bar">
            <button type="button" class="btn sm" id="comm-iframe-close" aria-label="${t("com_back")}">← ${t("com_back")}</button>
            <span class="comm-iframe-title">${esc(title)}</span>
            <a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener" title="${t("eix_open_in_tab")}" aria-label="${t("eix_open_in_tab")}">↗</a>
          </div>
          <iframe class="comm-iframe" src="${esc(url)}" allow="camera; microphone; display-capture; fullscreen" allowfullscreen></iframe>
        </div>`;
      commRight.querySelector("#comm-iframe-close")?.addEventListener("click", () => {
        commRight.innerHTML = appState.commEmptyHtml;
      });
    }
    // Filtrage : appliqué uniquement à la vue active.
    const filterSidebar = () => {
      const q = (app.querySelector("#comm-search")?.value || "").trim().toLowerCase();
      const selector = activeMode === "groups" ? ".comm-group-item" : ".comm-contact-item";
      app.querySelectorAll(selector).forEach((el) => {
        el.hidden = !!q && !(el.dataset.search || "").includes(q);
      });
    };
    // Intercepte openDeckColumn pour monter le HTML du plugin dans commRight, et
    // closeDeckColumn pour restaurer l'état initial (mêmes effets que le wiring
    // existant des contacts 1:1). On restaure openDeckColumn juste après l'appel
    // SYNCHRONE — closeDeckColumn reste interceptée car déclenchée plus tard par
    // l'utilisateur (clic sur ✕ dans le plugin).
    const wrapInline = (fn) => {
      const origOpen = host.openDeckColumn;
      const origClose = host.closeDeckColumn;
      host.openDeckColumn = ({ html, wire }) => {
        commRight.innerHTML = html;
        wire?.(commRight);
        return commRight;
      };
      host.closeDeckColumn = (col) => {
        if (col === commRight) {
          commRight.innerHTML = appState.commEmptyHtml;
          commContactList.querySelectorAll(".comm-contact-item").forEach((el) => el.classList.remove("selected"));
          commGroupsList?.querySelectorAll(".comm-group-item").forEach((el) => el.classList.remove("selected"));
          host.closeDeckColumn = origClose;
        } else { origClose?.(col); }
      };
      try { fn(); } finally { host.openDeckColumn = origOpen; }
    };
    const openGroupInline = (gid) => wrapInline(() => {
      commContactList.querySelectorAll(".comm-contact-item").forEach((el) => el.classList.remove("selected"));
      commGroupsList?.querySelectorAll(".comm-group-item").forEach((el) => el.classList.toggle("selected", el.dataset.gid === gid));
      host.chat.openGroup(gid, appState.key, data.handle);
      // Intercepte le bouton « Gérer » du chat plugin (cascade de prompts par
      // défaut) pour ouvrir un panneau inline avec picker chips. Délégation +
      // capture pour court-circuiter le handler chat.js bound sur le bouton.
      commRight.addEventListener("click", (e) => {
        if (e.target.closest("#gc-manage")) {
          e.preventDefault(); e.stopImmediatePropagation();
          openManageGroupInline(gid);
        }
      }, true);
    });
    /* Panneau « Gérer le groupe » : membres actuels (✕ pour retirer) + picker
     * (chips) pour ajouter, calqué sur Nouveau groupe. Le rail+sidebar restent
     * visibles, seul commRight est remplacé temporairement. */
    async function openManageGroupInline(gid) {
      const myKey = appState.key;
      const myHandle = data.handle;
      const mutualContacts = (data.relations?.[1] || [])
        .filter((r) => r.mutual)
        .map((r) => ({ handle: r.handle, displayName: r.display_name || null, hasPhoto: !!r.has_photo }));
      const initial = (h) => (h?.[0] || "?").toUpperCase();
      const hue = (h) => [...h].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 0);
      const avatarChip = (c) => c.hasPhoto
        ? `<img class="ng-av-img" src="/api/identities/${encodeURIComponent(c.handle)}/photo" alt="" loading="lazy" onerror="this.remove()" />`
        : `<span class="ng-av-init" style="background:hsl(${hue(c.handle)} 40% 46%)">${esc(initial(c.handle))}</span>`;
      const roleLabel = (r) => r === "owner" ? t("eix_role_owner") : r === "admin" ? "admin" : t("eix_role_member");
      let group = null;
      const skeleton = `
        <div class="comm-form-pane" role="region" aria-label="${t("eix_manage_group")}">
          <div class="comm-form-head">
            <h2 id="mg-title">${icon("users", 18)} ${t("eix_manage_group")}</h2>
            <button type="button" class="btn sm" id="mg-back" aria-label="${t("eix_back_to_conv")}">← ${t("com_back")}</button>
          </div>
          <div class="comm-form-body">
            <!-- Renommage (admin/owner) — masqué tant que le rôle n'est pas connu. -->
            <div class="comm-form-field" id="mg-rename-field" hidden>
              <label class="comm-form-label" for="mg-name">${t("eix_group_name")}</label>
              <div class="add-row" style="grid-template-columns:1fr auto">
                <input id="mg-name" type="text" maxlength="80" autocomplete="off" />
                <button type="button" class="btn sm" id="mg-rename">${t("eix_rename")}</button>
              </div>
            </div>
            <div class="comm-form-field">
              <span class="comm-form-label">${t("eix_current_members")} (<span id="mg-count">…</span>)</span>
              <ul class="ng-list" id="mg-members"><li class="ng-list-empty">${t("com_loading")}</li></ul>
            </div>
            <!-- Ajout de membre : admin/owner uniquement (masqué sinon). -->
            <div class="comm-form-field" id="mg-add-field" hidden>
              <span class="comm-form-label">${t("eix_add_member")}</span>
              <div class="ng-picker">
                <input id="mg-search" type="text" placeholder="${t("eix_search_contacts_ph")}" autocomplete="off" />
              </div>
              <small class="comm-form-hint">${t("eix_type_handle_hint")}</small>
            </div>
            <div class="ng-list-wrap" id="mg-list-wrap" hidden>
              <div class="ng-list-head" id="mg-list-head">${t("eix_available_contacts")}</div>
              <ul class="ng-list" id="mg-list" role="listbox"></ul>
            </div>
            <!-- Quitter : ouvert à tous les membres. Supprimer : propriétaire seul. -->
            <div class="comm-form-field" style="margin-top:.8rem;display:flex;gap:.5rem;flex-wrap:wrap">
              <button type="button" class="btn sm" id="mg-leave">${t("eix_leave_group")}</button>
              <button type="button" class="btn sm danger" id="mg-delete" hidden>${icon("trash", 14)} ${t("eix_delete_group")}</button>
            </div>
          </div>
        </div>`;
      commRight.innerHTML = skeleton;
      commRight.querySelector("#mg-back")?.addEventListener("click", () => openGroupInline(gid));
      const membersEl = commRight.querySelector("#mg-members");
      const countEl = commRight.querySelector("#mg-count");
      const titleEl = commRight.querySelector("#mg-title");
      const listEl = commRight.querySelector("#mg-list");
      const listHead = commRight.querySelector("#mg-list-head");
      const search = commRight.querySelector("#mg-search");
      const renameField = commRight.querySelector("#mg-rename-field");
      const nameInp = commRight.querySelector("#mg-name");
      const renameBtn = commRight.querySelector("#mg-rename");
      const deleteBtn = commRight.querySelector("#mg-delete");
      const leaveBtn = commRight.querySelector("#mg-leave");
      const addField = commRight.querySelector("#mg-add-field");
      const listWrap = commRight.querySelector("#mg-list-wrap");

      // Quitter le groupe — accessible à TOUT membre. Le serveur refuse au
      // propriétaire tant qu'il reste d'autres membres (transfert requis) : on
      // relaie simplement son message d'erreur.
      leaveBtn?.addEventListener("click", async () => {
        const label = group?.name || t("eix_group_default");
        const ok = await confirmDialog(
          t("eix_leave_group_confirm").replace("{name}", label),
          { ok: t("eix_leave_group"), cancel: t("com_cancel"), danger: true },
        );
        if (!ok) return;
        try {
          await host.groups.api.leave(gid);
          toast(t("eix_group_left"));
          commRight.innerHTML = appState.commEmptyHtml;
          await refreshGroupsSidebar();
        } catch (e) { toast(e.message || t("er_fail")); }
      });

      // Renommer (admin/owner) : PATCH puis rechargement (le nom se propage aux
      // autres membres via l'événement temps réel `group` émis par le serveur).
      async function doRename() {
        const name = (nameInp.value || "").trim();
        if (!name || name === group?.name) return;
        try {
          await host.groups.api.rename(gid, name);
          toast(t("eix_group_renamed"));
          await reload();
        } catch (e) { toast(e.message || t("er_fail")); }
      }
      renameBtn?.addEventListener("click", doRename);
      nameInp?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doRename(); } });

      // Supprimer le groupe (propriétaire) : destructif → confirmation explicite.
      deleteBtn?.addEventListener("click", async () => {
        const label = group?.name || t("eix_group_default");
        const ok = await confirmDialog(
          t("eix_delete_group_confirm").replace("{name}", label),
          { ok: t("com_delete"), cancel: t("com_cancel"), danger: true },
        );
        if (!ok) return;
        try {
          await host.groups.api.remove(gid);
          toast(t("eix_group_deleted"));
          // Le groupe n'existe plus : on vide le panneau de droite EXPLICITEMENT
          // (setMode("groups") serait un no-op si on est déjà sur cet onglet, et
          // laisserait afficher la gestion d'un groupe supprimé), puis on relit la liste.
          commRight.innerHTML = appState.commEmptyHtml;
          await refreshGroupsSidebar();
        } catch (e) { toast(e.message || t("er_fail")); }
      });

      function renderMembers() {
        if (!group) return;
        const me = group.members.find((m) => m.handle === myHandle);
        const canManage = me?.role === "owner" || me?.role === "admin";
        // Visibilité par rôle : renommage + ajout de membres = admin/owner ;
        // suppression = propriétaire seul ; « quitter » = tout le monde.
        if (renameField) renameField.hidden = !canManage;
        if (nameInp && document.activeElement !== nameInp) nameInp.value = group.name || "";
        if (addField) addField.hidden = !canManage;
        if (listWrap) listWrap.hidden = !canManage;
        if (deleteBtn) deleteBtn.hidden = me?.role !== "owner";
        countEl.textContent = String(group.members.length);
        titleEl.innerHTML = `${icon("users", 18)} ${esc(group.name || t("eix_group_default"))} <span class="deg" style="font-size:.72rem;font-weight:500">${t("eix_encrypted_badge")}</span>`;
        membersEl.innerHTML = group.members.map((m) => {
          const c = { handle: m.handle, displayName: null, hasPhoto: false };
          const cReal = mutualContacts.find((x) => x.handle === m.handle);
          if (cReal) { c.displayName = cReal.displayName; c.hasPhoto = cReal.hasPhoto; }
          const isOwner = m.role === "owner";
          const removable = canManage && !isOwner && m.handle !== myHandle;
          return `<li class="ng-row" data-h="${esc(m.handle)}">
            ${avatarChip(c)}
            <div class="ng-row-body">
              <span class="ng-row-name">@${esc(m.handle)}${m.handle === myHandle ? ` <small style='color:var(--muted)'>${t("eix_you_paren")}</small>` : ""}</span>
              <span class="ng-row-sub">${esc(roleLabel(m.role))}</span>
            </div>
            ${removable ? `<button type="button" class="ng-chip-x mg-remove" title="${t("eix_remove_handle").replace("{handle}", esc(m.handle))}" aria-label="${t("eix_remove_handle").replace("{handle}", esc(m.handle))}">✕</button>` : ""}
          </li>`;
        }).join("");
        membersEl.querySelectorAll(".mg-remove").forEach((b) => {
          b.addEventListener("click", async () => {
            const h = b.closest(".ng-row")?.dataset.h;
            if (!h) return;
            if (!(await confirmDialog(t("eix_remove_from_group").replace("{handle}", h), { ok: t("eix_remove"), danger: true }))) return;
            try {
              await host.groups.api.removeMember(gid, h);
              const g2 = await host.groups.api.get(gid);
              await host.groups.rotate(myHandle, myKey, gid, g2.members.map((mm) => mm.handle));
              toast(t("eix_member_removed_keys").replace("{handle}", h));
              await reload();
            } catch (e) { toast(e.message || t("er_fail")); }
          });
        });
      }
      function renderList() {
        if (!group) return;
        const memberSet = new Set(group.members.map((m) => m.handle));
        const q = (search.value || "").trim().toLowerCase().replace(/^@/, "");
        const filtered = mutualContacts
          .filter((c) => !memberSet.has(c.handle))
          .filter((c) => !q || c.handle.toLowerCase().includes(q) || (c.displayName || "").toLowerCase().includes(q));
        if (filtered.length) {
          listEl.innerHTML = filtered.map((c) => {
            const name = c.displayName ? esc(c.displayName) : `@${esc(c.handle)}`;
            const sub = c.displayName ? `@${esc(c.handle)}` : "";
            return `<li class="ng-row" data-h="${esc(c.handle)}" role="option" tabindex="0">
              ${avatarChip(c)}
              <div class="ng-row-body"><span class="ng-row-name">${name}</span>${sub ? `<span class="ng-row-sub">${sub}</span>` : ""}</div>
              <span class="ng-row-add" aria-hidden="true">+</span>
            </li>`;
          }).join("");
          listHead.textContent = q ? (filtered.length > 1 ? t("eix_results_pl") : t("eix_results")).replace("{n}", filtered.length) : t("eix_available_contacts");
          listEl.querySelectorAll(".ng-row").forEach((row) => row.addEventListener("click", () => addMember(row.dataset.h)));
        } else if (q && /^[a-z0-9_-]{1,40}$/i.test(q) && !memberSet.has(q)) {
          listEl.innerHTML = `<li class="ng-row ng-row-free" data-h="${esc(q)}" role="option" tabindex="0">
            <span class="ng-av-init" style="background:hsl(${hue(q)} 40% 46%)">?</span>
            <div class="ng-row-body"><span class="ng-row-name">@${esc(q)}</span><span class="ng-row-sub">${t("eix_out_of_contacts")}</span></div>
            <span class="ng-row-add" aria-hidden="true">+</span>
          </li>`;
          listHead.textContent = t("eix_add_this_handle");
          listEl.querySelector(".ng-row-free")?.addEventListener("click", () => addMember(q));
        } else {
          listEl.innerHTML = `<li class="ng-list-empty">${mutualContacts.length ? t("eix_no_available_contact") : t("eix_no_mutual_contact")}</li>`;
          listHead.textContent = "";
        }
      }
      async function addMember(h) {
        if (!h) return;
        try {
          await host.groups.api.addMember(gid, h);
          toast(t("eix_member_added").replace("{handle}", h));
          search.value = "";
          await reload();
        } catch (e) { toast(e.message || t("eix_cannot_add_contact")); }
      }
      search.addEventListener("input", renderList);
      search.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const q = search.value.trim().replace(/^@/, "");
          if (q && /^[a-z0-9_-]{1,40}$/i.test(q)) addMember(q);
        }
      });
      async function reload() {
        try {
          group = await host.groups.api.get(gid);
          renderMembers();
          renderList();
          await refreshGroupsSidebar();
        } catch (e) { membersEl.innerHTML = `<li class="ng-list-empty">${esc(e.message || t("eix_error"))}</li>`; }
      }
      await reload();
      // Ne prend le focus que si le champ d'ajout est réellement visible (admin/owner).
      if (addField && !addField.hidden) search.focus({ preventScroll: true });
    }
    // (handler du bouton ＋ unifié dans setMode/newAction plus haut)
    async function refreshGroupsSidebar() {
      if (!commGroupsList || !host.groups?.api) return;
      try {
        const { groups: gs } = await host.groups.api.list();
        groupsLoaded = true;
        // Badge sur le rail : nombre total de groupes (visuel léger, pas critique).
        const badge = app.querySelector("#comm-rail-groups-badge");
        if (badge) {
          badge.hidden = gs.length === 0;
          badge.textContent = gs.length > 99 ? "99+" : String(gs.length);
        }
        if (!gs.length) {
          commGroupsList.innerHTML =
            `<div class="comm-empty-state"><h3>${t("eix_no_group")}</h3><p>${t("eix_create_first_group")}</p></div>`;
        } else {
          commGroupsList.innerHTML = gs.map((g) => {
            const init = "👥";
            const name = g.name || t("eix_group_unnamed");
            const memberCount = g.members?.length ?? 0;
            const search = (name + " " + (g.members || []).map((m) => m.handle).join(" ")).toLowerCase();
            const roleLabel = g.role === "owner" ? t("eix_role_owner") : g.role === "admin" ? "admin" : t("eix_role_member");
            return `<div class="comm-contact-item comm-group-item" data-gid="${esc(g.id)}" data-search="${esc(search)}">
              <div class="comm-av"><span class="comm-av-init" style="background:hsl(${[...g.id].reduce((h,x)=>(h*31+x.charCodeAt(0))%360,0)} 40% 46%);color:#fff">${init}</span></div>
              <div class="comm-contact-body">
                <div class="comm-contact-name">${esc(name)}</div>
                <div class="comm-contact-sub">${(memberCount > 1 ? t("eix_member_count_pl") : t("eix_member_count")).replace("{n}", memberCount)} · ${esc(roleLabel)}</div>
              </div>
              <div class="comm-contact-meta"></div>
            </div>`;
          }).join("");
          commGroupsList.querySelectorAll(".comm-group-item").forEach((el) =>
            el.addEventListener("click", () => openGroupInline(el.dataset.gid)));
        }
        filterSidebar();
      } catch {
        commGroupsList.innerHTML =
          `<div class="comm-empty-state"><p>${t("eix_groups_load_fail")}</p></div>`;
      }
    }
    app.querySelector("#comm-search")?.addEventListener("input", filterSidebar);
    // Rafraîchit la liste à chaque event SSE « group » (création, ajout, retrait…).
    if (host.connectSSE && host.onSSE) {
      host.connectSSE(appState.key);
      host.onSSE("group", () => refreshGroupsSidebar());
    }
    refreshGroupsSidebar();
  }
  // Boutons dupliqués dans Options (Accès & Sessions + Appareils)
  const wireAlias = (id2, id1) => {
    const b = app.querySelector(id2);
    if (b) b.addEventListener("click", () => app.querySelector(id1)?.click());
  };
  wireAlias("#toggle-key2",       "#toggle-key");
  wireAlias("#rotate-key2",       "#rotate-key");
  wireAlias("#save-rec2",         "#save-rec");
  wireAlias("#logout-btn2",       "#logout-btn");
  wireAlias("#logout-all-btn2",   "#logout-all-btn");
  wireAlias("#e2e-passkey-save2", "#e2e-passkey-save");
  wireAlias("#e2e-pin-save2",     "#e2e-pin-save");
  wireAlias("#e2e-pass-save2",    "#e2e-pass-save");
  wireAlias("#e2e-restore2",      "#e2e-restore");
  wireAlias("#passkey-add2",      "#passkey-add");
  wireAlias("#export-data2",      "#export-data");
  wireAlias("#delete-account2",   "#delete-account");
  // copy-key2 : même clé que copy-key
  app.querySelector("#toggle-key2")?.addEventListener("click", () => {
    const d = app.querySelector("#key-display2");
    const d1 = app.querySelector("#key-display");
    if (d && d1) d.textContent = d1.textContent;
  });
  // email de récupération (champ dupliqué)
  const rec2 = app.querySelector("#rec-email2");
  const rec1 = app.querySelector("#rec-email");
  if (rec2 && rec1) {
    rec2.addEventListener("change", () => { rec1.value = rec2.value; });
  }
  // Visite guidée « Milo » : lanceur manuel + ouverture auto à la 1re connexion.
  app.querySelector("#hm-tour-btn")?.addEventListener("click", () => openMiloTourPicker());
  // Toggle dev : premium PAR UTILISATEUR. Pose/retire une ligne d'abonnement
  // "dev" pour le compte courant côté serveur, puis recharge. Échoue proprement
  // si l'endpoint est désactivé (prod, ou MINDLOG_DEV_PREMIUM absent).
  app.querySelector("#dev-toggle-premium")?.addEventListener("change", async (e) => {
    const on = e.target.checked;
    try {
      await api("/api/dev/premium", { method: on ? "POST" : "DELETE", headers: jsonAuth() });
    } catch (err) {
      e.target.checked = !on;
      toast(err?.message || t("eix_dev_premium_unavailable"));
      return;
    }
    location.reload();
  });

  // Dev : abonnements simulés à des espaces premium d'autres créateurs.
  // Liste, ajout, annulation. Endpoint gardé par DEV_PREMIUM_ENABLED côté serveur.
  const subsList = app.querySelector("#dev-space-subs");
  if (subsList) {
    const refreshSubs = async () => {
      try {
        const r = await api("/api/dev/space-subscriptions", { headers: authHeaders() });
        const active = (r.subscriptions || []).filter((s) => s.status === "active");
        subsList.innerHTML = active.length
          ? active.map((s) =>
              `<li class="opt-dev-sub-row" data-handle="${esc(s.handle)}">
                 <a href="/@${esc(s.handle)}" target="_blank" rel="noopener">@${esc(s.handle)}</a>
                 <span class="lbl-sm">${esc(s.provider || "stripe")}</span>
                 <button type="button" class="btn sm danger" data-dev-sub-cancel>${t("com_cancel")}</button>
               </li>`
            ).join("")
          : `<li class="lbl-sm">${t("eix_no_simulated_sub")}</li>`;
        subsList.querySelectorAll("[data-dev-sub-cancel]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const handle = btn.closest("[data-handle]")?.dataset.handle;
            if (!handle) return;
            try {
              await api(`/api/dev/space-subscription/${encodeURIComponent(handle)}`, {
                method: "DELETE",
                headers: jsonAuth(),
              });
              toast(t("eix_simulated_sub_removed"));
              await refreshSubs();
            } catch (err) { toast(err?.message || t("eix_failed")); }
          });
        });
      } catch {
        subsList.innerHTML = `<li class="lbl-sm">${t("eix_dev_premium_off")}</li>`;
      }
    };
    void refreshSubs();
    app.querySelector("#dev-space-add-btn")?.addEventListener("click", async () => {
      const inp = app.querySelector("#dev-space-add-handle");
      const handle = (inp?.value || "").trim().replace(/^@/, "");
      if (!handle) { toast(t("eix_enter_handle")); return; }
      try {
        await api("/api/dev/space-subscription", {
          method: "POST",
          headers: jsonAuth(),
          body: JSON.stringify({ handle }),
        });
        if (inp) inp.value = "";
        toast(t("eix_simulated_sub_to").replace("{handle}", handle));
        await refreshSubs();
      } catch (err) { toast(err?.message || t("eix_failed")); }
    });
  }

  // Swatches couleur Milo dans l'onglet Options
  app.querySelector("#opt-swatches")?.querySelectorAll(".swatch").forEach((s) =>
    s.addEventListener("click", () => {
      applyAccent(s.dataset.accent);
      try { localStorage.setItem(ACCENT_STORE, s.dataset.accent); } catch {}
    })
  );
  applyAccent(storedAccent() || "#8b8ff5"); // marque le swatch actif

  // Filtre des blocs Options
  app.querySelector("#opt-search")?.addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    app.querySelectorAll("#opt-v2-grid .opt-v2-block").forEach((block) => {
      block.hidden = !!q && !block.textContent.toLowerCase().includes(q);
    });
  });
  if (!localStorage.getItem(TOUR_SEEN_KEY)) {
    // On attend qu'aucun autre overlay (ex. sauvegarde E2E obligatoire à la 1re
    // connexion) ne soit ouvert, pour ne pas empiler les fenêtres modales.
    let tries = 0;
    const tryOpen = () => {
      if (localStorage.getItem(TOUR_SEEN_KEY)) return;
      if (document.querySelector(".overlay") && tries++ < 12) { setTimeout(tryOpen, 1200); return; }
      openMiloTourPicker();
    };
    setTimeout(tryOpen, 1300);
  }

  // Stats + liens "Voir tout" du Compte → navigation par data-goto. « Notifications »
  // est désormais un panneau du Compte (pas une colonne) → on ouvre l'onglet.
  app.querySelectorAll(".hm-stat[data-goto], .hm-section-title a[data-goto], .hm-requests-banner[data-goto]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const label = el.dataset.goto;
      if (label === "Notifications") { goCompteTab("notifs"); return; }
      if (label === "Identité") { goCompteTab("profil"); return; }
      const ci = deckState.cols.findIndex(c => c.dataset.deckLabel === label);
      if (ci >= 0 && deckState.go) deckState.go(ci);
    });
  });

  // Notifications : la cloche mène à la colonne Notifications + marque lues
  const markRead = () => {
    // Tous les compteurs « non lus » : cloche du header, entrée Compte de la nav,
    // ET la pastille du sous-menu « Notifs » (rendue depuis data.unread au montage,
    // sinon elle reste figée sur l'ancien total après « Tout marquer lu »).
    ["#notif-badge", "[data-notif-badge]", '.opt-tab[data-tab="notifs"] .subrail-badge'].forEach((sel) => {
      const badge = app.querySelector(sel) || document.querySelector(sel);
      if (badge) { badge.hidden = true; badge.textContent = ""; }
    });
    const count = app.querySelector("#notif-count");
    if (count) count.textContent = t("eix_zero_unread");
    app.querySelectorAll("#notif-list .notif.unread").forEach((n) => n.classList.remove("unread"));
    api("/api/notifications/read", { method: "POST", headers: authHeaders() }).catch(() => {});
  };
  app.querySelector("#notif-bell")?.addEventListener("click", () => {
    // La cloche du header ouvre le panneau Notifications, désormais intégré au
    // Compte (sous-menu conservé).
    goCompteTab("notifs");
    markRead();
  });
  app.querySelector("#notif-readall")?.addEventListener("click", markRead);

  // Colonne « Menu » : un clic mène à la colonne ciblée (nav par label, robuste
  // aux index dynamiques). Le bouton « ← Menu » ramène à la colonne Menu.
  const deckGoLabel = (label) => {
    const cols = [...document.querySelectorAll("#deck .col")];
    const i = cols.findIndex((c) => c.dataset.deckLabel === label);
    if (i >= 0 && deckState.go) deckState.go(i);
  };
  app.querySelector("#menu-nav")?.addEventListener("click", (e) => {
    // Stoppe la propagation : sinon le handler de clic au niveau colonne (qui
    // « sélectionne une colonne inactive ») se déclenche ensuite, voit l'index
    // du Menu ≠ nouvelle colonne active et nous ramène aussitôt au Menu.
    const goto = e.target.closest("[data-goto]");
    if (goto) { e.stopPropagation(); deckGoLabel(goto.dataset.goto); return; }
    const act = e.target.closest("[data-action]");
    if (act) { e.stopPropagation(); openContactPicker(act.dataset.action); }
  });
  // Aperçu téléphone : « Prendre rendez-vous » (écran Calendrier) → onglet Agenda.
  app.querySelector("#lt-book")?.addEventListener("click", () => deckGoLabel("Agenda"));

  // Sélecteur de contact : tuiles « Discuter » / « Passer un appel » du Menu.
  async function openContactPicker(mode) {
    let relations = data.relations;
    try {
      const fresh = await api("/api/me", { headers: authHeaders() });
      relations = fresh.relations;
      data.relations = relations;
    } catch {}
    const contacts = (relations?.[1] || []).filter((r) => r.mutual);
    const titleTxt = mode === "call" ? t("eix_make_call") : t("eix_chat_verb");
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="panel picker-panel" role="dialog" aria-modal="true" aria-label="${esc(titleTxt)}">
        <button type="button" class="close" id="pick-x" aria-label="${t("com_close")}">✕</button>
        <h2 class="picker-title">${mode === "call" ? icon("camera", 18) : icon("chat", 18)} ${esc(titleTxt)}</h2>
        <p class="sub" style="margin:.1rem 0 .7rem">${t("eix_choose_contact")}</p>
        ${contacts.length > 4 ? `<input type="search" id="pick-search" class="pick-search" placeholder="${t("eix_search_contact_ph")}" autocomplete="off" />` : ""}
        <ul class="picker-list">${
          contacts.length
            ? contacts
                .map(
                  (r) => `<li class="picker-li" data-search="${esc(`${r.display_name || ""} ${r.handle}`.toLowerCase())}"><button type="button" class="picker-item" data-h="${esc(r.handle)}">
                    ${avatarHtml(r.handle, r.has_photo, "av")}
                    <span class="meta"><span class="nm">${esc(r.display_name || r.handle)}</span><span class="hd">@${esc(r.handle)}</span></span>
                    <span class="e2e-dot" title="${r.has_pubkey ? t("eix_e2e_available") : t("eix_e2e_absent")}">${r.has_pubkey ? "🔒" : "🔓"}</span>
                  </button></li>`
                )
                .join("")
            : `<li class="empty">${t("eix_no_mutual_relations")}</li>`
        }<li class="empty pick-none" hidden>${t("eix_no_contact_match")}</li></ul>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => ev.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (ev) => ev.target === overlay && close());
    overlay.querySelector("#pick-x").onclick = close;
    // Filtre live de la liste (affiché dès > 4 contacts).
    const search = overlay.querySelector("#pick-search");
    if (search) {
      const lis = [...overlay.querySelectorAll(".picker-li")];
      const none = overlay.querySelector(".pick-none");
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        lis.forEach((li) => {
          const ok = !q || (li.dataset.search || "").includes(q);
          li.hidden = !ok;
          if (ok) shown++;
        });
        if (none) none.hidden = shown > 0;
      });
      setTimeout(() => search.focus(), 0);
    }
    overlay.querySelectorAll(".picker-item").forEach((b) =>
      b.addEventListener("click", async () => {
        const h = b.dataset.h;
        close();
        if (mode === "chat") return host.chat.open(h, appState.key, data.handle);
        // Appel : récupérer la clé publique du pair avant de lancer la connexion.
        try {
          const d = await api(`/api/identities/${encodeURIComponent(h)}`, { headers: viewerHeaders() });
          if (!d.pubkey) return toast(t("eix_contact_no_calls"));
          if (host.call) host.call.start(h, d.pubkey, { video: false });
        } catch {
          toast(t("eix_cannot_reach_contact"));
        }
      })
    );
  }
  // Clic sur une notif → colonne fermable (jamais de changement d'URL) :
  // message → chat, profil (ex. ajout en relation) → fiche contact.
  // stopPropagation : évite le handler « sélectionner une colonne inactive ».
  app.querySelector("#notif-list")?.addEventListener("click", (e) => {
    const chatB = e.target.closest("[data-chat-notif]");
    if (chatB) { e.stopPropagation(); host.chat.open(chatB.dataset.chatNotif, appState.key, data.handle); return; }
    const relNotifB = e.target.closest("[data-relation-notif]");
    if (relNotifB) {
      e.stopPropagation();
      const h = relNotifB.dataset.relationNotif;
      confirmDialog(t("eix_add_to_relations").replace("{handle}", h), { ok: t("eix_add"), cancel: t("eix_ignore") }).then(async (ok) => {
        if (!ok) return;
        try {
          await api("/api/relations", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...viewerHeaders() },
            body: JSON.stringify({ handle: h, type: "amis" }),
          });
          toast(t("eix_added_to_relations").replace("{handle}", h));
          renderPrivate(appState.key);
        } catch (err) { toast(err.message || t("eix_cannot_add")); }
      });
      return;
    }
    const contactB = e.target.closest("[data-contact-notif]");
    if (contactB) { e.stopPropagation(); openContactColumn(contactB.dataset.contactNotif); }
  });

  // Onglets de la colonne Agenda/RDV
  app.querySelectorAll(".agenda-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      app.querySelectorAll(".agenda-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      const id = tab.dataset.tab;
      app.querySelectorAll(".agenda-panel").forEach((p) => {
        p.hidden = p.id !== `agenda-${id}`;
      });
    });
  });

  // Clic sur une relation. Pour un CONTACT direct (degré 1) on ouvre sa page publique
  // (/@handle, nouvel onglet — l'ancre agit). Pour une identité du réseau étendu
  // (degré 2/3, pas encore reliée), on propose plutôt de l'AJOUTER aux contacts
  // (choix Ami/Pro/Autre) — c'est l'action utile depuis le réseau découvert.
  // Listener posé sur la colonne Relations (recréée à chaque rendu → pas de doublon),
  // stopPropagation pour éviter le handler « sélectionner une colonne inactive ».
  app.querySelector("#rel-tabs")?.closest(".col")?.addEventListener("click", (e) => {
    const link = e.target.closest("a.rel-link");
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.stopPropagation();
    const li = link.closest(".rel");
    const degree = li?.dataset.degree;
    if (degree && degree !== "1") {
      e.preventDefault();
      const handle = decodeURIComponent((link.getAttribute("href") || "").replace(/^\/@/, ""));
      const name = li.querySelector(".nm")?.textContent?.trim() || "";
      if (handle) openAddContactChooser(handle, name);
    }
  });

  // Chips degré + type de la colonne Relations
  app.querySelectorAll("#rel-degree-chips .rel-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      app.querySelectorAll("#rel-degree-chips .rel-chip").forEach((c) => c.classList.toggle("active", c === chip));
      filterRels();
    });
  });
  app.querySelectorAll("#rel-type-chips .rel-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      app.querySelectorAll("#rel-type-chips .rel-chip").forEach((c) => c.classList.toggle("active", c === chip));
      filterRels();
    });
  });
  // Subrail Réseau : Liste · Graphe · Contacts (data-tab). Les panneaux sont rendus
  // d'avance et masqués ; le graphe (réseau radial D1/D2/D3) câble son pan/zoom une
  // seule fois, au premier passage en vue graphe.
  let _relGraphWired = false;
  const relPanes = {
    list: app.querySelector("#rel-list-pane"),
    graph: app.querySelector("#rel-graph-pane"),
    contacts: app.querySelector("#rel-contacts-pane"),
    add: app.querySelector("#rel-add-pane"),
  };
  app.querySelectorAll(".rel-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.tab; // "list" | "graph" | "contacts" | "add"
      app.querySelectorAll(".rel-tab").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      for (const [k, pane] of Object.entries(relPanes)) if (pane) pane.hidden = k !== view;
      if (view === "graph" && !_relGraphWired && relPanes.graph) {
        wireRelationsGraph(relPanes.graph, data);
        _relGraphWired = true;
      }
      if (view === "add") app.querySelector("#rel-add-q")?.focus();
    });
  });
  // Carnet « Contacts » : bouton Discuter → ouvre la conversation 1:1 (le lien
  // « Voir la carte » est une ancre native). Attribut distinct (data-cbook-chat)
  // pour ne pas entrer en collision avec le data-contact-chat de la colonne profil.
  app.querySelectorAll("[data-cbook-chat]").forEach((b) =>
    b.addEventListener("click", () => host.chat.open(b.dataset.cbookChat, appState.key, data.handle))
  );
  // Bannière demandes en attente
  app.querySelector("#rel-pending-toggle")?.addEventListener("click", () => {
    const panel = app.querySelector("#rel-pending-panel");
    const btn = app.querySelector("#rel-pending-toggle");
    if (!panel || !btn) return;
    const expanded = panel.hidden;
    panel.hidden = !expanded;
    btn.setAttribute("aria-expanded", String(expanded));
  });

  // Onglets de la carte Identité (Profil / Réseaux)
  app.querySelectorAll(".id-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      app.querySelectorAll(".id-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      const id = tab.dataset.tab;
      app.querySelectorAll(".id-panel").forEach((p) => {
        p.hidden = p.id !== `id-${id}`;
      });
    });
  });

  // Onglets de la colonne « Mon compte » (Abonnement / Sécurité / Accès / Données)
  app.querySelectorAll(".opt-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      app.querySelectorAll(".opt-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      const id = tab.dataset.tab;
      app.querySelectorAll(".opt-panel").forEach((p) => {
        p.hidden = p.id !== `opt-${id}`;
      });
      // Stockage : chargé paresseusement la première fois qu'on ouvre l'onglet.
      if (id === "stockage") {
        const panel = app.querySelector("#opt-stockage");
        if (panel && !panel.dataset.loaded) {
          panel.dataset.loaded = "1";
          void loadStorageConfig(app);
        }
      }
      // « Mes espaces » : la page premium embarquée est câblée paresseusement au
      // premier affichage (cover, boutons, pages payantes, facturation…).
      if (id === "espaces") {
        const panel = app.querySelector("#opt-espaces");
        if (panel && !panel.dataset.wired) {
          panel.dataset.wired = "1";
          wirePremiumPage(panel, data);
        }
      }
    });
  });

  // Onglets internes du panneau « Activité » du Compte : « Activité récente » /
  // « Journal des actions » (data-acttab → panneau #act-pane-<id>).
  app.querySelectorAll(".act-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      app.querySelectorAll(".act-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      const id = tab.dataset.acttab;
      app.querySelectorAll(".act-tabpanel").forEach((p) => {
        p.hidden = p.id !== `act-pane-${id}`;
      });
    });
  });

  // Sélecteur de langue (Compte → À propos) : applique la langue et re-rend
  // l'app dans la nouvelle langue (les chaînes i18n sont relues au rendu).
  app.querySelector("#lang-select")?.addEventListener("change", (e) => {
    setLangCode(e.target.value);
    renderPrivate(appState.key);
  });

  // Sous-onglets du panneau « Accès » : Lien & clé / Sessions / Appareils.
  // (data-accseg → panneau #acc-seg-<id>). Même mécanique que les onglets Activité.
  app.querySelectorAll(".acc-seg-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      app.querySelectorAll(".acc-seg-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      const id = tab.dataset.accseg;
      app.querySelectorAll(".acc-seg-pane").forEach((p) => {
        p.hidden = p.id !== `acc-seg-${id}`;
      });
    });
  });

  // Stockage : CTA upgrade pour les comptes non-premium.
  app.querySelector("#opt-upgrade-storage")?.addEventListener("click", startCheckout);

  // Abonnement (Mon compte) : « 1 €/mois » démarre l'abonnement ; « Gérer » ouvre
  // la page dédiée « Espace Premium » (facturation + toutes les fonctions premium).
  app.querySelector("#opt-upgrade-btn")?.addEventListener("click", startCheckout);
  // « Gérer » (bandeau premium) → ouvre le panneau « Espaces » du Compte (sous-menu
  // conservé) plutôt que de naviguer vers la page plein écran /me/premium.
  app.querySelector("#opt-portal-btn")?.addEventListener("click", () => app.querySelector('.opt-tab[data-tab="espaces"]')?.click());

  // Journal des actions (Compte › Activité) : rafraîchi en direct quand une
  // entrée arrive (échec appel/chat/live…), et bouton « Vider ».
  const refreshActLog = () => {
    const box = app.querySelector("#act-log");
    if (box) box.innerHTML = activityLogInnerHtml();
  };
  app.querySelector("#act-log-clear")?.addEventListener("click", () => { clearActivityLog(); refreshActLog(); });
  appState._actLogUnsub?.(); // évite l'empilement d'abonnements à chaque re-rendu
  appState._actLogUnsub = onActivityLog(refreshActLog);

  // (L'upload d'avatar de l'ex-en-tête Compte a été retiré : il vit désormais sur
  // l'avatar du panneau Profil — clic sur la photo → #photo-file, géré ci-dessous.)

  // Profil, Notifs et Espaces sont désormais tous des panneaux (.opt-tab) du Compte,
  // gérés par le handler d'onglets ci-dessus — plus aucune navigation à part.

  // Personnalisation Premium : couverture, boutons, pages payantes et facturation
  // vivent désormais sur la page dédiée « Espace Premium » (route /me/premium →
  // renderPremiumFull), câblée par wirePremiumPage. Ici on ne garde que le CTA
  // d'upgrade de l'aperçu téléphone (colonne Identité).
  app.querySelector("#lt-go-premium")?.addEventListener("click", startCheckout);

  // Onglet « Options » : chaque bascule enregistre la préférence immédiatement.
  // « Vidéo » dépend d'« Appels » : on la désactive visuellement si les appels
  // sont coupés (la préférence reste mémorisée, mais sans effet).
  const syncVideoDep = () => {
    const call = app.querySelector('.opt-toggle[data-setting="allow_call"]');
    const video = app.querySelector('.opt-toggle[data-setting="allow_video"]');
    if (call && video) video.closest(".opt-row")?.classList.toggle("disabled", !call.checked);
  };
  syncVideoDep();
  app.querySelectorAll(".opt-toggle[data-setting]").forEach((box) => {
    box.addEventListener("change", async () => {
      const key = box.dataset.setting;
      try {
        await api("/api/me/settings", {
          method: "PATCH",
          headers: jsonAuth(),
          body: JSON.stringify({ [key]: box.checked }),
        });
        if (key === "allow_call") syncVideoDep();
        toast(t("eix_pref_saved"));
      } catch (e) {
        box.checked = !box.checked; // rollback visuel si l'enregistrement échoue
        toast(e.message);
      }
    });
  });

  // Onglet « Options » → Disponibilités générales (jours / week-end / horaires /
  // créneaux / périodes). Tout changement enregistre la règle et rafraîchit le
  // calendrier de l'agenda en place (les jours par défaut suivent la nouvelle règle).
  const availState = normalizeAvailability((data.settings || {}).availability);
  const refreshEditorCalendar = () => {
    host.calendar.setAvailability(availState);
    const fill = app.querySelector(".calendar-fill");
    if (fill && fill.querySelector(".calendar")) {
      const load = dayLoadMap(data);
      fill.innerHTML = host.calendar.html(data.overrides || {}, true, load);
      host.calendar.wire(fill.querySelector(".calendar"), data.overrides || {}, true, data.handle, load);
    }
  };
  const saveAvail = async () => {
    try {
      await api("/api/me/settings", {
        method: "PATCH",
        headers: jsonAuth(),
        body: JSON.stringify({ availability: availState }),
      });
      data.settings = { ...(data.settings || {}), availability: { ...availState } };
      refreshEditorCalendar();
      toast(t("eix_avail_saved"));
    } catch (e) {
      toast(e.message);
    }
  };
  // Jours de la semaine (toggle individuel)
  app.querySelectorAll("#avail-days .avail-day").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.dow);
      availState.weekdays[i] = !availState.weekdays[i];
      b.classList.toggle("on", availState.weekdays[i]);
      b.setAttribute("aria-pressed", String(availState.weekdays[i]));
      const wk = app.querySelector("#avail-weekend");
      if (wk) wk.checked = availState.weekdays[5] && availState.weekdays[6];
      saveAvail();
    })
  );
  // Week-end (sam + dim d'un coup)
  app.querySelector("#avail-weekend")?.addEventListener("change", (e) => {
    const on = e.target.checked;
    availState.weekdays[5] = on;
    availState.weekdays[6] = on;
    app.querySelectorAll("#avail-days .avail-day").forEach((b) => {
      const i = Number(b.dataset.dow);
      if (i === 5 || i === 6) {
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      }
    });
    saveAvail();
  });
  // Horaires + finesse des créneaux
  app.querySelector("#avail-start")?.addEventListener("change", (e) => {
    if (e.target.value) { availState.start = e.target.value; saveAvail(); }
  });
  app.querySelector("#avail-end")?.addEventListener("change", (e) => {
    if (e.target.value) { availState.end = e.target.value; saveAvail(); }
  });
  app.querySelector("#avail-slot")?.addEventListener("change", (e) => {
    availState.slot_minutes = Number(e.target.value);
    saveAvail();
  });
  // Périodes : ajout / suppression
  const wirePeriodDeletes = () =>
    app.querySelectorAll("[data-del-period]").forEach((b) =>
      b.addEventListener("click", () => {
        availState.periods.splice(Number(b.dataset.delPeriod), 1);
        const box = app.querySelector("#avail-periods");
        if (box) box.innerHTML = periodsListHtml(availState.periods);
        wirePeriodDeletes();
        saveAvail();
      })
    );
  wirePeriodDeletes();
  app.querySelector("#ap-add")?.addEventListener("click", () => {
    const fromEl = app.querySelector("#ap-from");
    const toEl = app.querySelector("#ap-to");
    const from = fromEl.value, to = toEl.value;
    if (!from || !to) { toast("Renseignez les deux dates."); return; }
    const [f, t] = from <= to ? [from, to] : [to, from];
    availState.periods.push({ from: f, to: t, free: app.querySelector("#ap-status").value === "free" });
    fromEl.value = ""; toEl.value = "";
    const box = app.querySelector("#avail-periods");
    if (box) box.innerHTML = periodsListHtml(availState.periods);
    wirePeriodDeletes();
    saveAvail();
  });

  // Réseaux sociaux : sauvegarde par champ de carte `social_<net>`.
  app.querySelectorAll(".social-edit").forEach((row) => {
    const netKey = row.dataset.net;
    const net = SOCIAL_BY_KEY[netKey];
    const input = row.querySelector(".social-input");
    const open = row.querySelector(".social-open");
    let saved = input.value;
    const refreshOpen = () => {
      const url = socialUrl(net, input.value);
      if (url) { open.href = url; open.hidden = false; }
      else { open.removeAttribute("href"); open.hidden = true; }
    };
    const save = async () => {
      if (input.value.trim() === saved.trim()) return;
      try {
        await api("/api/card/field", {
          method: "PUT",
          headers: jsonAuth(),
          body: JSON.stringify({
            key: socialFieldKey(netKey),
            label: net.label,
            value: input.value.trim(),
            is_custom: true,
            visibility: "public",
          }),
        });
        saved = input.value;
        refreshOpen();
        toast(t("msg_saved"));
      } catch (e) { toast(e.message); }
    };
    input.addEventListener("input", refreshOpen);
    input.addEventListener("blur", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
  });

  // Onglets de la colonne Compte
  app.querySelectorAll(".acct-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      app.querySelectorAll(".acct-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      const id = tab.dataset.tab;
      app.querySelectorAll(".acct-panel").forEach((p) => {
        p.hidden = p.id !== `acct-${id}`;
      });
    });
  });

  // Compte : email de récupération
  app.querySelector("#save-rec")?.addEventListener("click", async () => {
    await api("/api/recovery-email", {
      method: "PUT",
      headers: jsonAuth(),
      body: JSON.stringify({ email: app.querySelector("#rec-email").value }),
    });
    toast(t("msg_email_saved"));
  });

  // Invitation de contact : génère un jeton à usage unique → QR + lien à partager.
  app.querySelector("#gen-invite")?.addEventListener("click", async () => {
    try {
      const { token } = await api("/api/invites", { method: "POST", headers: jsonAuth(), body: "{}" });
      openQR(`${location.origin}/i/${token}`, t("eix_contact_invitation"));
    } catch (e) {
      toast(e.message || t("er_fail"));
    }
  });
  app.querySelector("#open-groups")?.addEventListener("click", () => host.chat.openGroups(myKey(), myHandle()));

  // Passkeys
  async function refreshPasskeyList() {
    const list = app.querySelector("#passkey-list");
    if (!list) return;
    try {
      const passkeys = await api("/api/passkeys", { headers: authHeaders() });
      if (!passkeys.length) {
        list.innerHTML = `<p class="lbl-sm" style="color:var(--fg-muted)">${t("eix_no_passkey")}</p>`;
        return;
      }
      list.innerHTML = passkeys.map((p) => `
        <div class="passkey-row" data-pk-id="${esc(p.id)}">
          <span class="passkey-icon">${icon("shield", 16)}</span>
          <span class="passkey-name">${esc(p.name)}</span>
          <span class="passkey-meta">${p.backedUp ? t("eix_synced") : t("eix_this_device")} · ${new Date(p.createdAt).toLocaleDateString()}</span>
          <button class="btn sm danger passkey-del" data-pk-id="${esc(p.id)}" title="${t("com_delete")}">✕</button>
        </div>`).join("");
      list.querySelectorAll(".passkey-del").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!await confirmDialog(t("eix_delete_passkey_confirm"), { ok: t("com_delete"), danger: true })) return;
          await api(`/api/passkeys/${encodeURIComponent(b.dataset.pkId)}`, { method: "DELETE", headers: authHeaders() });
          refreshPasskeyList();
        })
      );
    } catch {}
  }
  refreshPasskeyList();

  app.querySelector("#passkey-add")?.addEventListener("click", async () => {
    if (!window.PublicKeyCredential) return toast(t("eix_passkey_unsupported"));
    const name = app.querySelector("#passkey-name").value.trim() || "Passkey";
    try {
      // 1. Obtenir les options du serveur
      const options = await api("/api/passkeys/register/begin", {
        method: "POST", headers: jsonAuth(), body: JSON.stringify({ name }),
      });
      // 2. Créer la credential dans le navigateur
      const { startRegistration } = await import("https://unpkg.com/@simplewebauthn/browser@13/esm/index.js");
      const response = await startRegistration({ optionsJSON: options });
      // 3. Envoyer au serveur pour vérification
      await api("/api/passkeys/register/finish", {
        method: "POST", headers: jsonAuth(), body: JSON.stringify({ name, response }),
      });
      app.querySelector("#passkey-name").value = "";
      toast(t("eix_passkey_saved"));
      refreshPasskeyList();
    } catch (e) {
      if (e.name !== "NotAllowedError") toast(e.message || t("eix_registration_cancelled"));
    }
  });

  // Chiffrement des messages : coffre de clé portable (passkey PRF / PIN / passphrase).
  async function refreshVaultStatus() {
    const { vault: vaultStr } = await e2eVaultGet(appState.key);
    const v = vaultStr ? JSON.parse(vaultStr) : null;
    const parts = [];
    if (v?.prf) parts.push("passkey");
    if (v?.pin) parts.push(t("eix_pin_method"));
    if (v?.pass) parts.push("passphrase");
    const hasVault = parts.length > 0;
    // Garder l'état cohérent pour les prochains rendus de la même session.
    data.hasVault = hasVault;

    // Compte (Identité) : texte court.
    const el = app.querySelector("#e2e-vault-status");
    if (el) {
      el.textContent = hasVault ? t("eix_backed_up_parts").replace("{parts}", parts.join(" + ")) : t("eix_not_backed_up");
      el.style.color = hasVault ? "var(--success)" : "var(--muted)";
    }

    // Options › Sécurité : bandeau de statut + libellé du bouton de sauvegarde.
    const banner = app.querySelector("#opt-vault-banner");
    if (banner) {
      banner.classList.toggle("ok", hasVault);
      banner.classList.toggle("warn", !hasVault);
      banner.innerHTML = `${icon(hasVault ? "shield" : "key", 20)}
        <div>
          <b>${hasVault ? t("eix_key_in_vault") : t("eix_no_key_backup")}</b>
          <p>${hasVault ? t("eix_vault_protected") : t("eix_vault_warn")}</p>
        </div>`;
    }
    const backupBtn = app.querySelector("#opt-e2e-backup");
    if (backupBtn) backupBtn.innerHTML = `${icon("download", 14)} ${hasVault ? t("eix_update_vault") : t("eix_quick_backup")}`;

    // Accueil : badge « E2E activé » / « Sans coffre ».
    const badges = app.querySelector("#hm-vault-badges");
    if (badges) badges.innerHTML = hasVault
      ? `<span class="hm-badge vault">${icon("lock", 11)} ${t("eix_e2e_on")}</span>`
      : `<span class="hm-badge secret">${icon("lock", 11)} ${t("eix_no_vault")}</span>`;
  }
  refreshVaultStatus();

  app.querySelector("#e2e-passkey-save")?.addEventListener("click", async () => {
    try {
      await ensureE2E(data.handle, appState.key);
      await e2eSaveVault(data.handle, appState.key, "passkey");
      toast(t("eix_key_saved_passkey"));
      refreshVaultStatus();
    } catch (e) {
      if (e.name !== "NotAllowedError") toast(e.message || t("er_fail"));
    }
  });
  app.querySelector("#e2e-pin-save")?.addEventListener("click", async () => {
    const pin = await promptPin(t("eix_choose_pin"), { confirm: true });
    if (!pin) return;
    try {
      await ensureE2E(data.handle, appState.key);
      await e2eSaveVault(data.handle, appState.key, "pin", pin);
      toast(t("eix_key_saved_pin"));
      refreshVaultStatus();
    } catch (e) {
      toast(e.message || t("er_fail"));
    }
  });
  app.querySelector("#e2e-pass-save")?.addEventListener("click", async () => {
    const pass = await promptPassphrase(t("eix_define_passphrase"), { generate: true });
    if (!pass) return;
    try {
      await ensureE2E(data.handle, appState.key);
      await e2eSaveVault(data.handle, appState.key, "passphrase", pass);
      toast(t("eix_key_saved_passphrase"));
      refreshVaultStatus();
    } catch (e) {
      toast(e.message || t("er_fail"));
    }
  });
  app.querySelector("#e2e-restore")?.addEventListener("click", () =>
    openE2eRestore(data.handle, appState.key, refreshVaultStatus)
  );

  // Colonne Compte — clé d'accès
  let keyVisible = false;
  app.querySelector("#toggle-key")?.addEventListener("click", () => {
    keyVisible = !keyVisible;
    app.querySelector("#key-display").textContent = keyVisible ? appState.key : "••••••••••••";
    app.querySelector("#toggle-key").innerHTML = `${icon("key",13)} ${keyVisible ? t("eix_hide") : t("eix_show")}`;
  });

  // Nettoie tout état local de connexion (session, indice, ancienne clé).
  const clearLocalAuth = () => {
    setSessionHint(false);
    setStoredKey(null);
    setStoredHandle(null);
    appState.auth = null;
    appState.authPromise = null;
  };

  app.querySelector("#logout-btn")?.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST", headers: jsonAuth() });
    } catch {}
    clearLocalAuth();
    location.assign("/");
  });

  app.querySelector("#logout-all-btn")?.addEventListener("click", async () => {
    if (!(await confirmDialog(t("eix_logout_all_confirm"), { ok: t("eix_logout_all"), danger: true }))) return;
    try {
      await api("/api/auth/logout-all", { method: "POST", headers: jsonAuth() });
    } catch {}
    clearLocalAuth();
    location.assign("/");
  });

  // Code PIN d'appairage : génère un code à 6 chiffres à saisir sur le mobile.
  let pinTimer = null;
  // Génère un PIN d'appairage et l'affiche dans le couple display/hint fourni.
  // Deux emplacements existent (panneau Compte legacy masqué + onglet Accès v2),
  // chacun avec ses propres éléments — d'où le paramétrage plutôt qu'un alias.
  async function genPinInto(btn, display, hint) {
    if (!btn || !display) return;
    btn.disabled = true;
    try {
      const { pin, expiresAt } = await api("/api/auth/pin", { method: "POST", headers: jsonAuth() });
      display.textContent = pin.replace(/(\d{3})(\d{3})/, "$1 $2");
      display.hidden = false;
      if (hint) hint.hidden = false;
      if (pinTimer) clearInterval(pinTimer);
      const tick = () => {
        const left = Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 1000));
        if (left <= 0) {
          clearInterval(pinTimer);
          pinTimer = null;
          display.hidden = true;
          if (hint) hint.textContent = t("eix_code_expired");
        } else {
          const m = Math.floor(left / 60), s = String(left % 60).padStart(2, "0");
          if (hint) hint.textContent = t("eix_pin_expires").replace("{m}", m).replace("{s}", s);
        }
      };
      tick();
      pinTimer = setInterval(tick, 1000);
    } catch (e) {
      if (hint) { hint.hidden = false; hint.textContent = e.message || t("eix_code_gen_fail"); }
      else toast(e.message || t("eix_code_gen_fail"));
    } finally {
      btn.disabled = false;
    }
  }
  app.querySelector("#gen-pin-btn")?.addEventListener("click", () =>
    genPinInto(app.querySelector("#gen-pin-btn"), app.querySelector("#pin-display"), app.querySelector("#pin-hint")));
  app.querySelector("#gen-pin-btn2")?.addEventListener("click", () =>
    genPinInto(app.querySelector("#gen-pin-btn2"), app.querySelector("#pin-display2"), app.querySelector("#pin-hint2")));

  // Liste des sessions/appareils actifs, avec révocation individuelle.
  // Cible le panneau Accès vivant (#sessions-list2) ; #sessions-list appartenait
  // à l'ancien panneau id-compte (mort, display:none).
  async function refreshSessions() {
    const box = app.querySelector("#sessions-list2");
    if (!box) return;
    try {
      const { sessions } = await api("/api/sessions", { headers: authHeaders() });
      if (!sessions.length) {
        box.innerHTML = `<p class="lbl-sm">${t("eix_no_active_session")}</p>`;
        return;
      }
      box.innerHTML = sessions
        .map((s) => {
          const when = new Date(s.lastSeen + "Z");
          const ua = (s.userAgent || t("eix_unknown_device")).slice(0, 60);
          return `<div class="session-row" data-sid="${esc(s.id)}" style="display:flex;align-items:center;gap:.5rem;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid var(--line)">
            <span class="lbl-sm" style="flex:1">${esc(ua)}${s.current ? ` · <strong>${t("eix_this_device")}</strong>` : ""}<br><span style="opacity:.7">${t("eix_seen").replace("{when}", isNaN(when) ? "" : when.toLocaleString())}</span></span>
            ${s.current ? "" : `<button class="btn sm danger session-revoke" data-sid="${esc(s.id)}" title="${t("eix_revoke")}">✕</button>`}
          </div>`;
        })
        .join("");
      box.querySelectorAll(".session-revoke").forEach((b) =>
        b.addEventListener("click", async () => {
          await api(`/api/sessions/${encodeURIComponent(b.dataset.sid)}`, { method: "DELETE", headers: authHeaders() });
          refreshSessions();
        })
      );
    } catch {
      box.innerHTML = `<p class="lbl-sm">${t("eix_sessions_unavailable")}</p>`;
    }
  }
  refreshSessions();

  // Multi-appareils : liste des appareils chiffrés, approbation des appareils en
  // attente (réservée à un appareil déjà approuvé) et révocation.
  // Expose au module pour le handler SSE "device" (hors-portée de renderPrivate).
  // Popup d'approbation d'un nouvel appareil : affichée sur un appareil DÉJÀ
  // approuvé dès qu'un appareil en attente apparaît (au démarrage ou en direct via
  // SSE) → on approuve/refuse directement, sans passer par une simple notification.
  function showDeviceApprovalModal(pending, hdr) {
    if (!pending.length || document.querySelector("#dev-approve-overlay")) return;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "dev-approve-overlay";
    overlay.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true" style="max-width:440px">
        <button type="button" class="close" id="dev-approve-x" aria-label="${t("com_close")}">✕</button>
        <h2>${icon("shield", 18)} ${t("eix_new_device")}</h2>
        <p class="sub">${t("eix_new_device_desc")}</p>
        <div class="dev-approve-list">
          ${pending.map((d) => `<div class="dev-approve-row" data-pk="${d.id}">
            <span class="dev-approve-name">${icon("user", 14)} ${esc(d.name || t("eix_device_default"))}</span>
            <span class="dev-approve-actions">
              <button type="button" class="btn sm primary" data-approve>${t("eix_approve")}</button>
              <button type="button" class="btn sm danger" data-reject>${t("eix_refuse")}</button>
            </span>
          </div>`).join("")}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector("#dev-approve-x").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const done = (row) => { row.remove(); if (!overlay.querySelector(".dev-approve-row")) close(); appState.refreshDevices?.(); };
    overlay.querySelectorAll(".dev-approve-row").forEach((row) => {
      const pk = row.dataset.pk;
      row.querySelector("[data-approve]").addEventListener("click", async () => {
        try { await api(`/api/devices/${encodeURIComponent(pk)}/approve`, { method: "POST", headers: hdr }); toast?.(t("eix_device_approved")); }
        catch (e) { toast?.(e.message || t("eix_approve_fail")); }
        done(row);
      });
      row.querySelector("[data-reject]").addEventListener("click", async () => {
        try { await api(`/api/devices/${encodeURIComponent(pk)}`, { method: "DELETE", headers: hdr }); toast?.(t("eix_device_refused")); }
        catch (e) { toast?.(e.message || t("er_fail")); }
        done(row);
      });
    });
  }

  appState.refreshDevices = async function () {
    const myDid = mdDeviceId();
    const hdr = { ...authHeaders(), "x-device-id": myDid };
    const box = app.querySelector("#devices-list");
    let devices;
    try {
      ({ devices } = await api("/api/devices", { headers: hdr }));
    } catch {
      if (box) box.innerHTML = `<p class="lbl-sm">${t("eix_devices_unavailable")}</p>`;
      return;
    }
    devices = devices || [];
    const iAmApproved = devices.some((d) => d.deviceId === myDid && d.approved);
    // Popup d'approbation (seul un appareil approuvé peut approuver les autres).
    if (iAmApproved) {
      const pending = devices.filter((d) => d.deviceId !== myDid && !d.approved);
      if (pending.length) showDeviceApprovalModal(pending, hdr);
    }
    if (!box) return; // panneau Accès non monté : on a quand même pu lever la popup
    if (!devices.length) { box.innerHTML = `<p class="lbl-sm">${t("eix_no_device")}</p>`; return; }
    {
      box.innerHTML = devices
        .map((d) => {
          const isMe = d.deviceId === myDid;
          const badge = d.approved
            ? `<span class="badge-sm" style="color:var(--success)">${t("eix_approved_badge")}</span>`
            : `<span class="badge-sm" style="color:var(--accent-ink)">${t("eix_pending_badge")}</span>`;
          let actions = "";
          if (isMe) {
            // On ne peut pas auto-approuver l'appareil courant (l'approbation doit
            // venir d'un appareil DÉJÀ actif). S'il est en attente, on l'explique.
            actions = d.approved
              ? `<strong class="lbl-sm">${t("eix_this_device")}</strong>`
              : `<strong class="lbl-sm">${t("eix_this_device")}</strong> <span class="lbl-sm" style="opacity:.7">${t("eix_approve_from_active")}</span>`;
          } else {
            if (!d.approved && iAmApproved) actions += `<button class="btn sm device-approve" data-pk="${d.id}">${t("eix_approve")}</button>`;
            actions += `<button class="btn sm danger device-revoke" data-pk="${d.id}" title="${t("eix_revoke")}">✕</button>`;
          }
          return `<div class="session-row" style="display:flex;align-items:center;gap:.5rem;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid var(--line)">
            <span class="lbl-sm" style="flex:1">${esc(d.name || t("eix_device_default"))} ${badge}</span>
            <span style="display:flex;gap:.35rem;align-items:center">${actions}</span>
          </div>`;
        })
        .join("");
      box.querySelectorAll(".device-approve").forEach((b) =>
        b.addEventListener("click", async () => {
          try {
            await api(`/api/devices/${encodeURIComponent(b.dataset.pk)}/approve`, { method: "POST", headers: hdr });
            toast?.(t("eix_device_approved"));
          } catch (e) {
            toast?.(e.message || t("eix_approve_fail"));
          }
          appState.refreshDevices();
        })
      );
      box.querySelectorAll(".device-revoke").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!(await confirmDialog(t("eix_revoke_device_confirm"), { ok: t("eix_revoke"), danger: true }))) return;
          try {
            await api(`/api/devices/${encodeURIComponent(b.dataset.pk)}`, { method: "DELETE", headers: hdr });
          } catch (e) {
            toast?.(e.message || t("er_fail"));
          }
          appState.refreshDevices();
        })
      );
    }
  };
  appState.refreshDevices();

  app.querySelector("#rotate-key")?.addEventListener("click", async () => {
    if (!(await confirmDialog(t("eix_rotate_key_confirm"), { ok: t("eix_regenerate"), danger: true }))) return;
    // Le serveur révoque toutes les sessions et en rouvre une (cookie) pour cet appareil.
    await api("/api/access-key/rotate", { method: "POST", headers: authHeaders() });
    setStoredKey(null); // l'ancienne clé éventuellement mémorisée n'est plus valable
    setSessionHint(true);
    appState.auth = null;
    appState.authPromise = null;
    toast(t("eix_key_regenerated"));
    // Recharge l'espace via la session cookie rafraîchie (récupère la nouvelle clé).
    location.assign("/me");
  });

  // Copie clé / URL publique depuis la colonne Compte
  app.querySelectorAll(".url-row .copy, #copy-key").forEach((b) =>
    b.addEventListener("click", () => {
      copyText(b.dataset.copy);
      toast(t("msg_copied"));
    })
  );

  // Export RGPD
  app.querySelector("#export-data")?.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = `/api/me/export`;
    a.setAttribute("download", `mindlog-${data.handle}.json`);
    a.style.display = "none";
    // Passe la clé d'accès en header — contournement via fetch + blob
    api("/api/me/export", { headers: authHeaders() })
      .then((raw) => {
        // api() parse le JSON, on re-stringifie pour le téléchargement
        const blob = new Blob([JSON.stringify(raw, null, 2)], { type: "application/json" });
        a.href = URL.createObjectURL(blob);
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => toast(e.message));
  });

  // Suppression définitive du compte (RGPD)
  app.querySelector("#delete-account")?.addEventListener("click", async () => {
    if (!(await confirmDialog(
      t("eix_delete_account_confirm").replace("{handle}", data.handle),
      { ok: t("com_delete"), danger: true }
    ))) return;
    try {
      await api("/api/me", { method: "DELETE", headers: authHeaders() });
      // Nettoie le localStorage puis redirige vers la landing
      if (storedHandle() === data.handle) { setStoredKey(null); setStoredHandle(null); }
      toast(t("eix_account_deleted"));
      setTimeout(() => location.assign("/"), 1200);
    } catch (e) {
      toast(e.message);
    }
  });

  // Réseau → « Ajouter » : recherche annuaire (/api/search) → cartes résultat avec
  // choix du type (Ami/Pro/Autre) + bouton Relier par personne. Remplace l'ancien
  // champ « + Relier » étriqué et la recherche du header (retirée).
  {
    const addQ = app.querySelector("#rel-add-q");
    const addResults = app.querySelector("#rel-add-results");
    // Handles déjà reliés (degré 1) + soi-même → on n'affiche pas de bouton Relier.
    const linked = new Set([data.handle, ...((data.relations?.[1] || []).map((r) => r.handle))]);
    let addTimer;

    const renderAddResults = (list) => {
      if (!addResults) return;
      if (!list || !list.length) {
        addResults.innerHTML = `<p class="empty" style="text-align:center;padding:1rem 0;opacity:.7">${t("eix_no_result")}</p>`;
        return;
      }
      addResults.innerHTML = list.map((r) => {
        const initials = (r.name || r.handle).slice(0, 2).toUpperCase();
        const av = r.photo
          ? `<img class="av" src="${esc(r.photo)}" alt="" loading="lazy" />`
          : `<span class="av">${esc(initials)}</span>`;
        const isSelf = r.handle === data.handle;
        const already = linked.has(r.handle);
        return `<div class="rel-add-card" data-handle="${esc(r.handle)}">
          <a class="contact-av-link" href="/@${encodeURIComponent(r.handle)}" target="_blank" rel="noopener noreferrer">${av}</a>
          <div class="contact-info">
            <div class="contact-name">${esc(r.name || r.handle)}</div>
            <div class="contact-handle">@${esc(r.handle)}</div>
          </div>
          <div class="rel-add-actions">
            ${isSelf ? `<span class="rel-add-done">${t("eix_you")}</span>`
              : already ? `<span class="rel-add-done">${t("eix_added_check")}</span>`
              : `<select class="rel-add-type" aria-label="${t("eix_link_type")}">
                   <option value="amis">${t("eix_type_friend")}</option><option value="pro">${t("eix_type_pro")}</option><option value="autre">${t("eix_type_other")}</option>
                 </select>
                 <button type="button" class="btn sm primary rel-add-btn">${t("eix_add")}</button>`}
          </div>
        </div>`;
      }).join("");
    };

    const search = async () => {
      const q = addQ.value.trim();
      if (!q) {
        addResults.innerHTML = `<p class="empty" style="text-align:center;padding:1rem 0;opacity:.7">${t("eix_search_prompt")}</p>`;
        return;
      }
      try {
        const { results: list } = await api(`/api/search?q=${encodeURIComponent(q)}`);
        renderAddResults(list);
      } catch { /* silencieux */ }
    };

    addQ?.addEventListener("input", () => { clearTimeout(addTimer); addTimer = setTimeout(search, 200); });
    addQ?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(addTimer); search(); } });

    addResults?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".rel-add-btn");
      if (!btn) return;
      const card = btn.closest(".rel-add-card");
      const handle = card?.dataset.handle;
      const type = card?.querySelector(".rel-add-type")?.value || "amis";
      if (!handle) return;
      // État d'attente : l'ajout fait un POST puis un re-rendu complet (≈ qqs
      // centaines de ms) → spinner + libellé « Ajout… » pour un retour immédiat.
      btn.disabled = true;
      btn.classList.add("is-loading");
      const prevLabel = btn.innerHTML;
      btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${t("eix_adding")}`;
      const q = addQ?.value || "";
      try {
        await api("/api/relations", { method: "POST", headers: jsonAuth(), body: JSON.stringify({ handle, type }) });
        toast(t("eix_contact_added"));
        // Re-render complet depuis le serveur → le nouveau contact apparaît aussitôt
        // dans Contacts/Liste/Graphe (plus besoin de recharger la page). renderEditor
        // (et non renderPrivate) évite le flash « Chargement… ». On restaure ensuite la
        // vue Réseau → Ajouter et on relance la recherche (le contact ajouté s'y affiche
        // alors « ✓ Ajouté »), pour pouvoir enchaîner les ajouts sans perdre sa place.
        const fresh = await api("/api/me", { headers: authHeaders() });
        appState.myRelations = fresh?.relations?.[1] || [];
        renderEditor(fresh);
        window.__deckGoLabel?.("Relations");
        document.querySelector('.rel-tab[data-tab="add"]')?.click();
        const q2 = document.querySelector("#rel-add-q");
        if (q2 && q) { q2.value = q; q2.dispatchEvent(new Event("input")); }
      } catch (err) {
        // Échec → on restaure le bouton (le succès, lui, re-rend tout le deck).
        btn.disabled = false;
        btn.classList.remove("is-loading");
        btn.innerHTML = prevLabel;
        toast(err?.message || t("eix_failed"));
      }
    });
  }
  app.querySelectorAll("[data-del-rel]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/relations/${encodeURIComponent(b.dataset.delRel)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      renderPrivate(appState.key);
    })
  );

  // Réciprocité : ajouter en retour une relation reçue (→ devient un contact)
  app.querySelectorAll("[data-recip]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api("/api/relations", {
          method: "POST",
          headers: jsonAuth(),
          body: JSON.stringify({ handle: b.dataset.recip, type: "amis" }),
        });
        toast(t("msg_relation_validated"));
        renderPrivate(appState.key);
      } catch (e) {
        toast(e.message);
      }
    })
  );

  // Recherche + chips degré/type des relations
  const relSearch = app.querySelector("#rel-search");
  const filterRels = () => {
    const q = (relSearch?.value || "").trim().toLowerCase();
    const activeDeg = app.querySelector("#rel-degree-chips .rel-chip.active")?.dataset.degree ?? "";
    const activeType = app.querySelector("#rel-type-chips .rel-chip.active")?.dataset.reltype ?? "";
    let anyVisible = false;
    app.querySelectorAll("#rel-all-list .rel").forEach((li) => {
      const okText = !q || (li.dataset.search || "").includes(q);
      const okDeg = !activeDeg || li.dataset.degree === activeDeg;
      const okType = !activeType || li.dataset.type === activeType;
      const show = okText && okDeg && okType;
      li.style.display = show ? "" : "none";
      if (show) anyVisible = true;
    });
    // Hide degree separators when all their items are hidden
    app.querySelectorAll("#rel-all-list .rel-deg-sep").forEach((sep) => {
      const d = sep.dataset.degree;
      const hasVisible = [...app.querySelectorAll(`#rel-all-list .rel[data-degree="${d}"]`)].some(
        (li) => li.style.display !== "none"
      );
      sep.hidden = !hasVisible;
    });
    // Show "no results" message
    const noRes = app.querySelector("#rel-no-results");
    if (noRes) noRes.hidden = anyVisible || !q && !activeDeg && !activeType;
  };
  relSearch?.addEventListener("input", filterRels);

  // Demandes de RDV : statut, suppression, filtre — tout en place (pas de reload,
  // on reste sur l'onglet RDV actif).
  const reqList = app.querySelector("ul.requests");
  const STATUS_BADGE = { accepted: ["ok", t("eix_status_accepted")], declined: ["no", t("eix_status_declined")], pending: ["pending", t("eix_status_pending")] };
  const activeReqFilter = () =>
    app.querySelector("[data-req-filter].active")?.dataset.reqFilter || "pending";
  const applyReqFilter = (val) => {
    app.querySelectorAll("li.request").forEach((li) => {
      li.style.display = val === "all" || li.dataset.status === val ? "" : "none";
    });
  };
  // Recompte les puces depuis le DOM et réaffiche l'état vide si besoin.
  const refreshReqChips = () => {
    const lis = [...app.querySelectorAll("li.request")];
    const n = { all: lis.length, pending: 0, accepted: 0, declined: 0 };
    lis.forEach((li) => { n[li.dataset.status] = (n[li.dataset.status] || 0) + 1; });
    app.querySelectorAll("[data-req-filter]").forEach((chip) => {
      const span = chip.querySelector(".chip-n");
      if (span) span.textContent = n[chip.dataset.reqFilter] ?? 0;
    });
    const empty = reqList?.querySelector("li.empty");
    if (!lis.length && reqList && !empty) reqList.innerHTML = `<li class="empty">${t("eix_no_requests")}</li>`;
    applyReqFilter(activeReqFilter());
  };

  // Un RDV traité n'est plus « en attente » : on répercute le nouveau statut sur
  // la donnée en cache (data.requests / data.pending) pour que la bannière
  // « en attente de réponse » et le badge Agenda restent justes sur les autres
  // onglets (rendus depuis ce même cache), sans reload.
  const syncPending = () => {
    const p = (data.requests || []).filter((r) => r.status === "pending").length;
    data.pending = p;
    document.querySelectorAll("[data-agenda-badge]").forEach((el) => {
      if (p) { el.textContent = p > 99 ? "99+" : String(p); el.hidden = false; }
      else { el.textContent = ""; el.hidden = true; }
    });
  };

  const setStatus = async (id, status, btn) => {
    await api(`/api/requests/${id}`, { method: "PATCH", headers: jsonAuth(), body: JSON.stringify({ status }) });
    const li = btn.closest("li.request");
    if (li) {
      li.dataset.status = status;
      const badge = li.querySelector(".req-status");
      const [cls, label] = STATUS_BADGE[status] || STATUS_BADGE.pending;
      if (badge) { badge.className = `req-status ${cls}`; badge.textContent = label; }
      // Une demande traitée ne propose plus Accepter/Refuser (seul le ✕ reste).
      li.querySelectorAll("[data-req-accept],[data-req-decline]").forEach((el) => el.remove());
    }
    const rec = (data.requests || []).find((r) => String(r.id) === String(id));
    if (rec) rec.status = status;
    syncPending();
    refreshReqChips();
    toast(status === "accepted" ? t("eix_request_accepted") : t("eix_request_declined"));
  };
  app.querySelectorAll("[data-req-accept]").forEach((b) =>
    b.addEventListener("click", () => setStatus(b.dataset.reqAccept, "accepted", b))
  );
  app.querySelectorAll("[data-req-decline]").forEach((b) =>
    b.addEventListener("click", () => setStatus(b.dataset.reqDecline, "declined", b))
  );
  app.querySelectorAll("[data-req-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/requests/${b.dataset.reqDel}`, { method: "DELETE", headers: authHeaders() });
      b.closest("li.request")?.remove();
      data.requests = (data.requests || []).filter((r) => String(r.id) !== String(b.dataset.reqDel));
      syncPending();
      refreshReqChips();
      toast(t("eix_request_deleted"));
    })
  );

  // Filtre par statut (client) : « En attente » actif par défaut.
  const reqChips = app.querySelectorAll("[data-req-filter]");
  reqChips.forEach((chip) =>
    chip.addEventListener("click", () => {
      reqChips.forEach((c) => c.classList.toggle("active", c === chip));
      applyReqFilter(chip.dataset.reqFilter);
    })
  );
  if (app.querySelector("li.request")) applyReqFilter("pending");

  renderPrivateFooter(data);
}

export function renderPrivateFooter(data) {
  footer.innerHTML = `<p style="margin:.4rem 0"><span class="mobile-hide">${CREDIT()} · </span><a href="${esc(data.publicUrl)}" target="_blank" rel="noopener">${t("eix_view_my_page")} ↗</a></p>`;
}

// ISO → valeur d'un <input type="datetime-local"> (heure LOCALE, sans secondes).
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Modale composer d'événement (création ou édition), inspirée du « New meeting »
// de Teams : titre, créneau début/fin, lieu, lien, notes, visibilité publique.
// `event` null → création (POST /api/agenda) ; sinon édition (PUT /api/agenda/:id).
// opts.liveAvailable : affiche le sélecteur « Événement / Live » (créateur premium
// avec bénéfice lives activé). Un live planifié est visible par tous mais
// joignable uniquement par les abonné·e·s de l'espace premium.
// Sélecteur d'ajout de contact depuis le réseau étendu (degré 2/3). Modale stylée
// (pas de popup navigateur) : choix du type de lien (Ami/Pro/Autre) puis POST, et
// rafraîchissement complet pour que le contact apparaisse aussitôt dans tous les onglets.
function openAddContactChooser(handle, name) {
  const overlay = document.createElement("div");
  overlay.className = "overlay open";
  overlay.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true" aria-label="${t("eix_add_contact")}" style="max-width:380px">
      <button type="button" class="close" id="ac-close" aria-label="${t("com_close")}">✕</button>
      <h2 style="margin:0 0 .15rem">${t("eix_add_as_contact")}</h2>
      <p class="sub" style="margin:0 0 1rem">${esc(name || ("@" + handle))} <span class="lbl-sm" style="opacity:.7">@${esc(handle)}</span></p>
      <p class="lbl-sm" style="margin:0 0 .5rem">${t("eix_link_type_label")}</p>
      <div class="ac-types" style="display:flex;gap:.5rem;margin-bottom:1rem">
        <button type="button" class="btn" data-actype="amis" style="flex:1">${t("eix_type_friend")}</button>
        <button type="button" class="btn" data-actype="pro" style="flex:1">${t("eix_type_pro")}</button>
        <button type="button" class="btn" data-actype="autre" style="flex:1">${t("eix_type_other")}</button>
      </div>
      <div class="err" id="ac-err"></div>
      <div class="actions">
        <a class="btn sm" href="/@${encodeURIComponent(handle)}" target="_blank" rel="noopener noreferrer">${icon("link", 13)} ${t("eix_view_page")}</a>
        <button type="button" class="btn" id="ac-cancel">${t("com_cancel")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#ac-close").addEventListener("click", close);
  overlay.querySelector("#ac-cancel").addEventListener("click", close);
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  overlay.querySelectorAll("[data-actype]").forEach((b) =>
    b.addEventListener("click", async () => {
      overlay.querySelectorAll("[data-actype]").forEach((x) => (x.disabled = true));
      try {
        await api("/api/relations", { method: "POST", headers: jsonAuth(), body: JSON.stringify({ handle, type: b.dataset.actype }) });
        close();
        toast(t("eix_contact_added"));
        // Re-render depuis le serveur → le contact passe en degré 1 et apparaît dans
        // Contacts/Liste/Graphe sans recharger. On revient sur Réseau → Liste.
        const fresh = await api("/api/me", { headers: authHeaders() });
        appState.myRelations = fresh?.relations?.[1] || [];
        renderEditor(fresh);
        window.__deckGoLabel?.("Relations");
        document.querySelector('.rel-tab[data-tab="list"]')?.click();
      } catch (err) {
        overlay.querySelectorAll("[data-actype]").forEach((x) => (x.disabled = false));
        const el = overlay.querySelector("#ac-err");
        if (el) el.textContent = err?.message || t("eix_add_fail");
      }
    }));
}

// Vue LECTURE SEULE d'un événement reçu par invitation (jointure virtuelle : il
// appartient à l'organisateur, on n'autorise ni édition ni suppression chez l'invité).
function openInvitedEventView(event) {
  const overlay = document.createElement("div");
  overlay.className = "overlay open";
  const fmt = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short" }); };
  const row = (label, val) => (val ? `<div class="group"><label>${label}</label><div>${esc(val)}</div></div>` : "");
  overlay.innerHTML = `
    <div class="panel ev-modal" role="dialog" aria-modal="true" aria-label="${t("eix_event")}">
      <button type="button" class="close" id="ive-close" aria-label="${t("com_close")}">✕</button>
      <div class="ev-header"><h2>${esc(event.title || t("eix_event"))}</h2></div>
      <p class="lbl-sm" style="margin:.1rem 0 1rem">${icon("users", 13)} ${t("eix_invited_by").replace("{handle}", esc(event.invited_by))}</p>
      ${row(t("eix_start"), fmt(event.starts_at))}
      ${event.ends_at ? row(t("eix_end"), fmt(event.ends_at)) : ""}
      ${row(t("eix_location"), event.location)}
      ${event.link ? `<div class="group"><label>${t("eix_link")}</label><div><a href="${esc(event.link)}" target="_blank" rel="noopener noreferrer">${esc(event.link)}</a></div></div>` : ""}
      ${row(t("eix_notes"), event.notes)}
      <div class="actions"><button type="button" class="btn" id="ive-ok">${t("com_close")}</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#ive-close").addEventListener("click", close);
  overlay.querySelector("#ive-ok").addEventListener("click", close);
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
}

export function openEventModal(event, opts = {}) {
  // Événement reçu par invitation → vue lecture seule (pas le formulaire d'édition).
  if (event?.invited_by) return openInvitedEventView(event);
  const editing = !!event;
  const initialKind = editing && event.kind === "live" ? "live" : "event";
  // Préfill création depuis un clic sur une case horaire de la vue Jour/Semaine :
  // opts.prefill = { starts_at: "YYYY-MM-DDTHH:00" } (heure locale).
  const prefillStart = !editing && opts.prefill?.starts_at ? opts.prefill.starts_at : "";
  // On expose le toggle si le créateur peut planifier un live, OU si on édite
  // un live existant (pour permettre la rétrogradation en simple événement).
  const showKindToggle = !!opts.liveAvailable || initialKind === "live";
  const overlay = document.createElement("div");
  overlay.className = "overlay open";
  // Layout : tout le contenu mode-spécifique porte [data-only="event"|"live"]
  // ou [data-when="..."] et CSS gère la bascule via form[data-kind]. Pas de
  // re-render DOM au switch, juste une transition propre.
  overlay.innerHTML = `
    <div class="panel ev-modal" data-kind="${initialKind}" role="dialog" aria-modal="true" aria-labelledby="ev-modal-title">
      <button type="button" class="close" id="ev-close" aria-label="${t("com_close")}">✕</button>
      <div class="ev-header">
        <h2 id="ev-modal-title">
          <span data-when="event">${editing ? t("eix_edit_event") : t("eix_new_event")}</span>
          <span data-when="live">${editing ? t("eix_edit_live") : t("eix_new_live")}</span>
        </h2>
        <span class="ev-live-badge" data-only="live" aria-hidden="true"><span class="ev-live-dot"></span> ${t("eix_live_now")}</span>
      </div>
      <form id="ev-form" novalidate data-kind="${initialKind}">
        ${showKindToggle ? `
        <div class="group ev-kind-row" role="radiogroup" aria-label="${t("eix_event_type")}">
          <button type="button" class="ev-kind-tab${initialKind === "event" ? " active" : ""}" data-kind="event" role="radio" aria-checked="${initialKind === "event"}">
            ${icon("calendar", 16)}
            <span class="ev-kind-label">${t("eix_event")}</span>
            <span class="ev-kind-sub">${t("eix_event_sub")}</span>
          </button>
          <button type="button" class="ev-kind-tab${initialKind === "live" ? " active" : ""}" data-kind="live" role="radio" aria-checked="${initialKind === "live"}">
            ${icon("users", 16)}
            <span class="ev-kind-label">Live</span>
            <span class="ev-kind-sub">${t("eix_broadcast_brand")}</span>
          </button>
        </div>
        <div class="ev-live-hint" data-only="live" role="note">
          ${icon("lock", 14)}
          <div>${t("eix_live_hint")}</div>
        </div>` : ""}
        <div class="group">
          <label for="ev-title">${t("eix_title")} <span class="req" aria-hidden="true">*</span></label>
          <input id="ev-title" name="title" maxlength="200" required aria-required="true"
                 placeholder="${t("eix_title_ph")}"
                 data-placeholder-live="${t("eix_title_live_ph")}"
                 value="${editing ? esc(event.title || "") : ""}" />
        </div>
        <div class="group ev-grid2">
          <div>
            <label for="ev-start">${t("eix_start")} <span class="req" aria-hidden="true">*</span></label>
            <input id="ev-start" name="starts_at" type="datetime-local" required aria-required="true" value="${editing ? toLocalInput(event.starts_at) : prefillStart}" />
          </div>
          <div>
            <label for="ev-end">${t("eix_end")} <span class="opt">${t("eix_optional")}</span></label>
            <input id="ev-end" name="ends_at" type="datetime-local" value="${editing ? toLocalInput(event.ends_at) : ""}" />
          </div>
        </div>
        <div class="group" data-only="event">
          <label for="ev-loc">${t("eix_location")} <span class="opt">${t("eix_optional")}</span></label>
          <input id="ev-loc" name="location" maxlength="200" placeholder="${t("eix_location_ph")}" value="${editing ? esc(event.location || "") : ""}" />
        </div>
        <div class="group" data-only="event">
          <label for="ev-link">${t("eix_link")} <span class="opt">${t("eix_optional")}</span></label>
          <input id="ev-link" name="link" type="url" maxlength="500" placeholder="https://…" value="${editing ? esc(event.link || "") : ""}" />
        </div>
        <div class="group">
          <label for="ev-notes">
            <span data-when="event">${t("eix_notes")} <span class="opt">${t("eix_optional")}</span></span>
            <span data-when="live">${t("eix_live_desc")} <span class="opt">${t("eix_public_visible")}</span></span>
          </label>
          <textarea id="ev-notes" name="notes" rows="3" maxlength="4000"
                    placeholder="${t("eix_notes_ph")}"
                    data-placeholder-live="${t("eix_notes_live_ph")}">${editing ? esc(event.notes || "") : ""}</textarea>
        </div>
        <label class="ev-toggle-row ev-notify-row" data-only="live">
          <input type="checkbox" id="ev-notify" name="notify_subs" ${editing ? (event.notify_subs ? "checked" : "") : "checked"} />
          <div class="ev-toggle-text">
            <strong>${icon("bell", 14)} ${t("eix_notify_subs")}</strong>
            <small>${t("eix_notify_subs_sub")}</small>
          </div>
        </label>
        <label class="ev-toggle-row ev-public-row">
          <input type="checkbox" id="ev-public" name="is_public" ${editing ? (event.is_public !== 0 ? "checked" : "") : "checked"} />
          <div class="ev-toggle-text">
            <strong>${icon("eye", 14)} ${t("eix_public_on_page")}</strong>
            <small data-when="event">${t("eix_public_event_sub")}</small>
            <small data-when="live">${t("eix_public_live_sub")}</small>
          </div>
        </label>
        ${editing && initialKind === "event" ? `
        <div class="group ev-invites" data-only="event">
          <label>${icon("users", 14)} ${t("eix_guests")}</label>
          <div class="ev-invite-list" id="ev-invite-list"><p class="lbl-sm" style="margin:.2rem 0">${t("com_loading")}</p></div>
          <div class="add-row" style="grid-template-columns:1fr auto;margin-top:.4rem">
            <input id="ev-invite-handle" list="ev-invite-cands" placeholder="${t("eix_contact_handle_ph")}" autocomplete="off" />
            <button type="button" class="btn sm" id="ev-invite-add">${t("eix_invite")}</button>
          </div>
          <datalist id="ev-invite-cands">${(opts.contacts || []).map((cc) => `<option value="${esc(cc.handle)}">${esc(cc.name || cc.handle)}</option>`).join("")}</datalist>
        </div>` : ""}
        <div class="err" id="ev-err"></div>
        <div class="actions">
          ${editing ? `<button type="button" class="btn danger ghost" id="ev-delete">${icon("trash", 15)} ${t("com_delete")}</button>` : ""}
          <button type="button" class="btn" id="ev-cancel">${t("com_cancel")}</button>
          <button type="submit" class="btn primary" id="ev-submit">
            <span data-when="event">${editing ? t("eix_save") : t("eix_add")}</span>
            <span data-when="live">${editing ? t("eix_save_live") : t("eix_schedule_live")}</span>
          </button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const errEl = overlay.querySelector("#ev-err");
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#ev-close").addEventListener("click", close);
  overlay.querySelector("#ev-cancel").addEventListener("click", close);
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  setTimeout(() => overlay.querySelector("#ev-title").focus(), 30);

  overlay.querySelector("#ev-delete")?.addEventListener("click", async () => {
    if (!(await confirmDialog(t("eix_delete_confirm_title").replace("{title}", event.title), { ok: t("com_delete"), danger: true }))) return;
    await api(`/api/agenda/${event.id}`, { method: "DELETE", headers: authHeaders() });
    close();
    if (typeof opts.onDeleted === "function") opts.onDeleted(event.id);
    else renderPrivate(appState.key);
  });

  // Toggle « Événement / Live » : maintient form.dataset.kind (CSS gère la
  // bascule des éléments [data-only]/[data-when]) et swap les placeholders qui
  // sont des attributs, donc inaccessibles à CSS.
  const formEl = overlay.querySelector("#ev-form");
  const swapPlaceholders = (k) => {
    overlay.querySelectorAll("[data-placeholder-live]").forEach((el) => {
      if (!("placeholderDefault" in el.dataset)) el.dataset.placeholderDefault = el.placeholder;
      el.placeholder = k === "live" ? el.dataset.placeholderLive : el.dataset.placeholderDefault;
    });
  };
  swapPlaceholders(initialKind);
  const panelEl = overlay.querySelector(".ev-modal");
  overlay.querySelectorAll(".ev-kind-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      const k = tab.dataset.kind === "live" ? "live" : "event";
      formEl.dataset.kind = k;
      // Duplique data-kind sur le panel pour les éléments hors-form (badge
      // EN DIRECT du header) — évite la dépendance à :has() pour le ciblage.
      panelEl.dataset.kind = k;
      overlay.querySelectorAll(".ev-kind-tab").forEach((t) => {
        const on = t.dataset.kind === k;
        t.classList.toggle("active", on);
        t.setAttribute("aria-checked", on ? "true" : "false");
      });
      swapPlaceholders(k);
    })
  );

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    const fd = new FormData(e.target);
    const title = (fd.get("title") || "").trim();
    const start = fd.get("starts_at");
    const end = fd.get("ends_at");
    if (!title) { errEl.textContent = t("eix_title_required"); return; }
    if (!start) { errEl.textContent = t("eix_start_required"); return; }
    if (end && new Date(end) < new Date(start)) { errEl.textContent = t("eix_end_after_start"); return; }
    const kind = formEl.dataset.kind === "live" ? "live" : "event";
    const payload = {
      title,
      starts_at: new Date(start).toISOString(),
      ends_at: end ? new Date(end).toISOString() : null,
      // En mode live, lieu et lien externe n'ont pas de sens (le lieu = la
      // plateforme, le lien = /live/:id auto-généré) → on n'envoie que pour
      // les vrais événements.
      location: kind === "event" ? (fd.get("location") || "").trim() : "",
      link: kind === "event" ? (fd.get("link") || "").trim() : "",
      notes: (fd.get("notes") || "").trim(),
      is_public: fd.get("is_public") === "on",
      kind,
      notify_subs: kind === "live" ? fd.get("notify_subs") === "on" : false,
    };
    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const saved = await api(editing ? `/api/agenda/${event.id}` : "/api/agenda", {
        method: editing ? "PUT" : "POST",
        headers: jsonAuth(),
        body: JSON.stringify(payload),
      });
      close();
      toast(editing ? t("eix_event_updated") : t("eix_event_added"));
      // Rafraîchissement EN PLACE si l'appelant fournit onSaved (cas agenda) :
      // on évite le rechargement complet de l'éditeur (flash + perte de vue/scroll).
      if (typeof opts.onSaved === "function") opts.onSaved(saved);
      else renderPrivate(appState.key);
    } catch (err) {
      submitBtn.disabled = false;
      errEl.textContent = t("eix_save_retry");
    }
  });

  // ----- Invités (organisateur, événements existants uniquement) -----
  if (editing && initialKind === "event") {
    const listBox = overlay.querySelector("#ev-invite-list");
    const statusLabel = (s) =>
      s === "accepted" ? t("eix_inv_accepted") : s === "declined" ? t("eix_inv_declined") : t("eix_inv_pending");
    const renderInvites = (invites) => {
      if (!listBox) return;
      if (!invites.length) { listBox.innerHTML = `<p class="lbl-sm" style="margin:.2rem 0">${t("eix_no_guests_yet")}</p>`; return; }
      listBox.innerHTML = invites.map((iv) => `
        <div class="ev-invite-row">
          <span class="ev-invite-h">@${esc(iv.handle)}</span>
          <span class="ev-invite-status st-${esc(iv.status)}">${statusLabel(iv.status)}</span>
          <button type="button" class="btn-field-del" data-invite-remove="${esc(iv.handle)}" title="${t("eix_remove")}" aria-label="${t("eix_remove_handle").replace("{handle}", esc(iv.handle))}">✕</button>
        </div>`).join("");
      listBox.querySelectorAll("[data-invite-remove]").forEach((b) =>
        b.addEventListener("click", async () => {
          try { await api(`/api/agenda/${event.id}/invites/${encodeURIComponent(b.dataset.inviteRemove)}`, { method: "DELETE", headers: authHeaders() }); }
          catch (e) { return toast(e?.message || t("eix_failed")); }
          loadInvites();
        }));
    };
    const loadInvites = async () => {
      try { const r = await api(`/api/agenda/${event.id}/invites`, { headers: authHeaders() }); renderInvites(r.invites || []); }
      catch { if (listBox) listBox.innerHTML = `<p class="lbl-sm" style="margin:.2rem 0">${t("eix_guests_load_fail")}</p>`; }
    };
    const addInvite = async () => {
      const inp = overlay.querySelector("#ev-invite-handle");
      const h = (inp?.value || "").trim().replace(/^@/, "");
      if (!h) return;
      try {
        const r = await api(`/api/agenda/${event.id}/invites`, { method: "POST", headers: jsonAuth(), body: JSON.stringify({ handles: [h] }) });
        const res = (r.results || [])[0];
        if (res && res.ok === false) toast(res.error || t("eix_invite_impossible"));
        else { inp.value = ""; toast(t("eix_invite_sent")); }
        renderInvites(r.invites || []);
      } catch (e) { toast(e?.message || t("eix_failed")); }
    };
    overlay.querySelector("#ev-invite-add")?.addEventListener("click", addInvite);
    overlay.querySelector("#ev-invite-handle")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addInvite(); }
    });
    loadInvites();
  }
}

