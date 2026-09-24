import { ghListDir, ghGetFile, ghPutFile, ghDeleteFile, ghPutJSON } from "../github-api.js";
import { state, stale, showView } from "../nav.js";
import { todayISO, mondayOfWeek, addDaysISO, formatFrDate, sessionDayStatus } from "../date-utils.js";
import { skeletonHTML, escapeHtmlText, escapeAttr, renderMarkdown } from "../markdown.js";
import { renderWeekOverview, parseWeekOverview, splitBlockMarkdown, splitBlockIntro, DAY_NAMES } from "../plan-overview.js";
import { currentBlockLabel, lookupDaySummary, findSessionForDate } from "../training-index.js";
import { SESSION_TYPES } from "../session-types.js";
import { saveSession } from "../session/session-form.js";

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
export async function renderWeekPlanning(token) {
  const monday = state.planningMonday;
  document.getElementById("planning-week-label").textContent = `Semaine du ${formatFrDate(monday)}`;
  document.getElementById("week-day-strip").innerHTML = skeletonHTML();
  document.getElementById("week-highlights").innerHTML = "";
  document.getElementById("day-overview-panel").innerHTML = "";

  const planFile = await ghGetFile(`data/plans/${monday}.md`);
  if (stale(token)) return;

  let planDays = [];
  if (planFile) {
    renderWeekOverview(
      document.getElementById("week-day-strip"),
      document.getElementById("week-highlights"),
      planFile.content,
      todayISO(),
      monday,
      token
    ).catch(() => {});
    planDays = parseWeekOverview(planFile.content).days;
  } else {
    document.getElementById("week-day-strip").innerHTML = "<p class='muted'>Pas de planning disponible pour cette semaine.</p>";
  }
  renderWeekSessionsTable(token, monday, planDays).catch(() => {});
}

// ---- Semaine : Planning (+ proposition en attente), Bloc, Séances, Historique ----
export async function renderWeek(token) {
  const tabs = document.querySelectorAll("#week-tabs .segment");
  const planningPanel = document.getElementById("week-planning-panel");
  const blockPanel = document.getElementById("week-block-content");
  const sessionsPanel = document.getElementById("week-sessions-content");
  const historyPanel = document.getElementById("week-history-panel");

  const applyTab = () => {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.weekTab === state.weekSubTab));
    planningPanel.hidden = state.weekSubTab !== "planning";
    blockPanel.hidden = state.weekSubTab !== "block";
    sessionsPanel.hidden = state.weekSubTab !== "sessions";
    historyPanel.hidden = state.weekSubTab !== "history";
    if (state.weekSubTab === "history") loadPlanHistory(token);
  };
  tabs.forEach((t) => t.addEventListener("click", () => { state.weekSubTab = t.dataset.weekTab; applyTab(); }));
  applyTab();

  document.getElementById("adjust-week-button").addEventListener("click", () => showView("adjust-week"));

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
  loadPendingProposal(token).catch(() => {});
  loadActiveAlerts(token).catch(() => {});
  loadPendingSessionAdjustments(token).catch(() => {});
  renderWeekPlanning(token).catch(() => {});

  const blockContentEl = blockPanel.querySelector(".markdown-body");
  blockContentEl.innerHTML = skeletonHTML();
  const blockLabel = await currentBlockLabel();
  if (stale(token)) return;
  if (blockLabel) {
    const blockFile = await ghGetFile(`data/blocks/${blockLabel}.md`);
    if (stale(token)) return;
    if (blockFile) {
      const { overview } = splitBlockMarkdown(blockFile.content);
      const { intro, rest } = splitBlockIntro(overview);
      blockContentEl.innerHTML = renderMarkdown(intro) + (rest
        ? `<details class="block-overview-details"><summary>📋 Bilan et objectifs détaillés</summary>${renderMarkdown(rest)}</details>`
        : "");
    } else {
      blockContentEl.innerHTML = "<p class='muted'>Pas de fichier de bloc.</p>";
    }
  } else {
    blockContentEl.innerHTML = "<p class='muted'>Pas de bloc en cours.</p>";
  }
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
      const status = sessionDayStatus(date, s.hasSession, s.hasExecuted, today);
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
      <button type="button" id="sessions-prev-week" class="icon-button small" aria-label="Semaine précédente">◀</button>
      <span class="forge-week-label">Semaine du ${formatFrDate(mondayISO)}</span>
      <button type="button" id="sessions-next-week" class="icon-button small" aria-label="Semaine suivante">▶</button>
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
 * mechanism (see loadActiveAlerts, docs/adr/0045) — this proposal flow is
 * user-requested only. */
async function loadPendingProposal(token) {
  const box = document.getElementById("pending-proposal");
  // Surfaced as a badge on the Planning tab too — a pending proposal must
  // never go unnoticed just because Historique/Bloc happened to be the
  // sub-tab left active from a previous visit to Semaine.
  const planningTab = document.querySelector('#week-tabs .segment[data-week-tab="planning"]');
  const entries = await ghListDir("data/plans/pending");
  if (stale(token)) return;
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) { box.innerHTML = ""; if (planningTab) planningTab.classList.remove("has-pending"); return; }

  const target = files[0];
  const file = await ghGetFile(target.path);
  if (stale(token)) return;
  if (!file) { box.innerHTML = ""; if (planningTab) planningTab.classList.remove("has-pending"); return; }
  if (planningTab) planningTab.classList.add("has-pending");

  const monday = target.name.slice(0, -3);
  box.innerHTML = `
    <section class="card pending-proposal-card">
      <h2>🗒️ Proposition du coach — à valider</h2>
      <p class="muted small">Semaine du ${monday}</p>
      <div class="markdown-body">${renderMarkdown(file.content)}</div>
      <div class="proposal-actions">
        <button type="button" id="proposal-reject" class="primary-button ghost small">❌ Refuser</button>
        <button type="button" id="proposal-accept" class="primary-button small">✅ Valider</button>
      </div>
      <p id="proposal-status" class="muted small"></p>
    </section>`;

  document.getElementById("proposal-accept").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("proposal-status");
    btn.disabled = true;
    statusEl.textContent = "Application…";
    try {
      const targetPath = `data/plans/${target.name}`;
      const targetCurrent = await ghGetFile(targetPath);
      await ghPutFile(targetPath, file.content, `Planning semaine du ${monday} (validé depuis l'app)`, targetCurrent ? targetCurrent.sha : null);
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

const ALERT_CATEGORY_LABELS = { blessure: "🩹 Blessure/douleur", sommeil: "😴 Sommeil", poids: "⚖️ Poids", charge: "📈 Charge" };

/** Persistent alert cards, shown in the Planning sub-tab of Semaine —
 * between the day strip/day-overview panel and "objectifs clés" (direct
 * placement request, see docs/adr/0045 amendment) — distinct from a
 * plan-adjustment proposal: an alert stays up until the underlying
 * situation is actually resolved, not until a single Valider/Refuser
 * choice (direct request: "j'ai besoin qu'elles soient présentes...
 * enlevées au cas par cas").
 * `resolution: "auto"` entries (sleep, weight, workload) are entirely
 * managed by `coach.alerts.sync_active_alerts` and disappear on their own
 * once the signal clears — no dismiss button needed for those, and
 * clicking one wouldn't stick anyway since the next sync would re-add it
 * while the signal stays true. `resolution: "manual_or_note"` entries
 * (coach-judged, e.g. an injury) can also be cleared by the coach itself
 * from a voice note, but always get a manual dismiss button too, since the
 * coach might not always catch the resolution on its own. */
async function loadActiveAlerts(token) {
  const box = document.getElementById("week-active-alerts");
  const file = await ghGetFile("data/alerts/active.json");
  if (stale(token)) return;
  let alerts = [];
  if (file) { try { alerts = JSON.parse(file.content); } catch (_) { alerts = []; } }
  if (!Array.isArray(alerts) || alerts.length === 0) { box.innerHTML = ""; return; }

  // <details> rather than a plain <section> — collapsed by default, the
  // full message/advice/button only render once opened (direct request:
  // "trop verbeuses à l'écran", especially with several alerts stacked).
  box.innerHTML = alerts
    .map((a) => `
      <details class="card alert-card" data-alert-id="${escapeAttr(a.id || "")}">
        <summary>⚠️ ${ALERT_CATEGORY_LABELS[a.category] || "Alerte"}</summary>
        <p>${escapeHtmlText(a.message || "")}</p>
        ${Array.isArray(a.advice) && a.advice.length ? `<ul class="alert-advice">${a.advice.map((adv) => `<li>${escapeHtmlText(adv)}</li>`).join("")}</ul>` : ""}
        ${a.resolution === "manual_or_note"
          ? `<div class="proposal-actions">
              <button type="button" class="primary-button ghost small alert-dismiss">✅ Marquer comme résolu</button>
            </div>
            <p class="muted small alert-status"></p>`
          : `<p class="muted small">Se lève automatiquement une fois la situation revenue à la normale.</p>`}
      </details>`)
    .join("");

  box.querySelectorAll(".alert-dismiss").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".alert-card");
      const alertId = card.dataset.alertId;
      const statusEl = card.querySelector(".alert-status");
      btn.disabled = true;
      statusEl.textContent = "Mise à jour…";
      try {
        await ghPutJSON("data/alerts/active.json", [], "Alerte levée depuis l'app", (current) => {
          const list = Array.isArray(current) ? current : [];
          return list.filter((entry) => entry.id !== alertId);
        });
        loadActiveAlerts(state.renderToken).catch(() => {});
      } catch (err) {
        statusEl.textContent = `Échec : ${err.message}`;
        btn.disabled = false;
      }
    });
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
  const rows = (session.exercises || [])
    .map((ex) => {
      const p = ex.planned || {};
      const detail = [p.sets, p.reps, p.load].filter((v) => v != null && v !== "").join(" × ");
      return `<li>${escapeHtmlText(ex.name || "")}${detail ? ` — ${escapeHtmlText(String(detail))}` : ""}</li>`;
    })
    .join("");

  box.innerHTML = `
    <section class="card pending-proposal-card">
      <h2>📝 Ajustement de séance proposé — à valider</h2>
      <p class="muted small">${formatFrDate(date)} — ${escapeHtmlText(session.name || "")}</p>
      ${proposal.rationale ? `<p class="small">${escapeHtmlText(proposal.rationale)}</p>` : ""}
      <ul class="forge-pending-list">${rows || "<li class='muted small'>Aucun exercice.</li>"}</ul>
      <div class="proposal-actions">
        <button type="button" id="session-adjust-reject" class="primary-button ghost small">❌ Refuser</button>
        <button type="button" id="session-adjust-accept" class="primary-button small">✅ Valider</button>
      </div>
      <p id="session-adjust-status" class="muted small"></p>
    </section>`;

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
        <div class="history-date">Semaine du ${p.date}</div>
        <div class="history-sub">Appuie pour voir le contenu</div>
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
      const icon = SESSION_TYPES[s.type] ? SESSION_TYPES[s.type].icon : "🏋️";
      const status = sessionDayStatus(date, s.hasSession, s.hasExecuted, today);
      return `
        <button class="history-item" data-date="${date}">
          <div class="history-date">${icon} ${DAY_NAMES[i]} ${date.slice(8, 10)}/${date.slice(5, 7)}</div>
          <div class="history-sub">${escapeHtmlText(s.name || "Séance")} · ${status}</div>
        </button>`;
    })
    .join("");
  container.innerHTML = rows || "<p class='muted small'>Pas de séance cette semaine-là.</p>";
  container.querySelectorAll(".history-item[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => showView("session", { date: btn.dataset.date }));
  });
}
