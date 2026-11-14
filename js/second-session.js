// Enchaînement des deux séances d'un même jour (docs/adr/0117) : une fois le
// RPE + la durée de la séance de salle notés, on propose tout de suite ceux de
// la 2e (club du soir, footing…) au lieu de les laisser dans « À faire ».
import { openRpeSheet } from "./rpe-sheet.js";
import { clubSecondarySession } from "./training-index.js";
import { todayISO, addDaysISO } from "./date-utils.js";
import { ghPutJSON } from "./github-api.js";

/** La 2e séance a-t-elle déjà pu avoir lieu ? Le club du soir n'est pas
 * proposé le midi du jour même : avant 19 h, on ne demande rien. */
export function secondaryHasHappened(date, now = new Date()) {
  const today = todayISO();
  if (date < today) return true;
  if (date > today) return false;
  return now.getHours() >= 19;
}

/** 2e séance à noter pour ce jour : l'existante sans charge, ou le club
 * attendu (jour de club occupé par la salle). `null` sinon. */
export async function pendingSecondary(date, session, clubExpected) {
  if (!session || ["repos", "rugby"].includes(session.type || "musculation")) return null;
  const sec = session.secondary;
  if (sec) return sec.session_rpe != null && sec.session_duration_min != null ? null : sec;
  return clubExpected ? clubSecondarySession(date) : null;
}

/** Propose RPE + durée de la 2e séance si elle est à noter et déjà passée.
 * `save(session)` écrit la séance complète ; renvoie la séance mise à jour
 * ou `null` (rien à noter, ou fermé avec « Plus tard »). */
export async function chainSecondaryLoad({ date, session, clubExpected = false, save, now = new Date() }) {
  if (!secondaryHasHappened(date, now)) return null;
  const base = await pendingSecondary(date, session, clubExpected);
  if (!base) return null;
  const result = await openRpeSheet({
    title: `Et ${base.type === "rugby" ? "l'entraînement club" : "ta 2e séance"} ? — ${base.name || "2e séance"}`,
    defaultRpe: base.session_rpe ?? null,
    defaultDuration: base.session_duration_min ?? null,
  });
  if (!result) return null;
  const updated = { ...session, secondary: { ...base, session_rpe: result.rpe, session_duration_min: result.duration } };
  await save(updated);
  return updated;
}

/** « Ignorer » d'un élément d'« À faire » (docs/adr/0118) : aussi écrit côté
 * dépôt (`data/config/log-dismissed.json`, `{date: ["main"|"second"|"match"]}`)
 * pour que le rappel du soir ne le relance plus. Meilleur effort : l'ignorer
 * local (localStorage) a déjà eu lieu. */
export async function dismissOnServer(date, slot) {
  const keep = addDaysISO(todayISO(), -14);
  await ghPutJSON("data/config/log-dismissed.json", {}, "App : élément ignoré", (cur) => {
    const next = { ...(cur || {}) };
    next[date] = [...new Set([...(next[date] || []), slot])];
    for (const d of Object.keys(next)) if (d < keep) delete next[d];
    return next;
  });
}
