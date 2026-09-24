import { ghGetFile } from "../github-api.js";
import { stale } from "../nav.js";
import { todayISO } from "../date-utils.js";
import { skeletonHTML, escapeHtmlText } from "../markdown.js";
import { dayInitial, shortDateFr } from "./data-viz.js";

const MONTH_NAMES_FR = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]; // fmt: skip

/** "Septembre 2026" from an ISO date's year/month — the month-group
 * header for the Calendrier tab. */
function monthLabelFr(iso) {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTH_NAMES_FR[m - 1]} ${y}`;
}

/** "Matchs" tab — the whole season's fixtures (`season_matches`, past and
 * future), grouped by month, distinct from the short "next 3" preview in
 * Data: a full-year view was asked for explicitly, so this is not a
 * truncated list. Past matches are dimmed, the next one the user actually
 * plays is highlighted — "de manière ergonomique" means scannable at a
 * glance, not a raw dump of the schedule file. */
export async function renderCalendar(token) {
  const el = document.getElementById("calendar-content");
  el.innerHTML = skeletonHTML();
  const file = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  if (!file) { el.innerHTML = "<p class='muted'>Pas encore de résumé exporté.</p>"; return; }
  const s = JSON.parse(file.content);
  const matches = s.season_matches || [];
  if (!matches.length) { el.innerHTML = "<p class='muted'>Aucun match dans le calendrier de la saison.</p>"; return; }

  const today = todayISO();
  // "Prochain match" ne veut dire que la Première ici — les fixtures
  // Réserve (voir docs/adr/0029) portent toujours user_is_playing: true
  // (pas de notion de reprise en match pour elles) et fausseraient sinon
  // ce repère, pensé pour "quand est-ce que je rejoue moi-même".
  const ownMatches = matches.filter((m) => m.team !== "Réserve");
  const nextPlayed = ownMatches.find((m) => m.date >= today && m.user_is_playing);
  const nextAny = ownMatches.find((m) => m.date >= today);
  const nextDate = (nextPlayed || nextAny || {}).date;

  // Une même rencontre (date + adversaire) est jouée séparément par la
  // Première et la Réserve (voir docs/adr/0029) — regrouper les deux en
  // une seule ligne dépliable plutôt que deux lignes quasi identiques,
  // surtout indiscernables tant qu'aucun résultat n'est encore connu.
  const groups = new Map();
  for (const m of matches) {
    const key = `${m.date}|${m.opponent}`;
    if (!groups.has(key)) groups.set(key, { date: m.date, opponent: m.opponent, home_away: m.home_away, phase: m.phase, byTeam: {} });
    groups.get(key).byTeam[m.team || "Première"] = m;
  }

  const byMonth = new Map();
  for (const g of groups.values()) {
    const key = g.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(g);
  }

  // Résultat (score_for/score_against/result) rempli automatiquement chaque
  // lundi par prompts/match-results.md une fois le match joué — absent tant
  // que le score n'est pas encore connu, même pour un match déjà passé
  // (page pas encore lisible cette semaine-là) — voir docs/adr/0029.
  const teamRowHtml = (m, isPast) => {
    if (!m) return "<span class='muted small'>Non communiqué</span>";
    const hasScore = m.score_for != null && m.score_against != null;
    const resultClass = m.result === "victoire" ? "is-win" : m.result === "défaite" ? "is-loss" : m.result === "nul" ? "is-draw" : "";
    const scoreHtml = hasScore
      ? `<span class="calendar-match-score ${resultClass}">${m.score_for}-${m.score_against}</span>`
      : `<span class="muted small">${isPast ? "Résultat à venir" : "À venir"}</span>`;
    const note = m.user_is_playing ? "" : " <span class='muted small'>· tu ne joues pas encore</span>";
    return scoreHtml + note;
  };

  let html = "<div class='calendar-list'>";
  for (const monthGroups of byMonth.values()) {
    html += `<div class="calendar-month-label">${monthLabelFr(monthGroups[0].date)}</div>`;
    for (const g of monthGroups) {
      const isPast = g.date < today;
      const isNext = g.date === nextDate;
      const premiere = g.byTeam["Première"];
      const reserve = g.byTeam["Réserve"];
      const anyScore = [premiere, reserve].some((m) => m && m.score_for != null && m.score_against != null);
      const summaryStatus = anyScore ? "🏉" : isPast ? "✓" : isNext ? "▶" : "";
      html += `
        <details class="calendar-match${isPast ? " is-past" : ""}${isNext ? " is-next" : ""}">
          <summary class="calendar-match-summary">
            <div class="calendar-match-date">
              <span class="calendar-match-day">${dayInitial(g.date)}</span>
              <span class="calendar-match-dm">${shortDateFr(g.date)}</span>
            </div>
            <div class="calendar-match-info">
              <div class="calendar-match-opponent">${escapeHtmlText(g.opponent)}</div>
              <div class="calendar-match-meta">${escapeHtmlText(g.home_away)} · ${escapeHtmlText(g.phase)}</div>
            </div>
            <div class="calendar-match-status">${summaryStatus}</div>
            <span class="calendar-match-chevron">▾</span>
          </summary>
          <div class="calendar-match-detail">
            <div class="calendar-match-detail-row"><span class="format-tag">Première</span>${teamRowHtml(premiere, isPast)}</div>
            <div class="calendar-match-detail-row"><span class="format-tag">Réserve</span>${teamRowHtml(reserve, isPast)}</div>
          </div>
        </details>`;
    }
  }
  html += "</div>";
  el.innerHTML = html;
}
