import { ghGetFile } from "../github-api.js";
import { stale } from "../nav.js";
import { skeletonHTML, escapeHtmlText } from "../markdown.js";
import { statTile, sleepGoalTile, sparklineSVG, barChartSVG, formatHoursFr, statTileSimple } from "./data-viz.js";

// ---- Data (trajectoire, sommeil, poids, charge aiguë:chronique) ----

const SLEEP_TARGET_HOURS = 7.5;

const WORKLOAD_ZONE_LABELS = {
  sous_charge: "Sous-charge",
  zone_optimale: "Zone optimale",
  zone_prudente: "Zone prudente",
  risque_eleve: "Risque élevé",
};

export async function renderData(token) {
  const el = document.getElementById("data-content");
  el.innerHTML = skeletonHTML();
  const file = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  if (!file) { el.innerHTML = "<p class='muted'>Pas encore de résumé exporté.</p>"; return; }
  const s = JSON.parse(file.content);
  let html = "";

  html += readinessScoreHTML(s.readiness);

  let tiles = "";
  if (s.bodyweight_progress) {
    const bp = s.bodyweight_progress;
    tiles += statTile("Poids de corps", bp.current_kg, " kg", bp.fraction, `Objectif ${bp.target_kg} kg`, bp.baseline_kg, bp.baseline_date);
  }
  const liftLabels = { back_squat: "Back Squat", bench: "Bench", trap_bar_deadlift: "Trap Bar Deadlift" };
  for (const [key, label] of Object.entries(liftLabels)) {
    const entry = s.strength_trajectory && s.strength_trajectory[key];
    if (!entry) continue;
    const best = entry.recent_best;
    tiles += statTile(
      label,
      best ? best.load : null,
      " kg",
      entry.progress_fraction,
      entry.target ? `Cible 4RM : ${entry.target.four_rm.toFixed(1)} kg` : "Pas de cible calculable",
      entry.baseline_load,
      entry.baseline_date
    );
  }
  if (tiles) html += `<section class="card"><h2>🏆 Trajectoire de force</h2><div class="stat-grid">${tiles}</div></section>`;

  html += tonnageMilestoneHTML(s.tonnage || {}, liftLabels);

  const bw = (s.bodyweight_recent && s.bodyweight_recent.history) || []; // weekly averages, ~3 mois
  if (bw.length > 1) {
    const first = bw[0].weight_kg, last = bw[bw.length - 1].weight_kg;
    const delta = last - first;
    const weeks = Math.max(1, bw.length - 1);
    const perWeek = delta / weeks;
    html += `
      <section class="card">
        <h2>⚖️ Poids de corps (moyenne hebdomadaire, ~3 mois)</h2>
        ${sparklineSVG(bw.map((h) => ({ date: h.week_start, value: h.weight_kg })), { axis: true })}
        <p class="trend-line">${last.toFixed(1)} kg
          <span class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)} kg</span>
          sur la période <span class="muted small">(~${perWeek >= 0 ? "+" : ""}${perWeek.toFixed(2)} kg/semaine)</span>
        </p>
      </section>`;
  } else if (bw.length === 1) {
    html += `<section class="card"><h2>⚖️ Poids de corps</h2><p class="trend-line">${bw[0].weight_kg.toFixed(1)} kg</p></section>`;
  } else {
    html += `<section class="card"><h2>⚖️ Poids de corps</h2><p class="muted small">Pas encore assez de pesées récentes.</p></section>`;
  }

  const sr = s.sleep_recent || {};
  const sleepHist = sr.history || [];
  if (sr.avg_7d != null || sleepHist.length) {
    const delta = sr.avg_7d != null && sr.avg_prior_7d != null ? sr.avg_7d - sr.avg_prior_7d : null;
    html += `
      <section class="card">
        <h2>😴 Sommeil</h2>
        ${sleepHist.length ? barChartSVG(sleepHist.map((h) => ({ date: h.date, value: h.hours })), { reference: SLEEP_TARGET_HOURS, dayLabels: true }) : ""}
        <p class="trend-line">
          ${sr.avg_7d != null ? `${sr.avg_7d.toFixed(1)} h/nuit <span class="muted small">(moy. 7j)</span>` : "Pas assez de données"}
          ${delta != null ? `<span class="${delta >= 0 ? "trend-up" : "trend-down"} small">${delta >= 0 ? "+" : ""}${delta.toFixed(1)} h vs semaine précédente</span>` : ""}
        </p>
        <p class="muted small">Repère : ≥ ${formatHoursFr(SLEEP_TARGET_HOURS)}/nuit (barres dorées sous ce seuil).</p>
        ${sr.week_avg != null ? `
        <div class="sleep-week-summary">
          <div class="sleep-week-summary-label">Cette semaine (lundi → dimanche) — ${sr.week_nights_logged} nuit${sr.week_nights_logged > 1 ? "s" : ""} enregistrée${sr.week_nights_logged > 1 ? "s" : ""}</div>
          <div class="stat-grid">
            ${sleepGoalTile(
              "Moyenne/nuit",
              formatHoursFr(sr.week_avg),
              Math.min(1, sr.week_avg / SLEEP_TARGET_HOURS),
              `Objectif ${formatHoursFr(SLEEP_TARGET_HOURS)}/nuit`
            )}
            ${sleepGoalTile(
              "Cumul semaine",
              formatHoursFr(sr.week_total),
              Math.min(1, sr.week_total / (SLEEP_TARGET_HOURS * 7)),
              `Objectif ${formatHoursFr(SLEEP_TARGET_HOURS * 7)}`
            )}
          </div>
        </div>` : ""}
        ${(sr.weekly_average || []).length > 1 ? `
        <div class="sleep-weekly-evolution">
          <div class="sleep-week-summary-label">Évolution de la moyenne hebdomadaire</div>
          ${sparklineSVG(sr.weekly_average.map((w) => ({ date: w.week_start, value: w.avg_hours })), { axis: true })}
        </div>` : ""}
      </section>`;
  } else {
    html += `<section class="card"><h2>😴 Sommeil</h2><p class="muted small">Pas encore de données de sommeil.</p></section>`;
  }

  const recoveryHist = (s.recovery_recent && s.recovery_recent.history) || [];
  const lastWithField = (field) => {
    for (let i = recoveryHist.length - 1; i >= 0; i--) if (recoveryHist[i][field] != null) return recoveryHist[i][field];
    return null;
  };
  const restingHr = lastWithField("resting_heart_rate");
  const hrv = lastWithField("hrv_ms");
  if (restingHr != null || hrv != null) {
    html += `
      <section class="card">
        <h2>❤️ Récupération</h2>
        <div class="stat-grid">
          ${restingHr != null ? statTileSimple("FC repos", `${Math.round(restingHr)} bpm`) : ""}
          ${hrv != null ? statTileSimple("HRV", `${Math.round(hrv)} ms`) : ""}
        </div>
        <p class="muted small">FC repos basse et HRV stable/haute = bonne récupération ; une tendance inverse qui se maintient plusieurs jours est un signal précoce de fatigue.</p>
      </section>`;
  } else {
    html += `<section class="card"><h2>❤️ Récupération</h2><p class="muted small">Pas encore de données FC repos/HRV.</p></section>`;
  }

  const bc = s.body_composition || [];
  if (bc.length) {
    const latest = bc[bc.length - 1];
    const prev = bc.length > 1 ? bc[bc.length - 2] : null;
    const delta = (field) => (prev && latest[field] != null && prev[field] != null) ? latest[field] - prev[field] : null;
    html += `
      <section class="card">
        <h2>📏 Composition corporelle</h2>
        <p class="muted small">Dernier scan InBody : ${latest.date}</p>
        <div class="stat-grid">
          ${latest.skeletal_muscle_mass_kg != null ? statTileSimple("Masse musculaire", `${latest.skeletal_muscle_mass_kg.toFixed(1)} kg`, delta("skeletal_muscle_mass_kg"), " kg", "up") : ""}
          ${latest.fat_mass_kg != null ? statTileSimple("Masse grasse", `${latest.fat_mass_kg.toFixed(1)} kg`, delta("fat_mass_kg"), " kg", "down") : ""}
        </div>
        ${latest.inbody_score != null ? `<p class="muted small" style="margin-top:8px">Score InBody : ${latest.inbody_score}</p>` : ""}
      </section>`;
  } else {
    html += `<section class="card"><h2>📏 Composition corporelle</h2><p class="muted small">Pas encore de scan InBody enregistré.</p></section>`;
  }

  const ACCESSORY_LABELS = { strict_press: "Strict Press", tractions: "Tractions", cmj: "CMJ", sprint: "Sprint" };
  let accessoryTags = "";
  for (const [key, label] of Object.entries(ACCESSORY_LABELS)) {
    const entries = (s.secondary_lifts && s.secondary_lifts[key]) || (s.power_speed_progression && s.power_speed_progression[key]);
    if (!entries || !entries.length) continue;
    const last = entries[entries.length - 1];
    const ex = last.executed || {};
    const parts = [ex.sets, ex.reps, ex.load].filter((v) => v != null && v !== "").join(" × ");
    accessoryTags += `<div class="accessory-tag"><span class="accessory-tag-label">${label}</span><span>${escapeHtmlText(parts || "—")}</span><span class="muted small">${last.date}</span></div>`;
  }
  if (accessoryTags) {
    html += `<section class="card"><h2>💪 Accessoires & explosivité</h2><div class="accessory-tags">${accessoryTags}</div></section>`;
  }

  if (s.workload) {
    const w = s.workload;
    html += `
      <section class="card">
        <h2>⚙️ Charge aiguë:chronique</h2>
        <p class="workload-badge zone-${w.zone}">${WORKLOAD_ZONE_LABELS[w.zone] || w.zone}</p>
        <p class="muted small">Ratio ${w.ratio.toFixed(2)} — charge des 7 derniers jours vs moyenne des 4 dernières semaines (RPE × durée de séance).</p>
      </section>`;
  } else {
    html += `
      <section class="card">
        <h2>⚙️ Charge aiguë:chronique</h2>
        <p class="muted small">Pas encore assez d'historique de charge — renseigne le RPE et la durée à chaque séance loguée (voir Loguer la séance) : il faut environ 4 semaines de suivi régulier avant un premier calcul fiable.</p>
      </section>`;
  }

  html += tonnageSectionHTML(s.tonnage);

  html += tonnageHeatmapHTML(s.tonnage && s.tonnage.periods);

  el.innerHTML = html || "<p class='muted'>Pas encore de données.</p>";
}

const READINESS_LEVEL_LABELS = {
  pret: "Prêt à pousser",
  bonne_forme: "Bonne forme",
  vigilance: "Vigilance",
  repos_recommande: "Repos recommandé",
};
const READINESS_COMPONENT_LABELS = { charge: "Charge", sommeil: "Sommeil", recuperation: "Récupération" };

/** "Indice de forme" (Data tab, tout en haut) — croise charge aiguë:
 * chronique, sommeil et récupération en un seul chiffre 0-100 (voir
 * `coach.readiness` et docs/adr/0035) : un repère rapide pour savoir si la
 * semaine est plutôt à pousser ou à lever le pied, sans recroiser
 * soi-même trois cartes séparées. Affiche seulement les composantes
 * disponibles (`components[].available`) — jamais un chiffre inventé pour
 * celle qui manque encore d'historique. */
function readinessScoreHTML(readiness) {
  if (!readiness) {
    return `
      <section class="card readiness-card">
        <h2>🧭 Indice de forme</h2>
        <p class="muted small">Pas encore assez d'historique (charge, sommeil, récupération) pour calculer un indice fiable.</p>
      </section>`;
  }
  const rows = Object.entries(readiness.components)
    .filter(([, c]) => c.available)
    .map(
      ([key, c]) => `
        <div class="readiness-component">
          <span class="readiness-component-label">${READINESS_COMPONENT_LABELS[key]}</span>
          <div class="readiness-component-track"><div class="readiness-component-fill" style="width:${c.score}%"></div></div>
        </div>`
    )
    .join("");
  return `
    <section class="card readiness-card level-${readiness.level}">
      <h2>🧭 Indice de forme</h2>
      <div class="readiness-score-row">
        <div class="readiness-score-value">${readiness.score}</div>
        <div class="readiness-score-label">${READINESS_LEVEL_LABELS[readiness.level] || readiness.level}</div>
      </div>
      <div class="readiness-components">${rows}</div>
      <p class="muted small">Charge aiguë:chronique, sommeil récent et signaux de récupération (FC repos/HRV) — un repère, pas une vérité absolue.</p>
    </section>`;
}

// Quelques repères concrets pour donner un sens au tonnage total (tous
// exercices confondus) — croissants, on prend le plus grand qui tient
// dedans plutôt qu'un multiple absurde du plus petit. Purement ludique,
// aucune valeur scientifique.
const TONNAGE_EQUIVALENCE_REFS = [
  { label: "un pilier de rugby (120 kg)", kg: 120 },
  { label: "une voiture citadine (1,2 t)", kg: 1200 },
  { label: "un bus (12 t)", kg: 12000 },
  { label: "un camion de pompier (20 t)", kg: 20000 },
  { label: "une baleine bleue (150 t)", kg: 150000 },
  { label: "la Tour Eiffel (10 100 t)", kg: 10100000 },
];

function tonnageEquivalenceLabel(totalKg) {
  const candidates = TONNAGE_EQUIVALENCE_REFS.filter((r) => totalKg >= r.kg);
  if (!candidates.length) return null;
  const ref = candidates[candidates.length - 1];
  const multiplier = totalKg / ref.kg;
  const formatted = multiplier.toLocaleString("fr-FR", { maximumFractionDigits: multiplier < 10 ? 1 : 0 });
  return `≈ ${formatted} × ${ref.label}`;
}

/** true seulement à partir de la 2e fois qu'un palier est vu pour ce lift
 * dans ce navigateur — jamais au tout premier affichage (rien à "monter
 * depuis", juste la première mesure) — pour déclencher une petite mise en
 * valeur ("🎉 nouveau palier") sans backend ni état partagé, un pur
 * confort local à ce navigateur (jamais relu par le coach ni un autre
 * appareil). */
function tierJustLeveledUp(lift, tierIndex) {
  if (!tierIndex) return false;
  try {
    const key = `coach_seen_tier_${lift}`;
    const seen = parseInt(localStorage.getItem(key) || "0", 10);
    if (tierIndex > seen) {
      localStorage.setItem(key, String(tierIndex));
      return seen > 0;
    }
  } catch (_) { /* stockage indisponible (navigation privée...) — pas de flourish, pas grave */ }
  return false;
}

/** "Tonnage soulevé" (Data tab) — un chiffre motivant, pas un signal de
 * programmation (voir docs/adr/0034), donc traité visuellement à part.
 * Paliers/streak/tonnage total (voir docs/adr/0035 et son amendement)
 * n'apparaissent que si `tonnage.lift_milestones` a bien été calculé côté
 * export — un `data/app/summary.json` pas encore régénéré depuis l'ajout
 * de cette fonctionnalité ne doit jamais laisser croire à un "palier
 * maximum atteint" par défaut (bug observé : `undefined` traité comme
 * "pas de palier suivant" plutôt que comme "pas encore de données"). */
function tonnageMilestoneHTML(tonnage, liftLabels) {
  const lifetimeKg = tonnage.lifetime_main_lifts_kg || {};
  const milestonesAvailable = tonnage.lift_milestones != null;
  const milestones = tonnage.lift_milestones || {};
  const streak = tonnage.training_streak_weeks || 0;
  const equivalence = tonnage.lifetime_total_kg ? tonnageEquivalenceLabel(tonnage.lifetime_total_kg) : null;

  const tiles = Object.entries(liftLabels)
    .map(([key, label]) => ({ key, label, kg: lifetimeKg[key], m: milestones[key] || {} }))
    .filter((t) => t.kg > 0)
    .map((t) => {
      const tonnes = (t.kg / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const leveledUp = milestonesAvailable && tierJustLeveledUp(t.key, t.m.tier_index);
      let milestoneBlock = "";
      if (milestonesAvailable) {
        const progressPct = t.m.progress_to_next != null ? Math.round(t.m.progress_to_next * 100) : 100;
        const next = t.m.next_tier_tonnes != null
          ? `${(t.m.next_tier_tonnes - t.m.tonnes).toFixed(1)} t avant le palier suivant`
          : "Palier maximum atteint";
        milestoneBlock = `
          ${t.m.tier_label ? `<div class="tonnage-milestone-tier">${t.m.tier_icon || "🏅"} ${t.m.tier_label}</div>` : ""}
          <div class="tonnage-milestone-progress-track"><div class="tonnage-milestone-progress-fill" style="width:${progressPct}%"></div></div>
          <div class="tonnage-milestone-next">${next}</div>`;
      }
      return `
        <div class="tonnage-milestone-tile${leveledUp ? " just-leveled-up" : ""}">
          ${leveledUp ? `<div class="tonnage-milestone-levelup">🎉 Nouveau palier !</div>` : ""}
          <div class="tonnage-milestone-value">${tonnes}<span class="tonnage-milestone-unit">t</span></div>
          <div class="tonnage-milestone-label">${t.label}</div>
          ${milestoneBlock}
        </div>`;
    })
    .join("");
  if (!tiles) return "";
  return `
    <section class="card tonnage-milestone-card">
      <h2>🏋️ Tonnage soulevé</h2>
      ${streak > 0 ? `<div class="tonnage-streak-banner">🔥 ${streak} semaine${streak > 1 ? "s" : ""} d'affilée avec au moins une séance</div>` : ""}
      <div class="tonnage-milestone-grid">${tiles}</div>
      ${equivalence ? `<p class="tonnage-milestone-equivalence">🌍 ${(tonnage.lifetime_total_kg / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} t soulevées au total, tous exercices confondus — ${equivalence}</p>` : ""}
      <p class="tonnage-milestone-caption">Cumulé depuis le retour à l'entraînement (18/05/2026)</p>
    </section>`;
}

const TONNAGE_CATEGORY_LABELS = {
  quadriceps: "Quadriceps",
  ischios_jambiers: "Ischios-jambiers",
  fessiers: "Fessiers",
  mollets: "Mollets",
  poussee: "Poussée",
  tirage: "Tirage",
  bras: "Bras",
  gainage: "Gainage",
  explosivite_puissance: "Explosivité / puissance",
  cardio: "Cardio",
};

/** "Tonnage de la semaine" (Data tab), juste après la charge aiguë:
 * chronique — même esprit complémentaire que dans `coach.tonnage` : l'ACWR
 * dit combien la semaine a chargé au global, ceci dit où, compartiment par
 * compartiment, pour repérer un déséquilibre qu'un chiffre global ne peut
 * pas montrer. Barres à longueur relative (proportionnelles au
 * compartiment le plus chargé de la semaine), dans un ordre fixe plutôt
 * que trié par valeur — un ordre qui bougerait chaque semaine serait plus
 * dur à scanner d'un coup d'œil que la tendance elle-même. */
function tonnageSectionHTML(tonnage) {
  if (!tonnage) return "";
  const categories = tonnage.categories || {};
  const priorCategories = (tonnage.prior_week && tonnage.prior_week.categories) || {};
  if (!tonnage.total_sets) {
    return `
      <section class="card">
        <h2>🏋️ Tonnage de la semaine</h2>
        <p class="muted small">Pas encore de séance de musculation loguée cette semaine (lundi → dimanche).</p>
      </section>`;
  }

  const maxTonnage = Math.max(1, ...Object.values(categories).map((c) => c.tonnage_kg));
  const totalDelta = tonnage.total_tonnage_kg - ((tonnage.prior_week && tonnage.prior_week.total_tonnage_kg) || 0);

  let bars = "";
  for (const [key, label] of Object.entries(TONNAGE_CATEGORY_LABELS)) {
    const cat = categories[key] || { tonnage_kg: 0, sets: 0, reps: 0 };
    if (!cat.sets) continue;
    const prior = priorCategories[key] || { tonnage_kg: 0 };
    const delta = cat.tonnage_kg - prior.tonnage_kg;
    const widthPct = Math.max(3, (cat.tonnage_kg / maxTonnage) * 100);
    bars += `
      <div class="tonnage-row">
        <div class="tonnage-row-label">${label}</div>
        <div class="tonnage-row-bar-track"><div class="tonnage-row-bar" style="width:${widthPct}%"></div></div>
        <div class="tonnage-row-value">
          ${cat.tonnage_kg > 0 ? `${Math.round(cat.tonnage_kg)} kg` : `${cat.sets} série${cat.sets > 1 ? "s" : ""}`}
          ${cat.tonnage_kg > 0 && Math.abs(delta) >= 1 ? `<span class="${delta >= 0 ? "trend-up" : "trend-down"} small">${delta >= 0 ? "+" : ""}${Math.round(delta)}</span>` : ""}
        </div>
      </div>`;
  }

  return `
    <section class="card">
      <h2>🏋️ Tonnage de la semaine</h2>
      <p class="trend-line">${Math.round(tonnage.total_tonnage_kg)} kg <span class="small">au total</span>
        ${Math.abs(totalDelta) >= 1 ? `<span class="${totalDelta >= 0 ? "trend-up" : "trend-down"} small">${totalDelta >= 0 ? "+" : ""}${Math.round(totalDelta)} kg vs semaine dernière</span>` : ""}
      </p>
      <div class="tonnage-bars">${bars}</div>
      <p class="muted small">Séries × répétitions × charge, par compartiment — seules les séries avec une charge en kg connue comptent dans le tonnage ; le gainage et les exercices au poids du corps s'affichent en nombre de séries.</p>
    </section>`;
}

const TONNAGE_HEATMAP_PERIOD_LABELS = { "1": "Semaine", "3": "3 sem.", "6": "6 sem." };

// Silhouette humaine stylisée (vue de face) — torse et cuisses en formes
// courbes (épaules/hanches arrondies, cuisses qui se resserrent au genou)
// plutôt que de simples rectangles, segments qui se touchent sans espace
// visible entre eux (bras contre torse, cuisses contre bassin...) pour
// lire comme un seul corps continu plutôt qu'un empilement de blocs, et
// mains/pieds neutres en bout de membre pour finir la silhouette — sans
// viser un rendu anatomique réaliste pour autant. Le tirage (haut du
// dos/trapèzes) est la seule concession : représenté comme une bande
// étroite près du cou, visible même de face, plutôt que d'exiger une
// seconde silhouette de dos pour un seul compartiment. Les fessiers
// occupent la bande de hanches ; les ischios-jambiers, pas vraiment
// visibles de face, sont suggérés par une fine bande sur le bord externe
// de chaque cuisse plutôt qu'omis — explosivite_puissance/cardio n'ont
// eux aucun équivalent anatomique honnête (sprint, vélo...) : affichés à
// part en badges.
const HEATMAP_BODY_ZONES = [
  { cat: "tirage", shape: "rect", x: 26, y: 26, width: 48, height: 10, rx: 5 },
  {
    cat: "poussee",
    shape: "path",
    d: "M18,32 C18,27 24,25 30,25 L70,25 C76,25 82,27 82,32 L76,66 C76,69 55,70 50,70 C45,70 24,69 24,66 Z",
  },
  { cat: "bras", shape: "rect", x: 6, y: 30, width: 14, height: 28, rx: 7 },
  { cat: "bras", shape: "rect", x: 8, y: 56, width: 11, height: 27, rx: 5 },
  { cat: "bras", shape: "rect", x: 80, y: 30, width: 14, height: 28, rx: 7 },
  { cat: "bras", shape: "rect", x: 81, y: 56, width: 11, height: 27, rx: 5 },
  { cat: "gainage", shape: "rect", x: 29, y: 68, width: 42, height: 28, rx: 11 },
  { cat: "fessiers", shape: "rect", x: 26, y: 96, width: 48, height: 16, rx: 11 },
  { cat: "ischios_jambiers", shape: "rect", x: 17, y: 114, width: 9, height: 46, rx: 4 },
  {
    cat: "quadriceps",
    shape: "path",
    d: "M25,110 C25,107 30,106 34,106 C38,106 43,107 43,110 L41,158 C41,161 27,161 26,158 Z",
  },
  {
    cat: "quadriceps",
    shape: "path",
    d: "M57,110 C57,107 62,106 66,106 C70,106 75,107 75,110 L74,158 C73,161 59,161 59,158 Z",
  },
  { cat: "ischios_jambiers", shape: "rect", x: 74, y: 114, width: 9, height: 46, rx: 4 },
  { cat: "mollets", shape: "rect", x: 27, y: 159, width: 18, height: 42, rx: 8 },
  { cat: "mollets", shape: "rect", x: 55, y: 159, width: 18, height: 42, rx: 8 },
];

/** rgba() interpolée entre un fond quasi invisible (rien fait sur la
 * période) et une intensité pleine (compartiment le plus travaillé) —
 * même vert que le reste de l'UI tonnage, une seule teinte plutôt qu'une
 * échelle multicolore pour rester lisible pareil en clair et en sombre. */
function heatFill(fraction) {
  const alpha = 0.1 + Math.max(0, Math.min(1, fraction)) * 0.85;
  return `rgba(30, 122, 77, ${alpha.toFixed(2)})`;
}

/** `maxSets` : nombre de séries par compartiment — plus parlant côté
 * prépa que les répétitions totales pour lire d'un coup d'œil ce qui a
 * été touché. Pas de contour par zone (`stroke`) : les segments se
 * touchent déjà géométriquement, un trait par bloc les aurait fait
 * ressortir comme des cases séparées plutôt qu'un seul corps. */
function bodyHeatmapSVG(categories, maxSets) {
  const shapes = HEATMAP_BODY_ZONES.map((zone) => {
    const sets = (categories[zone.cat] && categories[zone.cat].sets) || 0;
    const fill = heatFill(maxSets ? sets / maxSets : 0);
    return zone.shape === "path"
      ? `<path d="${zone.d}" fill="${fill}" />`
      : `<rect x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.height}" rx="${zone.rx}" fill="${fill}" />`;
  }).join("");
  return `
    <svg viewBox="0 0 100 210" class="heatmap-body-svg" role="img" aria-label="Silhouette colorée par compartiment travaillé">
      <circle cx="50" cy="13" r="11" fill="var(--border)" />
      <path d="M43,21 L57,21 L55,29 L45,29 Z" fill="var(--border)" />
      ${shapes}
      <circle cx="13" cy="85" r="6" fill="var(--border)" />
      <circle cx="87" cy="85" r="6" fill="var(--border)" />
      <rect x="25" y="199" width="20" height="8" rx="4" fill="var(--border)" />
      <rect x="55" y="199" width="20" height="8" rx="4" fill="var(--border)" />
    </svg>`;
}

/** "Où le corps a-t-il vraiment été sollicité", en un coup d'œil, sur 1/3/6
 * semaines au choix (voir `coach.tonnage.breakdown_over_weeks` et
 * docs/adr/0035) — complète les barres de "Tonnage de la semaine"
 * au-dessus (précises mais limitées à la semaine en cours) avec une
 * lecture visuelle qui lisse le bruit d'une semaine à l'autre. Toujours en
 * nombre de séries, jamais en tonnage kg — seule mesure commune aux
 * compartiments à charge (quadriceps, poussée...) et à ceux presque
 * toujours au poids du corps (gainage, mollets), plus parlant côté prépa
 * que les répétitions totales, même principe que `tonnageSectionHTML`.
 * Le switch de période est un pur radio/label CSS
 * (voir style.css), même esprit zéro-JS que les `<details>` du
 * Calendrier — pas de re-fetch, les 3 fenêtres sont déjà dans
 * `s.tonnage.periods`. */
function tonnageHeatmapHTML(periods) {
  if (!periods) return "";
  const panels = Object.entries(TONNAGE_HEATMAP_PERIOD_LABELS)
    .map(([key]) => {
      const period = periods[key];
      if (!period) return "";
      const categories = period.categories || {};
      const maxSets = Math.max(1, ...Object.values(categories).map((c) => c.sets));
      const badges = ["explosivite_puissance", "cardio"]
        .map((cat) => {
          const sets = (categories[cat] && categories[cat].sets) || 0;
          const icon = cat === "cardio" ? "🫀" : "⚡";
          return `<div class="heatmap-badge" style="background:${heatFill(sets / maxSets)}">${icon} ${TONNAGE_CATEGORY_LABELS[cat]} <strong>${sets}</strong></div>`;
        })
        .join("");
      const legend = Object.entries(TONNAGE_CATEGORY_LABELS)
        .filter(([cat]) => cat !== "explosivite_puissance" && cat !== "cardio")
        .map(([cat, label]) => {
          const sets = (categories[cat] && categories[cat].sets) || 0;
          return `
            <div class="heatmap-legend-row">
              <span class="heatmap-legend-swatch" style="background:${heatFill(sets / maxSets)}"></span>
              <span class="heatmap-legend-label">${label}</span>
              <span class="heatmap-legend-value">${sets} série${sets > 1 ? "s" : ""}</span>
            </div>`;
        })
        .join("");
      return `
        <div class="heatmap-panel" data-panel="${key}">
          ${period.total_sets
            ? `<div class="heatmap-body-wrap">${bodyHeatmapSVG(categories, maxSets)}</div>
               <div class="heatmap-badges">${badges}</div>
               <div class="heatmap-legend">${legend}</div>`
            : `<p class="muted small">Pas de séance de musculation loguée sur cette période.</p>`}
        </div>`;
    })
    .join("");

  return `
    <section class="card">
      <h2>🧍 Heatmap corporelle</h2>
      <div class="heatmap-period-switch">
        <input type="radio" name="heatmap-period" id="hm-period-1" checked>
        <input type="radio" name="heatmap-period" id="hm-period-3">
        <input type="radio" name="heatmap-period" id="hm-period-6">
        <div class="heatmap-period-labels">
          <label for="hm-period-1">Semaine</label>
          <label for="hm-period-3">3 sem.</label>
          <label for="hm-period-6">6 sem.</label>
        </div>
        ${panels}
      </div>
      <p class="muted small">Intensité relative (nombre de séries) par compartiment sur la période choisie — le gainage et les mollets, presque toujours au poids du corps, comptent ici comme les autres.</p>
    </section>`;
}
