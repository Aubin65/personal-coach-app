import { skeletonHTML, escapeAttr, escapeHtmlText, renderMarkdown } from "./markdown.js";
import { state, stale, showView } from "./nav.js";
import { lookupDaySummary, findSessionForDate, currentBlockLabel } from "./training-index.js";
import { addDaysISO, formatFrDate, todayISO } from "./date-utils.js";
import { SESSION_TYPES, EXERCISE_FORMATS } from "./session-types.js";
import { ghGetFile } from "./github-api.js";

// ============================================================================
// Weekly plan overview — parses the plan markdown's day headers ("## Lundi
// 21/09 — Bas du corps (...)") and its "Points de vigilance de la semaine"
// list into structured data, for a compact day-strip + key-highlights card
// above the full raw plan text, and to build the week's forecast table.
// ============================================================================
export const DAY_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const DAY_ICONS = {
  rugby: "🏉",
  repos: "😴",
  match: "🏆",
  muscu: "🏋️",
};

export function dayIconFor(title) {
  const t = title.toLowerCase();
  if (/repos/.test(t)) return DAY_ICONS.repos;
  if (/match/.test(t)) return DAY_ICONS.match;
  if (/rugby|club/.test(t)) return DAY_ICONS.rugby;
  return DAY_ICONS.muscu;
}

export function parseWeekOverview(md) {
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

/** Splits a weekly-plan markdown (`data/plans/<lundi>.md` or its pending
 * counterpart) into `{intro, days, footer}` — `intro` is everything before
 * the first day heading (title, rationale paragraph), `days` is one entry
 * per `## <Jour> <date> — <titre>` heading with its **full** section body
 * (heading included, up to but excluding the next top-level heading —
 * unlike `parseWeekOverview`, which only extracts the day/date/title, not
 * the body text itself), and `footer` is whatever follows the last day
 * heading ("## Points de vigilance de la semaine" and beyond). Powers
 * per-day accept/reject of a pending proposal (see
 * `buildMergedWeekPlan`/docs/adr/0057) — "je veux pouvoir valider séance
 * par séance", not just the whole week's prose as one block. */
export function splitWeekPlanByDay(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const dayRe = new RegExp(`^##\\s+(${DAY_NAMES.join("|")})\\s+(\\d{1,2}/\\d{1,2})\\s*[—-]?\\s*(.*)$`);
  const headingIdx = [];
  lines.forEach((l, idx) => { if (/^##\s+/.test(l)) headingIdx.push(idx); });
  const dayHeadingIdx = headingIdx.filter((idx) => dayRe.test(lines[idx]));

  const introEnd = dayHeadingIdx.length ? dayHeadingIdx[0] : lines.length;
  const intro = lines.slice(0, introEnd).join("\n");

  const days = dayHeadingIdx.map((idx) => {
    const m = dayRe.exec(lines[idx]);
    const nextHeading = headingIdx.find((h) => h > idx);
    const end = nextHeading !== undefined ? nextHeading : lines.length;
    return { day: m[1], date: m[2], title: m[3].replace(/\([^)]*\)/g, "").trim(), body: lines.slice(idx, end).join("\n") };
  });

  const lastDayIdx = dayHeadingIdx.length ? dayHeadingIdx[dayHeadingIdx.length - 1] : -1;
  const footerStart = lastDayIdx === -1 ? lines.length : (headingIdx.find((h) => h > lastDayIdx) ?? lines.length);
  const footer = lines.slice(footerStart).join("\n");

  return { intro, days, footer };
}

/** Reassembles a full weekly-plan markdown from `pendingSplit` (see
 * `splitWeekPlanByDay`) keeping only the days named in `acceptedDayNames`
 * (a `Set` of `DAY_NAMES` values) — every other day falls back to its
 * matching entry in `currentSplit` (the already-validated
 * `data/plans/<lundi>.md`, or `null` for a brand-new week with nothing to
 * fall back to). A rejected day with no current version to fall back to is
 * simply omitted, never fabricated — `renderWeekOverview`'s day-strip
 * already tolerates a week with fewer than 7 day headings, and the actual
 * source of truth for what's executed is Sheets/app-log either way (see
 * docs/adr/0019), never this prose. `intro`/`footer` always come from
 * `pendingSplit` — the rationale/vigilance points explain the proposal as
 * a whole, there's no per-day equivalent to select between. */
export function buildMergedWeekPlan(pendingSplit, currentSplit, acceptedDayNames) {
  const dayBodies = pendingSplit.days
    .map((pd) => {
      if (acceptedDayNames.has(pd.day)) return pd.body;
      const cd = currentSplit && currentSplit.days.find((d) => d.day === pd.day);
      return cd ? cd.body : null;
    })
    .filter(Boolean);
  return [pendingSplit.intro, dayBodies.join("\n\n"), pendingSplit.footer]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function normalizeDM(str) {
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
export async function renderWeekOverview(dayStripEl, highlightsEl, markdown, todayISOStr, mondayISO, token) {
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
      const secondaryIcon = summary && summary.secondaryType && SESSION_TYPES[summary.secondaryType]
        ? `<span class="day-icon-secondary" title="+ ${escapeAttr(SESSION_TYPES[summary.secondaryType].label)}">${SESSION_TYPES[summary.secondaryType].icon}</span>`
        : "";
      stripHTML += `
        <button type="button" class="day-card${isToday ? " is-today" : ""}"${iso ? ` data-date="${iso}"` : ""}>
          <div class="day-name">${d.day.slice(0, 3)}</div>
          <div class="day-date">${d.date}</div>
          <div class="day-icon">${icon}${secondaryIcon}</div>
          <div class="day-title">${title.slice(0, 28)}</div>
        </button>`;
    }
    stripHTML += "</div>";
  }
  dayStripEl.innerHTML = stripHTML;
  dayStripEl.querySelectorAll(".day-card[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      dayStripEl.querySelectorAll(".day-card").forEach((c) => c.classList.toggle("is-selected", c === btn));
      showDayOverviewPanel(state.renderToken, btn.dataset.date).catch(() => {});
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
export function formatLoadText(load, perHand) {
  if (load == null || load === "") return null;
  return perHand ? `${load} (par main)` : String(load);
}

export function formatSetsRepsLoad(obj) {
  if (!obj) return "";
  return [obj.sets, obj.reps, formatLoadText(obj.load, obj.load_per_hand)].filter((v) => v != null && v !== "").join(" × ");
}

/** A compact "12min AMRAP" / "EMOM 60s ×10" / "Circuit 3 tours, repos 60s"
 * summary of a block's `block_meta` (leader only) — same fields as
 * BLOCK_TIMING_FIELDS in the editor, read back out for the day overview. */
export function blockMetaSummaryFr(format, meta) {
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
export function blockResultDisplay(format, leader) {
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
export async function showDayOverviewPanel(token, date) {
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
    const secondary = session.secondary;
    const secondaryHTML = secondary
      ? `<div class="day-overview-secondary">
          <p class="small"><strong>${SESSION_TYPES[secondary.type] ? SESSION_TYPES[secondary.type].icon : ""} ${escapeHtmlText(secondary.name || "")}</strong>${secondary.notes ? " — " + escapeHtmlText(secondary.notes) : ""}</p>
          ${!isFuture && (secondary.session_rpe != null || secondary.session_duration_min != null)
            ? `<p class="muted small">${secondary.session_rpe != null ? `RPE ${secondary.session_rpe}` : ""}${secondary.session_rpe != null && secondary.session_duration_min != null ? " · " : ""}${secondary.session_duration_min != null ? `${secondary.session_duration_min} min` : ""}</p>`
            : ""}
        </div>`
      : "";
    el.innerHTML = `
      <section class="card day-overview-card">
        <h2>${SESSION_TYPES[type] ? SESSION_TYPES[type].icon : ""} ${escapeHtmlText(session.name || "Séance")} — ${formatFrDate(date)}</h2>
        ${body}
        ${workload}
        ${secondaryHTML}
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
export function splitBlockMarkdown(md) {
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
export function splitBlockIntro(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const firstHeadingIdx = lines.findIndex((l) => /^##\s+/.test(l));
  if (firstHeadingIdx === -1) return { intro: md, rest: "" };
  return { intro: lines.slice(0, firstHeadingIdx).join("\n"), rest: lines.slice(firstHeadingIdx).join("\n") };
}

/** The markdown under one `##`/`###`/... heading matching `headingRegex`,
 * up to (not including) the next heading of the same or shallower level —
 * null if no heading matches. */
export function extractHeadingSection(md, headingRegex) {
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
export function blockObjectivesSummary(md) {
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
export function digestIconFor(title) {
  const hit = DIGEST_ICONS.find(([re]) => re.test(title));
  return hit ? hit[1] : "📋";
}

export function renderDigestSections(md) {
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

/** Shared "🎯 Objectifs du bloc en cours" collapsible reference, used both
 * in the session view (musculation planning) and in Forge — just the main
 * goals + typical session structure (see blockObjectivesSummary), loaded
 * once per toggle. */
export function bindBlockReferenceToggle(toggleEl, boxEl) {
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
