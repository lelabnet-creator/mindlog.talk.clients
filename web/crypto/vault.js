/* ======================================================================== *
 * crypto/vault.js — coffre de clé E2E (portabilité entre navigateurs).
 *
 * La clé PRIVÉE est chiffrée (AES-GCM) puis stockée côté serveur sous forme
 * OPAQUE. Déverrouillable via passkey (WebAuthn PRF) OU passphrase/PIN. Le
 * serveur ne voit jamais ni la clé, ni le secret PRF, ni la passphrase.
 * Extrait verbatim de public/app.js. cf. docs/web-crypto-modules.md.
 * ======================================================================== */
import { E2E, _b64, _unb64, _unb64url } from "./state.js";
import { api, authHeaders } from "../net.js";
import { t } from "../i18n.js";

const E2E_PRF_SALT = new TextEncoder().encode("mindlog-e2e-v1");

// Secret stable (32 o) dérivé de la passkey via l'extension PRF. Renvoie null si
// non supporté / aucune passkey / annulé. Nécessite un geste utilisateur (clic).
async function getPrfSecret(handle) {
  if (!window.PublicKeyCredential) return null;
  let opts;
  try {
    opts = await api("/api/passkeys/auth/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
  } catch {
    return null;
  }
  if (!opts.allowCredentials || !opts.allowCredentials.length) return null;
  const pub = {
    challenge: _unb64url(opts.challenge),
    rpId: opts.rpId,
    timeout: opts.timeout,
    userVerification: opts.userVerification || "preferred",
    allowCredentials: opts.allowCredentials.map((c) => ({
      id: _unb64url(c.id),
      type: "public-key",
      transports: c.transports,
    })),
    extensions: { prf: { eval: { first: E2E_PRF_SALT } } },
  };
  let assertion;
  try {
    assertion = await navigator.credentials.get({ publicKey: pub });
  } catch {
    return null;
  }
  const first = assertion?.getClientExtensionResults?.().prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

async function _wrapKeyFromBytes(bytes) {
  const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("mindlog-e2e-wrap") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function _wrapKeyFromPassphrase(pass, saltBytes) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 600000 },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function _wrapBlob(aes, plainStr) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(plainStr));
  return { iv: _b64(iv), ct: _b64(ct) };
}
async function _unwrapBlob(aes, blob) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _unb64(blob.iv) }, aes, _unb64(blob.ct));
  return new TextDecoder().decode(pt);
}

// Retourne { vault: objet|null, pin_locked_until: string|null, pin_fail_count: number }.
export async function e2eVaultGet(accessKey) {
  try {
    const r = await api("/api/e2e/vault", {
      headers: accessKey ? { "x-access-key": accessKey } : authHeaders(),
    });
    return {
      vault: r.vault || null,
      pin_locked_until: r.pin_locked_until || null,
      pin_fail_count: r.pin_fail_count || 0,
    };
  } catch {
    return { vault: null, pin_locked_until: null, pin_fail_count: 0 };
  }
}
export async function e2eVaultPut(vault, accessKey) {
  await api("/api/e2e/vault", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(accessKey ? { "x-access-key": accessKey } : authHeaders()) },
    body: JSON.stringify({ vault: JSON.stringify(vault) }),
  });
}

// Sauvegarde la clé privée locale dans le coffre. method = "passkey" | "passphrase" | "pin".
export async function e2eSaveVault(handle, accessKey, method, secret) {
  const privStr = localStorage.getItem("mindlog.e2e." + handle);
  if (!privStr) throw new Error(t("cry_no_local_key"));
  const { vault: vaultStr } = await e2eVaultGet(accessKey);
  const vault = vaultStr ? JSON.parse(vaultStr) : { v: 1 };
  vault.v = 1;
  if (method === "passkey") {
    const prfSecret = await getPrfSecret(handle);
    if (!prfSecret) throw new Error(t("cry_no_prf"));
    vault.prf = await _wrapBlob(await _wrapKeyFromBytes(prfSecret), privStr);
  } else if (method === "pin") {
    if (!secret || secret.length < 4) throw new Error(t("dom_pin_short"));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    vault.pin = { salt: _b64(salt), ...(await _wrapBlob(await _wrapKeyFromPassphrase(secret, salt), privStr)) };
  } else {
    if (!secret || secret.length < 8) throw new Error(t("cry_pass_short"));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    vault.pass = { salt: _b64(salt), ...(await _wrapBlob(await _wrapKeyFromPassphrase(secret, salt), privStr)) };
  }
  await e2eVaultPut(vault, accessKey);
  E2E.needsBackup = false;
  return true;
}

// Restaure la clé privée depuis le coffre. method = "passkey" | "passphrase" | "pin".
export async function e2eRestoreVault(handle, accessKey, method, secret) {
  const { vault: vaultStr } = await e2eVaultGet(accessKey);
  if (!vaultStr) return false;
  const vault = JSON.parse(vaultStr);
  let privStr = null;
  if (method === "passkey" && vault.prf) {
    const prfSecret = await getPrfSecret(handle);
    if (prfSecret) {
      try {
        privStr = await _unwrapBlob(await _wrapKeyFromBytes(prfSecret), vault.prf);
      } catch { /* mauvaise clé */ }
    }
  } else if (method === "pin" && vault.pin) {
    try {
      privStr = await _unwrapBlob(await _wrapKeyFromPassphrase(secret, _unb64(vault.pin.salt)), vault.pin);
    } catch { /* mauvais PIN */ }
  } else if (method === "passphrase" && vault.pass) {
    try {
      privStr = await _unwrapBlob(await _wrapKeyFromPassphrase(secret, _unb64(vault.pass.salt)), vault.pass);
    } catch { /* mauvaise passphrase */ }
  }
  if (!privStr) return false;
  try {
    JSON.parse(privStr);
  } catch {
    return false;
  }
  localStorage.setItem("mindlog.e2e." + handle, privStr);
  // Force le rechargement de la clé restaurée au prochain ensureE2E.
  E2E.priv = null;
  E2E.handle = null;
  E2E.shared.clear();
  E2E.needsBackup = false; // restaurée depuis le coffre = déjà sauvegardée.
  return true;
}
