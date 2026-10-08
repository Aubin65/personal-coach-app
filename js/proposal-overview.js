// ---------- Aperçu d'une séance proposée (ADR-0103) ----------
// Les propositions du coach (squelette de semaine, ajustement de séance)
// s'affichaient en une ligne par jour : « Full body A · 8 exercices ». Pour
// juger une proposition il fallait ouvrir chaque séance. Ici : la séance en
// clair, blocs compris (superset, EMOM, circuit…), sans rien ouvrir.
import { groupExercisesIntoBlocks } from "./session/session-model.js";
import { plannedSummary } from "./session/session-render.js";
import { EXERCISE_FORMATS, SESSION_TYPES } from "./session-types.js";
import { escapeHtmlText } from "./markdown.js";

const hasPlanned = (p) => !!p && ["sets", "reps", "load"].some((k) => p[k] !== undefined && p[k] !== null && p[k] !== "");

/** « EMOM · 8 tours × 60 s », « AMRAP · 12 min »… — le minutage du bloc. */
export function blockHeaderText(leader) {
  const format = leader.format || "standard";
  const m = leader.block_meta || {};
  const label = format === "standard" ? "Superset" : (EXERCISE_FORMATS[format] || format);
  const bits = [];
  if (format === "emom") {
    if (m.rounds && m.round_seconds) bits.push(`${m.rounds} tours × ${m.round_seconds} s`);
    else if (m.rounds) bits.push(`${m.rounds} tours`);
  } else if (format === "amrap" && m.duration_min) bits.push(`${m.duration_min} min`);
  else if (format === "circuit") {
    if (m.rounds) bits.push(`${m.rounds} tours`);
    if (m.rest_seconds) bits.push(`repos ${m.rest_seconds} s`);
  } else if (format === "for_time" && m.duration_min) bits.push(`cap ${m.duration_min} min`);
  return [label, ...bits].join(" · ");
}

function stationLine(ex) {
  const planned = ex.planned;
  const detail = hasPlanned(planned) ? plannedSummary(planned) : "";
  const note = ex.notes ? `<span class="po-note">${escapeHtmlText(ex.notes)}</span>` : "";
  return `<li class="po-ex"><span class="po-name">${escapeHtmlText(ex.name || "—")}</span>${detail ? `<span class="po-detail">${escapeHtmlText(detail)}</span>` : ""}${note}</li>`;
}

/** Liste des exercices d'une séance proposée, blocs regroupés. */
export function exercisesOverviewHTML(exercises) {
  const list = Array.isArray(exercises) ? exercises : [];
  if (!list.length) return "";
  const items = groupExercisesIntoBlocks(list).map((indices) => {
    const leader = list[indices[0]];
    const standard = (leader.format || "standard") === "standard";
    if (standard && indices.length === 1) return stationLine(leader);
    // Bloc non standard sans aucune station chiffrée : le détail n'est que
    // dans les notes — on l'affiche tel quel plutôt que de le perdre.
    const members = indices.map((i) => stationLine(list[i])).join("");
    return `<li class="po-block"><div class="po-block-head">${escapeHtmlText(blockHeaderText(leader))}</div><ul class="po-list">${members}</ul></li>`;
  });
  return `<ul class="po-list">${items.join("")}</ul>`;
}

const DAY_SHORT = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** Une journée d'une proposition de semaine : séance dépliée par défaut. */
export function proposedDayHTML(date, dayIndex, d, { editable = false } = {}) {
  const t = SESSION_TYPES[d.type];
  const icon = t ? t.icon : "🏋️";
  const exercises = d.exercises || [];
  const head = `${icon} <strong>${DAY_SHORT[dayIndex]}</strong> ${date.slice(8, 10)}/${date.slice(5, 7)} — ${escapeHtmlText(d.name || "")}`;
  const edit = editable ? `<button type="button" class="icon-button small forge-proposal-edit" data-date="${date}" title="Modifier avant validation" aria-label="Modifier avant validation">✏️</button>` : "";
  if (!exercises.length) {
    return `<div class="po-day po-day-flat"><div class="po-day-head"><span>${head}</span>${edit}</div>${d.notes ? `<p class="muted small">${escapeHtmlText(d.notes)}</p>` : ""}</div>`;
  }
  return `
    <details class="po-day" open>
      <summary><span>${head}</span><span class="muted small po-count">${exercises.length} exo</span>${edit}</summary>
      ${exercisesOverviewHTML(exercises)}
      ${d.notes ? `<p class="muted small po-day-notes">${escapeHtmlText(d.notes)}</p>` : ""}
    </details>`;
}

/** Les boutons ✏️ vivent dans <summary> : ne pas replier/déplier au clic. */
export function bindProposedDayEdits(scope, onEdit) {
  scope.querySelectorAll(".forge-proposal-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onEdit(btn.dataset.date);
    });
  });
}
