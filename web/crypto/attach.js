/* ======================================================================== *
 * crypto/attach.js — pièces jointes chiffrées éphémères.
 *
 * Le fichier est chiffré côté client (clé AES-256 aléatoire) ; seul le blob
 * opaque est uploadé. La métadonnée + la clé voyagent dans un message E2E
 * normal (sentinelle ATT_PREFIX), donc le serveur ne voit jamais le contenu.
 *
 * Extrait verbatim de public/app.js. cf. docs/web-crypto-modules.md.
 * ======================================================================== */
import { authHeaders } from "../net.js";
import { _b64, _unb64 } from "./state.js";
import { t } from "../i18n.js";

export const ATT_PREFIX = "att"; // marqueur d'un message « pièce jointe »
const _attCache = new Map(); // id → objectURL (déchiffré), durée de la session

/** Chiffre un fichier, uploade le blob, renvoie la métadonnée à mettre dans le message. */
export async function attachEncryptUpload(handle, file) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, await file.arrayBuffer());
  const fd = new FormData();
  fd.append("blob", new Blob([ct], { type: "application/octet-stream" }), "a.bin");
  const r = await fetch(`/api/attachments/${encodeURIComponent(handle)}`, {
    method: "POST", headers: authHeaders(), body: fd,
  });
  if (!r.ok) throw new Error(t("cry_attach_send_fail"));
  const { id } = await r.json();
  return { id, name: file.name || "fichier", mime: file.type || "application/octet-stream", size: file.size, key: _b64(keyBytes), iv: _b64(iv) };
}

/** Télécharge + déchiffre une pièce jointe ; renvoie un objectURL (caché). */
export async function attachDownloadDecrypt(handle, meta) {
  if (_attCache.has(meta.id)) return _attCache.get(meta.id);
  const r = await fetch(`/api/attachments/${encodeURIComponent(handle)}/${meta.id}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(t("cry_attach_unavailable"));
  const ctBuf = await r.arrayBuffer();
  const aes = await crypto.subtle.importKey("raw", _unb64(meta.key), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _unb64(meta.iv) }, aes, ctBuf);
  const url = URL.createObjectURL(new Blob([plain], { type: meta.mime || "application/octet-stream" }));
  _attCache.set(meta.id, url);
  return url;
}

/** Construit le plaintext d'un message « pièce jointe » à partir de la métadonnée. */
export function attachPayload(meta) { return ATT_PREFIX + JSON.stringify(meta); }
/** Parse un plaintext déchiffré ; renvoie la métadonnée si c'est une pièce jointe, sinon null. */
export function parseAttachment(text) {
  if (typeof text !== "string" || !text.startsWith(ATT_PREFIX)) return null;
  try { return JSON.parse(text.slice(ATT_PREFIX.length)); } catch { return null; }
}
