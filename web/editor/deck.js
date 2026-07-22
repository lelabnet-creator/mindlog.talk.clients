// editor/deck.js — deck horizontal de l'éditeur (GSAP) : navigation, colonnes
// dynamiques. État partagé `deckState` (cols/go/index) muté aussi par l'éditeur
// (renderEditor/wireEditor) côté app.js. Extrait verbatim. cf. docs/web-app-split-proposal.md

// État de navigation du deck, partagé entre l'éditeur et ces fonctions.
export const deckState = { cols: [], go: null, index: 0 };

import { branchNavSvg } from "../ui/icons.js";

export function setupDeck({ animateIntro = true } = {}) {
  const vp = document.getElementById("deck-viewport");
  const deck = document.getElementById("deck");
  if (!vp || !deck) return;
  const cols = [...deck.querySelectorAll(".col")];
  deckState.cols = cols;
  // Chevron « retour au Menu » : injecté en haut à gauche DE CHAQUE colonne
  // (sauf Menu), uniquement si le deck possède une colonne Menu (éditeur, pas
  // profil public). Cliquable, couleur d'accent Milo.
  if (cols.some((c) => c.dataset.deckLabel === "Menu")) {
    const CHEVRON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
    cols.forEach((c) => {
      if (c.dataset.deckLabel === "Menu") return;
      const card = c.querySelector(".card");
      if (!card || card.querySelector(":scope > .deck-back")) return;
      const back = document.createElement("button");
      back.type = "button";
      back.className = "deck-back";
      back.title = "Retour au menu";
      back.setAttribute("aria-label", "Retour au menu");
      back.innerHTML = CHEVRON;
      back.addEventListener("click", (e) => {
        e.stopPropagation();
        const mi = deckState.cols.findIndex((x) => x.dataset.deckLabel === "Menu");
        if (mi >= 0 && deckState.go) deckState.go(mi);
      });
      card.prepend(back);
    });
  }
  const buds = [...document.querySelectorAll("#deck-nav .bud")];
  const marker = document.querySelector("#deck-nav .branch-marker");
  const budXs = marker?.dataset.xs ? marker.dataset.xs.split(",").map(Number) : [];
  const g = window.gsap;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Centrage basé sur la position de mise en page réelle de la colonne i
  // (offsetLeft/offsetWidth ignorent le scale GSAP) → exact à toute taille.
  const targetX = (i) => {
    const c = cols[i] || cols[0];
    return vp.clientWidth / 2 - (c.offsetLeft + c.offsetWidth / 2);
  };
  const clamp = (i) => Math.max(0, Math.min(cols.length - 1, i));

  function go(i, animate = true) {
    deckState.index = clamp(i);
    const x = targetX(deckState.index);
    if (g && animate && !reduce) g.to(deck, { x, duration: 0.55, ease: "power3.out" });
    else g ? g.set(deck, { x }) : (deck.style.transform = `translateX(${x}px)`);
    buds.forEach((b, bi) => b.classList.toggle("active", bi === deckState.index));
    const titleEl = document.getElementById("deck-title");
    if (titleEl) titleEl.textContent = buds[deckState.index]?.dataset.label || "";
    if (marker && budXs.length) {
      const dx = budXs[deckState.index] - budXs[0];
      if (g && animate && !reduce) g.to(marker, { x: dx, duration: 0.5, ease: "power3.out" });
      else if (g) g.set(marker, { x: dx });
      else marker.setAttribute("transform", `translate(${dx} 0)`);
    }
    // L'opacité est pilotée ici (et non via CSS) : GSAP laisse une opacity inline
    // qui sinon écraserait la règle .col.active et figerait la mise en valeur.
    cols.forEach((c, ci) => {
      const on = ci === deckState.index;
      c.classList.toggle("active", on);
      const o = on ? 1 : 0.32;
      const sc = on ? 1 : 0.82; // zoom : la colonne active occupe nettement plus de place
      if (g && animate && !reduce) g.to(c, { opacity: o, scale: sc, duration: 0.4, ease: "power3.out" });
      else if (g) g.set(c, { opacity: o, scale: sc });
      else {
        c.style.opacity = String(o);
        c.style.transform = `scale(${sc})`;
      }
    });
  }

  deckState.go = go;
  // Navigation par label, sur le closure `cols`/`go` courant (jamais périmé) :
  // utilisée par les tests e2e et pratique au débogage. Inoffensif en prod.
  deckState.goLabel = (label) => {
    const i = cols.findIndex((c) => c.dataset.deckLabel === label);
    if (i >= 0) go(i);
    return i >= 0;
  };
  if (typeof window !== "undefined") window.__deckGoLabel = deckState.goLabel;

  function reset() {
    go(clamp(deckState.index), false);
  }
  reset();
  if (!setupDeck._resize) {
    setupDeck._resize = true;
    window.addEventListener("resize", () => {
      if (document.getElementById("deck") && deckState.go) deckState.go(deckState.index, false);
    });
  }

  // Écouteurs au niveau du viewport (molette/tactile/clavier) : liés UNE SEULE
  // fois par viewport (le viewport est recréé à chaque rendu plein écran, mais pas
  // lors de l'ajout/retrait d'une colonne dynamique). Ils lisent l'état courant
  // via `deckState.cols`/`deckState.go`, donc restent corrects après un relancement.
  if (!vp.dataset.deckWired) {
    vp.dataset.deckWired = "1";
    // Molette : priorité au défilement vertical de la col-scroll interne ;
    // navigation gauche/droite seulement si on est en bout de course (ou geste horizontal pur).
    let lock = false;
    vp.addEventListener(
      "wheel",
      (e) => {
        const dcols = deckState.cols;
        if (!deckState.go || !dcols.length) return;
        const col = dcols[deckState.index];
        if (!col) return;
        // L'élément scrollable est .col-scroll à l'intérieur (pattern col-scroll),
        // ou la colonne elle-même si pas de col-scroll (vue publique).
        const scrollEl = col.querySelector(".col-scroll") || col;

        const absX = Math.abs(e.deltaX);
        const absY = Math.abs(e.deltaY);

        // Geste principalement horizontal (trackpad) → navigation gauche/droite directe.
        if (absX > absY * 1.5) {
          e.preventDefault();
          if (lock) return;
          lock = true;
          deckState.go(deckState.index + (e.deltaX > 0 ? 1 : -1));
          setTimeout(() => (lock = false), 480);
          return;
        }

        // Geste vertical : laisser défiler la colonne si elle n'est pas en bout de course.
        const down = e.deltaY > 0;
        const atTop = scrollEl.scrollTop <= 0;
        const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 1;
        if (down && !atBottom) return; // défilement interne possible → ne rien faire
        if (!down && !atTop) return;   // idem

        // En bout de course → changer de colonne.
        if ((down && deckState.index === dcols.length - 1) || (!down && deckState.index === 0)) return;
        e.preventDefault();
        if (lock) return;
        lock = true;
        deckState.go(deckState.index + (down ? 1 : -1));
        setTimeout(() => (lock = false), 480);
      },
      { passive: false }
    );

    // Swipe horizontal (mobile/tactile) : on change de colonne ; le scroll
    // vertical interne de la colonne reste possible (pas de preventDefault).
    let sx = null, sy = null;
    vp.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    vp.addEventListener("touchend", (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && deckState.go) deckState.go(deckState.index + (dx < 0 ? 1 : -1));
      sx = sy = null;
    }, { passive: true });

    vp.tabIndex = 0;
    vp.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" && deckState.go) deckState.go(deckState.index + 1);
      if (e.key === "ArrowLeft" && deckState.go) deckState.go(deckState.index - 1);
    });
  }

  // Tooltip au survol des points de navigation (recréé à chaque relancement, car
  // les points sont régénérés quand la branche de navigation est reconstruite).
  const branch = document.querySelector(".deck-branch");
  branch?.querySelector(".bud-tip")?.remove();
  const tip = document.createElement("div");
  tip.className = "bud-tip";
  tip.hidden = true;
  branch?.appendChild(tip);

  buds.forEach((b) => {
    b.addEventListener("mouseenter", () => {
      const label = b.dataset.label;
      if (!label || !branch) return;
      tip.textContent = label;
      tip.hidden = false;
      // Positionne le tooltip au-dessus du point (coordonnées relatives au branch)
      const bRect = b.getBoundingClientRect();
      const pRect = branch.getBoundingClientRect();
      tip.style.left = `${bRect.left - pRect.left + bRect.width / 2}px`;
    });
    b.addEventListener("mouseleave", () => { tip.hidden = true; });
    b.addEventListener("click", () => { tip.hidden = true; go(Number(b.dataset.col)); });
    b.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go(Number(b.dataset.col));
      }
    });
  });

  // Cliquer une colonne INACTIVE la sélectionne (les clics dans la colonne
  // active passent normalement vers les champs). L'index est lu en direct sur
  // `deckState.cols` pour rester juste après l'insertion/retrait d'une colonne.
  cols.forEach((c) => {
    if (c.dataset.clickWired) return;
    c.dataset.clickWired = "1";
    c.addEventListener("click", () => {
      const ci = deckState.cols.indexOf(c);
      if (ci >= 0 && ci !== deckState.index && deckState.go) deckState.go(ci);
    });
  });

  if (g && !reduce && animateIntro)
    g.from(cols, { opacity: 0, y: 16, duration: 0.45, stagger: 0.08, ease: "power2.out" });
}

// Renumérote les colonnes et reconstruit la branche de navigation (un point par
// colonne) à partir des labels portés par `data-deck-label`.
export function rebuildDeckNav() {
  const deck = document.getElementById("deck");
  const branch = document.querySelector(".deck-branch");
  if (!deck || !branch) return;
  const cols = [...deck.querySelectorAll(".col")];
  cols.forEach((c, i) => (c.dataset.col = i));
  branch.innerHTML = branchNavSvg(cols.length, cols.map((c) => c.dataset.deckLabel || ""));
}

// Ouvre (ou réactive) une colonne dynamique fermable dans le deck. Par défaut
// elle est insérée JUSTE À DROITE de la colonne active (là où on se trouve). On
// peut forcer une position avec `afterLabel` (insertion après ce label).
// Renvoie la <section.col> créée (ou existante), ou null hors éditeur.
export function addDeckColumn({ key, label, html, wire }, afterLabel = null) {
  const deck = document.getElementById("deck");
  if (!deck) return null;
  const sel = window.CSS && CSS.escape ? CSS.escape(key) : key;
  const existing = deck.querySelector(`.col[data-deck-key="${sel}"]`);
  if (existing) {
    if (deckState.go) deckState.go(deckState.cols.indexOf(existing));
    return existing;
  }
  const section = document.createElement("section");
  section.className = "col";
  section.dataset.deckKey = key;
  section.dataset.deckLabel = label;
  section.innerHTML = html;
  const cols = [...deck.querySelectorAll(".col")];
  // Position : après le label demandé, sinon juste à droite de la colonne active.
  const after =
    (afterLabel && cols.find((c) => c.dataset.deckLabel === afterLabel)) ||
    cols[deckState.index] ||
    cols[cols.length - 1];
  after ? after.after(section) : deck.appendChild(section);
  rebuildDeckNav();
  if (wire) wire(section);
  setupDeck({ animateIntro: false });
  // Centre le deck sur la nouvelle colonne. On défère d'une frame pour laisser le
  // layout (et un éventuel scroll de focus dans `wire`) se stabiliser, puis on
  // neutralise tout décalage de défilement du viewport (centrage = transform).
  const focusCol = () => {
    const vp = document.getElementById("deck-viewport");
    if (vp) { vp.scrollLeft = 0; vp.scrollTop = 0; }
    if (deckState.go) deckState.go(deckState.cols.indexOf(section));
  };
  focusCol();
  requestAnimationFrame(focusCol);
  return section;
}

// Ferme une colonne dynamique et recentre le deck sur la colonne précédente.
export function removeDeckColumn(section) {
  const deck = document.getElementById("deck");
  if (!deck || !section || !section.parentElement) return;
  const prevIndex = deckState.cols.indexOf(section);
  section.remove();
  rebuildDeckNav();
  setupDeck({ animateIntro: false });
  const n = deckState.cols.length;
  if (n && deckState.go) deckState.go(Math.max(0, Math.min(prevIndex - 1, n - 1)));
}
