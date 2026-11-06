import { ghGetFile, ghPutJSON } from "../github-api.js";
import { stale, showView } from "../nav.js";
import { todayISO } from "../date-utils.js";
import { registerQueuedOp, runQueued } from "../offline-queue.js";
import { shortDateFr } from "./data-viz.js";
import { analyseTest, bestHeight, flightTime, jumpHeight, num, pushOffDistance, ORIENTATIONS, RECOMMENDED_LOADS } from "../fv-profile.js";

// ============================================================================
// Test force-vitesse (docs/adr/0113) — écran guidé : réglages une fois, puis
// une étape par charge (nombre d'images en l'air → hauteur en direct), puis le
// profil. Les réglages (masse, hPO, cadence, charges) sont mémorisés ; la
// saisie en cours l'est aussi (brouillon du jour) pour pouvoir quitter l'app
// et compter les images dans la galerie sans rien perdre.
// ============================================================================

const SETTINGS_KEY = "coach_fv_settings";
const DRAFT_KEY = "coach_fv_draft";
const DEFAULT_LOADS = [0, 20, 40, 60];
const FPS_CHOICES = [120, 240, 480];

registerQueuedOp("fv-test", async ({ test }) => {
  await ghPutJSON(`data/tests/fv/${test.date}.json`, null, `Test force-vitesse (${test.date})`, () => test);
});

/** Images en l'air d'un essai : « 120 » (comptées) ou « 305|425 » (image
 * d'envol | image d'atterrissage → différence). null si illisible. */
function framesOf(raw) {
  if (raw == null) return null;
  const str = String(raw);
  if (str.includes("|")) {
    const [a, b] = str.split("|").map(num);
    return a != null && b != null && b > a ? b - a : null;
  }
  const n = num(str);
  return n != null && n > 0 ? n : null;
}

const fr = (x, d = 1) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d).replace(".", ","));
const loadLabel = (kg) => (kg === 0 ? "Poids du corps" : `+${fr(kg, kg % 1 ? 1 : 0)} kg`);

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { return null; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* confort seulement */ }
}
function removeKey(key) {
  try { localStorage.removeItem(key); } catch (_) { /* confort seulement */ }
}

/** État du test : réglages + essais par charge (images saisies, texte brut). */
function initialState(defaults) {
  const saved = readJSON(SETTINGS_KEY) || {};
  const st = {
    step: "setup", // "setup" | index de charge | "result" | "saved"
    mass: saved.mass ?? defaults.mass ?? "",
    hpoMode: saved.hpoMode || "measure",
    legCm: saved.legCm ?? "",
    iliacCm: saved.iliacCm ?? "",
    hpoCm: saved.hpoCm ?? "",
    fps: saved.fps || 240,
    entry: saved.entry || "range", // "range" = image d'envol + image d'atterrissage ; "count" = images comptées
    loads: Array.isArray(saved.loads) && saved.loads.length ? saved.loads : [...DEFAULT_LOADS],
    attempts: {}, // { "<load_kg>": ["120", "118"] }
  };
  const draft = readJSON(DRAFT_KEY);
  if (draft && draft.date === todayISO() && draft.state) {
    return { ...st, ...draft.state };
  }
  return st;
}

function persist(st) {
  writeJSON(SETTINGS_KEY, { mass: st.mass, hpoMode: st.hpoMode, legCm: st.legCm, iliacCm: st.iliacCm, hpoCm: st.hpoCm, fps: st.fps, entry: st.entry, loads: st.loads });
  writeJSON(DRAFT_KEY, { date: todayISO(), state: { step: st.step, attempts: st.attempts, mass: st.mass, hpoMode: st.hpoMode, legCm: st.legCm, iliacCm: st.iliacCm, hpoCm: st.hpoCm, fps: st.fps, entry: st.entry, loads: st.loads } });
}

function hpoMeters(st) {
  if (st.hpoMode === "direct") {
    const cm = num(st.hpoCm);
    return cm != null && cm > 0 ? cm / 100 : null;
  }
  return pushOffDistance(st.legCm, st.iliacCm);
}

/** Test prêt pour `analyseTest` / l'enregistrement, à partir de l'état. */
function buildTest(st) {
  return {
    date: todayISO(),
    jump: "SJ",
    body_mass_kg: num(st.mass),
    hpo_m: hpoMeters(st),
    fps: num(st.fps),
    trials: st.loads.map((load) => ({
      load_kg: load,
      attempts: (st.attempts[String(load)] || []).map((f) => ({ frames: framesOf(f) })).filter((a) => a.frames != null),
    })).filter((t) => t.attempts.length),
  };
}

function setupProblem(st) {
  const mass = num(st.mass);
  if (!(mass > 30 && mass < 200)) return "Renseigne ta masse (kg).";
  const hpo = hpoMeters(st);
  if (hpo == null) return st.hpoMode === "direct" ? "Renseigne ta distance de poussée." : "Renseigne la longueur de jambe et la hauteur de crête iliaque (jambe > crête).";
  if (hpo < 0.15 || hpo > 0.7) return "Distance de poussée improbable (entre 15 et 70 cm attendus) : vérifie tes mesures.";
  if (!(num(st.fps) > 0)) return "Renseigne la cadence de la vidéo (images par seconde).";
  if (st.loads.length < 2) return "Garde au moins 2 charges.";
  return null;
}

function stepsDots(st) {
  const total = st.loads.length;
  const items = [`<span class="fv-dot${st.step === "setup" ? " current" : " done"}" title="Réglages"></span>`];
  st.loads.forEach((load, i) => {
    const filled = (st.attempts[String(load)] || []).some((f) => framesOf(f) != null);
    const cls = st.step === i ? " current" : filled ? " done" : "";
    items.push(`<span class="fv-dot${cls}" title="${loadLabel(load)}"></span>`);
  });
  items.push(`<span class="fv-dot${st.step === "result" || st.step === "saved" ? " current" : ""}" title="Profil"></span>`);
  return `<div class="fv-steps" role="presentation" aria-label="${total} charges">${items.join("")}</div>`;
}

// ---------------------------------------------------------------- Réglages
function setupHTML(st) {
  const hpo = hpoMeters(st);
  return `
    <section class="card fv-card">
      ${stepsDots(st)}
      <h2>Test force-vitesse</h2>
      <p class="muted small">Squat jump lesté filmé au ralenti : l'app déduit ta hauteur du temps passé en l'air, puis ton profil. Compte ~15 min pour ${st.loads.length} charges.</p>

      <label class="fv-field"><span>Masse du corps (kg)</span>
        <input class="fv-input" id="fv-mass" type="text" inputmode="decimal" autocomplete="off" value="${st.mass}" placeholder="82"></label>

      <div class="fv-field"><span>Distance de poussée</span>
        <div class="segmented" role="tablist">
          <button type="button" role="tab" class="segment${st.hpoMode === "measure" ? " active" : ""}" data-hpo-mode="measure">Je la calcule</button>
          <button type="button" role="tab" class="segment${st.hpoMode === "direct" ? " active" : ""}" data-hpo-mode="direct">Je la connais</button>
        </div>
        ${st.hpoMode === "measure" ? `
          <div class="fv-pair">
            <label><span>Jambe étendue (cm)</span><input class="fv-input" id="fv-leg" type="text" inputmode="decimal" value="${st.legCm}" placeholder="95"></label>
            <label><span>Crête iliaque au départ (cm)</span><input class="fv-input" id="fv-iliac" type="text" inputmode="decimal" value="${st.iliacCm}" placeholder="57"></label>
          </div>` : `
          <label class="fv-inline"><span class="muted small">Distance (cm)</span><input class="fv-input" id="fv-hpo" type="text" inputmode="decimal" value="${st.hpoCm}" placeholder="38"></label>`}
        <p class="fv-live muted small" id="fv-hpo-out">${hpo != null ? `Distance de poussée : <strong>${fr(hpo * 100, 1)} cm</strong>` : "&nbsp;"}</p>
        <details class="card-help"><summary>Comment mesurer ?</summary>
          <p><strong>Jambe étendue</strong> : du haut de la crête iliaque (os de la hanche) jusqu'au bout des orteils, jambe tendue et cheville en pointe, mesurée debout puis en position de saut tendu.<br>
          <strong>Crête iliaque au départ</strong> : hauteur du même point par rapport au sol quand tu es en position de départ du squat jump, genoux à ~90°.<br>
          La distance de poussée est la différence entre les deux. Garde le même angle de départ à chaque test.</p></details>
      </div>

      <div class="fv-field"><span>Cadence de la vidéo (images / seconde)</span>
        <div class="suggestion-chips">
          ${FPS_CHOICES.map((f) => `<button type="button" class="suggestion-chip${num(st.fps) === f ? " active" : ""}" data-fps="${f}">${f}</button>`).join("")}
          <input class="fv-input fv-fps-custom" id="fv-fps" type="text" inputmode="numeric" value="${FPS_CHOICES.includes(num(st.fps)) ? "" : st.fps}" placeholder="autre" aria-label="Autre cadence">
        </div>
      </div>

      <div class="fv-field"><span>Relevé du temps de vol</span>
        <div class="segmented" role="tablist">
          <button type="button" role="tab" class="segment${st.entry === "range" ? " active" : ""}" data-entry="range">Envol → atterrissage</button>
          <button type="button" role="tab" class="segment${st.entry === "count" ? " active" : ""}" data-entry="count">Images comptées</button>
        </div>
        <p class="muted small">${st.entry === "range" ? "Tu lis le numéro de l'image au décollage et celui à l'atterrissage, l'app fait la différence." : "Tu comptes toi-même les images passées en l'air."} Même précision : une image près à chaque événement.</p>
      </div>

      <div class="fv-field"><span>Charges ajoutées</span>
        <div class="suggestion-chips" id="fv-loads">
          ${st.loads.map((l) => `<span class="suggestion-chip active fv-load-chip">${loadLabel(l)}<button type="button" class="fv-chip-x" data-remove-load="${l}" aria-label="Retirer ${loadLabel(l)}">×</button></span>`).join("")}
        </div>
        <div class="fv-add-load">
          <input class="fv-input" id="fv-new-load" type="text" inputmode="decimal" placeholder="+ kg" aria-label="Nouvelle charge en kg">
          <button type="button" class="primary-button ghost small" id="fv-add-load">Ajouter</button>
        </div>
        ${st.loads.length < RECOMMENDED_LOADS ? `<p class="muted small">4 charges ou plus : profil plus fiable. Arrête la montée quand tu sautes à moins de 5 cm.</p>` : ""}
      </div>

      <p class="error-text" id="fv-setup-error" hidden></p>
      <button class="primary-button" id="fv-start">Commencer</button>
    </section>`;
}

function wireSetup(root, st, draw) {
  const refresh = () => {
    const out = root.querySelector("#fv-hpo-out");
    const hpo = hpoMeters(st);
    out.innerHTML = hpo != null ? `Distance de poussée : <strong>${fr(hpo * 100, 1)} cm</strong>` : "&nbsp;";
    persist(st);
  };
  const bind = (id, key) => {
    const el = root.querySelector(id);
    if (el) el.addEventListener("input", () => { st[key] = el.value; refresh(); });
  };
  bind("#fv-mass", "mass");
  bind("#fv-leg", "legCm");
  bind("#fv-iliac", "iliacCm");
  bind("#fv-hpo", "hpoCm");
  root.querySelectorAll("[data-hpo-mode]").forEach((b) => b.addEventListener("click", () => { st.hpoMode = b.dataset.hpoMode; persist(st); draw(); }));
  root.querySelectorAll("[data-entry]").forEach((b) => b.addEventListener("click", () => {
    // Les essais déjà saisis dans l'autre format sont gardés mais illisibles ici : on les efface.
    if (st.entry !== b.dataset.entry) { st.entry = b.dataset.entry; st.attempts = {}; persist(st); draw(); }
  }));
  root.querySelectorAll("[data-fps]").forEach((b) => b.addEventListener("click", () => { st.fps = Number(b.dataset.fps); persist(st); draw(); }));
  const custom = root.querySelector("#fv-fps");
  custom.addEventListener("input", () => { st.fps = custom.value; persist(st); });
  custom.addEventListener("change", () => draw());
  root.querySelectorAll("[data-remove-load]").forEach((b) => b.addEventListener("click", () => {
    const l = Number(b.dataset.removeLoad);
    st.loads = st.loads.filter((x) => x !== l);
    persist(st);
    draw();
  }));
  const addLoad = () => {
    const v = num(root.querySelector("#fv-new-load").value);
    if (v == null || v < 0 || st.loads.includes(v)) return;
    st.loads = [...st.loads, v].sort((a, b) => a - b);
    persist(st);
    draw();
  };
  root.querySelector("#fv-add-load").addEventListener("click", addLoad);
  root.querySelector("#fv-new-load").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addLoad(); } });
  root.querySelector("#fv-start").addEventListener("click", () => {
    const problem = setupProblem(st);
    const err = root.querySelector("#fv-setup-error");
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    st.fps = num(st.fps);
    st.step = 0;
    persist(st);
    draw();
  });
}

// ---------------------------------------------------------------- Une charge
function outHTML(st, raw, best) {
  const fps = num(st.fps);
  const f = framesOf(raw);
  const t = flightTime(f, fps);
  const h = jumpHeight(f, fps);
  return h != null ? `${fr(f, 0)} images · ${fr(t, 3)} s · <strong>${fr(h * 100, 1)} cm</strong>${best ? " ✓" : ""}` : "&nbsp;";
}

function attemptRowHTML(st, load, i, raw) {
  const aria = `essai ${i + 1}`;
  if (st.entry === "range") {
    const [from = "", to = ""] = String(raw || "").split("|");
    return `
    <div class="fv-attempt" data-attempt="${i}">
      <span class="fv-attempt-label">Essai ${i + 1}</span>
      <div class="fv-pair">
        <label><span>Image d'envol</span><input class="fv-input fv-from" type="text" inputmode="numeric" value="${from}" placeholder="n°" aria-label="Image d'envol, ${aria}"></label>
        <label><span>Image d'atterrissage</span><input class="fv-input fv-to" type="text" inputmode="numeric" value="${to}" placeholder="n°" aria-label="Image d'atterrissage, ${aria}"></label>
      </div>
      <span class="fv-out" data-out>${outHTML(st, raw, false)}</span>
    </div>`;
  }
  return `
    <div class="fv-attempt" data-attempt="${i}">
      <span class="fv-attempt-label">Essai ${i + 1}</span>
      <div class="fv-stepper">
        <button type="button" class="fv-step-btn" data-step="-1" aria-label="Une image de moins">−</button>
        <input class="fv-input fv-frames" type="text" inputmode="numeric" value="${raw}" placeholder="images" aria-label="Images en l'air, ${aria}">
        <button type="button" class="fv-step-btn" data-step="1" aria-label="Une image de plus">+</button>
      </div>
      <span class="fv-out" data-out>${outHTML(st, raw, false)}</span>
    </div>`;
}

function loadStepHTML(st) {
  const load = st.loads[st.step];
  const rows = st.attempts[String(load)] && st.attempts[String(load)].length ? st.attempts[String(load)] : ["", ""];
  st.attempts[String(load)] = rows;
  const last = st.step === st.loads.length - 1;
  return `
    <section class="card fv-card">
      ${stepsDots(st)}
      <p class="muted small fv-kicker">Charge ${st.step + 1} / ${st.loads.length}</p>
      <h2>${load === 0 ? "Poids du corps" : `+${fr(load, load % 1 ? 1 : 0)} kg`}</h2>
      <p class="muted small">Squat jump : départ à ~90° en bas, 2 s de pause, saut le plus haut possible, <strong>atterrissage jambes tendues</strong>. 2 essais (repos 2 min), 4-5 min avant la charge suivante.</p>
      <div id="fv-attempts">${rows.map((f, i) => attemptRowHTML(st, load, i, f)).join("")}</div>
      <p class="fv-gap small" id="fv-gap" hidden></p>
      <button type="button" class="link-button" id="fv-add-attempt">+ Un essai de plus</button>
      <details class="card-help"><summary>Comment relever les images ?</summary>
        <p>Filme de profil, à hauteur de hanche, en ralenti 240 images/s si possible. Avance image par image avec la même règle aux deux bouts : <strong>envol</strong> = première image où les deux pieds ont quitté le sol ; <strong>atterrissage</strong> = première image où un pied touche à nouveau. Les deux demi-images d'écart se compensent. ${st.entry === "range" ? "Si ton lecteur n'affiche pas le numéro d'image, passe en « Images comptées » dans les réglages." : "Compte le nombre de pas image par image entre ces deux images."}</p></details>
      <div class="fv-nav">
        <button type="button" class="primary-button ghost" id="fv-prev">Précédent</button>
        <button type="button" class="primary-button" id="fv-next">${last ? "Voir le profil" : "Suivant"}</button>
      </div>
      <button type="button" class="link-button" id="fv-skip">Passer cette charge (trop lourde ou non faite)</button>
    </section>`;
}

function wireLoadStep(root, st, draw) {
  const load = st.loads[st.step];
  const key = String(load);
  const fps = num(st.fps);
  const update = () => {
    const rows = st.attempts[key];
    const { best, heights } = bestHeight(rows.map((f) => ({ frames: framesOf(f) })), fps);
    root.querySelectorAll(".fv-attempt").forEach((row, i) => {
      const h = jumpHeight(framesOf(rows[i]), fps);
      const isBest = h != null && best != null && Math.abs(h - best) < 1e-12 && heights.length > 1;
      const out = row.querySelector("[data-out]");
      out.classList.toggle("best", isBest);
      out.innerHTML = outHTML(st, rows[i], isBest);
    });
    const gap = root.querySelector("#fv-gap");
    const spread = heights.length > 1 && Math.min(...heights) < Math.max(...heights) * 0.9;
    gap.hidden = !spread;
    if (spread) gap.textContent = "Écart de plus de 10 % entre tes essais : refais-en un, le meilleur sera gardé.";
    persist(st);
  };
  root.querySelectorAll(".fv-attempt").forEach((row, i) => {
    if (st.entry === "range") {
      const from = row.querySelector(".fv-from"), to = row.querySelector(".fv-to");
      const sync = () => { st.attempts[key][i] = `${from.value}|${to.value}`; update(); };
      from.addEventListener("input", sync);
      to.addEventListener("input", sync);
      return;
    }
    const input = row.querySelector(".fv-frames");
    input.addEventListener("input", () => { st.attempts[key][i] = input.value; update(); });
    row.querySelectorAll(".fv-step-btn").forEach((b) => b.addEventListener("click", () => {
      const delta = Number(b.dataset.step);
      // Premier appui sur un champ vide : on part de la dernière valeur connue
      // (essai précédent de la charge, sinon charge précédente) plutôt que de 0.
      const base = num(input.value) ?? lastKnownFrames(st, key, i) ?? 100;
      const next = Math.max(1, Math.round(num(input.value) != null ? base + delta : base));
      input.value = String(next);
      st.attempts[key][i] = input.value;
      update();
    }));
  });
  root.querySelector("#fv-add-attempt").addEventListener("click", () => { st.attempts[key].push(""); persist(st); draw(); });
  root.querySelector("#fv-prev").addEventListener("click", () => { st.step = st.step === 0 ? "setup" : st.step - 1; persist(st); draw(); });
  root.querySelector("#fv-next").addEventListener("click", () => advance(st, draw));
  root.querySelector("#fv-skip").addEventListener("click", () => { st.attempts[key] = ["", ""]; advance(st, draw); });
  update();
  const firstEmpty = [...root.querySelectorAll(".fv-frames, .fv-from, .fv-to")].find((el) => !el.value);
  if (firstEmpty) firstEmpty.focus({ preventScroll: true });
}

function lastKnownFrames(st, key, i) {
  const own = (st.attempts[key] || []).slice(0, i).map(framesOf).filter((v) => v != null);
  if (own.length) return own[own.length - 1];
  const idx = st.loads.map(String).indexOf(key);
  for (let j = idx - 1; j >= 0; j--) {
    const prev = (st.attempts[String(st.loads[j])] || []).map(framesOf).filter((v) => v != null);
    if (prev.length) return Math.round(Math.max(...prev) * 0.95);
  }
  return null;
}

function advance(st, draw) {
  st.step = st.step >= st.loads.length - 1 ? "result" : st.step + 1;
  persist(st);
  draw();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- Résultat
/** Droite mesurée + droite optimale + points, force par kg de masse en
 * fonction de la vitesse. */
function plotSVG(r) {
  const w = 300, h = 190, pl = 34, pr = 10, pt = 10, pb = 28;
  const opt = r.optimal;
  const xMax = Math.max(r.V0, opt ? opt.V0 : 0) * 1.05;
  const yMax = Math.max(r.F0_rel, opt ? opt.F0 / r.body_mass_kg : 0) * 1.05;
  const x = (v) => pl + ((w - pl - pr) * v) / xMax;
  const y = (f) => pt + (h - pt - pb) * (1 - f / yMax);
  const line = (f0, v0, cls) => `<line class="${cls}" x1="${x(0).toFixed(1)}" y1="${y(f0).toFixed(1)}" x2="${x(v0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`;
  const dots = r.points.map((p) => `<circle cx="${x(p.velocity_ms).toFixed(1)}" cy="${y(p.force_n / r.body_mass_kg).toFixed(1)}" r="4.5" class="fv-plot-dot"><title>${loadLabel(p.load_kg)}</title></circle>`).join("");
  return `<svg class="fv-plot" viewBox="0 0 ${w} ${h}" role="img" aria-label="Relation force-vitesse mesurée et optimale">
    <line class="fv-plot-axis" x1="${pl}" y1="${pt}" x2="${pl}" y2="${h - pb}"/><line class="fv-plot-axis" x1="${pl}" y1="${h - pb}" x2="${w - pr}" y2="${h - pb}"/>
    <text class="fv-plot-text" x="${pl - 4}" y="${pt + 8}" text-anchor="end">${Math.round(yMax)}</text>
    <text class="fv-plot-text" x="${pl - 4}" y="${h - pb}" text-anchor="end">0</text>
    <text class="fv-plot-text" x="${w - pr}" y="${h - pb + 14}" text-anchor="end">${fr(xMax, 1)} m/s</text>
    <text class="fv-plot-text" x="${pl}" y="${h - pb + 14}" text-anchor="start">0</text>
    <text class="fv-plot-text" x="${pl + 4}" y="${pt + 8}" text-anchor="start">N/kg</text>
    ${opt ? line(opt.F0 / r.body_mass_kg, opt.V0, "fv-plot-opt") : ""}${line(r.F0_rel, r.V0, "fv-plot-line")}${dots}
  </svg>`;
}

function resultHTML(st, r, previous) {
  if (!r) {
    return `<section class="card fv-card">${stepsDots(st)}<h2>Profil impossible à calculer</h2>
      <p class="muted">Il faut au moins 2 charges avec une hauteur valide, qui font baisser la vitesse quand la charge monte. Vérifie le nombre d'images saisi.</p>
      <button class="primary-button" id="fv-back">Revenir aux charges</button></section>`;
  }
  const o = r.orientation ? ORIENTATIONS[r.orientation] : null;
  const delta = previous ? r.Pmax_rel - previous.Pmax_rel : null;
  return `
    <section class="card fv-card">
      ${stepsDots(st)}
      <h2>Ton profil force-vitesse</h2>
      ${o ? `<div class="fv-banner tone-${o.tone}"><strong>${o.label}</strong><span>Déséquilibre ${fr(r.fv_imb_pct, 0)} %${r.fv_imb_sd != null ? ` ± ${fr(r.fv_imb_sd, 0)}` : ""}</span></div>
      <p class="fv-advice">${o.advice}</p>` : ""}
      <div class="mini-stats">
        <div><span>Puissance max</span><strong>${fr(r.Pmax_rel, 1)}<small> W/kg${r.Pmax_rel_sd != null ? ` ± ${fr(r.Pmax_rel_sd, 1)}` : ""}</small></strong>${delta != null ? `<small class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "+" : "−"}${fr(Math.abs(delta), 1)} vs ${shortDateFr(previous.date)}</small>` : ""}</div>
        <div><span>Force max (F0)</span><strong>${fr(r.F0_rel, 1)}<small> N/kg</small></strong></div>
        <div><span>Vitesse max (v0)</span><strong>${fr(r.V0, 2)}<small> m/s</small></strong></div>
      </div>
      ${plotSVG(r)}
      <p class="fv-legend muted small"><span class="fv-key dots"></span>mesures · <span class="fv-key solid"></span>ton profil · <span class="fv-key dashed"></span>profil optimal</p>
      ${r.warnings.length ? `<ul class="fv-warnings">${r.warnings.map((w) => `<li>${w}</li>`).join("")}</ul>` : ""}
      <details class="card-help"><summary>Détail par charge</summary>
        <table class="fv-table"><thead><tr><th>Charge</th><th>Hauteur</th><th>Force</th><th>Vitesse</th></tr></thead><tbody>
        ${r.points.map((p) => `<tr><td>${loadLabel(p.load_kg)}</td><td>${fr(p.height_m * 100, 1)} cm</td><td>${Math.round(p.force_n)} N</td><td>${fr(p.velocity_ms, 2)} m/s</td></tr>`).join("")}
        </tbody></table>
        <p class="muted small">Force et vitesse moyennes de la poussée (méthode de Samozino). Régression sur ${r.n_loads} charges, R² ${fr(r.r2, 3)}. Le ± vient d'une lecture à une image près à chaque saut. Déséquilibre = écart entre ta pente force-vitesse et la pente optimale pour ta puissance, ta masse et ta distance de poussée ; ±10 % = équilibré.</p>
      </details>
      <div class="fv-nav">
        <button type="button" class="primary-button ghost" id="fv-back">Modifier</button>
        <button type="button" class="primary-button" id="fv-save">Enregistrer</button>
      </div>
      <p class="muted small" id="fv-save-status"></p>
    </section>`;
}

function savedHTML(st, queued) {
  return `
    <section class="card fv-card">
      ${stepsDots(st)}
      <h2>${queued ? "Gardé sur le téléphone" : "Test enregistré"} ✓</h2>
      <p class="muted">${queued ? "Envoi dès que le réseau revient." : "Le suivi de Progrès se met à jour dans une minute environ."} Refais le test tous les ~2-3 mois, dans les mêmes conditions (même hPO, même cadence, mêmes charges).</p>
      <button class="primary-button" id="fv-done">Retour à Progrès</button>
    </section>`;
}

export async function renderFvTest(token) {
  const root = document.getElementById("fv-test-content");
  let defaults = {};
  let previous = null;
  try {
    const file = await ghGetFile("data/app/summary.json");
    if (stale(token)) return;
    if (file) {
      const s = JSON.parse(file.content);
      const hist = s.fv_history || [];
      previous = hist.length ? hist[hist.length - 1] : null;
      defaults = { mass: s.bodyweight_progress && s.bodyweight_progress.current_kg != null ? String(Math.round(s.bodyweight_progress.current_kg * 10) / 10).replace(".", ",") : "" };
    }
  } catch (_) { /* hors-ligne : réglages mémorisés seulement */ }

  const st = initialState(defaults);
  let queuedFlag = false;

  const draw = () => {
    if (st.step === "setup") root.innerHTML = setupHTML(st);
    else if (typeof st.step === "number") root.innerHTML = loadStepHTML(st);
    else if (st.step === "result") root.innerHTML = resultHTML(st, analyseTest(buildTest(st)), previous);
    else root.innerHTML = savedHTML(st, queuedFlag);
    if (st.step === "setup") wireSetup(root, st, draw);
    else if (typeof st.step === "number") wireLoadStep(root, st, draw);
    else if (st.step === "result") wireResult(root, st, draw);
    else root.querySelector("#fv-done").addEventListener("click", () => showView("data"));
  };

  const wireResult = () => {
    const back = root.querySelector("#fv-back");
    if (back) back.addEventListener("click", () => { st.step = st.loads.length - 1; persist(st); draw(); });
    const save = root.querySelector("#fv-save");
    if (!save) return;
    save.addEventListener("click", async () => {
      const status = root.querySelector("#fv-save-status");
      const test = buildTest(st);
      save.disabled = true;
      status.textContent = "Enregistrement…";
      try {
        const outcome = await runQueued("fv-test", { test }, { label: "Test force-vitesse" });
        queuedFlag = !!outcome.queued;
        st.step = "saved";
        removeKey(DRAFT_KEY);
        writeJSON(SETTINGS_KEY, { mass: st.mass, hpoMode: st.hpoMode, legCm: st.legCm, iliacCm: st.iliacCm, hpoCm: st.hpoCm, fps: st.fps, entry: st.entry, loads: st.loads });
        draw();
      } catch (err) {
        save.disabled = false;
        status.textContent = `Échec : ${err.message}`;
      }
    });
  };

  // Brouillon repris à l'écran « saved » ? Jamais : il est effacé à l'enregistrement.
  draw();
}
