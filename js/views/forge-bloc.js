import { ghGetFile, ghListDir, ghPutFile, ghPutJSON } from "../github-api.js";
import { state, stale, showView } from "../nav.js";
import { localISOWithOffset, formatFrDate, todayISO, addDaysISO } from "../date-utils.js";
import { loadClubConfig } from "../club-training.js";
import { escapeAttr, escapeHtmlText, skeletonHTML } from "../markdown.js";
import { setupMicButton } from "../voice-input.js";
import { postUserMessage, dispatchStatusNote } from "./chat.js";

// ============================================================================
// Forge de bloc (docs/adr/0085) — retour d'Aubin : « une forme de forge qui me
// permette de mettre en place des choix et objectifs pour un bloc donné, avec
// des sections à remplir et une sorte de discussion qui permettrait d'avoir
// les objectifs les plus pertinents ».
//
// Deux fichiers, un par écrivain (même principe que ADR-0083, pas de conflit
// de sha) :
//  - data/blocks/drafts/<label>.json        → app SEULE : sections + messages
//  - data/blocks/drafts/<label>.coach.json  → coach SEUL : réponses + suggestions
// « Créer le bloc » écrit data/blocks/<label>.md à partir des sections.
// La discussion passe par le chat habituel (`[Forge bloc <label>] …`, routé
// par prompts/app-chat.md vers prompts/block-plan.md « Mode Forge de bloc »).
// ============================================================================

export const BLOC_QUALITIES = [
  { id: "force_max", label: "Force maximale" },
  { id: "puissance", label: "Puissance / explosivité" },
  { id: "hypertrophie", label: "Hypertrophie / accessoires" },
  { id: "tronc", label: "Tronc / gainage" },
  { id: "epaule", label: "Épaule" },
  { id: "conditionnement", label: "Conditionnement" },
  { id: "contact", label: "Reprise du contact" },
];
const QUALITY_LABELS = Object.fromEntries(BLOC_QUALITIES.map((q) => [q.id, q.label]));

const draftPath = (label) => `data/blocks/drafts/${label}.json`;
const coachPath = (label) => `data/blocks/drafts/${label}.coach.json`;
const blockPath = (label) => `data/blocks/${label}.md`;

const EMPTY_SECTIONS = {
  objectif: "",
  duree_semaines: "",
  debut: "",
  fin_evenement: "",
  qualites: [],
  contraintes: "",
  structure: { muscu_par_semaine: "", rugby_par_semaine: "" },
  jalons: "",
};

function parse(file, fallback) {
  if (!file) return fallback;
  try { return JSON.parse(file.content) || fallback; } catch (_) { return fallback; }
}

/** Libellés de blocs connus : B<n>.md existants, brouillons, et le suivant. */
async function knownLabels() {
  const [blocks, drafts] = await Promise.all([ghListDir("data/blocks").catch(() => []), ghListDir("data/blocks/drafts").catch(() => [])]);
  const nums = new Set();
  for (const e of blocks) { const m = /^B(\d+)\.md$/.exec(e.name || ""); if (m) nums.add(Number(m[1])); }
  const draftNums = new Set();
  for (const e of drafts) { const m = /^B(\d+)\.json$/.exec(e.name || ""); if (m) draftNums.add(Number(m[1])); }
  const next = Math.max(0, ...nums) + 1; // le bloc qui suit le dernier créé
  const all = new Set([...draftNums, next]);
  return [...all].sort((a, b) => a - b).map((n) => `B${n}`);
}

/** Markdown du bloc écrit à la validation — même ossature que B4.md. */
export function blockMarkdown(label, s, feelings) {
  const lines = [];
  const title = s.fin_evenement ? ` — jusqu'à ${s.fin_evenement}` : "";
  lines.push(`# Bloc ${label}${title}`, "");
  const frame = [
    s.duree_semaines ? `${s.duree_semaines} semaines` : null,
    s.debut ? `à partir du ${formatFrDate(s.debut)}` : null,
  ].filter(Boolean).join(" ");
  if (frame) lines.push(frame + ".", "");
  lines.push("## Objectifs principaux du bloc", "");
  const goals = String(s.objectif || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const g of goals) lines.push(`- ${g.replace(/^[-•]\s*/, "")}`);
  if (!goals.length) lines.push("- (à préciser)");
  if ((s.qualites || []).length) {
    lines.push("", "### Qualités à développer (par priorité)", "");
    s.qualites.forEach((id, i) => lines.push(`${i + 1}. ${QUALITY_LABELS[id] || id}`));
  }
  const st = s.structure || {};
  if (st.muscu_par_semaine !== "" || st.rugby_par_semaine !== "") {
    lines.push("", "## Structure type", "");
    if (st.muscu_par_semaine !== "") lines.push(`- Musculation : ${st.muscu_par_semaine} séance(s) par semaine`);
    if (st.rugby_par_semaine !== "") lines.push(`- Rugby club : ${st.rugby_par_semaine} séance(s) par semaine`);
  }
  if (s.contraintes && s.contraintes.trim()) lines.push("", "## Contraintes et gênes", "", s.contraintes.trim());
  if (s.jalons && s.jalons.trim()) lines.push("", "## Jalons et tests", "", s.jalons.trim());
  const themes = ((feelings && feelings.themes) || []).slice(0, 3);
  if (themes.length) {
    lines.push("", "## Ressentis pris en compte (ressentis de match ×3)", "");
    for (const t of themes) {
      const m = t.mentions[0];
      lines.push(`- ${THEME_LABELS[t.theme] || t.theme}${m ? ` — « ${m.text} » (${SOURCE_LABELS[m.source] || m.source}, ${formatFrDate(m.date)})` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

const THEME_LABELS = { contact: "Contact", fatigue: "Fatigue / épuisement", conditionnement: "Conditionnement", force: "Force", vitesse: "Vitesse / explosivité", douleur: "Douleur / gêne" };
const SOURCE_LABELS = { match: "match", session: "séance / note", checkin: "check-in", pain: "douleur" };

function feelingsHTML(f) {
  const themes = (f && f.themes) || [];
  if (!f || (!themes.length && !(f.matches || []).length)) {
    return `<p class="muted small">Pas encore de ressenti exprimé (notes de match, de séance, notes vocales).</p>`;
  }
  const rows = themes.slice(0, 4).map((t) => {
    const m = t.mentions[0];
    return `<li><span class="bloc-theme"><strong>${escapeHtmlText(THEME_LABELS[t.theme] || t.theme)}</strong>
        <span class="bloc-theme-score" title="Poids cumulé : un ressenti de match compte ×3">${t.score % 1 ? t.score.toFixed(1) : t.score}</span></span>
      ${m ? `<div class="muted small">« ${escapeHtmlText(m.text)} » <em>(${escapeHtmlText(SOURCE_LABELS[m.source] || m.source)}, ${escapeHtmlText(formatFrDate(m.date))})</em></div>` : ""}</li>`;
  }).join("");
  return `
    ${rows ? `<ul class="bloc-themes">${rows}</ul>` : ""}
    <p class="muted small">Les ressentis exprimés après un match comptent trois fois plus. Le RPE (matchs ${f.rpe && f.rpe.matches != null ? f.rpe.matches : "—"}, séances ${f.rpe && f.rpe.sessions != null ? f.rpe.sessions : "—"}) n'est pas pondéré.</p>`;
}

function threadHTML(messages) {
  if (!messages.length) return `<p class="muted small">Pas encore de discussion. Remplis ce que tu sais, puis demande au coach quels objectifs sont les plus pertinents.</p>`;
  return messages.map((m) => `
    <div class="bloc-msg ${m.role === "coach" ? "from-coach" : "from-user"}">
      <span class="bloc-msg-who">${m.role === "coach" ? "Coach" : "Moi"}</span>
      <p>${escapeHtmlText(m.text).replace(/\n/g, "<br>")}</p>
    </div>`).join("");
}

const SECTION_LABELS = { objectif: "Objectif principal", contraintes: "Contraintes & gênes", jalons: "Jalons / tests", fin_evenement: "Fin / événement" };

export async function renderForgeBloc(token) {
  const root = document.getElementById("forge-bloc-root");
  if (!root) return;
  root.innerHTML = skeletonHTML();
  const labels = await knownLabels();
  if (stale(token)) return;
  if (!state.forgeBlocLabel || !labels.includes(state.forgeBlocLabel)) state.forgeBlocLabel = labels[labels.length - 1];
  await drawBloc(root, token);
}

const WEEKDAY_SHORT = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];
const frShort = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function nextMondayISO(today) {
  const d = new Date(`${today}T12:00:00`);
  const add = ((8 - (d.getDay() || 7)) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

/** Prochains matchs joués par Aubin (Première, après sa reprise) — proposés
 * comme « événement visé » du bloc. */
async function upcomingMatches(today) {
  const entries = await ghListDir("data/schedule").catch(() => []);
  const out = [];
  for (const e of entries.filter((x) => /^matches-.*\.json$/.test(x.name || "") && !/reserves/.test(x.name))) {
    const file = await ghGetFile(e.path).catch(() => null);
    const season = parse(file, null);
    if (!season) continue;
    const from = season.user_return_to_play_date || "0000-00-00";
    for (const f of season.fixtures || []) if (f.date >= today && f.date >= from && !f.performance) out.push(f);
  }
  return out.sort((x, y) => x.date.localeCompare(y.date)).slice(0, 3);
}

/** Point de départ : ce qui rend les objectifs pertinents, lu dans le résumé
 * (trajectoires, charge, fréquence de muscu, douleurs) + objectifs rapides
 * à ajouter d'un geste. */
function startingPoint(sum, matches) {
  const facts = [];
  const quick = [];
  const LIFTS = { back_squat: "Back Squat", bench: "Bench", trap_bar_deadlift: "Trap Bar Deadlift" };
  for (const [key, label] of Object.entries(LIFTS)) {
    const t = (sum.strength_trajectory || {})[key];
    if (!t || !t.target) continue;
    const best = t.recent_best && t.recent_best.load;
    const pct = t.progress_fraction != null ? Math.round(t.progress_fraction * 100) : null;
    const target = t.target.four_rm.toFixed(1).replace(".", ",");
    facts.push(`${label} : ${best != null ? `${best}` : "—"} → ${target} kg${pct != null ? ` (${pct} %)` : ""}`);
    if (pct == null || pct < 100) quick.push(`${label} : ${best != null ? `${best} → ` : ""}${target} kg (4RM)`);
  }
  const w = sum.workload;
  if (w && w.zone) facts.push(`Charge aiguë:chronique ${w.ratio != null ? w.ratio.toFixed(2).replace(".", ",") : ""} · ${String(w.zone).replace(/_/g, " ")}`);
  const gf = sum.gym_frequency;
  if (gf && gf.status && gf.status.low) {
    facts.push(`Musculation sous ${gf.target} séances/semaine depuis ${gf.status.consecutive_low_weeks} semaines`);
    quick.push(`Tenir ${gf.target} séances de musculation par semaine`);
  }
  const eps = ((sum.pain_recent || {}).episodes || []).filter((e) => e && (e.last_date || e.end_date || e.start_date));
  if (eps.length) {
    const zones = (sum.pain_recent || {}).zones || {};
    const names = [...new Set(eps.slice(0, 3).map((e) => zones[e.zone] || e.zone).filter(Boolean))];
    if (names.length) { facts.push(`Gênes récentes : ${names.join(", ")}`); quick.push(`Gérer la gêne (${names[0]}) : zéro douleur à l'entraînement`); }
  }
  if (matches[0]) quick.push(`Être prêt pour le match du ${frShort(matches[0].date)}`);
  const top = ((sum.feelings || {}).themes || []).filter((t) => t.score >= 3 && ["contact", "conditionnement", "force", "vitesse"].includes(t.theme)).slice(0, 2);
  for (const t of top) quick.push(`Travailler : ${(THEME_LABELS[t.theme] || t.theme).toLowerCase()} (ressenti de match)`);
  const tired = ((sum.feelings || {}).themes || []).find((t) => t.theme === "fatigue" && t.score >= 3);
  if (tired) facts.push("Fatigue exprimée après match : prévoir une semaine d'accroche progressive");
  return { facts, quick };
}

function progressOf(s) {
  const done = [
    s.duree_semaines !== "" && !!s.debut,
    !!String(s.objectif || "").trim(),
    (s.qualites || []).length > 0,
    s.structure.muscu_par_semaine !== "" || s.structure.rugby_par_semaine !== "",
    !!(String(s.contraintes || "").trim() || String(s.jalons || "").trim()),
  ];
  return { n: done.filter(Boolean).length, total: done.length, done };
}

const PROMPT_CHIPS = [
  "Quels objectifs prioriser vu mes ressentis récents ?",
  "Challenge mes objectifs : qu'est-ce qui est trop ambitieux ?",
  "Que garder du bloc précédent, que changer ?",
];

async function drawBloc(root, token) {
  const label = state.forgeBlocLabel;
  const today = todayISO();
  const labels = await knownLabels();
  const [draftFile, coachFile, summaryFile, matches, club] = await Promise.all([
    ghGetFile(draftPath(label)).catch(() => null),
    ghGetFile(coachPath(label)).catch(() => null),
    ghGetFile("data/app/summary.json").catch(() => null),
    upcomingMatches(today).catch(() => []),
    loadClubConfig().catch(() => ({ weekdays: [3, 5] })),
  ]);
  if (stale(token)) return;
  const draft = parse(draftFile, { label, sections: {}, messages: [] });
  const coach = parse(coachFile, { messages: [], suggestions: [] });
  const sum = parse(summaryFile, {}) || {};
  const feelings = sum.feelings || null;
  const s = { ...EMPTY_SECTIONS, ...(draft.sections || {}), structure: { ...EMPTY_SECTIONS.structure, ...((draft.sections || {}).structure || {}) } };
  s.qualites = Array.isArray(s.qualites) ? s.qualites : [];
  // Valeurs par défaut sensées (enregistrées à la première modification) :
  // début = lundi prochain, durée 5 semaines, rugby = nombre de jours de club.
  if (!s.debut) s.debut = nextMondayISO(today);
  if (s.duree_semaines === "") s.duree_semaines = 5;
  if (s.structure.rugby_par_semaine === "") s.structure.rugby_par_semaine = (club.weekdays || []).length;
  if (s.structure.muscu_par_semaine === "") s.structure.muscu_par_semaine = 2;

  const rank = (id) => s.qualites.indexOf(id) + 1;
  const chips = BLOC_QUALITIES.map((q) => `<button type="button" class="suggestion-chip${rank(q.id) ? " active" : ""}" data-quality="${q.id}">${rank(q.id) ? `${rank(q.id)}. ` : ""}${escapeHtmlText(q.label)}</button>`).join("");
  const num = (v, min, max, name, ph) => `<input type="number" inputmode="numeric" data-field="${name}" min="${min}" max="${max}" step="1" value="${escapeAttr(String(v ?? ""))}" placeholder="${ph}">`;
  const messages = [...(draft.messages || []), ...(coach.messages || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const suggestions = (coach.suggestions || []).filter((x) => x && x.section && x.text);
  const sp = startingPoint(sum, matches);
  const prog = progressOf(s);
  const stepNames = ["Cadre", "Objectif", "Qualités", "Structure", "Contraintes"];
  const eventChips = matches.map((m, i) => `<button type="button" class="suggestion-chip" data-event="${i}">Match ${frShort(m.date)}${m.opponent ? ` · ${escapeHtmlText(m.opponent)}` : ""}</button>`).join("");

  root.innerHTML = `
    <section class="card bloc-head">
      <div class="card-head"><h2>Forge de bloc</h2>
        <select id="bloc-label" aria-label="Bloc">${labels.map((l) => `<option${l === label ? " selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="bloc-steps" id="bloc-steps">${stepNames.map((n, i) => `<span class="bloc-step${prog.done[i] ? " done" : ""}">${prog.done[i] ? "✓ " : ""}${n}</span>`).join("")}</div>
      <p id="bloc-save-status" class="muted small">Tout s'enregistre au fil de l'eau.</p>
    </section>

    <section class="card">
      <h2>Point de départ</h2>
      ${sp.facts.length ? `<ul class="bloc-facts">${sp.facts.map((f) => `<li>${escapeHtmlText(f)}</li>`).join("")}</ul>` : `<p class="muted small">Pas assez de données pour un état des lieux.</p>`}
      <h3 class="bloc-sub">Mes ressentis</h3>
      ${feelingsHTML(feelings)}
    </section>

    <section class="card">
      <h2>Cadre</h2>
      <div class="bloc-grid-2">
        <div><label>Début</label><input type="date" data-field="debut" value="${escapeAttr(s.debut || "")}"></div>
        <div><label>Durée (semaines)</label>${num(s.duree_semaines, 1, 12, "duree_semaines", "5")}</div>
      </div>
      <p class="muted small" id="bloc-end-hint"></p>
      <label>Fin / événement visé</label>
      <input type="text" data-field="fin_evenement" value="${escapeAttr(s.fin_evenement || "")}" placeholder="Ex. retour en match le 18/10">
      ${eventChips ? `<div class="bloc-chips">${eventChips}</div>` : ""}
    </section>

    <section class="card">
      <h2>Objectifs</h2>
      <textarea data-field="objectif" rows="5" placeholder="Une ligne par objectif, mesurable">${escapeHtmlText(s.objectif || "")}</textarea>
      ${sp.quick.length ? `<p class="muted small" style="margin-top:8px">Ajouter d'un tap :</p><div class="bloc-chips" id="bloc-quick">${sp.quick.map((q, i) => `<button type="button" class="suggestion-chip" data-quick="${i}">+ ${escapeHtmlText(q)}</button>`).join("")}</div>` : ""}
      <h3 class="bloc-sub">Qualités à développer</h3>
      <p class="muted small">Touche dans l'ordre de priorité (re-touche pour retirer).</p>
      <div class="bloc-chips">${chips}</div>
    </section>

    <section class="card bloc-chat">
      <h2>Discussion avec le coach</h2>
      <div id="bloc-thread">${threadHTML(messages)}</div>
      ${suggestions.length ? `<div class="bloc-suggestions"><p class="small"><strong>Propositions du coach</strong></p>${suggestions.map((x, i) => `
        <div class="bloc-suggestion"><div class="small"><strong>${escapeHtmlText(SECTION_LABELS[x.section] || x.section)}</strong>${x.why ? ` — <span class="muted">${escapeHtmlText(x.why)}</span>` : ""}</div>
          <p class="small">${escapeHtmlText(x.text).replace(/\n/g, "<br>")}</p>
          <button type="button" class="primary-button ghost small" data-apply="${i}">Appliquer</button></div>`).join("")}</div>` : ""}
      <p class="bloc-chat-label">Questions rapides</p>
      <div class="bloc-prompts" id="bloc-prompts">${PROMPT_CHIPS.map((p, i) => `<button type="button" class="suggestion-chip" data-prompt="${i}">${escapeHtmlText(p)}</button>`).join("")}</div>
      <div class="compose-row">
        <textarea id="bloc-input" rows="2" placeholder="Pose une question ou précise un point…"></textarea>
        <button type="button" class="mic-button" id="bloc-mic" title="Dicter" aria-label="Dicter"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
      </div>
      <p class="voice-hint" id="bloc-voice-hint" hidden></p>
      <p class="live-caption" id="bloc-live-caption" hidden></p>
      <button type="button" class="primary-button" id="bloc-send">💬 Envoyer au coach</button>
      <p id="bloc-chat-status" class="muted small"></p>
    </section>

    <section class="card">
      <h2>Structure & contraintes</h2>
      <div class="bloc-grid-2">
        <div><label>Muscu / semaine</label>${num(s.structure.muscu_par_semaine, 0, 6, "muscu_par_semaine", "2")}</div>
        <div><label>Rugby club / semaine</label>${num(s.structure.rugby_par_semaine, 0, 6, "rugby_par_semaine", "2")}</div>
      </div>
      <label>Contraintes & gênes</label>
      <textarea data-field="contraintes" rows="3" placeholder="Blessures, indispos, matchs, déplacements…">${escapeHtmlText(s.contraintes || "")}</textarea>
      <label>Jalons / tests</label>
      <textarea data-field="jalons" rows="3" placeholder="Ex. test 4RM Squat en S4">${escapeHtmlText(s.jalons || "")}</textarea>
    </section>

    <section class="card">
      <h2>Valider</h2>
      <p class="muted small">Crée <code>${blockPath(label)}</code> : le bloc que le coach et Plan › Bloc liront.</p>
      <button type="button" class="primary-button" id="bloc-create">✅ Créer le bloc ${label}</button>
      <p id="bloc-create-status" class="muted small"></p>
    </section>`;

  wireBloc(root, token, { label, s, feelings, coachMessagesCount: (coach.messages || []).length, suggestions, matches, quick: sp.quick });
}

function readSections(root, s) {
  const next = { ...s, structure: { ...s.structure } };
  root.querySelectorAll("[data-field]").forEach((el) => {
    const k = el.dataset.field;
    if (k === "muscu_par_semaine" || k === "rugby_par_semaine") next.structure[k] = el.value === "" ? "" : Number(el.value);
    else if (k === "duree_semaines") next[k] = el.value === "" ? "" : Number(el.value);
    else next[k] = el.value;
  });
  return next;
}

async function saveDraft(label, sections, extraMessage) {
  await ghPutJSON(draftPath(label), { label, sections: {}, messages: [] }, `Forge de bloc ${label} : brouillon`, (cur) => {
    const base = cur || { label, sections: {}, messages: [] };
    base.label = label;
    base.updated_at = localISOWithOffset();
    base.sections = sections;
    base.messages = base.messages || [];
    if (extraMessage) base.messages.push(extraMessage);
    return base;
  });
}

function wireBloc(root, token, ctx) {
  const { label, feelings } = ctx;
  let sections = ctx.s;
  const statusEl = root.querySelector("#bloc-save-status");
  let timer = null;
  const scheduleSave = () => {
    clearTimeout(timer);
    statusEl.textContent = "…";
    timer = setTimeout(async () => {
      sections = readSections(root, sections);
      try { await saveDraft(label, sections); statusEl.textContent = "Enregistré ✓"; }
      catch (err) { statusEl.textContent = `Échec : ${err.message}`; }
    }, 900);
  };
  root.querySelectorAll("[data-field]").forEach((el) => el.addEventListener("input", () => { refreshDerived(); scheduleSave(); }));

  // Fin calculée (début + durée) et avancement, recalculés à chaque saisie.
  const hint = root.querySelector("#bloc-end-hint");
  const refreshDerived = () => {
    const cur = readSections(root, sections);
    if (cur.debut && cur.duree_semaines) {
      const end = addDaysISO(cur.debut, cur.duree_semaines * 7 - 1);
      hint.textContent = `S1 le ${formatFrDate(cur.debut)} → S${cur.duree_semaines} jusqu'au ${formatFrDate(end)}.`;
    } else hint.textContent = "";
    const prog = progressOf(cur);
    root.querySelectorAll(".bloc-step").forEach((el, i) => {
      el.classList.toggle("done", prog.done[i]);
      el.textContent = `${prog.done[i] ? "✓ " : ""}${["Cadre", "Objectif", "Qualités", "Structure", "Contraintes"][i]}`;
    });
  };
  refreshDerived();

  // Événement visé (prochain match) : remplit « fin » et cale la durée.
  root.querySelectorAll("[data-event]").forEach((chip) => chip.addEventListener("click", () => {
    const m = ctx.matches[Number(chip.dataset.event)];
    root.querySelector('[data-field="fin_evenement"]').value = `match du ${frShort(m.date)}${m.opponent ? ` (${m.opponent})` : ""}`;
    const debut = root.querySelector('[data-field="debut"]').value;
    if (debut && m.date >= debut) {
      const weeks = Math.max(1, Math.min(12, Math.ceil((new Date(`${m.date}T12:00:00`) - new Date(`${debut}T12:00:00`)) / (7 * 86400000))));
      root.querySelector('[data-field="duree_semaines"]').value = weeks;
    }
    refreshDerived();
    scheduleSave();
  }));

  // Objectifs rapides : ajoutés en fin de liste, une seule fois.
  root.querySelectorAll("[data-quick]").forEach((chip) => chip.addEventListener("click", () => {
    const text = ctx.quick[Number(chip.dataset.quick)];
    const ta = root.querySelector('[data-field="objectif"]');
    if (!ta.value.includes(text)) ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + text;
    chip.classList.add("active");
    refreshDerived();
    scheduleSave();
  }));

  // Questions types : préremplissent la discussion.
  root.querySelectorAll("[data-prompt]").forEach((chip) => chip.addEventListener("click", () => {
    const input = root.querySelector("#bloc-input");
    input.value = PROMPT_CHIPS[Number(chip.dataset.prompt)];
    input.focus();
  }));

  root.querySelectorAll("[data-quality]").forEach((chip) => chip.addEventListener("click", () => {
    const id = chip.dataset.quality;
    sections = readSections(root, sections);
    sections.qualites = sections.qualites.includes(id) ? sections.qualites.filter((q) => q !== id) : [...sections.qualites, id];
    root.querySelectorAll("[data-quality]").forEach((c) => {
      const r = sections.qualites.indexOf(c.dataset.quality) + 1;
      c.classList.toggle("active", !!r);
      c.textContent = `${r ? `${r}. ` : ""}${QUALITY_LABELS[c.dataset.quality]}`;
    });
    scheduleSave();
  }));

  root.querySelector("#bloc-label").addEventListener("change", (e) => {
    state.forgeBlocLabel = e.target.value;
    renderForgeBloc(state.renderToken).catch(() => {});
  });

  root.querySelectorAll("[data-apply]").forEach((btn) => btn.addEventListener("click", () => {
    const sug = ctx.suggestions[Number(btn.dataset.apply)];
    const el = root.querySelector(`[data-field="${sug.section}"]`);
    if (!el) return;
    el.value = sug.text;
    scheduleSave();
    btn.textContent = "Appliqué ✓";
    btn.disabled = true;
  }));

  const micBtn = root.querySelector("#bloc-mic");
  if (micBtn) setupMicButton(micBtn, root.querySelector("#bloc-voice-hint"), root.querySelector("#bloc-input"), root.querySelector("#bloc-live-caption"));

  const chatStatus = root.querySelector("#bloc-chat-status");
  root.querySelector("#bloc-send").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (micBtn && micBtn.classList.contains("recording")) micBtn.click();
    const input = root.querySelector("#bloc-input");
    const text = input.value.trim();
    if (!text) return;
    btn.disabled = true;
    chatStatus.textContent = "Envoi…";
    try {
      clearTimeout(timer);
      sections = readSections(root, sections);
      const at = localISOWithOffset();
      await saveDraft(label, sections, { role: "user", text, at });
      const dispatch = await postUserMessage(`[Forge bloc ${label}] ${text}`);
      input.value = "";
      chatStatus.textContent = (dispatch.dispatched
        ? "Envoyé ✓ — la réponse du coach apparaît ici toute seule (quelques minutes)."
        : "Envoyé ✓ — la réponse apparaîtra ici automatiquement.") + dispatchStatusNote(dispatch);
      startBlocPolling(root, token, ctx.coachMessagesCount);
      root.querySelector("#bloc-thread").innerHTML = threadHTML([{ role: "user", text, at }]);
    } catch (err) {
      chatStatus.textContent = `Échec : ${err.message}`;
    }
    btn.disabled = false;
  });

  root.querySelector("#bloc-create").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const out = root.querySelector("#bloc-create-status");
    sections = readSections(root, sections);
    if (!String(sections.objectif || "").trim()) { out.textContent = "Renseigne au moins l'objectif principal."; return; }
    btn.disabled = true;
    out.textContent = "Création…";
    try {
      const existing = await ghGetFile(blockPath(label));
      if (existing && !window.confirm(`${blockPath(label)} existe déjà : le remplacer ?`)) { out.textContent = "Annulé."; btn.disabled = false; return; }
      await saveDraft(label, sections);
      await ghPutFile(blockPath(label), blockMarkdown(label, sections, feelings), `Forge de bloc : ${label} créé`, existing ? existing.sha : null);
      out.textContent = `Bloc ${label} créé ✓ — visible dans Plan › Bloc.`;
    } catch (err) {
      out.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });
}

let blocPollTimer = null;
function startBlocPolling(root, token, knownCoachCount) {
  clearInterval(blocPollTimer);
  let ticks = 0;
  blocPollTimer = setInterval(async () => {
    ticks += 1;
    if (state.view !== "forge-bloc" || ticks > 60 || stale(token)) { clearInterval(blocPollTimer); return; }
    const file = await ghGetFile(coachPath(state.forgeBlocLabel)).catch(() => null);
    const coach = parse(file, { messages: [] });
    if ((coach.messages || []).length > knownCoachCount) {
      clearInterval(blocPollTimer);
      await drawBloc(root, token);
    }
  }, 10000);
}
