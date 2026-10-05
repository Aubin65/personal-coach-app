import { ghGetFile, ghPutJSON } from "./github-api.js";

// ============================================================================
// Entraînements club par défaut (docs/adr/0087) — retour d'Aubin : « pars du
// principe que mes entraînements sont le mercredi et le vendredi, je dois
// pouvoir le modifier si exceptionnellement j'ai une annulation ou un
// déplacement ». Réglage unique `data/config/club-training.json`
// (`weekdays` en jours ISO : 1 = lundi … 7 = dimanche, `since` = premier jour
// concerné, pour ne pas inventer d'historique). Lu par l'app et par
// coach.log_reminder.
//
// Un jour de club SANS séance enregistrée compte comme un entraînement rugby
// « virtuel » (rien n'est écrit tant qu'on ne logue pas). Annulation = poser
// « Repos » sur le jour (icônes de la Forge, ou « Annulé » dans Aujourd'hui) ;
// déplacement = annuler + poser « Rugby » sur un autre jour : toute séance
// réelle d'une date l'emporte sur le défaut.
// ============================================================================

export const CLUB_CONFIG_PATH = "data/config/club-training.json";
export const DEFAULT_CLUB_CONFIG = { weekdays: [3, 5], since: "2026-10-05", name: "Entraînement club" };

let cached = null;

export async function loadClubConfig() {
  if (cached) return cached;
  let cfg = {};
  try {
    const file = await ghGetFile(CLUB_CONFIG_PATH);
    if (file) cfg = JSON.parse(file.content) || {};
  } catch (_) { cfg = {}; }
  cached = {
    weekdays: Array.isArray(cfg.weekdays) ? cfg.weekdays.filter((d) => d >= 1 && d <= 7) : DEFAULT_CLUB_CONFIG.weekdays,
    since: cfg.since || DEFAULT_CLUB_CONFIG.since,
    name: cfg.name || DEFAULT_CLUB_CONFIG.name,
  };
  return cached;
}

export async function saveClubWeekdays(weekdays) {
  await ghPutJSON(CLUB_CONFIG_PATH, DEFAULT_CLUB_CONFIG, "App : jours d'entraînement club", (cur) => ({
    ...DEFAULT_CLUB_CONFIG,
    ...(cur || {}),
    weekdays: [...weekdays].sort((a, b) => a - b),
  }));
  cached = null;
}

function isoWeekday(date) {
  const d = new Date(`${date}T12:00:00`).getDay();
  return d === 0 ? 7 : d;
}

/** Cette date est-elle un jour de club par défaut ? (sans regarder les séances) */
export async function isClubDay(date) {
  const cfg = await loadClubConfig();
  return date >= cfg.since && cfg.weekdays.includes(isoWeekday(date));
}
