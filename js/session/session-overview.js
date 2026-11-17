import { escapeHtmlText } from "../markdown.js";
import { EXERCISE_FORMATS } from "../session-types.js";
import { groupExercisesIntoBlocks } from "./session-model.js";
import { hydrateExecRows } from "./session-exec.js";
import { cardioPrescription, cardioDone, cardioRoundsDone } from "../cardio.js";
import { blockResultText } from "../plan-overview.js";

// ============================================================================
// Aperçu de la séance (docs/adr/0122) : un tableau compact « exercice / prévu /
// fait » en tête du détail, pour voir toute la séance sans défiler les fiches ;
// un tap sur une ligne saute à la fiche. Pas de saisie ici — la saisie reste
// dans les fiches et dans le mode guidé.
// ============================================================================

const OPEN_KEY = "coach.sessionOverview";

const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const kg = (v) => (/^[\d.,]+$/.test(String(v)) ? `${v} kg` : String(v));

/** « 4 × 4 · 102,5 kg /main » (vide si rien n'est prévu). */
export function plannedText(planned = {}) {
  const sets = planned.sets ?? "";
  const reps = planned.reps ?? "";
  const load = planned.load ?? "";
  const head = sets !== "" && reps !== "" ? `${sets} × ${reps}` : sets !== "" ? `${sets} séries` : String(reps);
  const loadText = load === "" || load === null ? "" : kg(load) + (planned.load_per_hand ? " /main" : "");
  return [head, loadText].filter(Boolean).join(" · ");
}

/** Réalisé d'un exercice standard : `{text, state}` (state : "" | "partial" | "done"). */
export function doneInfo(ex) {
  if (ex.format === "cardio") {
    const n = cardioRoundsDone(ex);
    const target = num((ex.planned || {}).sets);
    if (!cardioDone(ex)) return { text: "—", state: "" };
    return { text: target ? `${n}/${target}` : "✓", state: target && n < target ? "partial" : "done" };
  }
  const rows = hydrateExecRows(ex.executed || {}, ex.rir).filter((r) => String(r.reps || "").trim() || String(r.load || "").trim());
  if (!rows.length) return { text: "—", state: "" };
  const target = num((ex.planned || {}).sets);
  const loads = rows.map((r) => num(r.load)).filter((n) => n !== null);
  const top = loads.length ? String(Math.max(...loads)).replace(".", ",") : "";
  const count = target ? `${rows.length}/${target}` : `${rows.length} s.`;
  return { text: top ? `${count} · ${top}` : count, state: target && rows.length < target ? "partial" : "done" };
}

function blockLabel(format, leader) {
  const meta = leader.block_meta || {};
  const bits = [];
  if (format === "amrap" && meta.duration_min) bits.push(`${meta.duration_min} min`);
  if (format === "emom" && meta.rounds) bits.push(`${meta.rounds} × ${meta.round_seconds || 60} s`);
  if (format === "circuit" && meta.rounds) bits.push(`${meta.rounds} tours`);
  if (format === "for_time" && meta.time_cap_min) bits.push(`cap ${meta.time_cap_min} min`);
  return [format === "standard" ? "Superset" : EXERCISE_FORMATS[format] || "Bloc", ...bits].join(" · ");
}

/** Lignes du tableau : `{kind: "head"|"row", idx?, label, planned, done, state}`. */
export function overviewRows(session) {
  const exercises = session.exercises || [];
  const rows = [];
  groupExercisesIntoBlocks(exercises).forEach((indices, b) => {
    const leader = exercises[indices[0]];
    const format = leader.format || "standard";
    const chained = indices.length > 1;
    if (format === "cardio" && !chained) {
      const d = doneInfo(leader);
      rows.push({ kind: "row", idx: indices[0], label: leader.name || "Cardio", planned: cardioPrescription(leader), done: d.text, state: d.state });
      return;
    }
    if (format === "standard" && !chained) {
      const d = doneInfo(leader);
      rows.push({ kind: "row", idx: indices[0], label: leader.name || "Exercice", planned: plannedText(leader.planned), done: d.text, state: d.state });
      return;
    }
    const result = blockResultText(format, leader);
    rows.push({ kind: "head", idx: indices[0], label: blockLabel(format, leader), done: result ? "✓" : "", state: result ? "done" : "" });
    indices.forEach((idx, n) => {
      const ex = exercises[idx];
      const station = format === "standard";
      const d = station ? doneInfo(ex) : { text: "", state: "" };
      const planned = station ? plannedText(ex.planned) : [ex.planned?.reps, ex.planned?.load ? kg(ex.planned.load) : ""].filter(Boolean).join(" · ");
      rows.push({ kind: "row", idx, label: `${String.fromCharCode(97 + n)}. ${ex.name || "Exercice"}`, planned, done: d.text, state: d.state, sub: true });
    });
  });
  return rows;
}

function rowsHTML(rows) {
  return rows.map((r) => r.kind === "head"
    ? `<tr class="ov-head" data-ov-idx="${r.idx}"><td colspan="2">${escapeHtmlText(r.label)}</td><td class="ov-done ${r.state}">${escapeHtmlText(r.done)}</td></tr>`
    : `<tr class="ov-row${r.sub ? " ov-sub" : ""}" data-ov-idx="${r.idx}" tabindex="0"><td class="ov-name">${escapeHtmlText(r.label)}</td><td class="ov-plan">${escapeHtmlText(r.planned || "—")}</td><td class="ov-done ${r.state}">${escapeHtmlText(r.done)}</td></tr>`).join("");
}

function isOpen() { try { return localStorage.getItem(OPEN_KEY) !== "closed"; } catch (_) { return true; } }

/** Carte « Aperçu de la séance » (HTML), ou "" s'il n'y a pas d'exercice. */
export function overviewHTML(session) {
  const rows = overviewRows(session);
  if (!rows.some((r) => r.kind === "row")) return "";
  return `<details class="card session-overview"${isOpen() ? " open" : ""}>
    <summary><strong>Aperçu de la séance</strong> <span class="muted small">${rows.filter((r) => r.kind === "row").length} exercices</span></summary>
    <table class="ov-table"><thead><tr><th>Exercice</th><th>Prévu</th><th>Fait</th></tr></thead><tbody>${rowsHTML(rows)}</tbody></table>
  </details>`;
}

/** Branche le tap (saut à la fiche), la mémoire ouvert/fermé et le rafraîchissement
 * du « fait » quand la saisie change. `getSession` : séance de travail courante. */
export function wireOverview(root, getSession) {
  const card = root.querySelector(".session-overview");
  if (!card) return;
  card.addEventListener("toggle", () => { try { localStorage.setItem(OPEN_KEY, card.open ? "open" : "closed"); } catch (_) { /* stockage indisponible */ } });
  const jump = (tr) => {
    const target = root.querySelector(`#exercise-list [data-idx="${tr.dataset.ovIdx}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("ov-flash");
    setTimeout(() => target.classList.remove("ov-flash"), 1400);
  };
  card.querySelector("tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-ov-idx]"); if (tr) jump(tr); });
  card.querySelector("tbody").addEventListener("keydown", (e) => { if (e.key === "Enter") { const tr = e.target.closest("tr[data-ov-idx]"); if (tr) jump(tr); } });
  const list = root.querySelector("#exercise-list");
  if (list) list.addEventListener("change", () => {
    // Après la synchro habituelle du formulaire (ses propres écouteurs passent avant).
    setTimeout(() => { const s = getSession(); if (s) card.querySelector("tbody").innerHTML = rowsHTML(overviewRows(s)); }, 0);
  });
}
