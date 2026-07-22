// editor/tabs/premium.js — « Espace Premium » : page dédiée regroupant TOUTES
// les fonctions premium (abonnement/facturation, couverture, boutons
// personnalisés, pages payantes, liens galerie). Ouverte via le bouton
// « Gérer » du bandeau d'abonnement (route /me/premium → renderPremiumFull dans index.js).
// Code premium → exclu du miroir OSS (cf. .oss-exclude).
import { esc } from "../../ui/dom.js";
import { icon } from "../../ui/icons.js";
import { localPrice, tagChipsHtml } from "../../app.js";
import { t } from "../../i18n.js";

// Catalogue d'icônes proposées (datalist d'auto-complétion).
export const PB_ICON_HINTS = ["link", "mail", "phone", "calendar", "chat", "image", "user", "users", "tag", "sparkles", "shield", "lock", "send", "zap", "pin", "smartphone", "home", "code"];

// Ligne complète d'un bouton personnalisé : icône (avec preview live) + libellé +
// URL + forme (◯/▢) + toggle affichage du libellé (Aa). pos_x/pos_y sont
// conservés via data-attributes (le drag se fait sur la page publique).
export const pbRowHtml = (b = {}) => {
  const shape = b.shape === "square" ? "square" : "circle";
  const showLbl = !!b.show_label;
  const px = typeof b.pos_x === "number" ? b.pos_x : 0.5;
  const py = typeof b.pos_y === "number" ? b.pos_y : 0.9;
  return `<div class="pb-row" data-x="${px}" data-y="${py}">
    <span class="pb-prev-ic">${icon(b.icon || "link", 16)}</span>
    <input class="pb-icon" list="pb-icon-list" placeholder="${t("prem_ph_icon")}" maxlength="24" value="${esc(b.icon || "")}">
    <input class="pb-label" placeholder="${t("prem_ph_label")}" maxlength="80" value="${esc(b.label || "")}">
    <input class="pb-url" type="url" placeholder="https://…" maxlength="2000" value="${esc(b.url || "")}">
    <button type="button" class="pb-shape" data-shape="${shape}" title="${t("prem_shape")}">${shape === "square" ? "▢" : "◯"}</button>
    <button type="button" class="pb-showlbl ${showLbl ? "on" : ""}" data-on="${showLbl ? "1" : "0"}" title="${t("prem_show_label")}">Aa</button>
    <button type="button" class="pb-del" title="${t("prem_remove")}">✕</button>
  </div>`;
};

export function renderPremiumPage(data) {
  const sub = data.subscription || { plan: data.plan || "free", status: "none", premiumUntil: null, cancelAtPeriodEnd: false };
  const pastDue = sub.status === "past_due";
  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  };

  // Page plein écran (vue "premium") : barre supérieure avec bouton Retour, puis
  // contenu défilant. Pas une colonne du deck ni une modale → scroll normal.
  return `<div class="prem-page-view">
    <header class="prem-topbar">
      <button type="button" class="back-btn" id="prem-back" aria-label="${t("prem_back_aria")}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        <span>${t("com_back")}</span>
      </button>
      <span class="prem-topbar-title">${icon("sparkles", 16)} ${t("prem_my_spaces")}</span>
    </header>
    <div class="col-scroll prem-body">

      <!-- ── Menu de navigation top-level : 2 sections au même rang.
           "Pages privées" regroupe abonnement + espace privé (monétisation).
           "Personnalisation" regroupe les customisations de /@handle.         -->
      <nav class="prem-tabs" role="tablist" aria-label="${t("prem_sections")}">
        <button type="button" class="prem-tab-btn is-active" role="tab" aria-selected="true" data-prem-tab="premium">
          ${icon("lock", 14)} <span>${t("prem_private_pages")}</span>
        </button>
        <button type="button" class="prem-tab-btn" role="tab" aria-selected="false" data-prem-tab="public">
          ${icon("user", 14)} <span>${t("prem_perso")}</span>
        </button>
      </nav>

      <!-- ────────────────────────────────────────────────────────────────── -->
      <!-- Pane 2 — Mon espace privé (bénéfices + monétisation)               -->
      <!-- ────────────────────────────────────────────────────────────────── -->
      <section class="prem-pane" id="prem-pane-space" role="tabpanel" data-prem-pane="premium" hidden>
      ${(() => {
        const benefits = data.space?.benefits || { chat: true, call: true, pages: true, rdv: true, lives: true };
        const item = (key, iconName, title, desc, opts = {}) => `
          <label class="prem-benefit" data-key="${key}" ${opts.lockedReason ? `data-locked="${esc(opts.lockedReason)}"` : ""}>
            <input type="checkbox" class="prem-benefit-cb" name="${key}" ${benefits[key] ? "checked" : ""} ${opts.lockedReason ? "disabled" : ""}>
            <span class="prem-benefit-card">
              <span class="prem-benefit-ic">${icon(iconName, 16)}</span>
              <span class="prem-benefit-text">
                <b>${title}${opts.suffix || ""}</b>
                <span>${desc}</span>
              </span>
              <span class="prem-benefit-check" aria-hidden="true">${icon("shield", 14)}</span>
            </span>
          </label>`;
        return `<section class="prem-benefits" aria-labelledby="prem-benefits-h">
          <div class="prem-benefits-head">
            <span class="prem-benefits-ic">${icon("sparkles", 18)}</span>
            <div>
              <h2 id="prem-benefits-h" class="prem-benefits-title">${t("prem_space_unlocks")}</h2>
              <p class="prem-benefits-sub">${t("prem_space_choose")}</p>
            </div>
            <span id="prem-benefits-status" class="lbl-sm" style="opacity:.7" aria-live="polite"></span>
          </div>
          <div class="prem-benefits-list">
            ${item("chat",  "chat",       t("prem_benefit_chat_t"),   t("prem_benefit_chat_d"))}
            ${item("call",  "smartphone", t("prem_benefit_call_t"),   t("prem_benefit_call_d"))}
            ${item("pages", "lock",       t("prem_benefit_pages_t"),  t("prem_benefit_pages_d"))}
            ${item("rdv",   "calendar",   t("prem_benefit_rdv_t"),    t("prem_benefit_rdv_d"))}
            ${item("lives", "users",      t("prem_benefit_lives_t"),  t("prem_benefit_lives_d"), { suffix: ` <span class="lbl-sm" style="opacity:.7">${t("prem_coming_soon")}</span>` })}
          </div>
        </section>`;
      })()}
      </section><!-- /Pane 2 (1ère partie : hero bénéfices) -->

      <!-- ────────────────────────────────────────────────────────────────── -->
      <!-- Pane 1 — Mon abonnement Premium (visible par défaut)               -->
      <!-- ────────────────────────────────────────────────────────────────── -->
      <section class="prem-pane is-active" id="prem-pane-subscription" role="tabpanel" data-prem-pane="premium">
      <h3 class="prem-section-title">${icon("tag", 14)} ${t("prem_my_subscription")}</h3>
      <div class="opt-v2-grid">
        <div class="opt-v2-block opt-v2-account">
          <div class="opt-v2-head">${icon("tag", 16)} ${t("prem_subscription")}</div>
          <div class="acc-sub-banner acc-sub-banner--premium" style="margin:0 0 1rem">
            <span class="acc-sub-banner-ic">${icon("sparkles", 15)}</span>
            <div class="acc-sub-banner-body">
              <b>${t("prem_active")}</b>
              ${sub.premiumUntil ? `<span>${sub.cancelAtPeriodEnd ? t("prem_ends_on") : t("prem_active_until")} ${esc(fmtDate(sub.premiumUntil))}</span>` : ""}
            </div>
            <button class="btn sm" id="prem-portal">${pastDue ? t("prem_update_card") : t("prem_manage_billing")}</button>
          </div>

          <!-- Avantages débloqués par mon abonnement Premium (utilisateur, pas abonnés) -->
          <p class="lbl-sm" style="margin:0 0 .55rem;opacity:.85"><b>${t("prem_perks_for_you")}</b></p>
          <div class="prem-perks-list">

            <!-- Profil hors annuaire : seul vrai toggle, persisté via /api/me/settings -->
            <label class="prem-perk" data-key="listed_in_directory">
              <input type="checkbox" class="prem-perk-cb" id="prem-perk-hidden" name="hidden_from_directory"
                ${data.settings?.listed_in_directory === false ? "checked" : ""}>
              <span class="prem-perk-card">
                <span class="prem-perk-ic">${icon("eye-off", 16)}</span>
                <span class="prem-perk-text">
                  <b>${t("prem_hidden_dir_t")}</b>
                  <span>${t("prem_hidden_dir_d")}</span>
                </span>
                <span class="prem-perk-check" aria-hidden="true">${icon("shield", 14)}</span>
              </span>
            </label>

            <!-- Capability marker : recherche par tags. Pas de toggle (toujours actif). -->
            <div class="prem-perk prem-perk--info">
              <span class="prem-perk-card">
                <span class="prem-perk-ic">${icon("tag", 16)}</span>
                <span class="prem-perk-text">
                  <b>${t("prem_tag_search_t")}</b>
                  <span>${t("prem_tag_search_d")}</span>
                </span>
                <span class="prem-perk-badge">${t("prem_included")}</span>
              </span>
            </div>

            <!-- Capability marker : moteur de recherche avancée. -->
            <div class="prem-perk prem-perk--info">
              <span class="prem-perk-card">
                <span class="prem-perk-ic">${icon("search", 16)}</span>
                <span class="prem-perk-text">
                  <b>${t("prem_adv_search_t")}</b>
                  <span>${t("prem_adv_search_d")}</span>
                </span>
                <span class="prem-perk-badge">${t("prem_included")}</span>
              </span>
            </div>

          </div>
          <span id="prem-perks-status" class="lbl-sm" style="margin-top:.4rem;display:block;opacity:.7" aria-live="polite"></span>
        </div>
      </div>

      </section><!-- /Pane 1 -->

      <!-- ────────────────────────────────────────────────────────────────── -->
      <!-- Pane 2 (suite) — Mon espace privé : monétisation                   -->
      <!-- ────────────────────────────────────────────────────────────────── -->
      <section class="prem-pane" role="tabpanel" data-prem-pane="premium" hidden>
      <h3 class="prem-section-title">${icon("lock", 14)} ${t("prem_my_space")} <span class="prem-section-sub">${t("prem_monetization")}</span></h3>
      <div class="opt-v2-grid">

        <!-- Tarif : pleine largeur, c'est la pièce maîtresse. -->
        <div class="opt-v2-block opt-v2-account" id="sp-block">
          <div class="opt-v2-head">${icon("tag", 16)} ${t("prem_sub_price")}</div>
          <p class="lbl-sm" style="margin:0 0 .5rem;line-height:1.5">${t("prem_sub_price_d")}</p>
          <div id="pp-connect" class="lbl-sm" style="margin:0 0 .6rem">${t("com_loading")}</div>
          <div class="sp-price-row" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
            <label class="lbl-sm" for="sp-price" style="margin:0">${t("prem_monthly_price")}</label>
            <input id="sp-price" type="number" min="1" step="0.01" placeholder="9.99" style="width:7rem">
            <span class="lbl-sm">${t("prem_per_month")}</span>
            <button class="btn primary sm" id="sp-save">${t("prem_save")}</button>
            <span id="sp-status" class="lbl-sm" style="margin-left:auto;opacity:.7" aria-live="polite"></span>
          </div>
        </div>

        <!-- Intro de l'espace : pleine largeur (textarea trop étroite à 1/2). -->
        <div class="opt-v2-block opt-v2-block--full" id="sp-intro-block">
          <div class="opt-v2-head">${icon("chat", 16)} ${t("prem_space_intro")}</div>
          <p class="lbl-sm" style="margin:0 0 .5rem;line-height:1.5">
            ${t("prem_intro_shown").replace("{handle}", esc(data?.handle || "moi"))}
          </p>
          <textarea id="sp-intro" class="sp-intro-ta"
            maxlength="4000" rows="4"
            placeholder="${t("prem_intro_ph")}"></textarea>
          <div class="lt-prem-actions" style="margin-top:.5rem;align-items:center">
            <button class="btn primary sm" id="sp-intro-save">${t("prem_save")}</button>
            <span id="sp-intro-status" class="lbl-sm" style="margin-left:auto;opacity:.7" aria-live="polite"></span>
          </div>
        </div>

        <!-- Bloc « Lives en direct » retiré : on entre dans le mode broadcast
             via le rail Échanges → Live (sous-mode du chat) ou directement
             depuis /me/broadcast. Inutile de dupliquer ici. -->

        <!-- Le stockage tiers se gère dans Compte → Stockage (un seul endroit). -->

        <!-- Pages : pleine largeur (liste + wizard prennent de la place). -->
        <div class="opt-v2-block opt-v2-block--full" id="pp-block">
          <div class="opt-v2-head">
            ${icon("image", 16)} ${t("prem_reserved_pages")}
            <span class="lbl-sm" id="pp-count" style="margin-left:auto;opacity:.6"></span>
          </div>
          <p class="lbl-sm" style="margin:0 0 .5rem;line-height:1.5">${t("prem_reserved_pages_d")}</p>
          <div id="pp-pages" style="margin:.4rem 0 .6rem"></div>
          <button type="button" class="btn primary sm" id="pp-add-btn">${t("prem_add_page")}</button>

          <!-- Workflow d'ajout : étape 1 (type) puis étape 2 (formulaire). Caché par défaut. -->
          <div id="pp-wizard" class="pp-wizard" hidden>
            <div class="pp-wiz-step" data-step="type">
              <div class="opt-v2-head" style="margin-top:.8rem">${t("prem_choose_page_type")}</div>
              <div class="pp-type-grid">
                <button type="button" class="pp-type-card" data-type="markdown">
                  <span class="pp-type-ic">${icon("chat", 22)}</span>
                  <b>${t("prem_type_md_t")}</b>
                  <span class="lbl-sm">${t("prem_type_md_d")}</span>
                </button>
                <button type="button" class="pp-type-card" data-type="gallery">
                  <span class="pp-type-ic">${icon("image", 22)}</span>
                  <b>${t("prem_type_gallery_t")}</b>
                  <span class="lbl-sm">${t("prem_type_gallery_d")}</span>
                </button>
                <button type="button" class="pp-type-card" data-type="link">
                  <span class="pp-type-ic">${icon("link", 22)}</span>
                  <b>${t("prem_type_link_t")}</b>
                  <span class="lbl-sm">${t("prem_type_link_d")}</span>
                </button>
                <button type="button" class="pp-type-card" data-type="file">
                  <span class="pp-type-ic">${icon("download", 22)}</span>
                  <b>${t("prem_type_file_t")}</b>
                  <span class="lbl-sm">${t("prem_type_file_d")}</span>
                </button>
              </div>
              <div style="margin-top:.6rem"><button type="button" class="btn sm" data-wiz-cancel>${t("com_cancel")}</button></div>
            </div>
            <div class="pp-wiz-step" data-step="form" hidden>
              <div class="opt-v2-head pp-form-head" id="pp-form-head">${t("prem_new_page")}</div>
              <form class="pp-form" autocomplete="off" novalidate>

                <div class="pp-field">
                  <label class="pp-label" for="pp-title">${t("prem_title")} <span class="pp-required" aria-hidden="true">*</span></label>
                  <input id="pp-title" type="text" placeholder="${t("prem_title_ph")}" maxlength="200" required aria-required="true">
                </div>

                <div class="pp-field">
                  <label class="pp-label" for="pp-slug">${t("prem_page_address")} <span class="pp-required" aria-hidden="true">*</span></label>
                  <div class="pp-slug-row">
                    <span class="pp-slug-prefix" aria-hidden="true">/@${esc(data?.handle || "moi")}/p/</span>
                    <input id="pp-slug" type="text" placeholder="${t("prem_slug_ph")}" maxlength="48" pattern="[a-z0-9][a-z0-9-]*" inputmode="url" required aria-required="true" aria-describedby="pp-slug-help">
                  </div>
                  <p class="pp-help" id="pp-slug-help">${t("prem_slug_help")}</p>
                </div>

                <div class="pp-field pp-field--content">
                  <span class="pp-label">${t("prem_content")}</span>
                  <!-- Champs spécifiques au type (injectés par JS dans #pp-type-fields) -->
                  <div id="pp-type-fields"></div>
                </div>

                <div class="pp-field pp-field--publish">
                  <label class="pp-toggle" for="pp-pub">
                    <input type="checkbox" id="pp-pub" class="pp-toggle-input">
                    <span class="pp-toggle-track"><span class="pp-toggle-thumb"></span></span>
                    <span class="pp-toggle-text">
                      <span class="pp-toggle-title">${t("prem_publish_now")}</span>
                      <span class="pp-toggle-desc">${t("prem_publish_desc")}</span>
                    </span>
                  </label>
                </div>

                <div class="pp-actions">
                  <button type="button" class="btn sm pp-actions-secondary" data-wiz-back>${t("prem_change_type")}</button>
                  <button type="button" class="btn sm pp-actions-secondary" data-wiz-cancel>${t("com_cancel")}</button>
                  <button type="button" class="btn primary pp-actions-primary" id="pp-save">${t("prem_save_page")}</button>
                </div>
              </form>
            </div>
          </div>
        </div>

      </div>

      </section><!-- /Pane 2 (suite) -->

      <!-- ────────────────────────────────────────────────────────────────── -->
      <!-- Pane 3 — Personnalisation (customisations Premium de /@handle)      -->
      <!-- ────────────────────────────────────────────────────────────────── -->
      <section class="prem-pane" id="prem-pane-profile" role="tabpanel" data-prem-pane="public" hidden>
      ${data.plan !== "premium" ? `
        <!-- ─── Compte non-Premium → bandeau upsell + CTA essai gratuit ─── -->
        <div class="prem-upsell">
          <div class="prem-upsell-head">
            <span class="prem-upsell-ic">${icon("sparkles", 22)}</span>
            <div>
              <h3 class="prem-upsell-title">${t("prem_upsell_title").replace("{handle}", esc(data?.handle || "moi"))}</h3>
              <p class="prem-upsell-sub">${t("prem_upsell_sub")}</p>
            </div>
          </div>
          <ul class="prem-upsell-list">
            <li>${icon("image", 14)} <span>${t("prem_upsell_cover")}</span></li>
            <li>${icon("tag", 14)} <span>${t("prem_upsell_tags")}</span></li>
            <li>${icon("link", 14)} <span>${t("prem_upsell_buttons")}</span></li>
            <li>${icon("image", 14)} <span>${t("prem_upsell_gallery")}</span></li>
            <li>${icon("lock", 14)} <span>${t("prem_upsell_private")}</span></li>
          </ul>
          <div class="prem-upsell-actions">
            <button type="button" class="btn primary" id="prem-upsell-trial">
              ${icon("sparkles", 14)} ${t("prem_start_trial")}
              <span class="prem-upsell-trial-sub">${t("prem_trial_sub").replace("{price}", (() => { const p = localPrice(); return `${p.primary}${p.per}`; })())}</span>
            </button>
            <span id="prem-upsell-status" class="lbl-sm" style="margin-left:auto;opacity:.75" aria-live="polite"></span>
          </div>
        </div>
      ` : `
      <h3 class="prem-section-title">${icon("user", 14)} ${t("prem_perso")} <span class="prem-section-sub">${t("prem_perso_sub")}</span></h3>
      <p class="lbl-sm" style="margin:0 0 .9rem;line-height:1.5;opacity:.85">
        ${t("prem_perso_intro").replace("{handle}", esc(data?.handle || "moi"))}
      </p>
      <div class="opt-v2-grid">

        <!-- Couverture : pleine largeur. Feature Premium (TODO backend gating). -->
        <div class="opt-v2-block opt-v2-block--full">
          <div class="opt-v2-head">${icon("image", 16)} ${t("prem_cover")}</div>
          <p class="lbl-sm" style="margin:0 0 .6rem;line-height:1.5">${t("prem_cover_d")}</p>
          <div class="lt-prem-actions">
            <label class="btn sm" style="cursor:pointer">${icon("image", 13)} ${t("prem_choose")}<input type="file" id="cover-file" accept="image/*,video/mp4,video/webm" hidden></label>
            ${data.cover ? `<button type="button" class="btn sm danger" id="cover-remove">${t("prem_remove")}</button>` : ""}
          </div>
        </div>

        <!-- Tags du profil : pleine largeur. Feature Premium (TODO backend gating). -->
        <div class="opt-v2-block opt-v2-block--full" id="prem-tags-block">
          <div class="opt-v2-head">${icon("tag", 16)} ${t("prem_profile_tags")} <span class="lbl-sm" id="prem-tags-count" style="margin-left:auto;opacity:.6">${(data.tags || []).length}/20</span></div>
          <p class="lbl-sm" style="margin:0 0 .6rem;line-height:1.5">${t("prem_profile_tags_d")}</p>
          <div class="tags-edit" id="prem-tags-edit">${tagChipsHtml(data.tags || [], true)}</div>
          <div class="add-row tag-add-row" style="margin-top:.6rem;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
            <input id="prem-tag-input" placeholder="${t("prem_tag_input_ph")}" maxlength="30" autocomplete="off" style="flex:1;min-width:10rem">
            <button type="button" class="btn primary sm" id="prem-add-tag">${t("prem_add_tag_btn")}</button>
            <span id="prem-tag-status" class="lbl-sm" style="margin-left:auto;opacity:.7" aria-live="polite"></span>
          </div>
        </div>

        <!-- Boutons personnalisés : pleine largeur (souvent plusieurs lignes). -->
        <div class="opt-v2-block opt-v2-account">
          <div class="opt-v2-head">${icon("link", 16)} ${t("prem_custom_buttons")} <span class="lbl-sm" id="pb-count" style="margin-left:auto;opacity:.6">${(data.buttons || []).length}/5</span></div>
          <p class="lbl-sm" style="margin:0 0 .5rem;line-height:1.5">${t("prem_custom_buttons_d")}</p>
          <datalist id="pb-icon-list">${PB_ICON_HINTS.map(k => `<option value="${k}">`).join("")}</datalist>
          <div id="pb-list" class="pb-list">${(data.buttons || []).map((b) => pbRowHtml(b)).join("")}</div>
          <div class="lt-prem-actions" style="margin-top:.5rem;align-items:center">
            <button type="button" class="btn sm" id="pb-add">${t("prem_add")}</button>
            <a class="btn sm" href="/@${esc(data.handle)}" target="_blank" rel="noopener noreferrer">${t("prem_view_page")}</a>
            <span id="pb-status" class="lbl-sm" style="margin-left:auto;opacity:.7" aria-live="polite"></span>
          </div>
        </div>

        <!-- Galerie cliquable : pleine largeur. Feature Premium (raccourci vers
             l'onglet Galerie qui gère l'ajout de liens). -->
        <div class="opt-v2-block opt-v2-account">
          <div class="opt-v2-head">${icon("image", 16)} ${t("prem_clickable_gallery")}</div>
          <p class="lbl-sm" style="margin:0 0 .5rem;line-height:1.5">${t("prem_clickable_gallery_d")}</p>
          <button type="button" class="btn sm" id="prem-go-gallery">${icon("image", 13)} ${t("prem_open_gallery")}</button>
        </div>

      </div>
      `}
      </section><!-- /Pane 3 -->
    </div>
  </div>`;
}
