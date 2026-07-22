// editor/tabs/agenda.js — colonne « Agenda » (disponibilités / événements / RDV).
// Builder de rendu pur (câblage dans wireEditor). Extrait verbatim.
// cf. docs/web-app-split-proposal.md
import { eventsHtml } from "../../app.js";
import { host } from "../../host.js";
import { icon } from "../../ui/icons.js";
import { esc } from "../../ui/dom.js";
import { t } from "../../i18n.js";

// Invitations reçues EN ATTENTE (RSVP) — bloc « Accepter / Refuser » en tête du
// panneau Événements. data.myInvites : [{ event, organizer_handle, organizer_name }].
function invitesReceivedHtml(invites) {
  if (!invites || !invites.length) return "";
  const fmt = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) +
      " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  };
  return `<div class="invites-recv">
    <div class="ev-toolbar-title" style="margin-bottom:.5rem">${icon("users", 15)} ${t("agnd_invites_received")}</div>
    ${invites.map((iv) => `
      <div class="invite-card" data-invite-event="${iv.event.id}">
        <div class="invite-main">
          <div class="invite-title">${esc(iv.event.title || "")}</div>
          <div class="invite-sub">${icon("clock", 12)} ${esc(fmt(iv.event.starts_at))} · ${esc(iv.organizer_name || ("@" + iv.organizer_handle))}</div>
        </div>
        <div class="invite-actions">
          <button type="button" class="btn sm primary" data-invite-accept="${iv.event.id}">${t("agnd_accept")}</button>
          <button type="button" class="btn sm" data-invite-decline="${iv.event.id}">${t("agnd_decline")}</button>
        </div>
      </div>`).join("")}
  </div>`;
}

export function renderAgendaColumn(data, { reqFilterChips, requestsHtml, dayLoad }) {
  // Layout rail : rail vertical (sous-modes) + scroll de panel à droite, même
  // pattern que les Échanges. Les class .agenda-tab restent inchangées pour que
  // le wiring (app.querySelectorAll('.agenda-tab')…) marche tel quel.
  return `<div class="card subrail-card">
      <nav class="subrail" role="tablist" aria-label="${t("agnd_subsections")}" id="agenda-tabs">
        <button class="subrail-btn agenda-tab active" data-tab="dispo" role="tab" aria-selected="true" title="${t("agnd_availability")}" aria-label="${t("agnd_availability")}">
          ${icon("calendar", 22)}<span class="subrail-label">${t("agnd_tab_agenda")}</span>
        </button>
        <button class="subrail-btn agenda-tab" data-tab="events" role="tab" aria-selected="false" title="${t("agnd_events")}" aria-label="${t("agnd_events")}">
          ${icon("clock", 22)}<span class="subrail-label">${t("agnd_events")}</span>
        </button>
        <button class="subrail-btn agenda-tab" data-tab="rdv" role="tab" aria-selected="false" title="${t("agnd_appointments")}" aria-label="${t("agnd_appointments")}">
          ${icon("users", 22)}<span class="subrail-label">${t("agnd_rdv")}</span>
          ${data.pending ? `<span class="subrail-badge">${data.pending}</span>` : ""}
        </button>
      </nav>
      <div class="col-scroll subrail-body">
        <div class="agenda-panel" id="agenda-dispo" role="tabpanel" style="padding:10px">
          <div class="calendar-fill">
            ${host.calendar.html(data.overrides, true, dayLoad, true, [...(data.events || []), ...(data.invitedEvents || [])])}
          </div>
        </div>
        <div class="agenda-panel" id="agenda-events" role="tabpanel" hidden style="padding:10px">
          ${invitesReceivedHtml(data.myInvites || [])}
          <div class="ev-toolbar">
            <span class="ev-toolbar-title">${icon("calendar", 15)} ${t("agnd_my_events")}</span>
            <button type="button" class="comm-topbar-btn" data-event-new title="${t("agnd_new_event")}" aria-label="${t("agnd_new_event")}">${icon("plus", 16)}</button>
          </div>
          <div class="agenda-events">${eventsHtml([...(data.events || []), ...(data.invitedEvents || [])], true)}</div>
        </div>
        <div class="agenda-panel" id="agenda-rdv" role="tabpanel" hidden style="padding:10px">
          <div class="ev-toolbar">
            <span class="ev-toolbar-title">${icon("users", 15)} ${t("agnd_my_appointments")}</span>
          </div>
          <div class="req-filters" role="tablist" aria-label="${t("agnd_filter_requests")}">
            ${reqFilterChips(data.requests || [])}
          </div>
          <ul class="requests">${requestsHtml(data.requests || [])}</ul>
        </div>
      </div>
    </div>`;
}
