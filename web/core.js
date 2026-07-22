// core.js — socle applicatif : identité du visiteur (qui suis-je), stockage
// navigateur (clé/handle), profil courant, et petites constantes/aides partagées
// (jours, settings par défaut, dates). Extrait verbatim. cf. docs/web-app-split-proposal.md
import { api } from "./net.js";
import { appState } from "./state.js";
import { setActivityHandle } from "./activity-log.js";

// Constantes de stockage / valeurs par défaut (utilisées par les helpers ci-dessous).
export const KEY_STORE = "mindlog.key";
export const HANDLE_STORE = "mindlog.handle";
export const LAST_HANDLE_STORE = "mindlog.lasthandle";
export const SESSION_HINT = "mindlog.session";
export const DEFAULT_AVAILABILITY = {
  weekdays: [true, true, true, true, true, false, false],
  periods: [],
  start: "09:00",
  end: "18:00",
  slot_minutes: 30,
};

export const app = document.getElementById("app");

export const storedKey = () => {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
};

export const setStoredKey = (k) => {
  try {
    k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE);
  } catch {
    /* localStorage indisponible */
  }
};

export const storedHandle = () => {
  try {
    return localStorage.getItem(HANDLE_STORE);
  } catch {
    return null;
  }
};

export const setStoredHandle = (h) => {
  try {
    h ? localStorage.setItem(HANDLE_STORE, h) : localStorage.removeItem(HANDLE_STORE);
  } catch {}
};

export const lastHandle = () => {
  try {
    return localStorage.getItem(LAST_HANDLE_STORE);
  } catch {
    return null;
  }
};

export const setLastHandle = (h) => {
  try {
    if (h) localStorage.setItem(LAST_HANDLE_STORE, h);
  } catch {}
  // Le journal d'activité local est cloisonné par handle.
  if (h) setActivityHandle(h);
};


export function setMeProfile({ name, hasPhoto, plan } = {}) {
  if (name !== undefined) appState.me.name = name;
  if (hasPhoto !== undefined) appState.me.hasPhoto = !!hasPhoto;
  if (plan !== undefined) appState.me.plan = plan === "premium" ? "premium" : "free";
  appState.me.photoTs = Date.now();
}

export async function loadAuth(force = false) {
  if (!force && appState.authPromise) return appState.authPromise;
  appState.authPromise = (async () => {
    try {
      const s = await api("/api/session"); // cookie httpOnly transmis tout seul
      appState.auth = s.authenticated ? { handle: s.handle, key: s.accessKey } : null;
      if (s.authenticated) setMeProfile({ name: s.displayName, hasPhoto: s.hasPhoto });
    } catch {
      appState.auth = null;
    }
    if (appState.auth) setSessionHint(true);
    return appState.auth;
  })();
  return appState.authPromise;
}

export const myHandle = () => appState.auth?.handle ?? storedHandle();

export const myKey = () => appState.auth?.key ?? storedKey();

export const isLoggedIn = () => !!(appState.auth || storedKey());

export const viewerHeaders = () => (appState.auth ? {} : storedKey() ? { "x-access-key": storedKey() } : {});

export const setSessionHint = (on) => {
  try {
    on ? localStorage.setItem(SESSION_HINT, "1") : localStorage.removeItem(SESSION_HINT);
  } catch {}
};

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const TOUR_SEEN_KEY = "mindlog.tourSeen";
export const isDev = typeof location !== "undefined" && location.hostname !== "id.mindlog.today";
export const DEV_PREMIUM_KEY = "mindlog.dev.premium";

export const DEFAULT_SETTINGS = {
  allow_chat: true,
  allow_call: true,
  allow_video: true,
  allow_requests: true,
  public_availability: true,
  availability: DEFAULT_AVAILABILITY,
};

export const DOW_LETTERS = ["L", "M", "M", "J", "V", "S", "D"];

export const DOW_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

export function normalizeAvailability(a) {
  const src = a || {};
  return {
    weekdays: DEFAULT_AVAILABILITY.weekdays.map((d, i) =>
      typeof (src.weekdays || [])[i] === "boolean" ? src.weekdays[i] : d
    ),
    periods: Array.isArray(src.periods) ? src.periods : [],
    start: src.start || DEFAULT_AVAILABILITY.start,
    end: src.end || DEFAULT_AVAILABILITY.end,
    slot_minutes: [15, 30, 60].includes(src.slot_minutes) ? src.slot_minutes : DEFAULT_AVAILABILITY.slot_minutes,
  };
}

export function relDate(s) {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d) ? "" : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}
