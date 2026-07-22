// Plugin Live — onglet dédié dans le deck éditeur, juste sous Chat.
//
// Layout style « Netflix » :
//   - barre de recherche en tête (filtre par mot — titre OU @handle)
//   - chips de tags extraits des titres (#hashtag) — clic = filtre
//   - section EN DIRECT MAINTENANT : grille de cartes poster (cover créateur)
//   - section À VENIR : liste compacte
//   - section MES LIVES : CTA broadcaster / lien vers diffusion en cours
//
// Le plugin contribue une colonne via le hook `editorColumns(host, data)` ;
// la barre de nav du bas l'expose si « Live » figure dans la liste NAV de
// editor/index.js.

import { icon } from "../ui/icons.js";
import { logFailure } from "../activity-log.js";
import { t } from "../i18n.js";

export default function register(host) {
  host.registerPlugin({
    id: "live",
    editorColumns: (_h, _data) => [{
      order: 12,          // Chat=10, Live=12 → juste après Chat dans le deck
      label: "Live",
      html: columnHtml(),
      wire: wireColumn,
    }],
  });
}

function columnHtml() {
  return `
  <div class="card live-col">
    <header class="live-col-h">
      <h2 style="margin:0;display:flex;align-items:center;gap:.5rem">
        ${icon("radio", 22)}
        <span>Live</span>
      </h2>
      <p class="lbl-sm" style="opacity:.75;margin:.35rem 0 0">
        ${t("live_intro")}
      </p>
    </header>

    <div class="live-search-bar">
      <input id="live-search" type="search" placeholder="${t("live_search_ph")}" autocomplete="off">
      <button type="button" class="live-search-clear" id="live-search-clear" hidden aria-label="${t("live_clear")}">✕</button>
    </div>
    <div class="live-tagbar" id="live-tagbar" hidden></div>

    <div class="live-col-body" id="live-col-body" aria-busy="true">
      <p class="lbl-sm" style="opacity:.6">${t("com_loading")}</p>
    </div>
  </div>`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtRelative(iso) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffMs = ts - Date.now();
  const abs = Math.abs(diffMs);
  const m = Math.round(abs / 60_000);
  const h = Math.round(abs / 3_600_000);
  const d = Math.round(abs / 86_400_000);
  const past = diffMs < 0;
  if (m < 1) return past ? t("live_just_now") : t("live_soon");
  if (m < 60) return past ? t("live_ago_min").replace("{n}", m) : t("live_in_min").replace("{n}", m);
  if (h < 24) return past ? t("live_ago_h").replace("{n}", h) : t("live_in_h").replace("{n}", h);
  return past ? t("live_ago_d").replace("{n}", d) : t("live_in_d").replace("{n}", d);
}

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString("fr-FR", {
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// Extrait les hashtags d'un texte. Renvoie une liste minuscule, sans le #.
// `#tech-news`, `#Q&R`, `#éco_2025` sont tous capturés ; on tronque sur le
// premier caractère non-mot pour rester propre côté affichage.
function extractTags(text) {
  if (!text) return [];
  const out = new Set();
  const re = /#([\p{L}\p{N}_-]{2,32})/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

// Retire les hashtags d'un titre pour l'affichage propre (le tag reste
// utilisable en filtre via les chips). On garde le texte hors-hashtag intact.
function stripHashtags(text) {
  return String(text || "").replace(/#[\p{L}\p{N}_-]{2,32}/gu, "").replace(/\s+/g, " ").trim();
}

// Vignette/poster pour une carte « EN DIRECT ». On essaie d'abord la vignette
// snapshot poussée par le broadcaster (≈1×/min — voir broadcaster.js
// _pushThumbnail). Si l'endpoint répond 404, l'image bascule sur la cover
// premium du créateur, puis sa photo de profil, puis une vignette dégradée.
// Le query ?ts=… change toutes les 60 s pour casser le cache navigateur.
function posterHtml(stream) {
  const handle = stream.owner_handle || "?";
  const initial = (handle[0] || "?").toUpperCase();
  const fallbackChain = [];
  if (stream.has_cover) fallbackChain.push(`/api/identities/${encodeURIComponent(handle)}/cover`);
  if (stream.has_photo) fallbackChain.push(`/api/identities/${encodeURIComponent(handle)}/photo`);
  // Chaîne d'erreur stockée en data-fallback : l'onerror lit la prochaine URL,
  // ou remplace par la vignette dégradée si la liste est vide.
  const fallbackAttr = esc(JSON.stringify(fallbackChain));
  const onerror = `(()=>{const a=JSON.parse(this.dataset.fallback||'[]');if(a.length){this.dataset.fallback=JSON.stringify(a.slice(1));this.src=a[0];}else{this.replaceWith(Object.assign(document.createElement('div'),{className:'lv-poster-fallback',textContent:'${esc(initial)}'}));}})()`;
  const bust = Math.floor(Date.now() / 60_000); // identique pendant 60 s
  const thumbUrl = `/api/live/${encodeURIComponent(stream.id)}/thumbnail?ts=${bust}`;
  return `<img class="lv-poster-img" src="${thumbUrl}" data-fallback="${fallbackAttr}" alt="" loading="lazy" onerror="${onerror}">`;
}

async function wireColumn(colEl, _data) {
  const body = colEl.querySelector("#live-col-body");
  const searchInput = colEl.querySelector("#live-search");
  const searchClear = colEl.querySelector("#live-search-clear");
  const tagBar = colEl.querySelector("#live-tagbar");
  if (!body) return;

  // État de la vue (filtre courant). Conservé entre les refresh.
  const state = { query: "", tag: "", data: null };

  async function refresh() {
    body.setAttribute("aria-busy", "true");
    try {
      const r = await fetch("/api/live/feed", { credentials: "include" });
      if (r.status === 401) {
        body.innerHTML = `<p class="lbl-sm" style="opacity:.6">${t("live_login_prompt")}</p>`;
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.data = await r.json();
      renderFeed();
    } catch (e) {
      body.innerHTML = `<p class="lbl-sm" style="opacity:.6">${t("live_load_fail").replace("{err}", e?.message || t("live_network"))} <button class="btn sm" id="live-retry">${t("live_retry")}</button></p>`;
      body.querySelector("#live-retry")?.addEventListener("click", refresh);
      logFailure("live", t("live_log_load_fail"), e);
    } finally {
      body.setAttribute("aria-busy", "false");
    }
  }

  function applyFilters(items) {
    const q = state.query.trim().toLowerCase();
    const tag = state.tag.toLowerCase();
    return items.filter((it) => {
      const haystack = `${it.title || ""} ${it.owner_handle || ""} ${it.owner_name || ""}`.toLowerCase();
      const matchesQuery = !q || haystack.includes(q);
      if (!matchesQuery) return false;
      if (!tag) return true;
      return extractTags(it.title).includes(tag);
    });
  }

  function renderTagBar(allTags) {
    if (!allTags.length) { tagBar.hidden = true; tagBar.innerHTML = ""; return; }
    tagBar.hidden = false;
    const chips = allTags.slice(0, 20).map((t) =>
      `<button type="button" class="lv-tag ${t === state.tag ? "on" : ""}" data-tag="${esc(t)}">#${esc(t)}</button>`
    );
    if (state.tag) {
      chips.unshift(`<button type="button" class="lv-tag lv-tag-clear" data-tag="">${t("live_tag_all")}</button>`);
    }
    tagBar.innerHTML = chips.join("");
  }

  function renderFeed() {
    const data = state.data || {};
    const mine = Array.isArray(data.mine) ? data.mine : [];
    const liveNow = Array.isArray(data.live_now) ? data.live_now : [];
    const scheduled = Array.isArray(data.scheduled) ? data.scheduled : [];
    const myActive = mine.find((s) => s.status === "live");

    // Tags agrégés depuis les titres des lives en cours + à venir (les plus
    // pertinents pour filtrer). Ordre = fréquence décroissante.
    const tagCounts = new Map();
    for (const s of liveNow) for (const t of extractTags(s.title)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    for (const s of scheduled) for (const t of extractTags(s.title)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    const allTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    renderTagBar(allTags);

    const filteredNow = applyFilters(liveNow);
    const filteredScheduled = applyFilters(scheduled);
    const filtering = !!(state.query || state.tag);

    const sections = [];

    // Section : mes lives (créateur) — toujours visible, pas filtrée.
    sections.push(`
      <section class="live-section">
        <h3 class="live-section-h">${myActive ? t("live_my_broadcast_on") : t("live_broadcast")}</h3>
        ${myActive
          ? `<a class="live-card live-card--mine-on" href="/me/broadcast">
              <span class="live-dot"></span>
              <div class="live-card-body">
                <strong>${esc(myActive.title || t("live_my_live"))}</strong>
                <small>${t("live_started_click").replace("{when}", fmtRelative(myActive.started_at))}</small>
              </div>
            </a>`
          : `<a class="live-card live-card--cta" href="/me/broadcast">
              <span class="live-card-icon">▶</span>
              <div class="live-card-body">
                <strong>${t("live_start_live")}</strong>
                <small>${t("live_start_desc")}</small>
              </div>
            </a>`
        }
      </section>`);

    // Section EN DIRECT — grille de posters style Netflix.
    if (liveNow.length) {
      const empty = filteredNow.length === 0 && filtering
        ? `<p class="lbl-sm" style="opacity:.6;padding:.5rem .2rem">${t("live_none_match_filter")}</p>`
        : "";
      sections.push(`
        <section class="live-section">
          <h3 class="live-section-h">${t("live_live_now")} <span class="lv-count">${filteredNow.length}/${liveNow.length}</span></h3>
          ${empty}
          <div class="lv-grid">
            ${filteredNow.map((s) => {
              const cleanTitle = stripHashtags(s.title) || t("live_untitled_live");
              const tags = extractTags(s.title).slice(0, 3);
              return `<a class="lv-tile" href="/live/${esc(s.id)}" data-live-id="${esc(s.id)}">
                <div class="lv-poster">
                  ${posterHtml(s)}
                  <span class="lv-badge-live"><span class="live-dot"></span>${t("live_badge_live")}</span>
                  <span class="lv-badge-since">${esc(fmtRelative(s.started_at))}</span>
                </div>
                <div class="lv-tile-body">
                  <strong class="lv-tile-title">${esc(cleanTitle)}</strong>
                  <small class="lv-tile-owner">@${esc(s.owner_handle)}${s.owner_name && s.owner_name !== s.owner_handle ? ` · ${esc(s.owner_name)}` : ""}</small>
                  ${tags.length ? `<div class="lv-tile-tags">${tags.map((t) => `<span class="lv-tile-tag">#${esc(t)}</span>`).join("")}</div>` : ""}
                </div>
              </a>`;
            }).join("")}
          </div>
        </section>`);
    }

    // Section À VENIR — liste compacte (filtrée aussi).
    if (scheduled.length) {
      const empty = filteredScheduled.length === 0 && filtering
        ? `<p class="lbl-sm" style="opacity:.6;padding:.5rem .2rem">${t("live_none_scheduled_match")}</p>`
        : "";
      sections.push(`
        <section class="live-section">
          <h3 class="live-section-h">${t("live_upcoming")} <span class="lv-count">${filteredScheduled.length}/${scheduled.length}</span></h3>
          ${empty}
          ${filteredScheduled.map((e) => {
            const cleanTitle = stripHashtags(e.title) || t("live_untitled_live");
            return `<a class="live-card live-card--sched" href="/@${esc(e.owner_handle)}">
              <span class="live-card-icon">📅</span>
              <div class="live-card-body">
                <strong>${esc(cleanTitle)}</strong>
                <small>@${esc(e.owner_handle)} · ${esc(fmtWhen(e.starts_at))} (${fmtRelative(e.starts_at)})</small>
              </div>
            </a>`;
          }).join("")}
        </section>`);
    }

    // Empty state global si rien à montrer et pas créateur.
    if (!myActive && !liveNow.length && !scheduled.length && mine.length === 0) {
      sections.push(`
        <section class="live-section live-empty">
          <p class="lbl-sm" style="opacity:.7">
            ${t("live_empty_global")}
          </p>
        </section>`);
    }

    body.innerHTML = sections.join("");
  }

  // Recherche : debounced light (input event), Esc pour vider.
  let searchTimer = null;
  searchInput?.addEventListener("input", () => {
    state.query = searchInput.value || "";
    searchClear.hidden = !state.query;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderFeed, 120);
  });
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      state.query = "";
      searchClear.hidden = true;
      renderFeed();
    }
  });
  searchClear?.addEventListener("click", () => {
    searchInput.value = "";
    state.query = "";
    searchClear.hidden = true;
    searchInput.focus();
    renderFeed();
  });

  // Click sur un chip de tag → bascule le filtre. Re-clic même chip = retire.
  tagBar?.addEventListener("click", (e) => {
    const chip = e.target.closest(".lv-tag");
    if (!chip) return;
    const tag = chip.dataset.tag || "";
    state.tag = (state.tag === tag && tag) ? "" : tag;
    renderFeed();
  });

  void refresh();
  // Rafraîchit toutes les 30 s tant que l'onglet est dans le viewport. On reste
  // sobre — c'est un panneau secondaire, pas besoin de SSE pour l'instant.
  const timer = setInterval(() => { if (colEl.classList.contains("active")) void refresh(); }, 30_000);
  // Le deck ne déwire pas les colonnes ; on nettoie via beforeunload.
  window.addEventListener("beforeunload", () => clearInterval(timer), { once: true });
}
