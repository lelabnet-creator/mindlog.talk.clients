// ui/modals.js — modales E2E (coffre backup/restore, récupération de clé) +
// numéro de sécurité (anti-MITM). Pilotées par callbacks (onDone/onChange).
// Extrait verbatim de app.js. cf. docs/web-app-split-proposal.md
import { ensureE2E } from "../crypto/e2e.js";
import { E2E } from "../crypto/state.js";
import { e2eRestoreVault, e2eSaveVault, e2eVaultGet } from "../crypto/vault.js";
import { groupDigits, safetyNumber, sha256hex, verifyClear, verifyGet, verifyPut } from "../crypto/verify.js";
import { t } from "../i18n.js";
import { api, authHeaders } from "../net.js";
import { esc, promptPassphrase, promptPin, toast } from "./dom.js";
import { icon } from "./icons.js";

// Garde anti-doublon : renderPrivate peut relancer la séquence E2E plusieurs fois
// par chargement (cache PIM → /api/me → clé fraîche). Sans verrou, on empile
// plusieurs `.overlay` plein écran ; la modale OBLIGATOIRE n'ayant ni croix ni
// fermeture au clic extérieur, le doublon du dessous bloque TOUS les clics de
// l'app (deck inutilisable). Le flag est synchrone : il barre la 2ᵉ entrée avant
// même les `await` (ensureE2E / passkeys) qui précèdent l'insertion du DOM.
let _e2eBackupOpen = false;

export async function openE2eBackup(handle, accessKey, onDone, opts = {}) {
  if (_e2eBackupOpen) return; // une seule modale de coffre à la fois
  _e2eBackupOpen = true;
  try {
    await ensureE2E(handle, accessKey);
  } catch (e) {
    _e2eBackupOpen = false;
    throw e;
  }
  const mandatory = !!opts.mandatory;
  // Une passkey est-elle enregistrée sur ce compte ? (chemin PRF « 1 geste »)
  let hasPasskey = false;
  if (window.PublicKeyCredential) {
    try {
      const o = await api("/api/passkeys/auth/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      hasPasskey = !!(o.allowCredentials && o.allowCredentials.length);
    } catch {}
  }
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true" style="max-width:400px">
      ${mandatory ? "" : `<button type="button" class="close" id="eb-x" aria-label="${t("com_close")}">✕</button>`}
      <h2>${mandatory ? t("eb_title_m") : t("eb_title")}</h2>
      <p class="sub">${mandatory ? t("eb_sub_m") : t("eb_sub")}</p>
      <div style="display:flex;flex-direction:column;gap:.6rem">
        ${
          // Passkey = confort lié à l'authentificateur, PAS garanti restaurable sur un
          // autre appareil (ex. Android n'a pas de chemin de restauration passkey). En
          // mode OBLIGATOIRE on exige donc un secret PORTABLE (PIN ou passphrase) ; la
          // passkey reste proposée en option hors mode obligatoire.
          hasPasskey && !mandatory ? `<button type="button" class="btn primary" id="eb-passkey">${icon("shield", 15)} ${t("eb_passkey")} <span class="lbl-sm" style="opacity:.7">&nbsp;${t("eb_note_1geste")}</span></button>` : ""
        }
        <button type="button" class="btn${(hasPasskey && !mandatory) ? "" : " primary"}" id="eb-pin">${icon("lock", 15)} ${t("eb_pin")} <span class="lbl-sm" style="opacity:.7">&nbsp;${t("eb_note_simple")}</span></button>
        <button type="button" class="btn" id="eb-pass">${icon("key", 15)} ${t("eb_pass")} <span class="lbl-sm" style="opacity:.7">&nbsp;${t("eb_note_safe")}</span></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); _e2eBackupOpen = false; };
  if (!mandatory) {
    overlay.querySelector("#eb-x").onclick = close;
    overlay.addEventListener("click", (e) => e.target === overlay && close());
  }

  overlay.querySelector("#eb-passkey")?.addEventListener("click", async () => {
    try {
      await e2eSaveVault(handle, accessKey, "passkey");
      close();
      toast(t("eb_ok_passkey"));
      onDone?.();
    } catch (e) {
      toast(e.message || t("eb_passkey_fail"));
    }
  });

  overlay.querySelector("#eb-pin").addEventListener("click", async () => {
    if (!mandatory) close();
    const pin = await promptPin(t("eb_pin_choose"), { confirm: true });
    if (!pin) return;
    try {
      await e2eSaveVault(handle, accessKey, "pin", pin);
      close();
      toast(t("eb_ok_pin"));
      onDone?.();
    } catch (e) {
      toast(e.message || t("eb_save_fail"));
    }
  });

  overlay.querySelector("#eb-pass").addEventListener("click", async () => {
    if (!mandatory) close();
    const pass = await promptPassphrase(t("eb_title"), { generate: true });
    if (!pass) return;
    try {
      await e2eSaveVault(handle, accessKey, "passphrase", pass);
      close();
      toast(t("eb_ok_pass"));
      onDone?.();
    } catch (e) {
      toast(e.message || t("eb_save_fail"));
    }
  });
}

export async function openKeyRecovery(handle, accessKey, onDone) {
  const r = await e2eVaultGet(accessKey).catch(() => null);
  const hasVault = !!r?.vault;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true" style="max-width:460px">
      <button type="button" class="close" id="kr-x" aria-label="${t("com_close")}">✕</button>
      <h2>${t("kr_title")}</h2>
      <p class="sub">${t("kr_sub")}</p>
      <ol style="font-size:.86rem;line-height:1.6;padding-left:1.2rem;margin:.2rem 0 1rem">
        <li>${t("kr_s1")} ${hasVault ? t("kr_s1_has") : t("kr_s1_none")}</li>
        <li>${t("kr_s2")}</li>
      </ol>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        ${hasVault ? `<button type="button" class="btn primary" id="kr-restore">${icon("download", 15)} ${t("kr_restore")}</button>` : ""}
        ${typeof window !== "undefined" && window.__mindlogSyncLink ? `<button type="button" class="btn" id="kr-link">${icon("shield", 15)} ${t("sync_link_title")}</button>` : ""}
        <button type="button" class="btn" id="kr-later">${t("kr_later")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#kr-x").onclick = close;
  overlay.querySelector("#kr-later").onclick = close;
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#kr-restore")?.addEventListener("click", () => {
    close();
    openE2eRestore(handle, accessKey, onDone);
  });
  // Handoff SAS : recevoir la clé d'identité depuis un de mes appareils déjà connectés.
  overlay.querySelector("#kr-link")?.addEventListener("click", () => {
    close();
    try { window.__mindlogSyncLink(); } catch { /* plugin sync indisponible */ }
  });
}

export async function openE2eRestore(handle, accessKey, onDone) {
  const r = await e2eVaultGet(accessKey);
  if (!r?.vault) { toast(t("er_no_key")); return; }
  const v = JSON.parse(r.vault);
  const pinLockedUntil = r.pin_locked_until ? new Date(r.pin_locked_until) : null;
  const pinLocked = pinLockedUntil && pinLockedUntil > new Date();
  const pinLockMsg = pinLocked
    ? t("er_pin_locked").replace("{time}", pinLockedUntil.toLocaleTimeString())
    : "";
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true" style="max-width:440px">
      <button type="button" class="close" id="er-x" aria-label="${t("com_close")}">✕</button>
      <h2>${t("er_title")}</h2>
      <p class="sub">${t("er_sub")}</p>
      <div style="display:flex;flex-direction:column;gap:.5rem">
        ${v.prf ? `<button type="button" class="btn primary" id="er-passkey">${icon("shield", 15)} ${t("er_with_passkey")}</button>` : ""}
        ${v.pin ? `<button type="button" class="btn${pinLocked ? " disabled" : ""}" id="er-pin" ${pinLocked ? "disabled" : ""}>${icon("lock", 15)} ${t("er_with_pin")}${pinLocked ? " 🔒" : ""}</button>` : ""}
        ${v.pass ? `<button type="button" class="btn" id="er-pass">${icon("key", 15)} ${t("er_with_pass")}</button>` : ""}
      </div>
      <p class="lbl-sm" id="er-err" style="color:var(--danger);margin-top:.6rem;min-height:1em">${esc(pinLockMsg)}</p>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const err = (m) => (overlay.querySelector("#er-err").textContent = m);
  overlay.querySelector("#er-x").onclick = close;
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#er-passkey")?.addEventListener("click", async () => {
    err("");
    try {
      if (!(await e2eRestoreVault(handle, accessKey, "passkey")))
        throw new Error(t("er_passkey_fail"));
      toast(t("er_restored"));
      close();
      onDone && onDone();
      setTimeout(() => location.reload(), 400);
    } catch (e) { err(e.message || t("er_fail")); }
  });
  overlay.querySelector("#er-pin")?.addEventListener("click", async () => {
    const pin = await promptPin(t("er_pin_prompt"));
    if (!pin) return;
    err("");
    try {
      const ok = await e2eRestoreVault(handle, accessKey, "pin", pin);
      if (!ok) {
        const res = await api("/api/e2e/vault/pin-fail", { method: "POST", headers: authHeaders() });
        const until = res.locked_until ? new Date(res.locked_until).toLocaleTimeString() : null;
        throw new Error(until ? t("er_pin_locked_until").replace("{time}", until) : t("er_pin_wrong"));
      }
      await api("/api/e2e/vault/pin-success", { method: "POST", headers: authHeaders() });
      toast(t("er_restored"));
      close();
      onDone && onDone();
      setTimeout(() => location.reload(), 400);
    } catch (e) { err(e.message || t("er_fail")); }
  });
  overlay.querySelector("#er-pass")?.addEventListener("click", async () => {
    const pass = await promptPassphrase(t("er_pass_prompt"));
    if (!pass) return;
    err("");
    try {
      if (!(await e2eRestoreVault(handle, accessKey, "passphrase", pass)))
        throw new Error(t("er_pass_wrong"));
      toast(t("er_restored"));
      close();
      onDone && onDone();
      setTimeout(() => location.reload(), 400);
    } catch (e) { err(e.message || t("er_fail")); }
  });
}

export async function openSafetyNumber(myHandle, peerHandle, peerPubStr, onChange) {
  const myPub = E2E.pubStr;
  if (!myPub || !peerPubStr) { toast(t("sn_no_keys")); return; }
  const sn = await safetyNumber(myHandle, myPub, peerHandle, peerPubStr);
  const hash = await sha256hex(sn);
  const status = await verifyGet(peerHandle);
  let verified = status.safety === hash;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="sn-title" style="max-width:460px">
      <button type="button" class="close" id="sn-close" aria-label="${t("com_close")}">✕</button>
      <h2 id="sn-title">${t("sn_title").replace("{handle}", esc(peerHandle))}</h2>
      <p class="sub">${t("sn_sub").replace(/\{handle\}/g, esc(peerHandle))}</p>
      <div class="qr-box" id="sn-qr" style="display:flex;justify-content:center;margin:.5rem 0"></div>
      <pre class="sn-digits" style="font-size:1.05rem;letter-spacing:.04em;text-align:center;white-space:pre-wrap;word-break:break-word;margin:.5rem 0">${esc(groupDigits(sn))}</pre>
      <p class="sub" id="sn-state"></p>
      <div class="actions" style="margin-top:1rem">
        <button type="button" class="btn" id="sn-clear">${t("sn_clear")}</button>
        <button type="button" class="btn primary" id="sn-verify">${t("sn_verify")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#sn-close").addEventListener("click", close);
  if (window.QRCode) {
    new window.QRCode(overlay.querySelector("#sn-qr"), {
      text: "mindlog-sn-v1:" + sn, width: 180, height: 180,
      colorDark: "#0f1115", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M,
    });
  }
  const renderState = () => {
    const el = overlay.querySelector("#sn-state");
    el.textContent = verified ? t("sn_verified") : t("sn_unverified");
    el.style.color = verified ? "var(--success)" : "var(--muted)";
    overlay.querySelector("#sn-verify").style.display = verified ? "none" : "";
    overlay.querySelector("#sn-clear").style.display = verified ? "" : "none";
  };
  renderState();
  overlay.querySelector("#sn-verify").addEventListener("click", async () => {
    try { await verifyPut(peerHandle, hash); verified = true; renderState(); onChange && onChange(); }
    catch (e) { toast(e.message || t("er_fail")); }
  });
  overlay.querySelector("#sn-clear").addEventListener("click", async () => {
    try { await verifyClear(peerHandle); verified = false; renderState(); onChange && onChange(); }
    catch (e) { toast(e.message || t("er_fail")); }
  });
}
