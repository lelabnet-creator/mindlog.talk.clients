/* ======================================================================== *
 * net.js — couche réseau + en-têtes d'auth (générique, partagée).
 *
 * Helpers HTTP universels utilisés par app.js ET les modules crypto.
 * Aucune dépendance (feuille). cf. docs/web-crypto-modules.md.
 * ======================================================================== */

/**
 * Schémas du contrat d'API, générés depuis `contract/openapi.yaml`
 * (voir `./types/api.d.ts`, régénérer via `npm run gen:types`). Raccourci pour
 * annoter les call-sites, ex : `/** @type {Schemas["Error"]} *\/ (data)`.
 * @typedef {import("./types/api.d.ts").components["schemas"]} Schemas
 */

// Clé d'accès courante. En mode cookie de session elle est null et l'auth passe
// par le cookie ; en mode lien /k/{clé} on envoie l'en-tête x-access-key.
// app.js détient la source de vérité (`KEY`) et appelle setAccessKey() à chaque
// (ré)authentification pour refléter la valeur ici.
let _accessKey = null;
export function setAccessKey(k) { _accessKey = k || null; }

export const authHeaders = () => (_accessKey ? { "x-access-key": _accessKey } : {});
export const jsonAuth = () => ({ "Content-Type": "application/json", ...authHeaders() });

// Base de l'API. Vide par défaut → même origine (`/api/...` en relatif, comportement
// historique). Un shell natif (Capacitor) ou un client servi sur une origine distincte
// la surcharge — via `window.__API_BASE__` au chargement, ou `setApiBase()` au boot —
// pour cibler le backend déployé. cf. scission client/backend.
let _apiBase = (typeof window !== "undefined" && window.__API_BASE__) || "";
export function setApiBase(b) { _apiBase = b || ""; }
export const apiBase = () => _apiBase;

/**
 * Appel HTTP JSON. Le chemin racine est préfixé par la base configurée
 * (cf. {@link setApiBase}) ; une URL absolue passe telle quelle. Renvoie le JSON
 * décodé (ou `null` sur 204), ou lève une `Error` portant `.status`.
 * @param {string} path
 * @param {RequestInit} [opts]
 * @returns {Promise<any>} forme selon l'endpoint — cf. contrat (`./types/api.d.ts`)
 */
export async function api(path, opts = {}) {
  // Les URL absolues passent telles quelles ; les chemins racine sont préfixés par la base.
  const url = /^https?:\/\//i.test(path) ? path : _apiBase + path;
  const res = await fetch(url, opts);
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText);
    err.status = res.status; // permet de distinguer les cas (403 accès, 402 premium…)
    // Motif STABLE et non traduit (ex. "awaiting_them"). Sans lui, les appelants
    // en étaient réduits à deviner par regex sur le message français du serveur —
    // ce qui cassait dès qu'une traduction changeait.
    if (data?.reason) err.reason = data.reason;
    if (data?.handle) err.handle = data.handle;
    throw err;
  }
  return data;
}
