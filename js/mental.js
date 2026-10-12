import { ghGetFile, ghListDir, ghPutJSON } from "./github-api.js";
import { escapeHtmlText, escapeAttr } from "./markdown.js";
import { localISOWithOffset } from "./date-utils.js";

// ============================================================================
// Préparation mentale (docs/adr/0106) — routine pré-match (checklist,
// respiration, visualisation guidée, objectifs de processus + mot-clé) et
// fiche mentale après match (activation, concentration, confiance, objectifs
// tenus). Plan écrit par l'app seule : `data/mental/<date du match>.json` ;
// résultat dans `fixture.performance.mental` (ignoré par coach.feelings, qui ne
// lit que `performance.feel`).
// ============================================================================

export const MENTAL_SCALES = [
  { key: "activation", label: "Activation avant le match", low: "Trop calme", high: "Trop tendu", note: "3 = juste bien" },
  { key: "concentration", label: "Concentration", low: "Dispersé", high: "Focus" },
  { key: "confiance", label: "Confiance", low: "Doute", high: "Sûr de moi" },
];

export const GOAL_SUGGESTIONS = [
  "Plaquages bas et propres",
  "Replacement en moins de 5 s",
  "Gagner la ligne d'avantage au porté",
  "Un ballon gratté ou une relance",
  "Reset après chaque erreur",
];

const CHECKLIST = [
  "Repas pris 3-4 h avant",
  "Hydratation OK",
  "Sac et matériel prêts",
  "Respiration faite",
  "Visualisation faite",
];

const BREATH = {
  calm: { label: "Calmer · 2 min", inhale: 4, exhale: 6, cycles: 12 },
  activate: { label: "Activer · 1 min", inhale: 2, exhale: 2, cycles: 15 },
};

const VISUALIZATION = [
  { text: "Installe-toi, ferme les yeux, respire calmement.", seconds: 30 },
  { text: "Vois-toi arriver au stade : l'ambiance, tes crampons, le ballon dans les mains.", seconds: 40 },
  { text: "Rejoue 3 actions clés réussies à ton poste (plaquage, porté, relance) : détails, vitesse, sensations.", seconds: 70 },
  { text: "Une erreur arrive : vois-toi souffler, dire ton mot-clé, enchaîner sur l'action suivante.", seconds: 45 },
  { text: "Termine sur ton premier plaquage ou ballon réussi. Ouvre les yeux quand tu es prêt.", seconds: 30 },
];

const PLAN_PATH = (date) => `data/mental/${date}.json`;
const plans = new Map();

export async function loadMentalPlan(date) {
  if (plans.has(date)) return plans.get(date);
  let plan = null;
  try {
    const file = await ghGetFile(PLAN_PATH(date));
    plan = file ? JSON.parse(file.content) : null;
  } catch (_) { /* plan illisible : absent */ }
  plans.set(date, plan);
  return plan;
}

/** Précharge les plans de plusieurs dates (liste du dossier, un seul appel). */
export async function preloadMentalPlans() {
  const entries = await ghListDir("data/mental").catch(() => []);
  await Promise.all(entries.filter((e) => /^\d{4}-\d{2}-\d{2}\.json$/.test(e.name || "")).map((e) => loadMentalPlan(e.name.slice(0, 10))));
}

export function cachedMentalPlan(date) {
  return plans.get(date) || null;
}

export async function saveMentalPlan(date, goals, cueWord) {
  const clean = goals.map((g) => g.trim()).filter(Boolean).slice(0, 3);
  const next = await ghPutJSON(PLAN_PATH(date), { date }, `App : plan mental du ${date}`, (cur) => ({
    ...(cur || {}), date, goals: clean, cue_word: cueWord.trim() || null, saved_at: localISOWithOffset(),
  }));
  plans.set(date, next);
  return next;
}

// ---- Après match -----------------------------------------------------------

export function mentalScalesHTML(mental = {}) {
  const rows = MENTAL_SCALES.map((s) => `
    <div class="feel-row">
      <div class="feel-row-head"><span class="feel-label">${s.label}</span><span class="feel-anchors">1 ${escapeHtmlText(s.low)} · ${s.note ? `${escapeHtmlText(s.note)} · ` : ""}5 ${escapeHtmlText(s.high)}</span></div>
      <div class="feel-chips">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="feel-chip${mental && mental[s.key] === n ? " active" : ""}" data-feel-key="${s.key}" data-feel-value="${n}" aria-label="${s.label} ${n} sur 5">${n}</button>`).join("")}</div>
    </div>`).join("");
  return rows;
}

/** Objectifs de processus du plan, à noter tenu / pas tenu. */
export function goalsCheckHTML(plan, mental = {}) {
  const goals = plan && Array.isArray(plan.goals) ? plan.goals : [];
  if (!goals.length) return "";
  const done = (mental && Array.isArray(mental.goals)) ? mental.goals : [];
  return `<div class="mental-goals-check"><p class="small muted">Tes objectifs</p>${goals.map((g, i) => {
    const prev = done.find((d) => d.text === g);
    return `<div class="goal-row" data-goal="${escapeAttr(g)}"><span>${escapeHtmlText(g)}</span><span class="goal-chips"><button type="button" class="suggestion-chip goal-chip${prev && prev.met === true ? " active" : ""}" data-met="1">Tenu</button><button type="button" class="suggestion-chip goal-chip${prev && prev.met === false ? " active" : ""}" data-met="0">Pas tenu</button></span></div>`;
  }).join("")}</div>`;
}

export function wireMentalPost(root) {
  root.querySelectorAll(".goal-row").forEach((row) => row.querySelectorAll(".goal-chip").forEach((chip) => chip.addEventListener("click", () => {
    const wasActive = chip.classList.contains("active");
    row.querySelectorAll(".goal-chip").forEach((c) => c.classList.remove("active"));
    if (!wasActive) chip.classList.add("active");
  })));
}

/** `{activation?, concentration?, confiance?, goals?}` ou null si rien. */
export function readMental(root) {
  const mental = {};
  for (const s of MENTAL_SCALES) {
    const chip = root.querySelector(`.feel-chip.active[data-feel-key="${s.key}"]`);
    if (chip) mental[s.key] = Number(chip.dataset.feelValue);
  }
  const goals = [...root.querySelectorAll(".goal-row")]
    .map((row) => ({ text: row.dataset.goal, chip: row.querySelector(".goal-chip.active") }))
    .filter((g) => g.chip)
    .map((g) => ({ text: g.text, met: g.chip.dataset.met === "1" }));
  if (goals.length) mental.goals = goals;
  return Object.keys(mental).length ? mental : null;
}

export function mentalSummaryText(mental) {
  if (!mental) return "";
  const parts = MENTAL_SCALES.filter((s) => mental[s.key] != null).map((s) => `${s.label.replace(" avant le match", "")} ${mental[s.key]}/5`);
  if (Array.isArray(mental.goals) && mental.goals.length) parts.push(`objectifs ${mental.goals.filter((g) => g.met).length}/${mental.goals.length}`);
  return parts.join(" · ");
}

// ---- Routine pré-match ------------------------------------------------------

const tickKey = (date) => `coach_mental_ticks_${date}`;
function readTicks(date) {
  try { return JSON.parse(localStorage.getItem(tickKey(date)) || "[]"); } catch (_) { return []; }
}
function writeTicks(date, ticks) {
  try { localStorage.setItem(tickKey(date), JSON.stringify(ticks)); } catch (_) { /* confort */ }
}

export function mentalRoutineHTML(date, plan) {
  const goals = plan && plan.goals ? plan.goals : [];
  const ticks = readTicks(date);
  return `
    <details class="mental-card" data-mental-date="${escapeAttr(date)}">
      <summary>🧠 Routine pré-match</summary>
      <div class="mental-body">
        <p class="small muted">Même séquence à chaque match : c'est la régularité qui compte.</p>
        <div class="mental-checklist">${CHECKLIST.map((c, i) => `<label class="mental-check"><input type="checkbox" data-tick="${i}"${ticks.includes(i) ? " checked" : ""}><span>${escapeHtmlText(c)}</span></label>`).join("")}</div>

        <p class="small"><strong>Respiration</strong></p>
        <div class="mental-actions">${Object.entries(BREATH).map(([k, b]) => `<button type="button" class="suggestion-chip mental-breath" data-mode="${k}">${escapeHtmlText(b.label)}</button>`).join("")}</div>
        <p class="small"><strong>Visualisation</strong> <span class="muted">(≈ 4 min, yeux fermés possible)</span></p>
        <div class="mental-actions"><button type="button" class="suggestion-chip mental-visu">Démarrer</button></div>
        <div class="mental-stage" aria-live="polite" hidden>
          <div class="mental-orb" aria-hidden="true"></div>
          <p class="mental-stage-text"></p>
          <p class="mental-stage-count muted small"></p>
          <button type="button" class="delete-link mental-stop">Arrêter</button>
        </div>

        <p class="small"><strong>Objectifs de processus</strong> <span class="muted">(sous ton contrôle, 2-3 max)</span></p>
        ${[0, 1, 2].map((i) => `<input type="text" class="mental-goal" maxlength="80" placeholder="Objectif ${i + 1}" value="${escapeAttr(goals[i] || "")}">`).join("")}
        <div class="suggestion-chips mental-suggestions">${GOAL_SUGGESTIONS.map((g) => `<button type="button" class="suggestion-chip" data-goal-suggestion="${escapeAttr(g)}">${escapeHtmlText(g)}</button>`).join("")}</div>
        <p class="small"><strong>Mot-clé de reset</strong> <span class="muted">(après une erreur : souffle, mot, action suivante)</span></p>
        <input type="text" class="mental-cue" maxlength="30" placeholder="Prochain ballon" value="${escapeAttr((plan && plan.cue_word) || "")}">
        <button type="button" class="primary-button small mental-save" style="margin-top:10px">Enregistrer mon plan</button>
        <p class="muted small mental-status" aria-live="polite"></p>
      </div>
    </details>`;
}

let runner = null;
function stopRunner() {
  if (runner) { clearInterval(runner.timer); runner = null; }
}

/** Joue une suite d'étapes `{text, seconds, phase?}` dans `stage`. */
function runSteps(stage, steps, onDone) {
  stopRunner();
  const orb = stage.querySelector(".mental-orb");
  const textEl = stage.querySelector(".mental-stage-text");
  const countEl = stage.querySelector(".mental-stage-count");
  stage.hidden = false;
  let idx = 0;
  let left = 0;
  const begin = () => {
    const step = steps[idx];
    left = step.seconds;
    textEl.textContent = step.text;
    orb.style.setProperty("--orb-seconds", `${step.seconds}s`);
    orb.dataset.phase = step.phase || "";
    countEl.textContent = `${left} s`;
  };
  begin();
  runner = {
    timer: setInterval(() => {
      if (!stage.isConnected) { stopRunner(); return; }
      left -= 1;
      if (left > 0) { countEl.textContent = `${left} s`; return; }
      idx += 1;
      if (idx >= steps.length) { stopRunner(); stage.hidden = true; if (onDone) onDone(); return; }
      begin();
    }, 1000),
  };
}

function breathSteps(mode) {
  const b = BREATH[mode];
  const out = [];
  for (let i = 0; i < b.cycles; i++) {
    out.push({ text: "Inspire", seconds: b.inhale, phase: "in" });
    out.push({ text: "Expire", seconds: b.exhale, phase: "out" });
  }
  return out;
}

export function wireMentalRoutine(root) {
  root.querySelectorAll(".mental-card").forEach((card) => {
    const date = card.dataset.mentalDate;
    const stage = card.querySelector(".mental-stage");
    card.addEventListener("toggle", () => { if (!card.open) { stopRunner(); stage.hidden = true; } });
    card.querySelectorAll("[data-tick]").forEach((box) => box.addEventListener("change", () => {
      const ticks = [...card.querySelectorAll("[data-tick]")].filter((b) => b.checked).map((b) => Number(b.dataset.tick));
      writeTicks(date, ticks);
    }));
    card.querySelectorAll(".mental-breath").forEach((btn) => btn.addEventListener("click", () => runSteps(stage, breathSteps(btn.dataset.mode))));
    card.querySelector(".mental-visu").addEventListener("click", () => {
      const cue = card.querySelector(".mental-cue").value.trim();
      const steps = VISUALIZATION.map((s) => ({ ...s, text: cue ? s.text.replace("ton mot-clé", `« ${cue} »`) : s.text, phase: "visu" }));
      runSteps(stage, steps);
    });
    card.querySelector(".mental-stop").addEventListener("click", () => { stopRunner(); stage.hidden = true; });
    card.querySelectorAll("[data-goal-suggestion]").forEach((chip) => chip.addEventListener("click", () => {
      const inputs = [...card.querySelectorAll(".mental-goal")];
      if (inputs.some((i) => i.value.trim() === chip.dataset.goalSuggestion)) return;
      const empty = inputs.find((i) => !i.value.trim());
      if (empty) empty.value = chip.dataset.goalSuggestion;
    }));
    card.querySelector(".mental-save").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const status = card.querySelector(".mental-status");
      btn.disabled = true;
      status.textContent = "Enregistrement…";
      try {
        await saveMentalPlan(date, [...card.querySelectorAll(".mental-goal")].map((i) => i.value), card.querySelector(".mental-cue").value);
        status.textContent = "Plan enregistré ✓ — tu le retrouveras dans ta fiche après match.";
      } catch (err) {
        status.textContent = `Échec : ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  });
}
