// Calculs de la fiche exercice (docs/adr/0070) — fonctions pures, sans DOM
// ni réseau. `coach.exercise_history` ne fournit que les valeurs brutes
// saisies : le meilleur set et le 1RM estimé se calculent ici, aussi bien
// pour les entrées exportées que pour les séances loguées depuis.

const NUMBER = /^\d+(?:[.,]\d+)?$/;
// Au-delà, la formule d'Epley surestime le 1RM : on garde la charge seule.
const EPLEY_MAX_REPS = 10;

/** "5-5-5-4" → [5,5,5,4], "100" → [100], "10m" / "PDC" / "3x gazon" → null. */
export function parseNumberList(value) {
  if (value == null) return null;
  const parts = String(value).trim().split("-").map((p) => p.trim());
  if (!parts.length || !parts.every((p) => NUMBER.test(p))) return null;
  return parts.map((p) => Number(p.replace(",", ".")));
}

export function epleyOneRepMax(load, reps) {
  return reps <= EPLEY_MAX_REPS ? load * (1 + reps / 30) : null;
}

/** Meilleur set d'une entrée `{sets, reps, load}` — `{load, reps, e1rm}` ou
 * `null` si charge ou reps ne sont pas numériques (poids de corps, temps,
 * distance...). Appariement série par série quand les deux sont des listes,
 * la valeur unique étant reportée sur toutes les séries. */
export function topSet(entry) {
  const loads = parseNumberList(entry.load);
  const reps = parseNumberList(entry.reps);
  if (!loads || !reps) return null;
  const count = Math.max(loads.length, reps.length);
  let best = null;
  for (let i = 0; i < count; i++) {
    const load = loads[Math.min(i, loads.length - 1)];
    const r = reps[Math.min(i, reps.length - 1)];
    const e1rm = epleyOneRepMax(load, r);
    const score = e1rm ?? load;
    if (!best || score > best.score) best = { load, reps: r, e1rm, score };
  }
  return best ? { load: best.load, reps: best.reps, e1rm: best.e1rm } : null;
}

/** Points de la courbe (1RM estimé, sinon charge), meilleur set global et
 * dernière entrée d'un historique trié par date croissante. */
export function summarizeEntries(entries) {
  const withTop = entries.map((entry) => ({ entry, top: topSet(entry) }));
  const points = withTop
    .filter((x) => x.top)
    .map((x) => ({ date: x.entry.date, value: x.top.e1rm ?? x.top.load }));
  let best = null;
  for (const { entry, top } of withTop) {
    if (!top) continue;
    const score = top.e1rm ?? top.load;
    if (!best || score > best.score) best = { ...top, date: entry.date, score };
  }
  const last = withTop.length ? withTop[withTop.length - 1] : null;
  return { points, best, last, numeric: points.length > 0 };
}

const LIFT_KEYS = {
  "back squat": "back_squat",
  squat: "back_squat",
  bench: "bench",
  "bench press": "bench",
  "développé couché": "bench",
  "trap bar deadlift": "trap_bar_deadlift",
};

/** Clé de `strength_trajectory` pour un des trois mouvements de référence. */
export function liftTargetKey(name) {
  return LIFT_KEYS[String(name || "").trim().toLowerCase()] || null;
}

export function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

export function formatNumber(n) {
  const rounded = Math.round(n * 10) / 10;
  return String(rounded).replace(".", ",");
}
