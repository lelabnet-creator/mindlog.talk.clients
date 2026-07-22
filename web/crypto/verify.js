/* ======================================================================== *
 * crypto/verify.js — numéro de sécurité (vérification anti-MITM, façon Signal).
 * Empreinte hors-bande dérivée des DEUX clés d'identité, identique des deux
 * côtés et BYTE-À-BYTE identique au portage TS/Android (ne pas altérer la
 * logique). Le modal UI openSafetyNumber reste dans app.js.
 * Extrait verbatim de public/app.js. cf. docs/web-crypto-modules.md.
 * ======================================================================== */
import { api, authHeaders } from "../net.js";
import { rConcat, rPublicOf, rRawPub } from "./ratchet.js";

// Empreinte vérifiable hors-bande dérivée des DEUX clés d'identité (façon Signal),
// identique des deux côtés. Doit être byte-à-byte identique au portage TS/Android.
export const SN_VERSION = new Uint8Array([0x00, 0x00]);
export const SN_ITER = 5200;
export async function rSha512(data) { return new Uint8Array(await crypto.subtle.digest("SHA-512", data)); }
export async function rUserFingerprint(handle, ikRaw) {
  let h = await rSha512(rConcat(SN_VERSION, ikRaw, new TextEncoder().encode(handle)));
  for (let i = 0; i < SN_ITER; i++) h = await rSha512(rConcat(h, ikRaw));
  let out = "";
  for (let i = 0; i < 6; i++) {
    const c = h.subarray(i * 5, i * 5 + 5);
    const n = ((c[0] * 256 + c[1]) * 256 + c[2]) * 256 + c[3];
    out += String((n * 256 + c[4]) % 100000).padStart(5, "0");
  }
  return out;
}
export function rCmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
/** Numéro de sécurité combiné (60 chiffres) entre moi et un pair. */
export async function safetyNumber(myHandle, myPubStr, peerHandle, peerPubStr) {
  const myRaw = rRawPub(rPublicOf(JSON.parse(myPubStr)));
  const peerRaw = rRawPub(rPublicOf(JSON.parse(peerPubStr)));
  const mine = await rUserFingerprint(myHandle, myRaw);
  const theirs = await rUserFingerprint(peerHandle, peerRaw);
  return rCmpBytes(myRaw, peerRaw) <= 0 ? mine + theirs : theirs + mine;
}
export function groupDigits(sn) { return (sn.match(/.{1,5}/g) || []).join(" "); }
export async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Statut de vérification (synchronisé serveur), gardé par contact réciproque.
export async function verifyGet(handle) {
  try { return await api(`/api/e2e/verify/${encodeURIComponent(handle)}`, { headers: authHeaders() }); }
  catch { return { safety: null, verifiedAt: null }; }
}
export async function verifyPut(handle, safetyHash) {
  await api(`/api/e2e/verify/${encodeURIComponent(handle)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ safety: safetyHash }),
  });
}
export async function verifyClear(handle) {
  await api(`/api/e2e/verify/${encodeURIComponent(handle)}`, { method: "DELETE", headers: authHeaders() });
}
