// editor/tabs/relations.js — colonne « Réseau ».
// Builder de rendu pur (câblage dans wireEditor). Extrait verbatim.
// cf. docs/web-app-split-proposal.md
import { relItemHtml, relationsListHtml, avatarHtml } from "../../app.js";
import { icon } from "../../ui/icons.js";
import { relationsGraphHtml } from "../relations-graph.js";
import { t } from "../../i18n.js";

const relLabel = (type) =>
  ({ amis: t("reln_type_ami"), pro: t("reln_type_pro"), autre: t("reln_type_autre") })[type];

// Inject data-degree + data-type into a single relItemHtml output.
function withDeg(r, deg, opts) {
  return relItemHtml(r, opts).replace(
    /^<li class="rel"/,
    `<li class="rel" data-degree="${deg}" data-type="${r.type || "autre"}"`
  );
}

// Inject data-degree into a relationsListHtml block (multiple <li>).
function withDegBulk(html, deg) {
  return html.replace(/<li class="rel"/g, `<li class="rel" data-degree="${deg}"`);
}

// Vue « Contacts » — carnet d'adresses des relations DIRECTES (degré 1), trié par
// nom, avec actions rapides (Discuter / Voir la carte). Sur Android, ce carnet est
// fusionné avec les contacts du téléphone (sync native — étape suivante).
function contactsBookHtml(deg1) {
  if (!deg1.length)
    return `<div class="contacts-empty"><p class="empty" style="text-align:center;padding:1rem 0">${t("reln_no_direct_contact")}</p></div>`;
  const sorted = [...deg1].sort((a, b) =>
    (a.display_name || a.handle).localeCompare(b.display_name || b.handle, "fr", { sensitivity: "base" })
  );
  return `<div class="contacts-book">
    ${sorted
      .map(
        (r) => `<div class="contact-card" data-handle="${r.handle}">
        <a class="contact-av-link" href="/@${encodeURIComponent(r.handle)}" target="_blank" rel="noopener noreferrer">${avatarHtml(r.handle, r.has_photo, "av")}</a>
        <div class="contact-info">
          <div class="contact-name">${r.display_name ? r.display_name : "@" + r.handle}${r.mutual ? ` <span class="rel-mutual" title="${t("reln_mutual_contact")}">⇄</span>` : ""}</div>
          <div class="contact-handle">@${r.handle}${r.type ? ` <span class="rel-type ${r.type}">${relLabel(r.type) || r.type}</span>` : ""}</div>
        </div>
        <div class="contact-actions">
          <button type="button" class="btn sm" data-cbook-chat="${r.handle}" title="${t("reln_chat")}" aria-label="${t("reln_chat_with").replace("{handle}", r.handle)}">${icon("chat", 15)}</button>
          <a class="btn sm" href="/@${encodeURIComponent(r.handle)}" target="_blank" rel="noopener noreferrer" title="${t("reln_view_card")}" aria-label="${t("reln_view_card_of").replace("{handle}", r.handle)}">${icon("link", 15)}</a>
        </div>
      </div>`
      )
      .join("")}
    <p class="contacts-sync-hint lbl-sm" style="margin:.8rem 0 .2rem;text-align:center;opacity:.75">${icon("users", 12)} ${t("reln_android_sync")}</p>
  </div>`;
}

export function renderRelationsColumn(data, { incomingListHtml }) {
  const rel = data.relations || { 1: [], 2: [], 3: [] };
  const _deg1 = rel[1] || [];
  const _friends = _deg1.filter((r) => r.type === "amis");
  const _others = _deg1.filter((r) => r.type !== "amis");
  const _incoming = data.incoming || [];
  const _deg2 = rel[2] || [];
  const _deg3 = rel[3] || [];
  const totalCount = _deg1.length + _deg2.length + _deg3.length;

  const d1html = [
    ..._friends.map((r) => withDeg(r, "1", { editable: true })),
    ..._others.map((r) => withDeg(r, "1", { editable: true })),
  ].join("");

  const d2html = _deg2.length
    ? `<li class="rel-deg-sep" data-degree="2">${t("reln_degree2")}</li>` +
      withDegBulk(relationsListHtml(_deg2, false), "2")
    : "";

  const d3html = _deg3.length
    ? `<li class="rel-deg-sep" data-degree="3">${t("reln_degree3")}</li>` +
      withDegBulk(relationsListHtml(_deg3, false), "3")
    : "";

  // Subrail vertical (même pattern que les Échanges / l'Agenda) : Liste · Graphe ·
  // Contacts. Les class .rel-tab + #rel-list-pane/#rel-graph-pane restent stables
  // pour le câblage (filtres, recherche, ajout, graphe D3) qui vit dans wireEditor.
  return `<div class="card subrail-card">
    <nav class="subrail" role="tablist" aria-label="${t("reln_subsections")}" id="rel-tabs">
      <button type="button" class="subrail-btn rel-tab active" data-tab="contacts" role="tab" aria-selected="true" title="${t("reln_contacts")}" aria-label="${t("reln_contacts")}">
        ${icon("users", 22)}<span class="subrail-label">${t("reln_contacts")}</span>
        ${_deg1.length ? `<span class="subrail-badge subrail-badge-soft">${_deg1.length}</span>` : ""}
      </button>
      <button type="button" class="subrail-btn rel-tab" data-tab="add" role="tab" aria-selected="false" title="${t("reln_add_contact")}" aria-label="${t("reln_add_contact")}">
        ${icon("plus", 22)}<span class="subrail-label">${t("reln_add")}</span>
      </button>
      <button type="button" class="subrail-btn rel-tab" data-tab="list" role="tab" aria-selected="false" title="${t("reln_list")}" aria-label="${t("reln_list")}">
        ${icon("list", 22)}<span class="subrail-label">${t("reln_list")}</span>
        ${_incoming.length ? `<span class="subrail-badge">${_incoming.length}</span>` : ""}
      </button>
      <button type="button" class="subrail-btn rel-tab" data-tab="graph" role="tab" aria-selected="false" title="${t("reln_graph")}" aria-label="${t("reln_graph")}">
        ${icon("share2", 22)}<span class="subrail-label">${t("reln_graph")}</span>
      </button>
    </nav>
    <div class="col-scroll subrail-body">

    <div class="rel-panel" id="rel-list-pane" role="tabpanel" hidden style="padding:10px">
    <input id="rel-search" class="rel-search-input" placeholder="${t("reln_search")}" autocomplete="off" />

    <div class="rel-chips-row" id="rel-degree-chips" role="group" aria-label="${t("reln_filter_degree")}">
      <button class="rel-chip active" data-degree="">${t("reln_all")}</button>
      <button class="rel-chip" data-degree="1">D1${_deg1.length ? ` <span class="chip-n">${_deg1.length}</span>` : ""}</button>
      ${_deg2.length ? `<button class="rel-chip" data-degree="2">D2 <span class="chip-n">${_deg2.length}</span></button>` : ""}
      ${_deg3.length ? `<button class="rel-chip" data-degree="3">D3 <span class="chip-n">${_deg3.length}</span></button>` : ""}
    </div>
    <div class="rel-chips-row" id="rel-type-chips" role="group" aria-label="${t("reln_filter_type")}">
      <button class="rel-chip active" data-reltype="">${t("reln_all")}</button>
      <button class="rel-chip" data-reltype="amis">${t("reln_chip_amis")}</button>
      <button class="rel-chip" data-reltype="pro">${t("reln_type_pro")}</button>
      <button class="rel-chip" data-reltype="autre">${t("reln_type_autre")}</button>
    </div>

    ${
      _incoming.length
        ? `<button class="rel-pending-banner" id="rel-pending-toggle" aria-expanded="false">
        ${icon("bell", 14)} ${(_incoming.length > 1 ? t("reln_pending_many") : t("reln_pending_one")).replace("{n}", _incoming.length)}
        <span class="rel-pending-chevron">›</span>
      </button>
      <div class="rel-pending-panel" id="rel-pending-panel" hidden>
        <ul class="rels">${incomingListHtml(_incoming)}</ul>
      </div>`
        : ""
    }

    <ul class="rels" id="rel-all-list">
      ${totalCount === 0 ? `<li class="rel-empty">${t("reln_no_relations")}</li>` : d1html + d2html + d3html}
      <li class="rel-no-results" id="rel-no-results" hidden>${t("reln_no_results")}</li>
    </ul>
    </div>

    <div class="rel-panel" id="rel-graph-pane" role="tabpanel" hidden style="padding:10px">
      ${relationsGraphHtml(data)}
    </div>

    <div class="rel-panel" id="rel-contacts-pane" role="tabpanel" style="padding:10px">
      ${contactsBookHtml(_deg1)}
    </div>

    <div class="rel-panel" id="rel-add-pane" role="tabpanel" hidden style="padding:10px">
      <p class="lbl-sm" style="margin:0 0 .6rem;line-height:1.45">${t("reln_add_hint")}</p>
      <input id="rel-add-q" class="rel-search-input" placeholder="${t("reln_search_person")}" autocomplete="off" inputmode="search" />
      <div class="rel-add-results" id="rel-add-results">
        <p class="empty" style="text-align:center;padding:1rem 0;opacity:.7">${t("reln_type_to_search")}</p>
      </div>
    </div>

    </div>
  </div>`;
}
