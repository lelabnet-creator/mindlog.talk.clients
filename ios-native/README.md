# mindlog · talk — client iOS natif (Swift)

Vide. Ce dossier est prévu pour une **implémentation native complète**, à
distinguer de la coquille `ios/` :

| | `ios/` | `ios-native/` (ici) |
|---|---|---|
| Nature | coquille Capacitor embarquant `../web` | implémentation à part entière |
| Vues | celles du client web | écrites en SwiftUI |
| Appels réseau | ceux du client web | écrits en Swift |
| Évolution fonctionnelle | héritée du web par synchronisation | à implémenter ici |

## Ce que cela implique

Une implémentation native duplique les écrans et la couche réseau. Ce qu'elle
apporte en retour : démarrage à froid plus rapide, défilement et animations
natifs, widgets système, intégrations profondes avec la plateforme, empreinte
mémoire réduite.

La contrepartie est permanente : chaque évolution fonctionnelle doit être portée
ici en plus du client web, et un écart entre les deux ne provoque aucune erreur
— il produit simplement deux applications différentes sous le même nom.

## Contrat d'API

Le contrat OpenAPI du service fait foi : `mindlog.talk/contract/openapi.yaml`.

Les types doivent être **générés depuis ce contrat**, jamais retapés : c'est ce
qui garantit qu'un client natif suit les évolutions du serveur.
