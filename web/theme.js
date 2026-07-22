// theme.js — thème clair/sombre + palette d'accentuation (effet caméléon).
// Module autonome (globals navigateur). Extrait verbatim. cf. docs/web-app-split-proposal.md
import { t } from "./i18n.js";

// Icônes SVG du bouton thème (soleil / lune) — plus d'emoji structurel (cohérence
// cross-OS + thématisable). Inlinées ici pour garder le module sans dépendance.
const SUN_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';

// Palette d'accentuation (effet caméléon) — persistée dans le navigateur.
// `k` = clé i18n du nom affiché (title + aria). `n` = libellé de repli (FR).
export const ACCENTS = [
  { n: "Indigo (Teams)", k: "thm_accent_indigo", v: "#8b8ff5" },
  { n: "Teal (WhatsApp)", k: "thm_accent_teal", v: "#2fd4a4" },
  { n: "Bleu", k: "thm_accent_blue", v: "#6ea8fe" },
  { n: "Vert", k: "thm_accent_green", v: "#5fd39a" },
  { n: "Violet", k: "thm_accent_violet", v: "#b48cff" },
  { n: "Ambre", k: "thm_accent_amber", v: "#f5b86b" },
  { n: "Corail", k: "thm_accent_coral", v: "#f4807a" },
  { n: "Cyan", k: "thm_accent_cyan", v: "#4fd1c5" },
  { n: "Caméléon (animé)", k: "thm_accent_chameleon", v: "rainbow" },
];
export const ACCENT_STORE = "mindlog.accent";
export const storedAccent = () => {
  try {
    return localStorage.getItem(ACCENT_STORE);
  } catch {
    return null;
  }
};

export let rainbowTimer = null;
export function stopRainbow() {
  if (rainbowTimer) clearInterval(rainbowTimer);
  rainbowTimer = null;
}
export function startRainbow() {
  stopRainbow();
  let h = Math.random() * 360;
  const tick = () => {
    h = (h + 1.5) % 360;
    const c = `hsl(${h.toFixed(0)} 78% 68%)`;
    document.documentElement.style.setProperty("--accent", c);
    document.documentElement.style.setProperty("--accent-strong", c);
  };
  tick();
  rainbowTimer = setInterval(tick, 70);
}

export function applyAccent(c) {
  if (!c) return;
  if (c === "rainbow") {
    startRainbow();
  } else {
    stopRainbow();
    document.documentElement.style.setProperty("--accent", c);
    document.documentElement.style.setProperty("--accent-strong", c);
  }
  document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.accent === c));
}

export const RAINBOW_BG =
  "conic-gradient(from 0deg,#f4807a,#f5b86b,#5fd39a,#4fd1c5,#6ea8fe,#b48cff,#f4807a)";
export const swatchesHtml = () =>
  ACCENTS.map(
    (a) =>
      `<button class="swatch${a.v === "rainbow" ? " rainbow" : ""}" type="button" data-accent="${a.v}" style="${
        a.v === "rainbow" ? `background:${RAINBOW_BG}` : `--sw:${a.v}`
      }" title="${t(a.k)}" aria-label="${t("thm_color").replace("{name}", t(a.k))}"></button>`
  ).join("");

// Thème clair / sombre — persisté dans le navigateur (défaut : sombre).
export const THEME_STORE = "mindlog.theme";
export const storedTheme = () => {
  try {
    return localStorage.getItem(THEME_STORE);
  } catch {
    return null;
  }
};
export function applyTheme(mode) {
  const theme = mode === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORE, theme);
  } catch {}
  document.querySelectorAll(".theme-toggle").forEach((b) => {
    // En clair on propose de passer en sombre (lune), et inversement (soleil).
    b.innerHTML = theme === "light" ? MOON_SVG : SUN_SVG;
    b.title = theme === "light" ? t("thm_to_dark") : t("thm_to_light");
    b.setAttribute("aria-label", b.title);
  });
}
export function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(next);
  return next;
}
export const themeToggleHtml = () =>
  `<button class="theme-toggle" type="button" aria-label="${t("thm_toggle")}"></button>`;
