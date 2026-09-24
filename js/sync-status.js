import { ghGetFile } from "./github-api.js";
import { shortDateFr } from "./views/data-viz.js";

// ============================================================================
// Last-sync indicator — persistent in the topbar (outside #content, so it
// survives navigation instead of needing to be re-fetched/shown per view)
// ============================================================================
/** "il y a 5 min" / "il y a 3 h" / "le 23/09 à 08:32" from an ISO
 * timestamp — a bare timestamp doesn't answer "is this actually fresh?"
 * at a glance. */
export function relativeSyncText(isoTimestamp) {
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
export async function loadSyncStatus() {
  const el = document.getElementById("topbar-sync-status");
  if (!el) return;
  try {
    const file = await ghGetFile("data/app/summary.json");
    const summary = file ? JSON.parse(file.content) : null;
    el.textContent = summary && summary.generated_at ? `Synchro ${relativeSyncText(summary.generated_at)}` : "";
  } catch (_) { /* leave the indicator as-is */ }
}
