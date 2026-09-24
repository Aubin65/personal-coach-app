// Shared domain constants for session types/exercise formats — used by the
// plan overview (day-strip/day-overview panel), the Semaine/Forge listing
// views and the session editor. Kept in one leaf module (no imports of its
// own) so every consumer can import it without risking a circular
// dependency.
export const SESSION_TYPES = {
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
export const EXERCISE_FORMATS = {
  standard: "Standard",
  amrap: "AMRAP",
  for_time: "For Time",
  emom: "EMOM",
  circuit: "Circuit",
  other: "Autre format",
};

// Which `block_meta` fields a format's block header exposes, and how —
// "standard" (superset) and "other" show none, a plain chained list is
// self-explanatory enough on its own. Field keys match `blankBlockMeta`.
export const BLOCK_TIMING_FIELDS = {
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
export const BLOCK_RESULT_LABELS = {
  amrap: "Résultat (ex. 6 tours + 4 reps)",
  emom: "Résultat (ex. tous les tours tenus)",
  circuit: "Résultat (ex. 3 tours en 14min)",
  for_time: "Temps réalisé (ex. 9:24)",
  other: "Résultat",
};

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
export const SECONDARY_SESSION_TYPES = ["rugby", "autre"];
