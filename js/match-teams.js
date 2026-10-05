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

let cached = null;

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
  return cached;
}

export async function savePlayingTeams(teams) {
  const clean = ALL_TEAMS.filter((t) => teams.includes(t));
  await ghPutJSON(MATCH_TEAMS_PATH, { teams: ALL_TEAMS }, "App : équipes jouées", (cur) => ({ ...(cur || {}), teams: clean }));
  cached = clean;
}

/** `user_is_playing` d'une fixture, réglage appliqué (pur). */
export function playsIn(fixture, teams) {
  return !!fixture.user_is_playing && teams.includes(fixture.team || "Première");
}
