import { sessionRuntime } from "./session-state.js";
import { state, stale } from "../nav.js";
import { todayISO, formatFrDate, sessionIsBlankSkeleton } from "../date-utils.js";
import { skeletonHTML, escapeAttr, escapeHtmlText } from "../markdown.js";
import { findSessionForDate } from "../training-index.js";
import { SESSION_TYPES, EXERCISE_FORMATS, BLOCK_TIMING_FIELDS, BLOCK_RESULT_LABELS } from "../session-types.js";
import { blankSession, groupExercisesIntoBlocks } from "./session-model.js";
import { splitTimerHTML, timerBarHTML, startTimerDisplayInterval, startSessionAutoSave, startBlockTimerIntervals } from "./session-timer.js";
import { workloadSectionHTML, secondarySessionSectionHTML, bindSessionContentEvents } from "./session-form.js";
import { execRowsHTML, hydrateExecRows } from "./session-exec.js";

// ---------- Session detail : voir/loguer/planifier n'importe quelle date ----------
// Reachable from Aujourd'hui ("Loguer la séance", aujourd'hui), un jour du
// day-strip Semaine, une case de Forge (n'importe quelle semaine), ou une
// entrée d'Historique.
export async function renderSession(token) {
  const date = state.sessionDate || todayISO();
  document.getElementById("topbar-title").textContent = `Séance — ${formatFrDate(date)}`;
  document.getElementById("session-content").innerHTML = skeletonHTML();

  const found = await findSessionForDate(date);
  if (stale(token)) return;
  // A day tapped "✏️" from a pending Forge skeleton proposal (see
  // loadForgePendingSkeleton) prefills here as an editable draft — nothing
  // is written until "Enregistrer la séance", same as any other new
  // session. Applies whenever the date has no real content yet — no
  // session at all, or just a quick-typed placeholder (sessionIsBlankSkeleton) —
  // real content on the date always wins over the draft. Consumed once.
  const draft = state.forgePrefillDraft;
  state.forgePrefillDraft = null;
  const useDraft = draft && draft.date === date && sessionIsBlankSkeleton(found.session);
  sessionRuntime.working = {
    weekLabel: found.weekLabel || "app",
    date,
    session: useDraft
      ? JSON.parse(JSON.stringify(draft.session))
      : found.session ? JSON.parse(JSON.stringify(found.session)) : null,
  };
  renderSessionContent();
}

export function renderSessionContent() {
  const el = document.getElementById("session-content");
  const { session, date } = sessionRuntime.working;

  if (!session) {
    el.innerHTML = `
      <section class="card">
        <p class="muted">Pas de séance enregistrée pour le ${formatFrDate(date)}.</p>
        <p class="muted small">Quel type de séance ?</p>
        <div class="type-picker">
          ${Object.entries(SESSION_TYPES)
            .map(([key, t]) => `<button type="button" class="action-button" data-type="${key}"><span class="action-icon">${t.icon}</span>${t.label}</button>`)
            .join("")}
        </div>
      </section>`;
    el.querySelectorAll(".type-picker [data-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        sessionRuntime.working.session = blankSession(date, btn.dataset.type);
        renderSessionContent();
      });
    });
    return;
  }

  const type = session.type || "musculation";
  el.innerHTML = `
    <section class="card">
      <div class="session-type-badge">${SESSION_TYPES[type] ? SESSION_TYPES[type].icon : ""} ${SESSION_TYPES[type] ? SESSION_TYPES[type].label : type}</div>
      <label>Nom de la séance</label>
      <input id="session-name-input" value="${escapeAttr(session.name || "Séance")}">
    </section>
    ${timerBarHTML(date)}
    ${type === "musculation" ? musculationBodyHTML(session) : ""}
    <section class="card">
      <label>${notesLabelFor(type)}</label>
      <textarea id="session-notes" rows="${type === "musculation" ? 3 : 5}" placeholder="${escapeAttr(notesPlaceholderFor(type))}">${escapeHtmlText(session.notes || "")}</textarea>
      ${type === "autre" ? `<label>Distance (km, facultatif)</label><input type="text" id="session-distance" value="${escapeAttr(session.distance_km ?? "")}">` : ""}
    </section>
    ${workloadSectionHTML(session)}
    ${secondarySessionSectionHTML(session)}
    <button id="save-session" class="primary-button">Enregistrer la séance</button>
    <p id="session-status" class="muted small"></p>`;

  bindSessionContentEvents();
  startTimerDisplayInterval();
  startSessionAutoSave();
  startBlockTimerIntervals();
}

export function notesLabelFor(type) {
  if (type === "rugby") return "Comment ça s'est passé ? (facultatif)";
  if (type === "autre") return "Description (facultatif)";
  if (type === "repos") return "Note (facultatif)";
  return "📝 Note de séance (facultatif — ex. \"volume réduit, épaule un peu sensible\")";
}
export function notesPlaceholderFor(type) {
  if (type === "rugby") return "Ressenti, intensité, contact, fatigue...";
  if (type === "autre") return "Où, combien de temps, ressenti...";
  if (type === "repos") return "Étirements, ressenti, sommeil...";
  return "";
}

function musculationBodyHTML(session) {
  const exercises = session.exercises || [];
  const blocks = groupExercisesIntoBlocks(exercises);
  return `
    <section class="card">
      <button type="button" id="toggle-block-ref" class="details-toggle">🎯 Objectifs du bloc en cours</button>
      <div id="block-ref-content" class="markdown-body small" hidden></div>
    </section>
    <section class="card">
      <button type="button" id="prefill-button" class="primary-button ghost small">🔁 Dupliquer une séance récente</button>
      <div id="prefill-picker" hidden></div>
    </section>
    <div id="exercise-list">${blocks.map((indices) => blockCardHTML(indices, exercises)).join("")}</div>
    <div class="add-block-row">
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="standard">+ Exercice</button>
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="superset">+ Superset</button>
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="amrap">+ AMRAP</button>
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="emom">+ EMOM</button>
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="circuit">+ Circuit</button>
    </div>`;
}

/** One block = one leader exercise (`indices[0]`) plus its chained
 * members (see `groupExercisesIntoBlocks`). A solo standard exercise
 * renders exactly as before (no block chrome at all — the common case
 * stays visually unchanged); anything else — a superset (≥2 standard
 * members) or an AMRAP/EMOM/Circuit/For Time/Autre block, chained or
 * solo — gets a shared header (format switch + block-level timing, see
 * `BLOCK_TIMING_FIELDS`) wrapping its station rows, a single result field
 * for the whole block (`BLOCK_RESULT_LABELS`, leader's `executed.reps`),
 * and one "+ Ajouter une station" to extend it — see docs/adr/0036. */
function blockCardHTML(indices, exercises) {
  const leaderIdx = indices[0];
  const leader = exercises[leaderIdx];
  const format = leader.format || "standard";
  const isChain = indices.length > 1;

  if (format === "standard" && !isChain) {
    return exerciseCardHTML(leader, leaderIdx, exercises.length, true);
  }

  const timingFields = BLOCK_TIMING_FIELDS[format] || [];
  const meta = leader.block_meta || {};
  const timingHTML = timingFields.length
    ? `<div class="exercise-block-timing">${timingFields
        .map(
          (f) => `
        <div><label>${f.label}</label><input type="number" min="0" class="f-block-meta" data-key="${f.key}" placeholder="${f.placeholder}" value="${meta[f.key] ?? ""}"></div>`
        )
        .join("")}</div>`
    : "";

  const stationsHTML = format === "standard"
    ? indices.map((idx) => exerciseCardHTML(exercises[idx], idx, exercises.length, false)).join("")
    : indices.map((idx) => stationRowHTML(exercises[idx], idx, format, exercises.length)).join("");

  // For Time : si le cap chronométré est atteint sans finir, le résultat
  // n'est plus un temps mais un nombre de tours/reps réalisés — même champ
  // de stockage (`executed.reps`, texte libre), juste un libellé qui suit
  // ce qui a réellement été réalisable ce jour-là plutôt que de forcer un
  // format "temps" qui n'a pas de sens quand le cap a coupé la séance.
  const cappedToggleHTML = format === "for_time"
    ? `<label class="capped-toggle"><input type="checkbox" class="f-block-capped"${leader.capped ? " checked" : ""}> Cap atteint (non terminé)</label>`
    : "";
  const resultLabel = format === "for_time" && leader.capped
    ? "Tours/reps atteints au cap (ex. 3 tours + 8 reps)"
    : (BLOCK_RESULT_LABELS[format] || "Résultat");
  const resultHTML = format !== "standard"
    ? `<div class="exercise-block-result"><label>${resultLabel}</label><input type="text" class="f-block-result" value="${escapeAttr((leader.executed && leader.executed.reps) ?? "")}"></div>`
    : "";

  // Circuit only, and separate from the free-text result above — a real
  // number (minutes) rather than something embedded in prose, so it can
  // actually be compared session to session to see whether it's getting
  // faster (see docs/adr/0036's amendement, "durée réalisée").
  const durationHTML = format === "circuit"
    ? `<div class="exercise-block-result"><label>Durée réalisée (min) — pour suivre la progression</label><input type="number" min="0" step="0.5" class="f-block-duration" value="${leader.executed_duration_min ?? ""}"></div>`
    : "";

  // Chrono par tour : utile surtout pour un EMOM (rythme tenu tour après
  // tour) ou un circuit (où le tour traîne-t-il vraiment) — un AMRAP/for
  // time/superset se lit déjà entièrement via le timer de séance global.
  const splitTimerCardHTML = (format === "emom" || format === "circuit")
    ? splitTimerHTML(leaderIdx, sessionRuntime.working.date)
    : "";

  return `
    <div class="exercise-block-card" data-leader-idx="${leaderIdx}">
      <div class="exercise-block-header">
        <span class="exercise-block-format-tag">${format === "standard" ? "🔗 Superset" : (EXERCISE_FORMATS[format] || format)}</span>
        <select class="f-block-format" data-leader-idx="${leaderIdx}">
          ${Object.entries(EXERCISE_FORMATS).map(([key, label]) => `<option value="${key}"${format === key ? " selected" : ""}>${label}</option>`).join("")}
        </select>
      </div>
      ${timingHTML}
      ${splitTimerCardHTML}
      <div class="exercise-block-stations">${stationsHTML}</div>
      <button type="button" class="primary-button ghost small add-station-button" data-leader-idx="${leaderIdx}">+ Ajouter ${format === "standard" ? "au superset" : "une station"}</button>
      ${cappedToggleHTML}
      ${resultHTML}
      ${durationHTML}
      <div class="exercise-block-notes"><label>Notes (optionnel)</label><textarea class="f-block-notes" rows="2" placeholder="Détail libre si besoin">${escapeHtmlText(leader.notes || "")}</textarea></div>
    </div>`;
}

/** A compact station row — name + reps/tâche + charge (optionnelle) — for
 * a member of an AMRAP/EMOM/Circuit/For Time/Autre block: these formats
 * don't have a per-station planned/executed/RIR grid, the whole block's
 * outcome is one shared result field (see `blockCardHTML`'s
 * `resultHTML`). The charge field lets a mixed block log a station with
 * a real load (ex. "Strict Press, 12 reps, 12kg/main") right next to one
 * without (ex. "Rameur, 300m") — never fed into `coach.tonnage` though,
 * same as the rest of this format family (no reliable rounds-completed
 * count to multiply it by, see docs/adr/0036's amendement). */
function stationRowHTML(ex, idx, format, total) {
  const planned = ex.planned || {};
  return `
    <div class="exercise-row station-row exercise-log-card" data-idx="${idx}">
      <div class="exercise-log-head">
        <input type="text" class="f-name" value="${escapeAttr(ex.name || "")}" placeholder="Nouvel exercice">
        <div class="reorder-buttons">
          <button type="button" class="icon-button small move-up" ${idx === 0 ? "disabled" : ""} title="Monter" aria-label="Monter">▲</button>
          <button type="button" class="icon-button small move-down" ${idx === total - 1 ? "disabled" : ""} title="Descendre" aria-label="Descendre">▼</button>
          <button type="button" class="icon-button small danger remove-exercise" title="Retirer" aria-label="Retirer">✕</button>
        </div>
      </div>
      <div class="exercise-log-grid">
        <div><label>Reps / tâche</label><input type="text" class="f-station-reps" value="${escapeAttr(planned.reps ?? "")}" placeholder="ex. 12 ou 300m"></div>
        <div>
          <label>Charge (optionnelle)</label>
          <input type="text" class="f-station-load" value="${escapeAttr(planned.load ?? "")}" placeholder="ex. 12">
          <label class="per-hand-toggle"><input type="checkbox" class="f-station-load-per-hand"${planned.load_per_hand ? " checked" : ""}> Par main</label>
        </div>
      </div>
    </div>`;
}

/** The full planned/executed/RIR card — a solo standard exercise, or one
 * member of a pure-standard superset block. `showFormatControls` is only
 * true for a solo exercise (where the format select doubles as "turn this
 * into a superset/AMRAP/EMOM/..." — see the shared `.f-block-format`
 * handler in bindSessionContentEvents): a superset member's format is
 * fixed to the block's ("standard"), so it doesn't need its own select.
 * The "Superset" option is a sentinel (`superset`), never written as a
 * real `format` (superset pairing and an exercise's own format are
 * independent axes — see EXERCISE_FORMATS' docstring, this select never
 * literally stores that conflated value): its change handler instead
 * inserts a second blank standard exercise chained right after this one
 * — "concatène deux exercices dans le même bloc", the same result as the
 * bottom "+ Superset" button, just reachable in place on an existing
 * exercise instead of only when starting a brand new pair. */
function exerciseCardHTML(ex, idx, total, showFormatControls) {
  const planned = ex.planned || {};
  const executed = ex.executed || {};
  return `
    <div class="exercise-row exercise-log-card" data-idx="${idx}">
      <div class="exercise-log-head">
        <input type="text" class="f-name" value="${escapeAttr(ex.name || "")}">
        <div class="reorder-buttons">
          <button type="button" class="icon-button small move-up" ${idx === 0 ? "disabled" : ""} title="Monter" aria-label="Monter">▲</button>
          <button type="button" class="icon-button small move-down" ${idx === total - 1 ? "disabled" : ""} title="Descendre" aria-label="Descendre">▼</button>
          <button type="button" class="icon-button small danger remove-exercise" title="Retirer" aria-label="Retirer">✕</button>
        </div>
      </div>
      ${showFormatControls
        ? `<select class="f-block-format" data-leader-idx="${idx}">
        <option value="standard"${(ex.format || "standard") === "standard" ? " selected" : ""}>Standard</option>
        <option value="superset">Superset</option>
        ${Object.entries(EXERCISE_FORMATS).filter(([key]) => key !== "standard").map(([key, label]) => `<option value="${key}"${(ex.format || "standard") === key ? " selected" : ""}>${label}</option>`).join("")}
      </select>`
        : ""}
      <div class="field-row-label">Prévu</div>
      <div class="exercise-log-grid">
        <div><label>Séries</label><input type="text" class="f-planned-sets" value="${escapeAttr(planned.sets ?? "")}"></div>
        <div><label>Reps/temps</label><input type="text" class="f-planned-reps" value="${escapeAttr(planned.reps ?? "")}"></div>
        <div>
          <label>Charge</label>
          <input type="text" class="f-planned-load" value="${escapeAttr(planned.load ?? "")}">
          <label class="per-hand-toggle"><input type="checkbox" class="f-planned-load-per-hand"${planned.load_per_hand ? " checked" : ""}> Par main</label>
        </div>
      </div>
      <div class="field-row-label">Fait</div>
      ${execRowsHTML(hydrateExecRows(executed, ex.rir))}
      <label class="per-hand-toggle"><input type="checkbox" class="f-load-per-hand"${executed.load_per_hand ? " checked" : ""}> Charge par main</label>
    </div>`;
}
