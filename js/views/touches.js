import { stale } from "../nav.js";
import { escapeHtmlText, escapeAttr } from "../markdown.js";
import {
  TOUCHES, byId, NOTES, validClassique, jumperOf, buildSpec, compute, specLabel, callText, specsOf, allSpecs,
} from "../touches/touches-data.js";

// ============================================================================
// Carnet de touches (docs/adr/0107) — annonces d'alignement animées + quiz.
// Les interprétations marquées « à valider » restent visibles : ce sont des
// lectures de l'utilisateur à confirmer avec son coach, pas des vérités.
// ============================================================================

const DUR = 900;
const STORE = "touches-quiz";
const ui = { id: "c7", code: "50", note: "DO", v: null, phase: 0, quiz: null, score: { ok: 0, n: 0 } };
let raf = 0;
let playTimer = 0;

function loadScore() { try { return JSON.parse(localStorage.getItem(STORE)) || { ok: 0, n: 0 }; } catch { return { ok: 0, n: 0 }; } }
function saveScore() { try { localStorage.setItem(STORE, JSON.stringify(ui.score)); } catch { /* stockage indisponible */ } }

function curSpec() {
  const t = byId[ui.id];
  if (t.classique) return { id: t.id, code: ui.code, note: ui.note };
  if (t.variants) return { id: t.id, v: ui.v || t.variants[0].k };
  return { id: t.id };
}

const KIND_FILL = { fw: "var(--green-light)", hooker: "var(--gold)", nine: "#2F64B3", relay: "#7A5BB5" };

function fieldSVG(tl) {
  const players = tl.players.map((p) =>
    `<g class="tch-p" data-id="${escapeAttr(p.id)}"><circle class="tch-ring" r="0.62" fill="none"/><circle class="tch-dot" r="0.46" fill="${KIND_FILL[p.kind]}"/><text class="tch-lbl" y="0.17" text-anchor="middle">${escapeHtmlText(p.label)}</text></g>`).join("");
  return `<svg class="tch-field" viewBox="-1.5 -5.2 21 11.4" role="img" aria-label="Terrain de l'alignement">
    <rect x="-1.5" y="-5.2" width="21" height="11.4" class="tch-grass"/>
    <line x1="0" y1="-5.2" x2="19.5" y2="-5.2" class="tch-touch"/>
    <line x1="5" y1="-5.2" x2="5" y2="6.2" class="tch-m5"/><line x1="15" y1="-5.2" x2="15" y2="6.2" class="tch-m5"/>
    <g id="tch-arrows"></g>${players}<circle id="tch-ball" r="0.28" class="tch-ball"/></svg>`;
}

function bez(a, b, via, t) {
  if (!via) return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const c = [2 * via[0] - (a[0] + b[0]) / 2, 2 * via[1] - (a[1] + b[1]) / 2], u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

function ballAt(chain, posOf, t) {
  if (!chain.length) return null;
  const n = chain.length, k = Math.min(n - 1, Math.floor(t * n)), local = t * n - k;
  const a = posOf(chain[k][0]), b = posOf(chain[k][1]);
  return [a[0] + (b[0] - a[0]) * Math.min(1, local), a[1] + (b[1] - a[1]) * Math.min(1, local)];
}

export async function renderTouches(token) {
  const root = document.getElementById("touches-content");
  if (!root || stale(token)) return;
  cancelAnimationFrame(raf); clearInterval(playTimer);
  ui.score = loadScore();
  draw(root);
}

function draw(root) {
  cancelAnimationFrame(raf); clearInterval(playTimer);
  const t = byId[ui.id];
  if (t.variants && !ui.v) ui.v = t.variants[0].k;
  if (t.classique && !validClassique(t.classique, ui.code, ui.note)) ui.code = "50";
  const spec = curSpec(), tl = buildSpec(spec), st = compute(tl);
  ui.phase = Math.min(ui.phase, tl.phases.length - 1);

  const groups = [...new Set(TOUCHES.map((x) => x.group))];
  const nav = groups.map((g) => `<div class="tch-group"><span class="tch-gname">${escapeHtmlText(g)}</span>${TOUCHES.filter((x) => x.group === g)
    .map((x) => `<button type="button" class="suggestion-chip${x.id === ui.id ? " active" : ""}" data-touche="${x.id}">${escapeHtmlText(x.name)}</button>`).join("")}</div>`).join("");

  let opts = "";
  if (t.classique) {
    const codes = ["40", "50", "60"].map((c) => `<button type="button" class="suggestion-chip${ui.code === c ? " active" : ""}" data-code="${c}" ${NOTES.some((nn) => validClassique(t.classique, c, nn)) ? "" : "disabled"}>${c}</button>`).join("");
    const notes = NOTES.map((nn) => `<button type="button" class="suggestion-chip${ui.note === nn ? " active" : ""}" data-note="${nn}" ${validClassique(t.classique, ui.code, nn) ? "" : "disabled"} title="${jumperOf(t.classique, nn)}e">${nn}</button>`).join("");
    opts = `<div class="tch-opts">${codes}</div><div class="tch-opts">${notes}</div>`;
  } else if (t.variants) {
    opts = `<div class="tch-opts">${t.variants.map((v) => `<button type="button" class="suggestion-chip${ui.v === v.k ? " active" : ""}" data-v="${v.k}">${escapeHtmlText(v.l)}</button>`).join("")}</div>`;
  }

  const quiz = ui.quiz;
  const sc = ui.score;
  root.innerHTML = `
    <div class="tch-nav">${nav}</div>
    <div class="card tch-card">
      <div class="tch-head"><strong>${escapeHtmlText(quiz ? "Quiz — qui saute ?" : specLabel(spec))}</strong>
        <span class="tch-tag">${escapeHtmlText(quiz ? `${sc.ok}/${sc.n}` : t.placement)}</span></div>
      ${quiz ? "" : opts}
      <div class="tch-call">${escapeHtmlText(quiz ? callText(quiz.spec) + " — " + byId[quiz.spec.id].name : "Annonce : " + callText(spec))}</div>
      ${fieldSVG(quiz ? quiz.tl : tl)}
      <div class="tch-phase"><strong id="tch-pt"></strong><p id="tch-pd" class="muted"></p></div>
      <div class="tch-ctl">
        <button type="button" class="ghost" id="tch-prev" aria-label="Phase précédente">◀</button>
        <button type="button" class="primary-button" id="tch-play">▶ Rejouer</button>
        <button type="button" class="ghost" id="tch-next" aria-label="Phase suivante">▶</button>
      </div>
      <p class="muted tch-sum">${escapeHtmlText(t.sum)}</p>
      ${t.interp ? `<p class="tch-interp">À valider avec le coach : ${escapeHtmlText(t.interp)}</p>` : ""}
      <div class="tch-quizbar"><button type="button" class="ghost" id="tch-quiz">${quiz ? "Quitter le quiz" : "Mode quiz"}</button>
        ${quiz ? `<button type="button" class="ghost" id="tch-qnext">Suivante</button>` : ""}</div>
    </div>`;

  const $ = (id) => root.querySelector("#" + id);
  const svg = root.querySelector(".tch-field");
  const useTl = quiz ? quiz.tl : tl, useSt = quiz ? quiz.st : st;
  const cur = {};
  const els = {};
  useTl.players.forEach((p) => { els[p.id] = svg.querySelector(`.tch-p[data-id="${CSS.escape(p.id)}"]`); });
  const ballEl = svg.querySelector("#tch-ball");
  const arrows = svg.querySelector("#tch-arrows");

  const paint = (ph, jumpT) => {
    useTl.players.forEach((p) => {
      const c = cur[p.id]; const g = els[p.id];
      g.setAttribute("transform", `translate(${c[0].toFixed(2)} ${c[1].toFixed(2)})`);
    });
  };
  const decorate = (i, h) => {
    const ph = useTl.phases[i], s = useSt[i];
    useTl.players.forEach((p) => {
      const g = els[p.id];
      g.classList.toggle("is-out", s.out.has(p.id));
      g.classList.toggle("is-jump", !!(ph.jump && h && ph.jump.J === p.id));
      g.classList.toggle("is-lift", !!(ph.jump && h && ph.jump.L.includes(p.id)));
      g.classList.toggle("is-feint", !!(ph.feint && (ph.feint.J === p.id || ph.feint.L.includes(p.id))));
    });
    arrows.innerHTML = h && ph.arrows ? ph.arrows.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="tch-arrow"/>`).join("") : "";
  };
  const textFor = (i) => {
    if (quiz && !quiz.revealed) { $("tch-pt").textContent = "Touche l'alignement…"; $("tch-pd").textContent = "Appuie sur le joueur que tu penses être le sauteur."; return; }
    $("tch-pt").textContent = `${i + 1}/${useTl.phases.length} · ${useTl.phases[i].t}`;
    $("tch-pd").textContent = useTl.phases[i].d;
  };

  // état initial : positions de la phase courante, sans animation
  const snap = (i) => {
    useTl.players.forEach((p) => { cur[p.id] = [...useSt[i].pos[p.id]]; });
    paint(); decorate(i, true);
    const b = posBall(i); ballEl.setAttribute("cx", b[0]); ballEl.setAttribute("cy", b[1]);
    textFor(i);
  };
  const posBall = (i) => {
    const h = useSt[i].holder; const p = cur[h] || [0, 0]; return [p[0] + 0.5, p[1] - 0.5];
  };
  const goTo = (i, animate = true) => {
    i = Math.max(0, Math.min(useTl.phases.length - 1, i));
    cancelAnimationFrame(raf);
    const from = {}; useTl.players.forEach((p) => { from[p.id] = [...cur[p.id]]; });
    const ph = useTl.phases[i], to = useSt[i].pos;
    ui.phase = i; textFor(i); decorate(i, false);
    root.querySelector("#tch-prev").disabled = i === 0; root.querySelector("#tch-next").disabled = i === useTl.phases.length - 1;
    if (!animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { snap(i); return; }
    const t0 = performance.now();
    const step = (now) => {
      if (!root.isConnected) return;
      const k = Math.min(1, (now - t0) / DUR), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      useTl.players.forEach((p) => { cur[p.id] = bez(from[p.id], to[p.id], ph.via && ph.via[p.id], e); });
      paint();
      const bp = ph.ball ? ballAt(ph.ball, (id) => cur[id], e) : null;
      const b = bp || posBall(i);
      ballEl.setAttribute("cx", (b[0] + (bp ? 0 : 0)).toFixed(2)); ballEl.setAttribute("cy", b[1].toFixed(2));
      if (k < 1) raf = requestAnimationFrame(step); else { decorate(i, true); const fb = posBall(i); ballEl.setAttribute("cx", fb[0]); ballEl.setAttribute("cy", fb[1]); }
    };
    raf = requestAnimationFrame(step);
  };

  // la vue s'ouvre sans lancer d'animation : phase 1 posée
  snap(0);
  if (ui.phase > 0 && !quiz) { snap(0); goTo(ui.phase, false); }
  root.querySelector("#tch-prev").disabled = ui.phase === 0;
  root.querySelector("#tch-next").disabled = ui.phase === useTl.phases.length - 1;

  root.querySelectorAll("[data-touche]").forEach((b) => b.addEventListener("click", () => { ui.id = b.dataset.touche; ui.v = null; ui.phase = 0; ui.quiz = null; draw(root); }));
  root.querySelectorAll("[data-code]").forEach((b) => b.addEventListener("click", () => { ui.code = b.dataset.code; ui.phase = 0; draw(root); }));
  root.querySelectorAll("[data-note]").forEach((b) => b.addEventListener("click", () => { ui.note = b.dataset.note; ui.phase = 0; draw(root); }));
  root.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => { ui.v = b.dataset.v; ui.phase = 0; draw(root); }));
  $("tch-prev").addEventListener("click", () => goTo(ui.phase - 1));
  $("tch-next").addEventListener("click", () => goTo(ui.phase + 1));
  $("tch-play").addEventListener("click", () => {
    clearInterval(playTimer); snap(0); let i = 0;
    playTimer = setInterval(() => {
      if (!root.isConnected || i + 1 >= useTl.phases.length) { clearInterval(playTimer); return; }
      i += 1; goTo(i);
    }, DUR + 900);
  });

  $("tch-quiz").addEventListener("click", () => { ui.quiz = quiz ? null : newQuiz(); ui.phase = 0; draw(root); });
  if (quiz) {
    $("tch-qnext").addEventListener("click", () => { ui.quiz = newQuiz(); draw(root); });
    // quiz : on montre la fin de la chorégraphie, sans l'indice du sauteur
    const last = useTl.phases.findIndex((p) => p.jump);
    svg.querySelectorAll(".tch-p").forEach((g) => g.addEventListener("click", () => {
      if (quiz.revealed) return;
      quiz.revealed = true; ui.score.n += 1;
      const ok = g.dataset.id === quiz.answer; if (ok) ui.score.ok += 1; saveScore();
      draw(root); $("tch-pt").textContent = ok ? "Bien vu !" : `Raté — c'était le ${quiz.answer}`;
    }));
    if (!quiz.revealed) { snap(Math.max(0, last - 1)); textFor(0); decorate(Math.max(0, last - 1), false); $("tch-prev").hidden = $("tch-next").hidden = $("tch-play").hidden = true; }
    else { snap(last); }
  }
}

function newQuiz() {
  const specs = allSpecs().filter((s) => buildSpec(s).phases.some((p) => p.jump));
  const spec = specs[Math.floor(Math.random() * specs.length)];
  const tl = buildSpec(spec), st = compute(tl);
  const answer = tl.phases.find((p) => p.jump).jump.J;
  return { spec, tl, st, answer, revealed: false };
}
