# mindlog · talk — shell Android (Capacitor)

Vide pour l'instant. Ce dossier accueillera **uniquement** le shell de
plateforme : projet natif généré par `cap add android`, `capacitor.config.ts`,
plugins natifs et chaîne de build/signature.

Aucune vue, aucune logique métier ici — elles vivent dans `../web/`. Voir
`docs/architecture/clients.md` pour la règle, et `mindlog.todo/android/` pour
un exemple déjà en service (`npm run sync` = build web + `cap sync`).

## À savoir avant de le remplir

Le client Android **natif Kotlin** de `mindlog.talk/android/` n'est pas
l'ancêtre de ce dossier : il est remplacé, pas porté. Suivi en T30 (coquille
Capacitor) et T36 (archivage du natif) dans `mindlog.talk/BACKLOG.md`.

Points d'attention hérités du natif : push FCM, coffre de clés E2E (la
sauvegarde obligatoire impose un secret **portable** — PIN/passphrase — la
biométrie seule ne restaure rien sur un autre appareil), et l'absence totale
d'i18n côté natif alors que le web est traduit en 7 langues.