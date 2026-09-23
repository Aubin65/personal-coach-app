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
 * clickable: they show that date's overview inline (see
 * showDayOverviewPanel) rather than jumping straight to the full session
 * editor — a tap is "let me see what's there", not necessarily "let me
 * edit it". */
/** Renders into two separate containers, `dayStripEl` and `highlightsEl`,
 * rather than one — `#day-overview-panel` (the table for whichever day was
 * tapped) sits between them in the DOM, so the selected day's detail
 * appears right under the day-strip and above "Objectifs clés de la
 * semaine", not buried below both ("au dessus des objectifs, pour que ce
 * soit plus ergonomique"). */
function renderWeekOverview(dayStripEl, highlightsEl, markdown, todayISOStr, mondayISO) {
  const { days, highlights } = parseWeekOverview(markdown);
  const [, tm, td] = todayISOStr.split("-");
  const todayDM = normalizeDM(`${parseInt(td, 10)}/${parseInt(tm, 10)}`);

  let stripHTML = "";
  if (days.length) {
    stripHTML += '<div class="day-strip">';
    for (const d of days) {
      const isToday = normalizeDM(d.date) === todayDM;
      const dayIdx = DAY_NAMES.indexOf(d.day);
      const iso = mondayISO && dayIdx !== -1 ? addDaysISO(mondayISO, dayIdx) : null;
      stripHTML += `
        <button type="button" class="day-card${isToday ? " is-today" : ""}"${iso ? ` data-date="${iso}"` : ""}>
          <div class="day-name">${d.day.slice(0, 3)}</div>
          <div class="day-date">${d.date}</div>
          <div class="day-icon">${dayIconFor(d.title)}</div>
          <div class="day-title">${d.title.slice(0, 28)}</div>
        </button>`;
    }
    stripHTML += "</div>";
  }
  dayStripEl.innerHTML = stripHTML;
  dayStripEl.querySelectorAll(".day-card[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      dayStripEl.querySelectorAll(".day-card").forEach((c) => c.classList.toggle("is-selected", c === btn));
      showDayOverviewPanel(renderToken, btn.dataset.date).catch(() => {});
    });
  });

  highlightsEl.innerHTML = highlights.length
    ? `<div class="highlights-card"><h2>🎯 Objectifs clés de la semaine</h2><ul>${highlights
        .map((h) => `<li>${h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</li>`)
        .join("")}</ul></div>`
    : "";
}

/** `{sets, reps, load}` (planned or executed) as one compact string, same
 * join convention as the accessory tags in renderData — "" when there's
 * nothing usable rather than a row of bare dashes. */
function formatSetsRepsLoad(obj) {
  if (!obj) return "";
  return [obj.sets, obj.reps, obj.load].filter((v) => v != null && v !== "").join(" × ");
}

/** Inline read-only overview for a day tapped in Planning's day-strip —
 * a table for musculation (one row per exercise, prévu/fait side by
 * side), the free-text description for rugby/autre/repos, and an
 * "✏️ Modifier la séance" button for whoever actually needs to change
 * something, instead of every tap jumping straight into edit mode. */
async function showDayOverviewPanel(token, date) {
  const el = document.getElementById("day-overview-panel");
  el.innerHTML = skeletonHTML();
  const found = await findSessionForDate(date);
  if (stale(token)) return;
  const session = found.session;

  const editButtonHTML = `<button type="button" id="day-overview-edit" class="primary-button ghost small" data-date="${date}">${session ? "✏️ Modifier la séance" : "+ Créer une séance"}</button>`;

  if (!session) {
    el.innerHTML = `
      <section class="card day-overview-card">
        <h2>${formatFrDate(date)}</h2>
        <p class="muted small">Aucune séance ce jour-là.</p>
        ${editButtonHTML}
      </section>`;
  } else {
    const type = session.type || "musculation";
    // A future date's "Fait" cells are never trustworthy — Sheets carries
    // planned values forward into the executed columns as a template for
    // a row not yet performed (the app's own sessionDayStatus already
    // treats a future date as never "Fait" for the same reason; this
    // table was reading ex.executed directly and missed that guard). Show
    // "—" there regardless of what the raw data says rather than a
    // session that hasn't happened yet looking already logged.
    const isFuture = date > todayISO();
    let body;
    if (type === "musculation" && (session.exercises || []).length) {
      const rows = session.exercises
        .map((ex) => {
          const format = ex.format || "standard";
          const nameCell = `${escapeHtmlText(ex.name || "")}${ex.superset_with_previous ? ' <span class="format-tag">🔗</span>' : ""}`;
          // A freeform format (AMRAP/EMOM/For Time/Circuit/Autre) has no
          // planned/executed sets×reps×load — its prescription lives in
          // `notes` instead (see exerciseCardHTML) — showing "—/—" for it
          // silently hid the actual content of the session.
          if (format !== "standard") {
            return `
              <tr>
                <td>${nameCell} <span class="format-tag">${escapeHtmlText(EXERCISE_FORMATS[format] || format)}</span></td>
                <td colspan="2">${escapeHtmlText(ex.notes || "") || "—"}</td>
              </tr>`;
          }
          return `
            <tr>
              <td>${nameCell}</td>
              <td>${escapeHtmlText(formatSetsRepsLoad(ex.planned)) || "—"}</td>
              <td>${isFuture ? "—" : escapeHtmlText(formatSetsRepsLoad(ex.executed)) || "—"}</td>
            </tr>`;
        })
        .join("");
      body = `
        <table class="day-overview-table">
          <thead><tr><th>Exercice</th><th>Prévu</th><th>Fait</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } else {
      body = `<p class="small">${session.notes ? escapeHtmlText(session.notes) : "<span class='muted'>Pas de note.</span>"}</p>`;
    }
    const workload = !isFuture && (session.session_rpe != null || session.session_duration_min != null)
      ? `<p class="muted small">${session.session_rpe != null ? `RPE ${session.session_rpe}` : ""}${session.session_rpe != null && session.session_duration_min != null ? " · " : ""}${session.session_duration_min != null ? `${session.session_duration_min} min` : ""}</p>`
      : "";
    el.innerHTML = `
      <section class="card day-overview-card">
        <h2>${SESSION_TYPES[type] ? SESSION_TYPES[type].icon : ""} ${escapeHtmlText(session.name || "Séance")} — ${formatFrDate(date)}</h2>
        ${body}
        ${workload}
        ${editButtonHTML}
      </section>`;
  }
  document.getElementById("day-overview-edit").addEventListener("click", () => showView("session", { date }));
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

/** Splits an already-condensed block overview (see splitBlockMarkdown)
 * further, for the Bloc tab specifically: the title + intro paragraph
 * (before the first "## " heading) is genuinely short and always shown;
 * everything else (Bilan, Objectifs chiffrés, Points de vigilance —
 * still useful, just not a one-glance "overview") collapses behind a
 * single toggle. The "🎯 Objectifs du bloc" reference shown while
 * planning/logging a session keeps the fuller `overview` as-is — more
 * detail is welcome there, it's already tucked behind its own toggle. */
function splitBlockIntro(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const firstHeadingIdx = lines.findIndex((l) => /^##\s+/.test(l));
  if (firstHeadingIdx === -1) return { intro: md, rest: "" };
  return { intro: lines.slice(0, firstHeadingIdx).join("\n"), rest: lines.slice(firstHeadingIdx).join("\n") };
}

/** The markdown under one `##`/`###`/... heading matching `headingRegex`,
 * up to (not including) the next heading of the same or shallower level —
 * null if no heading matches. */
function extractHeadingSection(md, headingRegex) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const startIdx = lines.findIndex((l) => headingRegex.test(l));
  if (startIdx === -1) return null;
  const level = lines[startIdx].match(/^(#+)/)[1].length;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

/** The "🎯 Objectifs du bloc" reference (Forge, session view) — just the
 * main physical-quality goals and the typical session structure, not the
 * full bilan/detailed numeric targets ("j'aimerais simplement les
 * objectifs principaux... et la structure type d'une séance"). Relies on
 * block-plan.md always producing these two exact headings; falls back to
 * the fuller `splitBlockMarkdown` overview for an older block written
 * before that convention, rather than showing nothing. */
function blockObjectivesSummary(md) {
  const goals = extractHeadingSection(md, /^##\s+Objectifs principaux du bloc/i);
  const structure = extractHeadingSection(md, /^##\s+Structure type d'une séance/i);
  return goals || structure ? [goals, structure].filter(Boolean).join("\n\n") : null;
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

/** true for a Saturday/Sunday ISO date. */
function isWeekendISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return dow === 0 || dow === 6;
}

/** Whether a session counts as actually done — a rugby/autre session
 * counts once it has a note, a musculation one once any exercise has a
 * real executed value. Mirrors coach.app_export._session_has_executed
 * (Python) exactly — kept in sync by hand on both sides, since the app
 * has no Python runtime of its own to share the logic with. */
function sessionHasExecuted(session) {
  if (!session) return false;
  // A rugby/autre/repos session counts as done once RPE and/or duration is
  // filled in (see workloadSectionHTML — the post-session "how did it go"
  // fields), never from `notes` alone: forge-skeleton.md deliberately
  // pre-fills notes with a pre-session vigilance point on a proposed rugby
  // day (e.g. "reprise du contact, prudence"), and a planning note like
  // that would otherwise mark a session "Fait" before it's even happened.
  if (session.type && session.type !== "musculation") {
    return session.session_rpe != null || session.session_duration_min != null;
  }
  return (session.exercises || []).some((ex) => ex.executed && (ex.executed.sets || ex.executed.reps || ex.executed.load));
}

/** True for "no session yet" AND for a quick-typed placeholder (Forge's
 * icon row — `blankSession`/`blankExercise`: a musculation day with a
 * single exercise still literally named "Nouvel exercice" and no real
 * planned/executed value, or a rugby/autre/repos day with no notes and no
 * workload logged) — the exact case the AI skeleton proposal is meant to
 * fill in on top of. Anything with real content (an exercise actually
 * renamed/filled in, a real note, an executed value) reads as false and
 * is never touched — same never-overwrite guarantee as before, just no
 * longer confusing "has a type set" with "has real content". Used both
 * to decide which days a bulk "Valider" actually applies to, and whether
 * a day's ✏️ edit should prefill the AI's proposal or the day's real,
 * already-there content. */
function sessionIsBlankSkeleton(session) {
  if (!session) return true;
  if (sessionHasExecuted(session)) return false;
  if (session.type === "musculation") {
    return (session.exercises || []).every((ex) => {
      const blankName = !ex.name || ex.name === "Nouvel exercice";
      const p = ex.planned;
      const blankPlanned = !p || (p.sets == null && p.reps == null && p.load == null);
      return blankName && blankPlanned;
    });
  }
  return !session.notes;
}

/** Status label for a day, shared by the Semaine "Séances" table, Forge
 * tiles and the Historique week browser — takes plain booleans rather
 * than a session object so it works equally from a full session
 * (`sessionHasExecuted(session)`) or from the lightweight precomputed
 * index (its own `has_executed` field), never requiring a full fetch just
 * to show a status. A date in the future can never be "Fait" — checked
 * first and short-circuits, whatever `hasExecuted` says — a spreadsheet
 * sync artifact (e.g. a template row carried over with last week's values
 * before being overwritten) could otherwise make an unplayed future day
 * look completed. */
function sessionDayStatus(date, hasSession, hasExecuted, today) {
  if (date > today) return hasSession ? "📝 Planifié" : "⏳ À venir";
  if (hasExecuted) return "✅ Fait";
  if (hasSession) return "📝 Planifié";
  return "— Non loggé";
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

// ============================================================================
// Training data index — two tiers, merged.
//
// 1. `summaryIndex`: coach.app_export precomputes `training_index` into
//    data/app/summary.json — date -> {name, type, week_label, path,
//    has_executed} for every Sheets-synced session. One small file to
//    fetch instead of scanning every week file (already 18+ a few weeks
//    into a season, and it only grows) — this was the actual reason
//    Historique/Forge felt slow. At most a day stale (refreshed with
//    every digest, same cadence Sheets itself syncs on), which is fine
//    for Sheets data that doesn't change more often than that anyway.
// 2. `appLogIndex`: data/training/app-log/ scanned live — a session just
//    logged from the app has to show up immediately, not only after the
//    next digest regenerates the precomputed index, so this side is never
//    precomputed. Wins over the summary index on a same-date collision.
//
// Listing views (Séances table, Forge tiles, Historique) only need this
// lightweight merged data (name/type/status) — see lookupDaySummary/
// listAllSessions. Only opening a specific day (renderSession) pays for
// one targeted extra fetch, of the exact file the index points to,
// instead of a scan. Invalidated (app-log side only) on every
// saveSession write so a just-saved session is never read back stale.
// ============================================================================
let summaryIndexCache = null;
let appLogIndexCache = null;

function invalidateAppLogIndex() {
  appLogIndexCache = null;
}

async function loadSummaryIndex() {
  if (summaryIndexCache) return summaryIndexCache;
  const index = new Map();
  const file = await ghGetFile("data/app/summary.json");
  if (file) {
    try {
      const summary = JSON.parse(file.content);
      for (const [date, hit] of Object.entries(summary.training_index || {})) index.set(date, hit);
    } catch (_) { /* malformed/missing summary — treat as empty, app-log still works */ }
  }
  summaryIndexCache = index;
  return index;
}

async function loadAppLogIndex() {
  if (appLogIndexCache) return appLogIndexCache;
  const top = await ghListDir("data/training");
  const appLogDir = top.find((e) => e.name === "app-log" && e.type === "dir");
  const entries = appLogDir ? (await ghListDir("data/training/app-log")).filter((e) => e.type === "file" && e.name.endsWith(".json")) : [];
  const files = await Promise.all(entries.map((e) => ghGetFile(e.path)));

  const index = new Map();
  files.forEach((file, i) => {
    if (!file) return;
    let week;
    try { week = JSON.parse(file.content); } catch (_) { return; }
    for (const s of week.sessions || []) index.set(s.date, { session: s, weekLabel: week.week_label, path: entries[i].path });
  });
  appLogIndexCache = index;
  return index;
}

/** Highest B<n> block label seen across data/training/ (top-level + app-log),
 * mirroring coach.blocks.current_block. */
async function currentBlockLabel() {
  const [appLogIndex, summaryIndex] = await Promise.all([loadAppLogIndex(), loadSummaryIndex()]);
  let best = null, bestN = -1;
  const consider = (label) => {
    const m = /^B(\d+)-S\d+$/.exec(label || "");
    if (m && +m[1] > bestN) { bestN = +m[1]; best = `B${m[1]}`; }
  };
  for (const hit of summaryIndex.values()) consider(hit.week_label);
  for (const entry of appLogIndex.values()) consider(entry.weekLabel);
  return best;
}

/** Lightweight {date, name, type, hasSession, hasExecuted} for a single
 * date — from the merged indexes only, no extra fetch. Used by list/table
 * views (Séances table, Forge tiles, Historique) that only need to show a
 * name and a status, not full exercise detail. */
async function lookupDaySummary(date) {
  const appLogIndex = await loadAppLogIndex();
  const appLogHit = appLogIndex.get(date);
  if (appLogHit) {
    const s = appLogHit.session;
    return { date, name: s.name, type: s.type, hasSession: true, hasExecuted: sessionHasExecuted(s) };
  }
  const summaryIndex = await loadSummaryIndex();
  const hit = summaryIndex.get(date);
  if (hit) return { date, name: hit.name, type: hit.type, hasSession: true, hasExecuted: !!hit.has_executed };
  return { date, name: null, type: null, hasSession: false, hasExecuted: false };
}

/** {weekLabel, path, session} with the FULL session for `date` — fetches
 * at most one extra file beyond the two indexes (the exact Sheets week
 * file the summary index points to), never a scan. `session: null` with a
 * best-guess weekLabel (most recent seen) when nothing is dated `date`
 * yet, for creating a brand-new session there. Used when actually opening
 * a day (renderSession, Forge's quick-set/skeleton, the prefill picker's
 * clone action) — listing views should use lookupDaySummary instead. */
async function findSessionForDate(date) {
  const appLogIndex = await loadAppLogIndex();
  const appLogHit = appLogIndex.get(date);
  if (appLogHit) return { weekLabel: appLogHit.weekLabel, path: appLogHit.path, session: appLogHit.session };

  const summaryIndex = await loadSummaryIndex();
  const hit = summaryIndex.get(date);
  if (!hit) {
    let lastLabel = null;
    for (const entry of appLogIndex.values()) if (entry.weekLabel) lastLabel = entry.weekLabel;
    for (const h of summaryIndex.values()) if (h.week_label) lastLabel = h.week_label;
    return { weekLabel: lastLabel, path: null, session: null };
  }

  const file = await ghGetFile(`data/${hit.path}`);
  if (!file) return { weekLabel: hit.week_label, path: null, session: null };
  let week;
  try { week = JSON.parse(file.content); } catch (_) { return { weekLabel: hit.week_label, path: null, session: null }; }
  const session = (week.sessions || []).find((s) => s.date === date) || null;
  return { weekLabel: hit.week_label, path: `data/${hit.path}`, session };
}

/** All known sessions (merged indexes, no extra fetch), newest first.
 * Powers the "dupliquer une séance récente" prefill picker — the picker
 * only needs name/date to list candidates; the actual clone, once one is
 * tapped, goes through findSessionForDate for full detail. */
async function listAllSessions() {
  const [appLogIndex, summaryIndex] = await Promise.all([loadAppLogIndex(), loadSummaryIndex()]);
  const byDate = new Map();
  for (const [date, hit] of summaryIndex) byDate.set(date, { date, name: hit.name, type: hit.type });
  for (const [date, entry] of appLogIndex) byDate.set(date, { date, name: entry.session.name, type: entry.session.type });
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// ============================================================================
// App state / navigation
// ============================================================================
const state = { view: "today", weekSubTab: "planning", sessionDate: null, forgeMonday: null, forgePrefillDraft: null };

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
  calendar: { title: "Matchs", render: renderCalendar },
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
  loadSyncStatus();
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
 * in the session view (musculation planning) and in Forge — just the main
 * goals + typical session structure (see blockObjectivesSummary), loaded
 * once per toggle. */
function bindBlockReferenceToggle(toggleEl, boxEl) {
  if (!toggleEl || !boxEl) return;
  toggleEl.addEventListener("click", async () => {
    boxEl.hidden = !boxEl.hidden;
    if (boxEl.hidden || boxEl.dataset.loaded) return;
    boxEl.innerHTML = skeletonHTML();
    const blockLabel = await currentBlockLabel();
    const blockFile = blockLabel ? await ghGetFile(`data/blocks/${blockLabel}.md`) : null;
    boxEl.innerHTML = blockFile
      ? renderMarkdown(blockObjectivesSummary(blockFile.content) || splitBlockMarkdown(blockFile.content).overview)
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

  if (!state.historyMonday) state.historyMonday = addDaysISO(mondayOfWeek(todayISO()), -7); // last week by default
  document.getElementById("history-prev-week").addEventListener("click", () => {
    state.historyMonday = addDaysISO(state.historyMonday, -7);
    renderSessionHistoryWeek(renderToken).catch(() => {});
  });
  document.getElementById("history-next-week").addEventListener("click", () => {
    state.historyMonday = addDaysISO(state.historyMonday, 7);
    renderSessionHistoryWeek(renderToken).catch(() => {});
  });
  document.getElementById("history-jump-date").addEventListener("change", (e) => {
    if (!e.target.value) return;
    state.historyMonday = mondayOfWeek(e.target.value);
    renderSessionHistoryWeek(renderToken).catch(() => {});
  });

  document.getElementById("week-day-strip").innerHTML = skeletonHTML();
  document.getElementById("week-highlights").innerHTML = "";
  document.getElementById("pending-proposal").innerHTML = "";
  document.getElementById("day-overview-panel").innerHTML = "";
  const plan = await latestFileOnOrBefore("data/plans", ".md", todayISO());
  if (stale(token)) return;

  let planDays = [];
  if (plan) {
    renderWeekOverview(
      document.getElementById("week-day-strip"),
      document.getElementById("week-highlights"),
      plan.content,
      todayISO(),
      plan.date
    );
    planDays = parseWeekOverview(plan.content).days;
  } else {
    document.getElementById("week-day-strip").innerHTML = "<p class='muted'>Pas de planning disponible.</p>";
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

// ---- Forge : planifier une semaine (n'importe laquelle) séance par séance ----

/** Fixed-format trigger text recognized by prompts/app-chat.md (the
 * "[Forge]" prefix) and routed to prompts/forge-skeleton.md — same async
 * request/poll pattern as "Ajuster ma semaine" (postUserMessage), but
 * asking for a structured week proposal instead of a chat answer. */
function forgeSkeletonRequestText(monday) {
  return `[Forge] Squelette IA pour la semaine du ${monday} : propose la meilleure structure (types de séance et exercices, jour par jour) en te basant sur l'historique d'entraînement, les objectifs de trajectoire et le bloc validé en cours — pas une copie de la semaine précédente.`;
}

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
    loadForgePendingSkeleton(renderToken).catch(() => {});
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
function forgeProposalDayToSession(date, d) {
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
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
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
      await renderForgeContent(renderToken);
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

/** `startValue` is where the ring's 0% actually is (the season baseline
 * it's progressing from — see bodyweight_progress.baseline_kg /
 * strength_trajectory[x].baseline_load) — without it a ring shows only
 * "how full", never "from where" or "how much of the objective, exactly"
 * ("je ne sais pas de quel point je pars"). `startDate` is when that
 * baseline was recorded (bodyweight_progress.baseline_date /
 * strength_trajectory[x].baseline_date — both anchored to the same
 * `_RETURN_TO_TRAINING_DATE` server-side) — shown alongside the value so
 * it's a specific, checkable point in time, not a bare number of
 * uncertain origin ("les points de départ ne sont pas cohérents"). */
function statTile(label, current, unit, fraction, help, startValue, startDate) {
  const valueText = current != null ? `${current}${unit}` : "—";
  const pct = fraction != null ? Math.round(fraction * 100) : null;
  return `
    <div class="stat-tile">
      <div class="stat-label">${label}</div>
      <div class="ring-wrap">
        ${ringSVG(fraction)}
        <div class="ring-value">${valueText}</div>
      </div>
      ${pct != null ? `<div class="stat-pct">${pct}% de l'objectif</div>` : ""}
      ${startValue != null ? `<div class="stat-start muted small">Départ ${startValue}${unit}${startDate ? ` (${shortDateFr(startDate)})` : ""}</div>` : ""}
      ${help ? `<div class="stat-help">${help}</div>` : ""}
    </div>`;
}

/** Ring tile for a recurring weekly sleep target (average or cumulative),
 * visually consistent with `statTile`'s trajectory rings — but no
 * `startValue`/`startDate`: a weekly goal resets every week, there's no
 * season baseline to progress from, only "how close to this week's
 * target" ("des indicateurs plus ergonomiques pour le sommeil moyen et
 * cumulé de la semaine" — replaces a plain text line with the same at-a-
 * glance ring language used everywhere else in Data). `valueText` is
 * preformatted (e.g. "7h15" via formatHoursFr) since these are hours, not
 * a bare number+unit like statTile's kg tiles. */
function sleepGoalTile(label, valueText, fraction, help) {
  const pct = fraction != null ? Math.round(fraction * 100) : null;
  return `
    <div class="stat-tile">
      <div class="stat-label">${label}</div>
      <div class="ring-wrap">
        ${ringSVG(fraction)}
        <div class="ring-value">${valueText}</div>
      </div>
      ${pct != null ? `<div class="stat-pct">${pct}% de l'objectif</div>` : ""}
      ${help ? `<div class="stat-help">${help}</div>` : ""}
    </div>`;
}

/** "dd/mm" from an ISO date — the short form used on chart axes. */
function shortDateFr(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Minimal inline-SVG line sparkline — no charting dependency. `points`:
 * [{date, value}] ascending. Uses the app's own CSS custom properties so
 * it matches the rest of the palette automatically, light or dark.
 * `opts.axis` adds min/max gridlines with their value, plus the first and
 * last point's date underneath — a bare line with no scale or dates
 * wasn't actually readable ("aucun axe, c'est peu exploitable"). */
function sparklineSVG(points, opts = {}) {
  const w = 280, h = 60, padRight = 6;
  const padTop = opts.axis ? 12 : 6;
  const padBottom = opts.axis ? 16 : 6;
  const padLeft = opts.axis ? 30 : 6;
  if (points.length < 2) return "";
  const values = points.map((p) => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;
  const stepX = plotW / (points.length - 1);
  const yFor = (v) => padTop + plotH * (1 - (v - min) / range);
  const coords = points.map((p, i) => [padLeft + i * stepX, yFor(p.value)]);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];
  const axis = opts.axis
    ? `
      <line x1="${padLeft}" y1="${padTop.toFixed(1)}" x2="${w - padRight}" y2="${padTop.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="${padLeft - 4}" y="${(padTop + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${max.toFixed(1)}</text>
      <line x1="${padLeft}" y1="${(padTop + plotH).toFixed(1)}" x2="${w - padRight}" y2="${(padTop + plotH).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="${padLeft - 4}" y="${(padTop + plotH + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${min.toFixed(1)}</text>
      <text x="${padLeft}" y="${h - 3}" text-anchor="start" font-size="9" fill="var(--muted)">${shortDateFr(points[0].date)}</text>
      <text x="${w - padRight}" y="${h - 3}" text-anchor="end" font-size="9" fill="var(--muted)">${shortDateFr(points[points.length - 1].date)}</text>`
    : "";
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="sparkline" preserveAspectRatio="none">
      ${axis}
      <path d="${path}" fill="none" stroke="var(--green-light)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--gold)"/>
    </svg>`;
}

/** French single-letter day-of-week initial (L/M/M/J/V/S/D) for an ISO
 * date — parsed as UTC like dayOfYear, so it's never off-by-one against
 * the local timezone. */
function dayInitial(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return ["D", "L", "M", "M", "J", "V", "S"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Bar chart — used for sleep (a night-by-night series reads better as
 * bars than as a connected line, which implies a continuous quantity).
 * `opts.reference` draws a dashed target line and colors bars below it
 * gold rather than green (e.g. the sleep guideline). `opts.dayLabels`
 * prints each bar's day-of-week initial underneath (`points[i].date`
 * required) — bare numbers with no axis were hard to place in the week
 * otherwise. */
function barChartSVG(points, opts = {}) {
  const w = 280, h = 70, pad = 6, gap = 3, labelH = 16;
  if (!points.length) return "";
  const totalH = h + (opts.dayLabels ? labelH : 0);
  const values = points.map((p) => p.value);
  const max = (opts.reference != null ? Math.max(...values, opts.reference) : Math.max(...values)) * 1.15;
  const slotW = (w - pad * 2) / points.length;
  const barW = Math.max(slotW - gap, 2);
  const yFor = (v) => pad + (h - pad * 2) * (1 - Math.min(v, max) / max);
  const bars = points
    .map((p, i) => {
      const x = pad + i * slotW;
      const y = yFor(p.value);
      const barH = Math.max(h - pad - y, 1);
      const below = opts.reference != null && p.value < opts.reference;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${below ? "var(--gold)" : "var(--green-light)"}"/>`;
    })
    .join("");
  const refLine = opts.reference != null
    ? `<line x1="${pad}" y1="${yFor(opts.reference).toFixed(1)}" x2="${w - pad}" y2="${yFor(opts.reference).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3,3"/>`
    : "";
  const labels = opts.dayLabels
    ? points
        .map((p, i) => {
          const cx = pad + i * slotW + barW / 2;
          return `<text x="${cx.toFixed(1)}" y="${h + labelH - 4}" text-anchor="middle" font-size="9" fill="var(--muted)">${dayInitial(p.date)}</text>`;
        })
        .join("")
    : "";
  return `
    <svg width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}" class="sparkline" preserveAspectRatio="none">
      ${refLine}
      ${bars}
      ${labels}
    </svg>`;
}

const SLEEP_TARGET_HOURS = 7.5;
/** "7h30" rather than "7.5h" — how sleep durations are normally written
 * in French. Only handles the half-hour case since that's all this app
 * ever needs (the fixed target, and hour values are shown as decimals
 * elsewhere). */
function formatHoursFr(hours) {
  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  return minutes ? `${wholeHours}h${String(minutes).padStart(2, "0")}` : `${wholeHours}h`;
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
    tiles += statTile("Poids de corps", bp.current_kg, " kg", bp.fraction, `Objectif ${bp.target_kg} kg`, bp.baseline_kg, bp.baseline_date);
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
      entry.target ? `Cible 4RM : ${entry.target.four_rm.toFixed(1)} kg` : "Pas de cible calculable",
      entry.baseline_load,
      entry.baseline_date
    );
  }
  if (tiles) html += `<section class="card"><h2>🏆 Trajectoire de force</h2><div class="stat-grid">${tiles}</div></section>`;

  const bw = (s.bodyweight_recent && s.bodyweight_recent.history) || []; // weekly averages, ~3 mois
  if (bw.length > 1) {
    const first = bw[0].weight_kg, last = bw[bw.length - 1].weight_kg;
    const delta = last - first;
    const weeks = Math.max(1, bw.length - 1);
    const perWeek = delta / weeks;
    html += `
      <section class="card">
        <h2>⚖️ Poids de corps (moyenne hebdomadaire, ~3 mois)</h2>
        ${sparklineSVG(bw.map((h) => ({ date: h.week_start, value: h.weight_kg })), { axis: true })}
        <p class="trend-line">${last.toFixed(1)} kg
          <span class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)} kg</span>
          sur la période <span class="muted small">(~${perWeek >= 0 ? "+" : ""}${perWeek.toFixed(2)} kg/semaine)</span>
        </p>
      </section>`;
  } else if (bw.length === 1) {
    html += `<section class="card"><h2>⚖️ Poids de corps</h2><p class="trend-line">${bw[0].weight_kg.toFixed(1)} kg</p></section>`;
  } else {
    html += `<section class="card"><h2>⚖️ Poids de corps</h2><p class="muted small">Pas encore assez de pesées récentes.</p></section>`;
  }

  const sr = s.sleep_recent || {};
  const sleepHist = sr.history || [];
  if (sr.avg_7d != null || sleepHist.length) {
    const delta = sr.avg_7d != null && sr.avg_prior_7d != null ? sr.avg_7d - sr.avg_prior_7d : null;
    html += `
      <section class="card">
        <h2>😴 Sommeil</h2>
        ${sleepHist.length ? barChartSVG(sleepHist.map((h) => ({ date: h.date, value: h.hours })), { reference: SLEEP_TARGET_HOURS, dayLabels: true }) : ""}
        <p class="trend-line">
          ${sr.avg_7d != null ? `${sr.avg_7d.toFixed(1)} h/nuit <span class="muted small">(moy. 7j)</span>` : "Pas assez de données"}
          ${delta != null ? `<span class="${delta >= 0 ? "trend-up" : "trend-down"} small">${delta >= 0 ? "+" : ""}${delta.toFixed(1)} h vs semaine précédente</span>` : ""}
        </p>
        <p class="muted small">Repère : ≥ ${formatHoursFr(SLEEP_TARGET_HOURS)}/nuit (barres dorées sous ce seuil).</p>
        ${sr.week_avg != null ? `
        <div class="sleep-week-summary">
          <div class="sleep-week-summary-label">Cette semaine (lundi → dimanche) — ${sr.week_nights_logged} nuit${sr.week_nights_logged > 1 ? "s" : ""} enregistrée${sr.week_nights_logged > 1 ? "s" : ""}</div>
          <div class="stat-grid">
            ${sleepGoalTile(
              "Moyenne/nuit",
              formatHoursFr(sr.week_avg),
              Math.min(1, sr.week_avg / SLEEP_TARGET_HOURS),
              `Objectif ${formatHoursFr(SLEEP_TARGET_HOURS)}/nuit`
            )}
            ${sleepGoalTile(
              "Cumul semaine",
              formatHoursFr(sr.week_total),
              Math.min(1, sr.week_total / (SLEEP_TARGET_HOURS * 7)),
              `Objectif ${formatHoursFr(SLEEP_TARGET_HOURS * 7)}`
            )}
          </div>
        </div>` : ""}
        ${(sr.weekly_average || []).length > 1 ? `
        <div class="sleep-weekly-evolution">
          <div class="sleep-week-summary-label">Évolution de la moyenne hebdomadaire</div>
          ${sparklineSVG(sr.weekly_average.map((w) => ({ date: w.week_start, value: w.avg_hours })), { axis: true })}
        </div>` : ""}
      </section>`;
  } else {
    html += `<section class="card"><h2>😴 Sommeil</h2><p class="muted small">Pas encore de données de sommeil.</p></section>`;
  }

  const recoveryHist = (s.recovery_recent && s.recovery_recent.history) || [];
  const lastWithField = (field) => {
    for (let i = recoveryHist.length - 1; i >= 0; i--) if (recoveryHist[i][field] != null) return recoveryHist[i][field];
    return null;
  };
  const restingHr = lastWithField("resting_heart_rate");
  const hrv = lastWithField("hrv_ms");
  if (restingHr != null || hrv != null) {
    html += `
      <section class="card">
        <h2>❤️ Récupération</h2>
        <div class="stat-grid">
          ${restingHr != null ? statTileSimple("FC repos", `${Math.round(restingHr)} bpm`) : ""}
          ${hrv != null ? statTileSimple("HRV", `${Math.round(hrv)} ms`) : ""}
        </div>
        <p class="muted small">FC repos basse et HRV stable/haute = bonne récupération ; une tendance inverse qui se maintient plusieurs jours est un signal précoce de fatigue.</p>
      </section>`;
  } else {
    html += `<section class="card"><h2>❤️ Récupération</h2><p class="muted small">Pas encore de données FC repos/HRV.</p></section>`;
  }

  const bc = s.body_composition || [];
  if (bc.length) {
    const latest = bc[bc.length - 1];
    const prev = bc.length > 1 ? bc[bc.length - 2] : null;
    const delta = (field) => (prev && latest[field] != null && prev[field] != null) ? latest[field] - prev[field] : null;
    html += `
      <section class="card">
        <h2>📏 Composition corporelle</h2>
        <p class="muted small">Dernier scan InBody : ${latest.date}</p>
        <div class="stat-grid">
          ${latest.skeletal_muscle_mass_kg != null ? statTileSimple("Masse musculaire", `${latest.skeletal_muscle_mass_kg.toFixed(1)} kg`, delta("skeletal_muscle_mass_kg"), " kg", "up") : ""}
          ${latest.fat_mass_kg != null ? statTileSimple("Masse grasse", `${latest.fat_mass_kg.toFixed(1)} kg`, delta("fat_mass_kg"), " kg", "down") : ""}
        </div>
        ${latest.inbody_score != null ? `<p class="muted small" style="margin-top:8px">Score InBody : ${latest.inbody_score}</p>` : ""}
      </section>`;
  } else {
    html += `<section class="card"><h2>📏 Composition corporelle</h2><p class="muted small">Pas encore de scan InBody enregistré.</p></section>`;
  }

  const ACCESSORY_LABELS = { strict_press: "Strict Press", tractions: "Tractions", cmj: "CMJ", sprint: "Sprint" };
  let accessoryTags = "";
  for (const [key, label] of Object.entries(ACCESSORY_LABELS)) {
    const entries = (s.secondary_lifts && s.secondary_lifts[key]) || (s.power_speed_progression && s.power_speed_progression[key]);
    if (!entries || !entries.length) continue;
    const last = entries[entries.length - 1];
    const ex = last.executed || {};
    const parts = [ex.sets, ex.reps, ex.load].filter((v) => v != null && v !== "").join(" × ");
    accessoryTags += `<div class="accessory-tag"><span class="accessory-tag-label">${label}</span><span>${escapeHtmlText(parts || "—")}</span><span class="muted small">${last.date}</span></div>`;
  }
  if (accessoryTags) {
    html += `<section class="card"><h2>💪 Accessoires & explosivité</h2><div class="accessory-tags">${accessoryTags}</div></section>`;
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

const MONTH_NAMES_FR = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]; // fmt: skip

/** "Septembre 2026" from an ISO date's year/month — the month-group
 * header for the Calendrier tab. */
function monthLabelFr(iso) {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTH_NAMES_FR[m - 1]} ${y}`;
}

/** "Matchs" tab — the whole season's fixtures (`season_matches`, past and
 * future), grouped by month, distinct from the short "next 3" preview in
 * Data: a full-year view was asked for explicitly, so this is not a
 * truncated list. Past matches are dimmed, the next one the user actually
 * plays is highlighted — "de manière ergonomique" means scannable at a
 * glance, not a raw dump of the schedule file. */
async function renderCalendar(token) {
  const el = document.getElementById("calendar-content");
  el.innerHTML = skeletonHTML();
  const file = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  if (!file) { el.innerHTML = "<p class='muted'>Pas encore de résumé exporté.</p>"; return; }
  const s = JSON.parse(file.content);
  const matches = s.season_matches || [];
  if (!matches.length) { el.innerHTML = "<p class='muted'>Aucun match dans le calendrier de la saison.</p>"; return; }

  const today = todayISO();
  const nextPlayed = matches.find((m) => m.date >= today && m.user_is_playing);
  const nextAny = matches.find((m) => m.date >= today);
  const nextDate = (nextPlayed || nextAny || {}).date;

  const byMonth = new Map();
  for (const m of matches) {
    const key = m.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(m);
  }

  let html = "<div class='calendar-list'>";
  for (const monthMatches of byMonth.values()) {
    html += `<div class="calendar-month-label">${monthLabelFr(monthMatches[0].date)}</div>`;
    for (const m of monthMatches) {
      const isPast = m.date < today;
      const isNext = m.date === nextDate;
      html += `
        <div class="calendar-match${isPast ? " is-past" : ""}${isNext ? " is-next" : ""}">
          <div class="calendar-match-date">
            <span class="calendar-match-day">${dayInitial(m.date)}</span>
            <span class="calendar-match-dm">${shortDateFr(m.date)}</span>
          </div>
          <div class="calendar-match-info">
            <div class="calendar-match-opponent">${escapeHtmlText(m.opponent)}</div>
            <div class="calendar-match-meta">${escapeHtmlText(m.home_away)} · ${escapeHtmlText(m.phase)}${m.user_is_playing ? "" : " · tu ne joues pas encore"}</div>
          </div>
          <div class="calendar-match-status">${isPast ? "✓" : isNext ? "▶" : ""}</div>
        </div>`;
    }
  }
  html += "</div>";
  el.innerHTML = html;
}

/** A compact labeled value, for secondary Data-tab metrics that don't
 * warrant a full progress ring (recovery, body composition) — optionally
 * with a small delta vs the previous reading. */
/** `goodDirection`: "up" (default — more is better, e.g. muscle mass) or
 * "down" (less is better, e.g. fat mass) — determines which sign of
 * `delta` is shown green vs red, since "positive number" doesn't mean
 * the same thing for every metric on this tab. */
function statTileSimple(label, valueText, delta, deltaUnit, goodDirection = "up") {
  const isGood = delta != null && (goodDirection === "down" ? delta <= 0 : delta >= 0);
  const deltaHtml = delta != null
    ? ` <span class="${isGood ? "trend-up" : "trend-down"} small">${delta >= 0 ? "+" : ""}${delta.toFixed(1)}${deltaUnit || ""}</span>`
    : "";
  return `
    <div class="stat-tile-simple">
      <div class="stat-label">${label}</div>
      <div class="trend-line small">${valueText}${deltaHtml}</div>
    </div>`;
}

// ---- Chat ----
let chatPollTimer = null;

/** Appends a user turn to the shared chat log — used by the Coach tab and
 * by "Ajuster ma semaine" (prompts/app-chat.md routes planning requests to
 * prompts/weekly-plan.md, which writes a proposal to data/plans/pending/
 * for the app to show — see loadPendingProposal — rather than applying it
 * directly, see docs/adr/0018). Also dispatches app-chat.yml immediately
 * instead of waiting for its cron: GitHub only runs scheduled workflows
 * on a best-effort basis, and in practice this one fires every couple of
 * hours rather than every 5 minutes, which is why replies used to take so
 * long to show up. The cron stays as a fallback (see app-chat.yml) for
 * anything that reaches conversation.json some other way, so a dispatch
 * failure (e.g. token missing the Actions permission — same requirement
 * as "Nouveau digest", see docs/app-deploy.md) is swallowed rather than
 * blocking the send. */
async function postUserMessage(text) {
  const result = await ghPutJSON(
    "data/app-chat/conversation.json",
    [],
    "App : nouveau message utilisateur",
    (conv) => [...conv, { role: "user", text, at: localISOWithOffset() }]
  );
  ghDispatchWorkflow("app-chat.yml").catch(() => {});
  return result;
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
  repos: { label: "Repos", icon: "😴" },
};

/** Deliberately doesn't include "superset" — pairing with the previous
 * exercise (`ex.superset_with_previous`) is an independent axis from how
 * an exercise's own work is structured (see coaching-guidelines.md,
 * "Supersets" vs "Format alternatif" are two separate sections): a
 * superset pair is normally two `standard` exercises done back to back,
 * not a format of its own. Used to conflate the two into one dropdown
 * value, which meant re-opening and saving a session with a real
 * `superset_with_previous: true` (format left as "standard", exactly how
 * the Forge skeleton writes it) silently reset it to `false` the moment
 * the format dropdown — showing "Standard" — was read back into the
 * session on save. */
const EXERCISE_FORMATS = {
  standard: "Standard",
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

/** A rugby session placed on a Saturday/Sunday is always a match, never
 * club training — applies wherever a blank session is created (the type
 * picker in the full session view, and Forge's quick-set buttons), not
 * just one of the two. */
function defaultSessionName(date, type) {
  if (type === "rugby") return isWeekendISO(date) ? "Match" : "Entraînement club";
  return SESSION_TYPES[type].label;
}

function blankSession(date, type) {
  return {
    name: defaultSessionName(date, type),
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
  // A day tapped "✏️" from a pending Forge skeleton proposal (see
  // loadForgePendingSkeleton) prefills here as an editable draft — nothing
  // is written until "Enregistrer la séance", same as any other new
  // session. Applies whenever the date has no real content yet — no
  // session at all, or just a quick-typed placeholder (sessionIsBlankSkeleton) —
  // real content on the date always wins over the draft. Consumed once.
  const draft = state.forgePrefillDraft;
  state.forgePrefillDraft = null;
  const useDraft = draft && draft.date === date && sessionIsBlankSkeleton(found.session);
  sessionWorking = {
    weekLabel: found.weekLabel || "app",
    date,
    session: useDraft
      ? JSON.parse(JSON.stringify(draft.session))
      : found.session ? JSON.parse(JSON.stringify(found.session)) : null,
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
  if (type === "repos") return "Note (facultatif)";
  return "📝 Note de séance (facultatif — ex. \"volume réduit, épaule un peu sensible\")";
}
function notesPlaceholderFor(type) {
  if (type === "rugby") return "Ressenti, intensité, contact, fatigue...";
  if (type === "autre") return "Où, combien de temps, ressenti...";
  if (type === "repos") return "Étirements, ressenti, sommeil...";
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
  const isFreeform = format !== "standard";
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
      ${idx > 0
        ? `<label class="superset-toggle"><input type="checkbox" class="f-superset"${ex.superset_with_previous ? " checked" : ""}> 🔗 Superset avec l'exercice précédent</label>`
        : ""}
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
    const supersetCheckbox = card.querySelector(".f-superset");
    ex.superset_with_previous = supersetCheckbox ? supersetCheckbox.checked : false;

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
  invalidateAppLogIndex();

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
// Last-sync indicator — persistent in the topbar (outside #content, so it
// survives navigation instead of needing to be re-fetched/shown per view)
// ============================================================================
/** "il y a 5 min" / "il y a 3 h" / "le 23/09 à 08:32" from an ISO
 * timestamp — a bare timestamp doesn't answer "is this actually fresh?"
 * at a glance. */
function relativeSyncText(isoTimestamp) {
  const then = new Date(isoTimestamp);
  const diffMin = Math.round((Date.now() - then.getTime()) / 60000);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  const hh = String(then.getHours()).padStart(2, "0");
  const mm = String(then.getMinutes()).padStart(2, "0");
  return `le ${shortDateFr(isoTimestamp.slice(0, 10))} à ${hh}:${mm}`;
}

/** `data/app/summary.json`'s `generated_at` (written by `coach.app_export`
 * on every digest/sync run — see docs/adr/0023) is the closest thing to a
 * single "last sync" instant across the whole app, so that's what this
 * shows — not a per-view concept, hence living in the topbar rather than
 * in renderData. Silently leaves the indicator as-is on any failure
 * (offline, malformed file) — a stale/missing timestamp is a minor
 * inconvenience, never worth surfacing as an error here. */
async function loadSyncStatus() {
  const el = document.getElementById("topbar-sync-status");
  if (!el) return;
  try {
    const file = await ghGetFile("data/app/summary.json");
    const summary = file ? JSON.parse(file.content) : null;
    el.textContent = summary && summary.generated_at ? `Synchro ${relativeSyncText(summary.generated_at)}` : "";
  } catch (_) { /* leave the indicator as-is */ }
}

// ============================================================================
// Notifications push (Web Push, VAPID) — replaces the Telegram bot as the
// "ping me even when I'm not in the app" channel (see docs/adr/0025). This
// public key has nothing to protect (only the matching private key, held
// server-side as a GitHub Actions secret, can actually sign a push) — safe
// to ship in the client.
// ============================================================================
const VAPID_PUBLIC_KEY = "BLFn9QoifLmwUBlO7AXZmG8A0qFTZUUZKdYr6apkpSw82iE6NFRapZ-HQ7dn9DpYi8MC7ju_VUyM96FyCyTxlh0";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function setPushButtonState(button, subscribed) {
  button.classList.toggle("is-active", subscribed);
  button.title = subscribed ? "Notifications activées (appuyer pour désactiver)" : "Activer les notifications";
  button.setAttribute("aria-label", button.title);
}

async function subscribeToPush(button) {
  if (Notification.permission === "denied") {
    alert("Notifications bloquées pour cette app — active-les dans Réglages iOS puis réessaie.");
    return;
  }
  button.disabled = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    await ghPutJSON("data/app/push-subscription.json", null, "App : abonnement notifications activé", () => subscription.toJSON());
    setPushButtonState(button, true);
  } catch (err) {
    alert(`Impossible d'activer les notifications : ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

async function unsubscribeFromPush(button) {
  button.disabled = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    const current = await ghGetFile("data/app/push-subscription.json");
    if (current) await ghDeleteFile("data/app/push-subscription.json", "App : abonnement notifications désactivé", current.sha);
    setPushButtonState(button, false);
  } catch (err) {
    alert(`Impossible de désactiver les notifications : ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

/** Hides the bell entirely when Push isn't supported (no service worker,
 * or Safari on an iOS old enough to lack Web Push — 16.4+ required, and
 * only once the app is installed to the home screen) rather than showing a
 * button that would just fail on tap. */
async function initPushButton() {
  const button = document.getElementById("push-subscribe-button");
  if (!button) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  setPushButtonState(button, !!existing);
  button.addEventListener("click", async () => {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await unsubscribeFromPush(button);
    } else {
      await subscribeToPush(button);
    }
  });
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

  const enterApp = () => {
    loginScreen.hidden = true;
    app.hidden = false;
    showView("today");
    loadSyncStatus();
    // Keeps the relative "il y a X min" text honest as time passes, and
    // picks up a newer sync without needing a manual refresh.
    setInterval(loadSyncStatus, 5 * 60 * 1000);
    initPushButton().catch(() => {});
  };

  if (getToken()) {
    enterApp();
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
    enterApp();
  });
}

init();
