import { sessionRuntime } from "./session-state.js";
import { renderSessionContent } from "./session-render.js";
import { groupExercisesIntoBlocks } from "./session-model.js";
import { groupZonesByRegion, painTier, PAIN_LEVEL_LABELS } from "../views/pain.js";
import { EVENT_KINDS, EXTERNAL_TAGS, setEventsOf, describeEvent, eventKindLabel, addSetEvent, removeSetEvent, shiftEventsAfterDelete } from "./set-events.js";
import { syncFormIntoSession, cancelSessionRun } from "./session-form.js";
import { getSessionTimerStart, startSessionRun, formatElapsed, formatDurationMs } from "./session-timer.js";
import { hydrateExecRows, hydrateSetRows, serializeExecRows } from "./session-exec.js";
import { ghGetFile } from "../github-api.js";
import { normalizeName } from "../exercise-stats.js";
import { escapeHtmlText, escapeAttr } from "../markdown.js";
import { MACHINES, filledIntervals, cardioStats, headlineMetric, totalsLine, cardioPrescription, fmtDuration, writeCardioExecuted, num, restAfter, blockSize, isShortIntervals, primaryUnit, writeCardioTotal, cardioRoundsDone } from "../cardio.js";
import { EXERCISE_FORMATS } from "../session-types.js";

// ============================================================================
// Mode séance guidée (docs/adr/0074) — une surcouche plein écran qui fait
// défiler les exercices « standard » de la séance un par un : série en cours
// pré-remplie (dernière série faite, sinon le prévu), boutons −/+ pour la
// charge et les reps, RIR en un tap, gros bouton « Valider la série » sous
// le pouce, repos décompté automatiquement.
//
// Aucun nouveau chemin d'écriture : chaque série validée est sérialisée dans
// `sessionRuntime.working.session` avec le même format que le formulaire
// (`serializeExecRows`, tirets par série), puis le formulaire derrière la
// surcouche est redessiné depuis ce modèle (`renderSessionContent`). L'auto-
// sauvegarde existante, qui relit le DOM du formulaire, voit donc toujours
// les valeurs à jour, et « Enregistrer la séance » / « Terminer » restent les
// seuls déclencheurs d'écriture.
//
// Superset (docs/adr/0100) : les membres d'un superset s'enchaînent comme on
// les exécute — A1, B1, (repos), A2, B2, (repos)… — le repos ne démarre qu'à la
// fin du tour, et une bande « Superset · Tour n » permet de sauter d'un
// membre à l'autre.
//
// Ressenti rattaché à une série : le « + » de la carte de série ouvre une
// feuille (douleur, imprévu extérieur, note) — voir set-events.js.
//
// Les blocs AMRAP / EMOM / Circuit / For Time ne sont pas proposés ici : leur
// résultat se saisit au niveau du bloc, dans le formulaire.
//
// Cardio sur machine (docs/adr/0112) : écran dédié — chrono effort/repos qui
// enchaîne les rounds avec un bip à chaque changement (écran maintenu allumé
// si le navigateur le permet), et une ligne par round (temps, distance, cal,
// FC facultative) à remplir pendant le repos.
//
// Navigation série par série (docs/adr/0082) : `live.cursor` désigne la série
// affichée dans l'exercice courant — une série faite (modifiable, supprimable)
// ou la prochaine à faire (`cursor === rows.length`). « Valider » passe à la
// série suivante du même exercice ; changer d'exercice est un geste explicite
// (« Exercice suivant », ou la liste des exercices). « + Ajouter une série »
// relève l'objectif de l'exercice pour la séance (montée en charge, série en
// plus) sans toucher au prévu.
// ============================================================================

const REST_KEY = "coach_live_rest_seconds";
const REST_CHOICES = [60, 90, 120, 180];
const RIR_CHOICES = ["0", "1", "2", "3", "4"];

let live = null;

function getRestSeconds() {
  try { const v = parseInt(localStorage.getItem(REST_KEY), 10); return REST_CHOICES.includes(v) ? v : 120; } catch (_) { return 120; }
}
function setRestSeconds(v) {
  try { localStorage.setItem(REST_KEY, String(v)); } catch (_) { /* confort seulement */ }
}

/** Indices des exercices proposés en mode guidé : format standard (seul, ou
 * membre d'un superset — un superset est une suite d'exercices standard). */
export function liveExerciseIndices(session) {
  return (session.exercises || [])
    .map((ex, i) => ({ ex, i }))
    .filter(({ ex }) => {
      if (!(ex.name || "").trim()) return false;
      // Un bloc (circuit, AMRAP, EMOM, for time…) est une seule étape, portée
      // par son premier exercice ; ses stations suivantes ne sont pas des étapes.
      return isBlock(ex) ? !ex.superset_with_previous : true;
    })
    .map(({ i }) => i);
}

/** Exercice d'un bloc non standard (circuit, AMRAP, EMOM, for time, autre). */
function isBlock(ex) {
  return !["standard", "cardio"].includes(ex.format || "standard");
}

/** Indices (dans la séance) des stations du bloc mené par `idx`. */
function blockStations(idx) {
  const { exercises } = sessionRuntime.working.session;
  const out = [idx];
  for (let k = idx + 1; k < exercises.length && exercises[k].superset_with_previous; k++) out.push(k);
  return out;
}

function blockRoundsPlanned(ex) {
  const n = parseInt((ex.block_meta || {}).rounds, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Positions (dans `live.indices`) des membres du superset qui contient la
 * position `pos`, ou null si l'exercice est seul. */
function membersOf(pos) {
  const { exercises } = sessionRuntime.working.session;
  const idx = live.indices[pos];
  const block = groupExercisesIntoBlocks(exercises).find((b) => b.includes(idx));
  if (!block) return null;
  const members = block.map((i) => live.indices.indexOf(i)).filter((k) => k >= 0);
  return members.length > 1 && members.includes(pos) ? members : null;
}

function blockEndPos(pos) {
  const members = membersOf(pos);
  return members ? Math.max(...members) : pos;
}

/** Prochain membre qui doit encore une série après `pos` : d'abord ceux qui
 * suivent dans le tour (`wrapped: false`), puis ceux d'avant, au tour suivant.
 * `strict` : sans objectif chiffré, un membre n'est « en retard » que s'il a
 * moins de séries que l'exercice courant (utilisé pour savoir s'il reste
 * vraiment quelque chose à faire ; le flux de validation, lui, enchaîne les
 * tours tant que l'utilisateur ne change pas d'exercice). */
function nextMember(pos, strict = false) {
  const members = membersOf(pos);
  if (!members) return null;
  const { exercises } = sessionRuntime.working.session;
  const curRows = doneRows(exercises[live.indices[pos]]).length;
  const at = members.indexOf(pos);
  const needs = (k, wrapped) => {
    const e = exercises[live.indices[k]];
    const n = doneRows(e).length;
    const t = targetCount(e, live.indices[k]);
    if (t != null) return n < t;
    return wrapped ? !strict : n < curRows;
  };
  for (const k of members.slice(at + 1)) if (needs(k, false)) return { pos: k, wrapped: false };
  for (const k of members.slice(0, at)) if (needs(k, true)) return { pos: k, wrapped: true };
  return null;
}

function doneRows(ex) {
  // Cardio : un round compte comme « fait » dès qu'un chiffre y est saisi
  // (lignes factices, seulement pour les compteurs et la progression).
  if (ex.format === "cardio") return Array.from({ length: cardioRoundsDone(ex) }, () => ({ load: "", reps: "1", rir: "" }));
  // Bloc : un tour validé (circuit) ou un résultat saisi (autres formats).
  if (isBlock(ex)) {
    const n = ex.format === "circuit" ? (parseInt((ex.executed || {}).sets, 10) || 0) : ((ex.executed || {}).reps ? 1 : 0);
    return Array.from({ length: n }, () => ({ load: "", reps: "1", rir: "" }));
  }
  return hydrateExecRows(ex.executed || {}, ex.rir).filter((r) => (r.reps || "").trim() || (r.load || "").trim());
}

function plannedCount(ex) {
  if (isBlock(ex)) return ex.format === "circuit" ? (blockRoundsPlanned(ex) || 1) : 1;
  const n = parseInt((ex.planned || {}).sets, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Nombre de séries visé pour cet exercice pendant la séance : le prévu,
 * relevé par « + Ajouter une série », et jamais moins que ce qui est déjà
 * fait. `null` si ni prévu ni ajout (exercice libre). */
function targetCount(ex, idx) {
  const planned = plannedCount(ex);
  const extra = live && live.targets[idx] != null ? live.targets[idx] : null;
  const base = extra != null ? Math.max(extra, planned || 0) : planned;
  if (base == null) return null;
  return Math.max(base, doneRows(ex).length);
}

function plannedLine(ex) {
  const p = ex.planned || {};
  const parts = [];
  if (p.sets && p.reps) parts.push(`${p.sets} × ${p.reps}`);
  else if (p.reps) parts.push(String(p.reps));
  if (p.load != null && p.load !== "") parts.push(`${p.load}${/^[\d.,]+$/.test(String(p.load)) ? " kg" : ""}${p.load_per_hand ? " / main" : ""}`);
  return parts.join(" · ");
}

/** Valeurs de départ de la série à saisir : la dernière série faite (le cas
 * courant est « même charge, mêmes reps »), sinon le prévu de cette série. */
function draftFor(ex) {
  const rows = doneRows(ex);
  if (rows.length) {
    const last = rows[rows.length - 1];
    return { load: last.load || "", reps: last.reps || "", rir: last.rir || "" };
  }
  const p = ex.planned || {};
  const reps = hydrateSetRows(p.sets, p.reps);
  return { load: p.load != null ? String(p.load) : "", reps: reps.length ? reps[0] : "", rir: "" };
}

function draftAtCursor(ex) {
  const rows = doneRows(ex);
  if (live.cursor < rows.length) {
    const r = rows[live.cursor];
    return { load: r.load || "", reps: r.reps || "", rir: r.rir || "" };
  }
  return draftFor(ex);
}

function lastTimeText(name) {
  if (!live || !live.history) return "";
  const key = Object.keys(live.history).find((k) => normalizeName(k) === normalizeName(name));
  if (!key) return "";
  const entries = (live.history[key] || []).filter((e) => e.date !== sessionRuntime.working.date && (e.reps || e.load));
  const last = entries[entries.length - 1];
  if (!last) return "";
  const parts = [];
  if (last.sets) parts.push(`${last.sets} séries`);
  if (last.reps) parts.push(`${last.reps} reps`);
  if (last.load) parts.push(`${last.load}${/^[\d.,]+$/.test(String(last.load)) ? " kg" : ""}`);
  return `Dernière fois (${last.date.slice(8, 10)}/${last.date.slice(5, 7)}) : ${parts.join(" · ")}`;
}

/** Charge conseillée (docs/adr/0115) : calculée par `coach.progression_hint`
 * d'après la dernière séance, affichée sous « Dernière fois ». Un tap
 * l'applique à la série en cours quand elle diffère de ce qui est affiché. */
function hintFor(ex) {
  if (!live || !live.hints) return null;
  const key = Object.keys(live.hints).find((k) => normalizeName(k) === normalizeName(ex.name));
  const hint = key ? live.hints[key] : null;
  if (!hint || !(hint.date < sessionRuntime.working.date)) return null;
  return hint;
}

function hintHTML(ex) {
  const hint = hintFor(ex);
  if (!hint) return "";
  const fmt = (v) => String(v).replace(".", ",");
  const target = [hint.load != null ? `${fmt(hint.load)} kg${hint.per_hand ? " / main" : ""}` : "", hint.reps ? `${hint.reps} reps` : ""].filter(Boolean).join(" × ");
  const plannedLoad = parseFloat(String((ex.planned || {}).load ?? "").replace(",", "."));
  const aligned = hint.load != null && Number.isFinite(plannedLoad) && Math.abs(plannedLoad - hint.load) < 0.01;
  const draftLoad = parseFloat(String((live.draft || {}).load ?? "").replace(",", "."));
  const canApply = hint.load != null && !(Number.isFinite(draftLoad) && Math.abs(draftLoad - hint.load) < 0.01) && doneRows(ex).length === 0;
  const icon = { up: "↗", down: "↘", reps: "＋", hold: "＝" }[hint.action] || "";
  return `<div class="live-hint ${hint.action}">
      <span class="live-hint-text"><strong>${icon} ${aligned ? "Prévu = ta progression" : `Conseil : ${escapeHtmlText(target)}`}</strong><small>${escapeHtmlText(hint.why)}</small></span>
      ${canApply ? `<button type="button" data-live="hint-apply">Utiliser</button>` : ""}
    </div>`;
}

function step(value, delta) {
  const s = String(value || "").trim().replace(",", ".");
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return value;
  const n = Math.max(0, Math.round((parseFloat(s) + delta) * 100) / 100);
  return String(n); // point décimal : le format lu par coach.tonnage (_load_kg)
}

function writeRows(ex, rows) {
  const serialized = serializeExecRows(rows.map((r) => r.reps || ""), rows.map((r) => r.load || ""), rows.map((r) => r.rir || ""));
  ex.executed = {
    sets: serialized.sets,
    reps: serialized.reps,
    load: serialized.load,
    load_per_hand: !!(ex.executed && ex.executed.load_per_hand),
  };
  ex.rir = serialized.rir;
  // Redessine le formulaire derrière la surcouche depuis le modèle, pour que
  // l'auto-sauvegarde (qui relit le DOM) ne réécrive pas d'anciennes valeurs.
  renderSessionContent();
}

function beep() {
  try {
    if (!live.audio) return;
    const ctx = live.audio;
    [0, 0.25].forEach((t) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.2);
    });
  } catch (_) { /* son facultatif */ }
}

function ensureAudio() {
  // Créé sur un geste (appui sur « Valider ») : iOS n'autorise le son qu'ainsi.
  try {
    if (!live.audio) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) live.audio = new Ctx();
    }
    if (live.audio && live.audio.state === "suspended") live.audio.resume();
  } catch (_) { /* son facultatif */ }
}

function tick() {
  if (!live) return;
  cardioTick();
  const chrono = live.el.querySelector("#live-chrono");
  const startedAt = getSessionTimerStart(sessionRuntime.working.date);
  if (chrono) chrono.textContent = startedAt ? formatElapsed(startedAt) : "--:--";
  const rest = live.el.querySelector("#live-rest");
  if (!rest) return;
  if (!live.restEnd) { rest.hidden = true; return; }
  const left = live.restEnd - Date.now();
  rest.hidden = false;
  const fill = rest.querySelector(".live-rest-fill");
  const label = rest.querySelector(".live-rest-time");
  if (left <= 0) {
    label.textContent = "Repos terminé";
    rest.classList.add("done");
    if (fill) fill.style.width = "100%";
    if (!live.beeped) { live.beeped = true; beep(); }
    return;
  }
  rest.classList.remove("done");
  label.textContent = `Repos ${formatDurationMs(left)}`;
  if (fill) fill.style.width = `${Math.min(100, 100 - (left / ((live.restSpan || live.restTotal) * 1000)) * 100)}%`;
}

function fmtLoad(load) {
  if (!load) return "";
  return `${load}${/^[\d.,]+$/.test(load) ? " kg" : ""}`;
}

/** État d'une étape : faite, entamée ou à faire. */
function stepState(session, k) {
  const e = session.exercises[live.indices[k]];
  const n = doneRows(e).length;
  const t = targetCount(e, live.indices[k]);
  return t != null ? (n >= t ? "done" : n > 0 ? "partial" : "") : (n > 0 ? "done" : "");
}

/** Ce qui est prévu pour une étape, en une ligne. */
function stepPlanText(e, idx) {
  if (e.format === "cardio") return cardioPrescription(e);
  if (isBlock(e)) {
    const stations = blockStations(idx).length;
    const rounds = blockRoundsPlanned(e);
    return `${EXERCISE_FORMATS[e.format] || "Bloc"} · ${stations} station${stations > 1 ? "s" : ""}${rounds ? ` · ${rounds} tour${rounds > 1 ? "s" : ""}` : ""}`;
  }
  return plannedLine(e);
}

function stepTitle(e, idx) {
  if (isBlock(e)) {
    const rounds = blockRoundsPlanned(e);
    return `${EXERCISE_FORMATS[e.format] || "Bloc"}${rounds ? ` · ${rounds} tour${rounds > 1 ? "s" : ""}` : ""}`;
  }
  return e.name;
}

/** Aperçu de toute la séance (docs/adr/0114) : chaque étape avec ce qui est
 * prévu et son état ; un tap y va. Remplace l'ancien sélecteur caché. */
function pickerHTML(session) {
  const total = live.indices.length;
  const done = live.indices.filter((_, k) => stepState(session, k) === "done").length;
  return `
    <div class="live-picker">
      <div class="live-picker-head"><strong>La séance · ${done} / ${total} fait${done > 1 ? "s" : ""}</strong><button type="button" class="live-link" data-live="picker-close">Fermer</button></div>
      <ol class="live-picker-list">${live.indices.map((i, k) => {
        const e = session.exercises[i];
        const n = doneRows(e).length;
        const t = targetCount(e, i);
        const state = stepState(session, k);
        const block = isBlock(e);
        const plan = block ? blockStations(i).map((s) => session.exercises[s].name).join(" · ") : stepPlanText(e, i);
        return `<li><button type="button" class="${k === live.pos ? "current" : ""} ${state}" data-goto="${k}">
          <span class="live-picker-num">${state === "done" ? "✓" : k + 1}</span>
          <span class="live-picker-name">${escapeHtmlText(stepTitle(e, i))}${plan ? `<small${block ? ' class="wrap"' : ""}>${escapeHtmlText(plan)}</small>` : ""}</span>
          <span class="live-picker-count">${state === "done" ? "fait" : k === live.pos ? "en cours" : `${n}${t != null ? ` / ${t}` : ""}`}</span></button></li>`;
      }).join("")}</ol>
    </div>`;
}

/** En-tête commun : « Quitter » explicite, chrono, accès à l'aperçu. */
function headHTML(session) {
  const total = live.indices.length;
  const done = live.indices.filter((_, k) => stepState(session, k) === "done").length;
  return `
    <header class="live-head">
      <button type="button" class="live-head-btn" data-live="exit-open">Quitter</button>
      <div class="live-head-text">
        <span class="live-head-name">${escapeHtmlText(session.name || "Séance")}</span>
        <span class="live-head-chrono" id="live-chrono">--:--</span>
      </div>
      <button type="button" class="live-head-btn" data-live="picker" aria-label="Voir toute la séance">☰ ${done}/${total}</button>
    </header>`;
}

/** « Ensuite : … » — ce qui vient après l'étape courante. */
function nextPeekHTML(session, pos) {
  const next = blockEndPos(pos) + 1;
  if (next >= live.indices.length) return "";
  const i = live.indices[next];
  const e = session.exercises[i];
  const plan = stepPlanText(e, i);
  return `<button type="button" class="live-peek" data-goto="${next}"><small>Ensuite</small><span>${escapeHtmlText(isBlock(e) ? (EXERCISE_FORMATS[e.format] || "Bloc") : e.name)}${plan && !isBlock(e) ? ` · ${escapeHtmlText(plan)}` : isBlock(e) ? ` · ${escapeHtmlText(plan.split(" · ").slice(1).join(" · "))}` : ""}</span><span aria-hidden="true">›</span></button>`;
}

/** Feuille « Quitter » : trois issues nommées, plus d'icône ambiguë. */
function exitSheetHTML() {
  return `
    <div class="live-sheet-backdrop" data-live="exit-close"></div>
    <section class="live-sheet live-exit" role="dialog" aria-label="Quitter la séance guidée">
      <div class="live-sheet-head"><strong>Quitter la séance guidée ?</strong><button type="button" class="live-link" data-live="exit-close">Fermer</button></div>
      <button type="button" class="live-exit-choice" data-live="close"><strong>⏸ Mettre en pause</strong><small>Tout est gardé et le chrono continue. Tu reprends avec « Reprendre la séance guidée ».</small></button>
      <button type="button" class="live-exit-choice" data-live="finish"><strong>✓ Terminer la séance</strong><small>Arrête le chrono, puis RPE et durée.</small></button>
      <button type="button" class="live-exit-choice danger" data-live="cancel-run"><strong>✕ Annuler la séance</strong><small>Arrête le chrono et efface ce qui a été saisi depuis le lancement.</small></button>
      <button type="button" class="live-validate" data-live="exit-close">Continuer la séance</button>
    </section>`;
}

/** Branche les contrôles communs (navigation, aperçu, feuille Quitter). */
function wireCommon() {
  live.el.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => {
    live.picker = false;
    goTo(parseInt(b.dataset.goto, 10));
  }));
  live.el.querySelectorAll("[data-live]").forEach((b) => b.addEventListener("click", () => action(b.dataset.live)));
}

function supersetStripHTML(members, pos, session) {
  const targets = members.map((k) => targetCount(session.exercises[live.indices[k]], live.indices[k]));
  const round = live.cursor + 1;
  const max = targets.every((t) => t != null) ? Math.max(...targets) : null;
  return `
    <div class="live-superset">
      <div class="live-superset-head"><span class="pill pill-gold">Superset</span><span>Tour ${max != null ? Math.min(round, max) : round}${max != null ? ` / ${max}` : ""}</span></div>
      <div class="live-superset-members">${members.map((k) => {
        const e = session.exercises[live.indices[k]];
        const n = doneRows(e).length;
        const t = targetCount(e, live.indices[k]);
        return `<button type="button" class="${k === pos ? "current" : ""}${t != null && n >= t ? " done" : ""}" data-goto="${k}"><span>${escapeHtmlText(e.name)}</span><small>${n}${t != null ? ` / ${t}` : ""}</small></button>`;
      }).join("")}</div>
    </div>`;
}

/** Feuille « ressenti sur la série » : type, puis champs selon le type. */
function eventSheetHTML(ex) {
  const sh = live.sheet;
  const existing = setEventsOf(ex, sh.setNo);
  const kinds = EVENT_KINDS.map((k) => `<button type="button" class="suggestion-chip${sh.kind === k.id ? " active" : ""}" data-ev-kind="${k.id}">${k.label}</button>`).join("");
  let form = "";
  if (sh.kind === "douleur") {
    const regions = live.zones ? groupZonesByRegion(live.zones) : null;
    const region = regions && sh.region ? regions.get(sh.region) : null;
    form = !regions
      ? `<p class="muted small">Liste des zones indisponible (hors-ligne ?) — décris la douleur dans la note.</p>`
      : `<div class="live-sheet-label">Zone</div>
         <div class="live-sheet-chips">${[...regions.entries()].map(([key, r]) => `<button type="button" class="suggestion-chip${sh.region === key ? " active" : ""}" data-ev-region="${escapeAttr(key)}">${escapeHtmlText(r.label)}</button>`).join("")}</div>
         ${region && region.sides ? `<div class="live-sheet-chips"><button type="button" class="suggestion-chip${sh.side === "gauche" ? " active" : ""}" data-ev-side="gauche">Gauche</button><button type="button" class="suggestion-chip${sh.side === "droit" ? " active" : ""}" data-ev-side="droit">Droite</button></div>` : ""}
         <div class="live-sheet-label">Niveau${sh.level != null ? ` — ${sh.level} · ${PAIN_LEVEL_LABELS[sh.level]}` : ""}</div>
         <div class="pain-level-grid live-sheet-levels">${Array.from({ length: 11 }, (_, n) => `<button type="button" class="pain-level-btn tier-${painTier(n)}${sh.level === n ? " active" : ""}" data-ev-level="${n}" aria-pressed="${sh.level === n}">${n}</button>`).join("")}</div>`;
  } else if (sh.kind === "exterieur") {
    form = `<div class="live-sheet-label">Qu'est-ce qui s'est passé ?</div>
      <div class="live-sheet-chips">${EXTERNAL_TAGS.map((t) => `<button type="button" class="suggestion-chip${sh.tags.includes(t) ? " active" : ""}" data-ev-tag="${escapeAttr(t)}">${escapeHtmlText(t)}</button>`).join("")}</div>`;
  }
  const ready = eventReady(sh);
  return `
    <div class="live-sheet-backdrop" data-live="event-close"></div>
    <section class="live-sheet" role="dialog" aria-label="Ressenti sur la série">
      <div class="live-sheet-head"><strong>${escapeHtmlText(ex.name)} · série ${sh.setNo}</strong><button type="button" class="live-link" data-live="event-close">Fermer</button></div>
      ${existing.length ? `<ul class="live-sheet-existing">${existing.map((e) => `<li><span><span class="live-event-kind">${escapeHtmlText(eventKindLabel(e.kind))}</span> ${escapeHtmlText(describeEvent(e, live.zones || {}))}</span><button type="button" class="live-link danger" data-ev-del="${escapeAttr(e.at)}" aria-label="Supprimer">✕</button></li>`).join("")}</ul>` : ""}
      <div class="live-sheet-chips kinds">${kinds}</div>
      ${form}
      ${sh.kind ? `<textarea id="ev-note" rows="2" placeholder="${sh.kind === "ressenti" ? "Ce que tu ressens sur cette série…" : "Précision (facultatif)"}">${escapeHtmlText(sh.note || "")}</textarea>
      <button type="button" class="live-validate" data-live="event-save"${ready ? "" : " disabled"}>Ajouter à la série ${sh.setNo}</button>` : `<p class="muted small">Choisis le type de ressenti à rattacher à cette série.</p>`}
    </section>`;
}

function render() {
  const { session } = sessionRuntime.working;
  const indices = live.indices;
  const pos = live.pos;
  const idx = indices[pos];
  const ex = session.exercises[idx];
  if (!live.picker && ex.format === "cardio") { renderCardio(session, ex, idx, pos); return; }
  if (!live.picker && isBlock(ex)) { renderBlock(session, ex, idx, pos); return; }
  const rows = doneRows(ex);
  const target = targetCount(ex, idx);
  if (live.cursor > rows.length) live.cursor = rows.length;
  const editing = live.cursor < rows.length;
  const reached = !editing && target != null && rows.length >= target;
  const members = membersOf(pos);
  const isLastEx = blockEndPos(pos) === indices.length - 1;
  const pending = reached ? nextMember(pos, true) : null;
  const setNo = live.cursor + 1;
  const d = live.draft;
  const segs = indices.map((i, k) => {
    const e = session.exercises[i];
    const t = targetCount(e, i);
    const n = doneRows(e).length;
    const cls = k === pos ? "current" : (t != null ? n >= t : n > 0) ? "done" : "";
    return `<span class="live-seg ${cls}"></span>`;
  }).join("");
  const supersetNote = members ? supersetStripHTML(members, pos, session) : "";
  const lastTime = lastTimeText(ex.name);
  const ofTarget = target != null ? ` / ${target}` : "";

  const doneList = rows.length ? `<ol class="live-done">${rows.map((r, i) => `
      <li><button type="button" class="${i === live.cursor ? "editing" : ""}" data-set="${i}" aria-label="Modifier la série ${i + 1}">
        <span class="live-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></span>
        <span>Série ${i + 1}</span>
        <span class="live-done-val">${escapeHtmlText([fmtLoad(r.load), r.reps ? `× ${r.reps}` : ""].filter(Boolean).join(" "))}</span>
        <span class="live-done-rir">${r.rir !== "" && r.rir != null ? `RIR ${escapeHtmlText(r.rir)}` : ""}${setEventsOf(ex, i + 1).length ? `<span class="live-event-flag" title="Ressenti noté">⚑</span>` : ""}</span>
      </button></li>`).join("")}</ol>` : "";

  const setCard = reached ? `
      <button type="button" class="live-add-set big" data-live="add-set"><span aria-hidden="true">+</span>Ajouter une série<small>montée en charge, série en plus…</small></button>
      <button type="button" class="live-link live-event-link" data-live="event-open">+ Ressenti sur la dernière série</button>` : `
      <section class="live-set${editing ? " editing" : ""}">
        <div class="live-set-head">
          <strong>${editing ? `Modifier la série ${setNo}` : `Série ${setNo}${ofTarget}`}</strong>
          <span>${editing ? "déjà validée" : rows.length ? "pré-rempli avec la série précédente" : "pré-rempli avec le prévu"}</span>
          <button type="button" class="live-event-add" data-live="event-open" aria-label="Ajouter un ressenti à la série ${setNo}" title="Ressenti, douleur, imprévu…">+${setEventsOf(ex, setNo).length ? `<span class="live-event-count">${setEventsOf(ex, setNo).length}</span>` : ""}</button>
        </div>
        ${setEventsOf(ex, setNo).length ? `<ul class="live-events">${setEventsOf(ex, setNo).map((e) => `<li><span class="live-event-kind">${escapeHtmlText(eventKindLabel(e.kind))}</span> ${escapeHtmlText(describeEvent(e, live.zones))}</li>`).join("")}</ul>` : ""}
        <div class="live-steppers">
          <label class="live-stepper"><span>Charge${(ex.planned || {}).load_per_hand ? " / main" : ""}</span>
            <span class="live-stepper-row"><button type="button" data-live="load-" aria-label="Moins 2,5">−</button><input type="text" inputmode="decimal" id="live-load" value="${escapeAttr(d.load)}" aria-label="Charge"><button type="button" data-live="load+" aria-label="Plus 2,5">+</button></span></label>
          <label class="live-stepper"><span>Reps / temps</span>
            <span class="live-stepper-row"><button type="button" data-live="reps-" aria-label="Moins une rep">−</button><input type="text" inputmode="numeric" id="live-reps" value="${escapeAttr(d.reps)}" aria-label="Reps"><button type="button" data-live="reps+" aria-label="Plus une rep">+</button></span></label>
        </div>
        <div class="live-rir"><span>Reps en réserve (RIR)</span>
          <div class="live-rir-row">${RIR_CHOICES.map((v) => `<button type="button" class="${d.rir === v ? "on" : ""}" data-rir="${v}">${v === "4" ? "4+" : v}</button>`).join("")}</div>
        </div>
        <div class="live-set-actions">
          ${editing
            ? `<button type="button" class="live-link danger" data-live="delete-set">Supprimer cette série</button><button type="button" class="live-link" data-live="cancel-edit">Annuler</button>`
            : `<button type="button" class="live-link" data-live="add-set">+ Ajouter une série</button>`}
        </div>
      </section>`;

  // Navigation série par série ; le changement d'exercice est toujours
  // nommé comme tel (jamais un « Suivant » ambigu).
  const prevLabel = live.cursor > 0 ? "← Série précédente" : pos > 0 ? "← Exercice précédent" : "";
  const nextLabel = editing ? "Série suivante →" : !isLastEx ? "Exercice suivant →" : "";

  let primary;
  if (editing) primary = `<button type="button" class="live-validate" data-live="save-edit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>Enregistrer la série ${setNo}</button>`;
  else if (pending) primary = `<button type="button" class="live-validate" data-live="next-member">${escapeHtmlText(session.exercises[live.indices[pending.pos]].name)} →</button>`;
  else if (reached && !isLastEx) primary = `<button type="button" class="live-validate" data-live="next-ex">Exercice suivant →</button>`;
  else if (reached) primary = `<button type="button" class="live-validate" data-live="finish">Terminer la séance</button>`;
  else primary = `<button type="button" class="live-validate" data-live="validate"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>Valider la série ${setNo}${ofTarget}</button>`;

  live.el.innerHTML = `
    ${headHTML(session)}
    <div class="live-segs" aria-hidden="true">${segs}</div>
    <main class="live-body">
      ${live.picker ? pickerHTML(session) : `
      <div class="live-ex-head">
        <p class="live-kicker">Exercice ${pos + 1} / ${indices.length}${plannedLine(ex) ? ` · objectif ${escapeHtmlText(plannedLine(ex))}` : ""}</p>
        <h2 class="live-ex-name">${escapeHtmlText(ex.name)}</h2>
        ${supersetNote}
        ${lastTime ? `<p class="live-last">${escapeHtmlText(lastTime)}</p>` : ""}
        ${hintHTML(ex)}
        ${ex.notes ? `<p class="live-notes">${escapeHtmlText(ex.notes)}</p>` : ""}
      </div>
      ${doneList}
      ${setCard}
      <div class="live-nav">
        ${prevLabel ? `<button type="button" data-live="prev">${prevLabel}</button>` : "<span></span>"}
        ${nextLabel ? `<button type="button" data-live="next">${nextLabel}</button>` : "<span></span>"}
      </div>
      ${nextPeekHTML(session, pos)}`}
    </main>
    <footer class="live-foot">
      <div class="live-rest" id="live-rest" hidden>
        <div class="live-rest-bar"><div class="live-rest-fill"></div></div>
        <span class="live-rest-time">Repos</span>
        <div class="live-rest-choices">${REST_CHOICES.map((s) => `<button type="button" class="${s === live.restTotal ? "on" : ""}" data-rest="${s}">${s < 60 ? s + " s" : (s / 60).toString().replace(".", ",") + " min"}</button>`).join("")}<button type="button" data-live="skip-rest">Passer</button></div>
      </div>
      ${live.picker ? "" : primary}
    </footer>
    ${live.sheet ? eventSheetHTML(ex) : ""}
    ${live.exit ? exitSheetHTML() : ""}`;

  const loadInput = live.el.querySelector("#live-load");
  const repsInput = live.el.querySelector("#live-reps");
  if (loadInput) loadInput.addEventListener("input", () => { live.draft.load = loadInput.value; });
  if (repsInput) repsInput.addEventListener("input", () => { live.draft.reps = repsInput.value; });
  live.el.querySelectorAll("[data-rir]").forEach((b) => b.addEventListener("click", () => {
    live.draft.rir = live.draft.rir === b.dataset.rir ? "" : b.dataset.rir;
    render();
  }));
  live.el.querySelectorAll("[data-rest]").forEach((b) => b.addEventListener("click", () => {
    const s = parseInt(b.dataset.rest, 10);
    live.restTotal = s;
    setRestSeconds(s);
    if (live.restEnd) { live.restEnd = live.restStart + s * 1000; live.beeped = false; }
    render();
  }));
  live.el.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => {
    const i = parseInt(b.dataset.set, 10);
    setCursor(live.cursor === i ? doneRows(ex).length : i);
  }));
  wireCommon();
  wireEventSheet(ex);
  tick();
}

// ---------------------------------------------------------------- Cardio

function segsHTML(session) {
  return live.indices.map((i, k) => {
    const e = session.exercises[i];
    const t = targetCount(e, i);
    const n = doneRows(e).length;
    const cls = k === live.pos ? "current" : (t != null ? n >= t : n > 0) ? "done" : "";
    return `<span class="live-seg ${cls}"></span>`;
  }).join("");
}

function cardioRounds(ex) {
  const planned = parseInt((ex.planned || {}).sets, 10);
  const have = ((ex.executed || {}).intervals || []).length;
  return Math.max(Number.isFinite(planned) && planned > 0 ? planned : 1, have);
}

function cardioRunFor(idx) {
  if (!live.cardio || live.cardio.idx !== idx) live.cardio = { idx, phase: "ready", round: 1, end: null, left: null, paused: false };
  return live.cardio;
}

function phaseDuration(ex, phase) {
  const p = ex.planned || {};
  if (phase === "rest") return restAfter(p, live.cardio ? live.cardio.round : 1) * 1000;
  return (num(p.work_s) || 0) * 1000;
}

async function keepAwake(on) {
  try {
    if (on && !live.wakeLock && navigator.wakeLock) live.wakeLock = await navigator.wakeLock.request("screen");
    if (!on && live.wakeLock) { await live.wakeLock.release(); live.wakeLock = null; }
  } catch (_) { /* facultatif */ }
}

/** Passe à la phase suivante : effort → repos → effort du round suivant… */
function cardioAdvance(ex) {
  const run = live.cardio;
  const rounds = cardioRounds(ex);
  const restMs = phaseDuration(ex, "rest");
  if (run.phase === "work") {
    run.completed = run.round;
    if (isShortIntervals(ex.planned) && ex.entry_mode !== "rounds") {
      const e = ex.executed || {};
      writeCardioTotal(ex, { rounds_done: run.completed, total_cal: e.entry === "total" ? e.total_cal : null, total_distance_m: e.entry === "total" ? e.total_distance_m : null });
    }
    if (run.round >= rounds) { run.phase = "done"; run.end = null; keepAwake(false); }
    else if (restMs > 0) { run.phase = "rest"; run.end = Date.now() + restMs; }
    else { run.round += 1; run.phase = "work"; run.end = Date.now() + phaseDuration(ex, "work"); }
  } else if (run.phase === "rest") {
    run.round += 1; run.phase = "work"; run.end = Date.now() + phaseDuration(ex, "work");
  }
  beep();
}

function cardioTick() {
  const run = live.cardio;
  if (!run || run.paused || !run.end) return;
  const ex = sessionRuntime.working.session.exercises[run.idx];
  if (!ex) return;
  if (Date.now() >= run.end) {
    cardioAdvance(ex);
    if (live.indices[live.pos] === run.idx && !live.picker) render();
    return;
  }
  const clock = live.el.querySelector("#cardio-clock");
  if (clock) clock.textContent = fmtDuration((run.end - Date.now()) / 1000);
  const fill = live.el.querySelector(".cardio-phase-fill");
  const total = phaseDuration(ex, run.phase);
  if (fill && total) fill.style.width = `${Math.min(100, 100 - ((run.end - Date.now()) / total) * 100)}%`;
}

function cardioLastText(name) {
  const hist = live.cardioHistory || {};
  const key = Object.keys(hist).find((k) => normalizeName(k) === normalizeName(name));
  const rows = key ? hist[key].filter((r) => r.date !== sessionRuntime.working.date) : [];
  const last = rows[rows.length - 1];
  if (!last) return "";
  const headline = headlineMetric(last.machine, last);
  return `Dernière fois (${last.date.slice(8, 10)}/${last.date.slice(5, 7)}) : ${[headline, totalsLine(last)].filter(Boolean).join(" · ")}`;
}

function renderCardio(session, ex, idx, pos) {
  const run = cardioRunFor(idx);
  const machine = MACHINES[ex.machine] || { label: "Cardio", icon: "🫀", pace: false };
  const short = isShortIntervals(ex.planned) && ex.entry_mode !== "rounds";          // total machine en fin d'exercice
  const rounds = cardioRounds(ex);
  const intervals = ((ex.executed || {}).intervals || []).slice();
  while (intervals.length < rounds) intervals.push({});
  const workS = num((ex.planned || {}).work_s);
  const stats = cardioStats(ex);
  const headline = headlineMetric(ex.machine, stats);
  const isLast = pos === live.indices.length - 1;
  const showHr = !short && (!!ex.track_hr || intervals.some((r) => num(r.hr_avg) != null));
  const showTime = !short && (!!live.cardioShowTime || intervals.some((r) => num(r.time_s) != null && num(r.time_s) !== workS));
  const unit = primaryUnit(ex);
  const unitLabel = unit === "cal" ? "Calories" : "Distance (m)";
  const target = (ex.planned || {}).target;
  const exd = ex.executed || {};

  const block = blockSize(ex.planned);
  const seriesRest = run.phase === "rest" && block && run.round % block === 0;
  const phaseLabel = { ready: "Prêt", work: "Effort", rest: seriesRest ? "Repos entre séries" : "Repos", done: "Terminé" }[run.phase];
  const remaining = run.end ? Math.max(0, run.end - Date.now()) / 1000 : run.phase === "ready" ? (workS || 0) : 0;
  const entryRound = run.phase === "rest" ? run.round : run.phase === "done" ? rounds : null;
  const hint = short
    ? (run.phase === "done" ? "Note le total affiché par la machine." : run.phase === "ready" ? "Lance le chrono ; tu noteras seulement le total à la fin." : target ? `Cible : ${target}` : "Tiens l'intensité.")
    : run.phase === "rest" ? `Note le round ${run.round} pendant le repos.`
    : run.phase === "work" ? (target ? `Cible : ${target}` : "Tiens l'allure.")
    : run.phase === "done" ? "Complète les rounds manquants puis passe à la suite."
    : "Lance le chrono quand tu es installé.";

  const controls = run.phase === "ready"
    ? `<button type="button" class="cardio-ctl primary" data-cardio="start">▶ Démarrer</button>`
    : run.phase === "done"
      ? `<button type="button" class="cardio-ctl" data-cardio="reset">↺ Recommencer le chrono</button>`
      : `<button type="button" class="cardio-ctl" data-cardio="${run.paused ? "resume" : "pause"}">${run.paused ? "▶ Reprendre" : "❚❚ Pause"}</button>
         <button type="button" class="cardio-ctl" data-cardio="skip">Passer ⏭</button>
         <button type="button" class="cardio-ctl ghost" data-cardio="reset">Arrêter</button>`;

  // Intervalles courts : un seul bloc « total » ; sinon une ligne par round
  // avec la seule mesure suivie (distance ou calories).
  const entryHTML = short ? `
      <section class="cardio-total" aria-label="Total de l'exercice">
        <label><span>Rounds faits</span><input type="text" inputmode="numeric" data-total="rounds_done" value="${escapeAttr(cardioRoundsDone(ex) || "")}" placeholder="${rounds}"></label>
        <label><span>Total calories</span><input type="text" inputmode="numeric" data-total="total_cal" value="${escapeAttr(exd.entry === "total" && exd.total_cal != null ? exd.total_cal : "")}" placeholder="—"></label>
        <label><span>Total distance (m)</span><input type="text" inputmode="numeric" data-total="total_distance_m" value="${escapeAttr(exd.entry === "total" && exd.total_distance_m != null ? exd.total_distance_m : "")}" placeholder="—"></label>
      </section>
      <p class="muted small cardio-total-help">Lis le total sur l'écran de la machine à la fin : pas besoin de noter chaque round. Un seul des deux suffit.</p>` : `
      <div class="cardio-unit" role="group" aria-label="Mesure notée à chaque round">
        <span>Je note</span>
        <button type="button" class="${unit === "distance_m" ? "on" : ""}" data-cardio="unit-distance_m">la distance</button>
        <button type="button" class="${unit === "cal" ? "on" : ""}" data-cardio="unit-cal">les calories</button>
      </div>
      <section class="cardio-live-rows${showTime ? " with-time" : ""}${showHr ? " with-hr" : ""}" aria-label="Rounds">${intervals.map((r, i) => `
      <div class="cardio-live-row${entryRound === i + 1 || (run.phase === "work" && run.round === i + 1) ? " current" : ""}${filledIntervals({ intervals: [r] }).length ? " filled" : ""}">
        <span class="cardio-live-num">${i + 1}</span>
        <label><span>${unitLabel}</span><input type="text" inputmode="numeric" data-ci="${i}" data-field="${unit}" value="${escapeAttr(r[unit] ?? "")}" placeholder="—"></label>
        ${showTime ? `<label><span>Temps</span><input type="text" inputmode="numeric" data-ci="${i}" data-field="time_s" value="${escapeAttr(num(r.time_s) != null ? fmtDuration(num(r.time_s)) : "")}" placeholder="${escapeAttr(workS ? fmtDuration(workS) : "m:ss")}"></label>` : ""}
        ${showHr ? `<label><span>FC moy.</span><input type="text" inputmode="numeric" data-ci="${i}" data-field="hr_avg" value="${escapeAttr(r.hr_avg ?? "")}" placeholder="—"></label>` : ""}
      </div>`).join("")}</section>
      <div class="cardio-live-actions">
        <button type="button" class="live-link" data-cardio="add-round">+ Round</button>
        <button type="button" class="live-link" data-cardio="time">${showTime ? "Masquer les temps" : "Round écourté ?"}</button>
        <label class="cardio-hr-toggle"><input type="checkbox" data-cardio="hr"${showHr ? " checked" : ""}> FC</label>
      </div>`;

  const last = cardioLastText(ex.name);
  live.el.innerHTML = `
    ${headHTML(session)}
    <div class="live-segs" aria-hidden="true">${segsHTML(session)}</div>
    <main class="live-body">
      <div class="live-ex-head">
        <p class="live-kicker">Exercice ${pos + 1} / ${live.indices.length} · ${escapeHtmlText(machine.icon + " " + machine.label)}</p>
        <h2 class="live-ex-name">${escapeHtmlText(ex.name)}</h2>
        <p class="live-last">${escapeHtmlText(cardioPrescription(ex))}</p>
        ${last ? `<p class="live-last">${escapeHtmlText(last)}</p>` : ""}
        ${ex.notes ? `<p class="live-notes">${escapeHtmlText(ex.notes)}</p>` : ""}
      </div>
      <section class="cardio-timer phase-${run.phase}${run.paused ? " paused" : ""}">
        <div class="cardio-phase"><span>${phaseLabel}${run.paused ? " (pause)" : ""}</span><span>${block ? `Série ${Math.ceil(Math.min(run.round, rounds) / block)} · ` : ""}Round ${Math.min(run.round, rounds)} / ${rounds}</span></div>
        <div class="cardio-clock" id="cardio-clock" aria-live="off">${fmtDuration(remaining)}</div>
        <div class="cardio-phase-bar"><div class="cardio-phase-fill"></div></div>
        <p class="cardio-hint">${escapeHtmlText(hint)}</p>
        <div class="cardio-controls">${controls}</div>
      </section>
      ${entryHTML}
      <p class="cardio-live-summary" id="cardio-summary">${escapeHtmlText([totalsLine(stats), headline].filter(Boolean).join(" · ")) || "Rien de saisi pour l'instant."}</p>
      <div class="live-nav">
        ${pos > 0 ? `<button type="button" data-live="prev-ex">← Exercice précédent</button>` : "<span></span>"}
        ${!isLast ? `<button type="button" data-live="next-ex">Exercice suivant →</button>` : "<span></span>"}
      </div>
      ${nextPeekHTML(session, pos)}
    </main>
    <footer class="live-foot">
      ${!isLast ? `<button type="button" class="live-validate" data-live="next-ex">Exercice suivant →</button>` : `<button type="button" class="live-validate" data-live="finish">Terminer la séance</button>`}
    </footer>
    ${live.exit ? exitSheetHTML() : ""}`;

  const refreshSummary = () => {
    const sum = live.el.querySelector("#cardio-summary");
    const st = cardioStats(ex);
    if (sum) sum.textContent = [totalsLine(st), headlineMetric(ex.machine, st)].filter(Boolean).join(" · ") || "Rien de saisi pour l'instant.";
  };
  const commit = () => {
    if (short) {
      const val = (k) => { const inp = live.el.querySelector(`[data-total="${k}"]`); return inp ? inp.value : null; };
      const typed = val("rounds_done");
      const hasTotal = (val("total_cal") || "").trim() || (val("total_distance_m") || "").trim();
      // Rounds faits : la saisie, sinon ce que le chrono a compté, sinon le
      // prévu dès qu'un total est noté.
      const counted = live.cardio && live.cardio.idx === idx ? live.cardio.completed || 0 : 0;
      const roundsDone = (typed || "").trim() ? typed : (counted || (hasTotal ? rounds : (exd.entry === "total" ? exd.rounds_done : 0)));
      writeCardioTotal(ex, { rounds_done: roundsDone, total_cal: val("total_cal"), total_distance_m: val("total_distance_m") });
    } else {
      const rows = intervals.map((r, i) => {
        const rowEl = live.el.querySelectorAll(".cardio-live-row")[i];
        const val = (f) => { const inp = rowEl && rowEl.querySelector(`[data-field="${f}"]`); return inp ? inp.value : r[f]; };
        const t = val("time_s");
        return { time_s: typeof t === "string" ? (t.trim() ? parseClock(t) : null) : t, distance_m: val("distance_m"), cal: val("cal"), hr_avg: val("hr_avg") };
      });
      writeCardioExecuted(ex, rows);
    }
    refreshSummary();
  };
  live.el.querySelectorAll(".cardio-live-row input, .cardio-total input").forEach((inp) => {
    inp.addEventListener("input", commit);
    inp.addEventListener("change", () => { commit(); renderSessionContent(); });
  });
  live.el.querySelectorAll("[data-cardio]").forEach((b) => b.addEventListener(b.type === "checkbox" ? "change" : "click", () => {
    const what = b.dataset.cardio;
    commit();
    if (what === "start") { ensureAudio(); keepAwake(true); run.phase = "work"; run.round = 1; run.completed = 0; run.paused = false; run.end = Date.now() + phaseDuration(ex, "work"); }
    else if (what === "pause") { run.paused = true; run.left = run.end - Date.now(); }
    else if (what === "resume") { run.paused = false; run.end = Date.now() + (run.left || 0); }
    else if (what === "skip") { run.paused = false; cardioAdvance(ex); }
    else if (what === "reset") { keepAwake(false); live.cardio = null; }
    else if (what === "add-round") { const list = ((ex.executed || {}).intervals || []).slice(); while (list.length < cardioRounds(ex)) list.push({}); list.push({}); writeCardioExecuted(ex, list); }
    else if (what === "hr") { ex.track_hr = b.checked; }
    else if (what === "time") { live.cardioShowTime = !showTime; }
    else if (what.startsWith("unit-")) { ex.unit = what.slice(5); }
    renderSessionContent();
    render();
  }));
  wireCommon();
  tick();
}

// ---------------------------------------------------------------- Blocs (circuit, AMRAP, EMOM…)

function fmtRest(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const s = seconds % 60;
  return `${Math.floor(seconds / 60)} min${s ? ` ${String(s).padStart(2, "0")}` : ""}`;
}

/** Un bloc dans la séance guidée (docs/adr/0114). Circuit : les stations avec
 * leur charge pré-remplie, un tap valide un tour entier (écrit séries, reps et
 * charge sur chaque station, comme un exercice classique, donc compté dans le
 * tonnage et l'historique) ; le repos entre tours démarre seul. Autres
 * formats : les stations, puis le résultat du bloc. */
function renderBlock(session, ex, idx, pos) {
  const stationIdx = blockStations(idx);
  const stations = stationIdx.map((i) => session.exercises[i]);
  const isCircuit = ex.format === "circuit";
  const meta = ex.block_meta || {};
  const done = doneRows(ex).length;
  const target = targetCount(ex, idx) || 1;
  const reached = done >= target;
  const isLast = pos === live.indices.length - 1;
  if (!live.blockStart[idx]) live.blockStart[idx] = Date.now();
  if (!live.blockLoads[idx]) {
    live.blockLoads[idx] = stations.map((st) => {
      const l = (st.executed || {}).load ?? (st.planned || {}).load;
      return l != null ? String(l) : "";
    });
  }
  const loads = live.blockLoads[idx];
  const label = EXERCISE_FORMATS[ex.format] || "Bloc";
  const metaLine = isCircuit
    ? [`${target} tour${target > 1 ? "s" : ""}`, meta.rest_seconds ? `repos ${fmtRest(meta.rest_seconds)} entre les tours` : ""].filter(Boolean).join(" · ")
    : [meta.duration_min ? `${meta.duration_min} min` : "", meta.round_seconds ? `tours de ${meta.round_seconds} s` : "", meta.rounds ? `${meta.rounds} tours` : ""].filter(Boolean).join(" · ");

  const stationsHTML = stations.map((st, k) => {
    const p = st.planned || {};
    return `
      <div class="live-station">
        <span class="live-station-num">${k + 1}</span>
        <span class="live-station-text"><strong>${escapeHtmlText(st.name)}</strong>${p.reps ? `<small>× ${escapeHtmlText(String(p.reps))}</small>` : ""}${st.notes && k > 0 ? `<small class="live-station-note">${escapeHtmlText(st.notes)}</small>` : ""}</span>
        ${isCircuit
          ? `<label class="live-station-load"><input type="text" inputmode="decimal" data-station="${k}" value="${escapeAttr(loads[k])}" placeholder="PDC" aria-label="Charge de ${escapeAttr(st.name)}"><small>kg${p.load_per_hand ? " / main" : ""}</small></label>`
          : (p.load != null && p.load !== "" ? `<span class="live-station-fixed">${escapeHtmlText(String(p.load))} kg${p.load_per_hand ? " / main" : ""}</span>` : "")}
      </div>`;
  }).join("");

  const roundsHTML = isCircuit
    ? `<div class="live-rounds" aria-label="Tours">${Array.from({ length: target }, (_, r) => `<span class="${r < done ? "done" : r === done ? "current" : ""}">${r < done ? "✓" : r + 1}</span>`).join("")}<strong>${reached ? "Circuit terminé" : `Tour ${done + 1} / ${target}`}</strong></div>`
    : "";

  let primary;
  if (isCircuit && !reached) primary = `<button type="button" class="live-validate" data-block="round"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>Tour ${done + 1} / ${target} terminé</button>`;
  else if (!isCircuit && !reached) primary = `<button type="button" class="live-validate" data-block="result"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>Bloc terminé</button>`;
  else if (!isLast) primary = `<button type="button" class="live-validate" data-live="next-ex">Exercice suivant →</button>`;
  else primary = `<button type="button" class="live-validate" data-live="finish">Terminer la séance</button>`;

  live.el.innerHTML = `
    ${headHTML(session)}
    <div class="live-segs" aria-hidden="true">${segsHTML(session)}</div>
    <main class="live-body">
      <div class="live-ex-head">
        <p class="live-kicker">Exercice ${pos + 1} / ${live.indices.length} · ${escapeHtmlText(label)}</p>
        <h2 class="live-ex-name">${escapeHtmlText(label)} · ${stations.length} station${stations.length > 1 ? "s" : ""}</h2>
        ${metaLine ? `<p class="live-last">${escapeHtmlText(metaLine)}</p>` : ""}
        ${ex.notes ? `<p class="live-notes">${escapeHtmlText(ex.notes)}</p>` : ""}
      </div>
      ${roundsHTML}
      <section class="live-stations">${stationsHTML}</section>
      ${isCircuit
        ? `<p class="muted small live-block-help">Enchaîne les stations ; les charges sont pré-remplies avec le prévu, corrige seulement ce qui a changé. Un tap valide tout le tour.</p>
           <div class="live-set-actions">${done > 0 ? `<button type="button" class="live-link danger" data-block="undo">Annuler le dernier tour</button>` : "<span></span>"}${reached ? `<button type="button" class="live-link" data-block="more">+ Tour supplémentaire</button>` : ""}</div>`
        : `<label class="live-block-result"><span>Résultat du bloc (facultatif)</span><input type="text" id="live-block-result" value="${escapeAttr((ex.executed || {}).reps && (ex.executed || {}).reps !== "fait" ? (ex.executed || {}).reps : "")}" placeholder="ex. 5 tours + 8 reps, 12:30…"></label>
           ${reached ? `<div class="live-set-actions"><button type="button" class="live-link danger" data-block="undo">Marquer comme non fait</button></div>` : ""}`}
      <div class="live-nav">
        ${pos > 0 ? `<button type="button" data-live="prev-ex">← Exercice précédent</button>` : "<span></span>"}
        ${!isLast ? `<button type="button" data-live="next-ex">Exercice suivant →</button>` : "<span></span>"}
      </div>
      ${nextPeekHTML(session, pos)}
    </main>
    <footer class="live-foot">
      <div class="live-rest" id="live-rest" hidden>
        <div class="live-rest-bar"><div class="live-rest-fill"></div></div>
        <span class="live-rest-time">Repos</span>
        <div class="live-rest-choices"><button type="button" data-live="skip-rest">Passer</button></div>
      </div>
      ${primary}
    </footer>
    ${live.exit ? exitSheetHTML() : ""}`;

  live.el.querySelectorAll("[data-station]").forEach((inp) => inp.addEventListener("input", () => { loads[+inp.dataset.station] = inp.value; }));
  const writeRounds = (n) => {
    stations.forEach((st, k) => {
      const p = st.planned || {};
      const load = (loads[k] || "").trim().replace(",", ".");
      st.executed = n > 0
        ? { sets: String(n), reps: p.reps != null ? String(p.reps) : null, load: load || null, load_per_hand: !!p.load_per_hand }
        : { sets: null, reps: null, load: null };
    });
    ex.block_result = n > 0 ? `${n} tour${n > 1 ? "s" : ""}` : null;
  };
  live.el.querySelectorAll("[data-block]").forEach((b) => b.addEventListener("click", () => {
    const what = b.dataset.block;
    if (what === "round") {
      ensureAudio();
      writeRounds(done + 1);
      if (done + 1 >= target) {
        // Durée réalisée du circuit, mesurée de l'ouverture au dernier tour.
        const minutes = Math.round(((Date.now() - live.blockStart[idx]) / 60000) * 2) / 2;
        if (ex.executed_duration_min == null && minutes > 0) ex.executed_duration_min = minutes;
        live.restEnd = null;
      } else {
        const restS = parseInt(meta.rest_seconds, 10) || live.restTotal;
        live.restStart = Date.now();
        live.restEnd = live.restStart + restS * 1000;
        live.restSpan = restS;
        live.beeped = false;
      }
    } else if (what === "undo") {
      if (isCircuit) writeRounds(Math.max(0, done - 1));
      else { ex.executed = { sets: null, reps: null, load: null }; }
      if (live.targets[idx] != null) live.targets[idx] = Math.max(plannedCount(ex) || 1, live.targets[idx] - 1);
    } else if (what === "more") {
      live.targets[idx] = target + 1;
    } else if (what === "result") {
      const input = live.el.querySelector("#live-block-result");
      ex.executed = { ...(ex.executed || { sets: null, load: null }), reps: (input && input.value.trim()) || "fait" };
    }
    renderSessionContent();
    render();
  }));
  wireCommon();
  tick();
}

/** « 4:05 » → 245 ; « 245 » → 245 (secondes). */
function parseClock(text) {
  const t = String(text).trim();
  const m = t.match(/^(\d+)[:'’](\d{1,2})$/);
  if (m) return +m[1] * 60 + +m[2];
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function wireEventSheet(ex) {
  const sh = live.sheet;
  if (!sh) return;
  const on = (sel, fn) => live.el.querySelectorAll(sel).forEach((b) => b.addEventListener("click", () => { fn(b); render(); }));
  on("[data-ev-kind]", (b) => { sh.kind = b.dataset.evKind; });
  on("[data-ev-region]", (b) => {
    sh.region = b.dataset.evRegion; sh.side = null;
    const region = live.zones ? groupZonesByRegion(live.zones).get(sh.region) : null;
    sh.zone = region && region.zone ? region.zone : null;
  });
  on("[data-ev-side]", (b) => {
    sh.side = b.dataset.evSide;
    const region = groupZonesByRegion(live.zones).get(sh.region);
    sh.zone = region && region.sides ? region.sides[sh.side] : null;
  });
  on("[data-ev-level]", (b) => { sh.level = Number(b.dataset.evLevel); });
  on("[data-ev-tag]", (b) => { const t = b.dataset.evTag; sh.tags = sh.tags.includes(t) ? sh.tags.filter((x) => x !== t) : [...sh.tags, t]; });
  on("[data-ev-del]", (b) => { removeSetEvent(ex, b.dataset.evDel, { date: sessionRuntime.working.date }); renderSessionContent(); });
  const note = live.el.querySelector("#ev-note");
  if (note) note.addEventListener("input", () => {
    sh.note = note.value;
    const save = live.el.querySelector('[data-live="event-save"]');
    if (save) save.disabled = !eventReady(sh);
  });
}

function eventReady(sh) {
  if (sh.kind === "douleur") return live.zones ? !!(sh.zone && sh.level != null) : !!(sh.note || "").trim();
  if (sh.kind === "exterieur") return sh.tags.length > 0 || !!(sh.note || "").trim();
  return sh.kind === "ressenti" && !!(sh.note || "").trim();
}

function scrollTop() {
  live.el.scrollTop = 0;
  const body = live.el.querySelector(".live-body");
  if (body) body.scrollTop = 0;
}

function setCursor(cursor) {
  const ex = sessionRuntime.working.session.exercises[live.indices[live.pos]];
  live.cursor = cursor;
  live.draft = draftAtCursor(ex);
  render();
}

/** Ouvre un exercice ; `atEnd` place le curseur sur sa dernière série faite
 * (retour arrière depuis l'exercice suivant), sinon sur la prochaine à faire. */
function goTo(pos, atEnd = false) {
  live.pos = pos;
  live.sheet = null;
  live.exit = false;
  const ex = sessionRuntime.working.session.exercises[live.indices[pos]];
  const n = doneRows(ex).length;
  live.cursor = atEnd && n > 0 ? n - 1 : n;
  live.draft = draftAtCursor(ex);
  render();
  scrollTop();
}

function startRest() {
  live.restSpan = null;
  live.restStart = Date.now();
  live.restEnd = live.restStart + live.restTotal * 1000;
  live.beeped = false;
}

function action(name) {
  const idx = live.indices[live.pos];
  const ex = sessionRuntime.working.session.exercises[idx];
  const rows = doneRows(ex);
  switch (name) {
    case "close": closeLiveMode(); break;
    case "hint-apply": {
      const hint = hintFor(sessionRuntime.working.session.exercises[live.indices[live.pos]]);
      if (hint && hint.load != null) {
        live.draft.load = String(hint.load).replace(".", ",");
        if (/^\d+$/.test(String(hint.reps || ""))) live.draft.reps = String(hint.reps);
        render();
      }
      break;
    }
    case "exit-open": live.exit = true; live.picker = false; render(); break;
    case "exit-close": live.exit = false; render(); break;
    case "finish": {
      closeLiveMode();
      const stop = document.getElementById("stop-timer");
      if (stop) stop.click();
      break;
    }
    case "cancel-run": {
      cancelSessionRun().catch(() => {});
      break;
    }
    case "picker": live.picker = !live.picker; live.exit = false; render(); scrollTop(); break;
    case "picker-close": live.picker = false; render(); break;
    case "load-": live.draft.load = step(live.draft.load, -2.5); render(); break;
    case "load+": live.draft.load = step(live.draft.load, 2.5); render(); break;
    case "reps-": live.draft.reps = step(live.draft.reps, -1); render(); break;
    case "reps+": live.draft.reps = step(live.draft.reps, 1); render(); break;
    case "prev":
      if (live.cursor > 0) setCursor(live.cursor - 1);
      else if (live.pos > 0) goTo(live.pos - 1, true);
      break;
    case "next":
      if (live.cursor < rows.length) setCursor(live.cursor + 1);
      else if (blockEndPos(live.pos) < live.indices.length - 1) goTo(blockEndPos(live.pos) + 1);
      break;
    case "prev-ex": if (live.pos > 0) goTo(live.pos - 1, true); break;
    case "next-ex": if (blockEndPos(live.pos) < live.indices.length - 1) goTo(blockEndPos(live.pos) + 1); break;
    case "next-member": { const nm = nextMember(live.pos, true); if (nm) goTo(nm.pos); break; }
    case "event-open": {
      const editing = live.cursor < rows.length;
      const target = targetCount(ex, idx);
      const reached = !editing && target != null && rows.length >= target;
      const setNo = reached ? Math.max(1, rows.length) : live.cursor + 1;
      live.sheet = { setNo, kind: null, region: null, side: null, zone: null, level: null, tags: [], note: "" };
      render();
      break;
    }
    case "event-close": live.sheet = null; render(); break;
    case "event-save": {
      const sh = live.sheet;
      if (!sh || !eventReady(sh)) return;
      addSetEvent(ex, { set: sh.setNo, kind: sh.kind, zone: sh.zone, level: sh.level, tags: sh.tags, note: sh.note }, { date: sessionRuntime.working.date });
      live.sheet = null;
      renderSessionContent();
      render();
      break;
    }
    case "skip-rest": live.restEnd = null; render(); break;
    case "add-set": {
      const current = targetCount(ex, idx);
      live.targets[idx] = Math.max(current || 0, rows.length) + 1;
      setCursor(rows.length);
      break;
    }
    case "cancel-edit": setCursor(rows.length); break;
    case "delete-set": {
      if (live.cursor >= rows.length) return;
      shiftEventsAfterDelete(ex, live.cursor + 1);
      rows.splice(live.cursor, 1);
      writeRows(ex, rows);
      // L'objectif ajouté suit la suppression, sans descendre sous le prévu.
      if (live.targets[idx] != null) live.targets[idx] = Math.max(plannedCount(ex) || 0, live.targets[idx] - 1);
      setCursor(rows.length);
      break;
    }
    case "save-edit": {
      if (live.cursor >= rows.length) return;
      rows[live.cursor] = { load: (live.draft.load || "").trim(), reps: (live.draft.reps || "").trim(), rir: live.draft.rir || "" };
      writeRows(ex, rows);
      setCursor(rows.length);
      break;
    }
    case "validate": {
      if (!(live.draft.reps || "").trim() && !(live.draft.load || "").trim()) return;
      ensureAudio();
      rows.push({ load: (live.draft.load || "").trim(), reps: (live.draft.reps || "").trim(), rir: live.draft.rir || "" });
      writeRows(ex, rows);
      // Superset : on enchaîne sur le membre suivant sans repos ; le repos ne
      // démarre qu'à la fin du tour (dernier membre).
      const nm = nextMember(live.pos);
      if (nm && !nm.wrapped) { goTo(nm.pos); break; }
      startRest();
      if (nm) { goTo(nm.pos); break; }
      live.cursor = rows.length;
      live.draft = draftFor(ex);
      render();
      break;
    }
    default: break;
  }
}

export function closeLiveMode() {
  if (!live) return;
  clearInterval(live.interval);
  if (live.wakeLock) { try { live.wakeLock.release(); } catch (_) {} }
  if (live.audio) { try { live.audio.close(); } catch (_) {} }
  live.el.remove();
  document.body.classList.remove("live-open");
  live = null;
  sessionRuntime.liveCleanup = null;
}

export async function openLiveMode() {
  if (live) return;
  syncFormIntoSession();
  const { session, date } = sessionRuntime.working;
  const indices = liveExerciseIndices(session);
  if (!indices.length) return;
  if (!getSessionTimerStart(date)) {
    startSessionRun(date, session);
    renderSessionContent();
  }
  const firstOpen = indices.findIndex((i) => {
    const e = session.exercises[i];
    const t = plannedCount(e);
    return t == null ? doneRows(e).length === 0 : doneRows(e).length < t;
  });
  const el = document.createElement("div");
  el.className = "live-mode";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Séance guidée");
  document.body.appendChild(el);
  document.body.classList.add("live-open");
  live = { el, indices, sheet: null, zones: null, pos: 0, cursor: 0, targets: {}, picker: false, exit: false, blockLoads: {}, blockStart: {}, draft: null, restTotal: getRestSeconds(), restEnd: null, restStart: null, beeped: false, history: null, cardioHistory: null, cardio: null, wakeLock: null, audio: null };
  live.interval = setInterval(tick, 500);
  sessionRuntime.liveCleanup = closeLiveMode;
  goTo(firstOpen >= 0 ? firstOpen : 0);
  // « Dernière fois » : historique précalculé (summary.json), facultatif.
  try {
    const file = await ghGetFile("data/app/summary.json");
    if (live && file) {
      const summary = JSON.parse(file.content);
      live.history = summary.exercise_history || {};
      live.cardioHistory = summary.cardio_history || {};
      live.hints = summary.exercise_hints || {};
      live.zones = (summary.pain_recent || {}).zones || null;
      render();
    }
  } catch (_) { /* pas d'historique : le reste fonctionne */ }
}
