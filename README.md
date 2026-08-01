# mindlog · talk — clients

Tous les clients de talk, un dossier par plateforme. Le socle **UI + logique est
unique** — `web/`, une SPA en modules ES sans bundler — et les autres dossiers
n'en sont que des **enveloppes** : ils ne dupliquent ni vue ni logique métier.

```
web/            socle : SPA servie sur le Web ET embarquée par les shells
android/        shell Capacitor  — à venir (cf. mindlog.talk/BACKLOG.md, T30)
ios/            shell Capacitor  — à venir
dev-server.mjs  serveur de dev : statique + proxy /api vers le backend
Caddyfile       référence du service en prod (l'edge fait foi)
```

Le desktop reste **Tauri** et vit hors de ce dépôt.

## web/ — le socle

Extrait de `mindlog.talk/public/` lors de la scission client/backend.

```
web/
  index.html      coquille SPA ; récupère la config runtime via /api/config
  app.js          noyau (routeur, auth, boot) — cf. crypto/, ui/, views/, editor/, plugins/
  net.js          couche réseau (base URL configurable : window.__API_BASE__ / setApiBase)
  types/api.d.ts  types générés depuis le contrat (npm run gen:types)
```

### Dev

Le backend doit tourner à part (défaut `http://localhost:8787`) :

```sh
# terminal 1 — backend
cd ../mindlog.talk && DATABASE_DRIVER=pglite npm run dev
# terminal 2 — client
npm run dev            # http://localhost:3000, proxifie /api → backend
```

`BACKEND_URL` et `PORT` sont surchargables. En prod, le service statique + le
proxy sont assurés par l'**edge** (Caddy, une seule origine) — pas par ce
serveur de dev.

### Contrat

Les types TS de `web/types/api.d.ts` sont générés depuis
`../mindlog.talk/contract/openapi.yaml` (`npm run gen:types`). Ne pas les
éditer à la main.

## android/ et ios/ — shells de plateforme

Vides pour l'instant, voir leurs README respectifs. La règle qui les gouverne :
**tout ce qui est visible ou métier appartient à `web/`**. Un shell ne contient
que le projet natif, la config Capacitor, les plugins natifs (push, biométrie,
partage) et la chaîne de build/signature.

L'ancien client Android **natif Kotlin** de `mindlog.talk/android/` n'est pas
leur ancêtre : il est remplacé, pas porté (T30 pour la coquille Capacitor, T36
pour son archivage).
