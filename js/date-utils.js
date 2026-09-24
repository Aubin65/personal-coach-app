// ============================================================================
// Date / file-picking helpers — mirrors coach.dashboard_data's logic
// (latest_digest / current_plan / current_block / today_session) in JS,
// since the app has no Python runtime of its own.
// ============================================================================
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function localISOWithOffset() {
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
export function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** The Monday (ISO) of the week containing `iso`. */
export function mondayOfWeek(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const offset = (date.getUTCDay() + 6) % 7; // days since Monday (getUTCDay: 0=Sun..6=Sat)
  date.setUTCDate(date.getUTCDate() - offset);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function formatFrDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

/** true for a Saturday/Sunday ISO date. */
export function isWeekendISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return dow === 0 || dow === 6;
}

/** Whether a session counts as actually done — a rugby/autre session
 * counts once it has a note, a musculation one once any exercise has a
 * real executed value. Mirrors coach.app_export._session_has_executed
 * (Python) exactly — kept in sync by hand on both sides, since the app
 * has no Python runtime of its own to share the logic with. */
export function sessionHasExecuted(session) {
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
export function sessionIsBlankSkeleton(session) {
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
export function sessionDayStatus(date, hasSession, hasExecuted, today) {
  if (date > today) return hasSession ? "📝 Planifié" : "⏳ À venir";
  if (hasExecuted) return "✅ Fait";
  if (hasSession) return "📝 Planifié";
  return "— Non loggé";
}
