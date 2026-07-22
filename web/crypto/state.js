/* ======================================================================== *
 * crypto/state.js — socle partagé du chiffrement bout-en-bout (E2E).
 *
 * Source de vérité UNIQUE pour l'état mutable `E2E` et les primitives de base
 * (constante ECDH, helpers base64 / base64url). Tous les modules crypto
 * importent CETTE référence d'objet `E2E` : comme c'est le même objet, leurs
 * mutations restent visibles partout (clé privée chargée par e2e.js, needsBackup
 * mis à jour par vault.js, etc.).
 *
 * Extrait verbatim de public/app.js (cf. docs/web-crypto-modules.md).
 * ======================================================================== */

// Clé privée générée et conservée DANS LE NAVIGATEUR (localStorage), jamais
// envoyée au serveur. Seule la clé publique est publiée. Le serveur ne peut
// pas lire les messages.
export const E2E = { priv: null, privJwk: null, handle: null, shared: new Map(), pubStr: null, needsRestore: false, needsBackup: false };

export const ECDH = { name: "ECDH", namedCurve: "P-256" };

export const _b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const _unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const _b64url = (buf) => _b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const _unb64url = (s) => {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return _unb64(t);
};
