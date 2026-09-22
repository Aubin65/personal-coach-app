"use strict";

// ============================================================================
// Config
// ============================================================================
const REPO = "Aubin65/personal_coach";
const API = "https://api.github.com";
const TOKEN_KEY = "coach_gh_token";

// ============================================================================
// GitHub Contents API — thin client. Every read/write in this app goes
// through here, straight to the browser (CORS-enabled on api.github.com —
// verified), no backend of any kind. Same trust model as the existing iOS
// Shortcuts (docs/adr/0005): a single-repo, contents-scoped fine-grained
// PAT, kept only in this device's localStorage.
// ============================================================================

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function b64DecodeUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function ghRequest(path, options = {}) {
  const res = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  return res;
}

/** {content, sha} for a file, or null if it doesn't exist (404). Throws on
 * any other error (bad token, rate limit, etc.) so callers can surface it. */
async function ghGetFile(path) {
  const res = await ghRequest(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} en lisant ${path}`);
  const data = await res.json();
  return { content: b64DecodeUtf8(data.content), sha: data.sha };
}

/** Directory entries [{name, path, type}], or [] if the directory doesn't
 * exist yet. */
async function ghListDir(path) {
  const res = await ghRequest(path);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status} en listant ${path}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/** Create or update a file. Retries once on a 409 (sha changed between our
 * read and this write — refetches the current sha and retries) since the
 * async coach-chat workflow can write concurrently. */
async function ghPutFile(path, content, message, sha = null, retry = true) {
  const res = await ghRequest(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: b64EncodeUtf8(content),
      sha: sha || undefined,
    }),
  });
  if (res.status === 409 && retry) {
    const current = await ghGetFile(path);
    return ghPutFile(path, content, message, current ? current.sha : null, false);
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} en écrivant ${path}`);
  return res.json();
}

/** Read-modify-write helper for a JSON file: `mutate(currentValueOrDefault)`
 * returns the new value to write. */
async function ghPutJSON(path, defaultValue, message, mutate) {
  const current = await ghGetFile(path);
  const currentValue = current ? JSON.parse(current.content) : defaultValue;
  const next = mutate(currentValue);
  await ghPutFile(path, JSON.stringify(next, null, 2), message, current ? current.sha : null);
  return next;
}

async function verifyToken() {
  const res = await fetch(`${API}/repos/${REPO}`, {
    headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return false;
  const data = await res.json();
  return !!(data.permissions && data.permissions.push);
}

// ============================================================================
// Tiny markdown renderer — just what our own docs actually use (headers,
// bold/italic, inline code, links, unordered/ordered lists, tables, hr,
// paragraphs). Not a full CommonMark implementation on purpose: zero
// dependencies, zero build step, easy to read and extend.
// ============================================================================
function renderMarkdown(md) {
  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  let inList = null; // "ul" | "ol" | null

  const closeList = () => {
    if (inList) { html += `</${inList}>`; inList = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      i++; continue;
    }

    if (/^-{3,}\s*$/.test(line)) { closeList(); html += "<hr>"; i++; continue; }

    if (/^\|.*\|\s*$/.test(line)) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      // second row is the "---|---" separator, if present
      const bodyRows = rows.length > 1 && /^:?-+:?$/.test(rows[1][0] || "") ? rows.slice(2) : rows.slice(1);
      const headerRow = rows[0];
      html += "<table><thead><tr>" + headerRow.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      for (const r of bodyRows) html += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      html += "</tbody></table>";
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (inList !== tag) { closeList(); html += `<${tag}>`; inList = tag; }
      // Soft-wrapped source lines (this repo's own markdown style): an
      // indented, non-blank line that isn't itself a new list item/heading
      // continues the current one rather than being dropped.
      const parts = [(ul || ol)[1]];
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        parts.push(lines[i].trim());
        i++;
      }
      html += `<li>${inline(parts.join(" "))}</li>`;
      continue;
    }

    closeList();
    // paragraph: consume until a blank line or a line that starts a new block
    const para = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\|.*\|\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    html += `<p>${para.map(inline).join("<br>")}</p>`;
  }
  closeList();
  return html;
}

function skeletonHTML() {
  const tpl = document.getElementById("tpl-skeleton");
  return tpl ? tpl.innerHTML : "";
}

// ============================================================================
// Voice input — Web Speech API (on-device dictation, same idea as the iOS
// Shortcut's dictation step). Tap once to start, tap again to stop; the
// transcript is appended live to the target textarea so the user can still
// review/edit before saving. Falls back silently (button hidden) where
// unsupported rather than a broken control — notably this can also behave
// inconsistently in an installed (standalone) PWA on iOS, so text input
// always remains the reliable fallback.
// ============================================================================
function setupMicButton(buttonEl, hintEl, textareaEl) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { buttonEl.hidden = true; return; }

  const recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.continuous = true;
  recognition.interimResults = true;

  let recording = false;
  let baseText = "";
  let finalText = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk + " ";
      else interim += chunk;
    }
    textareaEl.value = (baseText + finalText + interim).trim();
  };
  recognition.onerror = () => stop();
  recognition.onend = () => { if (recording) stop(); };

  function start() {
    baseText = textareaEl.value ? textareaEl.value + " " : "";
    finalText = "";
    recording = true;
    buttonEl.classList.add("recording");
    buttonEl.textContent = "⏹️";
    hintEl.hidden = false;
    try { recognition.start(); } catch (_) { /* already started */ }
  }
  function stop() {
    recording = false;
    buttonEl.classList.remove("recording");
    buttonEl.textContent = "🎙️";
    hintEl.hidden = true;
    try { recognition.stop(); } catch (_) { /* already stopped */ }
  }

  buttonEl.addEventListener("click", () => (recording ? stop() : start()));
}

// ============================================================================
// Weekly plan overview — parses the plan markdown's day headers ("## Lundi
// 21/09 — Bas du corps (...)") and its "Points de vigilance de la semaine"
// list into structured data, for a compact day-strip + key-highlights card
// above the full raw plan text.
// ============================================================================
const DAY_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const DAY_ICONS = {
  rugby: "🏉",
  repos: "😴",
  match: "🏆",
  muscu: "🏋️",
};

function dayIconFor(title) {
  const t = title.toLowerCase();
  if (/repos/.test(t)) return DAY_ICONS.repos;
  if (/match/.test(t)) return DAY_ICONS.match;
  if (/rugby|club/.test(t)) return DAY_ICONS.rugby;
  return DAY_ICONS.muscu;
}

function parseWeekOverview(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const dayRe = new RegExp(`^##\\s+(${DAY_NAMES.join("|")})\\s+(\\d{1,2}/\\d{1,2})\\s*[—-]?\\s*(.*)$`);
  const days = [];
  for (const line of lines) {
    const m = dayRe.exec(line);
    if (m) days.push({ day: m[1], date: m[2], title: m[3].replace(/\([^)]*\)/g, "").trim() });
  }

  const viIdx = lines.findIndex((l) => /^##\s+Points de vigilance/i.test(l));
  const highlights = [];
  if (viIdx !== -1) {
    for (let i = viIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) break;
      const hm = lines[i].match(/^\d+\.\s+(.*)$/);
      if (hm) {
        const parts = [hm[1]];
        // Soft-wrapped source lines (see renderMarkdown) — an indented
        // continuation belongs to this same highlight, not a new one.
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*\d+\.\s+/.test(lines[i + 1])) {
          i++;
          parts.push(lines[i].trim());
        }
        highlights.push(parts.join(" "));
      }
    }
  }
  return { days, highlights };
}

function normalizeDM(str) {
  const [a, b] = str.split("/").map((n) => parseInt(n, 10));
  return `${a}/${b}`;
}

function renderWeekOverview(container, markdown, todayISOStr) {
  const { days, highlights } = parseWeekOverview(markdown);
  const [, tm, td] = todayISOStr.split("-");
  const todayDM = normalizeDM(`${parseInt(td, 10)}/${parseInt(tm, 10)}`);
  let html = "";

  if (days.length) {
    html += '<div class="day-strip">';
    for (const d of days) {
      const isToday = normalizeDM(d.date) === todayDM;
      html += `
        <div class="day-card${isToday ? " is-today" : ""}">
          <div class="day-name">${d.day.slice(0, 3)}</div>
          <div class="day-date">${d.date}</div>
          <div class="day-icon">${dayIconFor(d.title)}</div>
          <div class="day-title">${d.title.slice(0, 28)}</div>
        </div>`;
    }
    html += "</div>";
  }

  if (highlights.length) {
    html += `<div class="highlights-card"><h2>🎯 Objectifs clés de la semaine</h2><ul>${highlights
      .map((h) => `<li>${h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</li>`)
      .join("")}</ul></div>`;
  }

  container.innerHTML = html;
}

// ============================================================================
// Date / file-picking helpers — mirrors coach.dashboard_data's logic
// (latest_digest / current_plan / current_block / today_session) in JS,
// since the app has no Python runtime of its own.
// ============================================================================
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localISOWithOffset() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offM = pad(Math.abs(offsetMin) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${offH}:${offM}`
  );
}

/** Most recent entry in a directory listing whose name (minus extension)
 * is <= today — mirrors latest_digest/current_plan's file-picking. */
async function latestFileOnOrBefore(dirPath, ext, today) {
  const entries = await ghListDir(dirPath);
  const candidates = entries
    .filter((e) => e.type === "file" && e.name.endsWith(ext))
    .map((e) => e.name.slice(0, -ext.length))
    .filter((stem) => stem <= today)
    .sort();
  if (candidates.length === 0) return null;
  const stem = candidates[candidates.length - 1];
  const file = await ghGetFile(`${dirPath}/${stem}${ext}`);
  return file ? { date: stem, content: file.content } : null;
}

/** Highest B<n> block label seen across data/training/ (top-level + app-log),
 * mirroring coach.blocks.current_block. */
async function currentBlockLabel() {
  const weeks = await allTrainingWeekLabels();
  let best = null, bestN = -1;
  for (const label of weeks) {
    const m = /^B(\d+)-S\d+$/.exec(label);
    if (m && +m[1] > bestN) { bestN = +m[1]; best = `B${m[1]}`; }
  }
  return best;
}

async function allTrainingWeekLabels() {
  const top = await ghListDir("data/training");
  const labels = top.filter((e) => e.type === "file" && e.name.endsWith(".json")).map((e) => e.name.slice(0, -5));
  const appLogDir = top.find((e) => e.name === "app-log" && e.type === "dir");
  if (appLogDir) {
    const appFiles = await ghListDir("data/training/app-log");
    for (const f of appFiles.filter((e) => e.type === "file" && e.name.endsWith(".json"))) {
      const file = await ghGetFile(f.path);
      if (file) {
        try { labels.push(JSON.parse(file.content).week_label); } catch (_) { /* ignore malformed file */ }
      }
    }
  }
  return labels;
}

/** {weekLabel, path, week, session} for the session dated `today`, found
 * across data/training/ (top-level) then data/training/app-log/, or null.
 * Also returns a best-guess weekLabel (most recent file's label) for
 * logging a brand-new session when nothing is dated today yet. */
async function findTodaySession(today) {
  const top = await ghListDir("data/training");
  const jsonFiles = top.filter((e) => e.type === "file" && e.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
  const appLogDir = top.find((e) => e.name === "app-log" && e.type === "dir");
  const appFiles = appLogDir ? (await ghListDir("data/training/app-log")).filter((e) => e.type === "file" && e.name.endsWith(".json")) : [];

  let lastLabel = null;
  for (const entry of [...jsonFiles, ...appFiles]) {
    const file = await ghGetFile(entry.path);
    if (!file) continue;
    let week;
    try { week = JSON.parse(file.content); } catch (_) { continue; }
    if (week.week_label) lastLabel = week.week_label;
    const session = (week.sessions || []).find((s) => s.date === today);
    if (session) return { weekLabel: week.week_label, path: entry.path, week, session };
  }
  return { weekLabel: lastLabel, path: null, week: null, session: null };
}

// ============================================================================
// App state / navigation
// ============================================================================
const state = { view: "today", weekSubTab: "planning" };

const views = {
  today: { title: "Aujourd'hui", render: renderToday },
  week: { title: "Semaine", render: renderWeek },
  progress: { title: "Progression", render: renderProgress },
  chat: { title: "Coach", render: renderChat },
  "log-session": { title: "Loguer la séance", render: renderLogSession },
  "write-note": { title: "Nouvelle note", render: renderWriteNote },
  "adjust-week": { title: "Ajuster ma semaine", render: renderAdjustWeek },
};

function showView(name) {
  state.view = name;
  document.getElementById("topbar-title").textContent = views[name].title;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  const content = document.getElementById("content");
  content.innerHTML = "";
  const tplId = "tpl-" + name;
  const tpl = document.getElementById(tplId);
  if (tpl) content.appendChild(tpl.content.cloneNode(true));
  views[name].render().catch((err) => {
    content.insertAdjacentHTML("afterbegin", `<p class="error-text">${err.message}</p>`);
  });
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

document.getElementById("refresh-button").addEventListener("click", (e) => {
  e.currentTarget.classList.add("spinning");
  showView(state.view);
  setTimeout(() => e.currentTarget.classList.remove("spinning"), 800);
});

// ============================================================================
// Views
// ============================================================================
async function renderToday() {
  document.getElementById("today-digest-content").innerHTML = skeletonHTML();
  const digest = await latestFileOnOrBefore("data/digests", ".md", todayISO());
  document.getElementById("today-digest-date").textContent = digest ? `Digest du ${digest.date}` : "Digest";
  document.getElementById("today-digest-content").innerHTML = digest
    ? renderMarkdown(digest.content)
    : "<p class='muted'>Pas encore de digest généré.</p>";

  document.querySelectorAll("#today-quick-actions [data-action]").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.action));
  });
}

async function listPlans() {
  const entries = (await ghListDir("data/plans")).filter((e) => e.type === "file" && e.name.endsWith(".md"));
  return entries.map((e) => ({ date: e.name.slice(0, -3), path: e.path })).sort((a, b) => b.date.localeCompare(a.date));
}

async function renderWeek() {
  const tabs = document.querySelectorAll("#week-tabs .segment");
  const planningPanel = document.getElementById("week-planning-panel");
  const blockPanel = document.getElementById("week-block-content");
  const historyPanel = document.getElementById("week-history-panel");

  const applyTab = () => {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.weekTab === state.weekSubTab));
    planningPanel.hidden = state.weekSubTab !== "planning";
    blockPanel.hidden = state.weekSubTab !== "block";
    historyPanel.hidden = state.weekSubTab !== "history";
    if (state.weekSubTab === "history") loadPlanHistory();
  };
  tabs.forEach((t) => t.addEventListener("click", () => { state.weekSubTab = t.dataset.weekTab; applyTab(); }));
  applyTab();

  document.getElementById("adjust-week-button").addEventListener("click", () => showView("adjust-week"));

  document.getElementById("week-overview").innerHTML = skeletonHTML();
  document.getElementById("week-planning-content").innerHTML = skeletonHTML();
  const plan = await latestFileOnOrBefore("data/plans", ".md", todayISO());
  if (plan) {
    renderWeekOverview(document.getElementById("week-overview"), plan.content, todayISO());
    document.getElementById("week-planning-content").innerHTML = renderMarkdown(plan.content);
  } else {
    document.getElementById("week-overview").innerHTML = "";
    document.getElementById("week-planning-content").innerHTML = "<p class='muted'>Pas de planning disponible.</p>";
  }

  const blockContentEl = blockPanel.querySelector(".markdown-body");
  blockContentEl.innerHTML = skeletonHTML();
  const blockLabel = await currentBlockLabel();
  if (blockLabel) {
    const blockFile = await ghGetFile(`data/blocks/${blockLabel}.md`);
    blockContentEl.innerHTML = blockFile ? renderMarkdown(blockFile.content) : "<p class='muted'>Pas de fichier de bloc.</p>";
  } else {
    blockContentEl.innerHTML = "<p class='muted'>Pas de bloc en cours.</p>";
  }
}

async function loadPlanHistory() {
  const container = document.getElementById("history-plans-list");
  if (container.dataset.loaded) return;
  container.innerHTML = skeletonHTML();
  const plans = await listPlans();
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

const RING_RADIUS = 38;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringSVG(fraction) {
  const f = fraction == null ? 0 : Math.max(0, Math.min(1, fraction));
  const offset = RING_CIRCUMFERENCE * (1 - f);
  return `
    <svg width="92" height="92" viewBox="0 0 92 92">
      <circle class="ring-track" cx="46" cy="46" r="${RING_RADIUS}" stroke-width="9"></circle>
      <circle class="ring-fill" cx="46" cy="46" r="${RING_RADIUS}" stroke-width="9"
              stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${offset}"></circle>
    </svg>`;
}

function statTile(label, current, unit, fraction, help) {
  const valueText = current != null ? `${current}${unit}` : "—";
  return `
    <div class="stat-tile">
      <div class="stat-label">${label}</div>
      <div class="ring-wrap">
        ${ringSVG(fraction)}
        <div class="ring-value">${valueText}</div>
      </div>
      ${help ? `<div class="stat-help">${help}</div>` : ""}
    </div>`;
}

async function renderProgress() {
  const el = document.getElementById("progress-content");
  el.innerHTML = skeletonHTML();
  const file = await ghGetFile("data/app/summary.json");
  if (!file) { el.innerHTML = "<p class='muted'>Pas encore de résumé exporté.</p>"; return; }
  const s = JSON.parse(file.content);
  let tiles = "";

  if (s.bodyweight_progress) {
    const bp = s.bodyweight_progress;
    tiles += statTile("Poids de corps", bp.current_kg, " kg", bp.fraction, `Objectif ${bp.target_kg} kg`);
  }

  const liftLabels = { back_squat: "Back Squat", bench: "Bench", trap_bar_deadlift: "Trap Bar Deadlift" };
  for (const [key, label] of Object.entries(liftLabels)) {
    const entry = s.strength_trajectory && s.strength_trajectory[key];
    if (!entry) continue;
    const best = entry.recent_best;
    tiles += statTile(
      label,
      best ? best.load : null,
      " kg",
      entry.progress_fraction,
      entry.target ? `Cible 4RM : ${entry.target.four_rm.toFixed(1)} kg` : "Pas de cible calculable"
    );
  }

  let html = tiles ? `<div class="stat-grid">${tiles}</div>` : "";

  if (s.upcoming_matches && s.upcoming_matches.length) {
    html += "<h2>🏆 Calendrier</h2><ul>";
    for (const m of s.upcoming_matches) {
      html += `<li>${m.date} — ${m.opponent} (${m.home_away}) ${m.user_is_playing ? "" : "· tu ne joues pas encore"}</li>`;
    }
    html += "</ul>";
  }

  el.innerHTML = html || "<p class='muted'>Pas encore de données.</p>";
}

// ---- Chat ----
let chatPollTimer = null;

/** Appends a user turn to the shared chat log — used by the Coach tab and
 * by "Ajuster ma semaine" (prompts/app-chat.md already routes planning
 * requests to prompts/weekly-plan.md and posts the result back here). */
async function postUserMessage(text) {
  return ghPutJSON(
    "data/app-chat/conversation.json",
    [],
    "App : nouveau message utilisateur",
    (conv) => [...conv, { role: "user", text, at: localISOWithOffset() }]
  );
}

async function renderChat() {
  await refreshChatLog();
  const form = document.getElementById("chat-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    appendChatBubble(text, "user");
    try {
      await postUserMessage(text);
    } catch (err) {
      appendChatBubble(`Échec de l'envoi : ${err.message}`, "assistant");
    }
    startChatPolling();
  });
  startChatPolling();
  // stop polling when leaving the chat view
  const stop = () => { if (state.view !== "chat") clearInterval(chatPollTimer); else setTimeout(stop, 5000); };
  setTimeout(stop, 5000);
}

function appendChatBubble(text, role) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  const placeholder = log.querySelector(".muted");
  if (placeholder) placeholder.remove();
  const div = document.createElement("div");
  div.className = `chat-bubble ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function refreshChatLog() {
  const file = await ghGetFile("data/app-chat/conversation.json");
  const log = document.getElementById("chat-log");
  if (!log) return;
  const conv = file ? JSON.parse(file.content) : [];
  log.innerHTML = conv.length
    ? ""
    : "<p class='muted small'>Pose une question au coach — récupération, nutrition, séance du jour, ce que tu veux. La réponse arrive en quelques minutes.</p>";
  for (const turn of conv) {
    const div = document.createElement("div");
    div.className = `chat-bubble ${turn.role}`;
    div.textContent = turn.text;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

function startChatPolling() {
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(() => { if (state.view === "chat") refreshChatLog(); }, 15000);
}

// ---- Log a session ----
async function renderLogSession() {
  const el = document.getElementById("log-session-content");
  el.innerHTML = skeletonHTML();
  const today = todayISO();
  const found = await findTodaySession(today);

  if (!found.session) {
    el.innerHTML = `
      <section class="card">
        <p class="muted">Pas de séance détectée pour aujourd'hui (${today}).</p>
        <label>Nom de la séance</label>
        <input id="log-session-name" value="Séance">
        <button id="log-session-start" class="primary-button">Créer la séance du jour</button>
      </section>`;
    document.getElementById("log-session-start").addEventListener("click", async () => {
      const name = document.getElementById("log-session-name").value.trim() || "Séance";
      await saveExercise(found, today, { name: "Exercice", executed_sets: "", executed_reps: "", executed_load: "", rir: "", notes: "" }, name, true);
      renderLogSession();
    });
    return;
  }

  const exercises = found.session.exercises || [];
  el.innerHTML = exercises
    .map(
      (ex, idx) => `
      <div class="exercise-log-card" data-idx="${idx}">
        <h3>${ex.name}</h3>
        <div class="exercise-log-grid">
          <div><label>Séries</label><input type="text" class="f-sets" value="${ex.executed?.sets ?? ""}"></div>
          <div><label>Reps (ex. 4-4-4-3)</label><input type="text" class="f-reps" value="${ex.executed?.reps ?? ""}"></div>
          <div><label>Charge (kg)</label><input type="text" class="f-load" value="${ex.executed?.load ?? ""}"></div>
          <div><label>RIR (ex. 2-2-1)</label><input type="text" class="f-rir" value="${ex.rir ?? ""}"></div>
        </div>
        <button class="primary-button small save-exercise" style="margin-top:10px">Enregistrer</button>
        <div class="exercise-saved-badge" hidden>Enregistré ✓</div>
      </div>`
    )
    .join("");

  el.querySelectorAll(".save-exercise").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".exercise-log-card");
      const idx = +card.dataset.idx;
      const ex = exercises[idx];
      btn.disabled = true;
      try {
        await saveExercise(found, today, {
          name: ex.name,
          executed_sets: card.querySelector(".f-sets").value,
          executed_reps: card.querySelector(".f-reps").value,
          executed_load: card.querySelector(".f-load").value,
          rir: card.querySelector(".f-rir").value,
        });
        card.querySelector(".exercise-saved-badge").hidden = false;
      } catch (err) {
        card.insertAdjacentHTML("beforeend", `<p class="error-text small">${err.message}</p>`);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/** Writes/updates data/training/app-log/<date>.json with one exercise's
 * executed values — read-modify-write so logging exercises one at a time
 * never loses a previous one. Schema matches coach.sheets_parse.parse_week
 * exactly so every existing reader (trajectory, progression, compliance,
 * blocks) picks it up with no code changes — see docs/adr/0017. */
async function saveExercise(found, date, exerciseUpdate, sessionName, isNewSession = false) {
  const path = `data/training/app-log/${date}.json`;
  await ghPutJSON(path, null, `App : log ${date}`, (current) => {
    const base = current || {
      week_label: found.weekLabel || "app",
      objective: null,
      bodyweight: {},
      sessions: [],
    };
    let session = base.sessions.find((s) => s.date === date);
    if (!session) {
      session = { name: sessionName || (found.session && found.session.name) || "Séance", date, exercises: [], notes: "Loguée depuis l'app." };
      base.sessions.push(session);
    }
    let exercise = session.exercises.find((e) => e.name === exerciseUpdate.name);
    if (!exercise) {
      exercise = {
        name: exerciseUpdate.name,
        planned: { sets: null, reps: null, load: null },
        executed: { sets: null, reps: null, load: null },
        rir: null,
        notes: null,
        superset_with_previous: false,
      };
      session.exercises.push(exercise);
    }
    exercise.executed = {
      sets: exerciseUpdate.executed_sets || null,
      reps: exerciseUpdate.executed_reps || null,
      load: exerciseUpdate.executed_load || null,
    };
    exercise.rir = exerciseUpdate.rir || null;
    return base;
  });
}

// ---- Notes ----
async function renderWriteNote() {
  setupMicButton(
    document.getElementById("note-mic"),
    document.getElementById("note-voice-hint"),
    document.getElementById("note-text")
  );
  document.getElementById("note-save").addEventListener("click", async () => {
    const textEl = document.getElementById("note-text");
    const statusEl = document.getElementById("note-status");
    const text = textEl.value.trim();
    if (!text) return;
    const iso = localISOWithOffset();
    statusEl.textContent = "Enregistrement…";
    try {
      await ghPutFile(`data/notes/${iso}.md`, `${iso}\n\n${text}`, `Note depuis l'app (${iso})`);
      textEl.value = "";
      statusEl.textContent = "Enregistrée ✓";
      loadRecentNotes();
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    }
  });
  loadRecentNotes();
}

// ---- Ajuster ma semaine ----
const ADJUST_SUGGESTIONS = [
  "Je suis fatigué, allège cette semaine",
  "J'ai un empêchement, décale une séance",
  "Reprogramme en tenant compte du prochain match",
];

async function renderAdjustWeek() {
  setupMicButton(
    document.getElementById("adjust-mic"),
    document.getElementById("adjust-voice-hint"),
    document.getElementById("adjust-text")
  );

  const chipsEl = document.getElementById("adjust-suggestions");
  chipsEl.innerHTML = ADJUST_SUGGESTIONS.map((s) => `<button type="button" class="suggestion-chip">${s}</button>`).join("");
  chipsEl.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const textEl = document.getElementById("adjust-text");
      textEl.value = chip.textContent;
      textEl.focus();
    });
  });

  document.getElementById("adjust-send").addEventListener("click", async (e) => {
    const textEl = document.getElementById("adjust-text");
    const statusEl = document.getElementById("adjust-status");
    const text = textEl.value.trim();
    if (!text) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    statusEl.textContent = "Envoi…";
    try {
      await postUserMessage(text);
      textEl.value = "";
      statusEl.innerHTML = "";
      const ok = document.createElement("span");
      ok.textContent = "Envoyé ✓ — la réponse arrive dans quelques minutes. ";
      const link = document.createElement("button");
      link.textContent = "Voir dans Coach →";
      link.className = "suggestion-chip";
      link.addEventListener("click", () => showView("chat"));
      statusEl.appendChild(ok);
      statusEl.appendChild(link);
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

async function loadRecentNotes(limit = 5) {
  const container = document.getElementById("recent-notes");
  container.innerHTML = skeletonHTML();
  const entries = (await ghListDir("data/notes")).filter((e) => e.type === "file" && e.name.endsWith(".md"));
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const recent = entries.slice(0, limit);
  if (recent.length === 0) { container.innerHTML = "<p class='muted small'>Pas encore de note.</p>"; return; }
  const files = await Promise.all(recent.map((e) => ghGetFile(e.path)));
  container.innerHTML = files
    .map((f, i) => {
      if (!f) return "";
      const lines = f.content.split("\n");
      const date = recent[i].name.slice(0, 10);
      const body = lines.slice(1).join(" ").trim();
      return `<div class="note-item"><div class="note-date">${date}</div>${body.slice(0, 200)}</div>`;
    })
    .join("");
  if (entries.length > recent.length) {
    container.insertAdjacentHTML("beforeend", `<button class="details-toggle" id="notes-see-more">Voir plus (${entries.length - recent.length})</button>`);
    document.getElementById("notes-see-more").addEventListener("click", () => loadRecentNotes(limit + 15));
  }
}

// ============================================================================
// Login
// ============================================================================
async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
    // A new service worker (shipped whenever CACHE_NAME bumps — see
    // service-worker.js) claims control of already-open tabs via
    // clients.claim(); reload once when that happens so an app left open
    // in the background picks up the new shell itself, instead of the
    // person having to manually close/reopen it.
    let reloadedForNewVersion = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForNewVersion) return;
      reloadedForNewVersion = true;
      window.location.reload();
    });
  }

  const loginScreen = document.getElementById("login-screen");
  const app = document.getElementById("app");

  if (getToken()) {
    loginScreen.hidden = true;
    app.hidden = false;
    showView("today");
    return;
  }

  document.getElementById("login-button").addEventListener("click", async () => {
    const input = document.getElementById("token-input");
    const errorEl = document.getElementById("login-error");
    const token = input.value.trim();
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    errorEl.hidden = true;
    const button = document.getElementById("login-button");
    button.disabled = true;
    button.textContent = "Vérification…";
    const ok = await verifyToken().catch(() => false);
    button.disabled = false;
    button.textContent = "Se connecter";
    if (!ok) {
      localStorage.removeItem(TOKEN_KEY);
      errorEl.textContent = "Token invalide, ou sans accès en écriture à ce repo.";
      errorEl.hidden = false;
      return;
    }
    loginScreen.hidden = true;
    app.hidden = false;
    showView("today");
  });
}

init();
