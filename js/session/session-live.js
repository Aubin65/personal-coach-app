import { sessionRuntime } from "./session-state.js";
import { renderSessionContent } from "./session-render.js";
import { syncFormIntoSession } from "./session-form.js";
import { getSessionTimerStart, setSessionTimerStart, formatElapsed, formatDurationMs } from "./session-timer.js";
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
// Les blocs AMRAP / EMOM / Circuit / For Time ne sont pas proposés ici : leur
// résultat se saisit au niveau du bloc, dans le formulaire.
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

function doneRows(ex) {
  return hydrateExecRows(ex.executed || {}, ex.rir).filter((r) => (r.reps || "").trim() || (r.load || "").trim());
}

function plannedCount(ex) {
  const n = parseInt((ex.planned || {}).sets, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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

function render() {
  const { session } = sessionRuntime.working;
  const indices = live.indices;
  const pos = live.pos;
  const idx = indices[pos];
  const ex = session.exercises[idx];
  const rows = doneRows(ex);
  const target = plannedCount(ex);
  const reached = target != null && rows.length >= target;
  const d = live.draft;
  const segs = indices.map((i, k) => {
    const e = session.exercises[i];
    const t = plannedCount(e);
    const n = doneRows(e).length;
    const cls = k === pos ? "current" : (t != null ? n >= t : n > 0) ? "done" : "";
    return `<span class="live-seg ${cls}"></span>`;
  }).join("");
  const supersetNote = ex.superset_with_previous ? '<span class="pill pill-gold">En superset avec le précédent</span>' : "";
  const lastTime = lastTimeText(ex.name);

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
      <div class="live-ex-head">
        <p class="live-kicker">Exercice ${pos + 1} / ${indices.length}${plannedLine(ex) ? ` · objectif ${escapeHtmlText(plannedLine(ex))}` : ""}</p>
        <h2 class="live-ex-name">${escapeHtmlText(ex.name)}</h2>
        ${supersetNote}
        ${lastTime ? `<p class="live-last">${escapeHtmlText(lastTime)}</p>` : ""}
        ${ex.notes ? `<p class="live-notes">${escapeHtmlText(ex.notes)}</p>` : ""}
      </div>
      ${rows.length ? `<ol class="live-done">${rows.map((r, i) => `<li><span class="live-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></span><span>Série ${i + 1}</span><span class="live-done-val">${escapeHtmlText([r.load ? `${r.load}${/^[\d.,]+$/.test(r.load) ? " kg" : ""}` : "", r.reps ? `× ${r.reps}` : ""].filter(Boolean).join(" "))}</span><span class="live-done-rir">${r.rir !== "" && r.rir != null ? `RIR ${escapeHtmlText(r.rir)}` : ""}</span></li>`).join("")}</ol>
        <button type="button" class="live-undo" data-live="undo">Annuler la dernière série</button>` : ""}
      <section class="live-set${reached ? " extra" : ""}">
        <div class="live-set-head"><strong>Série ${rows.length + 1}${reached ? " (en plus)" : ""}</strong><span>${rows.length ? "pré-rempli avec la série précédente" : "pré-rempli avec le prévu"}</span></div>
        <div class="live-steppers">
          <label class="live-stepper"><span>Charge${(ex.planned || {}).load_per_hand ? " / main" : ""}</span>
            <span class="live-stepper-row"><button type="button" data-live="load-" aria-label="Moins 2,5">−</button><input type="text" inputmode="decimal" id="live-load" value="${escapeAttr(d.load)}" aria-label="Charge"><button type="button" data-live="load+" aria-label="Plus 2,5">+</button></span></label>
          <label class="live-stepper"><span>Reps / temps</span>
            <span class="live-stepper-row"><button type="button" data-live="reps-" aria-label="Moins une rep">−</button><input type="text" inputmode="numeric" id="live-reps" value="${escapeAttr(d.reps)}" aria-label="Reps"><button type="button" data-live="reps+" aria-label="Plus une rep">+</button></span></label>
        </div>
        <div class="live-rir"><span>Reps en réserve (RIR)</span>
          <div class="live-rir-row">${RIR_CHOICES.map((v) => `<button type="button" class="${d.rir === v ? "on" : ""}" data-rir="${v}">${v === "4" ? "4+" : v}</button>`).join("")}</div>
        </div>
      </section>
      <div class="live-nav">
        <button type="button" data-live="prev"${pos === 0 ? " disabled" : ""}>← Précédent</button>
        <button type="button" data-live="next"${pos === indices.length - 1 ? " disabled" : ""}>Suivant →</button>
      </div>
    </main>
    <footer class="live-foot">
      <div class="live-rest" id="live-rest" hidden>
        <div class="live-rest-bar"><div class="live-rest-fill"></div></div>
        <span class="live-rest-time">Repos</span>
        <div class="live-rest-choices">${REST_CHOICES.map((s) => `<button type="button" class="${s === live.restTotal ? "on" : ""}" data-rest="${s}">${s < 60 ? s + " s" : (s / 60).toString().replace(".", ",") + " min"}</button>`).join("")}<button type="button" data-live="skip-rest">Passer</button></div>
      </div>
      ${reached && pos < indices.length - 1
        ? `<button type="button" class="live-validate" data-live="next">Exercice suivant →</button>`
        : `<button type="button" class="live-validate" data-live="validate"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>Valider la série ${rows.length + 1}</button>`}
    </footer>`;

  const loadInput = live.el.querySelector("#live-load");
  const repsInput = live.el.querySelector("#live-reps");
  loadInput.addEventListener("input", () => { live.draft.load = loadInput.value; });
  repsInput.addEventListener("input", () => { live.draft.reps = repsInput.value; });
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
  live.el.querySelectorAll("[data-live]").forEach((b) => b.addEventListener("click", () => action(b.dataset.live)));
  tick();
}

function goTo(pos) {
  live.pos = pos;
  const ex = sessionRuntime.working.session.exercises[live.indices[pos]];
  live.draft = draftFor(ex);
  live.el.scrollTop = 0;
  const body = live.el.querySelector(".live-body");
  if (body) body.scrollTop = 0;
  render();
}

function action(name) {
  const ex = sessionRuntime.working.session.exercises[live.indices[live.pos]];
  switch (name) {
    case "close": closeLiveMode(); break;
    case "finish": {
      closeLiveMode();
      const stop = document.getElementById("stop-timer");
      if (stop) stop.click();
      break;
    }
    case "load-": live.draft.load = step(live.draft.load, -2.5); render(); break;
    case "load+": live.draft.load = step(live.draft.load, 2.5); render(); break;
    case "reps-": live.draft.reps = step(live.draft.reps, -1); render(); break;
    case "reps+": live.draft.reps = step(live.draft.reps, 1); render(); break;
    case "prev": if (live.pos > 0) goTo(live.pos - 1); break;
    case "next": if (live.pos < live.indices.length - 1) goTo(live.pos + 1); break;
    case "skip-rest": live.restEnd = null; render(); break;
    case "undo": {
      const rows = doneRows(ex);
      rows.pop();
      writeRows(ex, rows);
      live.draft = draftFor(ex);
      render();
      break;
    }
    case "validate": {
      if (!(live.draft.reps || "").trim() && !(live.draft.load || "").trim()) return;
      ensureAudio();
      const rows = doneRows(ex);
      rows.push({ load: (live.draft.load || "").trim(), reps: (live.draft.reps || "").trim(), rir: live.draft.rir || "" });
      writeRows(ex, rows);
      live.restStart = Date.now();
      live.restEnd = live.restStart + live.restTotal * 1000;
      live.beeped = false;
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
    setSessionTimerStart(date, new Date().toISOString());
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
  live = { el, indices, pos: 0, draft: null, restTotal: getRestSeconds(), restEnd: null, restStart: null, beeped: false, history: null, audio: null };
  live.interval = setInterval(tick, 500);
  sessionRuntime.liveCleanup = closeLiveMode;
  goTo(firstOpen >= 0 ? firstOpen : 0);
  // « Dernière fois » : historique précalculé (summary.json), facultatif.
  try {
    const file = await ghGetFile("data/app/summary.json");
    if (live && file) {
      live.history = JSON.parse(file.content).exercise_history || {};
      render();
    }
  } catch (_) { /* pas d'historique : le reste fonctionne */ }
}
