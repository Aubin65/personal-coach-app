import { ghGetFile, ghListDir, ghPutFile, ghPutJSON } from "../github-api.js";
import { stale } from "../nav.js";
import { todayISO, localISOWithOffset } from "../date-utils.js";
import { skeletonHTML, escapeHtmlText, escapeAttr } from "../markdown.js";
import { setupMicButton } from "../voice-input.js";
import { dayInitial, shortDateFr } from "./data-viz.js";

const MONTH_NAMES_FR = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]; // fmt: skip

// ============================================================================
// Suivi de performance match (docs/adr/0064) — retour direct : "un vrai
// suivi de performance match... les éléments dont tu as besoin pour établir
// des liens de causes à effet cohérents avec la gestion de ma prépa
// physique". Écrit directement sur la fixture concernée dans
// data/schedule/matches-<saison>[-reserves].json (même fichier que le
// score, mis à jour automatiquement par prompts/match-results.md — voir
// docs/adr/0029) sous une clé `performance`, lue ensuite par
// coach.schedule.recent_played_matches pour les prompts de planification.
// RPE × durée est en plus reporté dans data/health/<date>.json au même
// titre que n'importe quelle séance (voir docs/adr/0011/0050) pour que le
// match compte dans la charge aiguë:chronique — jamais un système de
// charge séparé pour les matchs.
// ============================================================================

const CONTACT_INTENSITIES = [
  { id: "leger", label: "Léger" },
  { id: "modere", label: "Modéré" },
  { id: "intense", label: "Intense" },
];
const CONTACT_LABELS = Object.fromEntries(CONTACT_INTENSITIES.map((c) => [c.id, c.label]));

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
      // "Déjà joué" au sens du composer de performance : today inclus (le
      // match du jour peut déjà être logué le soir même), contrairement à
      // isPast (< today) qui pilote juste le libellé "Résultat à venir".
      const alreadyPlayed = g.date <= today;
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
            ${matchPerformanceHTML(premiere, alreadyPlayed)}
            <div class="calendar-match-detail-row"><span class="format-tag">Réserve</span>${teamRowHtml(reserve, isPast)}</div>
            ${matchPerformanceHTML(reserve, alreadyPlayed)}
          </div>
        </details>`;
    }
  }
  html += "</div>";
  el.innerHTML = html;
  wireMatchPerformanceForms(el);
}

/** Section "Mon match" sous la ligne d'une équipe — seulement si le match
 * est déjà joué et que l'utilisateur y joue réellement (`user_is_playing`,
 * voir docs/adr/0029 : la Réserve l'a toujours à `true`, la Première
 * seulement après la date de reprise). Affiche le résumé déjà logué s'il y
 * en a un (avec un "✏️ Modifier" qui réaffiche le formulaire pré-rempli),
 * sinon directement le formulaire — jamais les deux ouverts en même temps
 * par défaut, pour ne pas surcharger une carte de match déjà repliable. */
function matchPerformanceSummaryHTML(perf) {
  return `
    <div class="match-performance-summary">
      <p class="small">${perf.minutes_played}min · RPE ${perf.rpe} · Contacts ${escapeHtmlText(CONTACT_LABELS[perf.contact_intensity] || perf.contact_intensity || "?")}</p>
      ${perf.notes ? `<p class="small muted">${escapeHtmlText(perf.notes)}</p>` : ""}
      <button type="button" class="primary-button ghost small match-performance-edit">✏️ Modifier</button>
    </div>`;
}

function matchPerformanceHTML(m, alreadyPlayed) {
  if (!alreadyPlayed || !m || !m.user_is_playing) return "";
  const perf = m.performance;
  const intensityChips = CONTACT_INTENSITIES
    .map((c) => `<button type="button" class="suggestion-chip${perf && perf.contact_intensity === c.id ? " active" : ""}" data-intensity="${c.id}">${c.label}</button>`)
    .join("");
  const summaryHTML = perf ? matchPerformanceSummaryHTML(perf) : "";
  return `
    <div class="match-performance" data-date="${escapeAttr(m.date)}" data-opponent="${escapeAttr(m.opponent)}" data-team="${escapeAttr(m.team || "Première")}">
      <p class="small match-performance-title"><strong>Mon match</strong></p>
      <div class="match-performance-summary-slot">${summaryHTML}</div>
      <div class="match-performance-form"${perf ? " hidden" : ""}>
        <div class="exercise-log-grid">
          <div><label>Minutes jouées</label><input type="number" class="mp-minutes" min="0" max="80" step="1" value="${perf ? perf.minutes_played : ""}" placeholder="0-80"></div>
          <div><label>RPE (0-10)</label><input type="number" class="mp-rpe" min="0" max="10" step="1" value="${perf ? perf.rpe : ""}" placeholder="0-10"></div>
          <div><label>Durée totale (min)</label><input type="number" class="mp-duration" min="0" step="5" value="${perf ? perf.duration_min : ""}" placeholder="90"></div>
        </div>
        <p class="small muted" style="margin-top:8px">Intensité des contacts</p>
        <div class="suggestion-chips mp-intensity">${intensityChips}</div>
        <div class="compose-row" style="margin-top:10px">
          <textarea class="mp-notes" rows="3" placeholder="Ressenti physique, poste joué si différent du sien habituel, fait marquant, gêne apparue…">${perf ? escapeHtmlText(perf.notes || "") : ""}</textarea>
          <button type="button" class="mic-button mp-mic" title="Dicter" aria-label="Dicter">🎙️</button>
        </div>
        <p class="voice-hint mp-voice-hint" hidden></p>
        <p class="live-caption mp-live-caption" hidden></p>
        <button type="button" class="primary-button small mp-save" style="margin-top:10px">Enregistrer</button>
        <p class="muted small mp-status"></p>
      </div>
    </div>`;
}

/** Cherche la fixture (date + adversaire + équipe) dans les fichiers
 * `data/schedule/matches-*.json` — jamais un nom de fichier déduit d'une
 * convention (saison/équipe → nom de fichier) : plus robuste si de
 * nouveaux fichiers de saison apparaissent, même principe que le glob déjà
 * utilisé côté Python (`coach.schedule._load_fixtures`). */
async function findScheduleFile(date, opponent, team) {
  const entries = await ghListDir("data/schedule");
  const files = entries.filter((e) => e.type === "file" && e.name.startsWith("matches-") && e.name.endsWith(".json"));
  for (const entry of files) {
    const file = await ghGetFile(entry.path);
    if (!file) continue;
    const season = JSON.parse(file.content);
    const idx = (season.fixtures || []).findIndex((f) => f.date === date && f.opponent === opponent && (f.team || "Première") === team);
    if (idx !== -1) return { path: entry.path, sha: file.sha, season, idx };
  }
  return null;
}

/** Écrit `performance` sur la fixture concernée, et reporte rpe/durée dans
 * data/health/<date>.json comme n'importe quelle séance (docs/adr/0011) —
 * un match compte dans la charge aiguë:chronique exactement comme un
 * entraînement, jamais un système de charge séparé. `source: "match"` sur
 * l'entrée `session_loads` permet de la retrouver et la remplacer (pas la
 * dupliquer) si la performance est modifiée plus tard, sans toucher une
 * éventuelle autre séance loguée le même jour (voir docs/adr/0050) — le
 * champ est ignoré sans risque par coach.workload, qui ne lit que
 * rpe/duration_min. */
async function saveMatchPerformance(date, opponent, team, performance) {
  const found = await findScheduleFile(date, opponent, team);
  if (!found) throw new Error("Match introuvable dans le calendrier.");
  found.season.fixtures[found.idx] = { ...found.season.fixtures[found.idx], performance };
  await ghPutFile(found.path, JSON.stringify(found.season, null, 2), `Match : performance du ${date} (${opponent})`, found.sha);

  await ghPutJSON(`data/health/${date}.json`, { date }, `App : charge du match ${date}`, (current) => {
    const base = current || { date };
    const otherLoads = Array.isArray(base.session_loads)
      ? base.session_loads.filter((l) => l.source !== "match")
      : base.session_rpe != null && base.session_duration_min != null
        ? [{ rpe: base.session_rpe, duration_min: base.session_duration_min }]
        : [];
    const loads = [...otherLoads, { rpe: performance.rpe, duration_min: performance.duration_min, source: "match" }];
    if (loads.length > 1) {
      base.session_loads = loads;
      delete base.session_rpe;
      delete base.session_duration_min;
    } else {
      base.session_rpe = loads[0].rpe;
      base.session_duration_min = loads[0].duration_min;
      delete base.session_loads;
    }
    return base;
  });
}

/** (Re)binds the "✏️ Modifier" click on whatever `.match-performance-edit`
 * currently sits in the card's summary slot — called once at initial
 * render and again after a save replaces that slot's markup (a fresh
 * button element has no listener of its own yet). */
function wireMatchPerformanceEditButton(card) {
  const editBtn = card.querySelector(".match-performance-edit");
  if (!editBtn) return;
  editBtn.addEventListener("click", () => {
    card.querySelector(".match-performance-summary").hidden = true;
    card.querySelector(".match-performance-form").hidden = false;
  });
}

function wireMatchPerformanceForms(el) {
  el.querySelectorAll(".match-performance").forEach((card) => {
    const micBtn = card.querySelector(".mp-mic");
    if (micBtn) {
      setupMicButton(
        micBtn,
        card.querySelector(".mp-voice-hint"),
        card.querySelector(".mp-notes"),
        card.querySelector(".mp-live-caption")
      );
    }

    card.querySelectorAll(".mp-intensity .suggestion-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        card.querySelectorAll(".mp-intensity .suggestion-chip").forEach((c) => c.classList.toggle("active", c === chip));
      });
    });

    wireMatchPerformanceEditButton(card);

    card.querySelector(".mp-save").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const statusEl = card.querySelector(".mp-status");
      const minutesEl = card.querySelector(".mp-minutes");
      const rpeEl = card.querySelector(".mp-rpe");
      const durationEl = card.querySelector(".mp-duration");
      const notesEl = card.querySelector(".mp-notes");
      const activeChip = card.querySelector(".mp-intensity .suggestion-chip.active");
      if (minutesEl.value === "" || rpeEl.value === "" || durationEl.value === "") {
        statusEl.textContent = "Minutes jouées, RPE et durée sont nécessaires (même pour compter dans ta charge).";
        return;
      }
      const performance = {
        minutes_played: Number(minutesEl.value),
        rpe: Number(rpeEl.value),
        duration_min: Number(durationEl.value),
        contact_intensity: activeChip ? activeChip.dataset.intensity : null,
        notes: notesEl.value.trim(),
        logged_at: localISOWithOffset(),
      };
      btn.disabled = true;
      statusEl.textContent = "Enregistrement…";
      try {
        await saveMatchPerformance(card.dataset.date, card.dataset.opponent, card.dataset.team, performance);
        // Patch this one card in place instead of a full renderCalendar():
        // a full re-render would collapse every <details> back shut,
        // including the one the user is actively looking at.
        statusEl.textContent = "";
        card.querySelector(".match-performance-summary-slot").innerHTML = matchPerformanceSummaryHTML(performance);
        card.querySelector(".match-performance-form").hidden = true;
        wireMatchPerformanceEditButton(card);
      } catch (err) {
        statusEl.textContent = `Échec : ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  });
}
