// editor/tabs/home.js — colonne « Accueil » : aperçu configurable de la page
// publique (style linktr.ee) à gauche + colonne « back-office » à droite.
// L'agenda (écran Calendrier, RDV, événements) est parti dans mindlog·calendar.
// Builder de rendu pur (câblage dans wireEditor). cf. docs/web-app-split-proposal.md
import { esc } from "../../ui/dom.js";
import { icon } from "../../ui/icons.js";
import { t } from "../../i18n.js";

export function renderHomeColumn(data, { photo }) {
  const rel = data.relations || { 1: [], 2: [], 3: [] };
  const _deg1 = rel[1] || [];

  // Helpers home dashboard
  const hmGet = (k) => data.fields?.find(f => f.key === k)?.value?.trim() || "";
  const hmDisplayName = hmGet("display_name");
  const hmTitle = [hmGet("title"), hmGet("company")].filter(Boolean).join(" · ");
  const hmLocation = hmGet("location");
  const hmNotifs = (data.notifications || []).slice(0, 4);
  const hmProfilePublic = data.settings?.profile_public !== false;
  const hmGalleryPublic = data.settings?.gallery_public !== false;
  // Couverture de l'aperçu façon téléphone : champ « cover » s'il existe un jour,
  // sinon l'image par défaut (caméléon).
  const coverUrl = hmGet("cover") || "/static/default-cover.webp";

  function hmActivityRow(n) {
    const t = n.type || "";
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

  const vaultBadge = data.hasVault
    ? `<span class="hm-badge vault">${icon("lock", 11)} ${t("home_e2e_on")}</span>`
    : `<span class="hm-badge secret">${icon("lock", 11)} ${t("home_no_vault")}</span>`;

  // Personnalisation Premium (P4/P5) : couverture + boutons, éditables si Premium.
  const isPrem = data.plan === "premium" || data.subscription?.plan === "premium";
  const pbRowHtml = (b = { label: "", url: "" }) =>
    `<div class="pb-row">
      <input class="pb-label" placeholder="${t("home_label_ph")}" maxlength="80" value="${esc(b.label || "")}" ${isPrem ? "" : "disabled"}>
      <input class="pb-url" placeholder="https://…" maxlength="2000" value="${esc(b.url || "")}" ${isPrem ? "" : "disabled"}>
      <button type="button" class="pb-del" title="${t("home_remove")}" ${isPrem ? "" : "disabled"}>✕</button>
    </div>`;

  return `<div class="hm-dashboard">

      <div class="hm-row hm-row-hybrid">

        <!-- ===== GAUCHE : aperçu de la page publique (linktr.ee) ===== -->
        <section class="hm-section hm-public">
          <div class="hm-section-title">${t("home_public_preview")} <a href="/@${esc(data.handle)}" target="_blank" rel="noopener noreferrer">${t("home_open_ext")}</a></div>

          <div class="lt-phone-cols">
          <div class="lt-phone" role="group" aria-label="${t("home_preview_aria")}">
            <span class="lt-phone-notch" aria-hidden="true"></span>
            <div class="lt-phone-screen" style="--lt-cover:url('${esc(coverUrl)}')">
              <div class="lt-screens" id="lt-screens">

                <!-- Écran 1 : Accueil — couverture plein écran + identité en overlay bas -->
                <section class="lt-screen lt-screen--cover" data-screen="home" aria-label="${t("home_screen_home")}">
                  <div class="lt-cover-full" style="background-image:url('${esc(coverUrl)}')" aria-hidden="true"></div>
                  <!-- id propre (lt-qr-btn) : « hm-qr-btn » entrait en COLLISION avec le
                       bouton QR du header (app.js) — querySelector accrochait alors le
                       handler « QR profil » sur le bouton du header → 2 QR au clic. -->
                  <button type="button" class="lt-qr" id="lt-qr-btn" aria-label="${t("home_show_qr")}" title="${t("home_my_qr")}">${icon("qr", 18)}</button>
                  <div class="lt-identity">
                    ${hmDisplayName ? `<div class="lt-name">${esc(hmDisplayName)}</div>` : ""}
                    <div class="lt-handle${hmDisplayName ? "" : " lt-name"}">@${esc(data.handle)}</div>
                    ${hmTitle ? `<div class="lt-role">${esc(hmTitle)}</div>` : ""}
                    ${hmLocation ? `<div class="lt-loc">${icon("pin", 13)} ${esc(hmLocation)}</div>` : ""}
                  </div>
                </section>

                <!-- Écran 2 : Galerie — montée via le plugin (repli si vide), cf. wireEditor -->
                <section class="lt-screen lt-screen--pad" data-screen="gallery" aria-label="${t("home_gallery")}">
                  <div class="lt-screen-h">${icon("image", 18)} ${t("home_gallery")}</div>
                  <div id="lt-gallery-slot" class="lt-gallery-slot"></div>
                </section>

              </div>
              <!-- Indicateur de pagination — colonne verticale sur le bord droit de l'écran -->
              <div class="lt-dots" id="lt-dots" role="tablist" aria-label="${t("home_preview_screens")}">
                <button type="button" class="lt-dot is-on" data-go="0" aria-label="${t("home_screen_home")}"></button>
                <button type="button" class="lt-dot" data-go="1" aria-label="${t("home_gallery")}"></button>
              </div>
            </div>
          </div>

          <!-- Réglages de visibilité + visite : contrôles d'édition, hors téléphone -->
          <div class="lt-config lt-controls">
            <div class="lt-config-title">${t("home_visible_public")}</div>
            <div class="hm-privacy-toggles">
              <label class="hm-toggle">
                <span class="hm-toggle-ic">${icon("user", 14)}</span>
                <span class="hm-toggle-label">${t("home_profile_public")}</span>
                <input type="checkbox" data-setting="profile_public" ${hmProfilePublic ? "checked" : ""}>
                <span class="hm-toggle-sw"></span>
              </label>
              <label class="hm-toggle">
                <span class="hm-toggle-ic">${icon("image", 14)}</span>
                <span class="hm-toggle-label">${t("home_gallery_public")}</span>
                <input type="checkbox" data-setting="gallery_public" ${hmGalleryPublic ? "checked" : ""}>
                <span class="hm-toggle-sw"></span>
              </label>
            </div>

            <button type="button" class="lt-tour" id="hm-tour-btn" title="${t("home_tour_title")}">${t("home_redo_tour")}</button>
          </div><!-- /lt-controls -->
          </div><!-- /lt-phone-cols -->
        </section>

        <!-- ===== DROITE : coup d'œil / back-office ===== -->
        <aside class="hm-aside">

          <!-- Accès direct à l'Espace Premium (création/édition des pages réservées).
               Premium seulement : sans abonnement, le bloc « Passe en Premium » ci-dessous
               suffit comme point d'entrée vers la mise à niveau. -->
          ${isPrem ? `
            <a href="/me/premium" class="hm-space-card" aria-label="${t("home_open_premium_space")}">
              <span class="hm-space-ic">${icon("lock", 22)}</span>
              <div class="hm-space-body">
                <b>${t("home_my_private_space")}</b>
                <span>${t("home_private_space_sub")}</span>
              </div>
              <span class="hm-space-arrow" aria-hidden="true">→</span>
            </a>` : ""}

          <!-- Bloc Premium dédié -->
          ${isPrem
            ? `<div class="hm-prem-card hm-prem-card--active">
                <div class="hm-prem-hd">
                  <span class="hm-prem-ic">${icon("sparkles", 16)}</span>
                  <div>
                    <div class="hm-prem-title">${t("home_customization")} <span class="hm-badge premium" style="vertical-align:middle">${icon("sparkles", 10)} Premium</span></div>
                  </div>
                </div>
                <div class="lt-prem-row">
                  <span class="lt-prem-label">${icon("image", 14)} ${t("home_cover_label")}</span>
                  <div class="lt-prem-actions">
                    <label class="btn sm">${icon("image", 13)} ${t("home_choose")}<input type="file" id="cover-file" accept="image/*,video/mp4,video/webm" hidden></label>
                    ${data.cover ? `<button type="button" class="btn sm danger" id="cover-remove">${t("home_remove")}</button>` : ""}
                  </div>
                </div>
                <div class="lt-prem-row lt-prem-col">
                  <span class="lt-prem-label">${icon("link", 14)} ${t("home_custom_buttons")}</span>
                  <div id="pb-list" class="pb-list">${(data.buttons || []).map((b) => pbRowHtml(b)).join("")}</div>
                  <div class="lt-prem-actions">
                    <button type="button" class="btn sm" id="pb-add">${t("home_add")}</button>
                    <button type="button" class="btn sm primary" id="pb-save">${t("home_save")}</button>
                  </div>
                </div>
              </div>`
            : `<div class="hm-prem-card">
                <div class="hm-prem-hd">
                  <span class="hm-prem-ic">${icon("sparkles", 22)}</span>
                  <div>
                    <div class="hm-prem-title">${t("home_go_premium_title")}</div>
                    <div class="hm-prem-sub">${t("home_go_premium_sub")}</div>
                  </div>
                  <span class="hm-badge premium" style="margin-left:auto;flex-shrink:0">${t("home_price_month")}</span>
                </div>
                <ul class="hm-prem-features">
                  <li>${t("home_feat_cover")}</li>
                  <li>${t("home_feat_buttons")}</li>
                  <li>${t("home_feat_network")}</li>
                </ul>
                <button type="button" class="btn primary" id="lt-go-premium" style="width:100%;justify-content:center">${icon("sparkles", 14)} ${t("home_go_premium_btn")}</button>
              </div>`
          }

          <div class="hm-section">
            <div class="hm-section-title">${t("home_at_a_glance")}</div>
            <div class="hm-stats-grid">
              <div class="hm-stat" data-goto="Relations"><b>${_deg1.length}</b><span>${t("home_connections")}</span></div>
              <div class="hm-stat" data-goto="Notifications"><b>${data.unread || 0}</b><span>${t("home_unread")}</span></div>
            </div>
          </div>

          <div class="hm-section">
            <div class="hm-section-title">${t("home_recent_activity")} <a data-goto="Notifications" href="#">${t("home_see_all")}</a></div>
            ${hmNotifs.length ? `<div class="hm-activity">${hmNotifs.map(hmActivityRow).join("")}</div>` : `<div class="hm-empty">${t("home_no_activity")}</div>`}
          </div>
        </aside>
      </div>
    </div>`;
}
