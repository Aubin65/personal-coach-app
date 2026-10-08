import { ghListDir, ghGetFile, ghPutFile, ghDeleteFile } from "../github-api.js";
import { state, stale, showView } from "../nav.js";
import { todayISO, mondayOfWeek, addDaysISO, formatFrDate, sessionDayStatus } from "../date-utils.js";
import { skeletonHTML, escapeHtmlText, escapeAttr, renderMarkdown, addTableDataLabels } from "../markdown.js";
import { renderWeekOverview, parseWeekOverview, splitWeekPlanByDay, buildMergedWeekPlan, DAY_NAMES } from "../plan-overview.js";
import { lookupDaySummary, findSessionForDate } from "../training-index.js";
import { renderBlockTab } from "./block-view.js";
import { SESSION_TYPES } from "../session-types.js";
import { saveSession } from "../session/session-form.js";
import { refineBoxHTML, wireRefineBox } from "../proposal-refine.js";
import { loadPendingSkeletonInto } from "../forge-proposal.js";
import { exercisesOverviewHTML } from "../proposal-overview.js";

/** Numéro de semaine ISO 8601 d'une date (`YYYY-MM-DD`). */
function isoWeekNumber(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
/** « 5 – 11 octobre » ou « 28 septembre – 4 octobre ». */
function weekRangeFr(monday) {
  const sunday = addDaysISO(monday, 6);
  const [, m1, d1] = monday.split("-").map(Number);
  const [, m2, d2] = sunday.split("-").map(Number);
  return m1 === m2 ? `${d1} – ${d2} ${MONTHS_FR[m2 - 1]}` : `${d1} ${MONTHS_FR[m1 - 1]} – ${d2} ${MONTHS_FR[m2 - 1]}`;
}

async function listPlans() {
  const entries = (await ghListDir("data/plans")).filter((e) => e.type === "file" && e.name.endsWith(".md"));
  return entries.map((e) => ({ date: e.name.slice(0, -3), path: e.path })).sort((a, b) => b.date.localeCompare(a.date));
}

/** Planning sub-tab content for `state.planningMonday` — day-strip,
 * "Objectifs clés", day-overview panel and the Séances table, all scoped
 * to one specific week. Re-run standalone by the prev/next week buttons
 * (see renderWeek), not just on first entry into Semaine — a plan file is
 * fetched by its exact filename (`data/plans/<lundi>.md`) rather than
 * "the latest plan on or before today" (that made sense only when this
 * tab was locked to the current week) so navigating to a week without a
 * plan reads as "no plan for this week", not silently falling back to an
 * older one. */
/** Markdown minimal `## Jour d/m — titre` construit depuis les séances
 * enregistrées de la semaine ; `null` si aucune (→ « pas de planning »). */
async function markdownFromSessions(monday) {
  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
  const summaries = await Promise.all(dates.map((d) => lookupDaySummary(d)));
  if (!summaries.some((s) => s.hasSession)) return null;
  return dates
    .map((d, i) => `## ${DAY_NAMES[i]} ${parseInt(d.slice(8, 10), 10)}/${parseInt(d.slice(5, 7), 10)} — ${summaries[i].hasSession ? summaries[i].name || "Séance" : "Repos"}`)
    .join("\n");
}

export async function renderWeekPlanning(token) {
  const monday = state.planningMonday;
  document.getElementById("planning-week-label").textContent = `Semaine ${isoWeekNumber(monday)}`;
  document.getElementById("planning-week-sub").textContent = weekRangeFr(monday);
  document.getElementById("week-day-strip").innerHTML = skeletonHTML();
  document.getElementById("week-highlights").innerHTML = "";
  document.getElementById("day-overview-panel").innerHTML = "";

  const planFile = await ghGetFile(`data/plans/${monday}.md`);
  if (stale(token)) return;

  // Sans prose de planning (cas typique : semaine construite via Forge), le
  // bandeau est dérivé des séances réelles de la semaine (ADR-0104).
  const planMarkdown = planFile ? planFile.content : await markdownFromSessions(monday);
  if (stale(token)) return;

  let planDays = [];
  if (planMarkdown) {
    renderWeekOverview(
      document.getElementById("week-day-strip"),
      document.getElementById("week-highlights"),
      planMarkdown,
      todayISO(),
      monday,
      token
    ).catch(() => {});
    planDays = parseWeekOverview(planMarkdown).days;
  } else {
    document.getElementById("week-day-strip").innerHTML = "<p class='muted'>Pas de planning disponible pour cette semaine.</p>";
  }
  // Le tableau prévu/réalisé doublait la liste des jours (qui montre
  // désormais ✓ Fait / À loguer, ADR-0092) : il ne reste qu'en secours,
  // déplié, pour une semaine sans planning.
  const sessionsDetails = document.querySelector(".week-sessions-details");
  if (sessionsDetails) {
    sessionsDetails.hidden = !!planMarkdown;
    sessionsDetails.open = !planMarkdown;
  }
  renderWeekSessionsTable(token, monday, planDays).catch(() => {});
}

// ---- Semaine : Planning (+ proposition en attente), Bloc, Séances, Historique ----
export async function renderWeek(token) {
  const tabs = document.querySelectorAll("#week-tabs .segment");
  const planningPanel = document.getElementById("week-planning-panel");
  const blockPanel = document.getElementById("week-block-content");
  const historyPanel = document.getElementById("week-history-panel");

  // « Séances » n'est plus un onglet (docs/adr/0077) : son tableau prévu /
  // réalisé vit replié dans Semaine. Un ancien état y retombe.
  if (!["planning", "block", "history"].includes(state.weekSubTab)) state.weekSubTab = "planning";
  const applyTab = () => {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.weekTab === state.weekSubTab));
    planningPanel.hidden = state.weekSubTab !== "planning";
    blockPanel.hidden = state.weekSubTab !== "block";
    historyPanel.hidden = state.weekSubTab !== "history";
    if (state.weekSubTab === "history") loadPlanHistory(token);
    if (state.weekSubTab === "block" && !blockPanel.dataset.loaded) {
      blockPanel.dataset.loaded = "1";
      renderBlockTab(blockPanel, token).catch((err) => { blockPanel.innerHTML = `<p class="error-text">${err.message}</p>`; });
    }
  };
  tabs.forEach((t) => t.addEventListener("click", () => { state.weekSubTab = t.dataset.weekTab; applyTab(); }));
  applyTab();

  document.getElementById("adjust-week-button").addEventListener("click", () => showView("adjust-week"));
  document.getElementById("week-edit-button").addEventListener("click", () => {
    state.forgeMonday = state.planningMonday;
    showView("forge");
  });

  if (!state.planningMonday) state.planningMonday = mondayOfWeek(todayISO());
  document.getElementById("planning-prev-week").addEventListener("click", () => {
    state.planningMonday = addDaysISO(state.planningMonday, -7);
    renderWeekPlanning(state.renderToken).catch(() => {});
  });
  document.getElementById("planning-next-week").addEventListener("click", () => {
    state.planningMonday = addDaysISO(state.planningMonday, 7);
    renderWeekPlanning(state.renderToken).catch(() => {});
  });

  if (!state.historyMonday) state.historyMonday = addDaysISO(mondayOfWeek(todayISO()), -7); // last week by default
  document.getElementById("history-prev-week").addEventListener("click", () => {
    state.historyMonday = addDaysISO(state.historyMonday, -7);
    renderSessionHistoryWeek(state.renderToken).catch(() => {});
  });
  document.getElementById("history-next-week").addEventListener("click", () => {
    state.historyMonday = addDaysISO(state.historyMonday, 7);
    renderSessionHistoryWeek(state.renderToken).catch(() => {});
  });
  document.getElementById("history-jump-date").addEventListener("change", (e) => {
    if (!e.target.value) return;
    state.historyMonday = mondayOfWeek(e.target.value);
    renderSessionHistoryWeek(state.renderToken).catch(() => {});
  });

  document.getElementById("pending-proposal").innerHTML = "";
  watchPendingBadge();
  loadPendingProposal(token).catch(() => {});
  loadPendingSessionAdjustments(token).catch(() => {});
  loadWeekPendingSkeleton(token).catch(() => {});
  renderWeekPlanning(token).catch(() => {});

}

/** "Séances" tab — a compact forecast/actual table for the week currently
 * shown in Planning (one row per day: what's planned, what's actually
 * logged), replacing what used to be a raw dump of the block's own
 * week-by-week draft — the block's draft can drift from the real plan/log
 * once either is adjusted, and duplicated the day-strip above it. */
async function renderWeekSessionsTable(token, mondayISO, planDays) {
  const el = document.getElementById("week-sessions-content");
  el.innerHTML = skeletonHTML();
  if (!mondayISO) { el.innerHTML = "<p class='muted'>Pas de planning disponible pour cette semaine.</p>"; return; }

  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(mondayISO, i));
  const summaries = await Promise.all(dates.map((d) => lookupDaySummary(d)));
  if (stale(token)) return;

  const today = todayISO();
  const rows = dates
    .map((date, i) => {
      const planDay = planDays.find((d) => DAY_NAMES.indexOf(d.day) === i);
      const plannedLabel = planDay ? planDay.title : "—";
      const s = summaries[i];
      // Repos : posé comme séance de type « repos », ou prévu « Repos » au plan sans rien de logué.
      const restDay = s.type === "repos" || (!s.hasSession && /^\s*repos/i.test(plannedLabel));
      const status = sessionDayStatus(date, s.hasSession, s.hasExecuted, today, restDay ? "repos" : s.type);
      return `
        <tr class="week-table-row" data-date="${date}">
          <td>${DAY_NAMES[i].slice(0, 3)} ${date.slice(8, 10)}/${date.slice(5, 7)}</td>
          <td>${escapeHtmlText(plannedLabel)}</td>
          <td>${status}</td>
        </tr>`;
    })
    .join("");

  // Same week-nav pattern/state as Planning's arrows (state.planningMonday)
  // — direct request: this table was stuck on whatever week Planning
  // happened to be on, no way to move it from here.
  el.innerHTML = `
    <div class="forge-week-nav">
      <button type="button" id="sessions-prev-week" class="icon-button small" aria-label="Semaine précédente"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
      <span class="forge-week-label">Semaine du ${formatFrDate(mondayISO)}</span>
      <button type="button" id="sessions-next-week" class="icon-button small" aria-label="Semaine suivante"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <table class="week-sessions-table">
      <thead><tr><th>Jour</th><th>Prévu</th><th>Statut</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  el.querySelectorAll(".week-table-row").forEach((tr) => {
    tr.addEventListener("click", () => showView("session", { date: tr.dataset.date }));
  });
  document.getElementById("sessions-prev-week").addEventListener("click", () => {
    state.planningMonday = addDaysISO(state.planningMonday, -7);
    renderWeekPlanning(state.renderToken).catch(() => {});
  });
  document.getElementById("sessions-next-week").addEventListener("click", () => {
    state.planningMonday = addDaysISO(state.planningMonday, 7);
    renderWeekPlanning(state.renderToken).catch(() => {});
  });
}

/** A plan adjustment requested from the app (chat or "Ajuster ma semaine")
 * is never applied directly — it's written to data/plans/pending/<lundi>.md
 * and shown here for an explicit Valider/Refuser, per
 * prompts/weekly-plan.md's app-triggered branch and docs/adr/0018/0019.
 * Only the oldest pending file is shown at a time (there should never
 * realistically be more than one). Coach-initiated alerts are a separate
 * mechanism (see loadActiveAlerts in app/js/views/today.js, docs/adr/0045,
 * docs/adr/0053) — this proposal flow is
 * user-requested only.
 *
 * Validation is per day (docs/adr/0057 — "j'ai besoin de pouvoir valider
 * séance par séance"), not just the whole week's prose as one block: each
 * day whose proposed content actually differs from the current validated
 * plan gets its own checkbox (checked by default) plus the current
 * version to compare against; days the proposal leaves unchanged need no
 * decision and are reapplied as-is. "Valider la sélection" merges
 * accepted days' new content with rejected days' current content (see
 * buildMergedWeekPlan); "Tout refuser" still discards the whole pending
 * file at once, unchanged from before. */
/** Semaine proposée par le coach (squelette Forge) — visible ici, sans
 * passer par la Forge (ADR-0103), avec le détail des séances. */
async function loadWeekPendingSkeleton(token) {
  const box = document.getElementById("week-pending-forge-skeleton");
  const shown = await loadPendingSkeletonInto(token, {
    box,
    view: "week",
    onApplied: () => renderWeekPlanning(state.renderToken),
  });
  return shown;
}

/** Pastille sur l'onglet Planning dès qu'une proposition attend (plan,
 * squelette de semaine ou ajustement de séance) — suivie sur le contenu des
 * trois emplacements, quel que soit l'ordre dans lequel ils se chargent. */
const PENDING_BOX_IDS = ["pending-proposal", "week-pending-forge-skeleton", "week-pending-session-adjustments"];
function watchPendingBadge() {
  const refresh = () => {
    const tab = document.querySelector('#week-tabs .segment[data-week-tab="planning"]');
    if (!tab) return;
    tab.classList.toggle("has-pending", PENDING_BOX_IDS.some((id) => { const el = document.getElementById(id); return !!el && el.innerHTML.trim() !== ""; }));
  };
  PENDING_BOX_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) new MutationObserver(refresh).observe(el, { childList: true });
  });
  refresh();
}

async function loadPendingProposal(token) {
  const box = document.getElementById("pending-proposal");
  // Surfaced as a badge on the Planning tab too — a pending proposal must
  // never go unnoticed just because Historique/Bloc happened to be the
  // sub-tab left active from a previous visit to Semaine.
  const entries = await ghListDir("data/plans/pending");
  if (stale(token)) return;
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) { box.innerHTML = ""; return; }

  const target = files[0];
  const file = await ghGetFile(target.path);
  if (stale(token)) return;
  if (!file) { box.innerHTML = ""; return; }

  const monday = target.name.slice(0, -3);
  const currentPath = `data/plans/${target.name}`;
  const currentFile = await ghGetFile(currentPath);
  if (stale(token)) return;

  const pendingSplit = splitWeekPlanByDay(file.content);
  const currentSplit = currentFile ? splitWeekPlanByDay(currentFile.content) : null;

  const dayInfo = pendingSplit.days.map((pd) => {
    const cd = currentSplit ? currentSplit.days.find((d) => d.day === pd.day) : null;
    const changed = !cd || cd.body.trim() !== pd.body.trim();
    return { pd, cd, changed };
  });
  const changedDays = dayInfo.filter((d) => d.changed);
  const unchangedDayNames = dayInfo.filter((d) => !d.changed).map((d) => d.pd.day);

  // <details> collapsed by default (retour direct : les cartes ne
  // devaient pas s'afficher toutes ouvertes d'un coup) — la case à cocher
  // reste dans le <summary> pour rester décidable sans ouvrir la carte ;
  // son clic stoppe la propagation (voir plus bas) pour ne pas aussi
  // replier/déplier la carte à chaque coche.
  const dayCardsHTML = changedDays
    .map(({ pd, cd }) => `
      <details class="plan-day-proposal" data-day="${escapeAttr(pd.day)}">
        <summary class="plan-day-proposal-header">
          <input type="checkbox" class="plan-day-accept" checked>
          <span class="plan-day-diff"><span class="plan-day-when">${escapeHtmlText(pd.day)} ${escapeHtmlText(pd.date)}</span>${cd && cd.title && cd.title !== pd.title ? `<s>${escapeHtmlText(cd.title)}</s>` : ""}<b>${escapeHtmlText(pd.title || "")}</b></span>
          <span class="plan-day-tag">${cd ? "modifié" : "nouveau"}</span>
        </summary>
        <div class="markdown-body small">${renderMarkdown(pd.body)}</div>
        ${cd ? `
        <details class="block-overview-details">
          <summary>Voir la version actuelle</summary>
          <div class="markdown-body small">${renderMarkdown(cd.body)}</div>
        </details>` : ""}
      </details>`)
    .join("");

  box.innerHTML = `
    <section class="card pending-proposal-card">
      <p class="proposal-kicker"><span class="pill pill-gold">Proposition du coach</span><span class="muted small">Semaine du ${monday}</span></p>
      <p class="muted small">Avant → après, jour par jour. Décoche ce que tu ne veux pas garder.</p>
      ${pendingSplit.intro.trim() ? `<div class="markdown-body">${renderMarkdown(pendingSplit.intro)}</div>` : ""}
      ${dayCardsHTML || "<p class='muted small'>Aucun jour modifié par rapport au planning actuel.</p>"}
      ${unchangedDayNames.length ? `<p class="muted small">Jours inchangés, repris tels quels : ${unchangedDayNames.join(", ")}.</p>` : ""}
      <div class="proposal-actions">
        <button type="button" id="proposal-reject" class="primary-button ghost small">❌ Tout refuser</button>
        <button type="button" id="proposal-accept" class="primary-button small">✅ Valider la sélection</button>
      </div>
      <p id="proposal-status" class="muted small"></p>
      ${refineBoxHTML("Ex. : décale la séance de jeudi à vendredi, plus de tirage")}
    </section>`;
  wireRefineBox(box, {
    prefix: `[Affiner Semaine ${monday}]`,
    pendingPath: target.path,
    pendingSha: file.sha,
    view: "week",
    onUpdated: () => loadPendingProposal(state.renderToken).catch(() => {}),
  });

  // La case vit dans le <summary> : sans ça, la cocher rouvre/referme
  // aussi la carte (le clic bulle jusqu'au <summary>).
  box.querySelectorAll(".plan-day-accept").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
  });
  // Tableaux Fonction/Ordre/Exercice/Série×Reps/Charge/RIR-Note : 6
  // colonnes ne tiennent pas côte à côte sur un écran de téléphone sans
  // devenir illisibles — étiquette chaque cellule pour l'affichage en
  // carte empilée (voir .plan-day-proposal .markdown-body table).
  addTableDataLabels(box);

  document.getElementById("proposal-accept").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("proposal-status");
    btn.disabled = true;
    statusEl.textContent = "Application…";
    try {
      const acceptedDayNames = new Set(unchangedDayNames);
      box.querySelectorAll(".plan-day-proposal").forEach((el) => {
        if (el.querySelector(".plan-day-accept").checked) acceptedDayNames.add(el.dataset.day);
      });
      const merged = buildMergedWeekPlan(pendingSplit, currentSplit, acceptedDayNames);
      const targetCurrent = await ghGetFile(currentPath);
      await ghPutFile(currentPath, merged, `Planning semaine du ${monday} (validé depuis l'app, séance par séance)`, targetCurrent ? targetCurrent.sha : null);
      await ghDeleteFile(target.path, `Proposition validée : ${target.name}`, file.sha);
      statusEl.textContent = "Validé ✓";
      renderWeek(state.renderToken);
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });

  document.getElementById("proposal-reject").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("proposal-status");
    btn.disabled = true;
    statusEl.textContent = "Suppression…";
    try {
      await ghDeleteFile(target.path, `Proposition refusée : ${target.name}`, file.sha);
      box.innerHTML = "";
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });
}

/** A single-session adjustment proposal (see
 * prompts/session-adjustment.md, docs/adr/0045) — narrower than the
 * whole-week "Ajuster ma semaine" (loadPendingProposal): written to
 * data/training/app-log/pending/adjust-<date>.json, holding the session's
 * full new content, and validating it touches only that one date's file
 * (via saveSession) — nothing else in the week (direct request: "la modif
 * ne devrait impacter que la séance"). The "adjust-" filename prefix keeps
 * these apart from the whole-week Forge skeleton proposals living in the
 * same directory (loadForgePendingSkeleton, named `<lundi>.json`). */
async function loadPendingSessionAdjustments(token) {
  const box = document.getElementById("week-pending-session-adjustments");
  const entries = await ghListDir("data/training/app-log/pending");
  if (stale(token)) return;
  const files = entries
    .filter((e) => e.type === "file" && e.name.startsWith("adjust-") && e.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) { box.innerHTML = ""; return; }

  const target = files[0];
  const file = await ghGetFile(target.path);
  if (stale(token)) return;
  let proposal = null;
  try { proposal = file ? JSON.parse(file.content) : null; } catch (_) { proposal = null; }
  if (!file || !proposal || !proposal.session) { box.innerHTML = ""; return; }

  const date = proposal.date;
  const session = proposal.session;
  const overview = exercisesOverviewHTML(session.exercises || []);

  box.innerHTML = `
    <section class="card pending-proposal-card">
      <h2>📝 Ajustement de séance proposé — à valider</h2>
      <p class="muted small">${formatFrDate(date)} — ${escapeHtmlText(session.name || "")}</p>
      ${proposal.rationale ? `<p class="small">${escapeHtmlText(proposal.rationale)}</p>` : ""}
      ${overview || "<p class='muted small'>Aucun exercice.</p>"}
      <div class="proposal-actions">
        <button type="button" id="session-adjust-reject" class="primary-button ghost small">❌ Refuser</button>
        <button type="button" id="session-adjust-accept" class="primary-button small">✅ Valider</button>
      </div>
      <p id="session-adjust-status" class="muted small"></p>
      ${refineBoxHTML("Ex. : garde le leg press mais retire le hip thrust, 2 séries seulement")}
    </section>`;
  wireRefineBox(box, {
    prefix: `[Affiner Séance ${date}]`,
    pendingPath: target.path,
    pendingSha: file.sha,
    view: "week",
    onUpdated: () => loadPendingSessionAdjustments(state.renderToken).catch(() => {}),
  });

  document.getElementById("session-adjust-accept").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("session-adjust-status");
    btn.disabled = true;
    statusEl.textContent = "Application…";
    try {
      const found = await findSessionForDate(date);
      await saveSession(found.weekLabel || "app", date, session);
      await ghDeleteFile(target.path, `Ajustement de séance validé : ${target.name}`, file.sha);
      statusEl.textContent = "Validé ✓";
      box.innerHTML = "";
      renderWeekPlanning(state.renderToken).catch(() => {});
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });

  document.getElementById("session-adjust-reject").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("session-adjust-status");
    btn.disabled = true;
    statusEl.textContent = "Suppression…";
    try {
      await ghDeleteFile(target.path, `Ajustement de séance refusé : ${target.name}`, file.sha);
      box.innerHTML = "";
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });
}

async function loadPlanHistory(token) {
  await Promise.all([loadPlanHistoryList(token), renderSessionHistoryWeek(token)]);
}

async function loadPlanHistoryList(token) {
  const container = document.getElementById("history-plans-list");
  if (container.dataset.loaded) return;
  container.innerHTML = skeletonHTML();
  const plans = await listPlans();
  if (stale(token)) return;
  if (plans.length === 0) { container.innerHTML = "<p class='muted small'>Pas encore de planning archivé.</p>"; return; }
  container.innerHTML = plans
    .map((p, i) => `
      <button class="history-item" data-idx="${i}">
        <div class="history-date">Semaine ${isoWeekNumber(p.date)} · ${weekRangeFr(p.date)}</div>
        <div class="history-sub">${i === 0 ? "Planning en cours · " : ""}toucher pour relire</div>
      </button>
      <div class="markdown-body history-detail" data-idx="${i}" hidden></div>`)
    .join("");
  container.dataset.loaded = "1";
  container.querySelectorAll(".history-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = btn.dataset.idx;
      const detail = container.querySelector(`.history-detail[data-idx="${idx}"]`);
      if (!detail.hidden) { detail.hidden = true; return; }
      if (!detail.dataset.loaded) {
        detail.innerHTML = skeletonHTML();
        detail.hidden = false;
        const file = await ghGetFile(plans[idx].path);
        detail.innerHTML = file ? renderMarkdown(file.content) : "<p class='muted'>Introuvable.</p>";
        detail.dataset.loaded = "1";
      } else {
        detail.hidden = false;
      }
    });
  });
}

/** "Séances précédentes" — a week browser (◀/▶ + a native date input to
 * jump straight to a week, a real calendar picker on iOS) defaulting to
 * last week, instead of an ever-growing flat list. Uses lookupDaySummary
 * (the merged, precomputed-first index) so browsing weeks costs no extra
 * fetch beyond the one-time index load — this, together with that index,
 * is what actually fixes Historique feeling slow to open (see
 * docs/adr/0020), not just how it's displayed. */
async function renderSessionHistoryWeek(token) {
  const monday = state.historyMonday;
  document.getElementById("history-week-label").textContent = `Semaine du ${formatFrDate(monday)}`;
  const container = document.getElementById("history-sessions-list");
  container.innerHTML = skeletonHTML();

  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
  const summaries = await Promise.all(dates.map((d) => lookupDaySummary(d)));
  if (stale(token)) return;

  const today = todayISO();
  const rows = dates
    .map((date, i) => {
      const s = summaries[i];
      if (!s.hasSession) return "";
      // Statut en pastille plutôt qu'en emoji (maquette C, ADR-0077).
      const status = sessionDayStatus(date, s.hasSession, s.hasExecuted, today, s.type).replace(/^\S+\s+/, "");
      const pill = s.type === "repos" ? "" : status === "Fait" ? "pill-ok" : date < today ? "pill-alert" : "pill-gold";
      const statusLabel = s.type === "repos" ? "" : date < today && status !== "Fait" ? "Non loggée" : status;
      return `
        <button class="history-item history-session type-${escapeAttr(s.type || "musculation")}" data-date="${date}">
          <span class="history-dot" aria-hidden="true"></span>
          <span class="history-main"><span class="history-date">${DAY_NAMES[i]} ${date.slice(8, 10)}/${date.slice(5, 7)}</span><span class="history-sub">${escapeHtmlText(s.name || "Séance")}</span></span>
          ${statusLabel ? `<span class="pill ${pill}">${escapeHtmlText(statusLabel)}</span>` : ""}
        </button>`;
    })
    .join("");
  container.innerHTML = rows || "<p class='muted small'>Pas de séance cette semaine-là.</p>";
  container.querySelectorAll(".history-item[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => showView("session", { date: btn.dataset.date }));
  });
}
