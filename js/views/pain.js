import { ghGetFile, ghPutJSON } from "../github-api.js";
import { registerQueuedOp, runQueued } from "../offline-queue.js";
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
function groupZonesByRegion(zones) {
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
  await ghPutJSON(`data/health/${date}.json`, { date }, `App : douleur du ${date}`, (current) => {
    const base = current || { date };
    const existing = base.pain || [];
    if (existing.some((p) => p.at === entry.at)) return base;
    base.pain = [...existing, entry];
    return base;
  });
});

export async function renderPain(token) {
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
      const outcome = await runQueued("pain", { date, entry }, { label: "Douleur" });
      levelEl.value = "";
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
  const notes = ep.entries.filter((e) => e.note);
  const notesHTML = notes.length
    ? `<ul class="pain-episode-notes">${notes.map((e) => `<li><strong>${shortDateFr(e.date)}</strong> — ${escapeHtmlText(e.note)}</li>`).join("")}</ul>`
    : "<p class='muted small'>Pas de note sur cet épisode.</p>";
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

function renderPainHistoryBody(episodes, zones, listEl) {
  const filtered = historyFilter ? episodes.filter((ep) => ep.zone === historyFilter) : episodes;
  if (filtered.length === 0) {
    listEl.innerHTML = "<p class='muted small'>Aucun épisode pour cette zone.</p>";
    return;
  }
  const groups = groupEpisodesByBlock(filtered);
  listEl.innerHTML = groups.map(([block, eps], i) => blockGroupHTML(block, eps, zones, i === 0)).join("");
}
