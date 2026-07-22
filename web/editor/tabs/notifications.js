// editor/tabs/notifications.js — colonne « Notifications ».
// Builder de rendu pur (câblage dans wireEditor). Extrait verbatim.
// cf. docs/web-app-split-proposal.md

import { t } from "../../i18n.js";

export function renderNotificationsColumn(data, { notifListHtml }) {
  return `<div class="card">
      <div class="section-title" style="border-top:none;padding-top:0;margin-top:0">${t("notf_title")}</div>
      <div class="rel-filters" style="justify-content:space-between">
        <span class="deg" id="notif-count">${t("notf_unread_count").replace("{n}", data.unread || 0)}</span>
        <button class="btn sm" id="notif-readall">${t("notf_mark_all_read")}</button>
      </div>
      <div class="col-scroll">
        <ul class="notif-list notif-col" id="notif-list">${notifListHtml(data.notifications || [])}</ul>
      </div>
    </div>`;
}
