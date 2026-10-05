// Deux fichiers par date, deux propriétaires (docs/adr/0083) :
//  - data/health/<date>.json  → écrit par le Raccourci iPhone UNIQUEMENT
//    (sommeil, FC repos, HRV, poids…). L'app ne l'écrit jamais : plus de
//    conflit de sha avec le Raccourci.
//  - data/checkin/<date>.json → écrit par l'app UNIQUEMENT (check-in,
//    douleur, RPE/durée, charges de séance).
export const healthPath = (date) => `data/health/${date}.json`;
export const checkinPath = (date) => `data/checkin/${date}.json`;
