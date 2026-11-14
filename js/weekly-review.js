import { ghGetFile, ghListDir } from "./github-api.js";
import { addDaysISO, formatFrDate, todayISO } from "./date-utils.js";
import { escapeHtmlText } from "./markdown.js";

// ============================================================================
// Bilan de la semaine (docs/adr/0119) : écrit le lundi 8h par
// `coach.weekly_review` dans data/reviews/<lundi>.json ; carte sur Aujourd'hui
// pendant 6 jours, masquable (« Lu », mémorisé sur cet appareil seulement).
// ============================================================================

const SEEN_KEY = "coach.weeklyReviewSeen";
const SHOW_DAYS = 6;

function seen() { try { return localStorage.getItem(SEEN_KEY); } catch (_) { return null; } }
function markSeen(week) { try { localStorage.setItem(SEEN_KEY, week); } catch (_) { /* stockage indisponible */ } }

const fmtLoad = (r) => `${String(r.to).replace(".", ",")} kg${r.per_hand ? "/main" : ""}`;
const fmtNum = (n) => String(n).replace(".", ",");

/** Corps détaillé du bilan (HTML), exporté pour les tests. */
export function reviewBodyHTML(r) {
  const parts = [];
  const s = r.sessions || {};
  if (s.planned) {
    const missed = (s.missed || []).map((m) => `${escapeHtmlText(m.name)} (${formatFrDate(m.date)})`).join(", ");
    parts.push(`<li><strong>Séances</strong> : ${s.done}/${s.planned} faites${missed ? ` — non loguées : ${missed}` : ""}</li>`);
  }
  const l = r.load || {};
  if (l.week_ua) {
    const delta = l.delta_pct != null ? ` (${l.delta_pct >= 0 ? "+" : ""}${l.delta_pct} % vs semaine d'avant)` : "";
    const zone = l.ratio != null ? ` · ratio aigu/chronique ${fmtNum(l.ratio)}` : "";
    parts.push(`<li><strong>Charge</strong> : ${l.week_ua} UA${delta}${zone}</li>`);
  }
  const up = (r.strength || {}).progressed || [];
  if (up.length) {
    parts.push(`<li><strong>Charges en hausse</strong> : ${up.map((x) => `${escapeHtmlText(x.name)} ${fmtNum(x.from)} → ${fmtLoad(x)}`).join(" · ")}</li>`);
  }
  (r.cardio || []).forEach((c) => {
    if (c.value == null) return;
    const unit = c.metric === "pace_500_s" ? "s/500 m" : "cal/min";
    const better = c.previous == null ? "" : (c.lower_is_better ? c.value < c.previous : c.value > c.previous) ? " ↑" : c.value === c.previous ? " =" : " ↓";
    parts.push(`<li><strong>${escapeHtmlText(c.name)}</strong> : ${fmtNum(c.value)} ${unit}${c.previous != null ? ` (avant : ${fmtNum(c.previous)})` : ""}${better}</li>`);
  });
  (r.matches || []).forEach((m) => {
    const bits = [m.souffle != null ? `souffle ${m.souffle}/5` : "", m.contact != null ? `contact ${m.contact}/5` : "", m.energie != null ? `énergie ${m.energie}/5` : ""].filter(Boolean).join(", ");
    parts.push(`<li><strong>Match</strong> vs ${escapeHtmlText(m.opponent || "?")}${m.minutes ? ` (${m.minutes} min)` : ""}${bits ? ` : ${bits}` : ""}</li>`);
  });
  if (r.sleep_avg_h != null) parts.push(`<li><strong>Sommeil</strong> : ${fmtNum(r.sleep_avg_h)} h en moyenne</li>`);
  const nw = r.next_week || {};
  const hints = (nw.hints || []).map((h) => `${escapeHtmlText(h.name)} ${h.action === "down" ? "↓" : "↑"} ${fmtNum(h.load)} kg`);
  const next = [];
  if (hints.length) next.push(`Charges visées : ${hints.join(" · ")}`);
  if ((nw.team_unset || []).length) next.push("Équipe du week-end à choisir");
  const nextHTML = next.length ? `<p class="small"><strong>Semaine qui vient</strong> : ${next.join(" — ")}</p>` : "";
  return `<ul class="review-list small">${parts.join("")}</ul>${nextHTML}`;
}

/** Dernier bilan de data/reviews/ encore « frais » et non marqué lu. */
export async function latestReview(today = todayISO()) {
  const entries = (await ghListDir("data/reviews")).filter((e) => e.type === "file" && e.name.endsWith(".json")).sort((a, b) => b.name.localeCompare(a.name));
  if (!entries.length) return null;
  const file = await ghGetFile(entries[0].path);
  if (!file) return null;
  let review;
  try { review = JSON.parse(file.content); } catch (_) { return null; }
  if (!review || !review.week_start || review.generated_on < addDaysISO(today, -SHOW_DAYS)) return null;
  return review;
}

export async function renderWeeklyReviewCard(token, isStale, box = document.getElementById("today-weekly-review")) {
  if (!box) return;
  const review = await latestReview();
  if (isStale(token)) return;
  if (!review || seen() === review.week_start) { box.innerHTML = ""; return; }
  box.innerHTML = `<section class="card weekly-review">
    <h2>📊 Bilan de la semaine</h2>
    <p class="muted small">${formatFrDate(review.week_start)} → ${formatFrDate(review.week_end)}</p>
    <p class="weekly-review-headline">${escapeHtmlText(review.headline || "")}</p>
    <details><summary class="small">Voir le détail</summary>${reviewBodyHTML(review)}</details>
    <button type="button" class="primary-button ghost small" data-review-seen>Lu</button>
  </section>`;
  box.querySelector("[data-review-seen]").addEventListener("click", () => { markSeen(review.week_start); box.innerHTML = ""; });
}
