// state.js — état applicatif partagé (qui suis-je + contexte d'édition courant).
// Source de vérité unique ; app.js et l'éditeur mutent les propriétés (accès par
// propriété = légal entre modules ES). cf. docs/web-app-split-proposal.md
export const appState = {
  key: null,            // clé d'accès de l'éditeur courant (null en mode cookie)
  auth: null,           // { handle, key } ou null
  me: { name: null, hasPhoto: false, photoTs: Date.now(), plan: "free" }, // profil du visiteur connecté (plan = "free" | "premium")
  myRelations: [],      // relations degré-1 du compte connecté
  commEmptyHtml: "",    // gabarit « aucune donnée » (défini au rendu, réutilisé au câblage)
  authPromise: null,  // cache de la sonde d'auth (loadAuth)
  refreshDevices: null, // callback de rafraîchissement des appareils (handler SSE "device")
};
