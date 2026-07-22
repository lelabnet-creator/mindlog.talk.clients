/**
 * Cache PIM hors-ligne (tâche B2) — SQLite-WASM sur OPFS (VFS SAHPool).
 *
 * Stocke UNIQUEMENT les données PIM (carte, agenda, relations, demandes, tags,
 * notifications, préférences) — JAMAIS la clé d'accès ni le contenu/métadonnées
 * des messages E2E (éphémères + ratchet destructif). Miroir léger du cache Room
 * d'Android, côté web.
 *
 * Dégradation gracieuse : tout échec (navigateur sans OPFS, init WASM impossible…)
 * est avalé → `save`/`load` deviennent des no-op et l'app reste en ligne comme avant.
 * Le module WASM (~0,8 Mo) est chargé en *dynamic import* paresseux : aucun coût
 * sur la landing, seulement à la première lecture/écriture PIM (page éditeur).
 *
 * Expose `window.mindlogLocalPim = { save(me), load() }`.
 */
(function () {
  "use strict";

  let dbPromise = null;

  async function getDb() {
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      const { default: sqlite3InitModule } = await import("/static/vendor/sqlite3/index.mjs");
      const sqlite3 = await sqlite3InitModule();
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "mindlog-pim" });
      const db = new pool.OpfsSAHPoolDb("/pim.sqlite3");
      db.exec(
        "CREATE TABLE IF NOT EXISTS pim (handle TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)"
      );
      return db;
    })().catch((e) => {
      dbPromise = null; // permet une nouvelle tentative ultérieure
      throw e;
    });
    return dbPromise;
  }

  // Liste blanche des champs PIM conservés hors-ligne. Exclut volontairement
  // `accessKey` (secret) et `conversations` (métadonnées de messages E2E).
  const KEEP = [
    "handle",
    "fields",
    "events",
    "relations",
    "incoming",
    "requests",
    "tags",
    "overrides",
    "notifications",
    "settings",
    "hasPhoto",
    "hasVault",
    "hasPubkey",
    "pubkey",
    "unread",
    "pending",
    "recoveryEmail",
    "publicUrl",
  ];

  function sanitize(me) {
    if (!me || typeof me !== "object") return null;
    const out = {};
    for (const k of KEEP) if (k in me) out[k] = me[k];
    return out.handle ? out : null;
  }

  async function save(me) {
    const pim = sanitize(me);
    if (!pim) return;
    try {
      const db = await getDb();
      db.exec({
        sql:
          "INSERT INTO pim (handle, json, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(handle) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        bind: [pim.handle, JSON.stringify(pim), new Date().toISOString()],
      });
    } catch (e) {
      /* cache best-effort : on ignore (reste en ligne) */
    }
  }

  async function load() {
    try {
      const db = await getDb();
      const json = db.selectValue("SELECT json FROM pim ORDER BY updated_at DESC LIMIT 1");
      return json ? JSON.parse(json) : null;
    } catch (e) {
      return null;
    }
  }

  window.mindlogLocalPim = { save, load };
})();
