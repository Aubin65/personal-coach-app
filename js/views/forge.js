import { ghGetFile, ghListDir, ghDeleteFile } from "../github-api.js";
import { state, stale, showView } from "../nav.js";
import { todayISO, mondayOfWeek, addDaysISO, formatFrDate, sessionDayStatus, sessionIsBlankSkeleton } from "../date-utils.js";
import { skeletonHTML, escapeAttr, escapeHtmlText } from "../markdown.js";
import { bindBlockReferenceToggle, DAY_NAMES } from "../plan-overview.js";
import { lookupDaySummary, findSessionForDate } from "../training-index.js";
import { SESSION_TYPES } from "../session-types.js";
import { blankSession, defaultSessionName } from "../session/session-model.js";
import { saveSession } from "../session/session-form.js";
import { postUserMessage } from "./chat.js";

// ---- Forge : planifier une semaine (n'importe laquelle) séance par séance ----

/** Fixed-format trigger text recognized by prompts/app-chat.md (the
 * "[Forge]" prefix) and routed to prompts/forge-skeleton.md — same async
 * request/poll pattern as "Ajuster ma semaine" (postUserMessage), but
 * asking for a structured week proposal instead of a chat answer. */
function forgeSkeletonRequestText(monday) {
  return `[Forge] Squelette IA pour la semaine du ${monday} : propose la meilleure structure (types de séance et exercices, jour par jour) en te basant sur l'historique d'entraînement, les objectifs de trajectoire et le bloc validé en cours — pas une copie de la semaine précédente.`;
}

export async function renderForge(token) {
  if (!state.forgeMonday) state.forgeMonday = addDaysISO(mondayOfWeek(todayISO()), 7);

  document.getElementById("forge-prev-week").addEventListener("click", () => {
    state.forgeMonday = addDaysISO(state.forgeMonday, -7);
    renderForgeContent(state.renderToken).catch(() => {});
  });
  document.getElementById("forge-next-week").addEventListener("click", () => {
    state.forgeMonday = addDaysISO(state.forgeMonday, 7);
    renderForgeContent(state.renderToken).catch(() => {});
  });
  bindBlockReferenceToggle(document.getElementById("forge-block-toggle"), document.getElementById("forge-block-content"));

  document.getElementById("forge-skeleton-button").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("forge-skeleton-status");
    btn.disabled = true;
    statusEl.textContent = "Envoi…";
    try {
      await postUserMessage(forgeSkeletonRequestText(state.forgeMonday));
      statusEl.textContent = "Envoyé ✓ — le coach prépare une proposition, elle apparaît ici automatiquement (quelques minutes).";
      startForgePolling();
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });

  startForgePolling();
  await Promise.all([renderForgeContent(token), loadForgePendingSkeleton(token)]);
}

/** Polls for a pending Forge skeleton proposal while the Forge tab is open,
 * so it appears on its own (no manual ⟳) once the coach has finished —
 * same pattern as startChatPolling. Stops itself once a proposal is
 * showing (nothing left to wait for) or the tab is left. */
let forgePollTimer = null;
function startForgePolling() {
  clearInterval(forgePollTimer);
  forgePollTimer = setInterval(() => {
    if (state.view !== "forge") { clearInterval(forgePollTimer); return; }
    const box = document.getElementById("forge-skeleton-pending");
    if (box && box.innerHTML.trim()) { clearInterval(forgePollTimer); return; } // already showing — nothing left to poll for
    loadForgePendingSkeleton(state.renderToken).catch(() => {});
  }, 10000);
}

function quickTypeButtonsHTML(date, currentType) {
  return Object.entries(SESSION_TYPES)
    .map(([key, t]) => `
      <button type="button" class="forge-quick-type-button${currentType === key ? " active" : ""}"
              data-date="${date}" data-type="${key}" title="${escapeAttr(t.label)}" aria-label="${escapeAttr(t.label)}">${t.icon}</button>`)
    .join("");
}

/** One day's row markup — shared by the full-week render and
 * `patchForgeDayRow` (a single-row DOM patch after a quick-type tap), so
 * the two can never drift apart. `data-day-index` lets the patch path
 * recover `DAY_NAMES[i]` without recomputing it from the date. */
function forgeDayRowHTML(date, dayIndex, s, today) {
  const type = s.hasSession ? s.type || "musculation" : null;
  const label = s.hasSession ? `${SESSION_TYPES[type] ? SESSION_TYPES[type].icon : "🏋️"} ${escapeHtmlText(s.name || "Séance")}` : "Aucune séance planifiée";
  return `
    <div class="forge-day-row" data-date="${date}" data-day-index="${dayIndex}">
      <button type="button" class="forge-day-tile" data-date="${date}">
        <div class="forge-day-name">${DAY_NAMES[dayIndex]} ${date.slice(8, 10)}/${date.slice(5, 7)}</div>
        <div class="forge-day-session">${label}</div>
        <div class="forge-day-status">${sessionDayStatus(date, s.hasSession, s.hasExecuted, today)}</div>
      </button>
      <div class="forge-quick-types">${quickTypeButtonsHTML(date, type)}</div>
    </div>`;
}

function bindForgeDayRowEvents(scope) {
  scope.querySelectorAll(".forge-day-tile").forEach((btn) => {
    btn.addEventListener("click", () => showView("session", { date: btn.dataset.date }));
  });
  scope.querySelectorAll(".forge-quick-type-button").forEach((btn) => {
    btn.addEventListener("click", () => handleForgeQuickType(btn));
  });
}

async function renderForgeContent(token) {
  const monday = state.forgeMonday;
  document.getElementById("forge-week-label").textContent = `Semaine du ${formatFrDate(monday)}`;
  document.getElementById("forge-days").innerHTML = skeletonHTML();

  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
  const summaries = await Promise.all(dates.map((d) => lookupDaySummary(d)));
  if (stale(token)) return;

  const today = todayISO();
  const daysEl = document.getElementById("forge-days");
  daysEl.innerHTML = dates.map((date, i) => forgeDayRowHTML(date, i, summaries[i], today)).join("");
  bindForgeDayRowEvents(daysEl);
}

/** A quick-type tap only ever changes the one day tapped — patching just
 * that row (instead of `renderForgeContent`'s full skeleton-flash +
 * 7-day refetch) is what makes the picker feel immediate rather than
 * "pas très fluide". `quickSetDayType` already knows exactly what it
 * wrote, so no re-fetch is needed to know what to show. */
async function handleForgeQuickType(btn) {
  const row = btn.closest(".forge-day-row");
  const date = btn.dataset.date;
  const dayIndex = +row.dataset.dayIndex;
  row.querySelectorAll(".forge-quick-type-button").forEach((b) => (b.disabled = true));
  let result;
  try {
    result = await quickSetDayType(date, btn.dataset.type);
  } finally {
    row.querySelectorAll(".forge-quick-type-button").forEach((b) => (b.disabled = false));
  }
  if (!result) return; // user cancelled the overwrite confirm, or already this type
  const today = todayISO();
  row.outerHTML = forgeDayRowHTML(date, dayIndex, result, today);
  // `row` is now detached (outerHTML replaced it) — bind only the fresh
  // element, never the whole container, or every untouched row's buttons
  // would pick up one more duplicate listener on every single tap.
  bindForgeDayRowEvents(document.querySelector(`.forge-day-row[data-date="${date}"]`));
}

/** true if a session has enough real content that overwriting it deserves
 * a confirmation first — used by the Forge quick-type buttons and the
 * skeleton proposal, both of which can otherwise silently replace a
 * session with a blank one of a different type. */
function sessionHasContent(session) {
  if (!session) return false;
  if (session.notes) return true;
  if (session.session_rpe != null || session.session_duration_min != null) return true;
  return (session.exercises || []).some((ex) =>
    (ex.executed && (ex.executed.sets || ex.executed.reps || ex.executed.load)) ||
    (ex.planned && (ex.planned.sets || ex.planned.reps || ex.planned.load))
  );
}

/** Sets just a day's type from Forge — musculation/rugby/autre/repos —
 * without opening the full session view, so a whole week's structure can
 * be sketched in a few taps ("j'ai besoin de pouvoir simplement ajouter le
 * type de séance dans la semaine"). Rugby on a Saturday/Sunday is always
 * a match, never club training.
 *
 * Returns a `lookupDaySummary`-shaped `{hasSession, type, name,
 * hasExecuted}` so the caller can patch the Forge row locally without a
 * re-fetch — `null` when nothing changed (already this type, or the
 * overwrite confirm was declined). */
async function quickSetDayType(date, type) {
  const found = await findSessionForDate(date);
  const existing = found.session;
  if (existing && (existing.type || "musculation") === type) return null; // already this type
  if (sessionHasContent(existing)) {
    const ok = window.confirm(`Remplacer la séance déjà renseignée du ${formatFrDate(date)} (${existing.name}) ?`);
    if (!ok) return null;
  }
  const session = blankSession(date, type);
  await saveSession(found.weekLabel || "app", date, session);
  return { hasSession: true, type: session.type, name: session.name, hasExecuted: false };
}

/** A "🧠 Demander un squelette IA" request is answered asynchronously by
 * prompts/forge-skeleton.md (routed from app-chat.md, see
 * forgeSkeletonRequestText), which writes a structured proposal to
 * data/training/app-log/pending/<lundi>.json rather than applying it
 * directly — same validation-gate principle as the Semaine planning
 * proposals (loadPendingProposal/docs/adr/0019), but JSON/structured since
 * this feeds real session data, not prose. Shown regardless of which week
 * Forge currently browses (it carries its own Monday), like the Planning
 * tab's proposal card. At most one pending file expected at a time — the
 * request button disables itself while one exists. */
/** Maps one proposed day from a pending Forge skeleton (see
 * loadForgePendingSkeleton) into the app's actual session schema — shared
 * by the bulk "Valider" (writes straight to GitHub) and the per-day "✏️"
 * (opens it as an editable draft in the session view first, see
 * renderSession's forgePrefillDraft handling). */
export function forgeProposalDayToSession(date, d) {
  return {
    name: d.name || defaultSessionName(date, d.type),
    date,
    type: d.type,
    exercises: (d.exercises || []).map((ex) => ({
      name: ex.name,
      format: ex.format || "standard",
      planned: { sets: ex.planned && ex.planned.sets != null ? ex.planned.sets : null, reps: ex.planned && ex.planned.reps != null ? ex.planned.reps : null, load: ex.planned && ex.planned.load != null ? ex.planned.load : null },
      executed: { sets: null, reps: null, load: null },
      rir: null,
      notes: ex.notes || null,
      superset_with_previous: !!ex.superset_with_previous,
    })),
    notes: d.notes || "",
    session_rpe: null,
    session_duration_min: null,
    distance_km: d.type === "autre" ? (d.distance_km != null ? d.distance_km : null) : undefined,
  };
}

/** True while a "[Forge]" request has been sent but app-chat.yml hasn't
 * answered it yet (no assistant turn after it) — the request is in
 * flight even though `data/training/app-log/pending/` has nothing to
 * show yet (the coach can take a few minutes). Without this, leaving the
 * app and coming back (a fresh page load, no in-memory `disabled` state
 * left) re-enabled the "Demander un squelette IA" button while a request
 * was genuinely still being worked on, inviting a duplicate request. */
async function hasUnansweredForgeRequest() {
  const file = await ghGetFile("data/app-chat/conversation.json");
  if (!file) return false;
  let conversation;
  try { conversation = JSON.parse(file.content); } catch (_) { return false; }
  if (!Array.isArray(conversation)) return false;
  const lastAssistantIdx = conversation.map((t) => t.role).lastIndexOf("assistant");
  return conversation.slice(lastAssistantIdx + 1).some((t) => t.role === "user" && (t.text || "").startsWith("[Forge]"));
}

async function loadForgePendingSkeleton(token) {
  const box = document.getElementById("forge-skeleton-pending");
  const requestBtn = document.getElementById("forge-skeleton-button");
  const statusEl = document.getElementById("forge-skeleton-status");
  const entries = await ghListDir("data/training/app-log/pending");
  if (stale(token)) return;
  // Excludes "adjust-*.json" — single-session adjustment proposals living
  // in the same directory (see loadPendingSessionAdjustments), a different
  // schema entirely ({date, rationale, session}, not {monday, days}).
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json") && !e.name.startsWith("adjust-")).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) {
    box.innerHTML = "";
    const waiting = await hasUnansweredForgeRequest();
    if (stale(token)) return;
    if (requestBtn) requestBtn.disabled = waiting;
    if (statusEl && !statusEl.textContent) statusEl.textContent = waiting ? "En attente de la réponse du coach…" : "";
    return;
  }

  const target = files[0];
  const file = await ghGetFile(target.path);
  if (stale(token)) return;
  let week = null;
  try { week = file ? JSON.parse(file.content) : null; } catch (_) { week = null; }
  if (!file || !week) { box.innerHTML = ""; if (requestBtn) requestBtn.disabled = false; return; }
  if (requestBtn) requestBtn.disabled = true;

  const monday = target.name.slice(0, -5);
  const byDate = new Map((week.days || []).filter((d) => d && d.date).map((d) => [d.date, d]));
  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
  const rows = dates
    .map((date, i) => {
      const d = byDate.get(date);
      if (!d) return "";
      const icon = SESSION_TYPES[d.type] ? SESSION_TYPES[d.type].icon : "🏋️";
      const exCount = (d.exercises || []).length;
      const detail = d.type === "musculation" && exCount ? ` · ${exCount} exercice(s)` : "";
      return `<li>
        <span>${icon} <strong>${DAY_NAMES[i]}</strong> ${date.slice(8, 10)}/${date.slice(5, 7)} — ${escapeHtmlText(d.name || "")}${detail}</span>
        <button type="button" class="icon-button small forge-proposal-edit" data-date="${date}" title="Modifier avant validation" aria-label="Modifier avant validation">✏️</button>
      </li>`;
    })
    .join("");

  box.innerHTML = `
    <section class="card pending-proposal-card">
      <h2>🧠 Squelette proposé par le coach — à valider</h2>
      <p class="muted small">Semaine du ${formatFrDate(monday)}</p>
      ${week.rationale ? `<p class="small">${escapeHtmlText(week.rationale)}</p>` : ""}
      <ul class="forge-pending-list">${rows || "<li class='muted small'>Aucun jour proposé.</li>"}</ul>
      <div class="proposal-actions">
        <button type="button" id="forge-proposal-reject" class="primary-button ghost small">❌ Refuser</button>
        <button type="button" id="forge-proposal-accept" class="primary-button small">✅ Valider</button>
      </div>
      <p id="forge-proposal-status" class="muted small"></p>
    </section>`;

  box.querySelectorAll(".forge-proposal-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = btn.dataset.date;
      const d = byDate.get(date);
      if (!d) return;
      state.forgePrefillDraft = { date, session: forgeProposalDayToSession(date, d) };
      showView("session", { date });
    });
  });

  document.getElementById("forge-proposal-accept").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("forge-proposal-status");
    btn.disabled = true;
    statusEl.textContent = "Application…";
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
      statusEl.textContent = `Validé ✓ — ${filled} jour(s) appliqué(s)${skipped ? `, ${skipped} déjà renseigné(s) laissé(s) tel quel` : ""}.`;
      box.innerHTML = "";
      if (requestBtn) requestBtn.disabled = false;
      await renderForgeContent(state.renderToken);
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });

  document.getElementById("forge-proposal-reject").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("forge-proposal-status");
    btn.disabled = true;
    statusEl.textContent = "Suppression…";
    try {
      await ghDeleteFile(target.path, `Squelette Forge refusé : ${target.name}`, file.sha);
      box.innerHTML = "";
      if (requestBtn) requestBtn.disabled = false;
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });
}
