# mindlog · talk — shell iOS (Capacitor)

Vide pour l'instant. Ce dossier accueillera **uniquement** le shell de
plateforme : projet natif généré par `cap add ios`, `capacitor.config.ts`,
plugins natifs et chaîne de build/signature.

Aucune vue, aucune logique métier ici — elles vivent dans `../web/`. Voir
`docs/architecture/clients.md` pour la règle, et `mindlog.todo/android/` pour
un exemple déjà en service (`npm run sync` = build web + `cap sync`).

## À savoir avant de le remplir

Aucun client iOS n'a jamais existé. Prévoir : push APNs (et non FCM), le
stockage du coffre de clés E2E dans la Keychain, et la revue App Store des
fonctions de chiffrement (déclaration d'export).