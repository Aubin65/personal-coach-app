import { ghGetFile, ghListDir, ghDeleteFile } from "./github-api.js";
import { state, stale, showView } from "./nav.js";
import { addDaysISO, formatFrDate, sessionIsBlankSkeleton } from "./date-utils.js";
import { escapeHtmlText } from "./markdown.js";
import { findSessionForDate } from "./training-index.js";
import { defaultSessionName, defaultBlockMeta } from "./session/session-model.js";
import { saveSession } from "./session/session-form.js";
import { refineBoxHTML, wireRefineBox } from "./proposal-refine.js";
import { proposedDayHTML, bindProposedDayEdits } from "./proposal-overview.js";

// ---- Squelette de semaine proposé par le coach (Forge → « Squelette IA ») ----
// Écrit par prompts/forge-skeleton.md dans
// data/training/app-log/pending/<lundi>.json et jamais appliqué directement :
// il se valide (ou se retouche) ici. Affiché dans Plan › Semaine ET dans la
// Forge, avec le détail des séances (ADR-0103) — même carte des deux côtés.

/** Maps one proposed day from a pending Forge skeleton into the app's
 * actual session schema — shared by the bulk "Valider" (writes straight to
 * GitHub) and the per-day "✏️" (opens it as an editable draft in the session
 * view first, see renderSession's forgePrefillDraft handling).
 *
 * Un bloc non standard (EMOM, AMRAP, circuit…) garde son minutage
 * (`block_meta`, sur le leader) et la tâche de chaque station
 * (`planned.reps`/`load`) : sans eux l'EMOM arrivait vide, tout le détail
 * perdu dans les notes. Un leader sans minutage reçoit les valeurs par
 * défaut du format, modifiables ensuite. */
export function forgeProposalDayToSession(date, d) {
  const exercises = (d.exercises || []).map((ex) => {
    const format = ex.format || "standard";
    const planned = ex.planned || {};
    const out = {
      name: ex.name,
      format,
      planned: {
        sets: planned.sets != null ? planned.sets : null,
        reps: planned.reps != null ? planned.reps : null,
        load: planned.load != null ? planned.load : null,
        load_per_hand: !!planned.load_per_hand,
      },
      executed: { sets: null, reps: null, load: null },
      rir: null,
      notes: ex.notes || null,
      superset_with_previous: !!ex.superset_with_previous,
    };
    if (!out.superset_with_previous && format !== "standard") {
      out.block_meta = { ...defaultBlockMeta(format), ...(ex.block_meta || {}) };
    }
    return out;
  });
  return {
    name: d.name || defaultSessionName(date, d.type),
    date,
    type: d.type,
    ...(d.primer === true && d.type === "musculation" ? { primer: true } : {}),
    exercises,
    notes: d.notes || "",
    session_rpe: null,
    session_duration_min: null,
    distance_km: d.type === "autre" ? (d.distance_km != null ? d.distance_km : null) : undefined,
  };
}

/** True while a "[Forge]" request has been sent but app-chat.yml hasn't
 * answered it yet (no assistant turn after it) — the request is in flight
 * even though `pending/` has nothing to show yet. Sans ça, revenir dans
 * l'app réactivait « Demander un squelette IA » pendant qu'une demande était
 * encore en cours, invitant un doublon. */
export async function hasUnansweredForgeRequest() {
  const file = await ghGetFile("data/app-chat/conversation.json");
  if (!file) return false;
  let conversation;
  try { conversation = JSON.parse(file.content); } catch (_) { return false; }
  if (!Array.isArray(conversation)) return false;
  const lastAssistantIdx = conversation.map((t) => t.role).lastIndexOf("assistant");
  return conversation.slice(lastAssistantIdx + 1).some((t) => t.role === "user" && (t.text || "").startsWith("[Forge]"));
}

const QUALITY_STATUS = {
  bien_couvert: { label: "Bien couvert", cls: "ok" },
  a_renforcer: { label: "À renforcer", cls: "warn" },
  absent: { label: "Absent", cls: "bad" },
};

/** « Qualités vs objectifs » (docs/adr/0085) : ce que la semaine proposée
 * développe réellement au regard des objectifs du bloc (champ `qualities`). */
function qualitiesHTML(qualities) {
  if (!Array.isArray(qualities) || !qualities.length) return "";
  const rows = qualities.filter((q) => q && q.name).map((q) => {
    const st = QUALITY_STATUS[q.status] || { label: "—", cls: "warn" };
    return `<li class="quality-row quality-${st.cls}">
      <span class="quality-dot" aria-hidden="true"></span>
      <div><strong>${escapeHtmlText(q.name)}</strong> <span class="quality-badge">${st.label}</span>
        ${q.objective ? `<div class="muted small">Objectif : ${escapeHtmlText(q.objective)}</div>` : ""}
        ${q.detail ? `<div class="small">${escapeHtmlText(q.detail)}</div>` : ""}</div></li>`;
  }).join("");
  return `<details class="quality-block"><summary class="small"><strong>Qualités développées vs objectifs du bloc</strong></summary><ul class="quality-list">${rows}</ul></details>`;
}

/** Charge la proposition de squelette en attente et la rend dans `box`.
 * `requestBtn`/`statusEl` : le bouton de demande de la Forge (désactivé tant
 * qu'une demande est en cours). `view` : la vue courante (la retouche en
 * langage naturel arrête son attente en la quittant). `onApplied` : après
 * validation. Retourne true si une proposition est affichée. */
export async function loadPendingSkeletonInto(token, { box, requestBtn = null, statusEl = null, view, onApplied = () => {} }) {
  if (!box) return false;
  const entries = await ghListDir("data/training/app-log/pending");
  if (stale(token)) return false;
  // Exclut « adjust-*.json » : ajustements d'une seule séance, un autre schéma.
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json") && !e.name.startsWith("adjust-")).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) {
    box.innerHTML = "";
    if (requestBtn || statusEl) {
      const waiting = await hasUnansweredForgeRequest();
      if (stale(token)) return false;
      if (requestBtn) requestBtn.disabled = waiting;
      if (statusEl && !statusEl.textContent) statusEl.textContent = waiting ? "En attente de la réponse du coach…" : "";
    }
    return false;
  }

  const target = files[0];
  const file = await ghGetFile(target.path);
  if (stale(token)) return false;
  let week = null;
  try { week = file ? JSON.parse(file.content) : null; } catch (_) { week = null; }
  if (!file || !week) { box.innerHTML = ""; if (requestBtn) requestBtn.disabled = false; return false; }
  if (requestBtn) requestBtn.disabled = true;

  const monday = target.name.slice(0, -5);
  const byDate = new Map((week.days || []).filter((d) => d && d.date).map((d) => [d.date, d]));
  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
  const rows = dates.map((date, i) => (byDate.has(date) ? proposedDayHTML(date, i, byDate.get(date), { editable: true }) : "")).join("");

  box.innerHTML = `
    <section class="card pending-proposal-card">
      <h2>🧠 Semaine proposée par le coach — à valider</h2>
      <p class="muted small">Semaine du ${formatFrDate(monday)}</p>
      ${week.rationale ? `<p class="small">${escapeHtmlText(week.rationale)}</p>` : ""}
      <div class="po-days">${rows || "<p class='muted small'>Aucun jour proposé.</p>"}</div>
      ${qualitiesHTML(week.qualities)}
      <div class="proposal-actions">
        <button type="button" class="primary-button ghost small forge-proposal-reject">❌ Refuser</button>
        <button type="button" class="primary-button small forge-proposal-accept">✅ Valider</button>
      </div>
      <p class="muted small forge-proposal-status"></p>
      ${refineBoxHTML("Ex. : mets du repos jeudi, garde mardi tel quel, allège les jambes")}
    </section>`;
  const statusLine = box.querySelector(".forge-proposal-status");
  wireRefineBox(box, {
    prefix: `[Affiner Forge ${monday}]`,
    pendingPath: target.path,
    pendingSha: file.sha,
    view,
    onUpdated: () => loadPendingSkeletonInto(state.renderToken, { box, requestBtn, statusEl, view, onApplied }).catch(() => {}),
  });

  bindProposedDayEdits(box, (date) => {
    const d = byDate.get(date);
    if (!d) return;
    state.forgePrefillDraft = { date, session: forgeProposalDayToSession(date, d) };
    showView("session", { date });
  });

  box.querySelector(".forge-proposal-accept").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    statusLine.textContent = "Application…";
    try {
      let filled = 0;
      let skipped = 0;
      for (const date of dates) {
        const d = byDate.get(date);
        if (!d) continue;
        const found = await findSessionForDate(date);
        if (!sessionIsBlankSkeleton(found.session)) { skipped++; continue; } // never overwrite real content (incl. one just edited+saved via ✏️) — a quick-typed placeholder is fair game
        await saveSession(found.weekLabel || "app", date, forgeProposalDayToSession(date, d));
        filled++;
      }
      await ghDeleteFile(target.path, `Squelette Forge validé : ${target.name}`, file.sha);
      statusLine.textContent = `Validé ✓ — ${filled} jour(s) appliqué(s)${skipped ? `, ${skipped} déjà renseigné(s) laissé(s) tel quel` : ""}.`;
      box.innerHTML = "";
      if (requestBtn) requestBtn.disabled = false;
      await onApplied();
    } catch (err) {
      statusLine.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });

  box.querySelector(".forge-proposal-reject").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    statusLine.textContent = "Suppression…";
    try {
      await ghDeleteFile(target.path, `Squelette Forge refusé : ${target.name}`, file.sha);
      box.innerHTML = "";
      if (requestBtn) requestBtn.disabled = false;
    } catch (err) {
      statusLine.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });
  return true;
}
