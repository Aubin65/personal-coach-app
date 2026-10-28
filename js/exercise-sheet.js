import { ghGetFile, ghListDir } from "./github-api.js";
import { todayISO } from "./date-utils.js";
import { escapeHtmlText } from "./markdown.js";
import { openSheet } from "./sheet.js";
import { sparklineSVG, shortDateFr } from "./views/data-viz.js";
import { summarizeEntries, liftTargetKey, normalizeName, formatNumber } from "./exercise-stats.js";
import { MACHINES, cardioStats, headlineMetric, totalsLine, fmtDuration, fmtShortDuration } from "./cardio.js";

// ============================================================================
// Fiche exercice (docs/adr/0070) — dernière séance, record, cible et courbe
// d'un exercice, ouverte depuis la séance. Données : `exercise_history` du
// résumé exporté (10 dernières entrées) complété par les séances loguées
// depuis cet export (data/training/app-log/), pour qu'une séance faite ce
// matin y soit déjà.
// ============================================================================

const SUMMARY_TTL_MS = 5 * 60 * 1000;
let summaryCache = null;

async function loadSummary() {
  if (summaryCache && Date.now() - summaryCache.at < SUMMARY_TTL_MS) return summaryCache.summary;
  const file = await ghGetFile("data/app/summary.json");
  const summary = file ? JSON.parse(file.content) : {};
  summaryCache = { at: Date.now(), summary };
  return summary;
}

function entryFromExercise(date, exercise) {
  if (exercise.format === "cardio") return null; // historique cardio à part (ADR-0112)
  const executed = exercise.executed || {};
  const entry = { date, sets: executed.sets ?? null, reps: executed.reps ?? null, load: executed.load ?? null };
  if ([entry.sets, entry.reps, entry.load].every((v) => v == null || v === "")) return null;
  if (exercise.rir != null && exercise.rir !== "") entry.rir = exercise.rir;
  if (executed.load_per_hand) entry.per_hand = true;
  return entry;
}

async function liveEntriesSince(sinceDate, name) {
  const today = todayISO();
  const listing = await ghListDir("data/training/app-log");
  const dates = listing
    .filter((e) => e.type === "file" && e.name.endsWith(".json"))
    .map((e) => e.name.slice(0, -5))
    .filter((d) => d >= sinceDate && d <= today);
  const entries = [];
  for (const date of dates) {
    const file = await ghGetFile(`data/training/app-log/${date}.json`);
    if (!file) continue;
    let week;
    try { week = JSON.parse(file.content); } catch (_) { continue; }
    for (const session of week.sessions || []) {
      if (session.date !== date) continue;
      for (const exercise of session.exercises || []) {
        if (normalizeName(exercise.name) !== name) continue;
        const entry = entryFromExercise(date, exercise);
        if (entry) entries.push(entry);
      }
    }
  }
  return entries;
}

/** Entrées de l'exercice, anciennes d'abord : export + séances récentes
 * (celles-ci l'emportent sur l'export pour une même date). */
export async function loadExerciseEntries(rawName) {
  const name = normalizeName(rawName);
  const summary = await loadSummary();
  const histories = summary.exercise_history || {};
  const key = Object.keys(histories).find((k) => normalizeName(k) === name);
  const exported = key ? histories[key] : [];
  const sinceDate = (summary.generated_at || "").slice(0, 10) || "0000-00-00";
  let live = [];
  try { live = await liveEntriesSince(sinceDate, name); } catch (_) { /* hors-ligne : l'export suffit */ }
  const byDate = new Map(exported.map((e) => [e.date, e]));
  live.forEach((e) => byDate.set(e.date, e));
  return { entries: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), summary };
}

function describeEntry(entry) {
  const parts = [];
  if (entry.sets != null && entry.reps != null) parts.push(`${entry.sets} × ${entry.reps}`);
  else if (entry.reps != null) parts.push(`${entry.reps} reps`);
  else if (entry.sets != null) parts.push(`${entry.sets} séries`);
  if (entry.load != null && entry.load !== "") parts.push(`@ ${String(entry.load).replace(".", ",")}${/^[\d.,/-]+$/.test(String(entry.load)) ? " kg" : ""}${entry.per_hand ? " par main" : ""}`);
  if (entry.rir != null) parts.push(`RIR ${entry.rir}`);
  return escapeHtmlText(parts.join(" "));
}

function targetHTML(name, summary, stats) {
  const key = liftTargetKey(name);
  const target = key && summary.strength_trajectory && summary.strength_trajectory[key] && summary.strength_trajectory[key].target;
  if (!target || !target.four_rm) return "";
  if (key === "chin_up") {
    // Cible en lest (kg ajoutés au poids du corps), ADR-0109.
    return `<li><span class="exercise-sheet-label">Cible (lest, 4 reps)</span><span>${formatNumber(target.four_rm)} kg de lest</span></li>`;
  }
  const fourRm = target.four_rm;
  const top = stats.last && stats.last.top;
  const pct = top && top.reps >= 4 ? Math.round((top.load / fourRm) * 100) : null;
  return `<li><span class="exercise-sheet-label">Cible (4 reps)</span><span>${formatNumber(fourRm)} kg${pct != null ? ` — dernière séance à ${pct} %` : ""}</span></li>`;
}

function sheetBodyHTML(name, entries, summary) {
  if (!entries.length) {
    return `<h2>📈 ${escapeHtmlText(name)}</h2><p class="muted">Aucune performance enregistrée pour cet exercice pour l'instant.</p>`;
  }
  const stats = summarizeEntries(entries);
  const last = entries[entries.length - 1];
  const chart = stats.points.length >= 2 ? sparklineSVG(stats.points, { axis: true }) : "";
  const rows = entries
    .slice(-6)
    .reverse()
    .map((e) => `<li><span class="exercise-sheet-label">${shortDateFr(e.date)}</span><span>${describeEntry(e)}</span></li>`)
    .join("");
  const bestRow = stats.best
    ? `<li><span class="exercise-sheet-label">Record</span><span>${formatNumber(stats.best.load)} kg × ${stats.best.reps}${stats.best.e1rm ? ` — 1RM estimé ${formatNumber(stats.best.e1rm)} kg` : ""} (${shortDateFr(stats.best.date)})</span></li>`
    : "";
  return `
    <h2>📈 ${escapeHtmlText(name)}</h2>
    <ul class="exercise-sheet-facts">
      <li><span class="exercise-sheet-label">Dernière fois</span><span>${shortDateFr(last.date)} — ${describeEntry(last)}</span></li>
      ${bestRow}
      ${targetHTML(name, summary, stats)}
    </ul>
    ${chart ? `<p class="muted small exercise-sheet-chart-title">${stats.best && stats.best.e1rm ? "1RM estimé" : "Charge"} par séance</p>${chart}` : ""}
    <h3 class="exercise-sheet-subtitle">Dernières séances</h3>
    <ul class="exercise-sheet-facts">${rows}</ul>`;
}

// ---------------------------------------------------------------- Cardio (ADR-0112)

/** Séances cardio de l'exercice depuis l'export (app-log), mêmes indicateurs
 * que `summary.cardio_history` (coach.cardio). */
async function liveCardioSince(sinceDate, name) {
  const today = todayISO();
  const listing = await ghListDir("data/training/app-log");
  const dates = listing.filter((e) => e.type === "file" && e.name.endsWith(".json")).map((e) => e.name.slice(0, -5)).filter((d) => d >= sinceDate && d <= today);
  const rows = [];
  for (const date of dates) {
    const file = await ghGetFile(`data/training/app-log/${date}.json`);
    if (!file) continue;
    let week;
    try { week = JSON.parse(file.content); } catch (_) { continue; }
    for (const session of week.sessions || []) {
      if (session.date !== date) continue;
      for (const ex of session.exercises || []) {
        if (ex.format !== "cardio" || normalizeName(ex.name) !== name) continue;
        const st = cardioStats(ex);
        if (st.rounds) rows.push({ date, machine: ex.machine, work_s: (ex.planned || {}).work_s ?? null, rest_s: (ex.planned || {}).rest_s ?? null, ...st });
      }
    }
  }
  return rows;
}

export async function loadCardioEntries(rawName) {
  const name = normalizeName(rawName);
  const summary = await loadSummary();
  const hist = summary.cardio_history || {};
  const key = Object.keys(hist).find((k) => normalizeName(k) === name);
  const sinceDate = (summary.generated_at || "").slice(0, 10) || "0000-00-00";
  let live = [];
  try { live = await liveCardioSince(sinceDate, name); } catch (_) { /* hors-ligne */ }
  const byDate = new Map((key ? hist[key] : []).map((r) => [r.date, r]));
  live.forEach((r) => byDate.set(r.date, r));
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Valeur suivie d'une séance : allure aux 500 m (plus bas = mieux) pour le
 * rameur/SkiErg, cal/min sinon (plus haut = mieux). */
export function cardioMetric(row) {
  const m = MACHINES[row.machine] || {};
  if (m.pace && row.pace_500_s) return { value: row.pace_500_s, lowerIsBetter: true, label: "Allure aux 500 m", fmt: (v) => `${fmtDuration(v)} /500 m`, short: (v) => fmtDuration(v) };
  if (row.cal_per_min) return { value: row.cal_per_min, lowerIsBetter: false, label: "Calories par minute", fmt: (v) => `${v.toFixed(1).replace(".", ",")} cal/min`, short: (v) => v.toFixed(1).replace(".", ",") };
  if (row.speed_kmh) return { value: row.speed_kmh, lowerIsBetter: false, label: "Vitesse", fmt: (v) => `${v.toFixed(1).replace(".", ",")} km/h`, short: (v) => v.toFixed(1).replace(".", ",") };
  if (row.pace_500_s) return { value: row.pace_500_s, lowerIsBetter: true, label: "Allure aux 500 m", fmt: (v) => `${fmtDuration(v)} /500 m`, short: (v) => fmtDuration(v) };
  return null;
}

function cardioRowText(r) {
  const plan = r.work_s ? `${r.rounds > 1 ? `${r.rounds} × ` : ""}${fmtShortDuration(r.work_s)}` : "";
  return [plan, totalsLine(r).replace(/^\d+ rounds? · /, ""), headlineMetric(r.machine, r)].filter(Boolean).join(" · ");
}

function cardioSheetHTML(name, rows) {
  const last = rows[rows.length - 1];
  const scored = rows.map((r) => ({ r, m: cardioMetric(r) })).filter((x) => x.m);
  const best = scored.length ? scored.reduce((a, b) => (a.m.lowerIsBetter ? (b.m.value < a.m.value ? b : a) : (b.m.value > a.m.value ? b : a))) : null;
  const chart = scored.length >= 2 ? sparklineSVG(scored.map((x) => ({ date: x.r.date, value: x.m.value })), { axis: true, invert: scored[0].m.lowerIsBetter, fmt: scored[0].m.short }) : "";
  const list = rows.slice(-6).reverse().map((r) => `<li><span class="exercise-sheet-label">${shortDateFr(r.date)}</span><span>${escapeHtmlText(cardioRowText(r))}</span></li>`).join("");
  return `
    <h2>📈 ${escapeHtmlText(name)}</h2>
    <ul class="exercise-sheet-facts">
      <li><span class="exercise-sheet-label">Dernière fois</span><span>${shortDateFr(last.date)} — ${escapeHtmlText(cardioRowText(last))}</span></li>
      ${best ? `<li><span class="exercise-sheet-label">Meilleure séance</span><span>${escapeHtmlText(best.m.fmt(best.m.value))} (${shortDateFr(best.r.date)})</span></li>` : ""}
    </ul>
    ${chart ? `<p class="muted small exercise-sheet-chart-title">${escapeHtmlText(best.m.label)} par séance — ${best.m.lowerIsBetter ? "plus bas = mieux" : "plus haut = mieux"}</p>${chart}` : ""}
    <h3 class="exercise-sheet-subtitle">Dernières séances</h3>
    <ul class="exercise-sheet-facts">${list}</ul>`;
}

export async function openExerciseSheet(rawName) {
  const name = String(rawName || "").trim();
  if (!name) return;
  const { el } = openSheet(`<div class="exercise-sheet-content"><h2>📈 ${escapeHtmlText(name)}</h2><p class="muted small">Chargement…</p></div>`);
  const content = el.querySelector(".exercise-sheet-content");
  try {
    const cardioRows = await loadCardioEntries(name);
    if (cardioRows.length) { content.innerHTML = cardioSheetHTML(name, cardioRows); return; }
    const { entries, summary } = await loadExerciseEntries(name);
    content.innerHTML = sheetBodyHTML(name, entries, summary);
  } catch (err) {
    content.innerHTML = `<h2>📈 ${escapeHtmlText(name)}</h2><p class="error-text">Impossible de charger l'historique : ${escapeHtmlText(err.message)}</p>`;
  }
}

