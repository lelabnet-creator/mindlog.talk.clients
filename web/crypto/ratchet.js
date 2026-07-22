/* ======================================================================== *
 * crypto/ratchet.js — Double Ratchet + X3DH (forward secrecy).
 * Portage de src/ratchet.ts ; interop garantie par test/vectors/ratchet.json.
 * Primitives, X3DH, machine à états, stockage IndexedDB, prekeys, cache, et le
 * chiffrement/déchiffrement haut niveau (ratchetSend/ratchetDecrypt).
 * Dépendance circulaire assumée avec multidevice (live bindings ES).
 * Extrait verbatim de public/app.js. cf. docs/web-crypto-modules.md.
 * ======================================================================== */
import { E2E, ECDH, _b64, _b64url, _unb64, _unb64url } from "./state.js";
import { api } from "../net.js";
import { mdDeviceId, mdRegisterDevice } from "./multidevice.js";

/* ======================================================================== *
 * Double Ratchet + X3DH (forward secrecy) — portage de src/ratchet.ts.
 * Mêmes primitives qu'en TS/Android : ECDH P-256 (secret = X brut 32 o),
 * HKDF-SHA256, HMAC-SHA256, AES-GCM-256, IV déterministe par clé message.
 * L'AAD authentifiée est l'AD de session (IK_A||IK_B) suivie des octets EXACTS
 * du header transmis (b64url), d'où l'interop sans canonicalisation JSON.
 * ======================================================================== */
export const R_INFO_X3DH = new TextEncoder().encode("mindlog-x3dh-v1");
export const R_INFO_RK = new TextEncoder().encode("mindlog-ratchet-rk-v1");
export const R_INFO_MSG = new TextEncoder().encode("mindlog-msg-v1");
export const R_ZERO32 = new Uint8Array(32);
export const R_FF32 = new Uint8Array(32).fill(0xff);
export const R_MAX_SKIP = 1000;
export const R_MAX_SKIPPED_STORE = 2000;

export function rConcat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
export function rEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export function rPublicOf(j) {
  return { kty: "EC", crv: "P-256", x: j.x, y: j.y, ext: true };
}
export function rRawPub(pub) {
  return rConcat(_unb64url(pub.x), _unb64url(pub.y));
}
export async function rGenKeyPair() {
  const kp = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const [priv, pub] = await Promise.all([
    crypto.subtle.exportKey("jwk", kp.privateKey),
    crypto.subtle.exportKey("jwk", kp.publicKey),
  ]);
  return { priv, pub };
}
export async function rEcdh(privJwk, pubJwk) {
  // Force key_ops à ["deriveBits"] : les clés générées avec ["deriveKey"] ont key_ops=["deriveKey"]
  // dans leur JWK exporté, ce qui bloque importKey avec ["deriveBits"] sous Chrome/WebCrypto strict.
  const privForDH = { ...privJwk, key_ops: ["deriveBits"] };
  const [pk, pub] = await Promise.all([
    crypto.subtle.importKey("jwk", privForDH, ECDH, false, ["deriveBits"]),
    crypto.subtle.importKey("jwk", rPublicOf(pubJwk), ECDH, false, []),
  ]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, pk, 256));
}
export async function rHkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
export async function rHmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
}
export async function rAesEnc(keyBytes, iv, plain, aad) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, plain));
}
export async function rAesDec(keyBytes, iv, ct, aad) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, ct));
}
export async function rKdfRk(rk, dh) {
  const out = await rHkdf(dh, rk, R_INFO_RK, 64);
  return { rk: out.slice(0, 32), ck: out.slice(32, 64) };
}
export async function rKdfCk(ck) {
  return { ck: await rHmac(ck, new Uint8Array([0x02])), mk: await rHmac(ck, new Uint8Array([0x01])) };
}
export async function rKdfMk(mk) {
  const t = await rHkdf(mk, R_ZERO32, R_INFO_MSG, 44);
  return { key: t.slice(0, 32), iv: t.slice(32, 44) };
}

// --- X3DH ---
export async function rX3dhInitiator(ikA, ekA, bundle) {
  const parts = [
    R_FF32,
    await rEcdh(ikA.priv, bundle.spkPub),
    await rEcdh(ekA.priv, bundle.ik),
    await rEcdh(ekA.priv, bundle.spkPub),
  ];
  if (bundle.opkPub) parts.push(await rEcdh(ekA.priv, bundle.opkPub));
  const sk = await rHkdf(rConcat(...parts), R_ZERO32, R_INFO_X3DH, 32);
  const ad = rConcat(rRawPub(ikA.pub), rRawPub(bundle.ik));
  return { sk, ad };
}
export async function rX3dhResponder(ikB, spkB, opkB, ikAPub, ekAPub) {
  const parts = [
    R_FF32,
    await rEcdh(spkB.priv, ikAPub),
    await rEcdh(ikB.priv, ekAPub),
    await rEcdh(spkB.priv, ekAPub),
  ];
  if (opkB) parts.push(await rEcdh(opkB.priv, ekAPub));
  const sk = await rHkdf(rConcat(...parts), R_ZERO32, R_INFO_X3DH, 32);
  const ad = rConcat(rRawPub(ikAPub), rRawPub(ikB.pub));
  return { sk, ad };
}

// --- état du ratchet (sérialisable IndexedDB) ---
export async function rInitSender(sk, ad, spkB) {
  const dhs = await rGenKeyPair();
  const { rk, ck } = await rKdfRk(sk, await rEcdh(dhs.priv, spkB));
  return { rk: _b64(rk), dhs, dhr: rPublicOf(spkB), cks: _b64(ck), ckr: null, ns: 0, nr: 0, pn: 0, ad: _b64(ad), skipped: [], confirmed: false };
}
export function rInitReceiver(sk, ad, spkB) {
  return { rk: _b64(sk), dhs: { priv: spkB.priv, pub: rPublicOf(spkB.pub) }, dhr: null, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, ad: _b64(ad), skipped: [], confirmed: true };
}
export async function rEncrypt(state, plaintext, bootstrap) {
  if (!state.cks) throw new Error("chaîne d'envoi absente");
  const { ck, mk } = await rKdfCk(_unb64(state.cks));
  state.cks = _b64(ck);
  const header = { v: 2, dh: rPublicOf(state.dhs.pub), pn: state.pn, n: state.ns };
  if (bootstrap) { header.ek = bootstrap.ek; header.ik = bootstrap.ik; header.opk = bootstrap.opk; header.spk = bootstrap.spk; }
  state.ns += 1;
  const headerB64u = _b64url(new TextEncoder().encode(JSON.stringify(header)));
  const { key, iv } = await rKdfMk(mk);
  const aad = rConcat(_unb64(state.ad), new TextEncoder().encode(headerB64u));
  const ct = await rAesEnc(key, iv, new TextEncoder().encode(plaintext), aad);
  return { headerB64u, iv: _b64(iv), ct: _b64(ct) };
}
export function rPushSkipped(state, dh, n, mk) {
  state.skipped.push({ dh, n, mk: _b64(mk) });
  while (state.skipped.length > R_MAX_SKIPPED_STORE) state.skipped.shift();
}
export async function rTrySkipped(state, header, iv, ct, aad) {
  const dh = _b64url(rRawPub(header.dh));
  const idx = state.skipped.findIndex((e) => e.dh === dh && e.n === header.n);
  if (idx < 0) return null;
  const { key, iv: mkIv } = await rKdfMk(_unb64(state.skipped[idx].mk));
  if (!rEq(mkIv, _unb64(iv))) return null;
  try {
    const pt = await rAesDec(key, _unb64(iv), _unb64(ct), aad);
    state.skipped.splice(idx, 1);
    return new TextDecoder().decode(pt);
  } catch { return null; }
}
export async function rSkipMessageKeys(state, until) {
  if (state.ckr === null) return;
  if (until - state.nr > R_MAX_SKIP) throw new Error("trop de clés à sauter");
  if (state.dhr === null) return;
  const dh = _b64url(rRawPub(state.dhr));
  while (state.nr < until) {
    const { ck, mk } = await rKdfCk(_unb64(state.ckr));
    state.ckr = _b64(ck);
    rPushSkipped(state, dh, state.nr, mk);
    state.nr += 1;
  }
}
export async function rDhRatchet(state, header) {
  state.pn = state.ns; state.ns = 0; state.nr = 0;
  state.dhr = rPublicOf(header.dh);
  let step = await rKdfRk(_unb64(state.rk), await rEcdh(state.dhs.priv, state.dhr));
  state.rk = _b64(step.rk); state.ckr = _b64(step.ck);
  state.dhs = await rGenKeyPair();
  step = await rKdfRk(_unb64(state.rk), await rEcdh(state.dhs.priv, state.dhr));
  state.rk = _b64(step.rk); state.cks = _b64(step.ck);
}
export async function rDecrypt(state, headerB64u, iv, ct) {
  const header = JSON.parse(new TextDecoder().decode(_unb64url(headerB64u)));
  const aad = rConcat(_unb64(state.ad), new TextEncoder().encode(headerB64u));
  const skipped = await rTrySkipped(state, header, iv, ct, aad);
  if (skipped !== null) { state.confirmed = true; return skipped; }
  const headerDh = _b64url(rRawPub(header.dh));
  const curDhr = state.dhr ? _b64url(rRawPub(state.dhr)) : null;
  if (headerDh !== curDhr) { await rSkipMessageKeys(state, header.pn); await rDhRatchet(state, header); }
  await rSkipMessageKeys(state, header.n);
  if (state.ckr === null) return null;
  const { ck, mk } = await rKdfCk(_unb64(state.ckr));
  const { key, iv: mkIv } = await rKdfMk(mk);
  if (!rEq(mkIv, _unb64(iv))) return null;
  try {
    const pt = await rAesDec(key, _unb64(iv), _unb64(ct), aad);
    state.ckr = _b64(ck); state.nr += 1; state.confirmed = true;
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

/* ----------- Stockage IndexedDB (états ratchet + prekeys locales) -------- */
export const RDB_NAME = "mindlog-ratchet";
export const RDB_STORE = "kv";
export function rIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(RDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(RDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function rIdbGet(key) {
  const db = await rIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction(RDB_STORE, "readonly").objectStore(RDB_STORE).get(key);
    tx.onsuccess = () => res(tx.result ?? null);
    tx.onerror = () => rej(tx.error);
  });
}
export async function rIdbPut(key, val) {
  const db = await rIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction(RDB_STORE, "readwrite");
    tx.objectStore(RDB_STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function rIdbDel(key) {
  const db = await rIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction(RDB_STORE, "readwrite");
    tx.objectStore(RDB_STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export const rStateKey = (me, peer) => `ratchet:${me}:${peer}`;
// Session « inbound » archivée (multi-appareils) : sert à déchiffrer la chaîne X3DH
// PRÉ-ADOPTION du pair perdant le tiebreak, sans toucher à ma session primaire d'envoi.
export const rInboundKey = (me, peer) => `ratchet-inb:${me}:${peer}`;
export const rPrekeyKey = (me) => `prekeys:${me}`;
export const rRecvKey = (me, peer, iv) => `rcv:${rNoAt(me)}:${rNoAt(peer)}:${iv}`;

/* ----------- Prekeys X3DH : génération, publication, réappro ------------- */
export const R_OPK_TARGET = 30; // taille de pool visée
export const R_OPK_LOW = 8; // seuil de réapprovisionnement
export async function ratchetEnsurePrekeys(handle, accessKey) {
  if (!E2E.privJwk) return; // l'identité doit être prête
  const hdr = { "Content-Type": "application/json", "x-access-key": accessKey };
  let store = await rIdbGet(rPrekeyKey(handle));
  if (!store) {
    const spk = await rGenKeyPair();
    store = { spkId: 1, spk, opks: {}, nextOpkId: 1 };
  }
  // Complète le pool d'OPK localement.
  const newOpks = [];
  let available = 0;
  try {
    const r = await api("/api/e2e/prekeys/count", { headers: { "x-access-key": accessKey } });
    available = r.available || 0;
  } catch {}
  // Au premier passage (pas encore publié), on publie SPK + un pool plein.
  const firstPublish = Object.keys(store.opks).length === 0;
  if (firstPublish || available < R_OPK_LOW) {
    // Réappro basée sur le stock SERVEUR (et non le pool local) : si le serveur a été
    // vidé/désynchronisé alors que le store local croit encore avoir ses OPK, l'ancien
    // calcul (R_OPK_TARGET - localCount) donnait need=0 et ne republiait JAMAIS → le
    // bundle servi restait sans OPK en permanence (cas observé : diana à 0 OPK serveur).
    const need = Math.max(0, R_OPK_TARGET - available);
    for (let i = 0; i < need; i++) {
      const id = store.nextOpkId++;
      const kp = await rGenKeyPair();
      store.opks[id] = kp;
      newOpks.push({ opkId: id, opkPub: JSON.stringify(kp.pub) });
    }
    await rIdbPut(rPrekeyKey(handle), store);
    try {
      await fetch("/api/e2e/prekeys", {
        method: "PUT",
        headers: hdr,
        body: JSON.stringify({ spkPub: JSON.stringify(store.spk.pub), spkId: store.spkId, opks: newOpks }),
      });
    } catch {}
  } else {
    await rIdbPut(rPrekeyKey(handle), store);
  }
  // Multi-appareils (P2) : enregistre CE navigateur comme « appareil » du compte
  // (sa clé E2E locale = sa clé d'appareil) et publie ses prekeys par appareil.
  await mdRegisterDevice(handle, accessKey).catch(() => {});
}

/* ----------- Établissement de session + chiffrement de haut niveau ------- */
// Empreinte stable (clé publique brute en b64url) de l'identité d'un pair. Sert à
// LIER une session ratchet à l'identité cryptographique du pair, indépendamment du
// formatage JSON de la JWK : si le pair change d'identité (compte recréé, clé
// tournée), l'empreinte change et la session périmée est détectée puis rejouée.
export function rIkFp(jwk) { try { return _b64url(rRawPub(rPublicOf(jwk))); } catch { return ""; } }
export function rParseJwk(s) { try { return JSON.parse(s); } catch { return null; } }
export function rMyIdentity() {
  // ikA = keypair d'identité (priv JWK local + pub déduite).
  return { priv: E2E.privJwk, pub: rPublicOf(E2E.privJwk) };
}
export async function rLoadState(me, peer) { return rIdbGet(rStateKey(me, peer)); }
export async function rSaveState(me, peer, state) { return rIdbPut(rStateKey(me, peer), state); }

// Chiffre un message v2 ; établit la session (initiateur) si besoin via le bundle
// du pair. Renvoie null si le pair n'a pas de bundle (→ repli v1 par l'appelant).
export async function ratchetSend(me, accessKey, peerHandle, peerPubStr, text) {
  if (!E2E.privJwk) return null;
  let state = await rLoadState(me, peerHandle);
  // Session périmée : si la clé publique du pair a changé depuis l'établissement
  // (compte recréé, clé tournée), on la jette pour refaire un handshake X3DH —
  // sinon le destinataire recevrait « illisible ».
  if (state && state.peerIk && peerPubStr) {
    const cur = rParseJwk(peerPubStr);
    if (cur && rIkFp(cur) !== state.peerIk) { await rIdbDel(rStateKey(me, peerHandle)).catch(() => {}); state = null; }
  }
  let bootstrap = null;
  if (!state) {
    let bundle;
    try {
      bundle = await api(`/api/e2e/prekeys/${encodeURIComponent(peerHandle)}`, { headers: { "x-access-key": accessKey } });
    } catch {
      return null; // pas de bundle → repli v1
    }
    if (!bundle || !bundle.spkPub || !bundle.ik) return null;
    const ekA = await rGenKeyPair();
    const parsed = { ik: JSON.parse(bundle.ik), spkPub: JSON.parse(bundle.spkPub), spkId: bundle.spkId,
      opkPub: bundle.opkPub ? JSON.parse(bundle.opkPub) : null, opkId: bundle.opkId };
    const { sk, ad } = await rX3dhInitiator(rMyIdentity(), ekA, parsed);
    state = await rInitSender(sk, ad, parsed.spkPub);
    state.peerIk = rIkFp(rParseJwk(peerPubStr) || parsed.ik); // lie la session à l'identité du pair
    state.bootstrap = { ek: ekA.pub, ik: rMyIdentity().pub, opk: parsed.opkId, spk: parsed.spkId };
  }
  // Tant que le pair n'a pas répondu, on rejoue les champs bootstrap (idempotence TTL).
  if (!state.confirmed && state.bootstrap) bootstrap = state.bootstrap;
  const r = await rEncrypt(state, text, bootstrap);
  await rSaveState(me, peerHandle, state);
  // Forward secrecy : la clé message est détruite, donc je ne pourrai plus
  // redéchiffrer MON propre message. On en garde le clair localement (keyé par
  // l'IV, unique), pour le réafficher tel quel à chaque rafraîchissement.
  await rIdbPut(rSentKey(me, r.iv), { text, exp: Date.now() + 25 * 3600 * 1000 });
  rCachePutKey(me, accessKey, rSentKey(me, r.iv), text).catch(() => {}); // cache cross-appareil
  return { iv: r.iv, ciphertext: rPack(r.headerB64u, r.ct) };
}
export const rSentKey = (me, iv) => `sent:${rNoAt(me)}:${iv}`;
export async function ratchetRecallSent(me, accessKey, iv) {
  const r = await rIdbGet(rSentKey(me, iv));
  if (r && (!r.exp || r.exp >= Date.now())) return r.text;
  if (r) rIdbDel(rSentKey(me, iv)).catch(() => {});
  // Appareil restauré (clé seule) : mon propre clair vit dans le cache cross-appareil.
  await rCacheEnsureDown(me, accessKey);
  return rCacheGetKey(me, rSentKey(me, iv));
}

/* ---- Cache de déchiffrement cross-appareil (interop web↔Android) ----------
 * Le Double Ratchet est destructif : un appareil restauré (même coffre) n'a pas
 * l'état de session et ne peut PAS redériver les anciens messages. On conserve
 * donc les clairs récents (< 24 h), chiffrés AES-GCM sous une clé dérivée de la
 * clé d'IDENTITÉ, poussés sur le serveur (/api/e2e/cache). Tout appareil avec la
 * clé restaurée relit l'historique récent. Le serveur ne voit jamais de clair.
 *
 * FORMAT (identique à E2eRepository Android, ne pas diverger) :
 *  - clé AES = HKDF-SHA256(ikm = scalaire privé `d` 32 o, sel = "mindlog-e2e-cache-v1",
 *    info = "ratchet-cache", 32)
 *  - enveloppe serveur = JSON { v:1, iv, ct }  (base64 standard)
 *  - charge utile (déchiffrée) = JSON { "<cléStore>": "<chaîneJSON>" } où
 *    cléStore ∈ { "rcv:<moi>:<pair>:<iv>", "sent:<moi>:<iv>" } (@ retirés) et
 *    la valeur est la CHAÎNE JSON {"text":…,"exp":<ms>}. */
export const R_CACHE_TTL = 25 * 3600 * 1000;
export const R_CACHE_SALT = new TextEncoder().encode("mindlog-e2e-cache-v1");
export const R_CACHE_INFO = new TextEncoder().encode("ratchet-cache");
export const rNoAt = (s) => String(s || "").replace(/^@/, "");
export const rCacheMapKey = (me) => `cmap:${rNoAt(me)}`;
export let _rCacheUpTimer = null;
export let _rCacheDownAt = 0; // dernier pull (throttle réactif)
export let _rCacheDownInflight = null; // pull en cours (partagé par les lectures concurrentes)

// Clé AES-256-GCM stable dérivée du scalaire privé d'identité (interop Android).
export async function rCacheAesKey() {
  const id = rMyIdentity();
  if (!id || !id.priv || !id.priv.d) return null;
  const raw = await rHkdf(_unb64url(id.priv.d), R_CACHE_SALT, R_CACHE_INFO, 32);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function rCacheLoadMap(me) {
  const m = (await rIdbGet(rCacheMapKey(me))) || {};
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(m)) if (!m[k] || (m[k].e || 0) < now) { delete m[k]; changed = true; }
  if (changed) await rIdbPut(rCacheMapKey(me), m).catch(() => {});
  return m;
}
export async function rCacheGetKey(me, storeKey) {
  const e = (await rCacheLoadMap(me))[storeKey];
  return e && (e.e || 0) >= Date.now() ? e.t : null;
}
export async function rCachePutKey(me, accessKey, storeKey, text) {
  if (text == null) return;
  const m = (await rIdbGet(rCacheMapKey(me))) || {};
  if (m[storeKey] && m[storeKey].t === text) return; // déjà en cache → pas de réupload
  m[storeKey] = { t: text, e: Date.now() + R_CACHE_TTL };
  await rIdbPut(rCacheMapKey(me), m).catch(() => {});
  if (!accessKey) return;
  clearTimeout(_rCacheUpTimer);
  _rCacheUpTimer = setTimeout(() => rCacheUpload(me, accessKey).catch(() => {}), 4000);
}
export async function rCacheUpload(me, accessKey) {
  /* fan-out natif — cache retiré */
}
export async function rCacheDownload(me, accessKey) {
  /* fan-out natif — cache retiré */
}
// Télécharge le cache, ré-armable toutes les 8 s (récupération réactive à la
// réception d'un nouveau message). Les lectures concurrentes partagent le pull en cours.
export function rCacheEnsureDown(me, accessKey) {
  if (_rCacheDownInflight) return _rCacheDownInflight;
  if (Date.now() - _rCacheDownAt < 8000) return Promise.resolve();
  _rCacheDownAt = Date.now();
  _rCacheDownInflight = rCacheDownload(me, accessKey).catch(() => {}).finally(() => { _rCacheDownInflight = null; });
  return _rCacheDownInflight;
}

// Déchiffre un message v2 ; établit la session (destinataire) depuis le header
// bootstrap si aucune session locale. Renvoie le texte, ou null si indéchiffrable.
// Le texte déchiffré est mis en cache dans l'IDB (clé rcv:) pour que des appels
// ultérieurs (ex. depuis gSyncKeys puis depuis le chat UI) retournent le même résultat
// même si l'état ratchet a déjà avancé — évite les "(indéchiffrable)" causés par la
// consommation des clés de chaîne lors du scan SKDM des groupes.
export async function ratchetDecrypt(me, accessKey, peerHandle, iv, packed) {
  // Cache : si ce message a déjà été déchiffré, retourner le texte mis en cache.
  const cacheKey = rRecvKey(me, peerHandle, iv);
  const cached = await rIdbGet(cacheKey);
  if (cached && (!cached.exp || cached.exp >= Date.now())) return cached.text;
  // Appareil restauré (clé seule, pas d'état ratchet) : on tente le cache
  // cross-appareil AVANT le ratchet (qui ne pourrait de toute façon pas redériver).
  await rCacheEnsureDown(me, accessKey);
  const fromCache = await rCacheGetKey(me, cacheKey);
  if (fromCache != null) return fromCache;

  const up = rUnpack(packed);
  if (!up) return null;
  // Header lu d'avance : son champ `ik` (identité de l'expéditeur) permet de
  // détecter une session locale périmée (pair recréé / clé tournée).
  let header;
  try { header = JSON.parse(new TextDecoder().decode(_unb64url(up.headerB64u))); } catch { return null; }

  // Tiebreak déterministe (sessions « dev: » uniquement) : sur une course de DOUBLE
  // INITIATION entre deux appareils, les deux côtés appliquent la MÊME règle pour
  // converger vers une seule racine X3DH — celle de l'appareil au device-id le plus
  // petit (le « gagnant »). Sans ça, chacun jette sa session initiateur et devient
  // responder de l'autre → deux racines distinctes → désync permanente.
  const isDevice = peerHandle.startsWith("dev:");
  const myDev = isDevice ? mdDeviceId() : null;
  const peerDev = isDevice ? peerHandle.slice(4) : null;
  const iWin = isDevice && myDev != null && peerDev != null && myDev < peerDev;

  const stateKey = rStateKey(me, peerHandle);
  const inbKey = rInboundKey(me, peerHandle);
  let primary = await rLoadState(me, peerHandle);
  let inbound = await rIdbGet(inbKey);

  // Identité du pair changée (compte recréé / clé tournée) → on jette TOUT (primaire +
  // inbound) : l'ancienne identité ne reviendra pas, le pair refera un handshake.
  if (primary && primary.peerIk && header.ik && rIkFp(header.ik) !== primary.peerIk) {
    await rIdbDel(stateKey).catch(() => {});
    await rIdbDel(inbKey).catch(() => {});
    primary = null; inbound = null;
  }

  // rDecrypt MUTE l'état (avancée du ratchet) → on clone avant chaque essai et on ne
  // persiste le clone QUE si le déchiffrement réussit (sinon on garde l'état intact).
  const tryWith = async (st, saveKey) => {
    if (!st) return null;
    const clone = JSON.parse(JSON.stringify(st));
    const t = await rDecrypt(clone, up.headerB64u, iv, up.ct);
    if (t === null) return null;
    await rIdbPut(saveKey, clone).catch(() => {});
    return t;
  };

  let text = await tryWith(primary, stateKey);              // messages normaux + renvois récents
  if (text === null) text = await tryWith(inbound, inbKey); // chaîne pré-adoption archivée du pair

  // Aucune session existante ne déchiffre → message d'une (nouvelle) chaîne X3DH.
  let consumeOpk = null;
  if (text === null) {
    if (!header.ek || !header.ik) return null; // non-bootstrap & illisible → message perdu
    const estFp = rIkFp(header.ek);
    // Renvoi/ancien message d'une de MES sessions responder courantes (même établisseur) :
    // rDecrypt n'a pas pu le récupérer (trop ancien dans la chaîne) → ne pas réétablir un
    // doublon, qui brûlerait une OPK et écraserait une session saine.
    if ((primary && primary.bootEk === estFp) || (inbound && inbound.bootEk === estFp)) return null;
    const pre = await rIdbGet(rPrekeyKey(me));
    if (!pre) return null;
    const spkB = pre.spk; // (1 SPK active en v1)
    const opkB = header.opk != null ? pre.opks[header.opk] || null : null;
    const { sk, ad } = await rX3dhResponder(rMyIdentity(), spkB, opkB, JSON.parse(JSON.stringify(header.ik)), JSON.parse(JSON.stringify(header.ek)));
    const S = rInitReceiver(sk, ad, spkB);
    S.peerIk = rIkFp(header.ik); // lie la session à l'identité de l'expéditeur
    S.bootEk = estFp;            // éphémère X3DH établisseur (anti-doublon / détection retransmit)
    text = await rDecrypt(S, up.headerB64u, iv, up.ct);
    // Établissement raté (OPK périmée serveur, désync) → ne rien persister, ne pas brûler l'OPK.
    if (text === null) return null;
    if (opkB && header.opk != null) consumeOpk = { pre, id: header.opk };
    // Placement déterministe :
    if (!primary) {
      await rIdbPut(stateKey, S).catch(() => {});  // 1er contact → session primaire (cas normal)
    } else if (iWin) {
      await rIdbPut(inbKey, S).catch(() => {});    // je GAGNE → j'archive la chaîne du pair, je garde ma primaire (initiateur)
    } else {
      await rIdbPut(stateKey, S).catch(() => {});  // je PERDS → la session responder vers le gagnant devient ma primaire
      await rIdbDel(inbKey).catch(() => {});        // mon ancien inbound éventuel n'a plus de sens
    }
  }
  if (consumeOpk) {
    delete consumeOpk.pre.opks[consumeOpk.id]; // OPK à usage unique
    await rIdbPut(rPrekeyKey(me), consumeOpk.pre).catch(() => {});
  }
  // Mise en cache du texte déchiffré (TTL 25 h, cohérent avec recallSent).
  if (text !== null) {
    await rIdbPut(cacheKey, { text, exp: Date.now() + 25 * 3600 * 1000 }).catch(() => {});
    rCachePutKey(me, accessKey, cacheKey, text).catch(() => {}); // cache cross-appareil
  }
  return text;
}

export function rPack(headerB64u, ct) { return headerB64u + "." + ct; }
export function rUnpack(packed) {
  if (typeof packed !== "string") return null;
  const dot = packed.indexOf(".");
  if (dot <= 0) return null;
  return { headerB64u: packed.slice(0, dot), ct: packed.slice(dot + 1) };
}
// Un message v2 a un ciphertext « headerB64url.ciphertext » ; le « . » n'existe
// pas dans l'alphabet base64 des messages v1 → discriminant fiable.
export function isRatchetCiphertext(ct) { return typeof ct === "string" && ct.includes("."); }
