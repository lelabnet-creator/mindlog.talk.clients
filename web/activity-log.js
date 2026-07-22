// activity-log.js — Journal client local des actions et surtout des ÉCHECS
// (appel, chat, live, …). Les toasts sont éphémères ; ici on conserve la RAISON
// détaillée de chaque échec pour la consulter après coup dans Compte › Activité.
//
// Stockage : localStorage par handle (ring buffer borné). Aucun envoi serveur —
// purement local à l'appareil. Les abonnés (le panneau Activité) sont notifiés
// en direct via onActivityLog().

const MAX = 80;
const keyFor = (h) => `mindlog.activity.${h || "_"}`;
const listeners = new Set();

// Handle courant injecté par app.js (évite un import circulaire vers core/state).
let currentHandle = null;
export function setActivityHandle(h) {
  currentHandle = h || null;
}

function read(h) {
  try {
    const v = JSON.parse(localStorage.getItem(keyFor(h)) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(h, list) {
  try {
    localStorage.setItem(keyFor(h), JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* quota dépassé : best-effort, on abandonne silencieusement */
  }
}
function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* un abonné qui jette ne casse pas les autres */ }
  }
}

export function onActivityLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getActivityLog() {
  return read(currentHandle);
}

export function clearActivityLog() {
  write(currentHandle, []);
  emit();
}

// Enregistre une entrée de journal.
//   kind   : "call" | "chat" | "live" | "relation" | "system" | …
//   level  : "info" | "warn" | "error"   (défaut "info")
//   text   : résumé court ("Appel @bob échoué")
//   detail : raison détaillée de l'échec ("Connexion P2P impossible (NAT)")
//   peer   : handle concerné (optionnel, pour le contexte)
export function logActivity({ kind = "system", level = "info", text = "", detail = "", peer = "" } = {}) {
  const entry = { at: new Date().toISOString(), kind, level, text, detail, peer };
  const list = read(currentHandle);
  list.unshift(entry);
  write(currentHandle, list);
  emit();
  return entry;
}

// Raccourci pour les échecs : extrait un message lisible de l'erreur.
export function logFailure(kind, text, err, peer = "") {
  const detail = typeof err === "string" ? err : (err?.message || String(err ?? "")) || "Raison inconnue";
  return logActivity({ kind, level: "error", text, detail, peer });
}
