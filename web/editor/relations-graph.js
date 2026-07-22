// editor/relations-graph.js — vue « graphe » du réseau de relations (D1/D2/D3).
//
// Rendu via D3 (force-directed) : « moi » au centre, les contacts directs (D1)
// reliés à moi, les D2/D3 reliés à leur parent grâce au champ `via`. D3 est
// vendu localement (offline/PWA) et chargé PARESSEUSEMENT au premier passage en
// vue graphe — il ne pèse pas sur le chargement initial de l'éditeur.
//
// Interactions : glisser un nœud (repositionne + réveille la simulation),
// molette = zoom, glisser le fond = pan, clic sur un nœud = ouverture de
// /@handle. La donnée vient de `data.relations = { 1:[…], 2:[…], 3:[…] }`.
import { esc } from "../ui/dom.js";
import { hueFromString } from "../ui/icons.js";
import { t } from "../i18n.js";

const REL_COLOR = { amis: "hsl(145 45% 42%)", pro: "hsl(35 80% 46%)", autre: "hsl(220 8% 52%)" };
const NODE_R = { 0: 22, 1: 16, 2: 11, 3: 8 };
const D3_SRC = "/static/vendor/d3/d3.v7.min.js";

const strip = (h) => String(h || "").replace(/^@/, "").toLowerCase();
const shortName = (s) => {
  const t = String(s || "").trim();
  return t.length > 16 ? t.slice(0, 15) + "…" : t;
};
const totalRelations = (data) => {
  const r = data.relations || {};
  return (r[1] || []).length + (r[2] || []).length + (r[3] || []).length;
};

// Charge D3 une seule fois (script global vendu en local). Renvoie window.d3.
let _d3Promise = null;
function loadD3() {
  if (window.d3) return Promise.resolve(window.d3);
  if (_d3Promise) return _d3Promise;
  _d3Promise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = D3_SRC;
    s.async = true;
    s.onload = () => (window.d3 ? resolve(window.d3) : reject(new Error("d3 indisponible")));
    s.onerror = () => reject(new Error("échec du chargement de D3"));
    document.head.appendChild(s);
  });
  return _d3Promise;
}

// Construit nœuds + liens à plat à partir des relations par degré.
function buildGraph(data) {
  const rel = data.relations || {};
  const me = { id: "__me__", handle: data.handle || "", name: t("rgraph_me"), depth: 0, me: true };
  const nodes = [me];
  const byHandle = new Map();
  const links = [];
  const add = (r, depth) => {
    const id = strip(r.handle) || "n" + nodes.length;
    let n = byHandle.get(id);
    if (!n) {
      n = { id, handle: r.handle, name: r.display_name || r.handle, type: r.type, via: r.via, depth };
      nodes.push(n);
      byHandle.set(id, n);
    }
    return n;
  };
  (rel[1] || []).forEach((r) => { const n = add(r, 1); links.push({ source: "__me__", target: n.id }); });
  (rel[2] || []).forEach((r) => { const n = add(r, 2); const p = byHandle.get(strip(r.via)); links.push({ source: p ? p.id : "__me__", target: n.id }); });
  (rel[3] || []).forEach((r) => { const n = add(r, 3); const p = byHandle.get(strip(r.via)); links.push({ source: p ? p.id : "__me__", target: n.id }); });
  return { nodes, links };
}

function nodeFill(n) {
  if (n.me) return "var(--accent-ink, #5b5fc7)";
  if (n.depth === 1) return REL_COLOR[n.type] || REL_COLOR.autre;
  return `hsl(${hueFromString(n.handle)} 30% ${n.depth === 2 ? 46 : 38}%)`;
}

// Coquille HTML (SVG vide rempli par D3 + légende + bouton recentrer). L'état
// vide est géré ici pour éviter de charger D3 inutilement.
export function relationsGraphHtml(data) {
  if (!totalRelations(data)) {
    return `<div class="rg-empty">${t("rgraph_empty")}</div>`;
  }
  const rel = data.relations || {};
  const has2 = (rel[2] || []).length > 0;
  const has3 = (rel[3] || []).length > 0;
  // Légende = filtres de type (cliquables). Chips de degré affichés seulement si des
  // degrés étendus existent. Contrôles de zoom (+/−/recentrer) en superposition.
  return `<div class="rel-graph-wrap">
    <svg class="rel-graph-svg" role="img" aria-label="${t("rgraph_svg_aria")}"></svg>

    <div class="rg-zoomctl" role="group" aria-label="${t("rgraph_zoom_aria")}">
      <button type="button" class="rg-zoom" data-z="in" title="${t("rgraph_zoom_in")}" aria-label="${t("rgraph_zoom_in")}">＋</button>
      <button type="button" class="rg-zoom" data-z="out" title="${t("rgraph_zoom_out")}" aria-label="${t("rgraph_zoom_out")}">－</button>
      <button type="button" class="rg-reset" title="${t("rgraph_recenter")}" aria-label="${t("rgraph_recenter_aria")}">⟲</button>
    </div>

    <div class="rg-filters" role="group" aria-label="${t("rgraph_filter_aria")}">
      <button type="button" class="rg-fchip active" data-ftype="amis" aria-pressed="true"><i style="background:${REL_COLOR.amis}"></i>${t("rgraph_friend")}</button>
      <button type="button" class="rg-fchip active" data-ftype="pro" aria-pressed="true"><i style="background:${REL_COLOR.pro}"></i>${t("rgraph_pro")}</button>
      <button type="button" class="rg-fchip active" data-ftype="autre" aria-pressed="true"><i style="background:${REL_COLOR.autre}"></i>${t("rgraph_other")}</button>
      ${has2 || has3 ? `<span class="rg-fsep" aria-hidden="true"></span>
      <button type="button" class="rg-fchip active" data-fdeg="1" aria-pressed="true">D1</button>
      ${has2 ? `<button type="button" class="rg-fchip active" data-fdeg="2" aria-pressed="true">D2</button>` : ""}
      ${has3 ? `<button type="button" class="rg-fchip active" data-fdeg="3" aria-pressed="true">D3</button>` : ""}` : ""}
    </div>

    <div class="rg-loading">${t("rgraph_loading")}</div>
  </div>`;
}

// Câble la vue graphe : charge D3 puis monte la simulation. Idempotent (ne monte
// qu'une fois par coquille). `data` = même objet que la liste.
export async function wireRelationsGraph(scope, data) {
  const wrap = scope.querySelector(".rel-graph-wrap");
  if (!wrap || wrap.dataset.ready) return;
  const { nodes, links } = buildGraph(data);
  if (nodes.length <= 1) return; // état vide déjà rendu

  let d3;
  try {
    d3 = await loadD3();
  } catch {
    wrap.innerHTML = `<div class="rg-empty">Vue graphe indisponible (D3 n'a pas pu être chargé).</div>`;
    return;
  }
  wrap.dataset.ready = "1";
  wrap.querySelector(".rg-loading")?.remove();

  const svg = wrap.querySelector(".rel-graph-svg");
  const width = wrap.clientWidth || 360;
  const height = wrap.clientHeight || 440;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const svgSel = d3.select(svg);
  const g = svgSel.append("g").attr("class", "rg-viewport");

  const link = g.append("g").attr("class", "rg-edges")
    .selectAll("line").data(links).join("line")
    .attr("class", "rg-edge").attr("vector-effect", "non-scaling-stroke");

  const node = g.append("g").attr("class", "rg-nodes")
    .selectAll("g.rg-node").data(nodes).join("g")
    .attr("class", (d) => "rg-node" + (d.me ? " rg-me" : ""));

  node.append("title").text((d) =>
    d.name + (d.me ? "" : " · @" + d.handle) + (d.via ? " · via @" + d.via : ""));

  node.append("circle").attr("class", "rg-node-c")
    .attr("r", (d) => NODE_R[d.depth] || 8)
    .attr("fill", nodeFill)
    .attr("vector-effect", "non-scaling-stroke");

  node.append("text").attr("class", "rg-init")
    .attr("text-anchor", "middle").attr("dy", ".34em")
    .attr("font-size", (d) => Math.round((NODE_R[d.depth] || 8) * 0.95))
    .text((d) => esc((d.name[0] || d.handle[0] || "·").toUpperCase()));

  // Étiquette nom sous les nœuds proches (moi + D1) ; les autres via le <title>.
  node.filter((d) => d.depth <= 1).append("text").attr("class", "rg-label")
    .attr("text-anchor", "middle")
    .attr("dy", (d) => (NODE_R[d.depth] || 8) + 16)
    .text((d) => (d.me ? "Moi" : shortName(d.name)));

  // Clic = ouverture du profil (sauf si on vient de glisser le nœud).
  node.filter((d) => !d.me).style("cursor", "pointer").on("click", (e, d) => {
    if (d.__moved) { d.__moved = false; return; }
    window.open("/@" + encodeURIComponent(d.handle), "_blank", "noopener");
  });

  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(72).strength(0.55))
    .force("charge", d3.forceManyBody().strength(-260))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius((d) => (NODE_R[d.depth] || 8) + 9));

  sim.on("tick", () => {
    link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  const drag = d3.drag()
    .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; d.__moved = false; })
    .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; d.__moved = true; })
    .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });
  node.call(drag);

  const zoom = d3.zoom().scaleExtent([0.3, 4]).on("zoom", (e) => g.attr("transform", e.transform));
  svgSel.call(zoom).on("dblclick.zoom", null);

  wrap.querySelector(".rg-reset")?.addEventListener("click", () =>
    svgSel.transition().duration(300).call(zoom.transform, d3.zoomIdentity));

  // Boutons zoom +/− (en plus de la molette).
  wrap.querySelectorAll(".rg-zoom").forEach((b) =>
    b.addEventListener("click", () =>
      svgSel.transition().duration(200).call(zoom.scaleBy, b.dataset.z === "in" ? 1.4 : 1 / 1.4)));

  // Filtres : type (s'applique au degré 1) + degré. Un nœud est visible si son degré
  // est actif ET (degré ≠ 1 OU son type est actif). « Moi » toujours visible. Un lien
  // n'est visible que si ses deux extrémités le sont.
  const activeType = new Set(["amis", "pro", "autre"]);
  const activeDeg = new Set([1, 2, 3]);
  const isVisible = (d) =>
    d.me || (activeDeg.has(d.depth) && (d.depth !== 1 || activeType.has(d.type || "autre")));
  const applyFilters = () => {
    node.style("display", (d) => (isVisible(d) ? null : "none"));
    link.style("display", (d) => (isVisible(d.source) && isVisible(d.target) ? null : "none"));
  };
  wrap.querySelectorAll(".rg-fchip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const on = !chip.classList.contains("active");
      chip.classList.toggle("active", on);
      chip.setAttribute("aria-pressed", String(on));
      if (chip.dataset.ftype) { if (on) activeType.add(chip.dataset.ftype); else activeType.delete(chip.dataset.ftype); }
      else if (chip.dataset.fdeg) { const n = Number(chip.dataset.fdeg); if (on) activeDeg.add(n); else activeDeg.delete(n); }
      applyFilters();
    }));
}
