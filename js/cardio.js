// ============================================================================
// Exercices cardio sur machine (docs/adr/0112) — rameur, SkiErg, Assault Bike,
// vélo. Module pur (aucun DOM, aucun import) partagé par le formulaire de
// séance, le mode guidé, la fiche exercice et Progrès. Même calcul côté Python
// (`coach.cardio`), à garder aligné.
//
// Modèle (exercice `format: "cardio"`) :
//   machine: "rameur" | "skierg" | "assault_bike" | "velo"
//   planned:  { sets: rounds, reps: "4 min" (texte lisible), load: null,
//               work_s, rest_s, target (texte libre, ex. « 171-181 bpm »),
//               block_size?, block_rest_s? — rounds groupés en séries, avec un
//               repos plus long entre séries (ex. 2 × 6 × 20 s, 3 min entre) }
//   executed: { sets: rounds faits, reps: null, load: null,
//               intervals: [{ time_s, distance_m, cal, hr_avg? }],
//               total_time_s, total_distance_m, total_cal }
// La FC est facultative (elle est sur la montre) : jamais requise.
// ============================================================================

export const MACHINES = {
  rameur: { label: "Rameur", icon: "🚣", pace: true },
  skierg: { label: "SkiErg", icon: "⛷️", pace: true },
  assault_bike: { label: "Assault Bike", icon: "🚴", pace: false },
  velo: { label: "Vélo", icon: "🚲", pace: false },
};

/** Machine probable d'après le nom saisi (« Rameur 4×4 », « Assault Bike… »). */
export function guessMachine(name) {
  const n = String(name || "").toLowerCase();
  if (/ski\s*-?erg/.test(n)) return "skierg";
  if (/assault|air ?bike|echo bike/.test(n)) return "assault_bike";
  if (/rameur|row(er|ing)?\b|aviron|concept ?2/.test(n)) return "rameur";
  if (/v[ée]lo|bike|cycl/.test(n)) return "velo";
  return null;
}

/** Secondes depuis « 4:00 », « 4'30 », « 1:02:00 », « 240 », « 4 min », « 20 s ». */
export function parseDuration(text) {
  if (text == null) return null;
  if (typeof text === "number") return Number.isFinite(text) && text >= 0 ? Math.round(text) : null;
  const t = String(text).trim().toLowerCase().replace(",", ".");
  if (!t) return null;
  let m = t.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = t.match(/^(\d+)\s*[:'’]\s*(\d{1,2})\s*(?:"|'')?$/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:min|mn|m)$/);
  if (m) return Math.round(+m[1] * 60);
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secondes?)?$/);
  if (m) return Math.round(+m[1]);
  return null;
}

/** 240 → « 4:00 » ; 3725 → « 1:02:05 ». */
export function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Libellé court d'une durée prescrite : 240 → « 4 min », 20 → « 20 s », 90 → « 1:30 ». */
export function fmtShortDuration(seconds) {
  if (seconds == null) return "";
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  if (seconds < 60) return `${seconds} s`;
  return fmtDuration(seconds);
}

export function num(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Prévu par défaut d'une machine (le 4×4 au rameur/SkiErg, 2 × 6 × 20 s sinon). */
export function defaultCardioPlanned(machine) {
  if (machine === "assault_bike") return { sets: 12, reps: "20 s", load: null, work_s: 20, rest_s: 40, target: "", block_size: 6, block_rest_s: 180 };
  if (machine === "velo") return { sets: 1, reps: "30 min", load: null, work_s: 1800, rest_s: 0, target: "" };
  return { sets: 4, reps: "4 min", load: null, work_s: 240, rest_s: 180, target: "" };
}

/** « 4 × 4 min · repos 3 min · 171-181 bpm ». */
export function cardioPrescription(ex) {
  const p = (ex && ex.planned) || {};
  const rounds = num(p.sets);
  const work = num(p.work_s);
  const rest = num(p.rest_s);
  const block = blockSize(p);
  const series = block && rounds ? Math.ceil(rounds / block) : null;
  const head = rounds && work
    ? (series > 1 ? `${series} × ${block} × ${fmtShortDuration(work)}` : `${rounds > 1 ? `${rounds} × ` : ""}${fmtShortDuration(work)}`)
    : (p.reps ? String(p.reps) : "");
  return [
    head,
    rest ? `repos ${fmtShortDuration(rest)}` : "",
    series > 1 && num(p.block_rest_s) ? `${fmtShortDuration(num(p.block_rest_s))} entre séries` : "",
    p.target || "",
  ].filter(Boolean).join(" · ");
}

/** Rounds par série (null si les rounds ne sont pas groupés). */
export function blockSize(planned) {
  const b = num((planned || {}).block_size);
  const rounds = num((planned || {}).sets);
  return b && b > 0 && rounds && b < rounds ? Math.round(b) : null;
}

/** Repos après le round `round` (1-based) : repos de série en fin de série,
 * repos normal sinon. */
export function restAfter(planned, round) {
  const b = blockSize(planned);
  const blockRest = num((planned || {}).block_rest_s);
  if (b && blockRest != null && round % b === 0) return blockRest;
  return num((planned || {}).rest_s) || 0;
}

/** Intervalles réellement renseignés (au moins un chiffre). */
export function filledIntervals(executed) {
  return ((executed && executed.intervals) || []).filter((r) => r && ["time_s", "distance_m", "cal", "hr_avg"].some((k) => num(r[k]) != null));
}

/** Totaux et indicateurs d'une séance : allure /500 m (rameur, SkiErg), cal/min,
 * vitesse (vélo), FC moyenne si saisie. Le temps d'un round manquant vaut le
 * temps prescrit (on ne saisit pas « 4:00 » à chaque fois). */
export function cardioStats(ex) {
  const planned = (ex && ex.planned) || {};
  const rows = filledIntervals(ex && ex.executed);
  const work = num(planned.work_s);
  let time = 0, dist = 0, cal = 0, distTime = 0, calTime = 0;
  const hrs = [];
  let hasDist = false, hasCal = false;
  for (const r of rows) {
    const t = num(r.time_s) ?? work ?? 0;
    time += t;
    const d = num(r.distance_m);
    const c = num(r.cal);
    if (d != null) { dist += d; distTime += t; hasDist = true; }
    if (c != null) { cal += c; calTime += t; hasCal = true; }
    const h = num(r.hr_avg);
    if (h != null) hrs.push(h);
  }
  return {
    rounds: rows.length,
    time_s: rows.length ? time : null,
    distance_m: hasDist ? dist : null,
    cal: hasCal ? cal : null,
    pace_500_s: hasDist && dist > 0 && distTime > 0 ? (distTime / dist) * 500 : null,
    cal_per_min: hasCal && calTime > 0 ? cal / (calTime / 60) : null,
    speed_kmh: hasDist && distTime > 0 ? (dist / 1000) / (distTime / 3600) : null,
    hr_avg: hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null,
  };
}

/** Indicateur principal d'une machine, en texte : allure aux 500 m pour le
 * rameur/SkiErg, cal/min pour l'Assault Bike, vitesse ou cal/min pour le vélo. */
export function headlineMetric(machine, stats) {
  if (!stats) return "";
  const m = MACHINES[machine] || {};
  if (m.pace && stats.pace_500_s) return `${fmtDuration(stats.pace_500_s)} /500 m`;
  if (machine === "velo" && stats.speed_kmh) return `${stats.speed_kmh.toFixed(1).replace(".", ",")} km/h`;
  if (stats.cal_per_min) return `${stats.cal_per_min.toFixed(1).replace(".", ",")} cal/min`;
  if (stats.pace_500_s) return `${fmtDuration(stats.pace_500_s)} /500 m`;
  return "";
}

/** Totaux en une ligne : « 4 rounds · 16:00 · 4 120 m · 248 cal ». */
export function totalsLine(stats) {
  if (!stats || !stats.rounds) return "";
  return [
    `${stats.rounds} round${stats.rounds > 1 ? "s" : ""}`,
    stats.time_s ? fmtDuration(stats.time_s) : "",
    stats.distance_m != null ? `${Math.round(stats.distance_m).toLocaleString("fr-FR")} m` : "",
    stats.cal != null ? `${Math.round(stats.cal)} cal` : "",
    stats.hr_avg != null ? `FC ${Math.round(stats.hr_avg)}` : "",
  ].filter(Boolean).join(" · ");
}

/** Ré-écrit `executed` à partir des lignes saisies (totaux recalculés). */
export function writeCardioExecuted(ex, intervals) {
  const clean = (intervals || []).map((r) => ({
    time_s: num(r.time_s),
    distance_m: num(r.distance_m),
    cal: num(r.cal),
    ...(num(r.hr_avg) != null ? { hr_avg: num(r.hr_avg) } : {}),
  }));
  const tmp = { ...ex, executed: { intervals: clean } };
  const filled = filledIntervals(tmp.executed);
  const stats = cardioStats(tmp);
  ex.executed = {
    sets: filled.length ? String(filled.length) : null,
    reps: null,
    load: null,
    intervals: clean,
    total_time_s: stats.time_s,
    total_distance_m: stats.distance_m,
    total_cal: stats.cal,
  };
  ex.rir = null;
  return ex.executed;
}

/** Transforme un exercice en exercice cardio (garde le nom et les notes). */
export function makeCardio(ex, machine) {
  const m = machine || guessMachine(ex.name) || "rameur";
  ex.format = "cardio";
  ex.machine = m;
  ex.superset_with_previous = false;
  delete ex.block_meta;
  const p = ex.planned || {};
  if (!num(p.work_s)) ex.planned = defaultCardioPlanned(m);
  if (!ex.name || !ex.name.trim()) ex.name = MACHINES[m].label;
  if (!ex.executed || !Array.isArray(ex.executed.intervals)) ex.executed = { sets: null, reps: null, load: null, intervals: [] };
  return ex;
}
