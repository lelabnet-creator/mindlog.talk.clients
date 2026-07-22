// Plugin Premium Upsell — invitation à passer Premium au lancement.
//
// Pourquoi un plugin ? L'IIFE finale de app.js charge dynamiquement chaque
// plugin avec try/catch — en édition OSS, ce fichier est absent (cf.
// .oss-exclude) et l'import échoue silencieusement : aucune trace dans le
// bundle public.
//
// Cadence : on cible 1 à 3 affichages par mois → cooldown 12 jours côté
// localStorage. Le serveur reste source de vérité (eligibilité, essai non
// consommé) ; le client ne décide jamais seul d'afficher la modale.
//
// Essai : 1 mois (TRIAL_DAYS côté serveur). L'endpoint POST est idempotent et
// refusera tout 2e appel (présence d'une ligne `subscriptions` quelconque).

import { toast } from "../ui/dom.js";
import { t } from "../i18n.js";

const SHOWN_AT_KEY = "mindlog.premiumUpsellShownAt";
const COOLDOWN_MS = 12 * 24 * 60 * 60 * 1000; // ~2.5 affichages/mois

// Routes où l'on N'affiche PAS la modale : déjà sur la page d'abonnement,
// page espace d'un créateur, retour de checkout, invitation, etc.
const SKIP_PATHS = [/^\/me\/premium/, /\/space($|\/)/, /^\/i\//, /^\/status/];

export default function register(host) {
  host.registerPlugin({
    name: "premium-upsell",
    init: () => { scheduleCheck(host); },
  });
}

function scheduleCheck(host) {
  // Laisse l'app finir son boot (auth, SSE, rendu de la première vue) avant
  // d'intervenir : ~1.8 s c'est court mais on n'écrase pas une éventuelle
  // visite guidée Milo qui sortirait pile au même moment.
  const fire = () => { runCheck(host).catch(() => { /* silencieux */ }); };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => setTimeout(fire, 1800), { timeout: 4000 });
  } else {
    setTimeout(fire, 2000);
  }
}

async function runCheck(host) {
  if (!host?.isLoggedIn?.()) return;
  if (SKIP_PATHS.some((re) => re.test(location.pathname))) return;
  // Ne JAMAIS s'empiler sur une autre modale (ex. mise en coffre E2E obligatoire,
  // visite guidée) : deux `.overlay` plein écran se masquent et bloquent les clics.
  // On ne pose pas le cooldown dans ce cas → nouvelle tentative au prochain passage.
  if (document.querySelector(".overlay")) return;
  // Cooldown client : on a déjà sollicité récemment.
  const last = Number(localStorage.getItem(SHOWN_AT_KEY) || 0);
  if (last && Date.now() - last < COOLDOWN_MS) return;
  // Eligibilité côté serveur — source de vérité.
  let info;
  try {
    info = await host.api("/api/premium/upsell", { headers: host.viewerHeaders() });
  } catch {
    return; // OSS / 404 / réseau : on ne dérange jamais.
  }
  if (!info?.eligible) return;
  // Marqueur posé AVANT l'ouverture : si l'utilisateur ferme l'onglet ou
  // reload sans choisir, on respecte quand même la cadence.
  try { localStorage.setItem(SHOWN_AT_KEY, String(Date.now())); } catch {}
  openUpsellModal(host, info);
}

function openUpsellModal(host, info) {
  const trialAvailable = !!info.trialAvailable;
  const days = Number(info.trialDays) || 30;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  // Style inline minimal — réutilise les classes `.panel`, `.btn`, `.actions`
  // pour rester cohérent avec le thème.
  overlay.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="upsell-title"
         style="max-width:460px;text-align:center">
      <button type="button" class="close" id="upsell-x" aria-label="${t("com_close")}">✕</button>
      <div style="font-size:2.4rem;line-height:1;margin:.25rem 0 .6rem">✨</div>
      <h2 id="upsell-title" style="margin:0 0 .35rem">${trialAvailable
        ? t("upsl_trial_title")
        : t("upsl_upgrade_title")}</h2>
      <p class="sub" style="margin:.2rem 0 1rem">
        ${trialAvailable
          ? t("upsl_trial_sub")
          : t("upsl_upgrade_sub")}
      </p>
      <ul style="text-align:left;margin:.4rem auto 1.2rem;max-width:340px;line-height:1.7;list-style:none;padding:0">
        <li>${t("upsl_feat_lives")}</li>
        <li>${t("upsl_feat_pages")}</li>
        <li>${t("upsl_feat_chat")}</li>
        <li>${t("upsl_feat_rdv")}</li>
      </ul>
      <div class="actions" style="justify-content:center;gap:.6rem">
        <button type="button" class="btn" id="upsell-later">${t("upsl_later")}</button>
        <button type="button" class="btn primary" id="upsell-go">
          ${trialAvailable ? t("upsl_start_trial_btn").replace("{days}", days) : t("upsl_see_offer")}
        </button>
      </div>
      <p class="sub" style="font-size:.78rem;margin:.8rem 0 0;opacity:.7">
        ${trialAvailable
          ? t("upsl_trial_footnote")
          : ""}
      </p>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#upsell-x").onclick = close;
  overlay.querySelector("#upsell-later").onclick = close;

  overlay.querySelector("#upsell-go").onclick = async () => {
    if (!trialAvailable) {
      close();
      location.assign("/me/premium");
      return;
    }
    const btn = overlay.querySelector("#upsell-go");
    btn.disabled = true;
    btn.textContent = t("upsl_activating");
    try {
      await host.api("/api/premium/trial/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...host.viewerHeaders() },
      });
      close();
      toast(t("upsl_trial_started").replace("{days}", days));
      // Recharge /me/premium pour montrer l'espace fraîchement débloqué.
      location.assign("/me/premium");
    } catch (e) {
      btn.disabled = false;
      btn.textContent = t("upsl_start_trial_btn").replace("{days}", days);
      toast(e?.message || t("upsl_trial_start_fail"));
    }
  };
}
