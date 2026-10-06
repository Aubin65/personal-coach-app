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
    .filter(({ ex }) => (ex.format || "standard") === "standard" && (ex.name || "").trim())
    .map(({ i }) => i);
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
  return hydrateExecRows(ex.executed || {}, ex.rir).filter((r) => (r.reps || "").trim() || (r.load || "").trim());
}

function plannedCount(ex) {
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
  if (fill) fill.style.width = `${Math.min(100, 100 - (left / (live.restTotal * 1000)) * 100)}%`;
}

function fmtLoad(load) {
  if (!load) return "";
  return `${load}${/^[\d.,]+$/.test(load) ? " kg" : ""}`;
}

function pickerHTML(session) {
  return `
    <div class="live-picker">
      <div class="live-picker-head"><strong>Aller à l'exercice</strong><button type="button" class="live-link" data-live="picker-close">Fermer</button></div>
      <ol class="live-picker-list">${live.indices.map((i, k) => {
        const e = session.exercises[i];
        const n = doneRows(e).length;
        const t = targetCount(e, i);
        const state = t != null ? (n >= t ? "done" : n > 0 ? "partial" : "") : (n > 0 ? "done" : "");
        return `<li><button type="button" class="${k === live.pos ? "current" : ""} ${state}" data-goto="${k}">
          <span class="live-picker-num">${k + 1}</span>
          <span class="live-picker-name">${escapeHtmlText(e.name)}</span>
          <span class="live-picker-count">${n}${t != null ? ` / ${t}` : ""}</span></button></li>`;
      }).join("")}</ol>
    </div>`;
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
    <header class="live-head">
      <button type="button" class="live-icon-btn" data-live="close" aria-label="Revenir au formulaire"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
      <div class="live-head-text">
        <span class="live-head-name">${escapeHtmlText(session.name || "Séance")}</span>
        <span class="live-head-chrono" id="live-chrono">--:--</span>
      </div>
      <button type="button" class="live-finish" data-live="finish">Terminer</button>
    </header>
    <div class="live-segs" aria-hidden="true">${segs}</div>
    <main class="live-body">
      ${live.picker ? pickerHTML(session) : `
      <div class="live-ex-head">
        <button type="button" class="live-kicker" data-live="picker">Exercice ${pos + 1} / ${indices.length}${plannedLine(ex) ? ` · objectif ${escapeHtmlText(plannedLine(ex))}` : ""} <span aria-hidden="true">▾</span></button>
        <h2 class="live-ex-name">${escapeHtmlText(ex.name)}</h2>
        ${supersetNote}
        ${lastTime ? `<p class="live-last">${escapeHtmlText(lastTime)}</p>` : ""}
        ${ex.notes ? `<p class="live-notes">${escapeHtmlText(ex.notes)}</p>` : ""}
      </div>
      ${doneList}
      ${setCard}
      <div class="live-nav">
        ${prevLabel ? `<button type="button" data-live="prev">${prevLabel}</button>` : "<span></span>"}
        ${nextLabel ? `<button type="button" data-live="next">${nextLabel}</button>` : "<span></span>"}
      </div>
      <button type="button" class="live-cancel-run" data-live="cancel-run">Annuler la séance</button>`}
    </main>
    <footer class="live-foot">
      <div class="live-rest" id="live-rest" hidden>
        <div class="live-rest-bar"><div class="live-rest-fill"></div></div>
        <span class="live-rest-time">Repos</span>
        <div class="live-rest-choices">${REST_CHOICES.map((s) => `<button type="button" class="${s === live.restTotal ? "on" : ""}" data-rest="${s}">${s < 60 ? s + " s" : (s / 60).toString().replace(".", ",") + " min"}</button>`).join("")}<button type="button" data-live="skip-rest">Passer</button></div>
      </div>
      ${live.picker ? "" : primary}
    </footer>
    ${live.sheet ? eventSheetHTML(ex) : ""}`;

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
  live.el.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => {
    live.picker = false;
    goTo(parseInt(b.dataset.goto, 10));
  }));
  live.el.querySelectorAll("[data-live]").forEach((b) => b.addEventListener("click", () => action(b.dataset.live)));
  wireEventSheet(ex);
  tick();
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
  const ex = sessionRuntime.working.session.exercises[live.indices[pos]];
  const n = doneRows(ex).length;
  live.cursor = atEnd && n > 0 ? n - 1 : n;
  live.draft = draftAtCursor(ex);
  render();
  scrollTop();
}

function startRest() {
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
    case "picker": live.picker = true; render(); scrollTop(); break;
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
  live = { el, indices, sheet: null, zones: null, pos: 0, cursor: 0, targets: {}, picker: false, draft: null, restTotal: getRestSeconds(), restEnd: null, restStart: null, beeped: false, history: null, audio: null };
  live.interval = setInterval(tick, 500);
  sessionRuntime.liveCleanup = closeLiveMode;
  goTo(firstOpen >= 0 ? firstOpen : 0);
  // « Dernière fois » : historique précalculé (summary.json), facultatif.
  try {
    const file = await ghGetFile("data/app/summary.json");
    if (live && file) {
      const summary = JSON.parse(file.content);
      live.history = summary.exercise_history || {};
      live.zones = (summary.pain_recent || {}).zones || null;
      render();
    }
  } catch (_) { /* pas d'historique : le reste fonctionne */ }
}
