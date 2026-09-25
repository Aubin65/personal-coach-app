import { ghGetFile, ghPutJSON } from "../github-api.js";
import { state, stale } from "../nav.js";
import { todayISO, localISOWithOffset } from "../date-utils.js";
import { escapeHtmlText, escapeAttr } from "../markdown.js";
import { setupMicButton } from "../voice-input.js";
import { painTrendSVG, painLevelColor, shortDateFr } from "./data-viz.js";

// ============================================================================
// Suivi structuré de la douleur (docs/adr/0060) — retour direct : "j'ai
// besoin que ça soit stocké pour avoir un retour d'expérience pour la
// prochaine fois". Écrit dans data/health/<date>.json (même fichier que
// session_rpe/session_duration_min, voir docs/adr/0019) sous un champ
// `pain`, lu ensuite via coach.progression.pain_history/coach.app_export
// (`pain_recent` dans data/app/summary.json) — pas de fetch/scan de
// data/health/*.json côté app, même convention que sleep/recovery.
// ============================================================================

let selectedZone = null; // état du composer (zone en cours de sélection)
let historyFilter = null; // état de la liste d'historique (null = "Toutes")

function zoneChipsHTML(zones, selected, allLabel) {
  const chips = Object.entries(zones)
    .map(([id, label]) => `<button type="button" class="suggestion-chip${selected === id ? " active" : ""}" data-zone="${escapeAttr(id)}">${escapeHtmlText(label)}</button>`)
    .join("");
  if (!allLabel) return chips;
  return `<button type="button" class="suggestion-chip${selected === null ? " active" : ""}" data-zone="">${allLabel}</button>${chips}`;
}

export async function renderPain(token) {
  setupMicButton(
    document.getElementById("pain-mic"),
    document.getElementById("pain-voice-hint"),
    document.getElementById("pain-note"),
    document.getElementById("pain-live-caption")
  );
  document.getElementById("pain-date").value = todayISO();
  selectedZone = null;
  historyFilter = null;

  const summaryFile = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  const painRecent = summaryFile ? (JSON.parse(summaryFile.content).pain_recent || { entries: [], zones: {} }) : { entries: [], zones: {} };
  const zones = painRecent.zones;

  const chipsEl = document.getElementById("pain-zone-chips");
  chipsEl.innerHTML = zoneChipsHTML(zones, selectedZone, null);
  chipsEl.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      selectedZone = chip.dataset.zone || null;
      chipsEl.querySelectorAll(".suggestion-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  document.getElementById("pain-save").addEventListener("click", async (e) => {
    const statusEl = document.getElementById("pain-status");
    const levelEl = document.getElementById("pain-level");
    const dateEl = document.getElementById("pain-date");
    const noteEl = document.getElementById("pain-note");
    if (!selectedZone) { statusEl.textContent = "Choisis une zone."; return; }
    if (levelEl.value === "") { statusEl.textContent = "Indique un niveau (0-10)."; return; }
    const date = dateEl.value || todayISO();
    const entry = {
      zone: selectedZone,
      level: Number(levelEl.value),
      note: noteEl.value.trim() || null,
      at: localISOWithOffset(),
    };
    const btn = e.currentTarget;
    btn.disabled = true;
    statusEl.textContent = "Enregistrement…";
    try {
      await ghPutJSON(`data/health/${date}.json`, { date }, `App : douleur du ${date}`, (current) => {
        const base = current || { date };
        base.pain = [...(base.pain || []), entry];
        return base;
      });
      levelEl.value = "";
      noteEl.value = "";
      statusEl.textContent = "Enregistrée ✓";
      loadPainHistory(state.renderToken).catch(() => {});
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  await loadPainHistory(token);
}

/** `pain_recent.entries` — oldest first (see coach.progression.
 * pain_history) — re-fetched (rather than reusing what renderPain already
 * loaded) so a fresh save is reflected immediately without a full
 * navigation round-trip. */
async function loadPainHistory(token) {
  const filtersEl = document.getElementById("pain-history-filters");
  const trendEl = document.getElementById("pain-history-trend");
  const listEl = document.getElementById("pain-history-list");

  const summaryFile = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  const painRecent = summaryFile ? (JSON.parse(summaryFile.content).pain_recent || { entries: [], zones: {} }) : { entries: [], zones: {} };
  const zones = painRecent.zones;
  const entries = painRecent.entries || [];

  if (entries.length === 0) {
    filtersEl.innerHTML = "";
    trendEl.innerHTML = "";
    listEl.innerHTML = "<p class='muted small'>Pas encore d'entrée loguée.</p>";
    return;
  }

  // Seules les zones qui ont au moins une entrée méritent leur propre chip
  // — pas un mur de 10 zones vides à faire défiler.
  const zonesWithData = [...new Set(entries.map((e) => e.zone))];
  const filterableZones = Object.fromEntries(zonesWithData.filter((z) => zones[z]).map((z) => [z, zones[z]]));
  filtersEl.innerHTML = zoneChipsHTML(filterableZones, historyFilter, "Toutes");
  filtersEl.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      historyFilter = chip.dataset.zone || null;
      renderPainHistoryBody(entries, zones, trendEl, listEl);
      filtersEl.querySelectorAll(".suggestion-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  renderPainHistoryBody(entries, zones, trendEl, listEl);
}

function renderPainHistoryBody(entries, zones, trendEl, listEl) {
  const filtered = historyFilter ? entries.filter((e) => e.zone === historyFilter) : entries;

  trendEl.innerHTML = historyFilter && filtered.length >= 2 ? painTrendSVG(filtered) : "";

  listEl.innerHTML = [...filtered]
    .reverse() // most recent first — entries arrive oldest-first from pain_recent
    .map((e) => `
      <div class="pain-history-item">
        <span class="pain-level-badge" style="background:${painLevelColor(e.level)}">${e.level}</span>
        <div class="pain-history-item-body">
          <div class="pain-history-item-head">
            <strong>${escapeHtmlText(zones[e.zone] || e.zone)}</strong>
            <span class="muted small">${shortDateFr(e.date)}</span>
          </div>
          ${e.note ? `<p class="small">${escapeHtmlText(e.note)}</p>` : ""}
        </div>
      </div>`)
    .join("");
}
