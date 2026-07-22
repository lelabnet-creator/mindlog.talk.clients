// editor/tabs/options.js — Préférences de comportement de l'application :
// confidentialité, messagerie & appels, agenda & RDV.
// L'administration du compte (abonnement, sécurité, accès, données) se trouve
// dans l'onglet « Mon compte » (account.js).
import { DEFAULT_SETTINGS, DOW_LETTERS, DOW_NAMES, isDev, normalizeAvailability } from "../../core.js";
import { swatchesHtml } from "../../theme.js";
import { esc } from "../../ui/dom.js";
import { icon } from "../../ui/icons.js";
import { t } from "../../i18n.js";

export function renderOptionsColumn(data) {
  const s = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  const mkToggle = (key, name, desc, checked) =>
    `<label class="opt-row">
      <span class="opt-text"><span class="opt-name">${esc(name)}</span><span class="opt-desc">${esc(desc)}</span></span>
      <input type="checkbox" class="opt-toggle" data-setting="${key}" ${checked ? "checked" : ""} />
      <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
    </label>`;

  return `<div class="card opt-v2">
    <div class="opt-v2-search-wrap">
      <input id="opt-search" class="opt-search" type="search" placeholder="${t("opts_search_placeholder")}" autocomplete="off" aria-label="${t("opts_search_aria")}" />
    </div>
    <div class="opt-v2-grid" id="opt-v2-grid">

      <div class="opt-v2-block opt-v2-block--full">
        <div class="opt-v2-head">${icon("sparkles", 16)} ${t("opts_milo_color")}</div>
        <p class="lbl-sm" style="margin:.4rem 0 .65rem">${t("opts_ui_accent")}</p>
        <div class="opt-swatches" id="opt-swatches">${swatchesHtml()}</div>
      </div>

      <div class="opt-v2-block">
        <div class="opt-v2-head">${icon("shield", 16)} ${t("opts_privacy_head")}</div>
        <div class="opt-list">
          ${mkToggle("profile_public",      t("opts_profile_public_name"), t("opts_profile_public_desc"), data.settings?.profile_public !== false)}
          ${mkToggle("public_availability", t("opts_agenda_public_name"),  t("opts_agenda_public_desc"),  data.settings?.public_availability !== false)}
          ${mkToggle("gallery_public",      t("opts_gallery_public_name"), t("opts_gallery_public_desc"), data.settings?.gallery_public !== false)}
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem">
          <button type="button" class="btn sm" id="hm-tour-btn">${t("opts_tour_btn")}</button>
        </div>
      </div>

      <div class="opt-v2-block">
        <div class="opt-v2-head">${icon("chat", 16)} ${t("opts_messaging_head")}</div>
        <div class="opt-list">
          ${mkToggle("allow_chat",  t("opts_chat_name"),  t("opts_chat_desc"),  s.allow_chat)}
          ${mkToggle("allow_call",  t("opts_call_name"),  t("opts_call_desc"),  s.allow_call)}
          ${mkToggle("allow_video", t("opts_video_name"), t("opts_video_desc"), s.allow_video !== false)}
        </div>
      </div>

      <div class="opt-v2-block">
        <div class="opt-v2-head">${icon("calendar", 16)} ${t("opts_calendar_head")}</div>
        <div class="opt-list">
          ${mkToggle("allow_requests", t("opts_requests_name"), t("opts_requests_desc"), s.allow_requests)}
        </div>
        <p class="lbl-sm" style="margin:.8rem 0 .3rem">${t("opts_default_days")}</p>
        <div class="avail-days" id="avail-days" role="group">
          ${DOW_LETTERS.map((d, i) => `<button type="button" class="avail-day ${normalizeAvailability(s.availability).weekdays[i] ? "on" : ""}" data-dow="${i}" aria-pressed="${normalizeAvailability(s.availability).weekdays[i]}" title="${DOW_NAMES[i]}">${d}</button>`).join("")}
        </div>
      </div>

      ${isDev ? `
      <div class="opt-v2-block opt-v2-block--full opt-v2-dev">
        <div class="opt-v2-head">${icon("code", 16)} ${t("opts_dev_head")} <span class="opt-dev-badge">DEV</span></div>
        <p class="lbl-sm" style="margin:0 0 .65rem">${t("opts_dev_intro")}</p>
        <label class="opt-row">
          <span class="opt-text">
            <span class="opt-name">${icon("sparkles", 14)} ${t("opts_dev_premium_name")}</span>
            <span class="opt-desc">${t("opts_dev_premium_desc")}</span>
          </span>
          <input type="checkbox" class="opt-toggle" id="dev-toggle-premium" ${(data.subscription?.plan === "premium" || data.plan === "premium") ? "checked" : ""} />
          <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
        </label>

        <div class="opt-dev-subs">
          <div class="opt-name" style="display:flex;align-items:center;gap:.4rem;margin-top:.2rem">
            ${icon("users", 14)} ${t("opts_dev_space_subs_title")}
          </div>
          <p class="lbl-sm" style="margin:.2rem 0 .55rem">${t("opts_dev_space_subs_desc")}</p>
          <ul id="dev-space-subs" class="opt-dev-list">
            <li class="lbl-sm">${t("com_loading")}</li>
          </ul>
          <div class="opt-dev-sub-add">
            <input type="text" id="dev-space-add-handle" placeholder="${t("opts_dev_space_add_placeholder")}" autocomplete="off" />
            <button type="button" class="btn sm" id="dev-space-add-btn">${t("opts_dev_space_add_btn")}</button>
          </div>
        </div>
      </div>` : ""}

    </div>
  </div>`;
}
