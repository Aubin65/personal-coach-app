// ============================================================================
// Carnet de touches (docs/adr/0107) — données et choré des annonces d'alignement.
// Module pur (aucun DOM) : chaque touche est une suite de « phases » avec les
// positions (en mètres) des joueurs ; l'animation et l'affichage vivent dans
// views/touches.js. Positions : x = distance à la ligne de touche, y = écart
// latéral (0 = alignement, y > 0 = côté nôtre/arrière, y < 0 = côté adverse).
// ============================================================================

// ---------- géométrie (mètres) ----------
const U = 0.78, TIGHT = 0.85, OUT = 1.7;
export const T0 = [-0.8, -0.55], NINE0 = [8.6, 2.7], R0 = [10.4, 2.9];
const range = (n) => Array.from({ length: n }, (_, i) => String(i + 1));

export function normal(n) {
  const end = { 7: 14, 5: 12, 4: 10.5 }[n];
  return Array.from({ length: n }, (_, i) => 6 + (i * (end - 6)) / (n - 1));
}
function line(ids, xs) { const o = {}; ids.forEach((id, i) => (o[id] = [xs[i], 0])); return o; }
function blocks(ids, sizes, end) {
  const inner = sizes.reduce((s, k) => s + (k - 1) * TIGHT, 0);
  const gap = (end - 6 - inner) / (sizes.length - 1);
  let x = 6, i = 0;
  const o = {};
  sizes.forEach((k) => {
    for (let j = 0; j < k; j++) { o[ids[i++]] = [x, 0]; if (j < k - 1) x += TIGHT; }
    x += gap;
  });
  return o;
}
function unit(c, F, J, B) { return { [F]: [c - U, 0], [J]: [c, 0], [B]: [c + U, 0] }; }
const fw = (ids) => ids.map((id) => ({ id, label: id, kind: "fw" }));
const HOOK = { id: "T", label: "T", kind: "hooker" };
const NINE = { id: "9", label: "9", kind: "nine" };
const RELAY = { id: "R", label: "R", kind: "relay" };
const toNine = (from, x) => ({ t: "Ballon au 9", d: `Le ${from} redonne au 9.`, p: { 9: [x, 1.9] }, ball: [[from, "9"]] });

// ---------- classique ----------
export const NOTES = ["DO", "RE", "MI", "FA", "SOL"];
export function jumperOf(n, note) {
  const k = NOTES.indexOf(note);
  return n === 7 ? k + 2 : [2, 2, 3, 4, 4][k];
}
export function validClassique(n, code, note) {
  const j = jumperOf(n, note);
  return code === "40" ? j >= 3 : code === "60" ? j + 2 <= n : true;
}
function classique(n, code, note) {
  const ids = range(n), xs = normal(n), X = (i) => xs[i - 1], j = jumperOf(n, note), s = String;
  const ph = [{ t: "Placement", d: `Alignement à ${n}, écart normal. « ${code} ${note} … » : ${note} désigne le ${j}e de l’alignement.`, p: line(ids, xs) }];
  if (code === "50") {
    ph.push({ t: "50 : saut sur place", d: `Le ${j} saute à sa place, lifté par le ${j - 1} devant et le ${j + 1} derrière.`, p: unit(X(j), s(j - 1), s(j), s(j + 1)), jump: { J: s(j), L: [s(j - 1), s(j + 1)] }, ball: [["T", s(j)]] });
    ph.push(toNine(s(j), X(j) + 0.3));
  } else {
    ph.push({ t: "Feinte", d: `Le ${j} feinte le saut avec ses lifts ${j - 1} et ${j + 1}.`, p: unit(X(j), s(j - 1), s(j), s(j + 1)), feint: { J: s(j), L: [s(j - 1), s(j + 1)] } });
    if (code === "40") {
      const c = X(j - 2) + U;
      ph.push({ t: "40 : saut devant", d: `Le lift avant (${j - 1}) sort. Le ${j} et le ${j + 1} avancent : le ${j} saute au niveau du ${j - 2}, qui lifte devant.`, p: { ...unit(c, s(j - 2), s(j), s(j + 1)), [s(j - 1)]: [X(j) - U, OUT] }, out: [s(j - 1)], jump: { J: s(j), L: [s(j - 2), s(j + 1)] }, ball: [["T", s(j)]] });
      ph.push(toNine(s(j), c + 0.3));
    } else {
      const c = X(j + 2) - U;
      ph.push({ t: "60 : saut derrière", d: `Le ${j} sort. Le ${j - 1} recule lever le ${j + 1} (le lift arrière), avec le ${j + 2} derrière.`, p: { ...unit(c, s(j - 1), s(j + 1), s(j + 2)), [s(j)]: [X(j), OUT] }, via: { [s(j - 1)]: [X(j), 0.9] }, out: [s(j)], jump: { J: s(j + 1), L: [s(j - 1), s(j + 2)] }, ball: [["T", s(j + 1)]] });
      ph.push(toNine(s(j + 1), c + 0.3));
    }
  }
  return { players: [...fw(ids), NINE, HOOK], phases: ph };
}

// ---------- touches à 7 ----------
const IDS7 = range(7);
function samba() {
  const b = blocks(IDS7, [3, 1, 3], 14), c = b["6"][0];
  return { players: [...fw(IDS7), NINE, HOOK], phases: [
    { t: "Placement", d: "Alignement à 7, écart normal.", p: line(IDS7, normal(7)) },
    { t: "« Change » → 313", d: "Bloc de 3, un joueur seul, bloc de 3.", p: b },
    { t: "Saut en SOL", d: "Le 6 saute, lifté par le 5 et le 7. Le joueur seul (4) va couvrir : il contourne les sauteurs par derrière et se place au fond de l’alignement. Le premier bloc part en arc de cercle derrière l’alignement.", p: { ...unit(c, "5", "6", "7"), 4: [15.1, 0.2], 1: [16.3, 1.0], 2: [15.6, 1.8], 3: [17.0, 1.9] }, via: { 4: [13.2, 2.0], 1: [7, 3.7], 2: [8, 4.0], 3: [9, 4.4] }, jump: { J: "6", L: ["5", "7"] }, ball: [["T", "6"]] },
    { t: "Percussion", d: "Le 6 donne au 1, qui arrive lancé avec le 2 et le 3 et percute plus loin que la touche.", p: { 1: [16.6, 0.35], 2: [16.0, 1.1], 3: [17.3, 1.15] }, ball: [["6", "1"]], arrows: [[16.6, 0.35, 17.3, -2.5]] },
  ] };
}
function biarritz() {
  const b = blocks(IDS7, [3, 1, 3], 14), x4 = b["4"][0];
  return { players: [...fw(IDS7), NINE, HOOK], phases: [
    { t: "Placement", d: "Alignement à 7, écart normal.", p: line(IDS7, normal(7)) },
    { t: "« Change » → 313", d: "Bloc de 3, un joueur seul au milieu, bloc de 3.", p: b },
    { t: "Feinte au milieu", d: "Le 3 (fin du premier bloc) et le 5 (début du dernier) viennent feinter le lift sur le 4.", p: { 3: [x4 - U, 0], 5: [x4 + U, 0] }, feint: { J: "4", L: ["3", "5"] } },
    { t: "Saut au milieu", d: "Le 3 et le 5 repartent à leur place d’origine ; le 1 et le 7, lifteurs des extrémités, viennent lever le 4.", p: { 3: b["3"], 5: b["5"], 1: [x4 - U, 0], 7: [x4 + U, 0] }, via: { 1: [7.7, 0.8], 7: [12.3, 0.8] }, jump: { J: "4", L: ["1", "7"] }, ball: [["T", "4"]] },
    toNine("4", x4 + 0.4),
  ] };
}
const IDS9 = ["9", "2", "3", "4", "5", "6", "7"];
const PLAYERS9 = [{ id: "9", label: "9", kind: "nine" }, ...fw(IDS9.slice(1)), RELAY, HOOK];
function paris(v) {
  const b = blocks(IDS9, [3, 2, 2], 14), x3 = b["3"][0], x6 = b["6"][0];
  const ph = [
    { t: "Placement", d: "Le 9 entre en premier de l’alignement, un avant se place en relayeur (R).", p: { ...line(IDS9, normal(7)), R: [9.8, 2.9] } },
    { t: "« Change » → 322", d: "Bloc de 3 (9-2-3), bloc de 2 (4-5), bloc de 2 (6-7).", p: b },
    { t: "Feinte sur le 4", d: "Les deux du milieu viennent feinter le saut au niveau du 3 : le 4 feinte le saut, le 3 feinte le lift devant, le 5 lifte derrière.", p: { 4: [x3 + U, 0], 5: [x3 + 2 * U, 0] }, feint: { J: "4", L: ["3", "5"] } },
  ];
  if (v === "1") {
    ph.push({ t: "Relayeur : « 1 »", d: "La feinte devient le vrai saut : le 4, lifté par le 3 et le 5. Le relayeur s’approche.", p: { R: [6.6, 1.7] }, jump: { J: "4", L: ["3", "5"] }, ball: [["T", "4"]] });
    ph.push({ t: "Duel dans le couloir", d: "Le 4 donne au relayeur, qui joue le duel dans le couloir avec le talonneur.", p: { R: [3.4, 0.9], T: [2.5, 0.35] }, ball: [["4", "R"]], arrows: [[3.4, 0.9, 2.9, -2.5]] });
  } else {
    ph.push({ t: "Relayeur : « 2 »", d: "Après avoir feinté le lift devant, le 3 part lifter au fond : saut sur le 6, lifté par le 3 et le 7. Le 9 décroche.", p: { ...unit(x6, "3", "6", "7"), 9: [12.1, 1.9] }, via: { 3: [10.6, 1.1], 9: [8.5, 2.6] }, jump: { J: "6", L: ["3", "7"] }, ball: [["T", "6"]] });
    ph.push({ t: "Jeu derrière", d: "Le 9 prend la balle et fait jouer les lignes arrière.", ball: [["6", "9"]], arrows: [[12.1, 1.9, 15.6, 4.4]] });
  }
  return { players: PLAYERS9, phases: ph };
}
function specialeBase() {
  const b = blocks(IDS9, [3, 2, 2], 14), x6 = b["6"][0];
  return [
    { t: "Placement", d: "Comme Paris : le 9 devant, un avant en relayeur (R).", p: { ...line(IDS9, normal(7)), R: [9.8, 2.9] } },
    { t: "« Change » → 322", d: "Bloc de 3 (9-2-3), bloc de 2 (4-5), bloc de 2 (6-7).", p: b },
    { t: "Saut direct au fond", d: "Le relayeur s’avance pour lifter devant le 6 (avant-dernier), le 7 lifte derrière. Le 5 va couvrir : il contourne les sauteurs par derrière et se place au fond de l’alignement. Le 4 fait semblant d’aller devant.", p: { ...unit(x6, "R", "6", "7"), 5: [15.1, 0.2], 4: [8.6, 0] }, via: { R: [11.6, 1.7], 5: [13.4, 2.2] }, jump: { J: "6", L: ["R", "7"] }, ball: [["T", "6"]] },
  ];
}
function speciale() {
  return { players: PLAYERS9, phases: [...specialeBase(),
    { t: "Décalage du bloc 2-3-4", d: "Le bloc 2-3-4 se décale dans l’alignement vers le relayeur. En l’air, le 6 donne au 3.", p: { 2: [10.0, 0], 3: [10.8, 0], 4: [11.6, 0] }, ball: [["6", "3"]] },
    { t: "Maul désaxé", d: "Le maul se forme à hauteur du relayeur, autour du 3 : le 2, le 3 et le 4 restent dans l’alignement, le relayeur, le 6 et le 7 se lient derrière.", p: { 2: [10.7, 0], 3: [11.45, 0], 4: [12.2, 0], R: [12.0, 0.75], 6: [12.85, 0.55], 7: [13.6, 0.3], 9: [11.3, 1.6] }, via: { 9: [9, 2.3] }, arrows: [[11.45, 0, 9.6, -2.2]] },
  ] };
}
function smart() {
  return { players: PLAYERS9, phases: [...specialeBase(),
    { t: "Le 3 sort en arc", d: "Celui qui devait faire le maul (3) sort de la touche en décrivant un arc de cercle.", p: { 3: [11.0, 1.8] }, via: { 3: [8.0, 3.9] } },
    { t: "Percussion au milieu", d: "Le 6 donne au 3 lancé, qui percute au milieu de l’alignement, là où le 4 et le 5 ont libéré l’espace.", p: { 3: [10.7, 0.3] }, ball: [["6", "3"]], arrows: [[10.7, 0.3, 10.2, -2.5]] },
  ] };
}

// ---------- touches à 5 et 4 ----------
const IDS5 = range(5), X5 = normal(5);
function t121() {
  return { players: [...fw(IDS5), NINE, HOOK], phases: [
    { t: "Placement", d: "Alignement à 5, écart normal.", p: line(IDS5, X5) },
    { t: "Feinte devant", d: "Les trois premiers feintent le saut sur le 2.", p: unit(X5[1], "1", "2", "3"), feint: { J: "2", L: ["1", "3"] } },
    { t: "Deuxième feinte", d: "Le 2 sort et se replace en premier lifteur, tout devant. Le 1 et le 3 reculent et feintent plus loin avec le 4 : lift 1, sauteur 3, lift 4.", p: { 2: [6.0, 0], ...unit(X5[3] - U, "1", "3", "4") }, via: { 2: [6.7, 1.3], 1: [8.2, 0.8] }, feint: { J: "3", L: ["1", "4"] } },
    { t: "Saut devant", d: "Le lifteur avant (1) sort ; le bloc 3-4 revient devant où le 2 l’attend : lift 2, sauteur 3, lift 4.", p: { 1: [X5[3] - 2 * U, OUT], ...unit(6.0 + U, "2", "3", "4") }, out: ["1"], jump: { J: "3", L: ["2", "4"] }, ball: [["T", "3"]] },
    toNine("3", 7.1),
  ] };
}
function t131() {
  return { players: [...fw(IDS5), NINE, HOOK], phases: [
    { t: "Placement", d: "Alignement à 5, écart normal.", p: line(IDS5, X5) },
    { t: "Feinte sur le 2", d: "Les trois premiers feintent le saut sur le 2.", p: unit(X5[1], "1", "2", "3"), feint: { J: "2", L: ["1", "3"] } },
    { t: "Le 2 sort", d: "Le sauteur (2) sort de l’alignement.", p: { 2: [X5[1], OUT] }, out: ["2"] },
    { t: "Feinte sur le 3", d: "Feinte sur le 3, avec le 1 en lift avant et le 4 en lift arrière.", p: unit(X5[2], "1", "3", "4"), feint: { J: "3", L: ["1", "4"] } },
    { t: "Le 3 sort, saut au fond", d: "Le 3 sort ; saut au niveau du 5 : le 4 saute, lifté par le 1 devant et le 5 derrière.", p: { 3: [X5[2], OUT], ...unit(X5[4] - U, "1", "4", "5") }, via: { 1: [9.6, -0.35] }, out: ["3"], jump: { J: "4", L: ["1", "5"] }, ball: [["T", "4"]] },
    toNine("4", X5[4] - U + 0.3),
  ] };
}
function anglet(v) {
  const ph = [
    { t: "Placement", d: "Alignement à 5, écart normal, avec un relayeur (R).", p: { ...line(IDS5, X5), 9: [7.6, 2.7], R: [10.6, 2.9] } },
    { t: "Les 3 premiers devant", d: "Le 1, le 2 et le 3 se mettent en position de saut devant. Le relayeur annonce 1 ou 2.", p: unit(6.4, "1", "2", "3"), feint: { J: "2", L: ["1", "3"] } },
  ];
  if (v === "1") {
    ph.push({ t: "Relayeur : « 1 »", d: "Ballon au premier bloc : le 2 saute, lifté par le 1 et le 3.", jump: { J: "2", L: ["1", "3"] }, ball: [["T", "2"]] });
    ph.push(toNine("2", 6.8));
  } else {
    ph.push({ t: "Relayeur : « 2 »", d: "Ballon au second bloc : le relayeur rentre lifter devant le 4, qui saute ; le 5 lifte derrière.", p: unit(X5[3], "R", "4", "5"), via: { R: [10.4, 1.4] }, jump: { J: "4", L: ["R", "5"] }, ball: [["T", "4"]] });
    ph.push(toNine("4", 10.8));
  }
  return { players: [...fw(IDS5), NINE, RELAY, HOOK], phases: ph };
}
function billintx(v) {
  const c = X5[1] + U; // le 3 reste en place, sauteur du bloc de devant
  const ph = [
    { t: "Placement", d: "Alignement à 5, écart normal.", p: line(IDS5, X5) },
    { t: "Feinte en RE", d: "Le premier bloc feinte le saut en RE : le 2, avec le 1 et le 3.", p: unit(X5[1], "1", "2", "3"), feint: { J: "2", L: ["1", "3"] } },
    { t: "Le 1 feinte en SOL", d: "Le 1 contourne et va feinter en SOL avec les deux qui restent : lift 1, sauteur 4, lift 5.", p: unit(X5[3], "1", "4", "5"), via: { 1: [8.4, 1.4] }, feint: { J: "4", L: ["1", "5"] } },
    { t: "Le 1 revient lifter derrière", d: "Le 1 revient lifter derrière ceux restés devant : lift 2, sauteur 3, lift 1.", p: { 1: [c + U, 0] }, via: { 1: [9.9, 0.9] }, feint: { J: "3", L: ["2", "1"] } },
  ];
  if (v === "1") {
    ph.push({ t: "Annonce « 1 » : saut devant", d: "Le trio avance et saute plus devant : le 3, lifté par le 2 et le 1.", p: unit(6.5, "2", "3", "1"), jump: { J: "3", L: ["2", "1"] }, ball: [["T", "3"]] });
    ph.push(toNine("3", 6.8));
  } else {
    ph.push({ t: "Annonce « 2 » : saut au fond", d: "Le 2, resté tout devant, repart lever au fond ; le trio recule et saute plus au fond : lift 2, sauteur 4, lift 5.", p: { ...unit(11.5, "2", "4", "5"), 1: [9.0, 0.55] }, via: { 2: [8.6, 1.5] }, jump: { J: "4", L: ["2", "5"] }, ball: [["T", "4"]] });
    ph.push(toNine("4", 11.8));
  }
  return { players: [...fw(IDS5), NINE, HOOK], phases: ph };
}
function lacaze(v) {
  const ids = range(4), b = blocks(ids, [3, 1], 10.5), x2 = b["2"][0], x4 = b["4"][0];
  const ph = [
    { t: "Placement", d: "Alignement à 4, écart normal.", p: line(ids, normal(4)) },
    { t: "« Change » → 31", d: "Bloc de 3 devant, un joueur seul au fond.", p: b },
  ];
  if (v === "A") {
    ph.push({ t: "« A » : saut direct", d: "Saut direct sur le premier bloc : le 2, lifté par le 1 et le 3.", p: unit(x2, "1", "2", "3"), jump: { J: "2", L: ["1", "3"] }, ball: [["T", "2"]] });
    ph.push(toNine("2", 7.2));
  } else {
    ph.push({ t: "Feinte sur le 2", d: "Le premier bloc feinte le saut sur le 2.", p: unit(x2, "1", "2", "3"), feint: { J: "2", L: ["1", "3"] } });
    const step = { p: { 2: [x2, OUT], ...unit(x4 - U, "1", "3", "4") }, via: { 1: [8, 0.8] }, out: ["2"] };
    if (v === "ouais") {
      ph.push({ t: "« Ouais » : saut sur le 3", d: "Le 2 sort ; le 1 vient lever le 3 au niveau du 4, qui lifte derrière.", ...step, jump: { J: "3", L: ["1", "4"] }, ball: [["T", "3"]] });
      ph.push(toNine("3", x4 - U + 0.3));
    } else {
      ph.push({ t: "Le 2 sort, feinte sur le 3", d: "Le 2 sort ; le 1 et le 4 font mine de lever le 3.", ...step, feint: { J: "3", L: ["1", "4"] } });
      ph.push({ t: "« Non » : retour devant", d: "Le lifteur avant (1) sort ; on revient sauter en premier bloc sur le 2, qui avait feinté au début.", p: { 1: [x4 - 2 * U, OUT], ...unit(x2, "3", "2", "4") }, via: { 3: [7.5, 0.7] }, out: ["1"], back: ["2"], jump: { J: "2", L: ["3", "4"] }, ball: [["T", "2"]] });
      ph.push(toNine("2", 7.2));
    }
  }
  return { players: [...fw(ids), NINE, HOOK], phases: ph };
}

// ---------- catalogue ----------
const V12 = [{ k: "1", l: "« 1 »" }, { k: "2", l: "« 2 »" }];
export const TOUCHES = [
  { id: "c7", name: "Classique", group: "Complète · 7", tag: "7", placement: "Écart normal", n: 7, classique: 7,
    sum: "Annonce : 40, 50 ou 60, puis trois notes. La première note désigne le sauteur : DO = 2e, RE = 3e, MI = 4e, FA = 5e, SOL = 6e (avant-dernier). 50 : saut sur place. 40 : feinte, le lift avant sort, saut un cran devant. 60 : feinte, le sauteur sort, le lift avant vient lever le lift arrière sur le joueur de derrière.",
    interp: "40 : le lift avant sort, le sauteur et son lift arrière avancent, et le saut se fait au niveau du joueur encore devant, qui devient lift avant. 40 sur DO et 60 sur SOL sont désactivés faute de joueur devant / derrière." },
  { id: "samba", name: "Samba", group: "Complète · 7", tag: "313", placement: "313", n: 7, build: samba,
    sum: "Placement 313. Saut en SOL (le 6). Le joueur seul couvre le lob. Les trois premiers font un arc de cercle derrière et viennent percuter plus loin que la touche, le 1 prend le ballon.",
    interp: "« Le 1 couvre » lu comme le joueur seul du 313 (le 4)." },
  { id: "paris", name: "Paris", group: "Complète · 7", tag: "322", placement: "322", n: 7, build: paris, variants: V12,
    sum: "Le 9 en premier de l’alignement, un avant en relayeur. Placement 322. Les deux du milieu viennent feinter au niveau du 3 : le 4 feinte le saut, le 3 feinte le lift devant. Relayeur « 1 » : on saute, ballon au relayeur qui joue le duel dans le couloir avec le talonneur. « 2 » : le 3 part lifter au fond sur le dernier bloc, le 9 prend la balle pour jouer derrière.",
    interp: "Le 9 compte dans le 322 (9-2-3 / 4-5 / 6-7). En « 1 », la feinte devient le vrai saut : sauteur 4, lifts 3 et 5." },
  { id: "speciale", name: "Spéciale", group: "Complète · 7", tag: "322", placement: "322", n: 7, build: speciale,
    sum: "Comme Paris, 9 devant. Saut direct sur le bloc du fond : le relayeur s’avance lifter l’avant-dernier. Le 2e du bloc du milieu couvre le lob, le 1er fait semblant d’aller devant. En l’air, le sauteur donne au 3e du premier bloc ; le bloc 2-3-4 se décale dans l’alignement vers le relayeur et forme un maul désaxé.",
    interp: "" },
  { id: "smart", name: "Spéciale Smart", group: "Complète · 7", tag: "322", placement: "322", n: 7, build: smart,
    sum: "Comme Spéciale, mais celui qui devait faire le maul (le 3) sort de la touche en arc de cercle et vient percuter au milieu.", interp: "" },
  { id: "biarritz", name: "Biarritz", group: "Complète · 7", tag: "313", placement: "313", n: 7, build: biarritz,
    sum: "Placement 313. Le 3e du premier bloc et le 1er du dernier bloc feintent sur le sauteur du milieu, puis repartent à leur place ; le premier et le dernier lifteur de la touche reviennent lever ce même sauteur.", interp: "" },
  { id: "c5", name: "Classique à 5", group: "À 5", tag: "5", placement: "Écart normal", n: 5, classique: 5,
    sum: "Même code qu’à 7. Le 2e prend DO et RE, le 3e prend MI, le dernier sauteur prend FA et SOL.",
    interp: "« Le dernier » pour FA/SOL est lu comme le 4e (dernier sauteur possible avec un lift derrière). À confirmer." },
  { id: "t121", name: "121", group: "À 5", tag: "5", placement: "Écart normal", n: 5, build: t121,
    sum: "Les trois premiers feintent devant. Le sauteur sort et se replace en premier lifteur. Les deux lifteurs reculent feinter plus loin avec le 4e. Le lifteur avant sort et le bloc revient sauter devant.",
    interp: "Deuxième feinte lue comme : lift 1, sauteur 3, lift 4. Saut final : lift 2, sauteur 3, lift 4." },
  { id: "t131", name: "131", group: "À 5", tag: "5", placement: "Écart normal", n: 5, build: t131,
    sum: "Feinte sur le 2, qui sort. Feinte sur le 3 avec le 1 et le 4 en lifteurs, le 3 sort. Saut au niveau du 5 : le 4 saute, lifté par le 1 et le 5.", interp: "" },
  { id: "anglet", name: "Anglet", group: "À 5", tag: "5+R", placement: "Écart normal + relayeur", n: 5, build: anglet, variants: V12,
    sum: "Les trois premiers vont sauter devant. Relayeur « 1 » : ballon au premier bloc. « 2 » : ballon au second bloc, le relayeur rentre lifter devant les deux de derrière.", interp: "" },
  { id: "billintx", name: "Billintx", group: "À 5", tag: "5", placement: "Écart normal", n: 5, build: billintx, variants: V12, annLbl: "Annonce",
    sum: "Feinte du premier bloc en RE. Le 1 va feinter en SOL avec les deux qui restent, puis revient lifter derrière ceux restés devant. Annonce « 1 » : on saute devant. Sinon, celui resté tout devant repart lever au fond.",
    interp: "Saut devant : lift 2, sauteur 3, lift 1. Saut au fond : lift 2, sauteur 4, lift 5. Qui annonce « 1 » / « 2 » n’est pas précisé." },
  { id: "lacaze", name: "Lacaze", group: "À 4", tag: "31", placement: "31", n: 4, build: lacaze, annLbl: "Annonce", variants: [{ k: "A", l: "« A »" }, { k: "ouais", l: "« Ouais »" }, { k: "non", l: "« Non »" }],
    sum: "Placement 31. « A » : saut direct sur le premier bloc. « Ouais » : feinte, le sauteur sort, on lève le 3e au niveau du 4e. « Non » : le lifteur avant sort et on revient sauter en premier bloc sur le sauteur qui a feinté au début.",
    interp: "« Non » lu comme la suite de « Ouais » : saut final sur le 2, lifté par le 3 devant et le 4 derrière." },
];
export const byId = Object.fromEntries(TOUCHES.map((t) => [t.id, t]));

/** Chorégraphie complète d'une annonce `{id, code?, note?, v?}` (positions initiales complétées). */
export function buildSpec(spec) {
  const t = byId[spec.id];
  const tl = t.classique ? classique(t.classique, spec.code, spec.note) : t.build(spec.v);
  const p0 = tl.phases[0].p;
  for (const pl of tl.players) {
    if (!p0[pl.id]) p0[pl.id] = pl.id === "T" ? T0 : pl.id === "9" ? NINE0 : pl.id === "R" ? R0 : [0, 0];
  }
  return tl;
}

/** États cumulés (positions, joueurs sortis, porteur) après chaque phase. */
export function compute(tl) {
  const st = [];
  let pos = {}, out = new Set(), holder = "T";
  tl.phases.forEach((ph) => {
    pos = { ...pos, ...(ph.p || {}) };
    (ph.out || []).forEach((i) => out.add(i));
    (ph.back || []).forEach((i) => out.delete(i));
    if (ph.ball) holder = ph.ball[ph.ball.length - 1][1];
    st.push({ pos: { ...pos }, out: new Set(out), holder });
  });
  return st;
}
export function specLabel(s) {
  const t = byId[s.id];
  if (t.classique) return (t.classique === 7 ? "Classique " : "Classique à 5 · ") + s.code + " " + s.note;
  if (t.variants) return t.name + " · " + t.variants.find((v) => v.k === s.v).l;
  return t.name;
}
export function callText(s) {
  const t = byId[s.id];
  if (t.classique) return `${s.code} ${s.note} …`;
  if (t.variants) return (t.annLbl ? "" : "Relayeur ") + t.variants.find((v) => v.k === s.v).l;
  return "« Change »";
}
export function classicSpecs() {
  const out = [];
  ["40", "50", "60"].forEach((c) => NOTES.forEach((nn) => { if (validClassique(7, c, nn)) out.push({ id: "c7", code: c, note: nn }); }));
  return out;
}
export function specsOf(t) {
  if (t.classique === 7) return classicSpecs();
  if (t.classique) return [];
  if (t.variants) return t.variants.map((v) => ({ id: t.id, v: v.k }));
  return [{ id: t.id }];
}
/** Toutes les annonces possibles (classique à 5 incluse) — sert aux tests. */
export function allSpecs() {
  const out = [];
  for (const t of TOUCHES) {
    if (t.classique) {
      for (const c of ["40", "50", "60"]) for (const nn of NOTES) if (validClassique(t.classique, c, nn)) out.push({ id: t.id, code: c, note: nn });
    } else out.push(...specsOf(t));
  }
  return out;
}
