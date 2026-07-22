/* ======================================================================== *
 * crypto/multidevice.js — fan-out multi-appareils (P2) façon Signal.
 * Une session Double Ratchet par appareil pair (FS) ; clé symétrique self pour
 * la sync entre MES appareils. Dépendance circulaire assumée avec ratchet.
 * Extrait verbatim de public/app.js. cf. docs/web-crypto-modules.md.
 * ======================================================================== */
import { E2E, _b64, _b64url, _unb64, _unb64url } from "./state.js";
import { api } from "../net.js";
import { R_OPK_TARGET, rEncrypt, rGenKeyPair, rHkdf, rIdbDel, rIdbGet, rIdbPut, rIkFp, rInitSender, rLoadState, rMyIdentity, rPack, rPrekeyKey, rSaveState, rStateKey, rX3dhInitiator, ratchetDecrypt, ratchetEnsurePrekeys } from "./ratchet.js";

/* ---- Multi-appareils : identité d'appareil + prekeys par appareil (P2) -----
 * La clé E2E de CE navigateur (E2E.privJwk/pubStr, déjà locale) EST sa clé
 * d'appareil. On l'enregistre côté serveur (table `devices`) au lieu d'écraser
 * `identities.pubkey`, et on publie les MÊMES prekeys (réutilise le store local
 * rPrekeyKey) sous l'en-tête `x-device-id`. cf. docs/multidevice-proposal.md. */
export function mdDeviceId() {
  let id = null;
  try { id = localStorage.getItem("mindlog.deviceId"); } catch {}
  if (!id) {
    id = "dev-" + _b64url(crypto.getRandomValues(new Uint8Array(16))); // 26 car. [A-Za-z0-9_-]
    try { localStorage.setItem("mindlog.deviceId", id); } catch {}
  }
  return id;
}

// Enregistre/rafraîchit cet appareil + publie ses prekeys. Renvoie {deviceId, approved, pending}.
export async function mdRegisterDevice(handle, accessKey) {
  if (!E2E.pubStr) return null;
  const deviceId = mdDeviceId();
  const hdr = { "Content-Type": "application/json", "x-access-key": accessKey };
  let res = null;
  try {
    res = await api("/api/devices", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ deviceId, e2ePubkey: E2E.pubStr, name: (navigator.userAgent || "").slice(0, 60) }),
    });
  } catch { return null; }
  await mdPublishDevicePrekeys(handle, accessKey, deviceId).catch(() => {});
  return { deviceId, approved: !!res?.approved, pending: !!res?.pending };
}

// Publie le bundle de prekeys de CET appareil (réutilise le store local rPrekeyKey,
// rempli par ratchetEnsurePrekeys ; complète le pool au besoin).
export async function mdPublishDevicePrekeys(handle, accessKey, deviceId) {
  let store = await rIdbGet(rPrekeyKey(handle));
  if (!store) {
    const spk = await rGenKeyPair();
    store = { spkId: 1, spk, opks: {}, nextOpkId: 1 };
  }
  let count = Object.keys(store.opks).length;
  for (; count < R_OPK_TARGET; count++) {
    const id = store.nextOpkId++;
    store.opks[id] = await rGenKeyPair();
  }
  await rIdbPut(rPrekeyKey(handle), store);
  const opks = Object.entries(store.opks).map(([id, kp]) => ({ opkId: Number(id), opkPub: JSON.stringify(kp.pub) }));
  try {
    await fetch("/api/e2e/device-prekeys", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-access-key": accessKey, "x-device-id": deviceId },
      body: JSON.stringify({ spkPub: JSON.stringify(store.spk.pub), spkId: store.spkId, opks }),
    });
  } catch {}
}

/* ---- Fan-out multi-appareils (P2) -----------------------------------------
 * Une session Double Ratchet PAR appareil pair, keyée localement par le DEVICE-ID
 * de l'appareil DISTANT (stable et présent des deux côtés : `bundle.deviceId` à
 * l'envoi, `sender_device_id` renvoyé par le serveur à la réception). On ne peut
 * PAS keyer par header.ik : seul le 1ᵉʳ message (initiation X3DH) le contient ; une
 * réponse sur session établie n'a pas de bootstrap → la session serait introuvable. */
export const mdSessionKey = (peerDeviceId) => "dev:" + peerDeviceId;

// Chiffre `text` pour UN appareil distant (bundle = {deviceId, ik, spkPub, spkId, opkPub, opkId}).
export async function mdEncryptToDevice(me, bundle, text) {
  const peerIk = JSON.parse(bundle.ik);
  const sk = mdSessionKey(bundle.deviceId);
  let state = await rLoadState(me, sk);
  if (state && state.peerIk && rIkFp(peerIk) !== state.peerIk) {
    await rIdbDel(rStateKey(me, sk)).catch(() => {});
    state = null;
  }
  let bootstrap = null;
  if (!state) {
    const ekA = await rGenKeyPair();
    const parsed = {
      ik: peerIk,
      spkPub: JSON.parse(bundle.spkPub),
      spkId: bundle.spkId,
      opkPub: bundle.opkPub ? JSON.parse(bundle.opkPub) : null,
      opkId: bundle.opkId,
    };
    const { sk: secret, ad } = await rX3dhInitiator(rMyIdentity(), ekA, parsed);
    state = await rInitSender(secret, ad, parsed.spkPub);
    state.peerIk = rIkFp(peerIk);
    state.bootstrap = { ek: ekA.pub, ik: rMyIdentity().pub, opk: parsed.opkId, spk: parsed.spkId };
  }
  if (!state.confirmed && state.bootstrap) bootstrap = state.bootstrap;
  const r = await rEncrypt(state, text, bootstrap);
  await rSaveState(me, sk, state);
  return { iv: r.iv, ciphertext: rPack(r.headerB64u, r.ct) };
}

export const mdSentKey = (me, cmid) => `mdsent:${me}:${cmid}`;

/* -------- Sync entre MES appareils : clé symétrique partagée (PAS de ratchet) --------
 * Le ratchet par-appareil entre deux appareils du MÊME compte diverge fatalement (double
 * initiation systématique en fan-out → deux racines X3DH). Comme tous mes appareils
 * partagent DÉJÀ la clé d'identité (coffre), on chiffre « mon message → mes autres
 * appareils » avec une clé AES dérivée du scalaire d'identité (HKDF, domaine séparé du
 * cache). N'importe lequel de mes appareils la redérive et déchiffre — zéro état mutable,
 * zéro divergence. Interop Android (même dérivation HKDF(d, "mindlog-self-sync-v1")). */
export const R_SELF_SALT = new TextEncoder().encode("mindlog-self-sync-v1");
export const R_SELF_INFO = new TextEncoder().encode("self-sync");
export async function mdSelfAesKey() {
  const id = rMyIdentity();
  if (!id || !id.priv || !id.priv.d) return null;
  const raw = await rHkdf(_unb64url(id.priv.d), R_SELF_SALT, R_SELF_INFO, 32);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function mdSelfEncrypt(text) {
  const key = await mdSelfAesKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  return { iv: _b64(iv), ciphertext: "self:" + _b64(ct) }; // préfixe = marqueur self (vs pack ratchet)
}
export async function mdSelfDecrypt(iv, ciphertext) {
  const key = await mdSelfAesKey();
  if (!key || typeof ciphertext !== "string") return null;
  const ctB64 = ciphertext.startsWith("self:") ? ciphertext.slice(5) : ciphertext;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _unb64(iv) }, key, _unb64(ctB64));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

/**
 * Construit un envoi FAN-OUT : ratchet par-appareil pour les appareils du PAIR (identité
 * différente → forward secrecy) ; clé self partagée pour MES AUTRES appareils (sync, pas
 * de ratchet). Renvoie { clientMsgId, envelopes }, ou null si aucun appareil cible.
 */
export async function mdFanoutEncrypt(myHandle, accessKey, peerHandle, text) {
  const hdr = { "x-access-key": accessKey, "x-device-id": mdDeviceId() };
  let peerDevs = [];
  let myDevs = [];
  try { peerDevs = (await api(`/api/e2e/device-prekeys/${encodeURIComponent(peerHandle)}`, { headers: hdr })).devices || []; } catch {}
  try { myDevs = (await api("/api/e2e/my-devices", { headers: hdr })).devices || []; } catch {}
  const peers = peerDevs.filter((b) => b && b.ik && b.spkPub);
  const mine = myDevs.filter((b) => b && b.deviceId);
  if (!peers.length && !mine.length) return null; // aucun appareil enrôlé → repli legacy
  const envelopes = [];
  for (const b of peers) {
    try {
      const enc = await mdEncryptToDevice(myHandle, b, text); // ratchet par-appareil (FS)
      envelopes.push({ recipientDeviceId: b.deviceId, iv: enc.iv, ciphertext: enc.ciphertext });
    } catch { /* appareil injoignable → ignoré */ }
  }
  if (mine.length) {
    const self = await mdSelfEncrypt(text); // un seul chiffré, lisible par TOUS mes appareils
    if (self) for (const b of mine) envelopes.push({ recipientDeviceId: b.deviceId, iv: self.iv, ciphertext: self.ciphertext });
  }
  if (!envelopes.length) return null;
  const clientMsgId = "m-" + _b64url(crypto.getRandomValues(new Uint8Array(12)));
  // Conserve le clair localement (keyé par clientMsgId) pour réafficher MON propre envoi
  // sur CET appareil (aucune enveloppe ne m'est adressée à moi-même).
  await rIdbPut(mdSentKey(myHandle, clientMsgId), { text, exp: Date.now() + 25 * 3600 * 1000 }).catch(() => {});
  return { clientMsgId, envelopes };
}

/** Déchiffre une enveloppe reçue de l'appareil `senderDeviceId` : session keyée par
 *  ce device-id (le serveur le fournit via `sender_device_id`). ratchetDecrypt lit le
 *  header pour établir le responder X3DH au 1ᵉʳ message, puis avance la session. */
export async function mdDecryptEnvelope(myHandle, accessKey, senderDeviceId, iv, packed) {
  if (!senderDeviceId) return null;
  return ratchetDecrypt(myHandle, accessKey, mdSessionKey(senderDeviceId), iv, packed);
}

/** Clair de MON propre envoi fan-out (FS : non redéchiffrable), relu du cache local. */
export async function mdRecallSent(myHandle, clientMsgId) {
  const r = await rIdbGet(mdSentKey(myHandle, clientMsgId));
  if (!r) return null;
  if (r.exp && r.exp < Date.now()) { rIdbDel(mdSentKey(myHandle, clientMsgId)).catch(() => {}); return null; }
  return r.text;
}
