/* ======================================================================== *
 * crypto/groups.js — messagerie de groupe (sender keys, façon Signal).
 * Miroir de src/ratchet.ts : chaîne symétrique (rKdfCk/rKdfMk) + signature
 * ECDSA P-256 (anti-forge). État par groupe en IndexedDB ; la sender key (SKDM)
 * est distribuée via le canal 1-à-1 (fan-out, repli ratchet/e2e).
 * Extrait verbatim de public/app.js. cf. docs/web-crypto-modules.md.
 * ======================================================================== */
import { E2E, _b64, _b64url, _unb64, _unb64url } from "./state.js";
import { api, authHeaders, jsonAuth } from "../net.js";
import { isRatchetCiphertext, rAesDec, rAesEnc, rConcat, rEq, rIdbGet, rIdbPut, rKdfCk, rKdfMk, ratchetDecrypt, ratchetSend } from "./ratchet.js";
import { mdDecryptEnvelope, mdDeviceId, mdFanoutEncrypt, mdSelfDecrypt } from "./multidevice.js";
import { t } from "../i18n.js";
import { e2eDecrypt, e2eEncrypt } from "./e2e.js";
import { ATT_PREFIX, parseAttachment } from "./attach.js";

// Miroir de src/ratchet.ts (sender keys). Chaîne symétrique (rKdfCk/rKdfMk) +
// signature ECDSA P-256 (anti-forge). État par groupe en IndexedDB. La clé
// d'expéditeur (SKDM) est distribuée via le canal 1-à-1 (sentinelle « skd »).
// Façade locale (ex-host.md) — toutes les fonctions multi-appareils sont importées
// directement, plus besoin de passer par globalThis.__mindlog_host.
const md = {
  fanoutEncrypt: mdFanoutEncrypt,
  deviceId: mdDeviceId,
  decryptEnvelope: mdDecryptEnvelope,
  selfDecrypt: mdSelfDecrypt,
};
export const GECDSA = { name: "ECDSA", namedCurve: "P-256" };
export const SKD_PREFIX = "skd"; // message de contrôle 1-à-1 portant une sender key
// Demande de (re)distribution : envoyée quand on reçoit un message de groupe qu'on
// ne peut pas déchiffrer faute de sender key du pair. Sans ce mécanisme, un SKDM
// perdu (message 1:1 expiré au bout de 24 h, ou chaîne du ratchet déjà avancée) laisse
// la conversation bloquée à jamais sur « en attente de la clé de @x » : l'expéditeur
// a marqué `distributedTo[moi]` et ne renverra jamais spontanément sa clé.
export const SKR_PREFIX = "skr";
export const G_MAX_SKIP = 1000;

export async function gSign(privJwk, data) {
  const k = await crypto.subtle.importKey("jwk", privJwk, GECDSA, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, data));
}
export async function gVerify(pubJwk, sig, data) {
  const k = await crypto.subtle.importKey("jwk", pubJwk, GECDSA, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, data);
}
export const gIter = (n) => new TextEncoder().encode(String(n));

/** Crée mon état d'expéditeur de groupe (chaîne aléatoire + paire de signature). */
export async function gSenderInit() {
  const chain = crypto.getRandomValues(new Uint8Array(32));
  const kp = await crypto.subtle.generateKey(GECDSA, true, ["sign", "verify"]);
  const [sigPriv, sigPub] = await Promise.all([
    crypto.subtle.exportKey("jwk", kp.privateKey),
    crypto.subtle.exportKey("jwk", kp.publicKey),
  ]);
  return { chainKey: _b64(chain), iter: 0, sigPriv, sigPub };
}
export const gSenderDist = (s) => ({ chainKey: s.chainKey, iter: s.iter, sigPub: { kty: "EC", crv: "P-256", x: s.sigPub.x, y: s.sigPub.y, ext: true } });
export const gPeerFromDist = (d) => ({ chainKey: d.chainKey, iter: d.iter, sigPub: d.sigPub, skipped: [] });

/** Chiffre + signe un message de groupe ; avance ma chaîne (état muté). */
export async function gEncrypt(s, plaintext) {
  const { ck, mk } = await rKdfCk(_unb64(s.chainKey));
  const iter = s.iter;
  s.chainKey = _b64(ck);
  s.iter += 1;
  const { key, iv } = await rKdfMk(mk);
  const ct = await rAesEnc(key, iv, new TextEncoder().encode(plaintext), gIter(iter));
  const sig = await gSign(s.sigPriv, rConcat(gIter(iter), iv, ct));
  return { iter, iv: _b64(iv), ct: _b64(ct), sig: _b64(sig) };
}

/** Vérifie la signature puis déchiffre un message de groupe d'un membre. */
export async function gDecrypt(p, m) {
  const iv = _unb64(m.iv), ct = _unb64(m.ct);
  if (!(await gVerify(p.sigPub, _unb64(m.sig), rConcat(gIter(m.iter), iv, ct)))) return null;
  const idx = p.skipped.findIndex((e) => e.n === m.iter);
  if (idx >= 0) {
    const { key, iv: mkIv } = await rKdfMk(_unb64(p.skipped[idx].mk));
    if (!rEq(mkIv, iv)) return null;
    const pt = await rAesDec(key, iv, ct, gIter(m.iter)).catch(() => null);
    if (pt) p.skipped.splice(idx, 1);
    return pt ? new TextDecoder().decode(pt) : null;
  }
  if (m.iter < p.iter) return null;
  if (m.iter - p.iter > G_MAX_SKIP) return null;
  let ck = _unb64(p.chainKey);
  while (p.iter < m.iter) {
    const step = await rKdfCk(ck);
    ck = step.ck;
    p.skipped.push({ n: p.iter, mk: _b64(step.mk) });
    p.iter += 1;
  }
  const { ck: nextCk, mk } = await rKdfCk(ck);
  const { key, iv: mkIv } = await rKdfMk(mk);
  if (!rEq(mkIv, iv)) return null;
  const pt = await rAesDec(key, iv, ct, gIter(m.iter)).catch(() => null);
  if (!pt) return null;
  p.chainKey = _b64(nextCk);
  p.iter = m.iter + 1;
  return new TextDecoder().decode(pt);
}

/* ----------- État de groupe (IndexedDB) + orchestration host.groups ------- */
export const gStateKey = (me, gid) => `grp:${me}:${gid}`;
export async function gLoadState(me, gid) {
  // `distributedTo` : ensemble (en objet) des handles à qui on a déjà envoyé
  // notre SKDM courante. Évite de re-broadcaster à chaque ouverture du groupe
  // (sinon le chat 1:1 se remplit de paquets de contrôle).
  return (await rIdbGet(gStateKey(me, gid))) || { mySender: null, peers: {}, sent: {}, distributedTo: {} };
}
export const gSaveState = (me, gid, st) => rIdbPut(gStateKey(me, gid), st);

/**
 * Absorbe un paquet SKDM (« sender key » de groupe) déchiffré AILLEURS que dans
 * gSyncKeys — typiquement par la vue de conversation 1:1, qui déchiffre tous les
 * messages pour les afficher.
 *
 * Pourquoi c'est indispensable : le Double Ratchet est DESTRUCTIF. Si la vue 1:1
 * déchiffre le SKDM en premier, la chaîne avance et gSyncKeys ne peut plus le
 * relire → la sender key de l'expéditeur n'est jamais enregistrée et ses messages
 * de groupe restent bloqués sur « en attente de la clé de @x ».
 *
 * Idempotent : si on connaît déjà cette sender key (même sigPub), on NE réinitialise
 * PAS l'état (sinon on perdrait l'itérateur et les clés sautées déjà dérivés).
 * Une clé RÉGÉNÉRÉE par le pair (sigPub différent) est en revanche bien adoptée.
 * Renvoie true si l'état du groupe a été modifié.
 */
export async function gAbsorbSkd(me, senderHandle, text) {
  if (typeof text !== "string" || !me || !senderHandle) return false;
  const isSkd = text.startsWith(SKD_PREFIX);
  const isSkr = !isSkd && text.startsWith(SKR_PREFIX);
  if (!isSkd && !isSkr) return false;
  let o;
  try { o = JSON.parse(text.slice((isSkd ? SKD_PREFIX : SKR_PREFIX).length)); } catch { return false; }
  if (!o || !o.gid) return false;
  const st = await gLoadState(me, o.gid);
  if (isSkr) {
    // Demande de redistribution : on oublie le « déjà envoyé » pour ce pair ; la
    // prochaine gSyncKeys (ouverture du groupe) lui renverra notre sender key.
    if (!st.distributedTo || !(senderHandle in st.distributedTo)) return false;
    delete st.distributedTo[senderHandle];
    await gSaveState(me, o.gid, st);
    return true;
  }
  if (!o.dist) return false;
  const cur = st.peers[senderHandle];
  if (cur && cur.sigPub === o.dist.sigPub) return false; // déjà connue → ne pas rembobiner
  st.peers[senderHandle] = gPeerFromDist(o.dist);
  await gSaveState(me, o.gid, st);
  return true;
}

export const gApi = {
  list: () => api("/api/groups", { headers: authHeaders() }),
  get: (gid) => api(`/api/groups/${encodeURIComponent(gid)}`, { headers: authHeaders() }),
  create: (name, members) => api("/api/groups", { method: "POST", headers: jsonAuth(), body: JSON.stringify({ name, members }) }),
  addMember: (gid, handle) => api(`/api/groups/${encodeURIComponent(gid)}/members`, { method: "POST", headers: jsonAuth(), body: JSON.stringify({ handle }) }),
  removeMember: (gid, handle) => api(`/api/groups/${encodeURIComponent(gid)}/members/${encodeURIComponent(handle)}`, { method: "DELETE", headers: authHeaders() }),
  leave: (gid) => api(`/api/groups/${encodeURIComponent(gid)}/leave`, { method: "POST", headers: jsonAuth(), body: "{}" }),
  // Renommage (admin/owner) et suppression (owner) — parité avec l'app Android.
  rename: (gid, name) => api(`/api/groups/${encodeURIComponent(gid)}`, { method: "PATCH", headers: jsonAuth(), body: JSON.stringify({ name }) }),
  remove: (gid) => api(`/api/groups/${encodeURIComponent(gid)}`, { method: "DELETE", headers: authHeaders() }),
  messages: (gid) => api(`/api/groups/${encodeURIComponent(gid)}/messages`, { headers: authHeaders() }),
  deleteMessage: (gid, mid) => api(`/api/groups/${encodeURIComponent(gid)}/messages/${mid}`, { method: "DELETE", headers: authHeaders() }),
  burnMessage: (gid, mid) => api(`/api/groups/${encodeURIComponent(gid)}/messages/${mid}/burn`, { method: "POST", headers: jsonAuth(), body: "{}" }),
  react: (gid, mid, emoji) => api(`/api/groups/${encodeURIComponent(gid)}/messages/${mid}/react`, { method: "POST", headers: jsonAuth(), body: JSON.stringify({ emoji }) }),
};

/* ---- Pièces jointes de groupe (même pattern que crypto/attach.js 1:1) ----
 * Le blob est chiffré client-side (AES-GCM, clé aléatoire) puis uploadé. La
 * clé + métadonnée voyagent dans le message sender-key (sentinelle ATT_PREFIX),
 * donc le serveur ne voit jamais le contenu. */
const _gAttCache = new Map(); // id → objectURL (déchiffré, durée de la session)
export async function gAttachUpload(gid, file) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, await file.arrayBuffer());
  const fd = new FormData();
  fd.append("blob", new Blob([ct], { type: "application/octet-stream" }), "a.bin");
  const r = await fetch(`/api/groups/${encodeURIComponent(gid)}/attachments`, {
    method: "POST", headers: authHeaders(), body: fd,
  });
  if (!r.ok) throw new Error(t("cry_attach_send_fail"));
  const { id } = await r.json();
  return { id, name: file.name || "fichier", mime: file.type || "application/octet-stream", size: file.size, key: _b64(keyBytes), iv: _b64(iv) };
}
export async function gAttachDownload(gid, meta) {
  if (_gAttCache.has(meta.id)) return _gAttCache.get(meta.id);
  const r = await fetch(`/api/groups/${encodeURIComponent(gid)}/attachments/${meta.id}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(t("cry_attach_unavailable"));
  const ctBuf = await r.arrayBuffer();
  const aes = await crypto.subtle.importKey("raw", _unb64(meta.key), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _unb64(meta.iv) }, aes, ctBuf);
  const url = URL.createObjectURL(new Blob([plain], { type: meta.mime || "application/octet-stream" }));
  _gAttCache.set(meta.id, url);
  return url;
}

/**
 * Envoie un paquet de contrôle (SKDM ou demande de clé) à un membre via le canal
 * 1-à-1 : fan-out multi-appareils si dispo, sinon Double Ratchet, sinon E2E simple.
 * Renvoie true si l'envoi a abouti. Factorisé (utilisé par la distribution ET la
 * re-demande de clé).
 */
async function gSendControl(me, myKey, h, payload) {
  try {
    if (md) {
      const fo = await md.fanoutEncrypt(me, myKey, h, payload).catch(() => null);
      if (fo) {
        await api(`/api/messages/${encodeURIComponent(h)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-access-key": myKey, "x-device-id": md.deviceId() },
          body: JSON.stringify({ clientMsgId: fo.clientMsgId, envelopes: fo.envelopes }),
        });
        return true;
      }
    }
    const r = await ratchetSend(me, myKey, h, null, payload);
    if (!r) await e2eEncryptSend(me, myKey, h, payload);
    return true;
  } catch { return false; }
}

/**
 * Demande à chaque expéditeur dont on n'a PAS la sender key de la redistribuer.
 * Anti-spam : au plus une demande par pair et par groupe toutes les 10 minutes.
 * C'est le filet de sécurité qui débloque les conversations restées en
 * « en attente de la clé de @x ».
 */
export async function gRequestSenderKeys(me, myKey, gid, senders) {
  if (!me || !myKey || !senders?.length) return 0;
  const st = await gLoadState(me, gid);
  if (!st.requestedAt) st.requestedAt = {};
  const now = Date.now();
  const payload = SKR_PREFIX + JSON.stringify({ gid });
  let sent = 0;
  for (const h of [...new Set(senders)]) {
    if (!h || h === me || st.peers[h]) continue;            // clé déjà connue
    if (now - (st.requestedAt[h] || 0) < 10 * 60 * 1000) continue; // déjà demandé récemment
    if (await gSendControl(me, myKey, h, payload)) { st.requestedAt[h] = now; sent++; }
  }
  if (sent) await gSaveState(me, gid, st);
  return sent;
}

/* ------ Canal DÉDIÉ d'échange des sender keys (autorisé par le groupe) ----
 * Le canal 1:1 est réservé aux contacts RÉCIPROQUES : deux membres d'un même
 * groupe qui ne sont pas contacts recevaient un 403 et ne pouvaient jamais
 * échanger leurs clés (« en attente de la clé de @x », définitivement). On passe
 * donc par une boîte aux lettres de groupe, autorisée par l'APPARTENANCE.
 * Chiffrement : vers la clé publique d'identité du destinataire (info publique).
 * ------------------------------------------------------------------------ */
const _gPubCache = new Map();
async function gMemberPub(handle) {
  const h = String(handle).replace(/^@/, "");
  if (_gPubCache.has(h)) return _gPubCache.get(h);
  const d = await api(`/api/identities/${encodeURIComponent(h)}`, { headers: authHeaders() }).catch(() => null);
  const pub = d?.pubkey || null;
  if (pub) _gPubCache.set(h, pub);
  return pub;
}

/** Dépose ma sender key pour chaque membre qui ne l'a pas encore reçue. */
async function gPublishSenderKey(gid, st, others) {
  const targets = others.filter((h) => !st.publishedTo?.[h]);
  if (!targets.length) return 0;
  const payload = SKD_PREFIX + JSON.stringify({ gid, dist: gSenderDist(st.mySender) });
  const envelopes = [];
  for (const h of targets) {
    const pub = await gMemberPub(h);
    if (!pub) continue;
    try {
      const enc = await e2eEncrypt(pub, payload);
      envelopes.push({ to: h, fromPub: E2E.pubStr || "", iv: enc.iv, ciphertext: enc.ciphertext });
    } catch {}
  }
  if (!envelopes.length) return 0;
  try {
    await api(`/api/groups/${encodeURIComponent(gid)}/keys`, {
      method: "POST", headers: jsonAuth(), body: JSON.stringify({ envelopes }),
    });
    if (!st.publishedTo) st.publishedTo = {};
    for (const e of envelopes) st.publishedTo[e.to] = Date.now();
    return envelopes.length;
  } catch { return 0; }
}

/** Lit les sender keys déposées POUR MOI dans ce groupe et les enregistre. */
async function gCollectSenderKeys(gid, st) {
  const d = await api(`/api/groups/${encodeURIComponent(gid)}/keys`, { headers: authHeaders() }).catch(() => null);
  for (const e of d?.envelopes || []) {
    if (!e?.from || !e.iv || !e.ciphertext) continue;
    const pub = e.fromPub || (await gMemberPub(e.from));
    if (!pub) continue;
    const txt = await e2eDecrypt(pub, e.iv, e.ciphertext).catch(() => null);
    if (typeof txt !== "string" || !txt.startsWith(SKD_PREFIX)) continue;
    try {
      const o = JSON.parse(txt.slice(SKD_PREFIX.length));
      if (o.gid !== gid || !o.dist) continue;
      const cur = st.peers[e.from];
      if (cur && cur.sigPub === o.dist.sigPub) continue; // déjà connue → ne pas rembobiner
      st.peers[e.from] = gPeerFromDist(o.dist);
    } catch {}
  }
}

/**
 * Synchronise les sender keys : (1) garantit ma sender key et la publie dans la
 * boîte du GROUPE (+ envoi 1:1 historique, best-effort pour les anciens clients) ;
 * (2) collecte les clés déposées pour moi, puis celles présentes dans mes
 * conversations 1-à-1, et honore les demandes de redistribution (SKR).
 * À appeler à l'ouverture d'un groupe.
 */
export async function gSyncKeys(me, myKey, gid, members) {
  const st = await gLoadState(me, gid);
  const isNewSender = !st.mySender;
  if (isNewSender) {
    st.mySender = await gSenderInit();
    st.distributedTo = {}; // nouvelle clé → re-distribuer à tous
    st.publishedTo = {};
  }
  if (!st.distributedTo) st.distributedTo = {};
  if (!st.publishedTo) st.publishedTo = {};
  const others = members.filter((h) => h !== me);
  // (0) canal de groupe : publier ma clé + relever celles déposées pour moi.
  // C'est LE chemin qui fonctionne entre membres non-contacts.
  await gPublishSenderKey(gid, st, others);
  await gCollectSenderKeys(gid, st);
  // Le chemin 1:1 ci-dessous coûte N requêtes ET est rejoué à CHAQUE événement
  // temps réel (qui déclenche un refresh du groupe) → risque de saturation
  // (HTTP 429). On le limite à une passe toutes les 20 s ; le canal de groupe
  // ci-dessus, lui, reste toujours actif (il est bon marché et doit rester réactif).
  if (Date.now() - (st.lastScanAt || 0) < 20000) { await gSaveState(me, gid, st); return st; }
  st.lastScanAt = Date.now();
  // (1) envoyer ma SKDM aux membres QUI NE L'ONT PAS ENCORE REÇUE. Sans ce
  // filtre, chaque ouverture du groupe re-broadcaste un paquet de contrôle SKDM
  // qui pollue le chat 1:1 (cf. régression observée 11:23).
  const distribute = async (targets) => {
    if (!targets.length) return;
    const payload = SKD_PREFIX + JSON.stringify({ gid, dist: gSenderDist(st.mySender) });
    for (const h of targets) {
      if (await gSendControl(me, myKey, h, payload)) st.distributedTo[h] = Date.now();
    }
  };
  await distribute(others.filter((h) => !st.distributedTo[h]));
  const redistribute = new Set(); // pairs ayant demandé (SKR) notre sender key
  // (2) lire les SKDM reçus de chaque membre dans la conv 1-à-1.
  // IMPORTANT : passer x-device-id pour récupérer NOS enveloppes per-appareil
  // (sinon le serveur sert le legacy mono-session et les enveloppes fan-out
  // arrivent avec ciphertext vide, donc indéchiffrables côté SKDM).
  const deviceHeaders = { "x-access-key": myKey, ...(md && md.deviceId ? { "x-device-id": md.deviceId() } : {}) };
  for (const h of others) {
    try {
      const d = await api(`/api/messages/${encodeURIComponent(h)}`, { headers: deviceHeaders });
      for (const m of d.messages) {
        if (m.sender_id === d.me) continue;
        let txt = null;
        // Multi-appareils (fan-out) : message logique avec client_msg_id ; le
        // serveur a renvoyé NOTRE enveloppe (chiffrée pour ce device).
        if (m.client_msg_id) {
          txt = await md.decryptEnvelope(me, myKey, m.sender_device_id, m.iv, m.ciphertext).catch(() => null);
        } else if (isRatchetCiphertext(m.ciphertext)) {
          txt = await ratchetDecrypt(me, myKey, h, m.iv, m.ciphertext).catch(() => null);
        } else {
          txt = await e2eDecrypt(m.sender_pub || d.peerPubkey, m.iv, m.ciphertext).catch(() => null);
        }
        if (typeof txt === "string" && txt.startsWith(SKD_PREFIX)) {
          try {
            const o = JSON.parse(txt.slice(SKD_PREFIX.length));
            if (o.gid === gid && o.dist) st.peers[h] = gPeerFromDist(o.dist);
          } catch {}
        } else if (typeof txt === "string" && txt.startsWith(SKR_PREFIX)) {
          // Le pair n'a pas (ou plus) notre sender key → il faut la lui renvoyer.
          try {
            const o = JSON.parse(txt.slice(SKR_PREFIX.length));
            if (o.gid === gid) { delete st.distributedTo[h]; redistribute.add(h); }
          } catch {}
        }
      }
    } catch {}
  }
  // (3) honorer les demandes de redistribution reçues à l'étape (2).
  if (redistribute.size) await distribute([...redistribute]);
  await gSaveState(me, gid, st);
  return st;
}

// Envoi 1-à-1 de repli (v1) pour la SKDM si le ratchet n'est pas dispo.
export async function e2eEncryptSend(me, myKey, handle, text) {
  const enc = await e2eEncrypt(/* peerPub */ (await api(`/api/messages/${encodeURIComponent(handle)}`, { headers: { "x-access-key": myKey } })).peerPubkey, text);
  await api(`/api/messages/${encodeURIComponent(handle)}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-access-key": myKey },
    body: JSON.stringify({ ...enc, senderPub: E2E.pubStr || "", recipientPub: "" }),
  });
}

/**
 * Chiffre + envoie un message de groupe. Le payload peut être :
 *  - du texte simple
 *  - une sentinelle `att{json}` pour une pièce jointe (cf. gAttachUpload)
 *  - une sentinelle `tmr<seconds>` pour partager une minuterie de disparition
 * Options : `ttl` (secondes, borné par le serveur), `readOnce` (message à
 * lecture unique, supprimé après révélation par un membre).
 */
export async function gSendMessage(me, myKey, gid, text, opts = {}) {
  const st = await gLoadState(me, gid);
  if (!st.mySender) st.mySender = await gSenderInit();
  const m = await gEncrypt(st.mySender, text);
  st.sent[`${m.iter}`] = text; // relire mes propres messages (chaîne avancée)
  await gSaveState(me, gid, st);
  const body = { iv: m.iv, ciphertext: SKD_GROUP_PACK(m) };
  if (typeof opts.ttl === "number" && Number.isFinite(opts.ttl)) body.ttl = Math.floor(opts.ttl);
  if (opts.readOnce === true) body.readOnce = true;
  await api(`/api/groups/${encodeURIComponent(gid)}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-access-key": myKey },
    body: JSON.stringify(body),
  });
}
// Empaquette un message de groupe dans le champ ciphertext : b64url(header{iter,sig})+"."+b64(ct).
export function SKD_GROUP_PACK(m) { return _b64url(new TextEncoder().encode(JSON.stringify({ iter: m.iter, sig: m.sig }))) + "." + m.ct; }
export function SKD_GROUP_UNPACK(packed) {
  const dot = packed.indexOf("."); if (dot <= 0) return null;
  try { const h = JSON.parse(new TextDecoder().decode(_unb64url(packed.slice(0, dot)))); return { iter: h.iter, sig: h.sig, ct: packed.slice(dot + 1) }; } catch { return null; }
}

/** Charge + déchiffre les messages d'un groupe (mappe expéditeur → sa sender key).
 *  Expose les mêmes champs que le 1:1 : id, sender, mine, text, created_at,
 *  expires_at, read_once, reactions, pending. */
export async function gLoadMessages(me, myKey, gid) {
  const st = await gLoadState(me, gid);
  const d = await gApi.messages(gid);
  const out = [];
  for (const m of d.messages) {
    const mine = m.sender_id === d.me;
    const env = SKD_GROUP_UNPACK(m.ciphertext);
    let text = null;
    if (mine) {
      text = env ? (st.sent[`${env.iter}`] ?? null) : null;
    } else if (env) {
      const peer = st.peers[m.sender_handle];
      if (peer) text = await gDecrypt(peer, { iter: env.iter, iv: m.iv, ct: env.ct, sig: env.sig }).catch(() => null);
    }
    out.push({
      id: m.id,
      sender: m.sender_handle,
      mine,
      text,
      created_at: m.created_at,
      expires_at: m.expires_at,
      read_once: m.read_once === 1 || m.read_once === true,
      reactions: m.reactions || [],
      pending: !mine && text === null,
    });
  }
  await gSaveState(me, gid, st); // peers avancés persistés
  // Auto-réparation : pour chaque expéditeur dont on n'a pas la sender key, on lui
  // demande de la redistribuer (best-effort, throttlé) — sinon ses messages
  // resteraient bloqués indéfiniment sur « en attente de la clé de @x ».
  const missing = out.filter((m) => m.pending && !st.peers[m.sender]).map((m) => m.sender);
  if (missing.length) gRequestSenderKeys(me, myKey, gid, missing).catch(() => {});
  return { me: d.me, ttlHours: d.ttlHours, messages: out };
}

/** Rotation : régénère ma sender key (au retrait d'un membre) et rediffuse. */
export async function gRotate(me, myKey, gid, members) {
  const st = await gLoadState(me, gid);
  st.mySender = await gSenderInit();
  st.sent = {};
  st.distributedTo = {}; // nouvelle clé → invalider la liste de distribution
  await gSaveState(me, gid, st);
  await gSyncKeys(me, myKey, gid, members);
}
