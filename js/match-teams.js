import { ghGetFile, ghPutJSON } from "./github-api.js";

// ============================================================================
// Équipe(s) dans laquelle Aubin joue (docs/adr/0095). Avant : toute la Réserve
// comptait comme « tu joues » (ADR-0029), d'où des rappels et des fiches de
// ressenti pour des matchs qu'il n'a pas disputés. Réglage unique
// `data/config/match-teams.json` (`teams` : « Première », « Réserve »),
// écrit par l'app seule, lu aussi par coach.schedule. La date de retour en
// Première (`user_return_to_play_date` du calendrier) continue de s'appliquer.
// ============================================================================

export const MATCH_TEAMS_PATH = "data/config/match-teams.json";
export const ALL_TEAMS = ["Première", "Réserve"];
// Choix par week-end (docs/adr/0118) : `{overrides: {"2026-11-15": "Réserve" | "aucune"}}`,
// prioritaire sur le réglage général ; lu aussi par coach.schedule.
export const MATCH_WEEKS_PATH = "data/config/match-weeks.json";
export const NO_TEAM = "aucune";

let cached = null;
let overridesCache = {};

/** Équipes jouées ; sans fichier, les deux (comportement d'avant). */
export async function loadPlayingTeams() {
  if (cached) return cached;
  let teams = ALL_TEAMS;
  try {
    const file = await ghGetFile(MATCH_TEAMS_PATH);
    const cfg = file ? JSON.parse(file.content) : null;
    if (cfg && Array.isArray(cfg.teams)) teams = cfg.teams.filter((t) => ALL_TEAMS.includes(t));
  } catch (_) { /* réglage illisible : défaut */ }
  cached = teams;
  try {
    const file = await ghGetFile(MATCH_WEEKS_PATH);
    const cfg = file ? JSON.parse(file.content) : null;
    overridesCache = cfg && cfg.overrides && typeof cfg.overrides === "object" ? cfg.overrides : {};
  } catch (_) { overridesCache = {}; }
  return cached;
}

/** Choix du week-end (`{date: équipe | "aucune"}`), tel que chargé. */
export function weekOverrides() {
  return overridesCache;
}

/** Fixe (ou efface, `choice = null`) la équipe jouée à une date de match. */
export async function saveWeekTeam(date, choice, today) {
  const cutoff = new Date(`${today}T12:00:00`);
  cutoff.setDate(cutoff.getDate() - 30);
  const keep = cutoff.toISOString().slice(0, 10);
  const next = await ghPutJSON(MATCH_WEEKS_PATH, { overrides: {} }, "App : équipe du week-end", (cur) => {
    const overrides = { ...((cur && cur.overrides) || {}) };
    if (choice) overrides[date] = choice; else delete overrides[date];
    for (const d of Object.keys(overrides)) if (d < keep) delete overrides[d]; // purge > 30 j
    return { ...(cur || {}), overrides };
  });
  overridesCache = next.overrides || {};
  return overridesCache;
}

export async function savePlayingTeams(teams) {
  const clean = ALL_TEAMS.filter((t) => teams.includes(t));
  await ghPutJSON(MATCH_TEAMS_PATH, { teams: ALL_TEAMS }, "App : équipes jouées", (cur) => ({ ...(cur || {}), teams: clean }));
  cached = clean;
}

/** `user_is_playing` d'une fixture, réglage appliqué (pur). */
export function playsIn(fixture, teams, overrides = overridesCache) {
  const choice = overrides && overrides[fixture.date];
  if (choice) return choice !== NO_TEAM && (fixture.team || "Première") === choice;
  return !!fixture.user_is_playing && teams.includes(fixture.team || "Première");
}
