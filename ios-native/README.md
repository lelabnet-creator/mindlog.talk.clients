# mindlog · talk — client iOS natif (Swift)

Vide pour l'instant. Ce dossier accueillera une **implémentation native
complète** — pas une coquille. La distinction est le sens même du suffixe
`-native` :

| | `ios/` | `ios-native/` (ici) |
|---|---|---|
| Nature | emballage Capacitor de `../web` | implémentation à part entière |
| Vues | celles du web | redessinées en SwiftUI |
| Appels API | ceux du web | réécrits en Swift |
| Évolution fonctionnelle | gratuite, via `npm run sync` | à refaire ici |

## Avant d'y écrire la première ligne

C'est de la **duplication assumée**, et elle se paie. Le projet a déjà
l'expérience : le client Android natif de talk n'a jamais eu d'i18n alors que
son web est traduit en 7 langues. Rien ne casse quand une implémentation prend
du retard — elle rend juste un produit différent sous le même nom.

Ce que le natif apporte en échange : démarrage à froid, fluidité des listes et
des animations, widgets, intégrations système profondes, empreinte mémoire.
Ouvrir ce dossier veut dire que ces gains valent le coût récurrent.

## Garde-fou

Le **contrat d'API fait foi** (`../../mindlog.talk/contract/openapi.yaml`). Générer les types depuis ce contrat
plutôt que les retaper est le seul point où la duplication n'est pas
négociable : c'est ce qui empêche le client natif de dériver en silence du
serveur.

Convention complète : `docs/architecture/clients.md` du monorepo.
