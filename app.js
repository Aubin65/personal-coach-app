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

/** Deletes a file via the GitHub Contents API (needs the file's current
 * sha) — used to clear a validated/rejected plan proposal in
 * data/plans/pending/. */
async function ghDeleteFile(path, message, sha) {
  const res = await ghRequest(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} en supprimant ${path}`);
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

function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtmlText(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
function setupMicButton(buttonEl, hintEl, textareaEl, captionEl) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { buttonEl.hidden = true; return; }

  const recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.continuous = true;
  recognition.interimResults = true;

  const ERROR_MESSAGES = {
    "not-allowed": "Micro refusé — autorise l'accès au micro dans les réglages de Safari.",
    "service-not-allowed": "Micro refusé — autorise l'accès au micro dans les réglages de Safari.",
    "audio-capture": "Pas de micro détecté.",
    network: "Problème réseau pendant la dictée.",
  };
  const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

  let recording = false; // the person wants to be recording (drives auto-restart)
  let stoppedByUser = false;
  let baseText = "";
  let finalText = "";

  // Only *final* (confirmed) chunks land in the textarea — the still-being-
  // recognized interim text is shown separately in captionEl, closer to
  // how iOS dictation itself shows a live line before committing words.
  // Tapping the mic again to stop, then reviewing/editing the textarea
  // before hitting the screen's own Save/Envoyer button, is the validation
  // step before anything is actually sent.
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk + " ";
      else interim += chunk;
    }
    textareaEl.value = (baseText + finalText).trim();
    if (captionEl) captionEl.textContent = interim || "…";
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech") return; // just a pause, not an error worth surfacing
    hintEl.textContent = ERROR_MESSAGES[event.error] || `Erreur dictée (${event.error}).`;
    if (FATAL_ERRORS.has(event.error)) { stoppedByUser = true; recording = false; }
  };

  recognition.onend = () => {
    // iOS Safari ends recognition on its own after a short pause even with
    // continuous=true — restart transparently so the person doesn't have
    // to keep re-tapping the mic mid-dictation.
    if (recording && !stoppedByUser) {
      try { recognition.start(); } catch (_) { /* restart already pending */ }
    } else {
      finishStopUI();
    }
  };

  async function start() {
    // Some browsers (notably inside an installed iOS PWA) never prompt for
    // mic permission from recognition.start() alone — asking explicitly
    // first surfaces a clear "not-allowed" instead of a silent no-op.
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); }
      catch (_) { hintEl.textContent = ERROR_MESSAGES["not-allowed"]; hintEl.hidden = false; return; }
    }
    baseText = textareaEl.value ? textareaEl.value + " " : "";
    finalText = "";
    recording = true;
    stoppedByUser = false;
    buttonEl.classList.add("recording");
    buttonEl.textContent = "⏹️";
    hintEl.textContent = "🔴 Enregistrement… appuie à nouveau pour arrêter";
    hintEl.hidden = false;
    if (captionEl) { captionEl.textContent = "…"; captionEl.hidden = false; }
    try { recognition.start(); } catch (_) { /* already started */ }
  }
  function stop() {
    recording = false;
    stoppedByUser = true;
    try { recognition.stop(); } catch (_) { /* already stopped */ }
    finishStopUI();
  }
  function finishStopUI() {
    buttonEl.classList.remove("recording");
    buttonEl.textContent = "🎙️";
    hintEl.hidden = true;
    if (captionEl) captionEl.hidden = true;
  }

  buttonEl.addEventListener("click", () => (recording ? stop() : start()));
}

// ============================================================================
// Weekly plan overview — parses the plan markdown's day headers ("## Lundi
// 21/09 — Bas du corps (...)") and its "Points de vigilance de la semaine"
// list into structured data, for a compact day-strip + key-highlights card
// above the full raw plan text, and to build the week's forecast table.
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

/** `mondayISO` is the plan's own filename (data/plans/<lundi-AAAA-MM-jj>.md)
 * — the reliable source for each day's real ISO date, since the day
 * headers in the markdown only carry "DD/MM" with no year. Day cards are
 * clickable: they open that date's session directly (log/adjust/review),
 * rather than only ever reaching today's from the Aujourd'hui tab. */
function renderWeekOverview(container, markdown, todayISOStr, mondayISO) {
  const { days, highlights } = parseWeekOverview(markdown);
  const [, tm, td] = todayISOStr.split("-");
  const todayDM = normalizeDM(`${parseInt(td, 10)}/${parseInt(tm, 10)}`);
  let html = "";

  if (days.length) {
    html += '<div class="day-strip">';
    for (const d of days) {
      const isToday = normalizeDM(d.date) === todayDM;
      const dayIdx = DAY_NAMES.indexOf(d.day);
      const iso = mondayISO && dayIdx !== -1 ? addDaysISO(mondayISO, dayIdx) : null;
      html += `
        <button type="button" class="day-card${isToday ? " is-today" : ""}"${iso ? ` data-date="${iso}"` : ""}>
          <div class="day-name">${d.day.slice(0, 3)}</div>
          <div class="day-date">${d.date}</div>
          <div class="day-icon">${dayIconFor(d.title)}</div>
          <div class="day-title">${d.title.slice(0, 28)}</div>
        </button>`;
    }
    html += "</div>";
  }

  if (highlights.length) {
    html += `<div class="highlights-card"><h2>🎯 Objectifs clés de la semaine</h2><ul>${highlights
      .map((h) => `<li>${h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</li>`)
      .join("")}</ul></div>`;
  }

  container.innerHTML = html;
  container.querySelectorAll(".day-card[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => showView("session", { date: btn.dataset.date }));
  });
}

/** Splits a block markdown into a condensed "objectifs principaux" part
 * (Bloc tab, and the block-objectives reference shown while planning) and
 * the verbose day-by-day breakdown — the "## Planning détaillé, semaine
 * par semaine" section specifically, since that's this project's own
 * convention for where per-session detail lives (see data/blocks/*.md).
 * Falls back to putting everything in the overview if that heading isn't
 * found, rather than losing content. */
function splitBlockMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const topHeadingIdx = [];
  lines.forEach((l, idx) => { if (/^##\s+/.test(l)) topHeadingIdx.push(idx); });
  const detailStart = lines.findIndex((l) => /^##\s+Planning détaillé/i.test(l));
  if (detailStart === -1) return { overview: md, detail: "" };
  const nextIdx = topHeadingIdx.find((idx) => idx > detailStart);
  const detailEnd = nextIdx !== undefined ? nextIdx : lines.length;
  const detail = lines.slice(detailStart, detailEnd).join("\n");
  const overview = lines.slice(0, detailStart).concat(lines.slice(detailEnd)).join("\n");
  return { overview, detail };
}

/** Renders a digest's "## " sections as separate cards with an icon per
 * heading, instead of one long undifferentiated markdown blob — purely a
 * readability pass, the underlying markdown/content is unchanged. */
const DIGEST_ICONS = [
  [/forme du jour/i, "💪"],
  [/trajectoire/i, "📈"],
  [/conseils/i, "🎯"],
];
function digestIconFor(title) {
  const hit = DIGEST_ICONS.find(([re]) => re.test(title));
  return hit ? hit[1] : "📋";
}

function renderDigestSections(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length && !/^##\s+/.test(lines[i])) i++; // skip the "# Digest du ..." title line
  while (i < lines.length) {
    const h = lines[i].match(/^##\s+(.*)$/);
    if (!h) { i++; continue; }
    const title = h[1];
    i++;
    const body = [];
    while (i < lines.length && !/^##\s+/.test(lines[i])) { body.push(lines[i]); i++; }
    html += `<section class="card digest-section"><h2><span class="digest-icon">${digestIconFor(title)}</span>${title}</h2>${renderMarkdown(body.join("\n"))}</section>`;
  }
  return html || `<section class="card"><div class="markdown-body">${renderMarkdown(md)}</div></section>`;
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

/** ISO date `n` days after `iso` (n can be negative) — used to turn a
 * plan's Monday (its filename) plus a day-of-week into a concrete date,
 * and to step Forge's week picker back and forth. */
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** The Monday (ISO) of the week containing `iso`. */
function mondayOfWeek(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const offset = (date.getUTCDay() + 6) % 7; // days since Monday (getUTCDay: 0=Sun..6=Sat)
  date.setUTCDate(date.getUTCDate() - offset);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatFrDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
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
    const files = await Promise.all(appFiles.filter((e) => e.type === "file" && e.name.endsWith(".json")).map((e) => ghGetFile(e.path)));
    for (const file of files) {
      if (!file) continue;
      try { labels.push(JSON.parse(file.content).week_label); } catch (_) { /* ignore malformed file */ }
    }
  }
  return labels;
}

/** {weekLabel, path, week, session} for the session dated `date`, found
 * across data/training/ (top-level) then data/training/app-log/, or null.
 * Also returns a best-guess weekLabel (most recent file's label) for
 * logging a brand-new session when nothing is dated `date` yet. Used for
 * today's quick-log flow, Forge, the week day-strip and Historique. */
async function findSessionForDate(date) {
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
    const session = (week.sessions || []).find((s) => s.date === date);
    if (session) return { weekLabel: week.week_label, path: entry.path, week, session };
  }
  return { weekLabel: lastLabel, path: null, week: null, session: null };
}

/** All sessions across data/training/ (Sheets-synced) and
 * data/training/app-log/ (app edits — win on a same-date collision),
 * newest first. Powers "Séances précédentes" in Historique and the
 * "dupliquer une séance récente" prefill picker. Fetches every week file
 * in parallel (not one await at a time) — with a season's worth of
 * history this was the main reason Historique used to feel slow/stuck. */
async function listAllSessions() {
  const top = await ghListDir("data/training");
  const jsonFiles = top.filter((e) => e.type === "file" && e.name.endsWith(".json"));
  const appLogDir = top.find((e) => e.name === "app-log" && e.type === "dir");
  const appFiles = appLogDir ? (await ghListDir("data/training/app-log")).filter((e) => e.type === "file" && e.name.endsWith(".json")) : [];

  const files = await Promise.all([...jsonFiles, ...appFiles].map((e) => ghGetFile(e.path)));

  const byDate = new Map();
  for (const file of files) {
    if (!file) continue;
    let week;
    try { week = JSON.parse(file.content); } catch (_) { continue; }
    for (const s of week.sessions || []) byDate.set(s.date, { date: s.date, name: s.name, type: s.type, weekLabel: week.week_label });
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// ============================================================================
// App state / navigation
// ============================================================================
const state = { view: "today", weekSubTab: "planning", sessionDate: null, forgeMonday: null };

// Bumped on every navigation; each async render function captures it and
// checks `stale(token)` after an await before touching the DOM. Without
// this, an async render that resolves after the user has already
// navigated away writes into elements that either no longer exist
// (`document.getElementById` returns null → "null is not an object"
// crash, injected as stray red text into whatever view is now showing) or
// are detached (silently invisible, e.g. a stuck-looking Historique).
let renderToken = 0;
function stale(token) {
  return token !== renderToken;
}

const views = {
  today: { title: "Aujourd'hui", render: renderToday },
  week: { title: "Semaine", render: renderWeek },
  forge: { title: "Forge", render: renderForge },
  data: { title: "Data", render: renderData },
  chat: { title: "Coach", render: renderChat },
  session: { title: "Séance", render: renderSession },
  "write-note": { title: "Nouvelle note", render: renderWriteNote },
  "adjust-week": { title: "Ajuster ma semaine", render: renderAdjustWeek },
};

/** `params.date` (ISO) targets the "session" view at an arbitrary date —
 * set from the Aujourd'hui quick action (today), a day-strip/Forge/
 * Historique tile. renderSession overwrites the topbar title itself once
 * it knows the date, so the generic title below is just the instant
 * placeholder while it loads. */
function showView(name, params = {}) {
  renderToken += 1;
  const token = renderToken;
  state.view = name;
  if (params.date) state.sessionDate = params.date;
  document.getElementById("topbar-title").textContent = views[name].title;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  const content = document.getElementById("content");
  content.innerHTML = "";
  const tplId = "tpl-" + name;
  const tpl = document.getElementById(tplId);
  if (tpl) content.appendChild(tpl.content.cloneNode(true));
  views[name].render(token).catch((err) => {
    if (stale(token)) return; // navigated on already — don't inject a stray error into whatever's showing now
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
// Credo — a short motto shown big at the top of Aujourd'hui. Fixed, real,
// sourced quotes (not user-editable — see conversation) picked for the
// rugby/return-from-injury/discipline theme, rotating one per day so it
// stays a little alive without any moving parts. Kept short deliberately:
// popular "inspirational quotes" are frequently misattributed online, so
// this list only has ones with a real, checkable source.
// ============================================================================
const CREDO_QUOTES = [
  {
    text: "Le sport a le pouvoir de changer le monde. Il a le pouvoir d'inspirer. Il a le pouvoir de rassembler les gens comme peu de choses le peuvent.",
    author: "Nelson Mandela",
    source: "discours aux Laureus World Sports Awards, 2000",
  },
  {
    text: "Ce n'est pas d'être terrassé qui compte, c'est de se relever.",
    author: "Vince Lombardi",
  },
  {
    text: "Ce n'est pas parce que les choses sont difficiles que nous n'osons pas ; c'est parce que nous n'osons pas qu'elles sont difficiles.",
    author: "Sénèque",
    source: "Lettres à Lucilius",
  },
  {
    text: "La discipline est le pont entre les objectifs et leur accomplissement.",
    author: "Jim Rohn",
  },
];

function dayOfYear(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
}

function credoOfTheDay() {
  return CREDO_QUOTES[dayOfYear(todayISO()) % CREDO_QUOTES.length];
}

function setupCredo() {
  const textEl = document.getElementById("credo-text");
  const sourceEl = document.getElementById("credo-source");
  if (!textEl) return;
  const q = credoOfTheDay();
  textEl.textContent = q.text;
  if (sourceEl) sourceEl.textContent = `— ${q.author}${q.source ? ` (${q.source})` : ""}`;
}

/** Triggers a GitHub Actions workflow_dispatch — used by the "Nouveau
 * digest" button so a fresh digest can be regenerated on demand instead of
 * only waiting for the 8h30 cron. Needs the token to also carry an
 * Actions: Read and write permission (Contents alone isn't enough for
 * this one call) — see docs/app-deploy.md and docs/adr/0018. */
async function ghDispatchWorkflow(fileName, ref = "main") {
  const res = await fetch(`${API}/repos/${REPO}/actions/workflows/${fileName}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref }),
  });
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) {
      throw new Error("Le token n'a pas la permission Actions — voir docs/app-deploy.md.");
    }
    throw new Error(`GitHub ${res.status} en déclenchant ${fileName}`);
  }
}

/** Shared "🎯 Objectifs du bloc en cours" collapsible reference, used both
 * in the session view (musculation planning) and in Forge — condensed
 * block overview only (see splitBlockMarkdown), loaded once per toggle. */
function bindBlockReferenceToggle(toggleEl, boxEl) {
  if (!toggleEl || !boxEl) return;
  toggleEl.addEventListener("click", async () => {
    boxEl.hidden = !boxEl.hidden;
    if (boxEl.hidden || boxEl.dataset.loaded) return;
    boxEl.innerHTML = skeletonHTML();
    const blockLabel = await currentBlockLabel();
    const blockFile = blockLabel ? await ghGetFile(`data/blocks/${blockLabel}.md`) : null;
    boxEl.innerHTML = blockFile
      ? renderMarkdown(splitBlockMarkdown(blockFile.content).overview)
      : "<p class='muted small'>Pas de bloc en cours.</p>";
    boxEl.dataset.loaded = "1";
  });
}

// ============================================================================
// Views
// ============================================================================
async function renderToday(token) {
  setupCredo();

  document.getElementById("adjust-week-cta").addEventListener("click", () => showView("adjust-week"));

  document.querySelectorAll("#today-quick-actions [data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      showView(action, action === "session" ? { date: todayISO() } : {});
    });
  });

  const genBtn = document.getElementById("generate-digest-button");
  const genStatus = document.getElementById("generate-digest-status");
  genBtn.addEventListener("click", async () => {
    genBtn.disabled = true;
    genStatus.textContent = "Déclenchement…";
    try {
      await ghDispatchWorkflow("daily-digest.yml");
      genStatus.textContent = "Lancé ✓ — nouveau digest dans quelques minutes, puis ⟳ pour le récupérer.";
    } catch (err) {
      genStatus.textContent = `Échec : ${err.message}`;
    } finally {
      genBtn.disabled = false;
    }
  });

  document.getElementById("today-digest-content").innerHTML = skeletonHTML();
  const digest = await latestFileOnOrBefore("data/digests", ".md", todayISO());
  if (stale(token)) return;
  document.getElementById("today-digest-date").textContent = digest ? `Digest du ${digest.date}` : "Digest";
  document.getElementById("today-digest-content").innerHTML = digest
    ? renderDigestSections(digest.content)
    : "<p class='muted'>Pas encore de digest généré.</p>";
}

async function listPlans() {
  const entries = (await ghListDir("data/plans")).filter((e) => e.type === "file" && e.name.endsWith(".md"));
  return entries.map((e) => ({ date: e.name.slice(0, -3), path: e.path })).sort((a, b) => b.date.localeCompare(a.date));
}

// ---- Semaine : Planning (+ proposition en attente), Bloc, Séances, Historique ----
async function renderWeek(token) {
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

  document.getElementById("week-overview").innerHTML = skeletonHTML();
  document.getElementById("week-planning-content").innerHTML = skeletonHTML();
  document.getElementById("pending-proposal").innerHTML = "";
  const plan = await latestFileOnOrBefore("data/plans", ".md", todayISO());
  if (stale(token)) return;

  let planDays = [];
  if (plan) {
    renderWeekOverview(document.getElementById("week-overview"), plan.content, todayISO(), plan.date);
    document.getElementById("week-planning-content").innerHTML = renderMarkdown(plan.content);
    planDays = parseWeekOverview(plan.content).days;
  } else {
    document.getElementById("week-overview").innerHTML = "";
    document.getElementById("week-planning-content").innerHTML = "<p class='muted'>Pas de planning disponible.</p>";
  }
  loadPendingProposal(token).catch(() => {});
  renderWeekSessionsTable(token, plan ? plan.date : null, planDays).catch(() => {});

  const blockContentEl = blockPanel.querySelector(".markdown-body");
  blockContentEl.innerHTML = skeletonHTML();
  const blockLabel = await currentBlockLabel();
  if (stale(token)) return;
  if (blockLabel) {
    const blockFile = await ghGetFile(`data/blocks/${blockLabel}.md`);
    if (stale(token)) return;
    blockContentEl.innerHTML = blockFile
      ? renderMarkdown(splitBlockMarkdown(blockFile.content).overview)
      : "<p class='muted'>Pas de fichier de bloc.</p>";
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
  const founds = await Promise.all(dates.map((d) => findSessionForDate(d)));
  if (stale(token)) return;

  const today = todayISO();
  const rows = dates
    .map((date, i) => {
      const planDay = planDays.find((d) => DAY_NAMES.indexOf(d.day) === i);
      const plannedLabel = planDay ? planDay.title : "—";
      const session = founds[i].session;
      const hasExecuted = !!session && (
        (session.type && session.type !== "musculation" && session.notes) ||
        (session.exercises || []).some((ex) => ex.executed && (ex.executed.sets || ex.executed.reps || ex.executed.load))
      );
      let status;
      if (hasExecuted) status = "✅ Fait";
      else if (date > today) status = session ? "📝 Planifié" : "⏳ À venir";
      else if (session) status = "📝 Planifié";
      else status = "— Non loggé";
      return `
        <tr class="week-table-row" data-date="${date}">
          <td>${DAY_NAMES[i].slice(0, 3)} ${date.slice(8, 10)}/${date.slice(5, 7)}</td>
          <td>${escapeHtmlText(plannedLabel)}</td>
          <td>${status}</td>
        </tr>`;
    })
    .join("");

  el.innerHTML = `
    <table class="week-sessions-table">
      <thead><tr><th>Jour</th><th>Prévu</th><th>Statut</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  el.querySelectorAll(".week-table-row").forEach((tr) => {
    tr.addEventListener("click", () => showView("session", { date: tr.dataset.date }));
  });
}

/** A plan adjustment requested from the app (chat or "Ajuster ma semaine")
 * is never applied directly by the coach — it's written to
 * data/plans/pending/<lundi>.md and shown here for an explicit
 * Valider/Refuser, per prompts/weekly-plan.md's app-triggered branch and
 * docs/adr/0018/0019. Only the oldest pending file is shown at a time
 * (there should never realistically be more than one). */
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
      renderWeek(renderToken);
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

async function loadPlanHistory(token) {
  await Promise.all([loadPlanHistoryList(token), loadSessionHistoryList(token)]);
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

async function loadSessionHistoryList(token, limit = 10) {
  const container = document.getElementById("history-sessions-list");
  if (container.dataset.loaded && +container.dataset.limit >= limit) return;
  container.innerHTML = skeletonHTML();
  const sessions = await listAllSessions();
  if (stale(token)) return;
  const shown = sessions.slice(0, limit);
  if (shown.length === 0) { container.innerHTML = "<p class='muted small'>Pas encore de séance loguée.</p>"; return; }
  container.innerHTML = shown
    .map((s) => `
      <button class="history-item" data-date="${s.date}">
        <div class="history-date">${formatFrDate(s.date)}</div>
        <div class="history-sub">${escapeHtmlText(s.name || "Séance")}</div>
      </button>`)
    .join("");
  if (sessions.length > shown.length) {
    container.insertAdjacentHTML("beforeend", `<button class="details-toggle" id="sessions-see-more">Voir plus (${sessions.length - shown.length})</button>`);
    document.getElementById("sessions-see-more").addEventListener("click", () => {
      container.dataset.loaded = "";
      loadSessionHistoryList(renderToken, limit + 15);
    });
  }
  container.dataset.loaded = "1";
  container.dataset.limit = String(limit);
  container.querySelectorAll(".history-item[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => showView("session", { date: btn.dataset.date }));
  });
}

// ---- Forge : planifier une semaine (n'importe laquelle) séance par séance ----
async function renderForge(token) {
  if (!state.forgeMonday) state.forgeMonday = addDaysISO(mondayOfWeek(todayISO()), 7);

  document.getElementById("forge-prev-week").addEventListener("click", () => {
    state.forgeMonday = addDaysISO(state.forgeMonday, -7);
    renderForgeContent(renderToken).catch(() => {});
  });
  document.getElementById("forge-next-week").addEventListener("click", () => {
    state.forgeMonday = addDaysISO(state.forgeMonday, 7);
    renderForgeContent(renderToken).catch(() => {});
  });
  bindBlockReferenceToggle(document.getElementById("forge-block-toggle"), document.getElementById("forge-block-content"));

  await renderForgeContent(token);
}

async function renderForgeContent(token) {
  const monday = state.forgeMonday;
  document.getElementById("forge-week-label").textContent = `Semaine du ${formatFrDate(monday)}`;
  document.getElementById("forge-days").innerHTML = skeletonHTML();

  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
  const founds = await Promise.all(dates.map((d) => findSessionForDate(d)));
  if (stale(token)) return;

  document.getElementById("forge-days").innerHTML = dates
    .map((date, i) => {
      const session = founds[i].session;
      const type = session ? session.type || "musculation" : null;
      const label = session ? `${SESSION_TYPES[type] ? SESSION_TYPES[type].icon : "🏋️"} ${session.name || "Séance"}` : "Aucune séance planifiée";
      return `
        <button type="button" class="forge-day-tile" data-date="${date}">
          <div class="forge-day-name">${DAY_NAMES[i]} ${date.slice(8, 10)}/${date.slice(5, 7)}</div>
          <div class="forge-day-session">${escapeHtmlText(label)}</div>
        </button>`;
    })
    .join("");
  document.getElementById("forge-days").querySelectorAll(".forge-day-tile").forEach((btn) => {
    btn.addEventListener("click", () => showView("session", { date: btn.dataset.date }));
  });
}

// ---- Data (trajectoire, sommeil, poids, charge aiguë:chronique) ----
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

/** Minimal inline-SVG line sparkline — no charting dependency. `points`:
 * [{date, value}] ascending. Uses the app's own CSS custom properties so
 * it matches the rest of the palette automatically, light or dark. */
function sparklineSVG(points) {
  const w = 280, h = 60, pad = 6;
  if (points.length < 2) return "";
  const values = points.map((p) => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => [
    pad + i * stepX,
    pad + (h - pad * 2) * (1 - (p.value - min) / range),
  ]);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="sparkline" preserveAspectRatio="none">
      <path d="${path}" fill="none" stroke="var(--green-light)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--gold)"/>
    </svg>`;
}

const WORKLOAD_ZONE_LABELS = {
  sous_charge: "Sous-charge",
  zone_optimale: "Zone optimale",
  zone_prudente: "Zone prudente",
  risque_eleve: "Risque élevé",
};

async function renderData(token) {
  const el = document.getElementById("data-content");
  el.innerHTML = skeletonHTML();
  const file = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  if (!file) { el.innerHTML = "<p class='muted'>Pas encore de résumé exporté.</p>"; return; }
  const s = JSON.parse(file.content);
  let html = "";

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
  if (tiles) html += `<section class="card"><h2>🏆 Trajectoire de force</h2><div class="stat-grid">${tiles}</div></section>`;

  const bw = s.bodyweight_recent && s.bodyweight_recent.history;
  if (bw && bw.length > 1) {
    const first = bw[0].weight_kg, last = bw[bw.length - 1].weight_kg;
    const delta = last - first;
    const days = Math.max(1, (new Date(bw[bw.length - 1].date) - new Date(bw[0].date)) / 86400000);
    const perWeek = (delta / days) * 7;
    html += `
      <section class="card">
        <h2>⚖️ Poids de corps (${bw.length} derniers points)</h2>
        ${sparklineSVG(bw.map((h) => ({ date: h.date, value: h.weight_kg })))}
        <p class="trend-line">${last.toFixed(1)} kg
          <span class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)} kg</span>
          sur la période <span class="muted small">(~${perWeek >= 0 ? "+" : ""}${perWeek.toFixed(2)} kg/semaine)</span>
        </p>
      </section>`;
  } else if (bw && bw.length === 1) {
    html += `<section class="card"><h2>⚖️ Poids de corps</h2><p class="trend-line">${bw[0].weight_kg.toFixed(1)} kg</p></section>`;
  }

  if (s.sleep_recent) {
    const sr = s.sleep_recent;
    const hist = sr.history || [];
    const delta = sr.avg_7d != null && sr.avg_prior_7d != null ? sr.avg_7d - sr.avg_prior_7d : null;
    html += `
      <section class="card">
        <h2>😴 Sommeil</h2>
        ${hist.length > 1 ? sparklineSVG(hist.map((h) => ({ date: h.date, value: h.hours }))) : ""}
        <p class="trend-line">
          ${sr.avg_7d != null ? `${sr.avg_7d.toFixed(1)} h/nuit <span class="muted small">(moy. 7j)</span>` : "Pas assez de données"}
          ${delta != null ? `<span class="${delta >= 0 ? "trend-up" : "trend-down"} small">${delta >= 0 ? "+" : ""}${delta.toFixed(1)} h vs semaine précédente</span>` : ""}
        </p>
      </section>`;
  }

  if (s.workload) {
    const w = s.workload;
    html += `
      <section class="card">
        <h2>⚙️ Charge aiguë:chronique</h2>
        <p class="workload-badge zone-${w.zone}">${WORKLOAD_ZONE_LABELS[w.zone] || w.zone}</p>
        <p class="muted small">Ratio ${w.ratio.toFixed(2)} — charge des 7 derniers jours vs moyenne des 4 dernières semaines (RPE × durée de séance).</p>
      </section>`;
  } else {
    html += `
      <section class="card">
        <h2>⚙️ Charge aiguë:chronique</h2>
        <p class="muted small">Pas encore assez d'historique de charge — renseigne le RPE et la durée à chaque séance loguée (voir Loguer la séance) : il faut environ 4 semaines de suivi régulier avant un premier calcul fiable.</p>
      </section>`;
  }

  if (s.upcoming_matches && s.upcoming_matches.length) {
    html += "<section class='card'><h2>🏆 Calendrier</h2><ul>";
    for (const m of s.upcoming_matches) {
      html += `<li>${m.date} — ${m.opponent} (${m.home_away}) ${m.user_is_playing ? "" : "· tu ne joues pas encore"}</li>`;
    }
    html += "</ul></section>";
  }

  el.innerHTML = html || "<p class='muted'>Pas encore de données.</p>";
}

// ---- Chat ----
let chatPollTimer = null;

/** Appends a user turn to the shared chat log — used by the Coach tab and
 * by "Ajuster ma semaine" (prompts/app-chat.md routes planning requests to
 * prompts/weekly-plan.md, which writes a proposal to data/plans/pending/
 * for the app to show — see loadPendingProposal — rather than applying it
 * directly, see docs/adr/0018). */
async function postUserMessage(text) {
  return ghPutJSON(
    "data/app-chat/conversation.json",
    [],
    "App : nouveau message utilisateur",
    (conv) => [...conv, { role: "user", text, at: localISOWithOffset() }]
  );
}

async function renderChat(token) {
  await refreshChatLog(token);
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

async function refreshChatLog(token) {
  const file = await ghGetFile("data/app-chat/conversation.json");
  if (token != null && stale(token)) return;
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

// ============================================================================
// Session detail : voir/loguer/planifier n'importe quelle date
// ============================================================================
// Reachable from Aujourd'hui ("Loguer la séance", aujourd'hui), un jour du
// day-strip Semaine, une case de Forge (n'importe quelle semaine), ou une
// entrée d'Historique. `sessionWorking` est la copie en mémoire éditée —
// rien n'est écrit sur GitHub avant "Enregistrer la séance". Trois types
// de séance (session.type) : musculation (exercices structurés,
// réordonnables, formats AMRAP/For Time/EMOM/superset/etc. — voir
// EXERCISE_FORMATS), rugby et autre (course, rando...) qui se résument à
// une simple description libre, volontairement peu contraignante — voir
// docs/adr/0018.
let sessionWorking = null;

const SESSION_TYPES = {
  musculation: { label: "Musculation", icon: "🏋️" },
  rugby: { label: "Rugby / Match", icon: "🏉" },
  autre: { label: "Autre (course, rando...)", icon: "🏃" },
};

const EXERCISE_FORMATS = {
  standard: "Standard",
  superset: "Superset (lié au précédent)",
  amrap: "AMRAP",
  for_time: "For Time",
  emom: "EMOM",
  circuit: "Circuit",
  other: "Autre format",
};

function blankExercise() {
  return {
    name: "Nouvel exercice",
    format: "standard",
    planned: { sets: null, reps: null, load: null },
    executed: { sets: null, reps: null, load: null },
    rir: null,
    notes: null,
    superset_with_previous: false,
  };
}

function blankSession(date, type) {
  return {
    name: SESSION_TYPES[type].label,
    date,
    type,
    exercises: type === "musculation" ? [blankExercise()] : [],
    notes: "",
    session_rpe: null,
    session_duration_min: null,
    distance_km: type === "autre" ? null : undefined,
  };
}

async function renderSession(token) {
  const date = state.sessionDate || todayISO();
  document.getElementById("topbar-title").textContent = `Séance — ${formatFrDate(date)}`;
  document.getElementById("session-content").innerHTML = skeletonHTML();

  const found = await findSessionForDate(date);
  if (stale(token)) return;
  sessionWorking = {
    weekLabel: found.weekLabel || "app",
    date,
    session: found.session ? JSON.parse(JSON.stringify(found.session)) : null,
  };
  renderSessionContent();
}

function renderSessionContent() {
  const el = document.getElementById("session-content");
  const { session, date } = sessionWorking;

  if (!session) {
    el.innerHTML = `
      <section class="card">
        <p class="muted">Pas de séance enregistrée pour le ${formatFrDate(date)}.</p>
        <p class="muted small">Quel type de séance ?</p>
        <div class="type-picker">
          ${Object.entries(SESSION_TYPES)
            .map(([key, t]) => `<button type="button" class="action-button" data-type="${key}"><span class="action-icon">${t.icon}</span>${t.label}</button>`)
            .join("")}
        </div>
      </section>`;
    el.querySelectorAll(".type-picker [data-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        sessionWorking.session = blankSession(date, btn.dataset.type);
        renderSessionContent();
      });
    });
    return;
  }

  const type = session.type || "musculation";
  el.innerHTML = `
    <section class="card">
      <div class="session-type-badge">${SESSION_TYPES[type] ? SESSION_TYPES[type].icon : ""} ${SESSION_TYPES[type] ? SESSION_TYPES[type].label : type}</div>
      <label>Nom de la séance</label>
      <input id="session-name-input" value="${escapeAttr(session.name || "Séance")}">
    </section>
    ${type === "musculation" ? musculationBodyHTML(session) : ""}
    <section class="card">
      <label>${notesLabelFor(type)}</label>
      <textarea id="session-notes" rows="${type === "musculation" ? 3 : 5}" placeholder="${escapeAttr(notesPlaceholderFor(type))}">${escapeHtmlText(session.notes || "")}</textarea>
      ${type === "autre" ? `<label>Distance (km, facultatif)</label><input type="text" id="session-distance" value="${escapeAttr(session.distance_km ?? "")}">` : ""}
    </section>
    ${workloadSectionHTML(session)}
    <button id="save-session" class="primary-button">Enregistrer la séance</button>
    <p id="session-status" class="muted small"></p>`;

  bindSessionContentEvents();
}

function notesLabelFor(type) {
  if (type === "rugby") return "Comment ça s'est passé ? (facultatif)";
  if (type === "autre") return "Description (facultatif)";
  return "📝 Note de séance (facultatif — ex. \"volume réduit, épaule un peu sensible\")";
}
function notesPlaceholderFor(type) {
  if (type === "rugby") return "Ressenti, intensité, contact, fatigue...";
  if (type === "autre") return "Où, combien de temps, ressenti...";
  return "";
}

function musculationBodyHTML(session) {
  const exercises = session.exercises || [];
  return `
    <section class="card">
      <button type="button" id="toggle-block-ref" class="details-toggle">🎯 Objectifs du bloc en cours</button>
      <div id="block-ref-content" class="markdown-body small" hidden></div>
    </section>
    <section class="card">
      <button type="button" id="prefill-button" class="primary-button ghost small">🔁 Dupliquer une séance récente</button>
      <div id="prefill-picker" hidden></div>
    </section>
    <div id="exercise-list">${exercises.map((ex, idx) => exerciseCardHTML(ex, idx, exercises.length)).join("")}</div>
    <button type="button" id="add-exercise" class="primary-button ghost small" style="margin-bottom:14px">+ Ajouter un exercice</button>`;
}

function exerciseCardHTML(ex, idx, total) {
  const format = ex.format || "standard";
  const isFreeform = !["standard", "superset"].includes(format);
  const planned = ex.planned || {};
  const executed = ex.executed || {};
  return `
    <div class="exercise-log-card" data-idx="${idx}">
      <div class="exercise-log-head">
        <input type="text" class="f-name" value="${escapeAttr(ex.name || "")}">
        <div class="reorder-buttons">
          <button type="button" class="icon-button small move-up" ${idx === 0 ? "disabled" : ""} title="Monter" aria-label="Monter">▲</button>
          <button type="button" class="icon-button small move-down" ${idx === total - 1 ? "disabled" : ""} title="Descendre" aria-label="Descendre">▼</button>
          <button type="button" class="icon-button small danger remove-exercise" title="Retirer" aria-label="Retirer">✕</button>
        </div>
      </div>
      <select class="f-format">
        ${Object.entries(EXERCISE_FORMATS).map(([key, label]) => `<option value="${key}"${format === key ? " selected" : ""}>${label}</option>`).join("")}
      </select>
      ${isFreeform
        ? `<textarea class="f-format-detail" rows="2" placeholder="Détail du format (ex. 15min : 10 burpees, 15 swings, 20 squats)">${escapeHtmlText(ex.notes || "")}</textarea>`
        : `
        <div class="field-row-label">Prévu</div>
        <div class="exercise-log-grid">
          <div><label>Séries</label><input type="text" class="f-planned-sets" value="${escapeAttr(planned.sets ?? "")}"></div>
          <div><label>Reps/temps</label><input type="text" class="f-planned-reps" value="${escapeAttr(planned.reps ?? "")}"></div>
          <div><label>Charge</label><input type="text" class="f-planned-load" value="${escapeAttr(planned.load ?? "")}"></div>
        </div>
        <div class="field-row-label">Fait</div>
        <div class="exercise-log-grid">
          <div><label>Séries</label><input type="text" class="f-sets" value="${escapeAttr(executed.sets ?? "")}"></div>
          <div><label>Reps/temps</label><input type="text" class="f-reps" value="${escapeAttr(executed.reps ?? "")}"></div>
          <div><label>Charge</label><input type="text" class="f-load" value="${escapeAttr(executed.load ?? "")}"></div>
          <div><label>RIR</label><input type="text" class="f-rir" value="${escapeAttr(ex.rir ?? "")}"></div>
        </div>`
      }
    </div>`;
}

function workloadSectionHTML(session) {
  return `
    <section class="card">
      <h2>⚙️ Charge de la séance (optionnel)</h2>
      <p class="muted small">Alimente le calcul de charge aiguë:chronique (RPE × durée, méthode de Foster) — voir l'onglet Data.</p>
      <div class="exercise-log-grid">
        <div><label>RPE (0-10)</label><input type="number" min="0" max="10" step="1" id="session-rpe" value="${session.session_rpe ?? ""}"></div>
        <div><label>Durée (min)</label><input type="number" min="0" step="5" id="session-duration" value="${session.session_duration_min ?? ""}"></div>
      </div>
      <p class="muted small">0 = repos total, 5 = soutenu, 10 = effort maximal.</p>
    </section>`;
}

/** Reads whatever's currently typed back into `sessionWorking.session` —
 * called before any structural change (reorder/add/remove/format switch)
 * so in-progress edits survive the re-render, and before the final save. */
function syncFormIntoSession() {
  const session = sessionWorking.session;

  const nameInput = document.getElementById("session-name-input");
  if (nameInput) session.name = nameInput.value.trim() || "Séance";

  const notesInput = document.getElementById("session-notes");
  if (notesInput) session.notes = notesInput.value.trim() || null;

  const distanceInput = document.getElementById("session-distance");
  if (distanceInput) session.distance_km = distanceInput.value !== "" ? Number(distanceInput.value) : null;

  const rpeInput = document.getElementById("session-rpe");
  if (rpeInput) session.session_rpe = rpeInput.value !== "" ? Number(rpeInput.value) : null;
  const durationInput = document.getElementById("session-duration");
  if (durationInput) session.session_duration_min = durationInput.value !== "" ? Number(durationInput.value) : null;

  document.querySelectorAll("#exercise-list .exercise-log-card").forEach((card) => {
    const idx = +card.dataset.idx;
    const ex = session.exercises[idx];
    if (!ex) return;
    ex.name = card.querySelector(".f-name").value.trim() || ex.name;
    ex.format = card.querySelector(".f-format").value;
    ex.superset_with_previous = ex.format === "superset";

    const detailEl = card.querySelector(".f-format-detail");
    if (detailEl) {
      ex.notes = detailEl.value.trim() || null;
    } else {
      const plannedSets = card.querySelector(".f-planned-sets");
      if (plannedSets) {
        ex.planned = {
          sets: plannedSets.value || null,
          reps: card.querySelector(".f-planned-reps").value || null,
          load: card.querySelector(".f-planned-load").value || null,
        };
      }
      const sets = card.querySelector(".f-sets");
      if (sets) {
        ex.executed = {
          sets: sets.value || null,
          reps: card.querySelector(".f-reps").value || null,
          load: card.querySelector(".f-load").value || null,
        };
        ex.rir = card.querySelector(".f-rir").value || null;
      }
    }
  });
}

function bindSessionContentEvents() {
  document.querySelectorAll(".f-format").forEach((sel) => sel.addEventListener("change", () => {
    syncFormIntoSession();
    renderSessionContent();
  }));

  const addBtn = document.getElementById("add-exercise");
  if (addBtn) addBtn.addEventListener("click", () => {
    syncFormIntoSession();
    sessionWorking.session.exercises.push(blankExercise());
    renderSessionContent();
  });

  document.querySelectorAll(".move-up").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-log-card").dataset.idx;
    const arr = sessionWorking.session.exercises;
    [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
    renderSessionContent();
  }));
  document.querySelectorAll(".move-down").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-log-card").dataset.idx;
    const arr = sessionWorking.session.exercises;
    [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
    renderSessionContent();
  }));
  document.querySelectorAll(".remove-exercise").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-log-card").dataset.idx;
    sessionWorking.session.exercises.splice(idx, 1);
    renderSessionContent();
  }));

  bindBlockReferenceToggle(document.getElementById("toggle-block-ref"), document.getElementById("block-ref-content"));

  const prefillBtn = document.getElementById("prefill-button");
  if (prefillBtn) prefillBtn.addEventListener("click", async () => {
    const box = document.getElementById("prefill-picker");
    box.hidden = !box.hidden;
    if (box.hidden || box.dataset.loaded) return;
    box.innerHTML = skeletonHTML();
    const sessions = (await listAllSessions()).filter((s) => s.date < sessionWorking.date).slice(0, 8);
    box.innerHTML = sessions.length
      ? sessions.map((s) => `<button type="button" class="history-item" data-date="${s.date}"><div class="history-date">${formatFrDate(s.date)}</div><div class="history-sub">${escapeHtmlText(s.name || "Séance")}</div></button>`).join("")
      : "<p class='muted small'>Pas de séance récente à dupliquer.</p>";
    box.dataset.loaded = "1";
    box.querySelectorAll(".history-item").forEach((btn) => btn.addEventListener("click", async () => {
      const found = await findSessionForDate(btn.dataset.date);
      if (!found.session || !found.session.exercises || !found.session.exercises.length) return;
      const cloned = JSON.parse(JSON.stringify(found.session.exercises));
      cloned.forEach((ex) => { ex.executed = { sets: null, reps: null, load: null }; ex.rir = null; });
      sessionWorking.session.exercises = cloned;
      box.hidden = true;
      renderSessionContent();
    }));
  });

  document.getElementById("save-session").addEventListener("click", async (e) => {
    syncFormIntoSession();
    const btn = e.currentTarget;
    const statusEl = document.getElementById("session-status");
    btn.disabled = true;
    statusEl.textContent = "Enregistrement…";
    try {
      await saveSession(sessionWorking.weekLabel, sessionWorking.date, sessionWorking.session);
      statusEl.textContent = "Enregistré ✓";
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

/** Overwrites the whole session for `date` in data/training/app-log/<date>.json
 * — replaces the old per-exercise overlay (a partial merge could never
 * represent a reordered or resized exercise list coherently). Schema
 * matches coach.sheets_parse.parse_week exactly so every existing reader
 * (trajectory, progression, compliance, blocks) picks it up unchanged —
 * see docs/adr/0017 and docs/adr/0018.
 *
 * Also write-through merges session_rpe/session_duration_min into
 * data/health/<date>.json when present — that's the file coach.workload
 * actually reads (Foster's session-RPE method, see docs/adr/0011) — the
 * copy kept on the session itself is just for the app's own display, this
 * file is the real source of truth for the ACWR calculation. */
async function saveSession(weekLabel, date, session) {
  const path = `data/training/app-log/${date}.json`;
  await ghPutJSON(path, null, `App : séance du ${date}`, (current) => {
    const base = current || { week_label: weekLabel, objective: null, bodyweight: {}, sessions: [] };
    const nextSession = { ...session, date };
    const idx = base.sessions.findIndex((s) => s.date === date);
    if (idx === -1) base.sessions.push(nextSession);
    else base.sessions[idx] = nextSession;
    return base;
  });

  if (session.session_rpe != null || session.session_duration_min != null) {
    await ghPutJSON(`data/health/${date}.json`, { date }, `App : charge de séance ${date}`, (current) => {
      const base = current || { date };
      if (session.session_rpe != null) base.session_rpe = session.session_rpe;
      if (session.session_duration_min != null) base.session_duration_min = session.session_duration_min;
      return base;
    });
  }
}

// ---- Notes ----
async function renderWriteNote(token) {
  setupMicButton(
    document.getElementById("note-mic"),
    document.getElementById("note-voice-hint"),
    document.getElementById("note-text"),
    document.getElementById("note-live-caption")
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
      loadRecentNotes(renderToken);
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    }
  });
  await loadRecentNotes(token);
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
    document.getElementById("adjust-text"),
    document.getElementById("adjust-live-caption")
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
      ok.textContent = "Envoyé ✓ — le coach prépare une proposition (quelques minutes), à valider ensuite dans Semaine → Planning. ";
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

async function loadRecentNotes(token, limit = 5) {
  const container = document.getElementById("recent-notes");
  container.innerHTML = skeletonHTML();
  const entries = (await ghListDir("data/notes")).filter((e) => e.type === "file" && e.name.endsWith(".md"));
  if (token != null && stale(token)) return;
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const recent = entries.slice(0, limit);
  if (recent.length === 0) { container.innerHTML = "<p class='muted small'>Pas encore de note.</p>"; return; }
  const files = await Promise.all(recent.map((e) => ghGetFile(e.path)));
  if (token != null && stale(token)) return;
  container.innerHTML = files
    .map((f, i) => {
      if (!f) return "";
      const lines = f.content.split("\n");
      const date = recent[i].name.slice(0, 10);
      const body = lines.slice(1).join(" ").trim();
      return `<div class="note-item"><div class="note-date">${date}</div>${escapeHtmlText(body.slice(0, 200))}</div>`;
    })
    .join("");
  if (entries.length > recent.length) {
    container.insertAdjacentHTML("beforeend", `<button class="details-toggle" id="notes-see-more">Voir plus (${entries.length - recent.length})</button>`);
    document.getElementById("notes-see-more").addEventListener("click", () => loadRecentNotes(renderToken, limit + 15));
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
