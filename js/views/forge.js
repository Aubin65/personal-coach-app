import { ghGetFile, ghListDir, ghDeleteFile } from "../github-api.js";
import { state, stale, showView } from "../nav.js";
import { todayISO, mondayOfWeek, addDaysISO, formatFrDate, sessionDayStatus, sessionIsBlankSkeleton } from "../date-utils.js";
import { skeletonHTML, escapeAttr, escapeHtmlText } from "../markdown.js";
export { forgeProposalDayToSession };
import { bindBlockReferenceToggle, DAY_NAMES } from "../plan-overview.js";
import { lookupDaySummary, findSessionForDate } from "../training-index.js";
import { SESSION_TYPES } from "../session-types.js";
import { blankSession, defaultSessionName } from "../session/session-model.js";
import { saveSession } from "../session/session-form.js";
import { postUserMessage, dispatchStatusNote } from "./chat.js";
import { loadPendingSkeletonInto, forgeProposalDayToSession } from "../forge-proposal.js";
import { loadClubConfig, saveClubWeekdays } from "../club-training.js";
import { loadPlayedMatchDates, primerKind, addPrimer } from "../primer.js";

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
  setupClubDays().catch(() => {});
  document.getElementById("forge-bloc-button").addEventListener("click", () => showView("forge-bloc"));
  bindBlockReferenceToggle(document.getElementById("forge-block-toggle"), document.getElementById("forge-block-content"));

  document.getElementById("forge-skeleton-button").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("forge-skeleton-status");
    btn.disabled = true;
    statusEl.textContent = "Envoi…";
    try {
      const dispatch = await postUserMessage(forgeSkeletonRequestText(state.forgeMonday));
      statusEl.textContent = dispatch.dispatched
        ? "Envoyé ✓ — le coach prépare une proposition, elle apparaît ici automatiquement (quelques minutes)."
        : `Envoyé ✓ — elle apparaîtra ici automatiquement.${dispatchStatusNote(dispatch)}`;
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

// Libellé court sous chaque icône : quatre icônes seules (🏋️🏉🏃😴) étaient
// ambiguës d'un coup d'œil, surtout "autre" (docs/adr/0070).
const QUICK_TYPE_SHORT_LABELS = { musculation: "Muscu", rugby: "Rugby", autre: "Autre", repos: "Repos" };

function quickTypeButtonsHTML(date, currentType) {
  return Object.entries(SESSION_TYPES)
    .map(([key, t]) => `
      <button type="button" class="forge-quick-type-button${currentType === key ? " active" : ""}"
              data-date="${date}" data-type="${key}" title="${escapeAttr(t.label)}" aria-label="${escapeAttr(t.label)}"><span class="fq-icon">${t.icon}</span><span class="fq-label">${QUICK_TYPE_SHORT_LABELS[key] || escapeHtmlText(t.label)}</span></button>`)
    .join("");
}

/** One day's row markup — shared by the full-week render and
 * `patchForgeDayRow` (a single-row DOM patch after a quick-type tap), so
 * the two can never drift apart. `data-day-index` lets the patch path
 * recover `DAY_NAMES[i]` without recomputing it from the date. */
let forgeMatchDates = new Set();

/** Bouton « ⚡ Primer » : veille ou jour d'un match joué (ADR-0105). */
function primerButtonHTML(date, s) {
  const kind = primerKind(date, forgeMatchDates);
  if (!kind) return "";
  if (s.hasSession && s.isPrimer) return `<div class="forge-primer is-set">⚡ Primer ${kind === "veille" ? "veille de match" : "jour de match"} ✓</div>`;
  return `<button type="button" class="forge-primer" data-date="${date}">⚡ Ajouter un primer ${kind === "veille" ? "(veille de match)" : "(jour de match)"}</button>`;
}

function forgeDayRowHTML(date, dayIndex, s, today) {
  const type = s.hasSession ? s.type || "musculation" : null;
  const label = s.hasSession ? `${SESSION_TYPES[type] ? SESSION_TYPES[type].icon : "🏋️"} ${escapeHtmlText(s.name || "Séance")}` : "Aucune séance planifiée";
  return `
    <div class="forge-day-row" data-date="${date}" data-day-index="${dayIndex}">
      <button type="button" class="forge-day-tile" data-date="${date}">
        <div class="forge-day-name">${DAY_NAMES[dayIndex]} ${date.slice(8, 10)}/${date.slice(5, 7)}</div>
        <div class="forge-day-session">${label}</div>
        <div class="forge-day-status">${sessionDayStatus(date, s.hasSession, s.hasExecuted, today, s.type)}</div>
      </button>
      <div class="forge-quick-types">${quickTypeButtonsHTML(date, type)}</div>
      ${primerButtonHTML(date, s)}
    </div>`;
}

function bindForgeDayRowEvents(scope) {
  scope.querySelectorAll(".forge-day-tile").forEach((btn) => {
    btn.addEventListener("click", () => showView("session", { date: btn.dataset.date }));
  });
  scope.querySelectorAll(".forge-quick-type-button").forEach((btn) => {
    btn.addEventListener("click", () => handleForgeQuickType(btn));
  });
  scope.querySelectorAll("button.forge-primer").forEach((btn) => {
    btn.addEventListener("click", () => handleForgePrimer(btn));
  });
}

async function handleForgePrimer(btn) {
  const row = btn.closest(".forge-day-row");
  const date = btn.dataset.date;
  const dayIndex = +row.dataset.dayIndex;
  btn.disabled = true;
  btn.textContent = "Ajout…";
  try {
    const session = await addPrimer(date);
    if (!session) { btn.disabled = false; btn.textContent = "⚡ Ajouter un primer"; return; }
    row.outerHTML = forgeDayRowHTML(date, dayIndex, { hasSession: true, type: "musculation", name: session.name, hasExecuted: false, isPrimer: true }, todayISO());
    bindForgeDayRowEvents(document.querySelector(`.forge-day-row[data-date="${date}"]`));
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Échec : ${err.message}`;
  }
}

async function renderForgeContent(token) {
  const monday = state.forgeMonday;
  document.getElementById("forge-week-label").textContent = `Semaine du ${formatFrDate(monday)}`;
  document.getElementById("forge-days").innerHTML = skeletonHTML();

  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
  const [summaries, matchDates] = await Promise.all([
    Promise.all(dates.map((d) => lookupDaySummary(d))),
    loadPlayedMatchDates(todayISO()).catch(() => new Set()),
  ]);
  if (stale(token)) return;
  forgeMatchDates = matchDates;

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

const WEEKDAY_SHORT = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** Réglage des jours d'entraînement club par défaut (docs/adr/0087). */
async function setupClubDays() {
  const box = document.getElementById("club-days");
  if (!box) return;
  let days = [...(await loadClubConfig()).weekdays];
  const draw = () => {
    box.innerHTML = WEEKDAY_SHORT.map((label, i) => `<button type="button" class="suggestion-chip${days.includes(i + 1) ? " active" : ""}" data-wd="${i + 1}">${label}</button>`).join("");
    box.querySelectorAll("[data-wd]").forEach((b) => b.addEventListener("click", async () => {
      const wd = Number(b.dataset.wd);
      days = days.includes(wd) ? days.filter((d) => d !== wd) : [...days, wd];
      draw();
      try {
        await saveClubWeekdays(days);
        renderForgeContent(state.renderToken).catch(() => {});
      } catch (err) {
        document.getElementById("club-days-hint").textContent = `Échec : ${err.message}`;
      }
    }));
  };
  draw();
}


async function loadForgePendingSkeleton(token) {
  return loadPendingSkeletonInto(token, {
    box: document.getElementById("forge-skeleton-pending"),
    requestBtn: document.getElementById("forge-skeleton-button"),
    statusEl: document.getElementById("forge-skeleton-status"),
    view: "forge",
    onApplied: () => renderForgeContent(state.renderToken),
  });
}
