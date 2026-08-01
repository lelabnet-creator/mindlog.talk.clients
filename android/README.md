# mindlog · talk — shell Android (Capacitor)

Vide. Ce dossier est prévu pour le shell de plateforme : projet natif généré par
`cap add android`, `capacitor.config.ts`, plugins natifs et chaîne de
build/signature.

Aucune vue ni logique métier ici — elles vivent dans `../web/`, que le shell
embarque. Mettre à jour l'application revient à faire évoluer le code web puis à
rejouer une synchronisation Capacitor.

## Contraintes de la plateforme

- **Notifications** : Firebase Cloud Messaging.
- **Coffre de clés E2E** : la sauvegarde des clés impose un secret *portable*
  (code PIN ou phrase secrète). La biométrie seule est liée à l'appareil et ne
  restaure rien ailleurs.
- **Traductions** : l'interface web existe en 7 langues ; le shell doit exposer
  la locale du système au client web plutôt que gérer ses propres ressources.
