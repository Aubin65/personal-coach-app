import { ghGetFile } from "./github-api.js";
import { addDaysISO, formatFrDate } from "./date-utils.js";
import { findSessionForDate } from "./training-index.js";
import { loadPlayingTeams, playsIn } from "./match-teams.js";
import { blankSecondarySession } from "./session/session-model.js";
import { saveSession } from "./session/session-form.js";

// Primer pré-match (docs/adr/0105) : courte séance de salle, la veille ou le
// matin du match, pour arriver avec de bonnes sensations — activation
// neuromusculaire, jamais de fatigue. Gabarit local (instantané, hors ligne) ;
// les charges restent à saisir ou à demander au coach (composer du jour).

const ex = (name, sets, reps, load, notes, superset = false) => ({
  name, format: "standard",
  planned: { sets, reps, load, load_per_hand: false },
  executed: { sets: null, reps: null, load: null, load_per_hand: false },
  rir: null, notes, superset_with_previous: superset,
});

export const PRIMER_NOTES =
  "Primer : 20-30 min, RIR ≥ 4 partout, jamais à l'échec, vitesse d'exécution maximale, " +
  "repos 90 s-2 min entre séries. Pas d'excentrique lent ni de volume : tu dois sortir plus frais qu'en entrant. " +
  "Un doute sur la forme du jour → saute la dernière série plutôt que d'en rajouter.";

export function primerExercises() {
  return [
    ex("Trap Bar Jump", 3, "3", null, "Charge très légère (≈ 20-30 % de ta charge de travail au Trap Bar Deadlift) ou poids du corps. Réception souple."),
    ex("Trap Bar Deadlift (vitesse)", 2, "3", null, "≈ 60-70 % de ta charge de travail, montée explosive, RIR ≥ 4."),
    ex("Développé couché (vitesse)", 2, "3", null, "≈ 60-70 % de ta charge de travail, descente contrôlée, poussée explosive."),
    ex("Médecine ball scoop toss", 3, "4", 5, "Médecine ball 5 kg, extension complète hanches, lancer maximal."),
    ex("Sled push léger", 3, "10 m", null, "Charge légère, accélération progressive, pas de fatigue résiduelle."),
  ];
}

export function buildPrimerSession(date, existing) {
  const session = {
    name: "Primer match",
    date,
    type: "musculation",
    primer: true,
    exercises: primerExercises(),
    notes: PRIMER_NOTES,
    session_rpe: null,
    session_duration_min: null,
  };
  // Jour déjà rugby (match, entraînement club) : il devient la séance secondaire
  // plutôt que d'être écrasé (ADR-0050).
  if (existing && existing.type === "rugby") {
    session.secondary = {
      ...blankSecondarySession(date, "rugby"),
      name: existing.name || blankSecondarySession(date, "rugby").name,
      notes: existing.notes || "",
      session_rpe: existing.session_rpe ?? null,
      session_duration_min: existing.session_duration_min ?? null,
    };
  } else if (existing && existing.secondary) {
    session.secondary = existing.secondary;
  }
  return session;
}

/** Dates (ISO) des matchs que tu joues, à partir de hier. */
export async function loadPlayedMatchDates(today) {
  const file = await ghGetFile("data/app/summary.json");
  if (!file) return new Set();
  let summary;
  try { summary = JSON.parse(file.content); } catch (_) { return new Set(); }
  const teams = await loadPlayingTeams();
  const from = addDaysISO(today, -1);
  return new Set((summary.season_matches || [])
    .filter((m) => m.date >= from && playsIn(m, teams))
    .map((m) => m.date));
}

/** "veille" | "jour_j" | null pour une date. */
export function primerKind(date, matchDates) {
  if (matchDates.has(date)) return "jour_j";
  if (matchDates.has(addDaysISO(date, 1))) return "veille";
  return null;
}

/** Ajoute le primer à `date`. Renvoie la séance écrite, ou null si refusé. */
export async function addPrimer(date) {
  const found = await findSessionForDate(date);
  const existing = found.session;
  if (existing && existing.primer) return null; // déjà là
  if (existing && existing.type === "musculation" && (existing.exercises || []).some((e) => e.planned && (e.planned.sets || e.planned.reps))) {
    if (!window.confirm(`Remplacer la séance de musculation du ${formatFrDate(date)} (${existing.name}) par un primer ?`)) return null;
  }
  const session = buildPrimerSession(date, existing && existing.type === "musculation" ? null : existing);
  await saveSession(found.weekLabel || "app", date, session);
  return session;
}
