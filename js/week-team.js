import { ghGetFile } from "./github-api.js";
import { addDaysISO, todayISO } from "./date-utils.js";
import { escapeHtmlText } from "./markdown.js";
import { ALL_TEAMS, NO_TEAM, loadPlayingTeams, weekOverrides, saveWeekTeam } from "./match-teams.js";

// ============================================================================
// Équipe du week-end en un tap (docs/adr/0118). Le réglage général « je joue
// en… » ne dit pas ce qui se passe CE week-end (Première ou Réserve, ou rien) :
// un tap par semaine, sur Aujourd'hui, et tout le reste suit (fiche de
// ressenti, primer, rappels, planning) via playsIn / coach.schedule.
// ============================================================================

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** Prochaine date de match (aujourd'hui compris) dans les 8 jours et ses
 * adversaires, depuis summary.json ; `null` sinon. */
export async function nextMatchDay(today = todayISO()) {
  const file = await ghGetFile("data/app/summary.json");
  if (!file) return null;
  let summary;
  try { summary = JSON.parse(file.content); } catch (_) { return null; }
  const limit = addDaysISO(today, 8);
  const upcoming = (summary.season_matches || []).filter((m) => m.date >= today && m.date <= limit).sort((a, b) => a.date.localeCompare(b.date));
  if (!upcoming.length) return null;
  const date = upcoming[0].date;
  const same = upcoming.filter((m) => m.date === date);
  return { date, opponent: (same.find((m) => m.team !== "Réserve") || same[0]).opponent, teams: [...new Set(same.map((m) => m.team || "Première"))] };
}

/** Choix en cours : l'équipe, `"aucune"`, ou `null` (pas encore choisi). */
export function currentChoice(date) {
  return weekOverrides()[date] || null;
}

/** Trois puces : Première · Réserve · Pas ce week-end. */
export function weekTeamChipsHTML(date, choice) {
  const chip = (value, label) => `<button type="button" class="suggestion-chip${choice === value ? " active" : ""}" data-week-team="${escapeHtmlText(value)}" data-week-date="${date}" aria-pressed="${choice === value}">${escapeHtmlText(label)}</button>`;
  return `<div class="week-team-chips">${ALL_TEAMS.map((t) => chip(t, t)).join("")}${chip(NO_TEAM, "Pas ce week-end")}</div>`;
}

/** Branche les puces de `scope` : un tap enregistre, retap sur la puce active
 * efface le choix. `onChange` re-rend l'appelant. */
export function wireWeekTeamChips(scope, onChange) {
  scope.querySelectorAll("[data-week-team]").forEach((btn) => btn.addEventListener("click", async () => {
    const date = btn.dataset.weekDate;
    const value = btn.dataset.weekTeam;
    const next = currentChoice(date) === value ? null : value;
    scope.querySelectorAll("[data-week-team]").forEach((b) => (b.disabled = true));
    try {
      await saveWeekTeam(date, next, todayISO());
      await onChange();
    } catch (err) {
      scope.querySelectorAll("[data-week-team]").forEach((b) => (b.disabled = false));
      const status = scope.querySelector(".week-team-status");
      if (status) status.textContent = `Échec : ${err.message}`;
    }
  }));
}

/** Carte d'Aujourd'hui : demande l'équipe tant qu'elle n'est pas choisie,
 * puis une ligne compacte « ✓ Dimanche : Réserve ». */
export async function renderWeekTeamCard(token, isStale, box = document.getElementById("today-week-team")) {
  if (!box) return;
  await loadPlayingTeams();
  const match = await nextMatchDay();
  if (isStale(token)) return;
  if (!match) { box.innerHTML = ""; return; }
  const choice = currentChoice(match.date);
  const day = DAYS[new Date(`${match.date}T12:00:00`).getDay()];
  const label = choice === NO_TEAM ? "pas de match" : choice;
  box.innerHTML = choice
    ? `<section class="card week-team week-team-set"><span>✓ <strong>${day}</strong> vs ${escapeHtmlText(match.opponent || "?")} : ${escapeHtmlText(label)}</span><button type="button" class="live-link" data-week-edit>Modifier</button></section>`
    : `<section class="card week-team">
        <p class="week-team-title"><strong>${day}</strong> vs ${escapeHtmlText(match.opponent || "?")} — tu joues en quoi ?</p>
        ${weekTeamChipsHTML(match.date, choice)}
        <p class="muted small week-team-status" aria-live="polite">Un tap : fiche de ressenti, primer et rappels s'alignent.</p>
      </section>`;
  const rerender = () => renderWeekTeamCard(token, isStale, box);
  const edit = box.querySelector("[data-week-edit]");
  if (edit) edit.addEventListener("click", () => {
    box.innerHTML = `<section class="card week-team"><p class="week-team-title"><strong>${day}</strong> vs ${escapeHtmlText(match.opponent || "?")}</p>${weekTeamChipsHTML(match.date, choice)}<p class="muted small week-team-status" aria-live="polite"></p></section>`;
    wireWeekTeamChips(box, rerender);
  });
  wireWeekTeamChips(box, rerender);
}
