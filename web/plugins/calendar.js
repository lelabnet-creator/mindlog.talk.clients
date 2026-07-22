/* ============================================================================
 * Plugin : Calendrier (Jour / Semaine / Mois, style MS Teams) + demande de RDV
 * ----------------------------------------------------------------------------
 * Disponibilités par jour (libre en semaine, occupé le week-end par défaut ;
 * seules les exceptions sont stockées dans `overrides`), événements du
 * propriétaire affichés en chips/blocs, modale de RDV pour les visiteurs.
 *
 * Exposé sous `host.calendar` :
 *   - html(overrides, editable, dayLoad, canBook=true, events=[])
 *   - wire(container, overrides, editable, handle, dayLoad, locked=false,
 *          events=[], onEventClick=fn)
 *   - openBooking(handle, day)
 *   - fmtDay(iso)
 *   - defaultStatus(iso)
 *   - setAvailability(a)
 *
 * `dayLoad` reste comme avant (compteur d'events par jour pour la heatmap en
 * vue publique). `events` est la nouvelle liste plate des événements à rendre
 * (chips/blocs). Si on est éditeur, `onEventClick(eventObj)` est appelé au clic
 * sur un chip → l'app ouvre la modale d'édition.
 * ========================================================================== */

import { t } from "../i18n.js";

export default function register(host) {
  const { esc, api, toast, jsonAuth, isLoggedIn, viewerHeaders } = host;

  const pad2 = (n) => String(n).padStart(2, "0");
  const isoDay = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
  const isoDayOf = (date) => isoDay(date.getFullYear(), date.getMonth(), date.getDate());

  // Règle de dispo générale courante (jours de semaine + périodes), réglée par
  // l'app avant chaque rendu via setAvailability(). Par défaut : L-V libre.
  const DEFAULT_AVAIL = {
    weekdays: [true, true, true, true, true, false, false],
    periods: [],
    start: "08:00",
    end: "19:00",
    slot_minutes: 30,
  };
  let currentAvail = DEFAULT_AVAIL;
  function setAvailability(a) {
    currentAvail = a && Array.isArray(a.weekdays) && a.weekdays.length === 7
      ? {
          weekdays: a.weekdays,
          periods: Array.isArray(a.periods) ? a.periods : [],
          start: typeof a.start === "string" ? a.start : DEFAULT_AVAIL.start,
          end: typeof a.end === "string" ? a.end : DEFAULT_AVAIL.end,
          slot_minutes: a.slot_minutes || DEFAULT_AVAIL.slot_minutes,
        }
      : DEFAULT_AVAIL;
  }

  function defaultStatus(iso) {
    for (const p of currentAvail.periods) {
      if (p && iso >= p.from && iso <= p.to) return p.free ? "free" : "busy";
    }
    const wd = new Date(iso + "T00:00:00Z").getUTCDay();
    return currentAvail.weekdays[(wd + 6) % 7] ? "free" : "busy";
  }

  function fmtDay(iso) {
    return new Date(iso + "T00:00:00Z").toLocaleDateString("fr-FR", {
      weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
    });
  }

  /* ----------------------- État partagé du calendrier ---------------------- */
  // calOffset : décalage en mois (compatibilité existante, vue Mois).
  // cursor    : ancre Date pour Day/Week (lundi de la semaine ou jour visible).
  // view      : "month" | "week" | "day".
  let calOffset = 0;
  let cursor = new Date();
  let view = "month";

  function calYearMonth(offset) {
    const now = new Date();
    let m = now.getMonth() + offset;
    let y = now.getFullYear() + Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return { y, m };
  }

  // Lundi de la semaine contenant `date`, sans muter `date`.
  function mondayOf(date) {
    const d = new Date(date);
    const wd = (d.getDay() + 6) % 7; // 0 = lundi
    d.setDate(d.getDate() - wd);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  /* --------------------------- Heatmap (vue Mois pub) --------------------- */
  function heatClass(n) {
    if (!n) return "heat-0";
    if (n <= 1) return "heat-0";
    if (n <= 3) return "heat-mid";
    return "heat-high";
  }

  /* ----------------------- Indexation des événements ---------------------- */
  // Regroupe les events par ISO day (UTC). Un event qui chevauche plusieurs
  // jours est répété sur chacun. Conserve le tri par heure de début.
  function eventsByDay(events) {
    const map = new Map();
    for (const e of events || []) {
      if (!e?.starts_at) continue;
      const s = new Date(e.starts_at);
      const end = e.ends_at ? new Date(e.ends_at) : new Date(s.getTime() + 60 * 60_000);
      if (isNaN(s) || isNaN(end)) continue;
      const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      while (cur <= last) {
        const k = isoDayOf(cur);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(e);
        cur.setDate(cur.getDate() + 1);
      }
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.starts_at || "").localeCompare(b.starts_at || ""));
    }
    return map;
  }

  function fmtHourMin(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function chipClass(ev) {
    return ev?.kind === "live" ? "cal-chip is-live" : "cal-chip is-event";
  }

  /* ------------------------------ Toolbar --------------------------------- */
  function viewToolbar(title) {
    const tab = (k, label) =>
      `<button type="button" class="cal-view-tab${view === k ? " active" : ""}" data-view="${k}" role="tab" aria-selected="${view === k}">${label}</button>`;
    return `
      <div class="cal-toolbar">
        <div class="cal-nav-cluster">
          <button class="cal-nav" type="button" data-cal-prev aria-label="${t("caln_prev")}">‹</button>
          <button class="cal-nav cal-today" type="button" data-cal-today>${t("caln_today")}</button>
          <button class="cal-nav" type="button" data-cal-next aria-label="${t("caln_next")}">›</button>
        </div>
        <span class="cal-title">${title}</span>
        <div class="cal-view-tabs" role="tablist" aria-label="${t("caln_view_type")}">
          ${tab("day", t("caln_view_day"))}
          ${tab("week", t("caln_view_week"))}
          ${tab("month", t("caln_view_month"))}
        </div>
      </div>`;
  }

  /* ------------------------------- Vue Mois ------------------------------- */
  function monthInner(overrides, editable, counts, canBook, evMap) {
    const { y, m } = calYearMonth(calOffset);
    const now = new Date();
    const todayIso = isoDayOf(now);
    const first = new Date(Date.UTC(y, m, 1));
    const title = first.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const startOffset = (first.getUTCDay() + 6) % 7;
    const dows = t("caln_dow_initials").split(",").map((d) => `<div class="cal-dow">${d}</div>`).join("");

    const heatmap = !!counts && !editable;
    let cells = "";
    for (let i = 0; i < startOffset; i++) cells += '<div class="cal-cell empty"></div>';

    for (let d = 1; d <= days; d++) {
      const iso = isoDay(y, m, d);
      const status = overrides[iso] || defaultStatus(iso);
      const past = iso < todayIso;
      const isToday = iso === todayIso;
      const n = counts ? counts[iso] || 0 : 0;
      const dayEvents = (evMap.get(iso) || []);

      const cls = [
        "cal-cell",
        heatmap ? heatClass(n) : status,
        past ? "past" : "",
        isToday ? "is-today" : "",
        dayEvents.length ? "has-events" : "",
      ].filter(Boolean).join(" ");

      let attr = "";
      if (!past && editable) {
        const load = dayEvents.length ? ` — ${dayEvents.length} ${dayEvents.length > 1 ? t("caln_events_plural") : t("caln_event_singular")}` : "";
        attr = `data-day="${iso}" title="${t("caln_cell_toggle_title").replace("{load}", load)}"`;
      } else if (!past && !editable && canBook && status === "free") {
        attr = `data-book="${iso}" title="${t("caln_book_day")}"`;
      }
      const inert = past || (!editable && (status === "busy" || !canBook));

      // Chips d'événements : max 2 visibles + "+N" si plus. Chips cliquables en
      // éditeur (édition d'event) ; en vue publique, juste lecture.
      const MAX_CHIPS = 2;
      const chips = dayEvents.slice(0, MAX_CHIPS).map((ev) => {
        const t = ev.starts_at ? fmtHourMin(new Date(ev.starts_at)) : "";
        const tt = `${t ? t + " — " : ""}${ev.title || ""}`;
        return `<button type="button" class="${chipClass(ev)}" data-event-id="${ev.id}" title="${esc(tt)}">
          <span class="cal-chip-time">${t}</span>
          <span class="cal-chip-title">${esc(ev.title || "")}</span>
        </button>`;
      }).join("");
      const overflow = dayEvents.length > MAX_CHIPS
        ? `<span class="cal-chip-more" title="${t("caln_events_tooltip").replace("{n}", dayEvents.length)}">+${dayEvents.length - MAX_CHIPS}</span>`
        : "";

      // En éditeur, bouton « + » au survol → nouvel événement ce jour-là
      // (heure par défaut = début de plage). Dispatch le même event que les
      // cases horaires des vues Jour/Semaine.
      const addBtn = (editable && !past)
        ? `<button type="button" class="cal-cell-add" data-add-day="${iso}" title="${t("caln_add_event")}" aria-label="${t("caln_add_event_on").replace("{date}", iso)}">+</button>`
        : "";

      cells += `<div class="cal-cell-wrap">
        <button class="${cls}" ${attr} ${inert ? "disabled" : ""}>
          <span class="cal-cell-num">${d}</span>
        </button>
        ${addBtn}
        ${(chips || overflow) ? `<div class="cal-cell-chips">${chips}${overflow}</div>` : ""}
      </div>`;
    }

    const prevDisabled = calOffset <= 0 ? "disabled" : "";
    const legend = heatmap
      ? `<div class="cal-legend"><span><i class="dot-heat-0"></i> 0-1</span><span><i class="dot-heat-mid"></i> 2-3</span><span><i class="dot-heat-high"></i> 4+</span><span>${t("caln_day_load")}</span></div>`
      : `<div class="cal-legend">
          <span><i class="dot-free"></i> ${t("caln_available")}</span>
          <span><i class="dot-busy"></i> ${t("caln_busy")}</span>
          ${editable ? `<span>${t("caln_click_toggle")}</span>` : canBook ? `<span>${t("caln_click_book")}</span>` : ""}
        </div>`;

    return {
      title,
      html: `${viewToolbar(title).replace("data-cal-prev", `data-cal-prev ${prevDisabled}`)}
        <div class="cal-month-grid">${dows}${cells}</div>
        ${legend}`,
    };
  }

  /* ----------------------- Grille horaire (Day / Week) -------------------- */
  function hourRange() {
    const [sh] = currentAvail.start.split(":").map(Number);
    const [eh] = currentAvail.end.split(":").map(Number);
    // Marge d'1h autour de la plage configurée pour mieux situer les events
    // qui sortent légèrement du créneau de travail.
    return { startHour: Math.max(0, sh - 1), endHour: Math.min(24, eh + 1) };
  }

  function timeGridDays(days, editable, canBook, overrides, evMap, onClickDay) {
    const { startHour, endHour } = hourRange();
    const nbHours = endHour - startHour;
    const rowH = 40; // px par heure (cf. .cal-time-row)
    const now = new Date();
    const todayIso = isoDayOf(now);
    // Position de la ligne « maintenant » en FRACTION d'heures depuis startHour ;
    // convertie en px via var(--cal-row-h) au rendu (la hauteur de ligne est
    // ajustée par fitTimeGrid pour remplir l'espace).
    const nowTopH = now.getHours() - startHour + now.getMinutes() / 60;

    // Rail des heures à gauche
    const hourLabels = Array.from({ length: nbHours }, (_, i) => {
      const h = startHour + i;
      return `<div class="cal-time-row"><span class="cal-time-lbl">${pad2(h)}:00</span></div>`;
    }).join("");

    // Colonnes-jours
    const cols = days.map((d) => {
      const iso = isoDayOf(d);
      const status = overrides[iso] || defaultStatus(iso);
      const past = iso < todayIso;
      const isToday = iso === todayIso;
      const dayEvents = evMap.get(iso) || [];

      // Blocs d'événements positionnés en absolu dans la colonne. Le contenu
      // est ordonné par densité d'info (titre + heure → end-time + lieu →
      // notes) : `overflow:hidden` clippe naturellement ce qui ne tient pas
      // dans la hauteur du bloc, donc on garde le plus important en tête.
      const blocks = dayEvents.map((ev) => {
        const s = new Date(ev.starts_at);
        const end = ev.ends_at ? new Date(ev.ends_at) : new Date(s.getTime() + 60 * 60_000);
        // top/hauteur exprimés en heures (fraction) → px via var(--cal-row-h).
        const topH = Math.max(0, (s.getHours() + s.getMinutes() / 60) - startHour);
        const durH = Math.max(0, (end - s) / 3_600_000);
        const t = fmtHourMin(s);
        const tEnd = fmtHourMin(end);
        const tooltipBase = `${t} — ${tEnd} · ${ev.title || ""}`;
        const tooltip = ev.location ? `${tooltipBase} · ${ev.location}` : tooltipBase;
        const locHtml = ev.location ? `<span class="cal-block-loc">📍 ${esc(ev.location)}</span>` : "";
        const notesHtml = ev.notes ? `<div class="cal-block-notes">${esc(ev.notes)}</div>` : "";
        return `<button type="button" class="cal-time-block ${ev.kind === "live" ? "is-live" : "is-event"}"
          data-event-id="${ev.id}"
          style="top:calc(var(--cal-row-h) * ${topH});height:calc(var(--cal-row-h) * ${durH} - 2px)"
          title="${esc(tooltip)}">
          <div class="cal-block-row cal-block-head">
            <span class="cal-block-time">${t}</span>
            <span class="cal-block-title">${esc(ev.title || "")}</span>
          </div>
          <div class="cal-block-row cal-block-meta">
            <span class="cal-block-range">→ ${tEnd}</span>
            ${locHtml}
          </div>
          ${notesHtml}
        </button>`;
      }).join("");

      // Cases horaires (clic = nouvel event en éditeur, demande de RDV sinon)
      const slots = Array.from({ length: nbHours }, (_, i) => {
        const hour = startHour + i;
        const slotIso = `${iso}T${pad2(hour)}:00`;
        const clickable =
          !past && (
            (editable) ||
            (!editable && canBook && status === "free")
          );
        const attr = clickable
          ? (editable
              ? `data-slot-new="${slotIso}"`
              : `data-slot-book="${iso}|${pad2(hour)}:00"`)
          : "";
        return `<button type="button" class="cal-time-slot" ${attr} ${clickable ? "" : "disabled"}></button>`;
      }).join("");

      // Header de colonne : jour + dot d'état (free/busy). En éditeur, le dot
      // devient un bouton qui bascule la dispo (équivalent du clic sur cellule
      // en vue Mois). En public, le dot reste informatif et permet de demander
      // un RDV si le jour est libre.
      const statusCls = past ? "is-past" : (status === "free" ? "is-free" : "is-busy");
      const dotAttr = past
        ? ""
        : editable
          ? `data-day-toggle="${iso}" title="${t("caln_toggle_avail")}"`
          : (canBook && status === "free")
            ? `data-day-book="${iso}" title="${t("caln_book")}"`
            : "";
      const colHeader = `<div class="cal-day-header ${isToday ? "is-today" : ""} ${statusCls}">
        <span class="cal-day-dow">${d.toLocaleDateString("fr-FR", { weekday: "short" })}</span>
        <span class="cal-day-num">${d.getDate()}</span>
        <button type="button" class="cal-day-dot" ${dotAttr} ${dotAttr ? "" : "disabled"} aria-label="${status === "free" ? t("caln_available") : t("caln_busy")}">
          <span class="cal-day-dot-label">${status === "free" ? t("caln_free") : t("caln_busy")}</span>
        </button>
      </div>`;

      return `<div class="cal-day-col ${past ? "past" : ""} ${isToday ? "is-today" : ""} ${statusCls}" data-iso="${iso}">
        ${colHeader}
        <div class="cal-day-body ${statusCls}" data-day="${iso}" style="height:calc(var(--cal-row-h) * ${nbHours})">
          ${slots}
          ${blocks}
        </div>
      </div>`;
    }).join("");

    // Ligne « maintenant » globale : une seule pour toute la grille, traverse
    // toutes les colonnes visibles. Affichée uniquement si aujourd'hui est dans
    // la fenêtre rendue et que l'heure tombe dans la plage horaire affichée.
    const todayInRange = days.some((d) => isoDayOf(d) === todayIso);
    const headerH = 64; // doit matcher .cal-day-header height
    const nowLineGlobal =
      todayInRange && nowTopH >= 0 && nowTopH <= nbHours
        ? `<div class="cal-now-line" style="top:calc(${headerH}px + var(--cal-row-h) * ${nowTopH})" aria-hidden="true">
            <span class="cal-now-label">${pad2(now.getHours())}:${pad2(now.getMinutes())}</span>
          </div>`
        : "";

    return `<div class="cal-time-grid" data-rows="${nbHours}" style="--cal-row-h:${rowH}px">
      <div class="cal-time-rail">
        <div class="cal-day-header is-spacer"></div>
        ${hourLabels}
      </div>
      <div class="cal-time-cols">
        ${cols}
        ${nowLineGlobal}
      </div>
    </div>`;
  }

  function weekInner(overrides, editable, canBook, evMap) {
    const monday = mondayOf(cursor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const last = days[6];
    const sameMonth = monday.getMonth() === last.getMonth();
    const title = sameMonth
      ? `${monday.getDate()} — ${last.getDate()} ${monday.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`
      : `${monday.getDate()} ${monday.toLocaleDateString("fr-FR", { month: "short" })} — ${last.getDate()} ${last.toLocaleDateString("fr-FR", { month: "short", year: "numeric" })}`;
    return {
      title,
      html: `${viewToolbar(title)}
        ${timeGridDays(days, editable, canBook, overrides, evMap)}`,
    };
  }

  function dayInner(overrides, editable, canBook, evMap) {
    const d = new Date(cursor);
    d.setHours(0, 0, 0, 0);
    const title = d.toLocaleDateString("fr-FR", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
    return {
      title,
      html: `${viewToolbar(title)}
        ${timeGridDays([d], editable, canBook, overrides, evMap)}`,
    };
  }

  /* ----------------------------- Render & wire ---------------------------- */
  function renderInner(overrides, editable, counts, canBook, events) {
    const evMap = eventsByDay(events);
    if (view === "month") return monthInner(overrides, editable, counts, canBook, evMap);
    if (view === "week") return weekInner(overrides, editable, canBook, evMap);
    return dayInner(overrides, editable, canBook, evMap);
  }

  function calendarHtml(overrides, editable, counts, canBook = true, events = []) {
    const { html } = renderInner(overrides || {}, editable, counts, canBook, events);
    return `<div class="calendar view-${view}">${html}</div>`;
  }

  // Étire la grille Jour/Semaine pour remplir la hauteur disponible : on calcule
  // la hauteur de ligne (var --cal-row-h) à partir de l'espace réel, de sorte que
  // header + nbHours lignes occupent toute la grille (plus de grand vide sous le
  // calendrier). Plancher à 40px → si l'espace manque, la grille défile
  // (overflow:auto) au lieu de tasser les lignes. Un seul ResizeObserver vivant à
  // la fois (réattaché à chaque (re)rendu).
  const TIME_HEADER_H = 64; // doit matcher .cal-day-header height
  const MIN_ROW_H = 40;
  let _calResizeObs = null;
  function fitTimeGrid(container) {
    const grid = container?.querySelector(".cal-time-grid");
    if (_calResizeObs) { _calResizeObs.disconnect(); _calResizeObs = null; }
    if (!grid) return; // vue Mois : rien à étirer
    const apply = () => {
      const rows = Number(grid.dataset.rows) || 0;
      if (!rows) return;
      const avail = grid.clientHeight - TIME_HEADER_H;
      if (avail <= 0) return;
      const rowH = Math.max(MIN_ROW_H, avail / rows);
      grid.style.setProperty("--cal-row-h", `${rowH}px`);
    };
    apply();
    if (typeof ResizeObserver !== "undefined") {
      // Observe la grille (hauteur pilotée par le parent flex, pas par son
      // contenu) → modifier --cal-row-h ne reboucle pas.
      _calResizeObs = new ResizeObserver(apply);
      _calResizeObs.observe(grid);
    }
  }

  // Câblage : navigation, switcher de vue, clics jours/slots/chips.
  // `onEventClick(ev)` est appelé par le code éditeur pour ouvrir la modale d'édition.
  // ATTENTION : le 6e paramètre est bien `canBook` (true=autorise la demande
  // de RDV, false=non — typiquement `false` sur sa propre page publique). Ne
  // pas inverser : les appelants passent `!isSelf`.
  function wireCalendar(container, overrides, editable, handle, counts, canBook = true, events = [], onEventClick) {
    if (!container) return;
    const eventsById = new Map((events || []).map((e) => [String(e.id), e]));

    const rerender = () => {
      const { html } = renderInner(overrides, editable, counts, canBook, events);
      container.innerHTML = html;
      const wrap = container.closest(".calendar");
      if (wrap) wrap.className = `calendar view-${view}`;
      wireCalendar(container, overrides, editable, handle, counts, canBook, events, onEventClick);
    };

    container.querySelector("[data-cal-prev]")?.addEventListener("click", () => {
      if (view === "month") {
        if (calOffset > 0) calOffset--;
      } else if (view === "week") {
        cursor = addDays(cursor, -7);
      } else {
        cursor = addDays(cursor, -1);
      }
      rerender();
    });
    container.querySelector("[data-cal-next]")?.addEventListener("click", () => {
      if (view === "month") calOffset++;
      else if (view === "week") cursor = addDays(cursor, 7);
      else cursor = addDays(cursor, 1);
      rerender();
    });
    container.querySelector("[data-cal-today]")?.addEventListener("click", () => {
      calOffset = 0;
      cursor = new Date();
      rerender();
    });
    container.querySelectorAll("[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        view = b.dataset.view === "day" || b.dataset.view === "week" ? b.dataset.view : "month";
        rerender();
      })
    );

    // Chips d'événements (vue Mois) → ouverture en édition au clic.
    if (editable && typeof onEventClick === "function") {
      container.querySelectorAll(".cal-chip[data-event-id]").forEach((b) =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const ev = eventsById.get(b.dataset.eventId);
          if (ev) onEventClick(ev);
        })
      );
    }

    // Blocs d'événements (vues Jour/Semaine) → drag-to-move + resize bord bas.
    // Clic court (< 4px de mouvement) = édition ; sinon = MAJ starts_at/ends_at
    // via PUT /api/agenda/:id, snap au pas slot_minutes. Drag horizontal entre
    // colonnes en vue Semaine (l'event change de jour).
    if (editable && (view === "week" || view === "day")) {
      // Hauteur de ligne RÉELLE (étirée par fitTimeGrid) plutôt que la constante :
      // sinon le drag/redimensionnement calcule des heures fausses dès que la
      // grille remplit l'espace.
      const gridEl = container.querySelector(".cal-time-grid");
      const rowHpx = () => parseFloat(gridEl && getComputedStyle(gridEl).getPropertyValue("--cal-row-h")) || 40;
      const snapMin = currentAvail.slot_minutes || 30;
      const { startHour } = hourRange();

      container.querySelectorAll(".cal-time-block[data-event-id]").forEach((block) => {
        const ev = eventsById.get(block.dataset.eventId);
        if (!ev) return;
        let session = null;

        // Sépare le clic de la prise (drag/resize) : on regarde la distance
        // parcourue avant pointerup. Pas de preventDefault au pointerdown pour
        // ne pas casser le focus/clic court.
        block.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          // Ignore les clics sur le bouton de fermeture/contenu interactif éventuel.
          const rect = block.getBoundingClientRect();
          const onResizeEdge = (e.clientY - rect.top) > rect.height - 8;
          // offsetTop/offsetHeight (et non parseFloat(style)) car top/height sont
          // exprimés en calc(var(--cal-row-h)…) → non parsables en px.
          session = {
            mode: onResizeEdge ? "resize" : "move",
            startY: e.clientY,
            startX: e.clientX,
            startTop: block.offsetTop || 0,
            startHeight: block.offsetHeight || rowHpx(),
            snapPx: (snapMin / 60) * rowHpx(),
            startColIso: block.closest(".cal-day-body")?.dataset.day || null,
            moved: false,
          };
          block.setPointerCapture(e.pointerId);
        });

        block.addEventListener("pointermove", (e) => {
          if (!session) return;
          const dy = e.clientY - session.startY;
          const dx = e.clientX - session.startX;
          if (!session.moved && (Math.abs(dy) > 4 || Math.abs(dx) > 4)) {
            session.moved = true;
            block.classList.add("is-dragging");
          }
          if (!session.moved) return;
          // Snap au plus proche multiple de snapPx
          const snapPx = session.snapPx;
          const snappedDy = Math.round(dy / snapPx) * snapPx;

          if (session.mode === "resize") {
            const newH = Math.max(snapPx, session.startHeight + snappedDy);
            block.style.height = newH + "px";
          } else {
            // Déplacement vertical (heure)
            const newTop = Math.max(0, session.startTop + snappedDy);
            block.style.top = newTop + "px";
            // Déplacement horizontal entre colonnes (semaine uniquement)
            if (view === "week") {
              const cols = [...container.querySelectorAll(".cal-day-col")];
              const colUnder = cols.find((c) => {
                const r = c.getBoundingClientRect();
                return e.clientX >= r.left && e.clientX <= r.right;
              });
              const destBody = colUnder?.querySelector(".cal-day-body");
              if (destBody && destBody !== block.parentNode) {
                destBody.appendChild(block); // change de colonne, conserve top/height
              }
            }
          }
        });

        const finish = async (e) => {
          if (!session) return;
          const wasMoved = session.moved;
          const mode = session.mode;
          session = null;
          block.classList.remove("is-dragging");
          try { block.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }

          if (!wasMoved) {
            // Tap court → édition. On laisse pointerup déclencher le click natif.
            return;
          }
          // Empêche le click natif qui suivrait d'ouvrir la modale
          const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); block.removeEventListener("click", swallow, true); };
          block.addEventListener("click", swallow, true);

          // Recalcule starts_at/ends_at (offset* car style en calc()).
          const rowPx = rowHpx();
          const newTopPx = block.offsetTop || 0;
          const newHeightPx = block.offsetHeight || rowPx;
          const destIso = block.closest(".cal-day-body")?.dataset.day;
          if (!destIso) { rerender(); return; }
          const [yyyy, mm, dd] = destIso.split("-").map(Number);
          const startMinutes = startHour * 60 + (newTopPx / rowPx) * 60;
          const startDate = new Date(yyyy, mm - 1, dd, 0, 0, 0);
          startDate.setMinutes(Math.round(startMinutes));
          const durationMin = Math.max(snapMin, Math.round((newHeightPx / rowPx) * 60));
          const endDate = new Date(startDate.getTime() + durationMin * 60_000);
          const payload = {
            starts_at: startDate.toISOString(),
            ends_at: endDate.toISOString(),
          };
          try {
            await api(`/api/agenda/${ev.id}`, {
              method: "PUT", headers: jsonAuth(), body: JSON.stringify(payload),
            });
            ev.starts_at = payload.starts_at;
            ev.ends_at = payload.ends_at;
            toast(mode === "resize" ? t("caln_duration_updated") : t("caln_event_moved"));
            rerender();
          } catch (err) {
            toast(err.message || t("caln_save_failed"));
            rerender(); // revient à l'état serveur
          }
        };
        block.addEventListener("pointerup", finish);
        block.addEventListener("pointercancel", finish);

        // Click natif sur bloc non-bougé → édition
        block.addEventListener("click", (e) => {
          if (block.classList.contains("is-dragging")) return;
          e.stopPropagation();
          if (typeof onEventClick === "function") onEventClick(ev);
        });
      });
    }

    // Mois : bascule dispo (éditeur) ou demande RDV (public).
    if (view === "month") {
      if (editable) {
        // Bouton « + » au survol d'une cellule → nouvel événement ce jour-là.
        container.querySelectorAll("[data-add-day]").forEach((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            const startsAt = `${b.dataset.addDay}T${currentAvail.start || "09:00"}`;
            container.dispatchEvent(new CustomEvent("calendar:newAt", { detail: { startsAt } }));
          })
        );
        container.querySelectorAll("[data-day]").forEach((b) =>
          b.addEventListener("click", async () => {
            const day = b.dataset.day;
            const cur = overrides[day] || defaultStatus(day);
            const next = cur === "free" ? "busy" : "free";
            try {
              await api(`/api/availability/${day}`, {
                method: "PUT", headers: jsonAuth(), body: JSON.stringify({ status: next }),
              });
              if (next === defaultStatus(day)) delete overrides[day];
              else overrides[day] = next;
              rerender();
            } catch (e) { toast(e.message); }
          })
        );
      } else {
        container.querySelectorAll("[data-book]").forEach((b) =>
          b.addEventListener("click", () =>
            openBooking(handle, { day: b.dataset.book, label: fmtDay(b.dataset.book) })
          )
        );
      }
    }

    // Day/Week : dot du header — bascule dispo (éditeur) ou ouvre la modale
    // RDV pour le jour (visiteur).
    if (view === "week" || view === "day") {
      if (editable) {
        container.querySelectorAll("[data-day-toggle]").forEach((b) =>
          b.addEventListener("click", async (e) => {
            e.stopPropagation();
            const day = b.dataset.dayToggle;
            const cur = overrides[day] || defaultStatus(day);
            const next = cur === "free" ? "busy" : "free";
            try {
              await api(`/api/availability/${day}`, {
                method: "PUT", headers: jsonAuth(), body: JSON.stringify({ status: next }),
              });
              if (next === defaultStatus(day)) delete overrides[day];
              else overrides[day] = next;
              rerender();
            } catch (err) { toast(err.message); }
          })
        );
      } else {
        container.querySelectorAll("[data-day-book]").forEach((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            const iso = b.dataset.dayBook;
            openBooking(handle, { day: iso, label: fmtDay(iso) });
          })
        );
      }
      // Clic dans une case horaire vide → nouvel event (éditeur) ou RDV ciblé (visiteur).
      if (editable) {
        container.querySelectorAll("[data-slot-new]").forEach((b) =>
          b.addEventListener("click", () => {
            const ev = new CustomEvent("calendar:newAt", { detail: { startsAt: b.dataset.slotNew } });
            container.dispatchEvent(ev);
          })
        );
      } else {
        container.querySelectorAll("[data-slot-book]").forEach((b) =>
          b.addEventListener("click", () => {
            const [iso, time] = b.dataset.slotBook.split("|");
            openBooking(handle, { day: iso, label: fmtDay(iso), time });
          })
        );
      }
    }

    // Étire la grille horaire pour remplir l'espace dispo (vues Jour/Semaine).
    fitTimeGrid(container);
  }

  /* --------------------------- Modale RDV (visiteur) ---------------------- */
  function openBooking(handle, day) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="bk-title">
        <button type="button" class="close" id="bk-close" aria-label="${t("com_close")}">✕</button>
        <h2 id="bk-title">${t("caln_book")}</h2>
        <p class="sub">${day ? t("caln_wanted_date").replace("{label}", esc(day.label)) : t("caln_leave_contact").replace("{handle}", esc(handle))}</p>
        ${day ? '<div class="bk-slots" id="bk-slots" hidden></div>' : ""}
        <form id="bk-form">
          <div class="group">
            <label for="bk-name">${t("caln_your_name")}</label>
            <input id="bk-name" required />
          </div>
          <div class="group">
            <label for="bk-email">${t("caln_email")}</label>
            <input id="bk-email" type="email" placeholder="${t("caln_email_ph")}" />
          </div>
          <div class="group">
            <label for="bk-msg">${t("caln_msg_optional")}</label>
            <textarea id="bk-msg" rows="3"></textarea>
          </div>
          <div class="err" id="bk-err"></div>
          <div class="actions">
            <button type="button" class="btn" id="bk-cancel">${t("com_cancel")}</button>
            <button type="submit" class="btn primary">${t("caln_send_request")}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);

    let selectedTime = day?.time || null;
    if (day?.day) {
      const slotsBox = overlay.querySelector("#bk-slots");
      api(`/api/identities/${encodeURIComponent(handle)}/slots?day=${encodeURIComponent(day.day)}`, {
        headers: isLoggedIn() ? viewerHeaders() : {},
      })
        .then((res) => {
          if (!slotsBox) return;
          const slots = res.slots || [];
          if (!slots.length) return;
          slotsBox.hidden = false;
          slotsBox.innerHTML =
            '<span class="bk-slots-label">' + t("caln_wanted_slot") + '</span><div class="bk-slot-grid">' +
            slots.map((s) =>
              `<button type="button" class="bk-slot${s.taken ? " taken" : ""}${s.time === selectedTime ? " sel" : ""}" data-time="${esc(s.time)}" ${s.taken ? "disabled" : ""}>${esc(s.time)}</button>`
            ).join("") +
            "</div>";
          slotsBox.querySelectorAll(".bk-slot:not(.taken)").forEach((b) =>
            b.addEventListener("click", () => {
              const on = b.classList.contains("sel");
              slotsBox.querySelectorAll(".bk-slot").forEach((x) => x.classList.remove("sel"));
              if (!on) { b.classList.add("sel"); selectedTime = b.dataset.time; }
              else selectedTime = null;
            })
          );
        })
        .catch(() => { /* créneaux indisponibles → demande sans heure */ });
    }

    if (isLoggedIn()) {
      api("/api/me", { headers: viewerHeaders() })
        .then((me) => {
          const dn = (me.fields || []).find((f) => f.key === "display_name")?.value;
          const nameEl = overlay.querySelector("#bk-name");
          const emailEl = overlay.querySelector("#bk-email");
          if (nameEl && !nameEl.value) nameEl.value = dn || me.handle || "";
          if (emailEl && !emailEl.value) emailEl.value = me.recoveryEmail || "";
        })
        .catch(() => {});
    }

    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => e.target === overlay && close());
    overlay.querySelector("#bk-cancel").addEventListener("click", close);
    overlay.querySelector("#bk-close").addEventListener("click", close);
    overlay.querySelector("#bk-name").focus();

    overlay.querySelector("#bk-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = overlay.querySelector("#bk-err");
      errEl.textContent = "";
      try {
        const name = overlay.querySelector("#bk-name").value;
        const email = overlay.querySelector("#bk-email").value;
        await api(`/api/identities/${encodeURIComponent(handle)}/requests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            day: day ? day.day : null,
            time: selectedTime,
            name, email,
            message: overlay.querySelector("#bk-msg").value,
          }),
        });
        close();
        host.toast(host.t("msg_request_sent"));
        if (!isLoggedIn() && email) autoRegister(name, email).catch(() => {});
      } catch (err) { errEl.textContent = err.message; }
    });
  }

  async function autoRegister(name, email) {
    const slug = name.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "visiteur";
    const tries = [slug, `${slug}-${Math.floor(Math.random() * 900 + 100)}`];
    for (const handle of tries) {
      try {
        await api("/api/identities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handle, email, display_name: name, autoCreated: true }),
        });
        host.toast(t("caln_account_created"));
        return;
      } catch (err) {
        if (!err.message?.includes("handle")) return;
      }
    }
  }

  host.registerPlugin({ name: "calendar" });
  host.calendar = {
    html: calendarHtml,
    wire: wireCalendar,
    openBooking,
    fmtDay,
    defaultStatus,
    setAvailability,
  };
}
