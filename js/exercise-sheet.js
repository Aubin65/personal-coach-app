import { ghGetFile, ghListDir } from "./github-api.js";
import { todayISO } from "./date-utils.js";
import { escapeHtmlText } from "./markdown.js";
import { openSheet } from "./sheet.js";
import { sparklineSVG, shortDateFr } from "./views/data-viz.js";
import { summarizeEntries, liftTargetKey, normalizeName, formatNumber } from "./exercise-stats.js";

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

export async function openExerciseSheet(rawName) {
  const name = String(rawName || "").trim();
  if (!name) return;
  const { el } = openSheet(`<div class="exercise-sheet-content"><h2>📈 ${escapeHtmlText(name)}</h2><p class="muted small">Chargement…</p></div>`);
  const content = el.querySelector(".exercise-sheet-content");
  try {
    const { entries, summary } = await loadExerciseEntries(name);
    content.innerHTML = sheetBodyHTML(name, entries, summary);
  } catch (err) {
    content.innerHTML = `<h2>📈 ${escapeHtmlText(name)}</h2><p class="error-text">Impossible de charger l'historique : ${escapeHtmlText(err.message)}</p>`;
  }
}

