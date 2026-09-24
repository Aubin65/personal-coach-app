import { isWeekendISO } from "../date-utils.js";
import { SESSION_TYPES } from "../session-types.js";

// Reachable from Aujourd'hui ("Loguer la séance", aujourd'hui), un jour du
// day-strip Semaine, une case de Forge (n'importe quelle semaine), ou une
// entrée d'Historique. `sessionRuntime.working` (session/session-state.js)
// est la copie en mémoire éditée — rien n'est écrit sur GitHub avant
// "Enregistrer la séance". Trois types de séance (session.type) :
// musculation (exercices structurés, réordonnables, formats AMRAP/For
// Time/EMOM/superset/etc. — voir EXERCISE_FORMATS), rugby et autre
// (course, rando...) qui se résument à une simple description libre,
// volontairement peu contraignante — voir docs/adr/0018.

/** `ex.superset_with_previous` doubles as the generic "chained into the
 * same physical block as the previous exercise" flag — a "block" (see
 * groupExercisesIntoBlocks) is one leader (superset_with_previous falsy)
 * followed by zero or more chained members. A superset is simply a block
 * whose format is "standard"; AMRAP/EMOM/Circuit/For Time/Autre blocks
 * use the exact same chaining mechanism, just with block-level timing
 * (`block_meta`, leader only) and lightweight per-station rows instead of
 * a full planned/executed grid on every member — see docs/adr/0036. */
export function blankExercise() {
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
export function blankStationExercise(format) {
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

export function blankBlockMeta() {
  return { duration_min: null, round_seconds: null, rounds: null, rest_seconds: null };
}

/** Sensible starting values so a freshly-added AMRAP/EMOM/Circuit block
 * isn't blank fields the user has to fill in from nothing — a genuine
 * common-case default (12min AMRAP, 60s×10 EMOM, 3 tours de circuit),
 * always editable afterwards. */
export function defaultBlockMeta(format) {
  const meta = blankBlockMeta();
  if (format === "amrap") meta.duration_min = 12;
  else if (format === "emom") { meta.round_seconds = 60; meta.rounds = 10; }
  else if (format === "circuit") { meta.rounds = 3; meta.rest_seconds = 60; }
  return meta;
}

/** [[idx, idx, ...], ...] — one array of flat-`exercises` indices per
 * block: a leader (`superset_with_previous` falsy, or idx 0) followed by
 * its chained members. */
export function groupExercisesIntoBlocks(exercises) {
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
export function defaultSessionName(date, type) {
  if (type === "rugby") return isWeekendISO(date) ? "Match" : "Entraînement club";
  return SESSION_TYPES[type].label;
}

export function blankSession(date, type) {
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

/** A second, independent activity on the same date (direct request: "je
 * dois avoir la possibilité de faire deux séances par jour, par exemple si
 * je vais à la salle le midi et au rugby le soir") — deliberately scoped
 * to rugby/autre (see docs/adr/0050): the concrete case is always
 * musculation (the primary session, already full-featured) plus a second
 * simple activity, never two structured exercise lists to reconcile in one
 * day. Lives on the primary session as `session.secondary` rather than a
 * second top-level entry in `sessions[]` — every index (app-log Map keyed
 * by date, coach.progression.session_on, the precomputed summary index...)
 * assumes one record per date; nesting avoids touching any of that. */
export function blankSecondarySession(date, type) {
  return {
    name: defaultSessionName(date, type),
    type,
    notes: "",
    session_rpe: null,
    session_duration_min: null,
    distance_km: type === "autre" ? null : undefined,
  };
}
