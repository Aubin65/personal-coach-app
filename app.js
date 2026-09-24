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
async function renderWeekOverview(dayStripEl, highlightsEl, markdown, todayISOStr, mondayISO, token) {
  const { days, highlights } = parseWeekOverview(markdown);
  const [, tm, td] = todayISOStr.split("-");
  const todayDM = normalizeDM(`${parseInt(td, 10)}/${parseInt(tm, 10)}`);

  // The plan's title/icon is only a forecast, written before the week even
  // starts ("Repos" as a default guess for Saturday, say). Once a real
  // session exists for that date — created or edited from the session
  // editor, possibly with a different type than planned (e.g. a "rando"
  // logged on a day the plan called "Repos") — that real session is the
  // truth and must override the frozen plan text here too, not just in the
  // "Séances" table below.
  const daySummaries = mondayISO
    ? await Promise.all(Array.from({ length: 7 }, (_, i) => lookupDaySummary(addDaysISO(mondayISO, i))))
    : [];
  if (token !== undefined && stale(token)) return;

  let stripHTML = "";
  if (days.length) {
    stripHTML += '<div class="day-strip">';
    for (const d of days) {
      const isToday = normalizeDM(d.date) === todayDM;
      const dayIdx = DAY_NAMES.indexOf(d.day);
      const iso = mondayISO && dayIdx !== -1 ? addDaysISO(mondayISO, dayIdx) : null;
      const summary = dayIdx !== -1 ? daySummaries[dayIdx] : null;
      const icon = summary && summary.hasSession && summary.type && SESSION_TYPES[summary.type]
        ? SESSION_TYPES[summary.type].icon
        : dayIconFor(d.title);
      const title = summary && summary.hasSession && summary.name ? summary.name : d.title;
      stripHTML += `
        <button type="button" class="day-card${isToday ? " is-today" : ""}"${iso ? ` data-date="${iso}"` : ""}>
          <div class="day-name">${d.day.slice(0, 3)}</div>
          <div class="day-date">${d.date}</div>
          <div class="day-icon">${icon}</div>
          <div class="day-title">${title.slice(0, 28)}</div>
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
/** A charge value plus its "par main" flag as one clean display string
 * ("12" -> "12 (par main)") — the annotation lives in its own checkbox
 * next to the charge field (see stationRowHTML/exerciseCardHTML), never
 * typed into the number itself ("12/main" was hard to read back and
 * inconsistent from one entry to the next). */
function formatLoadText(load, perHand) {
  if (load == null || load === "") return null;
  return perHand ? `${load} (par main)` : String(load);
}

function formatSetsRepsLoad(obj) {
  if (!obj) return "";
  return [obj.sets, obj.reps, formatLoadText(obj.load, obj.load_per_hand)].filter((v) => v != null && v !== "").join(" × ");
}

/** A compact "12min AMRAP" / "EMOM 60s ×10" / "Circuit 3 tours, repos 60s"
 * summary of a block's `block_meta` (leader only) — same fields as
 * BLOCK_TIMING_FIELDS in the editor, read back out for the day overview. */
function blockMetaSummaryFr(format, meta) {
  if (!meta) return "";
  if (format === "amrap") return meta.duration_min ? `${meta.duration_min}min AMRAP` : "AMRAP";
  if (format === "emom") {
    const parts = [meta.round_seconds ? `${meta.round_seconds}s` : null, meta.rounds ? `×${meta.rounds}` : null].filter(Boolean);
    return parts.length ? `EMOM ${parts.join(" ")}` : "";
  }
  if (format === "circuit") {
    const parts = [meta.rounds ? `${meta.rounds} tours` : null, meta.rest_seconds ? `repos ${meta.rest_seconds}s` : null].filter(Boolean);
    return parts.length ? `Circuit ${parts.join(", ")}` : "";
  }
  if (format === "for_time" && meta.duration_min) return `Cap ${meta.duration_min}min`;
  return "";
}

/** A block's leader `executed.reps` result, formatted by what it actually
 * means for that format instead of raw undifferentiated text — mainly
 * For Time, where the same field means either "finished in this time" or
 * "cap reached, this many rounds/reps" (see `leader.capped`, the block
 * editor's toggle) and showing it unlabelled made it impossible to tell
 * which from the day overview alone. `null` when there's nothing to show
 * (caller falls back to "—"). */
function blockResultDisplay(format, leader) {
  const raw = leader.executed && leader.executed.reps;
  if (!raw) return null;
  if (format === "for_time") {
    return leader.capped ? `🚩 Cap atteint — ${raw}` : `⏱️ Terminé en ${raw}`;
  }
  return raw;
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
          // A non-standard format (AMRAP/EMOM/For Time/Circuit/Autre) has
          // no per-exercise sets×reps×load — its station task lives in
          // `planned.reps` and, on the block's leader only (see
          // groupExercisesIntoBlocks/blockCardHTML), the block's timing
          // (`block_meta`) and its final result (`executed.reps`) — a
          // chained station's own "Fait" cell stays "—", the result is
          // reported once for the whole block, not per station.
          if (format !== "standard") {
            const isLeader = !ex.superset_with_previous;
            const summary = isLeader ? blockMetaSummaryFr(format, ex.block_meta) : "";
            const stationLoad = ex.planned && formatLoadText(ex.planned.load, ex.planned.load_per_hand);
            const plannedCell = [ex.planned && ex.planned.reps, stationLoad, summary].filter(Boolean).join(" — ") || "—";
            const durationSuffix = isLeader && ex.executed_duration_min != null ? ` (${ex.executed_duration_min}min réalisées)` : "";
            const resultText = isLeader ? blockResultDisplay(format, ex) : null;
            const doneCell = (resultText || "—") + durationSuffix;
            return `
              <tr>
                <td>${nameCell} <span class="format-tag">${escapeHtmlText(EXERCISE_FORMATS[format] || format)}</span></td>
                <td>${escapeHtmlText(plannedCell)}</td>
                <td>${isFuture ? "—" : escapeHtmlText(doneCell)}</td>
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
  const hasWorkload = session.session_rpe != null || session.session_duration_min != null;
  if (session.type && session.type !== "musculation") {
    return hasWorkload;
  }
  // A musculation session needs the same RPE/durée wrap-up too, not just
  // real numbers on an exercise — otherwise the new session auto-save
  // (see docs/adr/0039), which silently persists whatever's typed mid-
  // session, would already flip the day to "Fait" before the session is
  // actually over and the "comment ça s'est passé" fields are filled in.
  if (!hasWorkload) return false;
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
const state = { view: "today", weekSubTab: "planning", sessionDate: null, forgeMonday: null, forgePrefillDraft: null, planningMonday: null };

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
  // The session view's live timer interval targets #timer-display by id —
  // about to be wiped from the DOM below along with the rest of #content,
  // so it must stop now rather than keep ticking against a detached node.
  // The auto-save interval doesn't touch the DOM, but it must stop too —
  // it reads `sessionWorking`, which the next view's render is about to
  // reassign/ignore, so a leaked tick would silently keep re-saving a
  // session the user has already navigated away from.
  if (typeof sessionTimerIntervalId !== "undefined" && sessionTimerIntervalId) {
    clearInterval(sessionTimerIntervalId);
    sessionTimerIntervalId = null;
  }
  if (typeof sessionAutoSaveIntervalId !== "undefined" && sessionAutoSaveIntervalId) {
    clearInterval(sessionAutoSaveIntervalId);
    sessionAutoSaveIntervalId = null;
  }
  if (typeof blockTimerIntervalIds !== "undefined") {
    Object.values(blockTimerIntervalIds).forEach((id) => clearInterval(id));
    blockTimerIntervalIds = {};
  }
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
// this list only has ones with a real, checkable source — a majority
// pulled from la philosophie stoïcienne (Marc Aurèle, Épictète, Sénèque)
// depuis que son thème central (ce qui dépend de nous / ce qui n'en
// dépend pas, l'obstacle qui devient le chemin) transfère directement à
// une reprise après blessure. Écarte volontairement le fameux "Nous
// sommes ce que nous répétons..." souvent crédité à Aristote — cette
// formulation est en réalité une paraphrase de Will Durant de l'Éthique à
// Nicomaque, pas une phrase qu'Aristote a réellement écrite, exactement
// le genre de mésattribution que cette liste évite.
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
  {
    text: "Tu as pouvoir sur ton esprit, non sur les événements extérieurs. Comprends cela, et tu trouveras la force.",
    author: "Marc Aurèle",
    source: "Pensées pour moi-même, Livre II",
  },
  {
    text: "Ce qui fait obstacle à l'action favorise l'action. Ce qui se met en travers du chemin devient le chemin.",
    author: "Marc Aurèle",
    source: "Pensées pour moi-même, Livre V",
  },
  {
    text: "La meilleure façon de se venger est de ne pas imiter celui qui a fait le mal.",
    author: "Marc Aurèle",
    source: "Pensées pour moi-même, Livre VI",
  },
  {
    text: "Ce ne sont pas les choses qui troublent les hommes, mais les opinions qu'ils en ont.",
    author: "Épictète",
    source: "Manuel, chapitre V",
  },
  {
    text: "Ne demande pas que les choses arrivent comme tu le souhaites, mais souhaite qu'elles arrivent comme elles arrivent, et ta vie s'écoulera paisiblement.",
    author: "Épictète",
    source: "Manuel, chapitre VIII",
  },
  {
    text: "Le feu éprouve l'or, l'adversité éprouve les hommes forts.",
    author: "Sénèque",
    source: "De la Providence",
  },
  {
    text: "Vivre, Lucilius, c'est combattre.",
    author: "Sénèque",
    source: "Lettres à Lucilius, Lettre 96",
  },
  {
    text: "Il n'y a pas de vent favorable pour celui qui ne sait pas vers quel port il navigue.",
    author: "Sénèque",
    source: "Lettres à Lucilius, Lettre 71",
  },
  {
    text: "Le caractère de l'homme est son destin.",
    author: "Héraclite",
    source: "Fragment 119",
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
    // GitHub's own message (e.g. "Resource not accessible by personal
    // access token", "Not Found") is always more precise than a guess —
    // a 403/404 here doesn't *only* mean "missing Actions permission"
    // (previously the only diagnosis shown, even when the real cause was
    // something else entirely, e.g. an expired token or a typo'd workflow
    // filename) — surfacing it lets a genuinely different cause actually
    // be seen instead of always pointing at the same likely-but-not-
    // certain explanation.
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch (_) { /* body not JSON */ }
    if (res.status === 401) {
      throw new Error(`Token invalide ou expiré (401)${detail ? ` — ${detail}` : ""}.`);
    }
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `Le token n'a probablement pas la permission Actions (HTTP ${res.status}${detail ? ` — ${detail}` : ""}) — voir docs/app-deploy.md. ` +
        "Si tu l'as déjà ajoutée : vérifie que c'est bien sur ce token précis (pas sur APP_REPO_TOKEN, un secret différent) et laisse quelques minutes — GitHub met parfois du temps à propager un changement de permission sur un token existant."
      );
    }
    throw new Error(`GitHub ${res.status} en déclenchant ${fileName}${detail ? ` — ${detail}` : ""}`);
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

/** Planning sub-tab content for `state.planningMonday` — day-strip,
 * "Objectifs clés", day-overview panel and the Séances table, all scoped
 * to one specific week. Re-run standalone by the prev/next week buttons
 * (see renderWeek), not just on first entry into Semaine — a plan file is
 * fetched by its exact filename (`data/plans/<lundi>.md`) rather than
 * "the latest plan on or before today" (that made sense only when this
 * tab was locked to the current week) so navigating to a week without a
 * plan reads as "no plan for this week", not silently falling back to an
 * older one. */
async function renderWeekPlanning(token) {
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

  if (!state.planningMonday) state.planningMonday = mondayOfWeek(todayISO());
  document.getElementById("planning-prev-week").addEventListener("click", () => {
    state.planningMonday = addDaysISO(state.planningMonday, -7);
    renderWeekPlanning(renderToken).catch(() => {});
  });
  document.getElementById("planning-next-week").addEventListener("click", () => {
    state.planningMonday = addDaysISO(state.planningMonday, 7);
    renderWeekPlanning(renderToken).catch(() => {});
  });

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

  document.getElementById("pending-proposal").innerHTML = "";
  loadPendingProposal(token).catch(() => {});
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

  html += readinessScoreHTML(s.readiness);

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

  html += tonnageMilestoneHTML(s.tonnage || {}, liftLabels);

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

  html += tonnageSectionHTML(s.tonnage);

  html += tonnageHeatmapHTML(s.tonnage && s.tonnage.periods);

  el.innerHTML = html || "<p class='muted'>Pas encore de données.</p>";
}

const READINESS_LEVEL_LABELS = {
  pret: "Prêt à pousser",
  bonne_forme: "Bonne forme",
  vigilance: "Vigilance",
  repos_recommande: "Repos recommandé",
};
const READINESS_COMPONENT_LABELS = { charge: "Charge", sommeil: "Sommeil", recuperation: "Récupération" };

/** "Indice de forme" (Data tab, tout en haut) — croise charge aiguë:
 * chronique, sommeil et récupération en un seul chiffre 0-100 (voir
 * `coach.readiness` et docs/adr/0035) : un repère rapide pour savoir si la
 * semaine est plutôt à pousser ou à lever le pied, sans recroiser
 * soi-même trois cartes séparées. Affiche seulement les composantes
 * disponibles (`components[].available`) — jamais un chiffre inventé pour
 * celle qui manque encore d'historique. */
function readinessScoreHTML(readiness) {
  if (!readiness) {
    return `
      <section class="card readiness-card">
        <h2>🧭 Indice de forme</h2>
        <p class="muted small">Pas encore assez d'historique (charge, sommeil, récupération) pour calculer un indice fiable.</p>
      </section>`;
  }
  const rows = Object.entries(readiness.components)
    .filter(([, c]) => c.available)
    .map(
      ([key, c]) => `
        <div class="readiness-component">
          <span class="readiness-component-label">${READINESS_COMPONENT_LABELS[key]}</span>
          <div class="readiness-component-track"><div class="readiness-component-fill" style="width:${c.score}%"></div></div>
        </div>`
    )
    .join("");
  return `
    <section class="card readiness-card level-${readiness.level}">
      <h2>🧭 Indice de forme</h2>
      <div class="readiness-score-row">
        <div class="readiness-score-value">${readiness.score}</div>
        <div class="readiness-score-label">${READINESS_LEVEL_LABELS[readiness.level] || readiness.level}</div>
      </div>
      <div class="readiness-components">${rows}</div>
      <p class="muted small">Charge aiguë:chronique, sommeil récent et signaux de récupération (FC repos/HRV) — un repère, pas une vérité absolue.</p>
    </section>`;
}

// Quelques repères concrets pour donner un sens au tonnage total (tous
// exercices confondus) — croissants, on prend le plus grand qui tient
// dedans plutôt qu'un multiple absurde du plus petit. Purement ludique,
// aucune valeur scientifique.
const TONNAGE_EQUIVALENCE_REFS = [
  { label: "un pilier de rugby (120 kg)", kg: 120 },
  { label: "une voiture citadine (1,2 t)", kg: 1200 },
  { label: "un bus (12 t)", kg: 12000 },
  { label: "un camion de pompier (20 t)", kg: 20000 },
  { label: "une baleine bleue (150 t)", kg: 150000 },
  { label: "la Tour Eiffel (10 100 t)", kg: 10100000 },
];

function tonnageEquivalenceLabel(totalKg) {
  const candidates = TONNAGE_EQUIVALENCE_REFS.filter((r) => totalKg >= r.kg);
  if (!candidates.length) return null;
  const ref = candidates[candidates.length - 1];
  const multiplier = totalKg / ref.kg;
  const formatted = multiplier.toLocaleString("fr-FR", { maximumFractionDigits: multiplier < 10 ? 1 : 0 });
  return `≈ ${formatted} × ${ref.label}`;
}

/** true seulement à partir de la 2e fois qu'un palier est vu pour ce lift
 * dans ce navigateur — jamais au tout premier affichage (rien à "monter
 * depuis", juste la première mesure) — pour déclencher une petite mise en
 * valeur ("🎉 nouveau palier") sans backend ni état partagé, un pur
 * confort local à ce navigateur (jamais relu par le coach ni un autre
 * appareil). */
function tierJustLeveledUp(lift, tierIndex) {
  if (!tierIndex) return false;
  try {
    const key = `coach_seen_tier_${lift}`;
    const seen = parseInt(localStorage.getItem(key) || "0", 10);
    if (tierIndex > seen) {
      localStorage.setItem(key, String(tierIndex));
      return seen > 0;
    }
  } catch (_) { /* stockage indisponible (navigation privée...) — pas de flourish, pas grave */ }
  return false;
}

/** "Tonnage soulevé" (Data tab) — un chiffre motivant, pas un signal de
 * programmation (voir docs/adr/0034), donc traité visuellement à part.
 * Paliers/streak/tonnage total (voir docs/adr/0035 et son amendement)
 * n'apparaissent que si `tonnage.lift_milestones` a bien été calculé côté
 * export — un `data/app/summary.json` pas encore régénéré depuis l'ajout
 * de cette fonctionnalité ne doit jamais laisser croire à un "palier
 * maximum atteint" par défaut (bug observé : `undefined` traité comme
 * "pas de palier suivant" plutôt que comme "pas encore de données"). */
function tonnageMilestoneHTML(tonnage, liftLabels) {
  const lifetimeKg = tonnage.lifetime_main_lifts_kg || {};
  const milestonesAvailable = tonnage.lift_milestones != null;
  const milestones = tonnage.lift_milestones || {};
  const streak = tonnage.training_streak_weeks || 0;
  const equivalence = tonnage.lifetime_total_kg ? tonnageEquivalenceLabel(tonnage.lifetime_total_kg) : null;

  const tiles = Object.entries(liftLabels)
    .map(([key, label]) => ({ key, label, kg: lifetimeKg[key], m: milestones[key] || {} }))
    .filter((t) => t.kg > 0)
    .map((t) => {
      const tonnes = (t.kg / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const leveledUp = milestonesAvailable && tierJustLeveledUp(t.key, t.m.tier_index);
      let milestoneBlock = "";
      if (milestonesAvailable) {
        const progressPct = t.m.progress_to_next != null ? Math.round(t.m.progress_to_next * 100) : 100;
        const next = t.m.next_tier_tonnes != null
          ? `${(t.m.next_tier_tonnes - t.m.tonnes).toFixed(1)} t avant le palier suivant`
          : "Palier maximum atteint";
        milestoneBlock = `
          ${t.m.tier_label ? `<div class="tonnage-milestone-tier">${t.m.tier_icon || "🏅"} ${t.m.tier_label}</div>` : ""}
          <div class="tonnage-milestone-progress-track"><div class="tonnage-milestone-progress-fill" style="width:${progressPct}%"></div></div>
          <div class="tonnage-milestone-next">${next}</div>`;
      }
      return `
        <div class="tonnage-milestone-tile${leveledUp ? " just-leveled-up" : ""}">
          ${leveledUp ? `<div class="tonnage-milestone-levelup">🎉 Nouveau palier !</div>` : ""}
          <div class="tonnage-milestone-value">${tonnes}<span class="tonnage-milestone-unit">t</span></div>
          <div class="tonnage-milestone-label">${t.label}</div>
          ${milestoneBlock}
        </div>`;
    })
    .join("");
  if (!tiles) return "";
  return `
    <section class="card tonnage-milestone-card">
      <h2>🏋️ Tonnage soulevé</h2>
      ${streak > 0 ? `<div class="tonnage-streak-banner">🔥 ${streak} semaine${streak > 1 ? "s" : ""} d'affilée avec au moins une séance</div>` : ""}
      <div class="tonnage-milestone-grid">${tiles}</div>
      ${equivalence ? `<p class="tonnage-milestone-equivalence">🌍 ${(tonnage.lifetime_total_kg / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} t soulevées au total, tous exercices confondus — ${equivalence}</p>` : ""}
      <p class="tonnage-milestone-caption">Cumulé depuis le retour à l'entraînement (18/05/2026)</p>
    </section>`;
}

const TONNAGE_CATEGORY_LABELS = {
  quadriceps: "Quadriceps",
  ischios_jambiers: "Ischios-jambiers",
  fessiers: "Fessiers",
  mollets: "Mollets",
  poussee: "Poussée",
  tirage: "Tirage",
  bras: "Bras",
  gainage: "Gainage",
  explosivite_puissance: "Explosivité / puissance",
  cardio: "Cardio",
};

/** "Tonnage de la semaine" (Data tab), juste après la charge aiguë:
 * chronique — même esprit complémentaire que dans `coach.tonnage` : l'ACWR
 * dit combien la semaine a chargé au global, ceci dit où, compartiment par
 * compartiment, pour repérer un déséquilibre qu'un chiffre global ne peut
 * pas montrer. Barres à longueur relative (proportionnelles au
 * compartiment le plus chargé de la semaine), dans un ordre fixe plutôt
 * que trié par valeur — un ordre qui bougerait chaque semaine serait plus
 * dur à scanner d'un coup d'œil que la tendance elle-même. */
function tonnageSectionHTML(tonnage) {
  if (!tonnage) return "";
  const categories = tonnage.categories || {};
  const priorCategories = (tonnage.prior_week && tonnage.prior_week.categories) || {};
  if (!tonnage.total_sets) {
    return `
      <section class="card">
        <h2>🏋️ Tonnage de la semaine</h2>
        <p class="muted small">Pas encore de séance de musculation loguée cette semaine (lundi → dimanche).</p>
      </section>`;
  }

  const maxTonnage = Math.max(1, ...Object.values(categories).map((c) => c.tonnage_kg));
  const totalDelta = tonnage.total_tonnage_kg - ((tonnage.prior_week && tonnage.prior_week.total_tonnage_kg) || 0);

  let bars = "";
  for (const [key, label] of Object.entries(TONNAGE_CATEGORY_LABELS)) {
    const cat = categories[key] || { tonnage_kg: 0, sets: 0, reps: 0 };
    if (!cat.sets) continue;
    const prior = priorCategories[key] || { tonnage_kg: 0 };
    const delta = cat.tonnage_kg - prior.tonnage_kg;
    const widthPct = Math.max(3, (cat.tonnage_kg / maxTonnage) * 100);
    bars += `
      <div class="tonnage-row">
        <div class="tonnage-row-label">${label}</div>
        <div class="tonnage-row-bar-track"><div class="tonnage-row-bar" style="width:${widthPct}%"></div></div>
        <div class="tonnage-row-value">
          ${cat.tonnage_kg > 0 ? `${Math.round(cat.tonnage_kg)} kg` : `${cat.sets} série${cat.sets > 1 ? "s" : ""}`}
          ${cat.tonnage_kg > 0 && Math.abs(delta) >= 1 ? `<span class="${delta >= 0 ? "trend-up" : "trend-down"} small">${delta >= 0 ? "+" : ""}${Math.round(delta)}</span>` : ""}
        </div>
      </div>`;
  }

  return `
    <section class="card">
      <h2>🏋️ Tonnage de la semaine</h2>
      <p class="trend-line">${Math.round(tonnage.total_tonnage_kg)} kg <span class="small">au total</span>
        ${Math.abs(totalDelta) >= 1 ? `<span class="${totalDelta >= 0 ? "trend-up" : "trend-down"} small">${totalDelta >= 0 ? "+" : ""}${Math.round(totalDelta)} kg vs semaine dernière</span>` : ""}
      </p>
      <div class="tonnage-bars">${bars}</div>
      <p class="muted small">Séries × répétitions × charge, par compartiment — seules les séries avec une charge en kg connue comptent dans le tonnage ; le gainage et les exercices au poids du corps s'affichent en nombre de séries.</p>
    </section>`;
}

const TONNAGE_HEATMAP_PERIOD_LABELS = { "1": "Semaine", "3": "3 sem.", "6": "6 sem." };

// Silhouette humaine stylisée (vue de face) — torse et cuisses en formes
// courbes (épaules/hanches arrondies, cuisses qui se resserrent au genou)
// plutôt que de simples rectangles, segments qui se touchent sans espace
// visible entre eux (bras contre torse, cuisses contre bassin...) pour
// lire comme un seul corps continu plutôt qu'un empilement de blocs, et
// mains/pieds neutres en bout de membre pour finir la silhouette — sans
// viser un rendu anatomique réaliste pour autant. Le tirage (haut du
// dos/trapèzes) est la seule concession : représenté comme une bande
// étroite près du cou, visible même de face, plutôt que d'exiger une
// seconde silhouette de dos pour un seul compartiment. Les fessiers
// occupent la bande de hanches ; les ischios-jambiers, pas vraiment
// visibles de face, sont suggérés par une fine bande sur le bord externe
// de chaque cuisse plutôt qu'omis — explosivite_puissance/cardio n'ont
// eux aucun équivalent anatomique honnête (sprint, vélo...) : affichés à
// part en badges.
const HEATMAP_BODY_ZONES = [
  { cat: "tirage", shape: "rect", x: 26, y: 26, width: 48, height: 10, rx: 5 },
  {
    cat: "poussee",
    shape: "path",
    d: "M18,32 C18,27 24,25 30,25 L70,25 C76,25 82,27 82,32 L76,66 C76,69 55,70 50,70 C45,70 24,69 24,66 Z",
  },
  { cat: "bras", shape: "rect", x: 6, y: 30, width: 14, height: 28, rx: 7 },
  { cat: "bras", shape: "rect", x: 8, y: 56, width: 11, height: 27, rx: 5 },
  { cat: "bras", shape: "rect", x: 80, y: 30, width: 14, height: 28, rx: 7 },
  { cat: "bras", shape: "rect", x: 81, y: 56, width: 11, height: 27, rx: 5 },
  { cat: "gainage", shape: "rect", x: 29, y: 68, width: 42, height: 28, rx: 11 },
  { cat: "fessiers", shape: "rect", x: 26, y: 96, width: 48, height: 16, rx: 11 },
  { cat: "ischios_jambiers", shape: "rect", x: 17, y: 114, width: 9, height: 46, rx: 4 },
  {
    cat: "quadriceps",
    shape: "path",
    d: "M25,110 C25,107 30,106 34,106 C38,106 43,107 43,110 L41,158 C41,161 27,161 26,158 Z",
  },
  {
    cat: "quadriceps",
    shape: "path",
    d: "M57,110 C57,107 62,106 66,106 C70,106 75,107 75,110 L74,158 C73,161 59,161 59,158 Z",
  },
  { cat: "ischios_jambiers", shape: "rect", x: 74, y: 114, width: 9, height: 46, rx: 4 },
  { cat: "mollets", shape: "rect", x: 27, y: 159, width: 18, height: 42, rx: 8 },
  { cat: "mollets", shape: "rect", x: 55, y: 159, width: 18, height: 42, rx: 8 },
];

/** rgba() interpolée entre un fond quasi invisible (rien fait sur la
 * période) et une intensité pleine (compartiment le plus travaillé) —
 * même vert que le reste de l'UI tonnage, une seule teinte plutôt qu'une
 * échelle multicolore pour rester lisible pareil en clair et en sombre. */
function heatFill(fraction) {
  const alpha = 0.1 + Math.max(0, Math.min(1, fraction)) * 0.85;
  return `rgba(30, 122, 77, ${alpha.toFixed(2)})`;
}

/** `maxSets` : nombre de séries par compartiment — plus parlant côté
 * prépa que les répétitions totales pour lire d'un coup d'œil ce qui a
 * été touché. Pas de contour par zone (`stroke`) : les segments se
 * touchent déjà géométriquement, un trait par bloc les aurait fait
 * ressortir comme des cases séparées plutôt qu'un seul corps. */
function bodyHeatmapSVG(categories, maxSets) {
  const shapes = HEATMAP_BODY_ZONES.map((zone) => {
    const sets = (categories[zone.cat] && categories[zone.cat].sets) || 0;
    const fill = heatFill(maxSets ? sets / maxSets : 0);
    return zone.shape === "path"
      ? `<path d="${zone.d}" fill="${fill}" />`
      : `<rect x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.height}" rx="${zone.rx}" fill="${fill}" />`;
  }).join("");
  return `
    <svg viewBox="0 0 100 210" class="heatmap-body-svg" role="img" aria-label="Silhouette colorée par compartiment travaillé">
      <circle cx="50" cy="13" r="11" fill="var(--border)" />
      <path d="M43,21 L57,21 L55,29 L45,29 Z" fill="var(--border)" />
      ${shapes}
      <circle cx="13" cy="85" r="6" fill="var(--border)" />
      <circle cx="87" cy="85" r="6" fill="var(--border)" />
      <rect x="25" y="199" width="20" height="8" rx="4" fill="var(--border)" />
      <rect x="55" y="199" width="20" height="8" rx="4" fill="var(--border)" />
    </svg>`;
}

/** "Où le corps a-t-il vraiment été sollicité", en un coup d'œil, sur 1/3/6
 * semaines au choix (voir `coach.tonnage.breakdown_over_weeks` et
 * docs/adr/0035) — complète les barres de "Tonnage de la semaine"
 * au-dessus (précises mais limitées à la semaine en cours) avec une
 * lecture visuelle qui lisse le bruit d'une semaine à l'autre. Toujours en
 * nombre de séries, jamais en tonnage kg — seule mesure commune aux
 * compartiments à charge (quadriceps, poussée...) et à ceux presque
 * toujours au poids du corps (gainage, mollets), plus parlant côté prépa
 * que les répétitions totales, même principe que `tonnageSectionHTML`.
 * Le switch de période est un pur radio/label CSS
 * (voir style.css), même esprit zéro-JS que les `<details>` du
 * Calendrier — pas de re-fetch, les 3 fenêtres sont déjà dans
 * `s.tonnage.periods`. */
function tonnageHeatmapHTML(periods) {
  if (!periods) return "";
  const panels = Object.entries(TONNAGE_HEATMAP_PERIOD_LABELS)
    .map(([key]) => {
      const period = periods[key];
      if (!period) return "";
      const categories = period.categories || {};
      const maxSets = Math.max(1, ...Object.values(categories).map((c) => c.sets));
      const badges = ["explosivite_puissance", "cardio"]
        .map((cat) => {
          const sets = (categories[cat] && categories[cat].sets) || 0;
          const icon = cat === "cardio" ? "🫀" : "⚡";
          return `<div class="heatmap-badge" style="background:${heatFill(sets / maxSets)}">${icon} ${TONNAGE_CATEGORY_LABELS[cat]} <strong>${sets}</strong></div>`;
        })
        .join("");
      const legend = Object.entries(TONNAGE_CATEGORY_LABELS)
        .filter(([cat]) => cat !== "explosivite_puissance" && cat !== "cardio")
        .map(([cat, label]) => {
          const sets = (categories[cat] && categories[cat].sets) || 0;
          return `
            <div class="heatmap-legend-row">
              <span class="heatmap-legend-swatch" style="background:${heatFill(sets / maxSets)}"></span>
              <span class="heatmap-legend-label">${label}</span>
              <span class="heatmap-legend-value">${sets} série${sets > 1 ? "s" : ""}</span>
            </div>`;
        })
        .join("");
      return `
        <div class="heatmap-panel" data-panel="${key}">
          ${period.total_sets
            ? `<div class="heatmap-body-wrap">${bodyHeatmapSVG(categories, maxSets)}</div>
               <div class="heatmap-badges">${badges}</div>
               <div class="heatmap-legend">${legend}</div>`
            : `<p class="muted small">Pas de séance de musculation loguée sur cette période.</p>`}
        </div>`;
    })
    .join("");

  return `
    <section class="card">
      <h2>🧍 Heatmap corporelle</h2>
      <div class="heatmap-period-switch">
        <input type="radio" name="heatmap-period" id="hm-period-1" checked>
        <input type="radio" name="heatmap-period" id="hm-period-3">
        <input type="radio" name="heatmap-period" id="hm-period-6">
        <div class="heatmap-period-labels">
          <label for="hm-period-1">Semaine</label>
          <label for="hm-period-3">3 sem.</label>
          <label for="hm-period-6">6 sem.</label>
        </div>
        ${panels}
      </div>
      <p class="muted small">Intensité relative (nombre de séries) par compartiment sur la période choisie — le gainage et les mollets, presque toujours au poids du corps, comptent ici comme les autres.</p>
    </section>`;
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
  // "Prochain match" ne veut dire que la Première ici — les fixtures
  // Réserve (voir docs/adr/0029) portent toujours user_is_playing: true
  // (pas de notion de reprise en match pour elles) et fausseraient sinon
  // ce repère, pensé pour "quand est-ce que je rejoue moi-même".
  const ownMatches = matches.filter((m) => m.team !== "Réserve");
  const nextPlayed = ownMatches.find((m) => m.date >= today && m.user_is_playing);
  const nextAny = ownMatches.find((m) => m.date >= today);
  const nextDate = (nextPlayed || nextAny || {}).date;

  // Une même rencontre (date + adversaire) est jouée séparément par la
  // Première et la Réserve (voir docs/adr/0029) — regrouper les deux en
  // une seule ligne dépliable plutôt que deux lignes quasi identiques,
  // surtout indiscernables tant qu'aucun résultat n'est encore connu.
  const groups = new Map();
  for (const m of matches) {
    const key = `${m.date}|${m.opponent}`;
    if (!groups.has(key)) groups.set(key, { date: m.date, opponent: m.opponent, home_away: m.home_away, phase: m.phase, byTeam: {} });
    groups.get(key).byTeam[m.team || "Première"] = m;
  }

  const byMonth = new Map();
  for (const g of groups.values()) {
    const key = g.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(g);
  }

  // Résultat (score_for/score_against/result) rempli automatiquement chaque
  // lundi par prompts/match-results.md une fois le match joué — absent tant
  // que le score n'est pas encore connu, même pour un match déjà passé
  // (page pas encore lisible cette semaine-là) — voir docs/adr/0029.
  const teamRowHtml = (m, isPast) => {
    if (!m) return "<span class='muted small'>Non communiqué</span>";
    const hasScore = m.score_for != null && m.score_against != null;
    const resultClass = m.result === "victoire" ? "is-win" : m.result === "défaite" ? "is-loss" : m.result === "nul" ? "is-draw" : "";
    const scoreHtml = hasScore
      ? `<span class="calendar-match-score ${resultClass}">${m.score_for}-${m.score_against}</span>`
      : `<span class="muted small">${isPast ? "Résultat à venir" : "À venir"}</span>`;
    const note = m.user_is_playing ? "" : " <span class='muted small'>· tu ne joues pas encore</span>";
    return scoreHtml + note;
  };

  let html = "<div class='calendar-list'>";
  for (const monthGroups of byMonth.values()) {
    html += `<div class="calendar-month-label">${monthLabelFr(monthGroups[0].date)}</div>`;
    for (const g of monthGroups) {
      const isPast = g.date < today;
      const isNext = g.date === nextDate;
      const premiere = g.byTeam["Première"];
      const reserve = g.byTeam["Réserve"];
      const anyScore = [premiere, reserve].some((m) => m && m.score_for != null && m.score_against != null);
      const summaryStatus = anyScore ? "🏉" : isPast ? "✓" : isNext ? "▶" : "";
      html += `
        <details class="calendar-match${isPast ? " is-past" : ""}${isNext ? " is-next" : ""}">
          <summary class="calendar-match-summary">
            <div class="calendar-match-date">
              <span class="calendar-match-day">${dayInitial(g.date)}</span>
              <span class="calendar-match-dm">${shortDateFr(g.date)}</span>
            </div>
            <div class="calendar-match-info">
              <div class="calendar-match-opponent">${escapeHtmlText(g.opponent)}</div>
              <div class="calendar-match-meta">${escapeHtmlText(g.home_away)} · ${escapeHtmlText(g.phase)}</div>
            </div>
            <div class="calendar-match-status">${summaryStatus}</div>
            <span class="calendar-match-chevron">▾</span>
          </summary>
          <div class="calendar-match-detail">
            <div class="calendar-match-detail-row"><span class="format-tag">Première</span>${teamRowHtml(premiere, isPast)}</div>
            <div class="calendar-match-detail-row"><span class="format-tag">Réserve</span>${teamRowHtml(reserve, isPast)}</div>
          </div>
        </details>`;
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

/** `ex.superset_with_previous` doubles as the generic "chained into the
 * same physical block as the previous exercise" flag — a "block" (see
 * groupExercisesIntoBlocks) is one leader (superset_with_previous falsy)
 * followed by zero or more chained members. A superset is simply a block
 * whose format is "standard"; AMRAP/EMOM/Circuit/For Time/Autre blocks
 * use the exact same chaining mechanism, just with block-level timing
 * (`block_meta`, leader only) and lightweight per-station rows instead of
 * a full planned/executed grid on every member — see docs/adr/0036. */
function blankExercise() {
  return {
    name: "Nouvel exercice",
    format: "standard",
    planned: { sets: null, reps: null, load: null, load_per_hand: false },
    executed: { sets: null, reps: null, load: null, load_per_hand: false },
    rir: null,
    notes: null,
    superset_with_previous: false,
  };
}

/** A chained member added to an existing block (station of an AMRAP/EMOM/
 * Circuit, or an added superset partner) — same shape as `blankExercise`
 * but pre-chained; `format` is set by the caller to match the block. A
 * non-standard station starts with an empty name (shows the "Nouvel
 * exercice" placeholder greyed out, see stationRowHTML) rather than that
 * text as a real value — a superset partner (format "standard", rendered
 * as a full card like any other standard exercise) keeps the literal
 * default text instead, unaffected by this. */
function blankStationExercise(format) {
  return {
    name: format === "standard" ? "Nouvel exercice" : "",
    format,
    planned: { sets: null, reps: null, load: null, load_per_hand: false },
    executed: { sets: null, reps: null, load: null, load_per_hand: false },
    rir: null,
    notes: null,
    superset_with_previous: true,
  };
}

function blankBlockMeta() {
  return { duration_min: null, round_seconds: null, rounds: null, rest_seconds: null };
}

/** Sensible starting values so a freshly-added AMRAP/EMOM/Circuit block
 * isn't blank fields the user has to fill in from nothing — a genuine
 * common-case default (12min AMRAP, 60s×10 EMOM, 3 tours de circuit),
 * always editable afterwards. */
function defaultBlockMeta(format) {
  const meta = blankBlockMeta();
  if (format === "amrap") meta.duration_min = 12;
  else if (format === "emom") { meta.round_seconds = 60; meta.rounds = 10; }
  else if (format === "circuit") { meta.rounds = 3; meta.rest_seconds = 60; }
  return meta;
}

// Which `block_meta` fields a format's block header exposes, and how —
// "standard" (superset) and "other" show none, a plain chained list is
// self-explanatory enough on its own. Field keys match `blankBlockMeta`.
const BLOCK_TIMING_FIELDS = {
  amrap: [{ key: "duration_min", label: "Durée totale (min)", placeholder: "12" }],
  emom: [
    { key: "round_seconds", label: "Secondes par tour", placeholder: "60" },
    { key: "rounds", label: "Nombre de tours", placeholder: "10" },
  ],
  circuit: [
    { key: "rounds", label: "Nombre de tours", placeholder: "3" },
    { key: "rest_seconds", label: "Repos entre tours (sec)", placeholder: "60" },
  ],
  for_time: [{ key: "duration_min", label: "Cap (min, optionnel)", placeholder: "15" }],
};

// The single free-text "how did it go" result field shown once per block
// (on the leader, via `executed.reps`) for any non-standard format — a
// circuit/AMRAP/EMOM result is a property of the whole block (total tours,
// temps réalisé...), never of one station in particular.
const BLOCK_RESULT_LABELS = {
  amrap: "Résultat (ex. 6 tours + 4 reps)",
  emom: "Résultat (ex. tous les tours tenus)",
  circuit: "Résultat (ex. 3 tours en 14min)",
  for_time: "Temps réalisé (ex. 9:24)",
  other: "Résultat",
};

/** [[idx, idx, ...], ...] — one array of flat-`exercises` indices per
 * block: a leader (`superset_with_previous` falsy, or idx 0) followed by
 * its chained members. */
function groupExercisesIntoBlocks(exercises) {
  const blocks = [];
  exercises.forEach((ex, idx) => {
    if (idx === 0 || !ex.superset_with_previous) blocks.push([idx]);
    else blocks[blocks.length - 1].push(idx);
  });
  return blocks;
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

// ---------- Timer de séance ("Lancer"/"Terminer") ----------
// localStorage uniquement — un pur confort de ce navigateur, jamais relu
// par le coach ni par un autre appareil (voir la note sur le stockage
// navigateur) : l'instant de départ n'a besoin de survivre qu'à un
// verrouillage/passage en arrière-plan du téléphone pendant la séance,
// pas de se synchroniser où que ce soit. Une seule séance à la fois par
// date suffit largement en pratique.
function getSessionTimerStart(date) {
  try { return localStorage.getItem(`coach_session_timer_${date}`); } catch (_) { return null; }
}
function setSessionTimerStart(date, iso) {
  try {
    if (iso) localStorage.setItem(`coach_session_timer_${date}`, iso);
    else localStorage.removeItem(`coach_session_timer_${date}`);
  } catch (_) { /* stockage indisponible — le timer tourne quand même pour ce rendu, juste pas persistant */ }
}

function formatDurationMs(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatElapsed(startedAtIso) {
  return formatDurationMs(Date.now() - new Date(startedAtIso).getTime());
}

/** "Lancer la séance" démarre un timer visible en permanence (sticky en
 * haut, même en défilant) qui remplit automatiquement `session_duration_
 * min` à "Terminer la séance" — la durée exacte plutôt qu'estimée après
 * coup, avec confirmation pour éviter de perdre le temps en cours sur un
 * appui accidentel. La saisie manuelle du champ durée plus bas
 * (workloadSectionHTML) reste toujours possible en parallèle — oubli
 * d'arrêt du timer, ou simplement ne pas s'en servir du tout. */
function timerBarHTML(date) {
  const startedAt = getSessionTimerStart(date);
  if (!startedAt) {
    return `
      <section class="card timer-card">
        <button type="button" id="start-timer" class="primary-button">▶️ Lancer la séance</button>
      </section>`;
  }
  return `
    <section class="card timer-card timer-running" id="timer-bar">
      <div class="timer-running-info">
        <div class="timer-label">Séance en cours</div>
        <div class="timer-display" id="timer-display">${formatElapsed(startedAt)}</div>
      </div>
      <button type="button" id="stop-timer" class="timer-stop-button">⏹ Terminer</button>
    </section>`;
}

let sessionTimerIntervalId = null;

/** Redémarré à chaque rendu de la séance (`renderSessionContent` tourne
 * souvent — ajout d'exercice, changement de format...) : plus simple et
 * plus sûr que d'essayer de faire survivre un seul intervalle à travers
 * des re-rendus qui remplacent le DOM sous ses pieds. */
function startTimerDisplayInterval() {
  if (sessionTimerIntervalId) {
    clearInterval(sessionTimerIntervalId);
    sessionTimerIntervalId = null;
  }
  const startedAt = getSessionTimerStart(sessionWorking.date);
  if (!startedAt || !document.getElementById("timer-display")) return;
  sessionTimerIntervalId = setInterval(() => {
    const displayEl = document.getElementById("timer-display");
    if (!displayEl) {
      clearInterval(sessionTimerIntervalId);
      sessionTimerIntervalId = null;
      return;
    }
    displayEl.textContent = formatElapsed(startedAt);
  }, 1000);
}

// ---------- Sauvegarde automatique pendant la séance ----------
// Filet de sécurité pour la durée de la séance chronométrée : un
// verrouillage de téléphone prolongé, un crash de l'onglet ou un simple
// oubli d'appuyer sur "Enregistrer" avant de partir ne doivent pas faire
// perdre tout le log en cours. Se déclenche silencieusement en tâche de
// fond tant que le timer tourne ; le bouton "Enregistrer la séance"
// manuel reste le mécanisme principal, celui-ci ne fait que réduire la
// fenêtre de perte possible.
const SESSION_AUTOSAVE_INTERVAL_MS = 3 * 60 * 1000;
let sessionAutoSaveIntervalId = null;
let sessionSaveInFlight = false;

/** Redémarré à chaque rendu, même logique que startTimerDisplayInterval —
 * s'arrête tout seul (et ne redémarre pas) dès que le timer n'est plus en
 * cours pour cette date, donc un simple appel après chaque
 * renderSessionContent suffit à suivre l'état démarré/arrêté sans logique
 * séparée. */
function startSessionAutoSave() {
  if (sessionAutoSaveIntervalId) {
    clearInterval(sessionAutoSaveIntervalId);
    sessionAutoSaveIntervalId = null;
  }
  if (!getSessionTimerStart(sessionWorking.date)) return;
  sessionAutoSaveIntervalId = setInterval(async () => {
    // Ne rentre jamais en conflit avec une sauvegarde manuelle déjà en
    // cours (double écriture concurrente sur le même fichier) — retentera
    // simplement au prochain intervalle.
    if (sessionSaveInFlight) return;
    if (!getSessionTimerStart(sessionWorking.date)) return; // séance terminée entre-temps
    syncFormIntoSession();
    sessionSaveInFlight = true;
    try {
      await saveSession(sessionWorking.weekLabel, sessionWorking.date, sessionWorking.session);
      const statusEl = document.getElementById("session-status");
      if (statusEl) {
        const hhmm = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        statusEl.textContent = `Sauvegarde auto ✓ ${hhmm}`;
      }
    } catch (_) {
      // Échec silencieux — pas d'alerte intrusive pendant une séance en
      // cours, le prochain intervalle retentera de lui-même ; "Enregistrer
      // la séance" reste disponible à tout moment en filet de secours.
    } finally {
      sessionSaveInFlight = false;
    }
  }, SESSION_AUTOSAVE_INTERVAL_MS);
}

// ---------- Chrono par tour (blocs EMOM/Circuit) ----------
// Un chrono secondaire optionnel, par bloc — le timer de séance ci-dessus
// ne donne qu'un total, pas le détail utile pour un EMOM/circuit ("le
// 3e tour a traîné, pas le 1er"). localStorage uniquement, même
// convention que le timer de séance ; clé par date+leaderIdx puisque
// plusieurs blocs EMOM/circuit peuvent coexister dans une même séance.
// À l'arrêt, un résumé texte des tours est ajouté aux notes du bloc
// (jamais dans coach.tonnage — même principe que le reste de ce format de
// bloc, voir docs/adr/0036/0038 : rien d'assez fiable ici pour en faire
// une donnée de suivi chiffrée, mais utile à relire pour voir si ça
// s'améliore d'une séance à l'autre).
function blockTimerKey(date, leaderIdx) {
  return `coach_block_timer_${date}_${leaderIdx}`;
}
function getBlockTimerState(date, leaderIdx) {
  try {
    const raw = localStorage.getItem(blockTimerKey(date, leaderIdx));
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
function setBlockTimerState(date, leaderIdx, stateObj) {
  try {
    const key = blockTimerKey(date, leaderIdx);
    if (stateObj) localStorage.setItem(key, JSON.stringify(stateObj));
    else localStorage.removeItem(key);
  } catch (_) { /* stockage indisponible — le bouton reste utilisable, juste pas persistant */ }
}

function splitTimerHTML(leaderIdx, date) {
  const bt = getBlockTimerState(date, leaderIdx);
  if (!bt) {
    return `
      <div class="split-timer-card">
        <button type="button" class="primary-button ghost small split-timer-start" data-leader-idx="${leaderIdx}">⏱️ Chrono par tour</button>
      </div>`;
  }
  const lapsHTML = bt.laps.length
    ? `<div class="split-timer-laps">${bt.laps.map((ms, i) => `<span>Tour ${i + 1} : ${formatDurationMs(ms)}</span>`).join("")}</div>`
    : "";
  return `
    <div class="split-timer-card split-timer-running">
      <div class="split-timer-row">
        <div class="split-timer-current">
          Tour ${bt.laps.length + 1} en cours
          <span class="split-timer-display" data-leader-idx="${leaderIdx}">${formatElapsed(bt.lastLapAt)}</span>
        </div>
        <div class="split-timer-buttons">
          <button type="button" class="primary-button small split-timer-lap" data-leader-idx="${leaderIdx}">✓ Tour terminé</button>
          <button type="button" class="icon-button small danger split-timer-stop" data-leader-idx="${leaderIdx}" title="Arrêter le chrono par tour" aria-label="Arrêter le chrono par tour">⏹</button>
        </div>
      </div>
      ${lapsHTML}
    </div>`;
}

let blockTimerIntervalIds = {};

/** Un intervalle par bloc dont le chrono-tours tourne, redémarré à chaque
 * rendu — même logique que startTimerDisplayInterval/startSessionAutoSave
 * (plus simple que de faire survivre des intervalles à travers des
 * re-rendus qui remplacent le DOM sous leurs pieds). */
function startBlockTimerIntervals() {
  Object.values(blockTimerIntervalIds).forEach((id) => clearInterval(id));
  blockTimerIntervalIds = {};
  document.querySelectorAll(".split-timer-display[data-leader-idx]").forEach((displayEl) => {
    const leaderIdx = displayEl.dataset.leaderIdx;
    const bt = getBlockTimerState(sessionWorking.date, +leaderIdx);
    if (!bt) return;
    blockTimerIntervalIds[leaderIdx] = setInterval(() => {
      const el = document.querySelector(`.split-timer-display[data-leader-idx="${leaderIdx}"]`);
      if (!el) {
        clearInterval(blockTimerIntervalIds[leaderIdx]);
        delete blockTimerIntervalIds[leaderIdx];
        return;
      }
      el.textContent = formatElapsed(bt.lastLapAt);
    }, 1000);
  });
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
    ${timerBarHTML(date)}
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
  startTimerDisplayInterval();
  startSessionAutoSave();
  startBlockTimerIntervals();
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
  const blocks = groupExercisesIntoBlocks(exercises);
  return `
    <section class="card">
      <button type="button" id="toggle-block-ref" class="details-toggle">🎯 Objectifs du bloc en cours</button>
      <div id="block-ref-content" class="markdown-body small" hidden></div>
    </section>
    <section class="card">
      <button type="button" id="prefill-button" class="primary-button ghost small">🔁 Dupliquer une séance récente</button>
      <div id="prefill-picker" hidden></div>
    </section>
    <div id="exercise-list">${blocks.map((indices) => blockCardHTML(indices, exercises)).join("")}</div>
    <div class="add-block-row">
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="standard">+ Exercice</button>
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="superset">+ Superset</button>
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="amrap">+ AMRAP</button>
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="emom">+ EMOM</button>
      <button type="button" class="primary-button ghost small add-block-button" data-add-format="circuit">+ Circuit</button>
    </div>`;
}

/** One block = one leader exercise (`indices[0]`) plus its chained
 * members (see `groupExercisesIntoBlocks`). A solo standard exercise
 * renders exactly as before (no block chrome at all — the common case
 * stays visually unchanged); anything else — a superset (≥2 standard
 * members) or an AMRAP/EMOM/Circuit/For Time/Autre block, chained or
 * solo — gets a shared header (format switch + block-level timing, see
 * `BLOCK_TIMING_FIELDS`) wrapping its station rows, a single result field
 * for the whole block (`BLOCK_RESULT_LABELS`, leader's `executed.reps`),
 * and one "+ Ajouter une station" to extend it — see docs/adr/0036. */
function blockCardHTML(indices, exercises) {
  const leaderIdx = indices[0];
  const leader = exercises[leaderIdx];
  const format = leader.format || "standard";
  const isChain = indices.length > 1;

  if (format === "standard" && !isChain) {
    // Chaîner cet exercice à celui juste au-dessus (superset) n'a de sens
    // que si ce précédent est lui-même de format standard — un exercice
    // "standard" chaîné après un leader AMRAP/EMOM/Circuit produirait un
    // bloc mixte que blockCardHTML ne sait pas rendre (ses stations
    // partagent toutes le format du leader).
    const canChainToPrevious = leaderIdx > 0 && (exercises[leaderIdx - 1].format || "standard") === "standard";
    return exerciseCardHTML(leader, leaderIdx, exercises.length, true, canChainToPrevious);
  }

  const timingFields = BLOCK_TIMING_FIELDS[format] || [];
  const meta = leader.block_meta || {};
  const timingHTML = timingFields.length
    ? `<div class="exercise-block-timing">${timingFields
        .map(
          (f) => `
        <div><label>${f.label}</label><input type="number" min="0" class="f-block-meta" data-key="${f.key}" placeholder="${f.placeholder}" value="${meta[f.key] ?? ""}"></div>`
        )
        .join("")}</div>`
    : "";

  const stationsHTML = format === "standard"
    ? indices.map((idx) => exerciseCardHTML(exercises[idx], idx, exercises.length, false)).join("")
    : indices.map((idx) => stationRowHTML(exercises[idx], idx, format, exercises.length)).join("");

  // For Time : si le cap chronométré est atteint sans finir, le résultat
  // n'est plus un temps mais un nombre de tours/reps réalisés — même champ
  // de stockage (`executed.reps`, texte libre), juste un libellé qui suit
  // ce qui a réellement été réalisable ce jour-là plutôt que de forcer un
  // format "temps" qui n'a pas de sens quand le cap a coupé la séance.
  const cappedToggleHTML = format === "for_time"
    ? `<label class="capped-toggle"><input type="checkbox" class="f-block-capped"${leader.capped ? " checked" : ""}> Cap atteint (non terminé)</label>`
    : "";
  const resultLabel = format === "for_time" && leader.capped
    ? "Tours/reps atteints au cap (ex. 3 tours + 8 reps)"
    : (BLOCK_RESULT_LABELS[format] || "Résultat");
  const resultHTML = format !== "standard"
    ? `<div class="exercise-block-result"><label>${resultLabel}</label><input type="text" class="f-block-result" value="${escapeAttr((leader.executed && leader.executed.reps) ?? "")}"></div>`
    : "";

  // Circuit only, and separate from the free-text result above — a real
  // number (minutes) rather than something embedded in prose, so it can
  // actually be compared session to session to see whether it's getting
  // faster (see docs/adr/0036's amendement, "durée réalisée").
  const durationHTML = format === "circuit"
    ? `<div class="exercise-block-result"><label>Durée réalisée (min) — pour suivre la progression</label><input type="number" min="0" step="0.5" class="f-block-duration" value="${leader.executed_duration_min ?? ""}"></div>`
    : "";

  // Chrono par tour : utile surtout pour un EMOM (rythme tenu tour après
  // tour) ou un circuit (où le tour traîne-t-il vraiment) — un AMRAP/for
  // time/superset se lit déjà entièrement via le timer de séance global.
  const splitTimerCardHTML = (format === "emom" || format === "circuit")
    ? splitTimerHTML(leaderIdx, sessionWorking.date)
    : "";

  return `
    <div class="exercise-block-card" data-leader-idx="${leaderIdx}">
      <div class="exercise-block-header">
        <span class="exercise-block-format-tag">${format === "standard" ? "🔗 Superset" : (EXERCISE_FORMATS[format] || format)}</span>
        <select class="f-block-format" data-leader-idx="${leaderIdx}">
          ${Object.entries(EXERCISE_FORMATS).map(([key, label]) => `<option value="${key}"${format === key ? " selected" : ""}>${label}</option>`).join("")}
        </select>
      </div>
      ${timingHTML}
      ${splitTimerCardHTML}
      <div class="exercise-block-stations">${stationsHTML}</div>
      <button type="button" class="primary-button ghost small add-station-button" data-leader-idx="${leaderIdx}">+ Ajouter ${format === "standard" ? "au superset" : "une station"}</button>
      ${cappedToggleHTML}
      ${resultHTML}
      ${durationHTML}
      <div class="exercise-block-notes"><label>Notes (optionnel)</label><textarea class="f-block-notes" rows="2" placeholder="Détail libre si besoin">${escapeHtmlText(leader.notes || "")}</textarea></div>
    </div>`;
}

/** A compact station row — name + reps/tâche + charge (optionnelle) — for
 * a member of an AMRAP/EMOM/Circuit/For Time/Autre block: these formats
 * don't have a per-station planned/executed/RIR grid, the whole block's
 * outcome is one shared result field (see `blockCardHTML`'s
 * `resultHTML`). The charge field lets a mixed block log a station with
 * a real load (ex. "Strict Press, 12 reps, 12kg/main") right next to one
 * without (ex. "Rameur, 300m") — never fed into `coach.tonnage` though,
 * same as the rest of this format family (no reliable rounds-completed
 * count to multiply it by, see docs/adr/0036's amendement). */
function stationRowHTML(ex, idx, format, total) {
  const planned = ex.planned || {};
  return `
    <div class="exercise-row station-row exercise-log-card" data-idx="${idx}">
      <div class="exercise-log-head">
        <input type="text" class="f-name" value="${escapeAttr(ex.name || "")}" placeholder="Nouvel exercice">
        <div class="reorder-buttons">
          <button type="button" class="icon-button small move-up" ${idx === 0 ? "disabled" : ""} title="Monter" aria-label="Monter">▲</button>
          <button type="button" class="icon-button small move-down" ${idx === total - 1 ? "disabled" : ""} title="Descendre" aria-label="Descendre">▼</button>
          <button type="button" class="icon-button small danger remove-exercise" title="Retirer" aria-label="Retirer">✕</button>
        </div>
      </div>
      <div class="exercise-log-grid">
        <div><label>Reps / tâche</label><input type="text" class="f-station-reps" value="${escapeAttr(planned.reps ?? "")}" placeholder="ex. 12 ou 300m"></div>
        <div>
          <label>Charge (optionnelle)</label>
          <input type="text" class="f-station-load" value="${escapeAttr(planned.load ?? "")}" placeholder="ex. 12">
          <label class="per-hand-toggle"><input type="checkbox" class="f-station-load-per-hand"${planned.load_per_hand ? " checked" : ""}> Par main</label>
        </div>
      </div>
    </div>`;
}

// ---------- Fait : reps par série, sans les taper à la main avec des
// tirets ----------
// `coach.tonnage._total_reps` (voir son docstring) accepte déjà un texte
// à tirets par série ("10-8-8-6") en plus d'une valeur unique — cette
// convention de stockage ne change pas, seule la façon de la remplir
// change : une ligne par série plutôt qu'un seul champ texte à composer à
// la main. `executed.load` en revanche reste toujours une valeur unique
// (la charge ne varie pas série par série dans ce modèle, voir
// `_load_kg` côté Python), donc seul reps devient un widget par ligne.

/** Reconstruit les lignes du widget à partir de ce qui est stocké — une
 * chaîne à tirets impose son propre découpage (la source la plus précise
 * possible) ; sinon `sets` donne le nombre de lignes, chacune préremplie
 * avec la valeur unique partagée (le cas le plus courant : "4 séries de
 * 10"). */
function hydrateSetRows(setsRaw, repsRaw) {
  if (repsRaw != null && String(repsRaw).includes("-")) {
    return String(repsRaw).split("-");
  }
  const setsCount = parseInt(setsRaw, 10);
  if (Number.isFinite(setsCount) && setsCount > 0) {
    return Array.from({ length: setsCount }, () => (repsRaw != null ? String(repsRaw) : ""));
  }
  return repsRaw != null && repsRaw !== "" ? [String(repsRaw)] : [];
}

/** L'inverse de hydrateSetRows — `{sets, reps}` prêt à stocker, `null`/
 * `null` si aucune ligne n'a de valeur (pas encore vraiment "fait", voir
 * sessionHasExecuted). Une valeur identique sur toutes les lignes se
 * simplifie en un texte simple plutôt que "10-10-10-10" — plus lisible
 * partout ailleurs (tableau Séances, digest...) ; hydrateSetRows
 * reconstruit exactement le même nombre de lignes à partir de `sets` de
 * toute façon, donc rien n'est perdu au rendu suivant. */
function serializeSetRows(values) {
  const trimmed = values.map((v) => (v || "").trim());
  if (trimmed.every((v) => v === "")) return { sets: null, reps: null };
  const allSame = trimmed.every((v) => v === trimmed[0]);
  return { sets: String(trimmed.length), reps: allSame ? trimmed[0] : trimmed.join("-") };
}

function setRowsHTML(rows) {
  const rowsHTML = rows
    .map(
      (v, i) => `
      <div class="set-row">
        <span class="set-row-num">Série ${i + 1}</span>
        <input type="text" inputmode="numeric" class="f-exec-set-reps" value="${escapeAttr(v)}" placeholder="reps">
        <button type="button" class="icon-button small danger remove-exec-set" title="Retirer cette série" aria-label="Retirer cette série">✕</button>
      </div>`
    )
    .join("");
  return `
    <div class="exec-set-rows">
      ${rowsHTML}
      <button type="button" class="primary-button ghost small add-exec-set">+ Série faite</button>
    </div>`;
}

/** Add/remove a set row purely in the DOM (no data-model mutation, no
 * full re-render) — a full re-render here would go through
 * syncFormIntoSession/serializeSetRows first, which collapses an empty
 * row right back to nothing (see serializeSetRows's docstring), so a
 * freshly-added blank row would visually vanish before the user gets to
 * type anything into it. The row's value only becomes real stored data
 * once syncFormIntoSession reads it — on any structural change elsewhere,
 * or on save. */
function bindRemoveExecSetRow(btn) {
  btn.addEventListener("click", () => {
    const container = btn.closest(".exec-set-rows");
    btn.closest(".set-row").remove();
    container.querySelectorAll(".set-row .set-row-num").forEach((el, i) => { el.textContent = `Série ${i + 1}`; });
  });
}

/** The full planned/executed/RIR card — a solo standard exercise, or one
 * member of a pure-standard superset block. `showFormatControls` is only
 * true for a solo exercise (where the format select doubles as "turn this
 * into a superset/AMRAP/EMOM/..." — see the shared `.f-block-format`
 * handler in bindSessionContentEvents): a superset member's format is
 * fixed to the block's ("standard"), so it doesn't need its own select.
 * `canChainToPrevious` adds one more option, "chaîner au précédent" — a
 * sentinel value (`__chain_previous`), never a real `format`, handled
 * separately by the change handler (sets `superset_with_previous`
 * instead): a real "superset" format value was deliberately removed from
 * `EXERCISE_FORMATS` (superset pairing and an exercise's own format are
 * independent axes — see EXERCISE_FORMATS' docstring), this restores an
 * easy way to reach it from the same dropdown without reintroducing that
 * conflation. */
function exerciseCardHTML(ex, idx, total, showFormatControls, canChainToPrevious) {
  const planned = ex.planned || {};
  const executed = ex.executed || {};
  return `
    <div class="exercise-row exercise-log-card" data-idx="${idx}">
      <div class="exercise-log-head">
        <input type="text" class="f-name" value="${escapeAttr(ex.name || "")}">
        <div class="reorder-buttons">
          <button type="button" class="icon-button small move-up" ${idx === 0 ? "disabled" : ""} title="Monter" aria-label="Monter">▲</button>
          <button type="button" class="icon-button small move-down" ${idx === total - 1 ? "disabled" : ""} title="Descendre" aria-label="Descendre">▼</button>
          <button type="button" class="icon-button small danger remove-exercise" title="Retirer" aria-label="Retirer">✕</button>
        </div>
      </div>
      ${showFormatControls
        ? `<select class="f-block-format" data-leader-idx="${idx}">
        ${Object.entries(EXERCISE_FORMATS).map(([key, label]) => `<option value="${key}"${(ex.format || "standard") === key ? " selected" : ""}>${label}</option>`).join("")}
        ${canChainToPrevious ? `<option value="__chain_previous">🔗 Superset (avec le précédent)</option>` : ""}
      </select>`
        : ""}
      <div class="field-row-label">Prévu</div>
      <div class="exercise-log-grid">
        <div><label>Séries</label><input type="text" class="f-planned-sets" value="${escapeAttr(planned.sets ?? "")}"></div>
        <div><label>Reps/temps</label><input type="text" class="f-planned-reps" value="${escapeAttr(planned.reps ?? "")}"></div>
        <div>
          <label>Charge</label>
          <input type="text" class="f-planned-load" value="${escapeAttr(planned.load ?? "")}">
          <label class="per-hand-toggle"><input type="checkbox" class="f-planned-load-per-hand"${planned.load_per_hand ? " checked" : ""}> Par main</label>
        </div>
      </div>
      <div class="field-row-label">Fait</div>
      ${setRowsHTML(hydrateSetRows(executed.sets, executed.reps))}
      <div class="exercise-log-grid">
        <div>
          <label>Charge</label>
          <input type="text" class="f-load" value="${escapeAttr(executed.load ?? "")}">
          <label class="per-hand-toggle"><input type="checkbox" class="f-load-per-hand"${executed.load_per_hand ? " checked" : ""}> Par main</label>
        </div>
        <div><label>RIR</label><input type="text" class="f-rir" value="${escapeAttr(ex.rir ?? "")}"></div>
      </div>
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

  // Individual exercise rows — a full standard card (solo exercise, or a
  // superset member) or a compact station row (AMRAP/EMOM/Circuit/For
  // Time/Autre member). `format`/`superset_with_previous` are NOT read
  // here — they're structural (which block an exercise belongs to, and
  // what kind), set directly by the block-format switch and the add/
  // remove-station handlers in bindSessionContentEvents, not by a form
  // field re-read on every sync.
  document.querySelectorAll("#exercise-list .exercise-row").forEach((row) => {
    const idx = +row.dataset.idx;
    const ex = session.exercises[idx];
    if (!ex) return;
    const nameInput = row.querySelector(".f-name");
    if (nameInput) ex.name = nameInput.value.trim() || ex.name;

    const stationReps = row.querySelector(".f-station-reps");
    if (stationReps) {
      const stationLoad = row.querySelector(".f-station-load");
      const stationLoadPerHand = row.querySelector(".f-station-load-per-hand");
      ex.planned = {
        sets: null,
        reps: stationReps.value.trim() || null,
        load: stationLoad ? (stationLoad.value.trim() || null) : null,
        load_per_hand: stationLoadPerHand ? stationLoadPerHand.checked : false,
      };
      return;
    }

    const plannedSets = row.querySelector(".f-planned-sets");
    if (plannedSets) {
      ex.planned = {
        sets: plannedSets.value || null,
        reps: row.querySelector(".f-planned-reps").value || null,
        load: row.querySelector(".f-planned-load").value || null,
        load_per_hand: row.querySelector(".f-planned-load-per-hand").checked,
      };
    }
    const execRowsContainer = row.querySelector(".exec-set-rows");
    if (execRowsContainer) {
      const repsVals = Array.from(execRowsContainer.querySelectorAll(".f-exec-set-reps")).map((el) => el.value);
      const { sets, reps } = serializeSetRows(repsVals);
      ex.executed = {
        sets,
        reps,
        load: row.querySelector(".f-load").value || null,
        load_per_hand: row.querySelector(".f-load-per-hand").checked,
      };
      ex.rir = row.querySelector(".f-rir").value || null;
    }
  });

  // Block-level fields — timing (leader only), the whole block's result,
  // and its shared notes (see blockCardHTML). Absent entirely for a solo
  // standard exercise (no `.exercise-block-card` wrapper in that case).
  document.querySelectorAll("#exercise-list .exercise-block-card").forEach((card) => {
    const leaderIdx = +card.dataset.leaderIdx;
    const leader = session.exercises[leaderIdx];
    if (!leader) return;

    const metaInputs = card.querySelectorAll(".f-block-meta");
    if (metaInputs.length) {
      const meta = leader.block_meta || blankBlockMeta();
      metaInputs.forEach((input) => {
        meta[input.dataset.key] = input.value !== "" ? Number(input.value) : null;
      });
      leader.block_meta = meta;
    }

    const cappedInput = card.querySelector(".f-block-capped");
    if (cappedInput) leader.capped = cappedInput.checked;

    const resultInput = card.querySelector(".f-block-result");
    if (resultInput) {
      leader.executed = leader.executed || { sets: null, reps: null, load: null };
      leader.executed.reps = resultInput.value.trim() || null;
    }

    const durationInput = card.querySelector(".f-block-duration");
    if (durationInput) leader.executed_duration_min = durationInput.value !== "" ? Number(durationInput.value) : null;

    const notesInput = card.querySelector(".f-block-notes");
    if (notesInput) leader.notes = notesInput.value.trim() || null;
  });
}

/** End (exclusive) of the block starting at `leaderIdx` — the leader plus
 * every following exercise chained to it (`superset_with_previous`). */
function blockEndIndex(exercises, leaderIdx) {
  let end = leaderIdx + 1;
  while (end < exercises.length && exercises[end].superset_with_previous) end++;
  return end;
}

function bindSessionContentEvents() {
  // Format select — shared by a solo exercise's own select (doubles as
  // "turn this into a superset/AMRAP/EMOM/...") and a block header's
  // select (applies to every member at once): both use `.f-block-format`
  // with `data-leader-idx`, see exerciseCardHTML/blockCardHTML.
  document.querySelectorAll(".f-block-format").forEach((sel) => sel.addEventListener("change", () => {
    syncFormIntoSession();
    const leaderIdx = +sel.dataset.leaderIdx;
    const exercises = sessionWorking.session.exercises;
    if (sel.value === "__chain_previous") {
      // Chaîne cet exercice à celui juste au-dessus — voir
      // exerciseCardHTML's `canChainToPrevious`. Le format reste
      // "standard" (déjà le cas ici, cette option n'existe que sur un
      // exercice solo), seul `superset_with_previous` change.
      exercises[leaderIdx].superset_with_previous = true;
      renderSessionContent();
      return;
    }
    const end = blockEndIndex(exercises, leaderIdx);
    const newFormat = sel.value;
    for (let i = leaderIdx; i < end; i++) exercises[i].format = newFormat;
    const leader = exercises[leaderIdx];
    leader.block_meta = newFormat === "standard" ? undefined : (leader.block_meta || defaultBlockMeta(newFormat));
    renderSessionContent();
  }));

  // For Time : bascule le libellé du résultat entre "temps réalisé" et
  // "tours/reps atteints au cap" — re-rendu nécessaire pour que le
  // libellé suive, syncFormIntoSession garde ce qui est déjà tapé partout
  // ailleurs (y compris dans le champ résultat lui-même) avant ça.
  document.querySelectorAll(".f-block-capped").forEach((cb) => cb.addEventListener("change", () => {
    syncFormIntoSession();
    const leaderIdx = +cb.closest(".exercise-block-card").dataset.leaderIdx;
    sessionWorking.session.exercises[leaderIdx].capped = cb.checked;
    renderSessionContent();
  }));

  // Bottom quick-add row — starts a fresh block of the given kind. A
  // superset needs ≥2 exercises to mean anything, so "+ Superset" adds
  // its first pair directly rather than a lone standard exercise the user
  // would then have to somehow chain by hand.
  document.querySelectorAll(".add-block-button").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const exercises = sessionWorking.session.exercises;
    const kind = btn.dataset.addFormat;
    if (kind === "standard") {
      exercises.push(blankExercise());
    } else if (kind === "superset") {
      exercises.push(blankExercise(), blankStationExercise("standard"));
    } else {
      const leader = blankStationExercise(kind);
      leader.superset_with_previous = false;
      leader.block_meta = defaultBlockMeta(kind);
      exercises.push(leader);
    }
    renderSessionContent();
  }));

  // Extends an existing block with one more chained member, right after
  // its current last one — same format as the block, station-empty.
  document.querySelectorAll(".add-station-button").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const exercises = sessionWorking.session.exercises;
    const leaderIdx = +btn.dataset.leaderIdx;
    const insertAt = blockEndIndex(exercises, leaderIdx);
    exercises.splice(insertAt, 0, blankStationExercise(exercises[leaderIdx].format || "standard"));
    renderSessionContent();
  }));

  // Chrono par tour (EMOM/Circuit) — voir "Chrono par tour (blocs
  // EMOM/Circuit)" plus haut pour la logique de stockage.
  document.querySelectorAll(".split-timer-start").forEach((btn) => btn.addEventListener("click", () => {
    const leaderIdx = +btn.dataset.leaderIdx;
    const now = new Date().toISOString();
    setBlockTimerState(sessionWorking.date, leaderIdx, { startedAt: now, lastLapAt: now, laps: [] });
    renderSessionContent();
  }));
  document.querySelectorAll(".split-timer-lap").forEach((btn) => btn.addEventListener("click", () => {
    const leaderIdx = +btn.dataset.leaderIdx;
    const bt = getBlockTimerState(sessionWorking.date, leaderIdx);
    if (!bt) return;
    const now = new Date();
    bt.laps.push(now.getTime() - new Date(bt.lastLapAt).getTime());
    bt.lastLapAt = now.toISOString();
    setBlockTimerState(sessionWorking.date, leaderIdx, bt);
    renderSessionContent();
  }));
  document.querySelectorAll(".split-timer-stop").forEach((btn) => btn.addEventListener("click", () => {
    const leaderIdx = +btn.dataset.leaderIdx;
    const bt = getBlockTimerState(sessionWorking.date, leaderIdx);
    if (!bt) return;
    // Garde tout ce qui a déjà été tapé (notes incluses) avant d'y ajouter
    // le résumé des tours — un "Arrêter" ne doit jamais écraser une note
    // en cours de frappe dans le même bloc.
    syncFormIntoSession();
    const leader = sessionWorking.session.exercises[leaderIdx];
    if (leader && bt.laps.length) {
      const summary = `Tours : ${bt.laps.map((ms) => formatDurationMs(ms)).join(", ")}`;
      leader.notes = leader.notes ? `${leader.notes}\n${summary}` : summary;
    }
    setBlockTimerState(sessionWorking.date, leaderIdx, null);
    renderSessionContent();
  }));

  document.querySelectorAll(".move-up").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-row").dataset.idx;
    const arr = sessionWorking.session.exercises;
    [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
    renderSessionContent();
  }));
  document.querySelectorAll(".move-down").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-row").dataset.idx;
    const arr = sessionWorking.session.exercises;
    [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
    renderSessionContent();
  }));
  document.querySelectorAll(".remove-exercise").forEach((btn) => btn.addEventListener("click", () => {
    syncFormIntoSession();
    const idx = +btn.closest(".exercise-row").dataset.idx;
    const exercises = sessionWorking.session.exercises;
    const removed = exercises[idx];
    // Removing a block leader that still has chained members: promote the
    // next member to leader so the block's timing/result/notes survive
    // rather than silently vanishing with the exercise that carried them.
    if (!removed.superset_with_previous && exercises[idx + 1] && exercises[idx + 1].superset_with_previous) {
      const promoted = exercises[idx + 1];
      promoted.block_meta = removed.block_meta;
      promoted.notes = removed.notes;
      if (removed.executed) promoted.executed = removed.executed;
      promoted.superset_with_previous = false;
    }
    exercises.splice(idx, 1);
    renderSessionContent();
  }));

  // Fait : ajouter/retirer une ligne "série" — voir bindRemoveExecSetRow
  // pour pourquoi ceci reste du DOM pur plutôt qu'un cycle sync+mutate+
  // re-render comme le reste de ce formulaire.
  document.querySelectorAll(".remove-exec-set").forEach(bindRemoveExecSetRow);
  document.querySelectorAll(".add-exec-set").forEach((btn) => btn.addEventListener("click", () => {
    const container = btn.closest(".exec-set-rows");
    const rowCount = container.querySelectorAll(".set-row").length;
    const rowEl = document.createElement("div");
    rowEl.className = "set-row";
    rowEl.innerHTML = `
      <span class="set-row-num">Série ${rowCount + 1}</span>
      <input type="text" inputmode="numeric" class="f-exec-set-reps" placeholder="reps">
      <button type="button" class="icon-button small danger remove-exec-set" title="Retirer cette série" aria-label="Retirer cette série">✕</button>`;
    container.insertBefore(rowEl, btn);
    bindRemoveExecSetRow(rowEl.querySelector(".remove-exec-set"));
    rowEl.querySelector(".f-exec-set-reps").focus();
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

  const startTimerBtn = document.getElementById("start-timer");
  if (startTimerBtn) startTimerBtn.addEventListener("click", () => {
    setSessionTimerStart(sessionWorking.date, new Date().toISOString());
    renderSessionContent();
  });
  const stopTimerBtn = document.getElementById("stop-timer");
  if (stopTimerBtn) stopTimerBtn.addEventListener("click", () => {
    if (!confirm("Terminer la séance ? La durée sera remplie automatiquement (encore modifiable ensuite).")) return;
    const startedAt = getSessionTimerStart(sessionWorking.date);
    syncFormIntoSession(); // garde les autres champs déjà tapés (RPE, notes...) avant d'écraser la durée
    if (startedAt) {
      sessionWorking.session.session_duration_min = Math.max(1, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000));
    }
    setSessionTimerStart(sessionWorking.date, null);
    renderSessionContent();
  });

  document.getElementById("save-session").addEventListener("click", async (e) => {
    syncFormIntoSession();
    const btn = e.currentTarget;
    const statusEl = document.getElementById("session-status");
    if (sessionSaveInFlight) { statusEl.textContent = "Sauvegarde déjà en cours…"; return; }
    btn.disabled = true;
    sessionSaveInFlight = true;
    statusEl.textContent = "Enregistrement…";
    try {
      await saveSession(sessionWorking.weekLabel, sessionWorking.date, sessionWorking.session);
      statusEl.textContent = "Enregistré ✓";
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
      sessionSaveInFlight = false;
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
