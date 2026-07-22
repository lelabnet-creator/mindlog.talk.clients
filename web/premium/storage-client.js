// Client de stockage tiers (Premium) — chiffrement BOUT-EN-BOUT des médias +
// upload direct navigateur → fournisseur.
//
// Modèle de confiance : la clé symétrique d'espace (AES-256-GCM) qui chiffre les
// médias est générée DANS LE NAVIGATEUR du créateur et n'est JAMAIS envoyée en
// clair au serveur. Elle est enveloppée (ECDH P-256 + AES-GCM, mêmes primitives
// que le chat) pour CHAQUE membre autorisé avec sa clé publique. Le serveur ne
// stocke que des enveloppes opaques : id.mindlog ne peut PAS lire les médias —
// seuls le créateur et ses abonnés actifs le peuvent.
//
// CORS : déchiffrer à l'affichage nécessite un fetch cross-origin du fichier
// chiffré → le stockage doit autoriser CORS en lecture (S3/R2/B2/Wasabi/Scaleway/
// DO/MinIO le permettent ; configurez l'origine).
import { api, authHeaders, jsonAuth } from "../net.js";
import { myHandle, myKey } from "../core.js";
import { ensureE2E, e2eEncrypt, e2eDecrypt } from "../crypto/e2e.js";
import { E2E } from "../crypto/state.js";
import { t } from "../i18n.js";

const aesCache = new Map(); // handle → CryptoKey (clé média importée)
const kb64Cache = new Map(); // handle → clé média en base64 (côté créateur)

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
const importAes = (kb64) => crypto.subtle.importKey("raw", b64ToBytes(kb64), "AES-GCM", false, ["encrypt", "decrypt"]);

// PUT direct vers le fournisseur. Un échec réseau = blocage CORS (le bucket doit
// autoriser PUT depuis cette origine) — message explicite plutôt que « Failed to fetch ».
async function putToProvider(url, headers, body) {
  let res;
  try {
    res = await fetch(url, { method: "PUT", headers: headers || {}, body });
  } catch {
    throw new Error(t("sto_cors_blocked"));
  }
  if (!res.ok) throw new Error(`upload échoué (${res.status})`);
  return res;
}

async function ensureE2EReady() {
  if (!E2E.priv) await ensureE2E(myHandle(), myKey() || "");
  if (!E2E.priv) throw new Error(t("sto_e2e_unavailable"));
}

// ── Côté membre/visiteur : récupère + déchiffre l'enveloppe de la clé média ──
export async function loadMediaKey(handle) {
  if (aesCache.has(handle)) return aesCache.get(handle);
  await ensureE2EReady();
  const env = await api(`/api/space/${encodeURIComponent(handle)}/media-key`, { headers: authHeaders() });
  if (!env?.ct) throw new Error("clé média non partagée");
  const kb64 = await e2eDecrypt(env.sender_pub, env.iv, env.ct);
  if (!kb64) throw new Error("déchiffrement de la clé média impossible");
  const key = await importAes(kb64);
  aesCache.set(handle, key);
  return key;
}

// ── Côté créateur : enveloppe la clé média pour toutes les cibles (lui +
// abonnés actifs). À appeler à l'ouverture de l'espace et avant le 1ᵉʳ upload. ──
export async function syncOwnerMediaKeys(handle) {
  await ensureE2EReady();
  const kb64 = await ensureOwnerKb64(handle);
  let targets = [];
  try {
    targets = (await api("/api/storage/media-key-targets", { headers: authHeaders() })).targets || [];
  } catch { return; }
  const entries = [];
  for (const t of targets) {
    if (!t.pubkey) continue;
    try {
      const env = await e2eEncrypt(t.pubkey, kb64);
      entries.push({ member_identity_id: t.member_identity_id, sender_pub: E2E.pubStr, iv: env.iv, ct: env.ciphertext });
    } catch { /* clé publique du membre invalide → ignoré */ }
  }
  if (entries.length) {
    await api("/api/storage/media-keys", { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ entries }) });
  }
}

// Clé média en clair (base64) côté créateur : depuis son enveloppe existante,
// sinon génération + enveloppe initiale pour toutes les cibles.
async function ensureOwnerKb64(handle) {
  if (kb64Cache.has(handle)) return kb64Cache.get(handle);
  await ensureE2EReady();
  // 1) enveloppe déjà publiée pour moi ? → déchiffre.
  try {
    const env = await api(`/api/space/${encodeURIComponent(handle)}/media-key`, { headers: authHeaders() });
    if (env?.ct) {
      const kb64 = await e2eDecrypt(env.sender_pub, env.iv, env.ct);
      if (kb64) { kb64Cache.set(handle, kb64); return kb64; }
    }
  } catch { /* 404 = pas encore de clé → on en crée une */ }
  // 2) première fois : génère K et publie les enveloppes.
  const kb64 = bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
  kb64Cache.set(handle, kb64);
  const targets = (await api("/api/storage/media-key-targets", { headers: authHeaders() }).catch(() => ({ targets: [] }))).targets || [];
  const entries = [];
  for (const t of targets) {
    if (!t.pubkey) continue;
    try {
      const env = await e2eEncrypt(t.pubkey, kb64);
      entries.push({ member_identity_id: t.member_identity_id, sender_pub: E2E.pubStr, iv: env.iv, ct: env.ciphertext });
    } catch { /* ignoré */ }
  }
  // Garantit au moins l'enveloppe auto-adressée (member_identity_id:0 = « moi »
  // côté serveur) si la liste des cibles est vide (clé publique pas encore
  // répliquée). Le créateur doit toujours pouvoir relire ses propres médias.
  if (!entries.length) {
    const env = await e2eEncrypt(E2E.pubStr, kb64);
    entries.push({ member_identity_id: 0, sender_pub: E2E.pubStr, iv: env.iv, ct: env.ciphertext });
  }
  await api("/api/storage/media-keys", { method: "PUT", headers: jsonAuth(), body: JSON.stringify({ entries }) });
  return kb64;
}

async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}
async function decryptBuffer(key, buf) {
  const data = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12) }, key, data.subarray(12));
}

const safeName = (n) => String(n || "media").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "media";

// Chiffre (clé d'espace, jamais connue du serveur) puis uploade un fichier
// directement chez le fournisseur. Renvoie l'item { url, kind, mime, enc }.
export async function uploadEncrypted({ file, handle, scope = "private" }) {
  const kb64 = await ensureOwnerKb64(handle);
  const key = await importAes(kb64);
  const cipher = await encryptBytes(key, new Uint8Array(await file.arrayBuffer()));
  const blob = new Blob([cipher], { type: "application/octet-stream" });

  const filename = `${Date.now()}-${safeName(file.name)}.enc`;
  const signed = await api("/api/storage/sign", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ filename, contentType: file.type || "application/octet-stream", size: blob.size, scope }),
  });
  if (signed.mode === "none") throw new Error(signed.reason || "upload non supporté par ce fournisseur");

  let publicUrl;
  if (signed.mode === "put") {
    await putToProvider(signed.uploadUrl, signed.headers, blob);
    publicUrl = signed.publicUrl;
  } else if (signed.mode === "session") {
    const headers = { ...(signed.headers || {}) };
    if (signed.rangeUpload) headers["Content-Range"] = `bytes 0-${blob.size - 1}/${blob.size}`;
    const res = await fetch(signed.sessionUrl, { method: signed.method, headers, body: blob });
    if (!res.ok) throw new Error(`upload échoué (${res.status})`);
    const j = await res.json().catch(() => ({}));
    const ref = j.id || j.fileId || j.path_lower || j.path_display || signed.key;
    const fin = await api("/api/storage/finalize", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
    if (!fin?.publicUrl) throw new Error("partage public échoué");
    publicUrl = fin.publicUrl;
  } else {
    throw new Error("réponse de signature inattendue");
  }

  return {
    url: publicUrl,
    kind: (file.type || "").startsWith("video") ? "video" : "image",
    mime: file.type || "application/octet-stream",
    enc: true,
  };
}

// ── Galerie PUBLIQUE (vitrine) : NON chiffrée, servie directement ──────────
// Liste les images du dossier vitrine du stockage du créateur.
export async function listPublicGallery(handle) {
  const r = await api(`/api/storage/gallery/${encodeURIComponent(handle)}`, { headers: authHeaders() });
  return r?.items || [];
}

// Uploade une image SANS chiffrement vers le dossier vitrine (mindlog/public/
// gallery/). Renvoie { url, name, kind }. L'image est publique → affichée
// directement par <img src>, sans déchiffrement ni CORS de lecture.
export async function uploadPublic({ file, handle }) {
  void handle;
  const signed = await api("/api/storage/sign", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, contentType: file.type || "application/octet-stream", size: file.size, scope: "public-gallery" }),
  });
  if (signed.mode === "none") throw new Error(signed.reason || "upload non supporté par ce fournisseur");
  let url, key;
  if (signed.mode === "put") {
    await putToProvider(signed.uploadUrl, signed.headers, file);
    url = signed.publicUrl;
    key = signed.key; // clé S3 → suppression immédiate possible
  } else if (signed.mode === "session") {
    const headers = { ...(signed.headers || {}) };
    if (signed.rangeUpload) headers["Content-Range"] = `bytes 0-${file.size - 1}/${file.size}`;
    const res = await fetch(signed.sessionUrl, { method: signed.method, headers, body: file });
    if (!res.ok) throw new Error(`upload échoué (${res.status})`);
    const j = await res.json().catch(() => ({}));
    const ref = j.id || j.fileId || j.path_lower || j.path_display || signed.key;
    const fin = await api("/api/storage/finalize", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
    url = fin?.publicUrl || "";
    key = ref;
  } else {
    throw new Error("réponse de signature inattendue");
  }
  return { url, name: file.name, kind: (file.type || "").startsWith("video") ? "video" : "image", key };
}

// Nom « propre » d'un objet privé : retire le préfixe horodaté et le suffixe .enc.
export const cleanName = (name) => String(name || "").replace(/^\d+-/, "").replace(/\.enc$/i, "");

const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v", ogv: "video/ogg",
  pdf: "application/pdf", zip: "application/zip", txt: "text/plain", csv: "text/csv", json: "application/json",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
};
const mimeFromName = (name) => MIME_BY_EXT[(cleanName(name).split(".").pop() || "").toLowerCase()] || "";

// Renvoie une URL affichable (objectURL déchiffré si `enc`, sinon l'URL brute).
export async function resolveMediaUrl(handle, item) {
  if (!item || !item.url) return "";
  if (!item.enc) return item.url;
  const key = await loadMediaKey(handle);
  const res = await fetch(item.url, { mode: "cors" });
  if (!res.ok) throw new Error(`média introuvable (${res.status})`);
  const plain = await decryptBuffer(key, await res.arrayBuffer());
  const type = item.mime || mimeFromName(item.name) || (item.kind === "video" ? "video/mp4" : "image/jpeg");
  return URL.createObjectURL(new Blob([plain], { type }));
}

// Supprime un objet du stockage (propriétaire uniquement, vérifié côté serveur).
export async function deleteObject(key) {
  return api("/api/storage/delete", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

// ── Sections PRIVÉES (galerie/fichiers chiffrés, réservées aux abonnés) ──────
export async function listPrivate(handle, kind) {
  const r = await api(`/api/storage/private/${encodeURIComponent(handle)}/${kind === "files" ? "files" : "gallery"}`, { headers: authHeaders() });
  return r?.items || [];
}

// Déchiffre un fichier privé et déclenche son téléchargement (tout type).
export async function downloadPrivateFile(handle, item) {
  const key = await loadMediaKey(handle);
  const res = await fetch(item.url, { mode: "cors" });
  if (!res.ok) throw new Error(`fichier introuvable (${res.status})`);
  const plain = await decryptBuffer(key, await res.arrayBuffer());
  const name = cleanName(item.name) || "fichier";
  const url = URL.createObjectURL(new Blob([plain], { type: mimeFromName(item.name) || "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
