/**
 * Client Web Push autonome (tâche B3).
 *
 * Principe : ne demande JAMAIS la permission automatiquement (mauvaise UX).
 *  - au chargement, si la permission est DÉJÀ accordée, (ré)abonne en silence ;
 *  - `window.mindlogEnablePush()` déclenche la demande de permission puis l'abonnement
 *    (à câbler sur un bouton « Activer les notifications » des réglages).
 * Le push est SANS contenu (E2E) : il ne fait que réveiller l'app.
 */
(function () {
  "use strict";
  const KEY_STORE = "mindlog.key";
  const supported = () =>
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  // Auth : cookie de session (credentials) + repli clé d'accès locale (x-access-key).
  const authHeaders = () => {
    const k = localStorage.getItem(KEY_STORE);
    return k ? { "x-access-key": k } : {};
  };

  const urlB64ToU8 = (s) => {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  /**
   * Inscription du service worker, quelle que soit la page.
   *
   * `navigator.serviceWorker.ready` ne résout QUE si la page courante est
   * contrôlée par un SW. Depuis que la portée est réduite à « /app » (la racine
   * appartient à la vitrine), une session ouverte sur `/me`, `/@handle`, `/k/*`
   * ou `/i/*` ne l'est plus : `ready` resterait en attente indéfiniment — sans
   * erreur, sans rejet — et l'abonnement push ne se ferait jamais. On interroge
   * donc l'inscription par sa PORTÉE, et on attend son activation à la main.
   */
  async function swRegistration() {
    let reg = null;
    try {
      reg = await navigator.serviceWorker.getRegistration("/app");
    } catch (_) { /* ignore */ }
    if (!reg) {
      // Premier chargement : l'inscription posée par index.html n'est pas encore
      // visible via getRegistration(). On réutilise sa promesse.
      try {
        reg = await window.__SW_REG__;
      } catch (_) { /* inscription en échec */ }
    }
    if (!reg) return null;
    if (reg.active) return reg;
    const worker = reg.installing || reg.waiting;
    if (!worker) return null;
    await new Promise((resolve) => {
      worker.addEventListener("statechange", function onChange() {
        if (worker.state === "activated" || worker.state === "redundant") {
          worker.removeEventListener("statechange", onChange);
          resolve();
        }
      });
    });
    return reg.active ? reg : null;
  }

  async function subscribe(reg) {
    const r = await fetch("/api/push/vapid-public-key", {
      credentials: "include",
      headers: authHeaders(),
    });
    if (!r.ok) return false; // push non configuré côté serveur
    const { key } = await r.json();
    if (!key) return false;
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToU8(key),
      }));
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(sub.toJSON()),
    });
    return res.ok;
  }

  async function trySilent() {
    if (!supported() || Notification.permission !== "granted") return;
    try {
      const reg = await swRegistration();
      if (reg) await subscribe(reg);
    } catch (e) {
      /* non critique */
    }
  }

  // Hook public : à appeler depuis un geste utilisateur (bouton réglages).
  window.mindlogEnablePush = async function () {
    if (!supported()) return false;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return false;
    try {
      const reg = await swRegistration();
      return reg ? await subscribe(reg) : false;
    } catch (e) {
      return false;
    }
  };

  window.addEventListener("load", trySilent);
})();
