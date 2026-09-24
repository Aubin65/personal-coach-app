import { ghGetFile, ghListDir } from "./github-api.js";
import { sessionHasExecuted } from "./date-utils.js";

/** Most recent entry in a directory listing whose name (minus extension)
 * is <= today — mirrors latest_digest/current_plan's file-picking. */
export async function latestFileOnOrBefore(dirPath, ext, today) {
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

export function invalidateAppLogIndex() {
  appLogIndexCache = null;
}

export async function loadSummaryIndex() {
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

export async function loadAppLogIndex() {
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
export async function currentBlockLabel() {
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
export async function lookupDaySummary(date) {
  const appLogIndex = await loadAppLogIndex();
  const appLogHit = appLogIndex.get(date);
  if (appLogHit) {
    const s = appLogHit.session;
    // secondaryType only ever comes from the live app-log scan — a
    // secondary session is an app-only concept (see blankSecondarySession,
    // docs/adr/0050), never present in the Sheets-sourced summary index.
    return { date, name: s.name, type: s.type, hasSession: true, hasExecuted: sessionHasExecuted(s), secondaryType: s.secondary ? s.secondary.type : null };
  }
  const summaryIndex = await loadSummaryIndex();
  const hit = summaryIndex.get(date);
  if (hit) return { date, name: hit.name, type: hit.type, hasSession: true, hasExecuted: !!hit.has_executed, secondaryType: null };
  return { date, name: null, type: null, hasSession: false, hasExecuted: false, secondaryType: null };
}

/** {weekLabel, path, session} with the FULL session for `date` — fetches
 * at most one extra file beyond the two indexes (the exact Sheets week
 * file the summary index points to), never a scan. `session: null` with a
 * best-guess weekLabel (most recent seen) when nothing is dated `date`
 * yet, for creating a brand-new session there. Used when actually opening
 * a day (renderSession, Forge's quick-set/skeleton, the prefill picker's
 * clone action) — listing views should use lookupDaySummary instead. */
export async function findSessionForDate(date) {
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
export async function listAllSessions() {
  const [appLogIndex, summaryIndex] = await Promise.all([loadAppLogIndex(), loadSummaryIndex()]);
  const byDate = new Map();
  for (const [date, hit] of summaryIndex) byDate.set(date, { date, name: hit.name, type: hit.type });
  for (const [date, entry] of appLogIndex) byDate.set(date, { date, name: entry.session.name, type: entry.session.type });
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}
