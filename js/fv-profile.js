// ============================================================================
// Profil force-vitesse en squat jump lesté (docs/adr/0113). Module pur (aucun
// DOM, aucun import) — même calcul côté Python (`coach.fv_profile`), à garder
// aligné.
//
// Méthode « simple » de Samozino et al. (2008) : force et vitesse moyennes de la
// poussée à partir de la masse (corps + charge), de la hauteur de saut et de la
// distance de poussée hPO. La hauteur vient du temps de vol relevé en comptant
// les images d'une vidéo au ralenti : t = images / fps, h = g·t²/8.
// Profil optimal : même Pmax, masse et hPO, la pente qui maximise la vitesse de
// décollage (Samozino et al., 2012) ; FVimb = 100·|1 − Sfv/Sfv_opt|.
//
// Test (data/tests/fv/<date>.json) :
//   { date, jump: "SJ", body_mass_kg, hpo_m, fps,
//     trials: [{ load_kg, attempts: [{ frames }] }] }
// ============================================================================

export const G = 9.81;
export const MAX_FLIGHT_S = 0.9;
export const MIN_HEIGHT_M = 0.05;
export const MIN_LOADS = 3;
export const RECOMMENDED_LOADS = 4;
export const MIN_R2 = 0.95;
export const ATTEMPT_GAP = 0.1;
export const BALANCED_BAND_PCT = 10;
// Incertitude de lecture : ±1 image par saut (erreur entière uniforme sur
// {−1, 0, +1}, écart-type √(2/3) ≈ 0,8 image), propagée par différences finies.
export const FRAME_SD = 0.8;
export const LOW_FPS = 200; // en dessous (120 images/s), le bruit de lecture double

export const ORIENTATIONS = {
  balanced: {
    label: "Profil équilibré",
    tone: "ok",
    advice: "Force et vitesse sont bien dosées pour ta puissance : l'enjeu est d'augmenter ta puissance maximale en gardant cet équilibre.",
  },
  force_deficit: {
    label: "Déficit de force",
    tone: "warn",
    advice: "Ton profil est plus orienté vitesse que l'optimal : priorité à la force maximale (charges lourdes), sans perdre la vitesse.",
  },
  velocity_deficit: {
    label: "Déficit de vitesse",
    tone: "warn",
    advice: "Ton profil est plus orienté force que l'optimal : priorité à la vitesse d'exécution (balistique, charges légères, sauts, sprints).",
  },
};

const positive = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;

/** « 4,5 » → 4.5 ; vide ou illisible → null. */
export function num(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Temps de vol (s) depuis le nombre d'images et la cadence. */
export function flightTime(frames, fps) {
  return positive(frames) && positive(fps) ? frames / fps : null;
}

/** Hauteur (m) depuis le nombre d'images en l'air : g·t²/8. */
export function jumpHeight(frames, fps) {
  const t = flightTime(frames, fps);
  return t == null ? null : (G * t * t) / 8;
}

/** Force moyenne (N), vitesse moyenne (m/s), puissance (W) de la poussée d'un
 * saut : F = M·g·(h/hPO + 1), v = √(g·h/2), M = masse du système. */
export function trialForceVelocity(bodyMass, load, height, hpo) {
  const force = (bodyMass + load) * G * (height / hpo + 1);
  const velocity = Math.sqrt((G * height) / 2);
  return { force_n: force, velocity_ms: velocity, power_w: force * velocity };
}

/** Régression F = F0 + S·v ; null si inexploitable (moins de 2 vitesses
 * distinctes, pente non négative). */
export function fitLine(points) {
  const n = points.length;
  if (n < 2) return null;
  const meanV = points.reduce((a, p) => a + p[0], 0) / n;
  const meanF = points.reduce((a, p) => a + p[1], 0) / n;
  const sxx = points.reduce((a, p) => a + (p[0] - meanV) ** 2, 0);
  if (sxx < 1e-12) return null;
  const sxy = points.reduce((a, p) => a + (p[0] - meanV) * (p[1] - meanF), 0);
  const slope = sxy / sxx;
  const intercept = meanF - slope * meanV;
  if (slope >= 0 || intercept <= 0) return null;
  const ssTot = points.reduce((a, p) => a + (p[1] - meanF) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p[1] - (intercept + slope * p[0])) ** 2, 0);
  return { F0: intercept, slope, V0: -intercept / slope, r2: ssTot > 1e-12 ? 1 - ssRes / ssTot : 1 };
}

/** Vitesse de décollage prédite (bilan travail-énergie sur hPO, force moyenne
 * F0·(1 − v̄/V0), v̄ = v_décollage / 2). */
export function takeOffVelocity(f0, v0, bodyMass, hpo) {
  if (f0 / bodyMass <= G || v0 <= 0) return null;
  const b = (f0 * hpo) / (2 * bodyMass * v0);
  return -b + Math.sqrt(b * b - 2 * (G - f0 / bodyMass) * hpo);
}

/** Profil optimal à puissance constante (F0/k, V0·k) : le k qui maximise la
 * vitesse de décollage, par section dorée (fonction unimodale). */
export function optimalProfile(f0, v0, bodyMass, hpo) {
  const kMax = f0 / (bodyMass * G);
  const kMin = 0.05;
  if (kMax <= kMin) return null;
  const tov = (k) => {
    const v = takeOffVelocity(f0 / k, v0 * k, bodyMass, hpo);
    return v == null ? -1 : v;
  };
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = kMin;
  let b = kMax * (1 - 1e-9);
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  for (let i = 0; i < 200; i++) {
    if (tov(c) > tov(d)) b = d; else a = c;
    c = b - phi * (b - a);
    d = a + phi * (b - a);
  }
  const k = (a + b) / 2;
  return { F0: f0 / k, V0: v0 * k, take_off_velocity: tov(k) };
}

/** Meilleure hauteur parmi les essais d'une charge, et toutes les hauteurs. */
export function bestHeight(attempts, fps) {
  const heights = (attempts || []).map((a) => jumpHeight(num(a && a.frames), fps)).filter((h) => h != null);
  return { best: heights.length ? Math.max(...heights) : null, heights };
}

function bestFrames(attempts) {
  const frames = (attempts || []).map((a) => num(a && a.frames)).filter((f) => positive(f));
  return frames.length ? Math.max(...frames) : null;
}

function withFrames(test, load, frames) {
  return { ...test, trials: (test.trials || []).map((t) => (t.load_kg === load ? { load_kg: t.load_kg, attempts: [{ frames }] } : t)) };
}

/** Écart-type de Pmax (W/kg) et du déséquilibre (points) dû à la lecture des
 * images : dérivée centrée (±1 image) du meilleur essai de chaque charge,
 * propagée avec FRAME_SD (indépendance entre sauts supposée). */
function uncertainty(test) {
  let varP = 0, varI = 0;
  for (const trial of test.trials || []) {
    const best = bestFrames(trial.attempts);
    if (best == null || best < 2) continue;
    const up = analyseTest(withFrames(test, trial.load_kg, best + 1), false);
    const down = analyseTest(withFrames(test, trial.load_kg, best - 1), false);
    if (!up || !down) continue;
    varP += ((up.Pmax_rel - down.Pmax_rel) / 2) ** 2;
    if (up.fv_imb_pct != null && down.fv_imb_pct != null) varI += ((up.fv_imb_pct - down.fv_imb_pct) / 2) ** 2;
  }
  return { Pmax_rel_sd: FRAME_SD * Math.sqrt(varP), fv_imb_sd: FRAME_SD * Math.sqrt(varI) };
}

/** Résultat complet d'un test, ou null si les entrées ne permettent aucun calcul. */
export function analyseTest(test, withSd = true) {
  const mass = num(test.body_mass_kg), hpo = num(test.hpo_m), fps = num(test.fps);
  if (!positive(mass) || !positive(hpo) || !positive(fps)) return null;
  const warnings = [];
  const points = [];
  for (const trial of test.trials || []) {
    const load = num(trial.load_kg);
    if (load == null || load < 0) continue;
    const { best, heights } = bestHeight(trial.attempts, fps);
    if (best == null) continue;
    const lbl = load === 0 ? "poids du corps" : `+${load % 1 ? load.toFixed(1).replace(".", ",") : load} kg`;
    if (heights.length > 1 && Math.min(...heights) < Math.max(...heights) * (1 - ATTEMPT_GAP)) warnings.push(`Essais écartés de plus de 10 % (${lbl}) : refais un essai.`);
    if (best < MIN_HEIGHT_M) warnings.push(`Hauteur sous 5 cm (${lbl}) : trop lourd pour être mesuré en images.`);
    if (Math.sqrt((8 * best) / G) > MAX_FLIGHT_S) warnings.push(`Temps de vol suspect (${lbl}) : vérifie le nombre d'images.`);
    points.push({ load_kg: load, height_m: best, attempts: heights.length, ...trialForceVelocity(mass, load, best, hpo) });
  }
  points.sort((a, b) => a.load_kg - b.load_kg);
  const fit = fitLine(points.map((p) => [p.velocity_ms, p.force_n]));
  if (!fit) return null;
  if (points.length < MIN_LOADS) warnings.push("Moins de 3 charges : le profil est très approximatif.");
  else if (points.length < RECOMMENDED_LOADS) warnings.push("4 charges ou plus rendent le profil plus fiable.");
  if (fps < LOW_FPS) warnings.push(`À ${fps} images/s la mesure est deux fois plus bruitée qu'à 240 : filme à 240 si ton téléphone le permet.`);
  if (fit.r2 < MIN_R2) warnings.push(`Les points s'alignent mal (R² ${fit.r2.toFixed(2)}) : refais les charges qui s'écartent.`);

  const f0 = fit.F0, v0 = fit.V0;
  const out = {
    date: test.date || null,
    jump: test.jump || "SJ",
    body_mass_kg: mass, hpo_m: hpo, fps,
    points, n_loads: points.length,
    F0_n: f0, F0_rel: f0 / mass, V0: v0,
    Pmax_w: (f0 * v0) / 4, Pmax_rel: (f0 * v0) / 4 / mass,
    Sfv_rel: -f0 / v0 / mass,
    r2: fit.r2,
    warnings,
  };
  const opt = optimalProfile(f0, v0, mass, hpo);
  if (!opt) {
    warnings.push("Profil optimal incalculable : F0 trop faible pour décoller, vérifie masse et images.");
    return { ...out, Sfv_opt_rel: null, fv_imb_pct: null, sfv_ratio_pct: null, orientation: null, optimal: null, Pmax_rel_sd: null, fv_imb_sd: null };
  }
  const sfvOpt = -opt.F0 / opt.V0 / mass;
  const ratio = out.Sfv_rel / sfvOpt;
  const imb = 100 * Math.abs(1 - ratio);
  // Pente plus raide (plus négative) que l'optimale = profil orienté force =
  // déficit de vitesse ; plus plate = déficit de force.
  const orientation = imb <= BALANCED_BAND_PCT ? "balanced" : ratio > 1 ? "velocity_deficit" : "force_deficit";
  const result = { ...out, Sfv_opt_rel: sfvOpt, fv_imb_pct: imb, sfv_ratio_pct: ratio * 100, orientation, optimal: opt };
  if (withSd) {
    Object.assign(result, uncertainty(test));
    if (Math.abs(imb - BALANCED_BAND_PCT) < result.fv_imb_sd) warnings.push(`Déséquilibre proche du seuil de 10 % (± ${Math.round(result.fv_imb_sd)} points de précision) : la catégorie est incertaine, confirme au prochain test.`);
  }
  return result;
}

/** Distance de poussée (m) = longueur de jambe étendue − hauteur de la crête
 * iliaque au départ (cm → m), ou null si incohérent. */
export function pushOffDistance(legLengthCm, iliacHeightCm) {
  const leg = num(legLengthCm), iliac = num(iliacHeightCm);
  if (!positive(leg) || !positive(iliac) || leg <= iliac) return null;
  return (leg - iliac) / 100;
}
