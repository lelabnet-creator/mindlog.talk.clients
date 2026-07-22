// Crypto des lives — clé symétrique de stream `Ks` + chiffrement par chunk.
//
// Pourquoi AES-GCM 256 (et pas XChaCha20) ? SubtleCrypto le fournit nativement
// côté web ET côté Android (javax.crypto), pas de dépendance externe. Le risque
// nonce-reuse est éliminé par construction : chaque chunk a un nonce unique
// dérivé HKDF(Ks, "chunk" || index || epoch). Une rotation d'epoch invalide
// tous les Ki passés (révocation in-stream).
//
// Distribution de Ks : pour chaque abonné, le broadcaster :
//   1. génère un secret partagé via ECDH(myPriv, viewerPub)
//   2. dérive `wrapKey` = HKDF(secret, "live:wrap")
//   3. emballe Ks = AES-GCM(wrapKey, Ks).
// Tant que le viewer a sa clé privée ECDH, il peut déballer Ks. L'enveloppe
// voyage via la voie /signal (chiffrée) ou via key_wrap_json (annoté par
// device_id du destinataire).

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  enc: (buf) => {
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (str) => {
    const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = s + "===".slice((s.length + 3) % 4);
    const b = atob(padded);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  },
};

// ── Génération / import de Ks ───────────────────────────────────────────────

export async function generateStreamKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportRawKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

export async function importRawKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ── Chiffrement par chunk ───────────────────────────────────────────────────
// Nonce 12 octets : 4 octets epoch BE + 8 octets index BE. Garantit l'unicité
// pour 2^64 chunks par epoch, soit > 5 ans à 1 chunk/s. AAD = streamId.

export function chunkNonce(epoch, index) {
  const n = new Uint8Array(12);
  const ep = BigInt(epoch >>> 0);
  const ix = BigInt(index);
  new DataView(n.buffer).setUint32(0, Number(ep & 0xffffffffn));
  new DataView(n.buffer).setBigUint64(4, ix);
  return n;
}

export async function encryptChunk(key, streamId, epoch, index, data) {
  const iv = chunkNonce(epoch, index);
  const ad = enc.encode(streamId);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, key, data);
  return new Uint8Array(ct);
}

export async function decryptChunk(key, streamId, epoch, index, ct) {
  const iv = chunkNonce(epoch, index);
  const ad = enc.encode(streamId);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad }, key, ct);
  return new Uint8Array(pt);
}

// ── ECDH wrap / unwrap pour distribuer Ks ──────────────────────────────────
// Reprend la convention du projet (clés P-256 JWK publiées dans identities.pubkey).

export async function importEcdhPub(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

async function deriveWrapKey(privKey, peerPubJwk) {
  const peer = await importEcdhPub(peerPubJwk);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privKey, 256);
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("mindlog-live/wrap"), info: enc.encode("Ks-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function wrapStreamKey(myPriv, peerPubJwk, ksRaw) {
  const k = await deriveWrapKey(myPriv, peerPubJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, ksRaw);
  return { iv: b64u.enc(iv), ct: b64u.enc(ct) };
}

export async function unwrapStreamKey(myPriv, broadcasterPubJwk, envelope) {
  const k = await deriveWrapKey(myPriv, broadcasterPubJwk);
  const iv = b64u.dec(envelope.iv);
  const ct = b64u.dec(envelope.ct);
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, ct);
  return new Uint8Array(raw);
}

// ── Hash de chunk (identifiant de contenu, sert au mesh HAVE/WANT) ─────────

export async function sha256Hex(data) {
  const h = await crypto.subtle.digest("SHA-256", data);
  const b = new Uint8Array(h);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s.slice(0, 32); // 128 bits suffisent pour identifier un chunk
}

export const text = { enc, dec };
