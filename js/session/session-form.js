import { sessionRuntime } from "./session-state.js";
import { escapeAttr, escapeHtmlText, skeletonHTML } from "../markdown.js";
import { SESSION_TYPES, SECONDARY_SESSION_TYPES } from "../session-types.js";
import { notesLabelFor, notesPlaceholderFor, renderSessionContent } from "./session-render.js";
import { blankBlockMeta, defaultBlockMeta, blankExercise, blankStationExercise, blankSecondarySession, defaultSessionName } from "./session-model.js";
import { bindRemoveExecSetRow, addExecSetRow, fillExecRowsAsPlanned, serializeExecRows } from "./session-exec.js";
import { bindBlockReferenceToggle } from "../plan-overview.js";
import { listAllSessions, findSessionForDate, invalidateAppLogIndex } from "../training-index.js";
import { formatFrDate } from "../date-utils.js";
import { setSessionTimerStart, getSessionTimerStart, setBlockTimerState, getBlockTimerState, formatDurationMs } from "./session-timer.js";
import { ghPutJSON } from "../github-api.js";

/** Repères concrets pour bien choisir le RPE de séance (échelle 0-10,
 * méthode de Foster) — mêmes anchors que la table que le coach utilise
 * lui-même pour estimer un RPE à partir d'une note vocale (voir
 * `prompts/coaching-guidelines.md`, section ACWR) : un ressenti "dur"
 * doit correspondre au même chiffre qu'on le tape soi-même ou que le
 * coach le déduise, sinon la charge aiguë:chronique mélange deux
 * échelles différentes sans le savoir. Repliée par défaut (`<details>`,
 * même pattern que `.block-overview-details`) — un repère consulté
 * surtout la première fois ou en cas de doute, pas à chaque séance. */
function rpeHelpDetailsHTML() {
  const rows = [
    ["0-1", "Repos, très très léger (mobilité, marche)"],
    ["2-3", "Facile, tranquille — tu peux tenir une conversation"],
    ["4-6", "Modéré à soutenu — respiration marquée mais contrôlée"],
    ["7-8", "Difficile — ça tire, peu de réserve en fin de séance"],
    ["9", "Très difficile — proche de l'échec sur les derniers efforts"],
    ["10", "Maximal — tout donné, rien en réserve (effort exceptionnel, match décisif)"],
  ].map(([rpe, feel]) => `<tr><td>${rpe}</td><td>${feel}</td></tr>`).join("");
  return `
    <details class="block-overview-details rpe-help-details">
      <summary>Comment bien choisir le RPE ?</summary>
      <p class="small">Un seul chiffre pour <strong>toute la séance</strong>
      (muscu ou rugby/match) — pas par exercice, ça c'est le RIR de chaque
      série dans le tableau "Fait". Note-le idéalement 20-30 min après la
      fin, une fois le souffle redescendu, plutôt qu'à chaud juste après le
      dernier exercice ou la dernière action de match.</p>
      <table class="rpe-scale-table">${rows}</table>
      <p class="small">Sois honnête même un jour "ordinaire" : ce chiffre
      sert au calcul de charge aiguë:chronique (onglet Data) pour repérer
      une hausse de charge trop rapide — jamais un jugement de performance.</p>
    </details>`;
}

export function workloadSectionHTML(session) {
  return `
    <section class="card">
      <h2>⚙️ Charge de la séance (optionnel)</h2>
      <p class="muted small">Alimente le calcul de charge aiguë:chronique (RPE × durée, méthode de Foster) — voir l'onglet Data.</p>
      <div class="exercise-log-grid">
        <div><label>RPE (0-10)</label><input type="number" min="0" max="10" step="1" id="session-rpe" value="${session.session_rpe ?? ""}"></div>
        <div><label>Durée (min)</label><input type="number" min="0" step="5" id="session-duration" value="${session.session_duration_min ?? ""}"></div>
      </div>
      ${rpeHelpDetailsHTML()}
    </section>`;
}

/** See blankSecondarySession — a second, simpler activity the same day
 * (rugby/autre only). Rendered as its own compact card, always below the
 * primary session's own charge section. */
export function secondarySessionSectionHTML(session) {
  if (!session.secondary) {
    return `
      <section class="card">
        <button type="button" id="add-secondary-session" class="primary-button ghost small">+ Ajouter une deuxième séance ce jour-là</button>
      </section>`;
  }
  const secondary = session.secondary;
  const type = SECONDARY_SESSION_TYPES.includes(secondary.type) ? secondary.type : "rugby";
  return `
    <section class="card" id="secondary-session-card">
      <div class="secondary-session-header">
        <h2>${SESSION_TYPES[type].icon} Deuxième séance</h2>
        <button type="button" id="remove-secondary-session" class="icon-button small danger" title="Retirer cette deuxième séance" aria-label="Retirer cette deuxième séance">✕</button>
      </div>
      <label>Type</label>
      <select id="secondary-type-select">
        ${SECONDARY_SESSION_TYPES.map((t) => `<option value="${t}"${t === type ? " selected" : ""}>${SESSION_TYPES[t].label}</option>`).join("")}
      </select>
      <label>Nom</label>
      <input id="secondary-name-input" value="${escapeAttr(secondary.name || "")}">
      <label>${notesLabelFor(type)}</label>
      <textarea id="secondary-notes" rows="3" placeholder="${escapeAttr(notesPlaceholderFor(type))}">${escapeHtmlText(secondary.notes || "")}</textarea>
      ${type === "autre" ? `<label>Distance (km, facultatif)</label><input type="text" id="secondary-distance" value="${escapeAttr(secondary.distance_km ?? "")}">` : ""}
      <div class="exercise-log-grid">
        <div><label>RPE (0-10)</label><input type="number" min="0" max="10" step="1" id="secondary-rpe" value="${secondary.session_rpe ?? ""}"></div>
        <div><label>Durée (min)</label><input type="number" min="0" step="5" id="secondary-duration" value="${secondary.session_duration_min ?? ""}"></div>
      </div>
      <p class="muted small">Compte avec la séance principale dans la charge aiguë:chronique du jour (RPE × durée de chaque séance, additionnées).</p>
      ${rpeHelpDetailsHTML()}
    </section>`;
}

/** Reads whatever's currently typed back into `sessionRuntime.working.session` —
 * called before any structural change (reorder/add/remove/format switch)
 * so in-progress edits survive the re-render, and before the final save. */
export function syncFormIntoSession() {
  const session = sessionRuntime.working.session;

  const nameInput = document.getElementById("session-name-input");
  if (nameInput) session.name = nameInput.value.trim() || "Séance";

  const notesInput = document.getElementById("session-notes");
  if (notesInput) session.notes = notesInput.value.trim() || null;

  const distanceInput = document.getElementById("session-distance");
  if (distanceInput) session.distance_km = distanceInput.value !== "" ? Number(distanceInput.value) : null;

  const rpeInput = document.getElementById("session-rpe");
  if (rpeInput) session.session_rpe = rpeInput.value !== "" ? Number(rpeInput.value) : null;
  const durationInput = document.getElementById("session-duration");
  if (durationInput) session.session_duration_min = durationInput.value !== "" ? Number(durationInput.value) : null;

  if (session.secondary) {
    const typeSelect = document.getElementById("secondary-type-select");
    if (typeSelect) session.secondary.type = typeSelect.value;
    const secNameInput = document.getElementById("secondary-name-input");
    if (secNameInput) session.secondary.name = secNameInput.value.trim() || session.secondary.name;
    const secNotesInput = document.getElementById("secondary-notes");
    if (secNotesInput) session.secondary.notes = secNotesInput.value.trim() || null;
    const secDistanceInput = document.getElementById("secondary-distance");
    if (secDistanceInput) session.secondary.distance_km = secDistanceInput.value !== "" ? Number(secDistanceInput.value) : null;
    const secRpeInput = document.getElementById("secondary-rpe");
    if (secRpeInput) session.secondary.session_rpe = secRpeInput.value !== "" ? Number(secRpeInput.value) : null;
    const secDurationInput = document.getElementById("secondary-duration");
    if (secDurationInput) session.secondary.session_duration_min = secDurationInput.value !== "" ? Number(secDurationInput.value) : null;
  }

  // Individual exercise rows — a full standard card (solo exercise, or a
  // superset member) or a compact station row (AMRAP/EMOM/Circuit/For
  // Time/Autre member). `format`/`superset_with_previous` are NOT read
  // here — they're structural (which block an exercise belongs to, and
  // what kind), set directly by the block-format switch and the add/
  // remove-station handlers in bindSessionContentEvents, not by a form
  // field re-read on every sync.
  document.querySelectorAll("#exercise-list .exercise-row").forEach((row) => {
    const idx = +row.dataset.idx;
    const ex = session.exercises[idx];
    if (!ex) return;
    const nameInput = row.querySelector(".f-name");
    if (nameInput) ex.name = nameInput.value.trim() || ex.name;

    const stationReps = row.querySelector(".f-station-reps");
    if (stationReps) {
      const stationLoad = row.querySelector(".f-station-load");
      const stationLoadPerHand = row.querySelector(".f-station-load-per-hand");
      ex.planned = {
        sets: null,
        reps: stationReps.value.trim() || null,
        load: stationLoad ? (stationLoad.value.trim() || null) : null,
        load_per_hand: stationLoadPerHand ? stationLoadPerHand.checked : false,
      };
      return;
    }

    const plannedSets = row.querySelector(".f-planned-sets");
    if (plannedSets) {
      ex.planned = {
        sets: plannedSets.value || null,
        reps: row.querySelector(".f-planned-reps").value || null,
        load: row.querySelector(".f-planned-load").value || null,
        load_per_hand: row.querySelector(".f-planned-load-per-hand").checked,
      };
    }
    const execRowsContainer = row.querySelector(".exec-set-rows");
    if (execRowsContainer) {
      const setRows = Array.from(execRowsContainer.querySelectorAll(".set-row:not(.set-row-head)"));
      const repsVals = setRows.map((r) => r.querySelector(".f-exec-set-reps").value);
      const loadVals = setRows.map((r) => r.querySelector(".f-exec-set-load").value);
      const rirVals = setRows.map((r) => r.querySelector(".f-exec-set-rir").value);
      const serialized = serializeExecRows(repsVals, loadVals, rirVals);
      ex.executed = {
        sets: serialized.sets,
        reps: serialized.reps,
        load: serialized.load,
        load_per_hand: row.querySelector(".f-load-per-hand").checked,
      };
      ex.rir = serialized.rir;
    }
  });

  // Block-level fields — timing (leader only), the whole block's result,
  // and its shared notes (see blockCardHTML). Absent entirely for a solo
  // standard exercise (no `.exercise-block-card` wrapper in that case).
  document.querySelectorAll("#exercise-list .exercise-block-card").forEach((card) => {
    const leaderIdx = +card.dataset.leaderIdx;
    const leader = session.exercises[leaderIdx];
    if (!leader) return;

    const metaInputs = card.querySelectorAll(".f-block-meta");
    if (metaInputs.length) {
      const meta = leader.block_meta || blankBlockMeta();
      metaInputs.forEach((input) => {
        meta[input.dataset.key] = input.value !== "" ? Number(input.value) : null;
      });
      leader.block_meta = meta;
    }

    const cappedInput = card.querySelector(".f-block-capped");
    if (cappedInput) leader.capped = cappedInput.checked;

    const resultInput = card.querySelector(".f-block-result");
    if (resultInput) {
      leader.executed = leader.executed || { sets: null, reps: null, load: null };
      leader.executed.reps = resultInput.value.trim() || null;
    }

    const durationInput = card.querySelector(".f-block-duration");
    if (durationInput) leader.executed_duration_min = durationInput.value !== "" ? Number(durationInput.value) : null;

    const notesInput = card.querySelector(".f-block-notes");
    if (notesInput) leader.notes = notesInput.value.trim() || null;
  });
}

/** End (exclusive) of the block starting at `leaderIdx` — the leader plus
 * every following exercise chained to it (`superset_with_previous`). */
function blockEndIndex(exercises, leaderIdx) {
  let end = leaderIdx + 1;
  while (end < exercises.length && exercises[end].superset_with_previous) end++;
  return end;
}

export function bindSessionContentEvents() {
  // Format select — shared by a solo exercise's own select (doubles as
  // "turn this into a superset/AMRAP/EMOM/...") and a block header's
  // select (applies to every member at once): both use `.f-block-format`
  // with `data-leader-idx`, see exerciseCardHTML/blockCardHTML.
  document.querySelectorAll(".f-block-format").forEach((sel) => sel.addEventListener("change", () => {
    syncFormIntoSession();
    const leaderIdx = +sel.dataset.leaderIdx;
    const exercises = sessionRuntime.working.session.exercises;
    if (sel.value === "superset") {
      // Concatène : insère un deuxième exercice standard juste après,
      // chaîné à celui-ci — même résultat que le bouton "+ Superset" du
      // bas, mais depuis un exercice déjà existant. Le format de
      // l'exercice actuel reste "standard" (jamais "superset" — voir la
      // note sur EXERCISE_FORMATS), seul superset_with_previous change,
      // sur le nouvel exercice inséré.
      exercises.splice(leaderIdx + 1, 0, blankStationExercise("standard"));
      renderSessionContent();
      return;
    }
    const end = blockEndIndex(exercises, leaderIdx);
    const newFormat = sel.value;
    for (let i = leaderIdx; i < end; i++) exercises[i].format = newFormat;
    const leader = exercises[leaderIdx];
    leader.block_meta = newFormat === "standard" ? undefined : (leader.block_meta || defaultBlockMeta(newFormat));
    renderSessionContent();
  }));

  // For Time : bascule le libellé du résultat entre "temps réalisé" et
  // "tours/reps atteints au cap" — re-rendu nécessaire pour que le
  // libellé suive, syncFormIntoSession garde ce qui est déjà tapé partout
  // ailleurs (y compris dans le champ résultat lui-même) avant ça.
  document.querySelectorAll(".f-block-capped").forEach((cb) => cb.addEventListener("change", () => {
    syncFormIntoSession();
    const leaderIdx = +cb.closest(".exercise-block-card").dataset.leaderIdx;
    sessionRuntime.working.session.exercises[leaderIdx].capped = cb.checked;
    renderSessionContent();
  }));

  // Bottom quick-add row — starts a fresh block of the given kind. A
  // superset needs ≥2 exercises to mean anything, so "+ Superset" adds
  // its first pair directly rather than a lone standard exercise the user
  // would then have to somehow chain by hand.
  document.querySelectorAll(".add-block-button").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const exercises = sessionRuntime.working.session.exercises;
    const kind = btn.dataset.addFormat;
    if (kind === "standard") {
      exercises.push(blankExercise());
    } else if (kind === "superset") {
      exercises.push(blankExercise(), blankStationExercise("standard"));
    } else {
      const leader = blankStationExercise(kind);
      leader.superset_with_previous = false;
      leader.block_meta = defaultBlockMeta(kind);
      exercises.push(leader);
    }
    renderSessionContent();
  }));

  // Extends an existing block with one more chained member, right after
  // its current last one — same format as the block, station-empty.
  document.querySelectorAll(".add-station-button").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const exercises = sessionRuntime.working.session.exercises;
    const leaderIdx = +btn.dataset.leaderIdx;
    const insertAt = blockEndIndex(exercises, leaderIdx);
    exercises.splice(insertAt, 0, blankStationExercise(exercises[leaderIdx].format || "standard"));
    renderSessionContent();
  }));

  // Chrono par tour (EMOM/Circuit) — voir "Chrono par tour (blocs
  // EMOM/Circuit)" plus haut pour la logique de stockage.
  document.querySelectorAll(".split-timer-start").forEach((btn) => btn.addEventListener("click", () => {
    const leaderIdx = +btn.dataset.leaderIdx;
    const now = new Date().toISOString();
    setBlockTimerState(sessionRuntime.working.date, leaderIdx, { startedAt: now, lastLapAt: now, laps: [] });
    renderSessionContent();
  }));
  document.querySelectorAll(".split-timer-lap").forEach((btn) => btn.addEventListener("click", () => {
    const leaderIdx = +btn.dataset.leaderIdx;
    const bt = getBlockTimerState(sessionRuntime.working.date, leaderIdx);
    if (!bt) return;
    const now = new Date();
    bt.laps.push(now.getTime() - new Date(bt.lastLapAt).getTime());
    bt.lastLapAt = now.toISOString();
    setBlockTimerState(sessionRuntime.working.date, leaderIdx, bt);
    renderSessionContent();
  }));
  document.querySelectorAll(".split-timer-stop").forEach((btn) => btn.addEventListener("click", () => {
    const leaderIdx = +btn.dataset.leaderIdx;
    const bt = getBlockTimerState(sessionRuntime.working.date, leaderIdx);
    if (!bt) return;
    // Garde tout ce qui a déjà été tapé (notes incluses) avant d'y ajouter
    // le résumé des tours — un "Arrêter" ne doit jamais écraser une note
    // en cours de frappe dans le même bloc.
    syncFormIntoSession();
    const leader = sessionRuntime.working.session.exercises[leaderIdx];
    if (leader && bt.laps.length) {
      const summary = `Tours : ${bt.laps.map((ms) => formatDurationMs(ms)).join(", ")}`;
      leader.notes = leader.notes ? `${leader.notes}\n${summary}` : summary;
    }
    setBlockTimerState(sessionRuntime.working.date, leaderIdx, null);
    renderSessionContent();
  }));

  document.querySelectorAll(".move-up").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-row").dataset.idx;
    const arr = sessionRuntime.working.session.exercises;
    [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
    renderSessionContent();
  }));
  document.querySelectorAll(".move-down").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-row").dataset.idx;
    const arr = sessionRuntime.working.session.exercises;
    [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
    renderSessionContent();
  }));
  document.querySelectorAll(".remove-exercise").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-row").dataset.idx;
    const exercises = sessionRuntime.working.session.exercises;
    const removed = exercises[idx];
    // Removing a block leader that still has chained members: promote the
    // next member to leader so the block's timing/result/notes survive
    // rather than silently vanishing with the exercise that carried them.
    if (!removed.superset_with_previous && exercises[idx + 1] && exercises[idx + 1].superset_with_previous) {
      const promoted = exercises[idx + 1];
      promoted.block_meta = removed.block_meta;
      promoted.notes = removed.notes;
      if (removed.executed) promoted.executed = removed.executed;
      promoted.superset_with_previous = false;
    }
    exercises.splice(idx, 1);
    renderSessionContent();
  }));

  // Fait : ajouter/retirer une ligne "série" — voir bindRemoveExecSetRow
  // pour pourquoi ceci reste du DOM pur plutôt qu'un cycle sync+mutate+
  // re-render comme le reste de ce formulaire.
  document.querySelectorAll(".remove-exec-set").forEach(bindRemoveExecSetRow);
  document.querySelectorAll(".add-exec-set").forEach((btn) => btn.addEventListener("click", () => {
    addExecSetRow(btn.closest(".exec-set-rows"));
  }));
  document.querySelectorAll(".as-planned-exec").forEach((btn) => btn.addEventListener("click", () => {
    const card = btn.closest(".exercise-row");
    const container = btn.closest(".exec-set-rows");
    const plannedSets = card.querySelector(".f-planned-sets").value;
    const plannedReps = card.querySelector(".f-planned-reps").value;
    const plannedLoad = card.querySelector(".f-planned-load").value;
    fillExecRowsAsPlanned(container, plannedSets, plannedReps, plannedLoad);
  }));
  document.querySelectorAll(".duplicate-exec-set").forEach((btn) => btn.addEventListener("click", () => {
    const container = btn.closest(".exec-set-rows");
    const rows = container.querySelectorAll(".set-row:not(.set-row-head)");
    if (rows.length < 2) return;
    const first = rows[0];
    const load = first.querySelector(".f-exec-set-load").value;
    const reps = first.querySelector(".f-exec-set-reps").value;
    const rir = first.querySelector(".f-exec-set-rir").value;
    rows.forEach((r, i) => {
      if (i === 0) return;
      r.querySelector(".f-exec-set-load").value = load;
      r.querySelector(".f-exec-set-reps").value = reps;
      r.querySelector(".f-exec-set-rir").value = rir;
    });
  }));

  bindBlockReferenceToggle(document.getElementById("toggle-block-ref"), document.getElementById("block-ref-content"));

  const prefillBtn = document.getElementById("prefill-button");
  if (prefillBtn) prefillBtn.addEventListener("click", async () => {
    const box = document.getElementById("prefill-picker");
    box.hidden = !box.hidden;
    if (box.hidden || box.dataset.loaded) return;
    box.innerHTML = skeletonHTML();
    const sessions = (await listAllSessions()).filter((s) => s.date < sessionRuntime.working.date).slice(0, 8);
    box.innerHTML = sessions.length
      ? sessions.map((s) => `<button type="button" class="history-item" data-date="${s.date}"><div class="history-date">${formatFrDate(s.date)}</div><div class="history-sub">${escapeHtmlText(s.name || "Séance")}</div></button>`).join("")
      : "<p class='muted small'>Pas de séance récente à dupliquer.</p>";
    box.dataset.loaded = "1";
    box.querySelectorAll(".history-item").forEach((btn) => btn.addEventListener("click", async () => {
      const found = await findSessionForDate(btn.dataset.date);
      if (!found.session || !found.session.exercises || !found.session.exercises.length) return;
      const cloned = JSON.parse(JSON.stringify(found.session.exercises));
      cloned.forEach((ex) => { ex.executed = { sets: null, reps: null, load: null }; ex.rir = null; });
      sessionRuntime.working.session.exercises = cloned;
      box.hidden = true;
      renderSessionContent();
    }));
  });

  const startTimerBtn = document.getElementById("start-timer");
  if (startTimerBtn) startTimerBtn.addEventListener("click", () => {
    setSessionTimerStart(sessionRuntime.working.date, new Date().toISOString());
    renderSessionContent();
  });
  const stopTimerBtn = document.getElementById("stop-timer");
  if (stopTimerBtn) stopTimerBtn.addEventListener("click", () => {
    if (!confirm("Terminer la séance ? La durée sera remplie automatiquement (encore modifiable ensuite).")) return;
    const startedAt = getSessionTimerStart(sessionRuntime.working.date);
    syncFormIntoSession(); // garde les autres champs déjà tapés (RPE, notes...) avant d'écraser la durée
    if (startedAt) {
      sessionRuntime.working.session.session_duration_min = Math.max(1, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000));
    }
    setSessionTimerStart(sessionRuntime.working.date, null);
    renderSessionContent();
  });

  document.getElementById("save-session").addEventListener("click", async (e) => {
    syncFormIntoSession();
    const btn = e.currentTarget;
    const statusEl = document.getElementById("session-status");
    if (sessionRuntime.saveInFlight) { statusEl.textContent = "Sauvegarde déjà en cours…"; return; }
    btn.disabled = true;
    sessionRuntime.saveInFlight = true;
    statusEl.textContent = "Enregistrement…";
    try {
      await saveSession(sessionRuntime.working.weekLabel, sessionRuntime.working.date, sessionRuntime.working.session);
      statusEl.textContent = "Enregistré ✓";
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
      sessionRuntime.saveInFlight = false;
    }
  });

  const addSecondaryBtn = document.getElementById("add-secondary-session");
  if (addSecondaryBtn) addSecondaryBtn.addEventListener("click", () => {
    syncFormIntoSession();
    sessionRuntime.working.session.secondary = blankSecondarySession(sessionRuntime.working.date, "rugby");
    renderSessionContent();
  });

  const removeSecondaryBtn = document.getElementById("remove-secondary-session");
  if (removeSecondaryBtn) removeSecondaryBtn.addEventListener("click", () => {
    if (!confirm("Retirer cette deuxième séance ?")) return;
    syncFormIntoSession();
    sessionRuntime.working.session.secondary = null;
    renderSessionContent();
  });

  const secondaryTypeSelect = document.getElementById("secondary-type-select");
  if (secondaryTypeSelect) secondaryTypeSelect.addEventListener("change", () => {
    syncFormIntoSession();
    const secondary = sessionRuntime.working.session.secondary;
    const oldType = secondary.type;
    const newType = secondaryTypeSelect.value;
    // Follows the new type's default name only if it was still on the old
    // type's default (never customized) — a name the user actually typed
    // is left alone, same as the primary session's own naming.
    if (secondary.name === defaultSessionName(sessionRuntime.working.date, oldType)) {
      secondary.name = defaultSessionName(sessionRuntime.working.date, newType);
    }
    secondary.type = newType;
    secondary.distance_km = newType === "autre" ? (secondary.distance_km ?? null) : undefined;
    renderSessionContent();
  });
}

/** Overwrites the whole session for `date` in data/training/app-log/<date>.json
 * — replaces the old per-exercise overlay (a partial merge could never
 * represent a reordered or resized exercise list coherently). Schema
 * matches coach.sheets_parse.parse_week exactly so every existing reader
 * (trajectory, progression, compliance, blocks) picks it up unchanged —
 * see docs/adr/0017 and docs/adr/0018.
 *
 * Also write-through merges session_rpe/session_duration_min into
 * data/health/<date>.json when present — that's the file coach.workload
 * actually reads (Foster's session-RPE method, see docs/adr/0011) — the
 * copy kept on the session itself is just for the app's own display, this
 * file is the real source of truth for the ACWR calculation.
 *
 * When a secondary session (see blankSecondarySession, docs/adr/0050) also
 * has a full RPE+durée pair, both loads are written as `session_loads`
 * (summed by coach.workload) instead of just the primary's singular
 * fields — the common single-session case keeps writing exactly the same
 * shape as before, untouched. */
export async function saveSession(weekLabel, date, session) {
  const path = `data/training/app-log/${date}.json`;
  await ghPutJSON(path, null, `App : séance du ${date}`, (current) => {
    const base = current || { week_label: weekLabel, objective: null, bodyweight: {}, sessions: [] };
    const nextSession = { ...session, date };
    const idx = base.sessions.findIndex((s) => s.date === date);
    if (idx === -1) base.sessions.push(nextSession);
    else base.sessions[idx] = nextSession;
    return base;
  });
  invalidateAppLogIndex();

  const secondary = session.secondary;
  const primaryHasLoad = session.session_rpe != null && session.session_duration_min != null;
  const secondaryHasLoad = !!secondary && secondary.session_rpe != null && secondary.session_duration_min != null;

  if (primaryHasLoad || secondaryHasLoad || session.session_rpe != null || session.session_duration_min != null) {
    await ghPutJSON(`data/health/${date}.json`, { date }, `App : charge de séance ${date}`, (current) => {
      const base = current || { date };
      if (session.session_rpe != null) base.session_rpe = session.session_rpe;
      if (session.session_duration_min != null) base.session_duration_min = session.session_duration_min;
      const loads = [];
      if (primaryHasLoad) loads.push({ rpe: session.session_rpe, duration_min: session.session_duration_min });
      if (secondaryHasLoad) loads.push({ rpe: secondary.session_rpe, duration_min: secondary.session_duration_min });
      if (loads.length > 1) base.session_loads = loads;
      else delete base.session_loads; // no (longer any) second activity — legacy singular fields tell the whole story, clears a stale array if a secondary was removed
      return base;
    });
  }
}
