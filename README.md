# mindlog · talk — clients

Les clients de [mindlog · talk](https://github.com/jacquesh82/mindlog.talk), une
messagerie chiffrée de bout en bout. Un dossier par plateforme.

```
web/             SPA en modules ES, sans bundler — l'UI et la logique
android/         coquille Capacitor autour de web/       (vide)
ios/             coquille Capacitor autour de web/       (vide)
android-native/  implémentation Kotlin / Compose         (vide)
ios-native/      implémentation Swift / SwiftUI          (vide)
dev-server.mjs   serveur de dev : statique + proxy /api vers le backend
Caddyfile        référence de la configuration servie en production
```

Seul `web/` contient du code aujourd'hui. Le client desktop est un projet Tauri
distinct, hors de ce dépôt.

## Deux familles de clients

Les coquilles `android/` et `ios/` embarquent `web/` dans une WebView : elles ne
contiennent que le projet natif généré, la configuration Capacitor, les plugins
natifs (notifications, biométrie, partage) et la chaîne de signature. Aucune vue
ni logique n'y est réécrite — une évolution du web s'y propage par une commande
de synchronisation.

Les dossiers `android-native/` et `ios-native/` sont prévus pour des
implémentations complètes, écrites dans le langage de la plateforme. Elles
redessinent les vues et réécrivent les appels réseau.

## web/

```
web/
  index.html      coquille de la SPA ; lit la configuration runtime via /api/config
  app.js          noyau : routeur, authentification, amorçage
  crypto/         X3DH, Double Ratchet, clés de groupe
  ui/ views/      composants et écrans
  editor/         éditeur de messages
  plugins/        modules fonctionnels (chat, agenda, appels…)
  net.js          couche réseau ; base URL configurable
  types/api.d.ts  types générés depuis le contrat OpenAPI
```

### Développement

Le backend tourne à part, par défaut sur `http://localhost:8787` :

```sh
# terminal 1 — backend
cd ../mindlog.talk && DATABASE_DRIVER=pglite npm run dev
# terminal 2 — client
npm run dev            # http://localhost:3000, proxifie /api vers le backend
```

`BACKEND_URL` et `PORT` sont surchargeables. En production, les fichiers
statiques et le proxy `/api` sont servis par un reverse proxy Caddy — une seule
origine — et non par ce serveur de développement.

### Types

`web/types/api.d.ts` est généré depuis `../mindlog.talk/contract/openapi.yaml` :

```sh
npm run gen:types
```

Ne pas l'éditer à la main. Le contrat OpenAPI fait foi pour tous les clients,
y compris les implémentations natives.

### Vérification syntaxique

```sh
npm run check          # parse tous les modules ES de web/
```
