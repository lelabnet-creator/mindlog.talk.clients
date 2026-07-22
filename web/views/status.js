// views/status.js — page d'état du service (/status). Extrait verbatim.
import { app, loadAuth } from "../core.js";
import { CREDIT, t } from "../i18n.js";
import { api } from "../net.js";
import { esc } from "../ui/dom.js";
import { miloSvg, siteHeader } from "../ui/icons.js";
import { fmtUptime, footer, headerAccount, headerSearchHtml, setupMiloEyes, wireHeaderSearch } from "../app.js";

export async function renderStatus() {
  app.innerHTML = `<p class="loading">${t("com_loading")}</p>`;
  await loadAuth(); // chip header cohérent (photo + nom) avec les autres écrans
  let s = null;
  try {
    s = await api("/api/status");
  } catch {
    /* serveur injoignable */
  }
  footer.innerHTML = `<p>${CREDIT()}</p>`;

  if (!s) {
    app.innerHTML = `
      <div class="card" style="text-align:center">
        <div class="empty-milo">${miloSvg(110)}</div>
        <h1>${t("stat_unreachable_title")}</h1>
        <p class="subtitle">${t("stat_unreachable_sub")}</p>
        <a class="btn primary" href="/">${t("cv_home")}</a>
      </div>`;
    setupMiloEyes();
    return;
  }

  const svc = (label, state) => {
    const up = state === "ok" || state === "available";
    return `<div class="status-card ${up ? "up" : "down"}">
      <span class="status-dot"></span>
      <div><div class="status-name">${label}</div><div class="status-state">${esc(state)}</div></div>
    </div>`;
  };
  const metric = (n, l) => `<div class="metric"><b>${n}</b><span>${l}</span></div>`;

  app.innerHTML = `
    ${siteHeader({
      center: headerSearchHtml(),
      right: `<a class="btn sm" href="/">${t("cv_home")}</a>
        ${headerAccount()}`,
    })}
    <section class="status">
      <div class="status-head">
        <span class="status-badge ${s.ok ? "up" : "down"}">${s.ok ? t("stat_operational") : t("stat_incident")}</span>
        <h1>${t("stat_title")}</h1>
      </div>
      <div class="status-grid">
        ${svc(t("stat_web"), s.services.web)}
        ${svc("API", s.services.api)}
        ${svc(t("stat_db"), s.services.db)}
        ${svc(t("stat_mcp"), s.services.mcp)}
      </div>
      <div class="section-title">${t("stat_numbers")}</div>
      <div class="status-metrics">
        ${metric(s.counts.identities, t("stat_identities"))}
        ${metric(s.counts.events, t("stat_events"))}
        ${metric(s.counts.requests, t("stat_requests"))}
        ${metric(s.counts.relations, t("stat_relations"))}
      </div>
      <p class="status-meta">${t("stat_meta").replace("{v}", esc(s.version)).replace("{u}", fmtUptime(s.uptimeSeconds)).replace("{date}", new Date(s.time).toLocaleString())}</p>
    </section>`;
  wireHeaderSearch();
}
