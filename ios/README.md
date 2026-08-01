# mindlog · talk — shell iOS (Capacitor)

Vide. Ce dossier est prévu pour le shell de plateforme : projet natif généré par
`cap add ios`, `capacitor.config.ts`, plugins natifs et chaîne de
build/signature.

Aucune vue ni logique métier ici — elles vivent dans `../web/`, que le shell
embarque. Mettre à jour l'application revient à faire évoluer le code web puis à
rejouer une synchronisation Capacitor.

## Contraintes de la plateforme

- **Notifications** : APNs (et non Firebase Cloud Messaging).
- **Coffre de clés E2E** : stockage dans la Keychain ; la sauvegarde des clés
  impose un secret *portable* (code PIN ou phrase secrète), Face ID seul étant
  lié à l'appareil.
- **Publication** : l'application met en œuvre du chiffrement de bout en bout,
  ce qui demande une déclaration de conformité à l'export lors de la soumission
  à l'App Store.
