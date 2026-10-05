import { ghGetFile, ghListDir } from "./github-api.js";
import { escapeHtmlText } from "./markdown.js";

// ============================================================================
// Fiche de ressenti après match (docs/adr/0094) — objectif écrit dans B5 :
// « recueillir un ressenti après chaque match (contact, fatigue,
// conditionnement) pour orienter B6 ». Trois échelles 1-5, toujours dans le
// même sens (1 = mauvais, 5 = très bien), stockées dans
// `fixture.performance.feel` et comptées ×3 par coach.feelings.
// ============================================================================

export const MATCH_FEEL_SCALES = [
  { key: "contact", label: "Contact", low: "Subi", high: "Dominant" },
  { key: "energie", label: "Énergie", low: "Cuit", high: "Frais" },
  { key: "souffle", label: "Souffle", low: "À la peine", high: "Facile" },
];

export function feelScalesHTML(feel = {}) {
  return MATCH_FEEL_SCALES.map((s) => `
    <div class="feel-row">
      <div class="feel-row-head"><span class="feel-label">${s.label}</span><span class="feel-anchors">1 ${escapeHtmlText(s.low)} · 5 ${escapeHtmlText(s.high)}</span></div>
      <div class="feel-chips">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="feel-chip${feel && feel[s.key] === n ? " active" : ""}" data-feel-key="${s.key}" data-feel-value="${n}" aria-label="${s.label} ${n} sur 5">${n}</button>`).join("")}</div>
    </div>`).join("");
}

export function wireFeelScales(root) {
  root.querySelectorAll(".feel-chip").forEach((chip) => chip.addEventListener("click", () => {
    root.querySelectorAll(`.feel-chip[data-feel-key="${chip.dataset.feelKey}"]`).forEach((c) => c.classList.toggle("active", c === chip));
  }));
}

/** `{contact, energie, souffle}` des échelles cochées, ou null si aucune. */
export function readFeel(root) {
  const feel = {};
  for (const s of MATCH_FEEL_SCALES) {
    const chip = root.querySelector(`.feel-chip.active[data-feel-key="${s.key}"]`);
    if (chip) feel[s.key] = Number(chip.dataset.feelValue);
  }
  return Object.keys(feel).length ? feel : null;
}

export function feelSummaryText(feel) {
  if (!feel) return "";
  return MATCH_FEEL_SCALES.filter((s) => feel[s.key] != null).map((s) => `${s.label} ${feel[s.key]}/5`).join(" · ");
}

const DISMISS_KEY = (date) => `coach_match_feel_skip_${date}`;
export function dismissMatchFeel(date) {
  try { localStorage.setItem(DISMISS_KEY(date), "1"); } catch (_) { /* confort seulement */ }
}
function dismissed(date) {
  try { return localStorage.getItem(DISMISS_KEY(date)) === "1"; } catch (_) { return false; }
}

/** Pur : parmi les fixtures `{date, team, opponent, performance, user_is_playing}`,
 * le match à faire noter — joué dans les `days` derniers jours (le jour même
 * à partir de 18h), auquel Aubin participe, sans fiche de ressenti. Une même
 * date porte souvent Première + Réserve : la fixture déjà loguée est prise,
 * sinon la Première si Aubin y joue, sinon la Réserve. */
export function pickMatchToRate(fixtures, today, hour, days = 3, isDismissed = () => false) {
  const min = new Date(`${today}T12:00:00`);
  min.setDate(min.getDate() - days);
  const minISO = min.toISOString().slice(0, 10);
  const byDate = new Map();
  for (const f of fixtures) {
    if (!f.user_is_playing || f.date < minISO || f.date > today || (f.date === today && hour < 18)) continue;
    if (!byDate.has(f.date)) byDate.set(f.date, []);
    byDate.get(f.date).push(f);
  }
  const dates = [...byDate.keys()].sort().reverse();
  for (const date of dates) {
    if (isDismissed(date)) continue;
    const list = byDate.get(date);
    if (list.some((f) => f.performance && f.performance.feel)) continue;
    return list.find((f) => f.performance) || list.find((f) => (f.team || "Première") === "Première") || list[0];
  }
  return null;
}

/** Fixtures des fichiers `data/schedule/matches-*.json` (lus frais, pas via
 * summary.json qui n'est régénéré qu'au digest), avec `user_is_playing`
 * calculé comme côté Python (coach.schedule._load_fixtures). */
export async function loadFixtures() {
  const entries = await ghListDir("data/schedule").catch(() => []);
  const out = [];
  for (const e of entries.filter((x) => x.type === "file" && /^matches-.*\.json$/.test(x.name || ""))) {
    const file = await ghGetFile(e.path).catch(() => null);
    if (!file) continue;
    let season;
    try { season = JSON.parse(file.content); } catch (_) { continue; }
    const back = season.user_return_to_play_date;
    for (const f of season.fixtures || []) out.push({ ...f, user_is_playing: !back || f.date >= back });
  }
  return out;
}

export async function matchToRate(today, hour) {
  return pickMatchToRate(await loadFixtures(), today, hour, 3, dismissed);
}
