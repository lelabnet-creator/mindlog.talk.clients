# mindlog · talk — client Web

Socle **UI + logique unique** de l'app (SPA en modules ES, sans bundler). C'est ce client
qui est servi sur le Web **et** enveloppé par les shells natifs (Capacitor : Android/iOS)
et desktop (Tauri). Extrait de `mindlog.talk/public/` lors de la scission client/backend.

## Structure

```
web/            racine statique servie (ex-`public/`)
  index.html    coquille SPA ; récupère la config runtime via /api/config
  app.js        noyau (routeur, auth, boot) — cf. crypto/, ui/, views/, editor/, plugins/
  net.js        couche réseau (base URL configurable : window.__API_BASE__ / setApiBase)
  types/api.d.ts  types générés depuis le contrat (npm run gen:types)
dev-server.mjs  serveur de dev : statique + proxy /api vers le backend (sans dépendance)
```

## Dev

Le backend doit tourner à part (défaut `http://localhost:8787`) :

```sh
# terminal 1 — backend
cd ../mindlog.talk && DATABASE_DRIVER=pglite npm run dev
# terminal 2 — client
npm run dev            # http://localhost:3000, proxifie /api → backend
```

`BACKEND_URL` et `PORT` sont surchargables. En prod, le service statique + le proxy sont
assurés par l'**edge** (Caddy, une seule origine) — pas par ce serveur de dev.

## Contrat

Les types TS de `web/types/api.d.ts` sont générés depuis
`../mindlog.talk/contract/openapi.yaml` (`npm run gen:types`). Ne pas les éditer à la main.
