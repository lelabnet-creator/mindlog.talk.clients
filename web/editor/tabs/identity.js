// editor/tabs/identity.js — colonne « Identité » (profil / réseaux / compte).
// Builder de rendu pur (câblage dans wireEditor). Extrait verbatim.
// cf. docs/web-app-split-proposal.md
import { icon, isSocialKey } from "../../ui/icons.js";
import { esc } from "../../ui/dom.js";
import { appState } from "../../state.js";
import { t } from "../../i18n.js";

export function renderIdentityColumn(data, { photo, fieldEditHtml, socialEditHtml }) {
  // « Date de naissance » est un attribut PERMANENT : toujours présent dans la liste
  // (champ date), synthétisé s'il n'existe pas encore côté serveur (sauvegardé au
  // premier remplissage). Plus de bouton preset à cliquer.
  const nonSocial = data.fields.filter((f) => !isSocialKey(f.key));
  const attrFields = nonSocial.some((f) => f.key === "birthday")
    ? nonSocial
    : [...nonSocial, { key: "birthday", label: t("idnt_birthday"), value: "", is_custom: 0, is_public: 1, visibility: "public" }];
  return `<div class="card">
      <div class="id-head">
        <label class="photo-wrap" for="photo-file" title="${t("idnt_change_photo")}"><span class="photo-frame">${photo}${
          data.hasVault
            ? `<span class="vault-badge" title="${t("idnt_vault_badge_title")}" aria-label="${t("idnt_vault_badge_aria")}">${icon("key", 13)}</span>`
            : ""
        }<span class="photo-edit" aria-hidden="true">${icon("camera", 18)}</span></span></label>
        <div class="id-head-body">
          <p class="handle">@${esc(data.handle)}</p>
          <div class="id-actions">
            <!-- Boutons photo masqués sur mobile (.id-hide-mobile) : l'avatar est
                 déjà tappable pour changer la photo (le label for=photo-file
                 déclenche l'input même si ce form est en display:none), et le
                 sélecteur natif propose l'appareil photo. L'input reste dans le
                 DOM pour que l'avatar fonctionne. -->
            <form id="photo-form" class="id-photo-form id-hide-mobile">
              <label class="btn" style="cursor:pointer" title="${t("idnt_change_photo")}" aria-label="${t("idnt_change_photo")}">${icon("user", 16)}<span class="btn-label"> ${t("idnt_change_photo")}</span>
                <input type="file" id="photo-file" name="photo" accept="image/*" hidden />
              </label>
              <button type="button" class="btn" id="take-photo-btn" title="${t("idnt_take_photo")}" aria-label="${t("idnt_take_photo")}">${icon("camera", 16)}<span class="btn-label"> ${t("idnt_take_photo")}</span></button>
            </form>
            <div class="id-actions-sec">
              <button class="btn sm" id="qr-btn">${icon("qr", 16)} QR</button>
              <a class="btn sm" href="${esc(data.publicUrl)}" target="_blank" rel="noopener noreferrer">${t("idnt_view")}</a>
            </div>
          </div>
        </div>
      </div>
      <div class="id-tabs" role="tablist" id="id-tabs">
        <button class="id-tab active" data-tab="profil" role="tab" aria-selected="true">${t("idnt_tab_profile")}</button>
        <button class="id-tab id-hide-mobile" data-tab="reseaux" role="tab" aria-selected="false">${icon("link", 14)} ${t("idnt_tab_networks")}</button>
      </div>
      <div class="col-scroll">
        <div class="id-panel" id="id-profil" role="tabpanel">
          <!-- Astuce mobile : l'édition ci-dessous est volontairement allégée
               (photo + intro + attributs de base). Le reste — champs perso,
               réseaux, réglages avancés — est plus confortable sur grand écran.
               Masquée en desktop via CSS (.mobile-web-hint). -->
          <div class="mobile-web-hint">
            <div class="mwh-head">${icon("code", 16)} <b>${t("idnt_full_ui_title")}</b></div>
            <p class="lbl-sm" style="margin:.25rem 0 .55rem;line-height:1.45">${t("idnt_full_ui_desc")}</p>
            <div class="url-row">
              <code style="font-size:.75rem;word-break:break-all">${esc(location.origin)}/app</code>
              <button class="btn copy" data-copy="${esc(location.origin)}/app">${t("com_copy")}</button>
            </div>
          </div>
          <div class="section-title" style="border-top:none;padding-top:0;margin-top:0">${t("idnt_intro_title")}</div>
          <p class="lbl-sm" style="margin:0 0 .5rem;line-height:1.5">
            ${t("idnt_intro_hint").replace("{handle}", esc(data.handle))}
          </p>
          <textarea id="sp-profile-intro" class="sp-intro-ta"
            maxlength="4000" rows="4"
            placeholder="${t("idnt_intro_placeholder")}">${esc(data.profile_intro_md || "")}</textarea>
          <div class="lt-prem-actions" style="margin:.35rem 0 .8rem;align-items:center;justify-content:flex-end">
            <span id="sp-profile-intro-status" class="lbl-sm" style="opacity:.7" aria-live="polite"></span>
          </div>
          <div class="section-title">${t("idnt_attributes")}</div>
          <div id="fields-edit">${attrFields.map(fieldEditHtml).join("")}</div>
          <div class="add-row id-hide-mobile" style="margin-top:.5rem;padding-bottom:.6rem">
            <input id="nf-label" placeholder="${t("idnt_label_placeholder")}" />
            <input id="nf-value" placeholder="${t("idnt_value_placeholder")}" />
            <button class="btn" id="add-field">${t("idnt_add")}</button>
          </div>
        </div>
        <div class="id-panel" id="id-reseaux" role="tabpanel" hidden>
          <p class="lbl-sm" style="margin:.2rem 0 .7rem;line-height:1.45">${t("idnt_networks_hint")}</p>
          <div id="socials-edit">${socialEditHtml(data.fields)}</div>
          <div style="padding-bottom:.6rem"></div>
        </div>
        <div class="id-panel" id="id-options" role="tabpanel" hidden style="display:none!important"><!-- déplacé → Options --></div>
        <div class="id-panel" id="id-compte" role="tabpanel" hidden style="display:none!important">
          <div class="acct-tabs" role="tablist" id="acct-tabs" hidden>

          <div class="acct-panel" id="acct-access" role="tabpanel">
            <label class="lbl-sm">${t("idnt_public_url")}</label>
            <div class="url-row" style="margin:.3rem 0 .8rem">
              <code style="font-size:.78rem;word-break:break-all">${esc(location.origin + data.publicUrl)}</code>
              <button class="btn copy" data-copy="${esc(location.origin + data.publicUrl)}">${t("com_copy")}</button>
            </div>

            <label class="lbl-sm">${t("idnt_invite_contact")}</label>
            <div class="add-row" style="grid-template-columns:1fr 1fr;margin:.3rem 0 .9rem">
              <button class="btn" id="gen-invite" title="${t("idnt_invite_title")}">${t("idnt_invite_btn")}</button>
              <button class="btn" id="open-groups" title="${t("idnt_groups_title")}">${t("idnt_groups_btn")}</button>
            </div>

            <label class="lbl-sm" for="rec-email">${t("idnt_recovery_email")}</label>
            <div class="add-row" style="grid-template-columns:1fr auto;margin-top:.3rem;margin-bottom:.9rem">
              <input id="rec-email" type="email" value="${esc(data.recoveryEmail || "")}" placeholder="${t("idnt_email_placeholder")}" />
              <button class="btn" id="save-rec">${t("idnt_save")}</button>
            </div>

            <label class="lbl-sm">${t("idnt_private_key")}</label>
            <div class="url-row" style="margin:.3rem 0 .4rem">
              <code id="key-display" style="font-size:.72rem;word-break:break-all;cursor:pointer" title="${t("idnt_toggle_key_title")}">••••••••••••</code>
              <button class="btn copy" id="copy-key" data-copy="${esc(appState.key)}">${t("com_copy")}</button>
            </div>
            <p class="lbl-sm" style="margin:.3rem 0 .5rem;line-height:1.45">${t("idnt_private_link_hint")}</p>
            <div style="display:flex;gap:.4rem;flex-wrap:wrap">
              <button class="btn sm" id="toggle-key">${icon("key",13)} ${t("idnt_show")}</button>
              <button class="btn sm danger" id="rotate-key">${icon("key",13)} ${t("idnt_regenerate")}</button>
            </div>
            <div style="padding-bottom:.6rem"></div>
          </div>

          <div class="acct-panel" id="acct-devices" role="tabpanel" hidden>
            <div class="section-title" style="border-top:none;padding-top:.3rem;margin-top:0">${t("idnt_active_sessions")}</div>
            <div id="sessions-list"><p class="lbl-sm">${t("com_loading")}</p></div>
            <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.6rem">
              <button class="btn sm" id="logout-btn">${icon("key",13)} ${t("idnt_logout")}</button>
              <button class="btn sm danger" id="logout-all-btn">${icon("key",13)} ${t("idnt_logout_all")}</button>
            </div>

            <div class="section-title" style="margin-top:1.2rem">${t("idnt_connect_phone")} <span class="badge-sm">${t("idnt_pin_badge")}</span></div>
            <p class="lbl-sm" style="margin:.2rem 0 .6rem;line-height:1.45">${t("idnt_pin_desc")}</p>
            <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
              <button class="btn sm" id="gen-pin-btn">${icon("key",13)} ${t("idnt_gen_pin")}</button>
              <code id="pin-display" style="font-size:1.15rem;letter-spacing:.25em;font-weight:600" hidden></code>
            </div>
            <p class="lbl-sm" id="pin-hint" style="margin:.4rem 0 0" hidden></p>

            <div class="section-title" style="margin-top:1.2rem">Passkeys <span class="badge-sm">${t("idnt_passkey_badge")}</span></div>
            <p class="lbl-sm" style="margin:.2rem 0 .7rem">${t("idnt_biometric_hint")}</p>
            <div id="passkey-list"></div>
            <div class="add-row" style="grid-template-columns:1fr auto;margin-top:.5rem">
              <input id="passkey-name" placeholder="${t("idnt_device_name_placeholder")}" maxlength="64" />
              <button class="btn primary" id="passkey-add">${icon("shield", 15)} ${t("idnt_create")}</button>
            </div>

            <div class="section-title" style="margin-top:1.2rem">${t("idnt_msg_encryption")} <span class="badge-sm">${t("idnt_portability_badge")}</span></div>
            <p class="lbl-sm" style="margin:.2rem 0 .6rem;line-height:1.45">${t("idnt_backup_key_hint")}</p>
            <div id="e2e-vault-status" class="lbl-sm" style="margin-bottom:.5rem">…</div>
            <div style="display:flex;gap:.4rem;flex-wrap:wrap">
              <button class="btn sm" id="e2e-passkey-save">${icon("shield", 13)} ${t("idnt_via_passkey")}</button>
              <button class="btn sm" id="e2e-pin-save">${icon("lock", 13)} ${t("idnt_pin_code")}</button>
              <button class="btn sm" id="e2e-pass-save">${icon("key", 13)} ${t("idnt_passphrase")}</button>
              <button class="btn sm" id="e2e-restore">${icon("download", 13)} ${t("idnt_restore")}</button>
            </div>
            <div style="padding-bottom:.6rem"></div>
          </div>

          <div class="acct-panel" id="acct-danger" role="tabpanel" hidden>
            <p class="lbl-sm" style="margin:.5rem 0 1rem;line-height:1.5">${t("idnt_danger_warning")}</p>
            <div style="display:flex;flex-direction:column;gap:.6rem">
              <button class="btn sm" id="export-data">${icon("download", 14)} ${t("idnt_export_data")}</button>
              <button class="btn sm danger" id="delete-account">${icon("trash", 14)} ${t("idnt_delete_account")}</button>
            </div>
            <div style="padding-bottom:.6rem"></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}
