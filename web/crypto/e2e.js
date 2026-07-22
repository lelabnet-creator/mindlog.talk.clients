/* ======================================================================== *
 * crypto/e2e.js — chiffrement bout-en-bout v1 (ECDH P-256 + AES-GCM).
 *
 * Clé privée générée et conservée DANS LE NAVIGATEUR (localStorage), jamais
 * envoyée au serveur. Seule la clé publique est publiée. ensureE2E charge ou
 * établit la clé d'identité ; e2eEncrypt/Decrypt dérivent une clé AES partagée
 * par contact. Extrait verbatim de public/app.js. cf. docs/web-crypto-modules.md.
 * ======================================================================== */
import { E2E, ECDH, _b64, _unb64 } from "./state.js";
import { e2eVaultGet } from "./vault.js";
import { t } from "../i18n.js";

export async function ensureE2E(handle, accessKey) {
  if (E2E.priv && E2E.handle === handle) return E2E.priv;
  E2E.handle = handle;
  E2E.shared.clear();
  E2E.needsRestore = false;
  E2E.needsBackup = false;
  const store = "mindlog.e2e." + handle;
  let privJwk = null;
  try {
    privJwk = JSON.parse(localStorage.getItem(store) || "null");
  } catch {}
  if (privJwk) {
    try {
      E2E.priv = await crypto.subtle.importKey("jwk", privJwk, ECDH, false, ["deriveKey"]);
      E2E.privJwk = privJwk; // requis pour le DH1 du X3DH (deriveBits depuis l'IK)
      // La clé publique se déduit de la privée (mêmes x/y, sans le scalaire d).
      // On la (re)publie systématiquement : sans ça, une désync serveur↔navigateur
      // (ex. après migration) ne se répare jamais et les messages restent
      // « indéchiffrables » côté destinataire. On renseigne aussi E2E.pubStr,
      // nécessaire au chiffrement du journal (champs e2e: auto-adressés).
      const pubJwk = { crv: privJwk.crv, kty: privJwk.kty, x: privJwk.x, y: privJwk.y, ext: true, key_ops: [] };
      E2E.pubStr = JSON.stringify(pubJwk);
      fetch("/api/pubkey", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-access-key": accessKey },
        body: JSON.stringify({ pubkey: E2E.pubStr }),
      }).catch(() => {});
      // Clé présente localement mais à protéger tant qu'elle n'est pas dans le
      // coffre : sinon elle est introuvable (et les messages illisibles) ailleurs.
      // NB : e2eVaultGet renvoie TOUJOURS un objet ({ vault, … }), jamais null —
      // il faut tester `.vault`, sinon needsBackup resterait faux en permanence.
      E2E.needsBackup = !(await e2eVaultGet(accessKey)).vault;
      return E2E.priv;
    } catch {
      /* clé invalide → on en régénère une */
    }
  }
  // Pas de clé locale exploitable. Si un COFFRE existe déjà, on NE génère PAS de
  // nouvelle clé : cela écraserait la clé publique du serveur et casserait le
  // coffre (anciens messages définitivement illisibles). On signale qu'une
  // restauration (passkey/PIN/passphrase) est nécessaire — déclenchée par l'UI.
  const { vault: vaultStr } = await e2eVaultGet(accessKey);
  if (vaultStr) {
    E2E.needsRestore = true;
    return null;
  }
  // Vraiment nouveau (aucune clé, aucun coffre) : générer + publier.
  // ["deriveKey","deriveBits"] : deriveKey pour _sharedKey (v1) ; deriveBits pour rEcdh (X3DH ratchet).
  const kp = await crypto.subtle.generateKey(ECDH, true, ["deriveKey", "deriveBits"]);
  const [priv, pub] = await Promise.all([
    crypto.subtle.exportKey("jwk", kp.privateKey),
    crypto.subtle.exportKey("jwk", kp.publicKey),
  ]);
  try {
    localStorage.setItem(store, JSON.stringify(priv));
  } catch {}
  E2E.priv = kp.privateKey;
  E2E.privJwk = priv;
  E2E.pubStr = JSON.stringify(pub);
  E2E.needsBackup = true; // nouvelle clé : pas encore dans le coffre → à sauvegarder.
  // Publication de la clé publique en arrière-plan (ne bloque pas le chargement).
  fetch("/api/pubkey", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-access-key": accessKey },
    body: JSON.stringify({ pubkey: JSON.stringify(pub) }),
  }).catch(() => {});
  return E2E.priv;
}

async function _sharedKey(peerPubStr) {
  if (!E2E.priv || !peerPubStr) return null;
  if (E2E.shared.has(peerPubStr)) return E2E.shared.get(peerPubStr);
  let jwk;
  try {
    jwk = JSON.parse(peerPubStr);
  } catch {
    return null;
  }
  const peerPub = await crypto.subtle.importKey("jwk", jwk, ECDH, false, []);
  const aes = await crypto.subtle.deriveKey({ name: "ECDH", public: peerPub }, E2E.priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  E2E.shared.set(peerPubStr, aes);
  return aes;
}
export async function e2eEncrypt(peerPubStr, text) {
  const aes = await _sharedKey(peerPubStr);
  if (!aes) throw new Error(t("cry_no_e2e"));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(text));
  return { iv: _b64(iv), ciphertext: _b64(ct) };
}
export async function e2eDecrypt(peerPubStr, iv, ciphertext) {
  const aes = await _sharedKey(peerPubStr);
  if (!aes) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _unb64(iv) }, aes, _unb64(ciphertext));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
