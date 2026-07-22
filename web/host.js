// host.js — registre partagé exposé aux plugins (public/plugins/*.js) ET aux
// vues extraites (public/views/*, public/editor/*). app.js le PEUPLE au chargement
// (Object.assign) : les plugins/vues importent cette référence et lisent host.*
// à l'exécution (donc après le remplissage). Source de vérité unique de l'objet.
// cf. docs/web-app-split-proposal.md
export const host = {};
