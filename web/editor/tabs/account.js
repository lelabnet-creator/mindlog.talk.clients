// editor/tabs/account.js — « Compte » : dashboard public + gestion du compte.
// Fusion de l'ex-Accueil (aperçu page publique, stats, events, activité) et de
// l'ex-Compte (abonnement, sécurité E2E, accès, données).
import { appState } from "../../state.js";
import { buildInfo } from "../../app.js";
import { esc } from "../../ui/dom.js";
import { icon } from "../../ui/icons.js";
import { getActivityLog } from "../../activity-log.js";
import { t, langSelectHtml } from "../../i18n.js";

// Une ligne du journal local (appel/chat/live…). Les échecs (level=error) sont
// mis en évidence et affichent leur raison détaillée sous le résumé.
export function activityLogRowHtml(e) {
  const when = new Date(e.at);
  const t = isNaN(when) ? "" : when.toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const ic = e.kind === "call" ? icon("phone", 13)
    : e.kind === "chat" ? icon("chat", 13)
    : e.kind === "live" ? icon("users", 13)
    : e.kind === "relation" ? icon("users", 13)
    : icon("clock", 13);
  return `<div class="act-log-row act-log--${esc(e.level || "info")}">
    <span class="act-log-ic">${ic}</span>
    <div class="act-log-body">
      <div class="act-log-head"><span class="act-log-text">${esc(e.text || "")}</span><span class="act-log-time">${esc(t)}</span></div>
      ${e.detail ? `<div class="act-log-detail">${esc(e.detail)}</div>` : ""}
    </div>
  </div>`;
}

// Contenu du journal (sans son conteneur) — réutilisé pour le rafraîchissement live.
export function activityLogInnerHtml() {
  const entries = getActivityLog();
  return entries.length
    ? entries.map(activityLogRowHtml).join("")
    : `<div class="hm-empty">${t("acnt_no_log")}</div>`;
}

export function renderAccountColumn(data, { photo, profileHtml = "", notifsHtml = "", espacesHtml = "" } = {}) {
  // ── Identité ──────────────────────────────────────────────────────────────
  const sub = data.subscription || { plan: data.plan || "free", status: "none", premiumUntil: null, cancelAtPeriodEnd: false };
  const isPrem = sub.plan === "premium";
  const pastDue = sub.status === "past_due";
  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  };

  // ── Dashboard (ex-Accueil) ────────────────────────────────────────────────
  const hmNotifs       = (data.notifications || []).slice(0, 4);
  const rel  = data.relations || { 1: [], 2: [], 3: [] };
  const deg1 = rel[1] || [];

  function hmActivityRow(n) {
    const t  = n.type || "";
    const ic = t === "subscription" ? icon("sparkles", 13)
      : t === "meeting"             ? icon("calendar", 13)
      : t === "call"                ? icon("phone", 13)
      : t === "message"             ? icon("chat", 13)
      : t === "like"                ? "♥"
      :                               icon("clock", 13);
    return `<div class="hm-act-row ${n.read ? "" : "unread"}">
      <span class="hm-act-ic hm-act-ic--${t || "notif"}">${ic}</span>
      <div class="hm-act-text">${esc(n.text || "")}</div>
    </div>`;
  }

  // ── Fonctions premium ─────────────────────────────────────────────────────
  // Toutes les fonctions premium (couverture, boutons, pages payantes,
  // facturation) vivent désormais dans la page dédiée « Espace Premium »
  // (premium.js), ouverte via le bouton « Gérer » du bandeau d'abonnement.

  // Layout 2-cols rail+main, comme Échanges (wrapper + layout grid au niveau .col).
  // Le rail est flush avec le bord gauche de la colonne (x = .col.left), la zone
  // main prend le reste. La hauteur est calée sur --col-h (même invariant que la
  // comm-wrapper) et le scroll vit DANS la zone main.
  return `<div class="acc-wrapper">
    <div class="acc-layout">
      <nav class="subrail acc-rail" role="tablist" id="opt-tabs" aria-label="${t("acnt_subsections")}">
        <!-- Profil, Notifications & Espaces = panneaux DANS Compte (le sous-menu reste
             affiché). « Espaces » embarque la gestion premium / l'upsell. -->
        <button type="button" class="subrail-btn opt-tab active" data-tab="profil" role="tab" aria-selected="true" title="${t("acc_profil")}" aria-label="${t("acc_profil")}">
          ${icon("user", 22)}<span class="subrail-label">${t("acc_profil")}</span>
        </button>
        <button type="button" class="subrail-btn opt-tab" data-tab="notifs" role="tab" aria-selected="false" title="${t("nav_notifs")}" aria-label="${t("nav_notifs")}">
          ${icon("bell", 22)}<span class="subrail-label">${t("nav_notifs")}</span>
          ${data.unread ? `<span class="subrail-badge">${data.unread > 99 ? "99+" : data.unread}</span>` : ""}
        </button>
        <button type="button" class="subrail-btn opt-tab${isPrem ? "" : " opt-tab-premium"}" data-tab="espaces" role="tab" aria-selected="false" title="${t("acc_espaces")}" aria-label="${t("acc_espaces")}">
          ${icon("sparkles", 22)}<span class="subrail-label">${t("acc_espaces")}</span>
        </button>
        <span class="subrail-sep" aria-hidden="true"></span>
        <button class="subrail-btn opt-tab" data-tab="activite" role="tab" aria-selected="false" title="${t("acc_activite")}" aria-label="${t("acc_activite")}">
          ${icon("clock", 22)}<span class="subrail-label">${t("acc_activite")}</span>
        </button>
        <button class="subrail-btn opt-tab" data-tab="securite" role="tab" aria-selected="false" title="${t("acc_securite")}" aria-label="${t("acc_securite")}">
          ${icon("lock", 22)}<span class="subrail-label">${t("acc_securite")}</span>
        </button>
        <button class="subrail-btn opt-tab" data-tab="acces" role="tab" aria-selected="false" title="${t("acc_acces")}" aria-label="${t("acc_acces")}">
          ${icon("key", 22)}<span class="subrail-label">${t("acc_acces")}</span>
        </button>
        <button class="subrail-btn opt-tab" data-tab="stockage" role="tab" aria-selected="false" title="${t("acc_stockage")}" aria-label="${t("acc_stockage")}">
          ${icon("database", 22)}<span class="subrail-label">${t("acc_stockage")}</span>
        </button>
        <button class="subrail-btn opt-tab" data-tab="apropos" role="tab" aria-selected="false" title="${t("acc_apropos")}" aria-label="${t("acc_apropos")}">
          ${icon("code", 22)}<span class="subrail-label">${t("acc_apropos")}</span>
        </button>
        <button class="subrail-btn opt-tab opt-tab-danger" data-tab="donnees" role="tab" aria-selected="false" title="${t("acc_donnees")}" aria-label="${t("acc_donnees")}">
          ${icon("trash", 22)}<span class="subrail-label">${t("acc_donnees")}</span>
        </button>
      </nav>
      <div class="acc-main">
        <div class="col-scroll acc-scroll">
          ${
            // En-tête identité (avatar + @handle + badge plan) retiré : redondant
            // avec la barre d'app et le panneau Profil. On ne garde que les bandeaux
            // d'action conditionnels, et le conteneur n'est émis QUE s'il en a un
            // (sinon gros espace mort en haut du panneau Compte).
            (() => {
              const banners = [
                // (Bandeau « RDV en attente » retiré : les demandes de RDV vivent
                // désormais dans mindlog·calendar.)
                // Le statut « Premium actif » est désormais porté par la couronne
                // sur l'avatar (header) — plus de bandeau permanent qui mange la
                // place. On ne conserve QUE l'alerte critique « paiement en attente »
                // (past_due), car elle demande une action immédiate.
                (isPrem && pastDue) ? `<div class="acc-sub-banner acc-sub-banner--premium">
                  <span class="acc-sub-banner-ic">${icon("sparkles", 15)}</span>
                  <div class="acc-sub-banner-body">
                    <b>${t("acc_pastdue_t")}</b>
                    <span>${t("acc_pastdue_d")}</span>
                  </div>
                  <button class="btn sm" id="opt-portal-btn">${t("acc_update_card")}</button>
                </div>` : "",
              ].join("");
              return banners ? `<div class="acc-header">${banners}</div>` : "";
            })()
          }

          <div class="acc-panels">

          <!-- Panneau « Mon profil » : édition de la carte (ex-colonne Identité). -->
          <div class="opt-panel opt-panel--embed" id="opt-profil" role="tabpanel">${profileHtml}</div>
          <!-- Panneau « Notifications » (ex-colonne Notifications). -->
          <div class="opt-panel opt-panel--embed" id="opt-notifs" role="tabpanel" hidden>${notifsHtml}</div>
          <!-- Panneau « Mes espaces » : gestion premium / upsell (ex-page /me/premium),
               câblé paresseusement (wirePremiumPage) au premier affichage. -->
          <div class="opt-panel opt-panel--embed" id="opt-espaces" role="tabpanel" hidden>${espacesHtml}</div>

          <div class="opt-panel" id="opt-activite" role="tabpanel" hidden>
            <div class="hm-stats-grid" style="grid-template-columns:repeat(2,1fr);margin:0 10px .75rem">
              <div class="hm-stat" data-goto="Notifications"><b>${data.unread || 0}</b><span>${t("acc_stat_unread")}</span></div>
              <div class="hm-stat" data-goto="Relations"><b>${deg1.length}</b><span>${t("acc_stat_conn")}</span></div>
            </div>
            <!-- Activité récente (notifs) & Journal local des actions (appel/chat/
                 live, conserve la RAISON des échecs) présentés en onglets. Le journal
                 est rafraîchi en direct via onActivityLog. -->
            <div class="act-tabs" role="tablist" aria-label="${t("acc_activite")}" style="margin:0 10px .65rem">
              <button class="act-tab active" data-acttab="recent" role="tab" aria-selected="true">${icon("clock", 14)} ${t("acc_act_recent")}</button>
              <button class="act-tab" data-acttab="journal" role="tab" aria-selected="false">${icon("clock", 14)} ${t("acc_act_journal")}</button>
            </div>
            <section class="hm-section act-tabpanel" id="act-pane-recent" role="tabpanel" style="margin:0 10px">
              <div class="hm-section-title"><a data-goto="Notifications" href="#" style="margin-left:auto">${t("acc_see_all")}</a></div>
              ${hmNotifs.length ? `<div class="hm-activity">${hmNotifs.map(hmActivityRow).join("")}</div>` : `<div class="hm-empty">${t("acc_no_activity")}</div>`}
            </section>
            <section class="hm-section act-tabpanel" id="act-pane-journal" role="tabpanel" hidden style="margin:0 10px">
              <div class="hm-section-title">
                <button class="btn sm ghost" id="act-log-clear" style="margin-left:auto">${t("acc_clear")}</button>
              </div>
              <div class="act-log" id="act-log">${activityLogInnerHtml()}</div>
            </section>
          </div>

          <div class="opt-panel" id="opt-securite" role="tabpanel" hidden>
          <div class="opt-v2-grid">
            <div class="opt-v2-block opt-v2-account">
              <div class="opt-v2-head">${icon("lock", 16)} ${t("acc_sec_h")}</div>
              <div class="opt-v2-e2e-status ${data.hasVault ? "ok" : "warn"}" id="opt-vault-banner">
                ${icon(data.hasVault ? "shield" : "key", 20)}
                <div>
                  <b>${data.hasVault ? t("acc_vault_ok_t") : t("acc_vault_no_t")}</b>
                  <p>${data.hasVault ? t("acc_vault_ok_d") : t("acc_vault_no_d")}</p>
                </div>
              </div>
              <div class="opt-v2-access-grid" style="margin-top:.85rem">
                <div class="opt-v2-access-col">
                  <p class="lbl-sm" style="margin:0 0 .4rem">${t("acc_vault_save")}</p>
                  <button class="btn sm" id="opt-e2e-backup" style="margin-bottom:.55rem">${icon("download", 14)} ${data.hasVault ? t("acc_vault_update") : t("acc_vault_quick")}</button>
                  <div style="display:flex;gap:.4rem;flex-wrap:wrap">
                    <button class="btn sm" id="e2e-passkey-save2">${icon("shield", 13)} ${t("acc_via_passkey")}</button>
                    <button class="btn sm" id="e2e-pin-save2">${icon("lock", 13)} ${t("acc_via_pin")}</button>
                    <button class="btn sm" id="e2e-pass-save2">${icon("key", 13)} ${t("acc_via_pass")}</button>
                    <button class="btn sm" id="e2e-restore2">${icon("download", 13)} ${t("acc_restore")}</button>
                  </div>
                </div>
                <div class="opt-v2-access-col">
                  <p class="lbl-sm" style="margin:0 0 .4rem">${t("acc_passkeys_h")}</p>
                  <div id="passkey-list2" class="lbl-sm">${t("acc_loading")}</div>
                  <div class="add-row" style="grid-template-columns:1fr auto;margin-top:.5rem">
                    <input id="passkey-name2" placeholder="${t("acc_device_name_ph")}" maxlength="64" />
                    <button class="btn primary sm" id="passkey-add2">${icon("shield", 14)} ${t("acc_create")}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>

          <div class="opt-panel" id="opt-acces" role="tabpanel" hidden>
            <!-- Sous-onglets pour aérer un panneau autrefois très dense (grille 2
                 colonnes entassant lien, clé, email, sessions, PIN et appareils).
                 Une seule préoccupation à la fois → meilleure lisibilité, surtout
                 sur mobile. Câblage : .acc-seg-tab → panneau #acc-seg-<id>. -->
            <div class="acc-seg-tabs" role="tablist" aria-label="${t("acc_acces")}">
              <button type="button" class="acc-seg-tab active" data-accseg="cle" role="tab" aria-selected="true">${icon("key", 14)} ${t("accseg_cle")}</button>
              <button type="button" class="acc-seg-tab" data-accseg="sessions" role="tab" aria-selected="false">${icon("clock", 14)} ${t("accseg_sessions")}</button>
              <button type="button" class="acc-seg-tab" data-accseg="devices" role="tab" aria-selected="false">${icon("shield", 14)} ${t("accseg_devices")}</button>
            </div>

            <!-- ── Lien & clé ────────────────────────────────────────────── -->
            <div class="acc-seg-pane" id="acc-seg-cle" role="tabpanel">
              <div class="opt-v2-block opt-v2-account">
                <div class="opt-v2-head">${icon("link", 16)} ${t("acc_link_h")}</div>
                <p class="lbl-sm" style="margin:0 0 .55rem;line-height:1.5">${t("acc_link_d")}</p>
                <div class="url-row">
                  <code style="font-size:.74rem;word-break:break-all">${esc(location.origin + data.publicUrl)}</code>
                  <button class="btn copy sm" data-copy="${esc(location.origin + data.publicUrl)}">${t("acc_copy")}</button>
                </div>
              </div>
              <div class="opt-v2-block opt-v2-account">
                <div class="opt-v2-head">${icon("key", 16)} ${t("acc_key_h")}</div>
                <p class="lbl-sm" style="margin:0 0 .55rem;line-height:1.5">${t("acc_key_d")}</p>
                <div class="url-row" style="margin-bottom:.5rem">
                  <code id="key-display2" style="font-size:.74rem;cursor:pointer" title="${t("acc_show")}">••••••••••</code>
                  <button class="btn copy sm" id="copy-key2" data-copy="${esc(appState.key)}">${t("acc_copy")}</button>
                </div>
                <div style="display:flex;gap:.4rem;flex-wrap:wrap">
                  <button class="btn sm" id="toggle-key2">${icon("eye-off", 13)} ${t("acc_show")}</button>
                  <button class="btn sm danger" id="rotate-key2">${icon("key", 13)} ${t("acc_regen")}</button>
                </div>
              </div>
              <div class="opt-v2-block opt-v2-account">
                <div class="opt-v2-head">${icon("download", 16)} ${t("acc_recovery_h")}</div>
                <p class="lbl-sm" style="margin:0 0 .55rem;line-height:1.5">${t("acc_recovery_d")}</p>
                <div class="add-row" style="grid-template-columns:1fr auto">
                  <input id="rec-email2" type="email" value="${esc(data.recoveryEmail || "")}" placeholder="${t("acnt_email_ph")}" />
                  <button class="btn sm" id="save-rec2">${t("acc_save")}</button>
                </div>
              </div>
            </div>

            <!-- ── Sessions ──────────────────────────────────────────────── -->
            <div class="acc-seg-pane" id="acc-seg-sessions" role="tabpanel" hidden>
              <div class="opt-v2-block opt-v2-account">
                <div class="opt-v2-head">${icon("clock", 16)} ${t("acc_sessions_h")}</div>
                <p class="lbl-sm" style="margin:0 0 .6rem;line-height:1.5">${t("acc_sessions_d")}</p>
                <div id="sessions-list2" class="lbl-sm">${t("acc_loading")}</div>
                <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.75rem">
                  <button class="btn sm" id="logout-btn2">${icon("key", 13)} ${t("acc_logout_one")}</button>
                  <button class="btn sm danger" id="logout-all-btn2">${icon("key", 13)} ${t("acc_logout_all")}</button>
                </div>
              </div>
              <div class="opt-v2-block opt-v2-account">
                <div class="opt-v2-head">${icon("qr", 16)} ${t("acc_pin_h")} <span class="badge-sm">PIN</span></div>
                <p class="lbl-sm" style="margin:0 0 .6rem;line-height:1.5">${t("acc_pin_d")}</p>
                <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
                  <button class="btn sm" id="gen-pin-btn2">${icon("key", 13)} ${t("acc_pin_gen")}</button>
                  <code id="pin-display2" style="font-size:1.1rem;letter-spacing:.2em;font-weight:600" hidden></code>
                </div>
                <p class="lbl-sm" id="pin-hint2" style="margin:.4rem 0 0" hidden></p>
              </div>
            </div>

            <!-- ── Appareils chiffrés ────────────────────────────────────── -->
            <div class="acc-seg-pane" id="acc-seg-devices" role="tabpanel" hidden>
              <div class="opt-v2-block opt-v2-account">
                <div class="opt-v2-head">${icon("shield", 16)} ${t("acc_devices_h")}</div>
                <p class="lbl-sm" style="margin:0 0 .6rem;line-height:1.5">${t("acc_devices_d")}</p>
                <div id="devices-list" class="lbl-sm">${t("acc_loading")}</div>
              </div>
            </div>
          </div>

          <div class="opt-panel" id="opt-stockage" role="tabpanel" hidden>
          <div class="opt-v2-grid">
            <div class="opt-v2-block opt-v2-block--full" id="sp-storage-block">
              <div class="opt-v2-head">
                ${icon("database", 16)} ${t("acc_storage_h")}
                <span class="lbl-sm" id="sp-storage-status" style="margin-left:auto;opacity:.6" aria-live="polite"></span>
              </div>
              ${isPrem
                ? `<!-- Sur mobile : la config stockage (fournisseur, clés d'accès,
                        dossiers) exige une saisie précise → on la masque et on
                        renvoie vers la version bureau. Le bloc #sp-storage reste
                        dans le DOM (chargé, juste masqué en CSS). -->
                   <div class="mobile-web-hint">
                     <div class="mwh-head">${icon("code", 16)} <b>${t("acc_storage_web_h")}</b></div>
                     <p class="lbl-sm" style="margin:.25rem 0 .55rem;line-height:1.45">${t("acc_storage_web_d")}</p>
                     <div class="url-row">
                       <code style="font-size:.75rem;word-break:break-all">${esc(location.origin)}/app</code>
                       <button class="btn copy sm" data-copy="${esc(location.origin)}/app">${t("acc_copy")}</button>
                     </div>
                   </div>
                   <div class="id-hide-mobile">
                     <p class="lbl-sm" style="margin:0 0 .6rem;line-height:1.5">
                       ${icon("lock", 12)} ${t("acc_storage_prem_d")}
                     </p>
                     <div id="sp-storage" class="sp-storage">${t("acc_loading")}</div>
                   </div>`
                : `<p class="lbl-sm" style="margin:0 0 .7rem;line-height:1.5">
                     ${t("acc_storage_free_d")}
                   </p>
                   <button class="btn primary sm" id="opt-upgrade-storage">${icon("sparkles", 13)} ${t("acc_go_premium")}</button>`}
            </div>
          </div>
          </div>

          <div class="opt-panel" id="opt-apropos" role="tabpanel" hidden>
          <div class="opt-v2-grid">
            <div class="opt-v2-block opt-v2-account">
              <div class="opt-v2-head">${icon("settings", 16)} ${t("lang_label")}</div>
              <p class="lbl-sm" style="margin:0 0 .6rem;line-height:1.5">${t("acc_lang_hint")}</p>
              ${langSelectHtml()}
            </div>
            <div class="opt-v2-block opt-v2-account">
              <div class="opt-v2-head">${icon("shield", 16)} ${t("acc_legal_h")}</div>
              <p class="lbl-sm" style="margin:0 0 .75rem;line-height:1.5">${t("acc_legal_d")}</p>
              <div class="acc-legal-links">
                <a class="btn sm" href="/mentions-legales" target="_blank" rel="noopener">${icon("shield", 13)} ${t("acc_legal_terms")}</a>
                <a class="btn sm" href="/cgu" target="_blank" rel="noopener">${icon("code", 13)} ${t("acc_legal_cgu")}</a>
                <a class="btn sm" href="/confidentialite" target="_blank" rel="noopener">${icon("lock", 13)} ${t("acc_legal_privacy")}</a>
                <a class="btn sm" href="/cgv" target="_blank" rel="noopener">${icon("sparkles", 13)} ${t("acc_legal_cgv")}</a>
              </div>
            </div>

            <div class="opt-v2-block opt-v2-account">
              <div class="opt-v2-head">${icon("code", 16)} ${t("acnt_software_brand")}</div>
              <p class="acc-version" style="margin:0 0 .55rem">
                ${icon("sparkles", 12)} ${t("acc_version_l")} <b>${esc(window.__APP_VERSION__ || "—")}</b>${(() => {
                  const bi = buildInfo(); // jeton edge (s) ou assetVersion backend (ms)
                  return bi ? ` <span class="lbl-sm">· build ${esc(bi.build)} · ${esc(bi.date)}</span>` : "";
                })()}
              </p>
              <p class="lbl-sm" style="margin:0 0 .55rem;line-height:1.5">
                ${t("acc_opensource")}
                <a href="https://www.gnu.org/licenses/agpl-3.0.fr.html" target="_blank" rel="noopener"><b>GNU AGPL v3.0</b></a>${t("acc_opensource2")}
              </p>
              <div style="display:flex;gap:.4rem;flex-wrap:wrap">
                <a class="btn sm" href="https://github.com/jacquesH82/mindlog.id" target="_blank" rel="noopener">${icon("code", 13)} ${t("acc_source")}</a>
                <a class="btn sm" href="/static/api-docs.html" target="_blank" rel="noopener">${icon("plug", 13)} ${t("acc_api_docs")}</a>
                <a class="btn sm" href="/status" target="_blank" rel="noopener">${icon("zap", 13)} ${t("acc_status")}</a>
              </div>
            </div>

            <details class="opt-v2-block opt-v2-account acc-collapse">
              <summary class="opt-v2-head acc-collapse-head">
                <span class="acc-collapse-title">${icon("users", 16)} ${t("acc_licenses_h")}</span>
                ${icon("chevron-down", 16)}
              </summary>
              <p class="lbl-sm" style="margin:.75rem 0;line-height:1.5">
                ${t("acnt_lic_intro")}
              </p>

              <p class="lbl-sm" style="margin:.65rem 0 .25rem"><b>${t("acnt_lic_cat_platform")}</b></p>
              <ul class="acc-licenses">
                <li><b>Node.js</b> — ${t("acnt_lic_node")} — <em>MIT</em></li>
                <li><b>PostgreSQL</b> — ${t("acnt_lic_pg_desc")} — <em>${t("acnt_lic_pg_name")}</em></li>
                <li><b>TypeScript</b> — ${t("acnt_lic_ts")} — <em>Apache-2.0</em></li>
              </ul>

              <p class="lbl-sm" style="margin:.85rem 0 .25rem"><b>${t("acnt_lic_cat_server")}</b></p>
              <ul class="acc-licenses">
                <li><b>Hono</b> — ${t("acnt_lic_hono")} — <em>MIT</em></li>
                <li><b>Drizzle ORM</b> &amp; <b>drizzle-kit</b> — ${t("acnt_lic_drizzle")} — <em>Apache-2.0</em></li>
                <li><b>@electric-sql/pglite</b> — ${t("acnt_lic_pglite")} — <em>Apache-2.0</em></li>
                <li><b>node-postgres (pg)</b> — ${t("acnt_lic_pg_driver")} — <em>MIT</em></li>
                <li><b>@simplewebauthn/server</b> — ${t("acnt_lic_webauthn")} — <em>MIT</em></li>
                <li><b>@modelcontextprotocol/sdk</b> — ${t("acnt_lic_mcp")} — <em>MIT</em></li>
                <li><b>zod</b> — ${t("acnt_lic_zod")} — <em>MIT</em></li>
                <li><b>nodemailer</b> — ${t("acnt_lic_nodemailer")} — <em>MIT-0</em></li>
                <li><b>MJML</b> — ${t("acnt_lic_mjml")} — <em>MIT</em></li>
                <li><b>better-sqlite3</b> — ${t("acnt_lic_sqlite")} — <em>MIT</em></li>
              </ul>

              <p class="lbl-sm" style="margin:.85rem 0 .25rem"><b>${t("acnt_lic_cat_client")}</b></p>
              <ul class="acc-licenses">
                <li><b>GSAP</b> &amp; <b>ScrollTrigger</b> — ${t("acnt_lic_gsap")} — <em>${t("acnt_lic_gsap_name")}</em></li>
                <li><b>Shepherd.js</b> — ${t("acnt_lic_shepherd")} — <em>MIT</em></li>
                <li><b>QRCode.js</b> — ${t("acnt_lic_qr")} — <em>MIT</em></li>
                <li><b>D3.js</b> — ${t("acnt_lic_d3")} — <em>ISC</em></li>
              </ul>

              <p class="lbl-sm" style="margin:.85rem 0 .25rem"><b>${t("acnt_lic_cat_thirdparty")}</b></p>
              <ul class="acc-licenses">
                <li><b>Stripe</b> — ${t("acnt_lic_stripe_desc")} — <em>${t("acnt_lic_stripe_name")}</em></li>
                <li><b>Cloudflare Turnstile</b> — ${t("acnt_lic_turnstile_desc")} — <em>${t("acnt_lic_turnstile_name")}</em></li>
                <li><b>OVHcloud</b> — ${t("acnt_lic_ovh_desc")} — <em>${t("acnt_lic_ovh_name")}</em></li>
              </ul>

              <p class="lbl-sm" style="margin:1rem 0 0;line-height:1.5;color:var(--muted)">
                ${t("acnt_lic_agpl")}
              </p>
            </details>
          </div>
          </div>

          <div class="opt-panel" id="opt-donnees" role="tabpanel" hidden>
          <div class="opt-v2-grid">
            <div class="opt-v2-block opt-v2-account">
              <div class="opt-v2-head">${icon("shield", 16)} ${t("acc_data_h")}</div>
              <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem">
                <button class="btn sm" id="export-data2">${icon("download", 14)} ${t("acc_export")}</button>
                <button class="btn sm" id="opt-qr-link">${icon("qr", 14)} ${t("acc_qr")}</button>
              </div>
              <div class="opt-v2-head" style="color:var(--danger);margin-top:.5rem">${icon("trash", 16)} ${t("acc_danger_h")}</div>
              <p class="lbl-sm" style="margin:0 0 .75rem;line-height:1.5">${t("acc_danger_d")}</p>
              <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                <button class="btn sm danger" data-action="logout">${icon("key", 14)} ${t("acc_logout_btn")}</button>
                <button class="btn sm danger" id="delete-account2">${icon("trash", 14)} ${t("acc_delete")}</button>
              </div>
            </div>
          </div>
          </div>
          </div><!-- /acc-panels -->
        </div><!-- /acc-scroll -->
      </div><!-- /acc-main -->
    </div><!-- /acc-layout -->
  </div>`;
}
