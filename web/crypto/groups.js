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

export const gApi = {
  list: () => api("/api/groups", { headers: authHeaders() }),
  get: (gid) => api(`/api/groups/${encodeURIComponent(gid)}`, { headers: authHeaders() }),
  create: (name, members) => api("/api/groups", { method: "POST", headers: jsonAuth(), body: JSON.stringify({ name, members }) }),
  addMember: (gid, handle) => api(`/api/groups/${encodeURIComponent(gid)}/members`, { method: "POST", headers: jsonAuth(), body: JSON.stringify({ handle }) }),
  removeMember: (gid, handle) => api(`/api/groups/${encodeURIComponent(gid)}/members/${encodeURIComponent(handle)}`, { method: "DELETE", headers: authHeaders() }),
  leave: (gid) => api(`/api/groups/${encodeURIComponent(gid)}/leave`, { method: "POST", headers: jsonAuth(), body: "{}" }),
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
 * Synchronise les sender keys : (1) garantit ma sender key et l'envoie aux autres
 * membres via le canal 1-à-1 (SKDM) ; (2) collecte les SKDM reçus dans mes
 * conversations 1-à-1 avec chaque membre. À appeler à l'ouverture d'un groupe.
 */
export async function gSyncKeys(me, myKey, gid, members) {
  const st = await gLoadState(me, gid);
  const isNewSender = !st.mySender;
  if (isNewSender) {
    st.mySender = await gSenderInit();
    st.distributedTo = {}; // nouvelle clé → re-distribuer à tous
  }
  if (!st.distributedTo) st.distributedTo = {};
  const others = members.filter((h) => h !== me);
  // (1) envoyer ma SKDM aux membres QUI NE L'ONT PAS ENCORE REÇUE. Sans ce
  // filtre, chaque ouverture du groupe re-broadcaste un paquet de contrôle SKDM
  // qui pollue le chat 1:1 (cf. régression observée 11:23).
  const targets = others.filter((h) => !st.distributedTo[h]);
  if (targets.length) {
    const payload = SKD_PREFIX + JSON.stringify({ gid, dist: gSenderDist(st.mySender) });
    for (const h of targets) {
      try {
        if (md) {
          const fo = await md.fanoutEncrypt(me, myKey, h, payload).catch(() => null);
          if (fo) {
            await api(`/api/messages/${encodeURIComponent(h)}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-access-key": myKey, "x-device-id": md.deviceId() },
              body: JSON.stringify({ clientMsgId: fo.clientMsgId, envelopes: fo.envelopes }),
            });
            st.distributedTo[h] = Date.now();
            continue;
          }
        }
        const r = await ratchetSend(me, myKey, h, null, payload);
        if (!r) await e2eEncryptSend(me, myKey, h, payload);
        st.distributedTo[h] = Date.now();
      } catch {}
    }
  }
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
        }
      }
    } catch {}
  }
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
