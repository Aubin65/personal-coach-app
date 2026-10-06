import { ghGetFile, ghPutJSON } from "../github-api.js";
import { checkinPath } from "../data-paths.js";
import { registerQueuedOp, runQueued } from "../offline-queue.js";
import { state, stale } from "../nav.js";
import { todayISO, localISOWithOffset } from "../date-utils.js";
import { escapeHtmlText, escapeAttr } from "../markdown.js";
import { setupMicButton } from "../voice-input.js";
import { painTrendSVG, painLevelColor, shortDateFr } from "./data-viz.js";

// ============================================================================
// Suivi structuré de la douleur (docs/adr/0060) — retour direct : "j'ai
// besoin que ça soit stocké pour avoir un retour d'expérience pour la
// prochaine fois". Écrit dans data/checkin/<date>.json (même fichier que
// session_rpe/session_duration_min, voir docs/adr/0019) sous un champ
// `pain`, lu ensuite via coach.progression.pain_history/coach.app_export
// (`pain_recent` dans data/app/summary.json) — pas de fetch/scan de
// data/checkin/*.json côté app, même convention que sleep/recovery.
// ============================================================================

let selectedZone = null; // état du composer (zone finale résolue)
let selectedRegionKey = null; // état du composer (région choisie, avant côté)
let selectedSide = null; // état du composer ("gauche" | "droit" | null)
let historyFilter = null; // état de la liste d'historique (null = "Toutes")

function zoneChipsHTML(zones, selected, allLabel) {
  const chips = Object.entries(zones)
    .map(([id, label]) => `<button type="button" class="suggestion-chip${selected === id ? " active" : ""}" data-zone="${escapeAttr(id)}">${escapeHtmlText(label)}</button>`)
    .join("");
  if (!allLabel) return chips;
  return `<button type="button" class="suggestion-chip${selected === null ? " active" : ""}" data-zone="">${allLabel}</button>${chips}`;
}

/** Regroupe les zones à plat (`epaule_gauche`, `epaule_droite`, `lombaire`,
 * ...) en régions ("Épaule" + un côté à part, "Bas du dos" seule) — retour
 * direct : "la liste des endroits où log la douleur est très longue" (19
 * zones à plat, ADR-0060 amendement précision gauche/droite). Dérivé
 * uniquement du dict zones (id → libellé), jamais une deuxième taxonomie
 * codée en dur ici : un changement de PAIN_ZONES côté Python est repris
 * automatiquement. `Map` plutôt qu'un objet pour préserver l'ordre
 * d'apparition (déjà logique côté Python : épaule, lombaire, hanche...). */
export function groupZonesByRegion(zones) {
  const regions = new Map();
  for (const [id, label] of Object.entries(zones)) {
    const left = /^(.+)_gauche$/.exec(id);
    const right = /^(.+)_droite?$/.exec(id);
    if (left || right) {
      const key = (left || right)[1];
      if (!regions.has(key)) {
        const baseLabel = label.replace(/\s+(gauche|droite?)$/i, "");
        regions.set(key, { label: baseLabel, sides: {} });
      }
      if (left) regions.get(key).sides.gauche = id;
      if (right) regions.get(key).sides.droit = id;
    } else {
      regions.set(id, { label, zone: id });
    }
  }
  return regions;
}

/** Chips de région dans #pain-zone-chips ; si la région choisie a un
 * côté, une deuxième rangée Gauche/Droite apparaît dans #pain-side-toggle
 * jusqu'à ce qu'un côté soit choisi — `selectedZone` (utilisé par
 * "Enregistrer") n'est résolu qu'à ce moment-là pour une région latérale,
 * immédiatement pour une région sans côté (lombaires, cou/nuque, autre). */
function renderZoneComposer(regions) {
  const regionEl = document.getElementById("pain-zone-chips");
  const sideEl = document.getElementById("pain-side-toggle");

  regionEl.innerHTML = [...regions.entries()]
    .map(([key, region]) => `<button type="button" class="suggestion-chip${selectedRegionKey === key ? " active" : ""}" data-region="${escapeAttr(key)}">${escapeHtmlText(region.label)}</button>`)
    .join("");
  regionEl.querySelectorAll("[data-region]").forEach((chip) => {
    chip.addEventListener("click", () => {
      selectedRegionKey = chip.dataset.region;
      selectedSide = null;
      const region = regions.get(selectedRegionKey);
      selectedZone = region.zone || null;
      renderZoneComposer(regions);
    });
  });

  const region = selectedRegionKey ? regions.get(selectedRegionKey) : null;
  if (region && region.sides) {
    sideEl.hidden = false;
    sideEl.innerHTML = `
      <button type="button" class="suggestion-chip${selectedSide === "gauche" ? " active" : ""}" data-side="gauche">Gauche</button>
      <button type="button" class="suggestion-chip${selectedSide === "droit" ? " active" : ""}" data-side="droit">Droite</button>`;
    sideEl.querySelectorAll("[data-side]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedSide = btn.dataset.side;
        selectedZone = region.sides[selectedSide];
        renderZoneComposer(regions);
      });
    });
  } else {
    sideEl.hidden = true;
    sideEl.innerHTML = "";
  }
}

/** Ajoute une entrée de douleur au fichier santé du jour — rejouable par la
 * file hors-ligne (offline-queue.js) : l'horodatage `at` sert de clé pour ne
 * jamais ajouter deux fois la même entrée si un premier envoi avait abouti
 * sans que la réponse revienne. */
registerQueuedOp("pain", async ({ date, entry }) => {
  await ghPutJSON(checkinPath(date), { date }, `App : douleur du ${date}`, (current) => {
    const base = current || { date };
    const existing = base.pain || [];
    if (existing.some((p) => p.at === entry.at)) return base;
    base.pain = [...existing, entry];
    return base;
  });
});

// Grille de niveau 0-10 (docs/adr/0076, maquette C) à la place d'un champ
// numérique : un tap, couleur par palier, libellé du palier. La valeur vit
// toujours dans #pain-level (champ caché) lu par « Enregistrer ».
export const PAIN_LEVEL_LABELS = ["aucune gêne", "légère", "légère", "légère", "modérée", "modérée", "modérée", "forte", "forte", "très forte", "très forte"];
export function painTier(n) { return n === 0 ? "none" : n <= 3 ? "low" : n <= 6 ? "mid" : "high"; }

function wirePainLevelGrid() {
  const grid = document.getElementById("pain-level-grid");
  const input = document.getElementById("pain-level");
  const label = document.getElementById("pain-level-label");
  if (!grid || !input) return;
  grid.innerHTML = Array.from({ length: 11 }, (_, n) => `<button type="button" class="pain-level-btn tier-${painTier(n)}" data-level="${n}" aria-pressed="false">${n}</button>`).join("");
  grid.querySelectorAll("[data-level]").forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.level;
      grid.querySelectorAll("[data-level]").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      label.textContent = `${btn.dataset.level} · ${PAIN_LEVEL_LABELS[+btn.dataset.level]}`;
    });
  });
}

function resetPainLevelGrid() {
  const grid = document.getElementById("pain-level-grid");
  if (grid) grid.querySelectorAll("[data-level]").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); });
  const label = document.getElementById("pain-level-label");
  if (label) label.textContent = "touche un chiffre";
}

export async function renderPain(token) {
  wirePainLevelGrid();
  setupMicButton(
    document.getElementById("pain-mic"),
    document.getElementById("pain-voice-hint"),
    document.getElementById("pain-note"),
    document.getElementById("pain-live-caption")
  );
  document.getElementById("pain-date").value = todayISO();
  selectedZone = null;
  selectedRegionKey = null;
  selectedSide = null;
  historyFilter = null;

  const summaryFile = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  const painRecent = summaryFile ? (JSON.parse(summaryFile.content).pain_recent || { entries: [], zones: {} }) : { entries: [], zones: {} };
  const zones = painRecent.zones;

  renderZoneComposer(groupZonesByRegion(zones));

  document.getElementById("pain-save").addEventListener("click", async (e) => {
    const statusEl = document.getElementById("pain-status");
    const levelEl = document.getElementById("pain-level");
    const dateEl = document.getElementById("pain-date");
    const noteEl = document.getElementById("pain-note");
    if (!selectedZone) { statusEl.textContent = "Choisis une zone."; return; }
    if (levelEl.value === "") { statusEl.textContent = "Choisis un niveau de 0 à 10."; return; }
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
      const outcome = await runQueued("pain", { date, entry }, { label: "Douleur" });
      levelEl.value = "";
      resetPainLevelGrid();
      noteEl.value = "";
      statusEl.textContent = outcome.queued ? "Gardée sur le téléphone — envoi dès que le réseau revient." : "Enregistrée ✓";
      loadPainHistory(state.renderToken).catch(() => {});
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  await loadPainHistory(token);
}

/** Tri décroissant par numéro de bloc ("B5" avant "B4") — un épisode sans
 * bloc connu (pas encore de séance synchronisée à cette date, voir
 * coach.progression._block_for_date) retombe toujours en dernier plutôt
 * qu'en tête, ce n'est jamais le plus récent en pratique. */
function blockSortKey(block) {
  const m = block ? /^B(\d+)$/.exec(block) : null;
  return m ? Number(m[1]) : -1;
}

/** [[blockLabelOuNull, épisodes], ...] triés du bloc le plus récent au
 * plus ancien — retour direct : "il faut... par bloc". `episodes` déjà
 * triés oldest-first par `pain_episodes` ; l'ordre à l'intérieur d'un
 * groupe est inversé au rendu (plus récent en premier), pas ici. */
function groupEpisodesByBlock(episodes) {
  const byBlock = new Map();
  for (const ep of episodes) {
    const key = ep.block || null;
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push(ep);
  }
  return [...byBlock.entries()].sort((a, b) => blockSortKey(b[0]) - blockSortKey(a[0]));
}

/** Une carte par épisode — combine les événements (plage de dates), leur
 * évolution (niveau départ → fin, pic si différent des deux) et les
 * notes de chaque entrée en clair (jamais résumées/filtrées, voir
 * docs/adr/0061 : "notifiant les éléments importants recensés dans les
 * notes" = les garder visibles, pas les faire disparaître dans le
 * regroupement). Repliée par défaut (même motif que les autres
 * disclosures de l'app) — `open` seulement pour le tout premier épisode
 * du groupe le plus récent, pour que quelque chose soit visible sans
 * clic à l'ouverture de l'onglet tout en restant "consultable" pour le
 * reste sans surcharger l'écran. */
function episodeCardHTML(ep, zones, open) {
  const zoneLabel = zones[ep.zone] || ep.zone;
  const dateRange = ep.start_date === ep.end_date
    ? shortDateFr(ep.start_date)
    : `${shortDateFr(ep.start_date)} → ${shortDateFr(ep.end_date)}`;
  const evolution = ep.level_start === ep.level_end ? `${ep.level_end}/10` : `${ep.level_start} → ${ep.level_end}/10`;
  const peak = ep.level_peak > Math.max(ep.level_start, ep.level_end) ? ` (pic à ${ep.level_peak}/10)` : "";
  const trend = ep.entries.length >= 2 ? painTrendSVG(ep.entries) : "";
  // Chaque saisie de l'épisode, supprimable une à une (docs/adr/0082).
  const notesHTML = `<ul class="pain-episode-notes">${ep.entries.map((e) => `
      <li class="pain-entry"><span><strong>${shortDateFr(e.date)}</strong> · ${e.level}/10${e.note ? ` — ${escapeHtmlText(e.note)}` : ""}</span>
        ${e.at ? `<button type="button" class="delete-link pain-entry-delete" data-date="${escapeAttr(e.date)}" data-at="${escapeAttr(e.at)}" aria-label="Supprimer la saisie du ${shortDateFr(e.date)}">Supprimer</button>` : ""}</li>`).join("")}</ul>`;
  return `
    <details class="pain-episode"${open ? " open" : ""}>
      <summary>
        <span class="pain-level-badge" style="background:${painLevelColor(ep.level_end)}">${ep.level_end}</span>
        <span class="pain-episode-title">${escapeHtmlText(zoneLabel)} — ${dateRange}</span>
      </summary>
      <p class="small pain-episode-evolution">Niveau : ${evolution}${peak}</p>
      ${trend}
      ${notesHTML}
    </details>`;
}

function blockGroupHTML(blockLabel, episodes, zones, open) {
  const title = blockLabel ? `Bloc ${escapeHtmlText(blockLabel)}` : "Avant le suivi des blocs";
  const cards = [...episodes].reverse().map((ep, i) => episodeCardHTML(ep, zones, open && i === 0)).join("");
  return `
    <details class="pain-block-group"${open ? " open" : ""}>
      <summary>${title} <span class="muted small">(${episodes.length} épisode${episodes.length > 1 ? "s" : ""})</span></summary>
      ${cards}
    </details>`;
}

/** `pain_recent.episodes` — oldest first (see coach.progression.
 * pain_episodes) — re-fetched (rather than reusing what renderPain
 * already loaded) so a fresh save is reflected immediately without a
 * full navigation round-trip. */
async function loadPainHistory(token) {
  const filtersEl = document.getElementById("pain-history-filters");
  const listEl = document.getElementById("pain-history-list");

  const summaryFile = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  const painRecent = summaryFile ? (JSON.parse(summaryFile.content).pain_recent || { entries: [], episodes: [], zones: {} }) : { entries: [], episodes: [], zones: {} };
  const zones = painRecent.zones;
  const episodes = painRecent.episodes || [];

  if (episodes.length === 0) {
    filtersEl.innerHTML = "";
    listEl.innerHTML = "<p class='muted small'>Pas encore d'entrée loguée.</p>";
    return;
  }

  // Seules les zones qui ont au moins un épisode méritent leur propre
  // chip — pas un mur de 19 zones vides à faire défiler.
  const zonesWithData = [...new Set(episodes.map((ep) => ep.zone))];
  const filterableZones = Object.fromEntries(zonesWithData.filter((z) => zones[z]).map((z) => [z, zones[z]]));
  filtersEl.innerHTML = zoneChipsHTML(filterableZones, historyFilter, "Toutes");
  filtersEl.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      historyFilter = chip.dataset.zone || null;
      renderPainHistoryBody(episodes, zones, listEl);
      filtersEl.querySelectorAll(".suggestion-chip").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  renderPainHistoryBody(episodes, zones, listEl);
}

// Saisies supprimées depuis l'app : l'historique vient de summary.json,
// recalculé au prochain export — d'ici là on les masque ici.
const DELETED_PAIN_KEY = "coach_pain_deleted";
function deletedPainKeys() {
  try { return new Set(JSON.parse(localStorage.getItem(DELETED_PAIN_KEY) || "[]")); } catch (_) { return new Set(); }
}
function rememberDeletedPain(at) {
  try {
    const keys = [...deletedPainKeys(), at].slice(-100);
    localStorage.setItem(DELETED_PAIN_KEY, JSON.stringify(keys));
  } catch (_) { /* confort seulement */ }
}

registerQueuedOp("painDelete", async ({ date, at }) => {
  await ghPutJSON(checkinPath(date), { date }, `App : douleur du ${date} supprimée`, (current) => {
    const base = current || { date };
    const rest = (base.pain || []).filter((p) => p.at !== at);
    if (rest.length) base.pain = rest;
    else delete base.pain;
    return base;
  });
});

function withoutDeleted(episodes) {
  const deleted = deletedPainKeys();
  if (!deleted.size) return episodes;
  return episodes
    .map((ep) => {
      const entries = ep.entries.filter((e) => !deleted.has(e.at));
      if (!entries.length) return null;
      const levels = entries.map((e) => e.level);
      return { ...ep, entries, start_date: entries[0].date, end_date: entries[entries.length - 1].date,
        level_start: levels[0], level_end: levels[levels.length - 1], level_peak: Math.max(...levels) };
    })
    .filter(Boolean);
}

function renderPainHistoryBody(allEpisodes, zones, listEl) {
  const episodes = withoutDeleted(allEpisodes);
  const filtered = historyFilter ? episodes.filter((ep) => ep.zone === historyFilter) : episodes;
  if (filtered.length === 0) {
    listEl.innerHTML = "<p class='muted small'>Aucun épisode pour cette zone.</p>";
    return;
  }
  const groups = groupEpisodesByBlock(filtered);
  listEl.innerHTML = groups.map(([block, eps], i) => blockGroupHTML(block, eps, zones, i === 0)).join("");
  listEl.querySelectorAll(".pain-entry-delete").forEach((btn) => btn.addEventListener("click", async () => {
    if (!window.confirm("Supprimer cette saisie de douleur ?")) return;
    btn.disabled = true;
    try {
      await runQueued("painDelete", { date: btn.dataset.date, at: btn.dataset.at }, { key: `pain-delete:${btn.dataset.at}`, label: "Suppression d'une douleur" });
      rememberDeletedPain(btn.dataset.at);
      renderPainHistoryBody(allEpisodes, zones, listEl);
    } catch (err) {
      btn.disabled = false;
      window.alert(`Échec : ${err.message}`);
    }
  }));
}
