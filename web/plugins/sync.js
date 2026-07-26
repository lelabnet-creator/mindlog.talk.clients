/* ============================================================================
 * Plugin : Synchronisation P2P inter-appareils (moteur crypto/sync.js) + UI Milo.
 * ----------------------------------------------------------------------------
 * - Monte l'orbe « Milo + ondes radio » pendant qu'une synchronisation est active.
 * - Fournit l'UI d'appairage (handoff de clé) vérifié par SAS emoji.
 * - Démarre le moteur d'anti-entropie et annonce la présence de cet appareil.
 * Exposé : host.sync.link() (lier ce nouvel appareil via un appareil approuvé).
 * ========================================================================== */
import { t } from "../i18n.js";
import { miloSvg } from "../ui/icons.js";
import { createSyncEngine } from "../crypto/sync.js";

export default function register(host) {
  const { esc, toast } = host;

  /* ----------------------------- Orbe Milo ------------------------------- */
  let dock = null, count = 0;
  function mountDock() {
    if (dock) return;
    dock = document.createElement("aside");
    dock.className = "sync-dock";
    dock.setAttribute("aria-live", "polite");
    dock.innerHTML = `
      <div class="sync-orb" role="status" aria-label="${esc(t("sync_active"))}">
        <span class="sync-wave"></span><span class="sync-wave"></span><span class="sync-wave"></span>
        <span class="sync-milo">${miloSvg(46)}</span>
      </div>
      <span class="sync-label">${esc(t("sync_active"))}</span>`;
    document.body.appendChild(dock);
  }
  const ui = {
    show() { count++; mountDock(); },
    hide() { count = 0; dock?.remove(); dock = null; },
  };

  /* -------------------------- UI d'appairage (SAS) ----------------------- */
  function linkModal(bodyHtml, { confirm } = {}) {
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true" style="max-width:420px;text-align:center">
        <button type="button" class="close" id="lk-x" aria-label="${esc(t("com_close"))}">✕</button>
        <div class="sync-orb sync-orb-sm" aria-hidden="true"><span class="sync-wave"></span><span class="sync-wave"></span>${miloSvg(40)}</div>
        ${bodyHtml}
        <div class="actions" style="justify-content:center;margin-top:1rem">
          ${confirm ? `<button class="btn primary" id="lk-ok">${esc(t("sync_sas_match"))}</button>` : ""}
          <button class="btn" id="lk-cancel">${esc(t("com_close"))}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("#lk-x").addEventListener("click", close);
    ov.querySelector("#lk-cancel").addEventListener("click", close);
    if (confirm) ov.querySelector("#lk-ok").addEventListener("click", () => { close(); confirm(); });
    return close;
  }
  let closeLink = null;
  const sasBlock = (sas) => `<h3>${esc(t("sync_link_title"))}</h3><p>${esc(t("sync_sas_help"))}</p><div class="sync-sas">${esc(sas)}</div>`;
  ui.linkWaiting = () => { closeLink?.(); closeLink = linkModal(`<h3>${esc(t("sync_link_title"))}</h3><p>${esc(t("sync_link_waiting"))}</p>`); };
  ui.linkShow = (sas) => { closeLink?.(); closeLink = linkModal(sasBlock(sas) + `<p class="muted">${esc(t("sync_sas_confirm_other"))}</p>`); };
  ui.linkConfirm = (sas, onConfirm) => { closeLink?.(); closeLink = linkModal(sasBlock(sas), { confirm: onConfirm }); };
  ui.linkDone = (ok) => {
    closeLink?.(); closeLink = null;
    if (ok === true) toast(t("sync_link_sent"));       // côté source : clé envoyée
    else if (ok === false) {                            // côté nouvel appareil : clé installée
      toast(t("sync_link_success"));
      setTimeout(() => location.reload(), 900);         // recharge → l'identité se charge depuis le stockage
    } else toast(t("sync_link_failed"));                // échec / SAS non concordant
  };

  /* ------------------------------ Démarrage ------------------------------ */
  const engine = createSyncEngine({ host, ui });
  host.sync = {
    link: () => engine.requestLink(),
    announce: () => engine.announce(),
  };
  // Hook global : la modale « clé manquante » (ui/modals.js, sans accès à `host`)
  // propose « recevoir la clé depuis un appareil connecté » via cet appel.
  window.__mindlogSyncLink = () => engine.requestLink();

  host.registerPlugin({
    name: "sync",
    init() {
      engine.start();
      // Re-annonce après un court délai (l'identité E2E peut n'être prête qu'après le login).
      setTimeout(() => engine.announce(), 3000);
    },
  });
}
