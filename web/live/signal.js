// Couche signalisation : SSE descendant + POST montant.
// Le serveur route les paquets `{from, to, kind, payload}` vers le device cible.
//
// Robustesse : EventSource a un auto-reconnect natif mais (1) il n'a pas de
// backoff, (2) il continue à boucler même sur un 4xx terminal, (3) il ne
// notifie pas qu'il a re-réussi après un échec. On wrappe la connexion pour
// fournir un reconnect explicite à backoff exponentiel, détecter les erreurs
// terminales (401/403/404) et notifier le viewer quand le canal redevient
// `ready` après une coupure.

const SIGNAL_RETRY_BASE = 800;     // 1ère reconnexion ~0,8 s
const SIGNAL_RETRY_MAX = 30_000;   // cap 30 s
const SIGNAL_RETRY_GIVEUP = 8;     // 8 tentatives avant d'abandonner (≈ 2 min)

export function openSignalChannel(streamId, deviceId, onPacket, onReady, onError) {
  let es = null;
  let closed = false;
  let retryTimer = null;
  let retryAttempts = 0;
  let lastReadyAt = 0;

  const url = `/api/live/${encodeURIComponent(streamId)}/signal?device_id=${encodeURIComponent(deviceId)}`;

  const scheduleReconnect = (reason) => {
    if (closed) return;
    if (retryTimer) return;
    if (retryAttempts >= SIGNAL_RETRY_GIVEUP) {
      onError?.({ terminal: true, reason: reason || "give-up" });
      return;
    }
    const delay = Math.min(SIGNAL_RETRY_BASE * Math.pow(2, retryAttempts), SIGNAL_RETRY_MAX);
    retryAttempts += 1;
    onError?.({ terminal: false, reason: reason || "transient", nextRetryMs: delay, attempt: retryAttempts });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed) return;
    try { es?.close(); } catch { /* ignore */ }
    es = new EventSource(url, { withCredentials: true });
    es.addEventListener("ready", (ev) => {
      // Connexion rétablie — reset le compteur de tentatives.
      retryAttempts = 0;
      lastReadyAt = Date.now();
      try { onReady?.(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    es.addEventListener("signal", (ev) => {
      try { onPacket?.(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    es.addEventListener("ping", () => { /* keep-alive serveur */ });
    es.onerror = () => {
      // EventSource passe à readyState=2 (CLOSED) ou 0 (CONNECTING). En 2
      // c'est un échec terminal côté navigateur — on reprend la main pour
      // décider du retry. On ne fait pas confiance à l'auto-reconnect du
      // navigateur (pas de backoff, boucle sur 4xx).
      const wasReady = lastReadyAt > 0;
      try { es?.close(); } catch { /* ignore */ }
      es = null;
      scheduleReconnect(wasReady ? "drop" : "open-failed");
    };
  };

  connect();

  return {
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { es?.close(); } catch { /* ignore */ }
    },
    // Force une reconnexion immédiate (utilisé par le viewer sur `online` ou
    // `visibilitychange`). Reset les tentatives — on assume que la situation
    // réseau a changé.
    revive() {
      if (closed) return;
      retryAttempts = 0;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      connect();
    },
  };
}

export async function sendSignal(streamId, from, to, kind, payload) {
  const r = await fetch(`/api/live/${encodeURIComponent(streamId)}/signal`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to, kind, payload }),
  });
  if (!r.ok) throw new Error(`signal ${kind} failed: ${r.status}`);
  return r.json();
}

export async function sendHeartbeat(streamId, deviceId, score) {
  try {
    await fetch(`/api/live/${encodeURIComponent(streamId)}/heartbeat`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, score }),
    });
  } catch { /* best-effort */ }
}

export async function leave(streamId, deviceId) {
  try {
    await fetch(`/api/live/${encodeURIComponent(streamId)}/leave`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: deviceId }),
    });
  } catch { /* best-effort */ }
}

export async function fetchRoster(streamId) {
  const r = await fetch(`/api/live/${encodeURIComponent(streamId)}/roster`, { credentials: "include" });
  if (!r.ok) {
    const e = new Error(`roster ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return (await r.json()).roster || [];
}

export async function joinStream(streamId, deviceId, score = 50) {
  const r = await fetch(`/api/live/${encodeURIComponent(streamId)}/join`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, score }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const err = new Error(j.error || `join ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}
