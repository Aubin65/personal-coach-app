import { ghGetFile } from "../github-api.js";
import { stale, showView } from "../nav.js";
import { todayISO } from "../date-utils.js";
import { skeletonHTML, escapeHtmlText, escapeAttr } from "../markdown.js";
import { statTile, sparklineSVG, barChartSVG, formatHoursFr, statTileSimple, workloadGaugeHTML, workloadTrendSVG, shortDateFr, painLevelColor } from "./data-viz.js";

// ---- Data (trajectoire, sommeil, poids, charge aiguë:chronique) ----

const SLEEP_TARGET_HOURS = 7.5;

export const WORKLOAD_ZONE_LABELS = {
  sous_charge: "Sous-charge",
  zone_optimale: "Zone optimale",
  zone_prudente: "Zone prudente",
  risque_eleve: "Risque élevé",
};

const CONTACT_INTENSITY_LABELS_FR = { leger: "Contacts légers", modere: "Contacts modérés", intense: "Contacts intenses" };

const WORKLOAD_ZONE_HELP = {
  sous_charge: "Charge en dessous de la référence des 4 dernières semaines — marge pour remonter progressivement sans risque.",
  zone_optimale: "Charge cohérente avec la référence récente — bonne zone pour progresser régulièrement.",
  zone_prudente: "Charge sensiblement au-dessus de la référence récente — surveille la récupération avant d'ajouter du volume.",
  risque_eleve: "Hausse de charge trop rapide par rapport à la moyenne des 4 dernières semaines — zone associée à un risque de blessure accru (Gabbett 2016).",
};

// Progrès en trois sous-onglets (docs/adr/0082) : un long défilement de
// ~5 écrans devient trois vues courtes, chacune répondant à une question.
//   Forme — « est-ce que je peux pousser aujourd'hui ? »
//   Force — « est-ce que je progresse ? » (fiche exercice, records)
//   Corps — poids, composition, douleurs
const PROGRES_TABS = [
  { id: "forme", label: "Forme" },
  { id: "force", label: "Force" },
  { id: "corps", label: "Corps" },
];
const PROGRES_TAB_KEY = "coach_progres_tab";
const EXERCISE_KEY = "coach_progres_exercise";

function savedChoice(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
}
function saveChoice(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* confort seulement */ }
}

/** Explication repliée sous la carte plutôt qu'un paragraphe toujours affiché. */
function helpHTML(text) {
  return `<details class="card-help"><summary>Comment lire ?</summary><p>${text}</p></details>`;
}

export async function renderData(token) {
  const el = document.getElementById("data-content");
  el.innerHTML = skeletonHTML();
  const file = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  if (!file) { el.innerHTML = "<p class='muted'>Pas encore de résumé exporté.</p>"; return; }
  const s = JSON.parse(file.content);
  let tab = savedChoice(PROGRES_TAB_KEY, "forme");
  if (!PROGRES_TABS.some((t) => t.id === tab)) tab = "forme";

  const draw = () => {
    const body = tab === "force" ? forceTabHTML(s) : tab === "corps" ? corpsTabHTML(s) : formeTabHTML(s);
    el.innerHTML = `
      <div class="segmented progres-tabs" role="tablist">${PROGRES_TABS.map((t) => `<button type="button" role="tab" class="segment${t.id === tab ? " active" : ""}" aria-selected="${t.id === tab}" data-progres-tab="${t.id}">${t.label}</button>`).join("")}</div>
      ${body}`;
    stripHeadingEmojis(el);
    el.querySelectorAll("[data-progres-tab]").forEach((b) => b.addEventListener("click", () => {
      tab = b.dataset.progresTab;
      saveChoice(PROGRES_TAB_KEY, tab);
      draw();
      window.scrollTo({ top: 0 });
    }));
    if (tab === "force") wireExerciseCard(el, s);
    const painLink = el.querySelector("[data-open-pain]");
    if (painLink) painLink.addEventListener("click", () => showView("pain"));
  };
  draw();
}

/** Titres sans emoji (icônes au trait partout ailleurs) — retire le
 * pictogramme de tête du premier nœud texte, sans toucher aux enfants. */
function stripHeadingEmojis(root) {
  root.querySelectorAll("h2").forEach((h) => {
    const node = [...h.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (node) node.textContent = node.textContent.replace(/^[\s\p{Extended_Pictographic}️‍]+/u, "");
  });
}

// ---------------------------------------------------------------- Forme
function formeTabHTML(s) {
  let html = readinessScoreHTML(s.readiness);

  if (s.workload) {
    const w = s.workload;
    const readings = s.workload_history || [];
    html += `
      <section class="card">
        <div class="card-head"><h2>Charge aiguë:chronique</h2><span class="workload-badge zone-${w.zone}">${WORKLOAD_ZONE_LABELS[w.zone] || w.zone}</span></div>
        ${workloadGaugeHTML(w.ratio)}
        <p class="workload-zone-help small">${WORKLOAD_ZONE_HELP[w.zone] || ""}</p>
        <div class="mini-stats">
          <div><span>Ratio</span><strong>${w.ratio.toFixed(2).replace(".", ",")}</strong></div>
          <div><span>7 derniers jours</span><strong>${Math.round(w.acute_load)} <small>u.a./j</small></strong></div>
          <div><span>Réf. 4 semaines</span><strong>${Math.round(w.chronic_load)} <small>u.a./j</small></strong></div>
        </div>
        ${readings.length > 1 ? `<div class="workload-trend"><div class="sleep-week-summary-label">Ratio, ${readings.length} derniers jours</div>${workloadTrendSVG(readings)}</div>` : ""}
        ${deloadInfoHTML(s.deload)}
        ${gymFrequencyInfoHTML(s.gym_frequency)}
        ${helpHTML("Ratio = charge des 7 derniers jours ÷ moyenne quotidienne des 4 dernières semaines (RPE × durée de séance, méthode de Foster). Repères : &lt;0,8 sous-charge, 0,8–1,3 zone optimale, 1,3–1,5 zone prudente, &gt;1,5 risque élevé.")}
      </section>`;
  } else {
    html += `<section class="card"><h2>Charge aiguë:chronique</h2><p class="muted small">Pas encore assez d'historique de charge : renseigne le RPE et la durée à chaque séance (environ 4 semaines avant un premier calcul fiable).</p></section>`;
  }

  const sr = s.sleep_recent || {};
  const sleepHist = sr.history || [];
  if (sr.avg_7d != null || sleepHist.length) {
    const delta = sr.avg_7d != null && sr.avg_prior_7d != null ? sr.avg_7d - sr.avg_prior_7d : null;
    html += `
      <section class="card">
        <div class="card-head"><h2>Sommeil</h2>${sr.avg_7d != null ? `<span class="card-head-value">${formatHoursFr(sr.avg_7d)}<small> / nuit</small></span>` : ""}</div>
        ${sleepHist.length ? barChartSVG(sleepHist.map((h) => ({ date: h.date, value: h.hours })), { reference: SLEEP_TARGET_HOURS, dayLabels: true }) : ""}
        <p class="small">${delta != null ? `<span class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "+" : "−"}${Math.round(Math.abs(delta) * 60)} min</span> par rapport aux 7 nuits d'avant` : ""}${sr.week_avg != null ? `${delta != null ? " · " : ""}cette semaine ${formatHoursFr(sr.week_avg)} sur ${sr.week_nights_logged} nuit${sr.week_nights_logged > 1 ? "s" : ""}` : ""}</p>
        ${(sr.weekly_average || []).length > 1 ? `<details class="card-more"><summary>Moyenne par semaine</summary>${sparklineSVG(sr.weekly_average.map((w) => ({ date: w.week_start, value: w.avg_hours })), { axis: true })}</details>` : ""}
        ${helpHTML(`Repère : au moins ${formatHoursFr(SLEEP_TARGET_HOURS)} par nuit — les barres dorées sont sous ce seuil.`)}
      </section>`;
  } else {
    html += `<section class="card"><h2>Sommeil</h2><p class="muted small">Pas encore de données de sommeil.</p></section>`;
  }

  // Récupération en courbes : la tendance compte plus que la valeur du jour.
  const rec = (s.recovery_recent && s.recovery_recent.history) || [];
  const series = (field) => rec.filter((r) => r[field] != null).map((r) => ({ date: r.date, value: r[field] }));
  const hr = series("resting_heart_rate");
  const hrv = series("hrv_ms");
  if (hr.length || hrv.length) {
    const block = (label, pts, unit, betterUp) => {
      if (!pts.length) return "";
      const last = pts[pts.length - 1].value;
      const avg = pts.reduce((a, p) => a + p.value, 0) / pts.length;
      const diff = last - avg;
      const good = betterUp ? diff >= 0 : diff <= 0;
      return `
        <div class="recovery-series">
          <div class="recovery-series-head"><span>${label}</span><strong>${Math.round(last)} <small>${unit}</small></strong>
            <span class="${good ? "trend-up" : "trend-down"} small">${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(0)} vs moy. ${pts.length} j</span></div>
          ${sparklineSVG(pts, { axis: true })}
        </div>`;
    };
    html += `
      <section class="card">
        <h2>Récupération</h2>
        ${block("FC repos", hr, "bpm", false)}
        ${block("HRV", hrv, "ms", true)}
        ${helpHTML("FC repos basse et HRV stable ou haute = bonne récupération. Une tendance inverse qui dure plusieurs jours est un signal précoce de fatigue.")}
      </section>`;
  }

  const well = (s.wellness_recent && s.wellness_recent.history) || [];
  if (well.length) {
    const last = well[well.length - 1];
    html += `
      <section class="card">
        <div class="card-head"><h2>Bien-être du matin</h2><span class="card-head-value">${last.score}<small> / 100</small></span></div>
        ${well.length > 1 ? sparklineSVG(well.map((w) => ({ date: w.date, value: w.score })), { axis: true }) : ""}
        <div class="mini-stats four">
          <div><span>Énergie</span><strong>${last.energie}/5</strong></div>
          <div><span>Stress</span><strong>${last.stress}/5</strong></div>
          <div><span>Courbatures</span><strong>${last.courbatures}/5</strong></div>
          <div><span>Motivation</span><strong>${last.motivation}/5</strong></div>
        </div>
        <p class="muted small">Dernier check-in : ${shortDateFr(last.date)}.</p>
      </section>`;
  }

  html += tendancesHTML(s.insights);
  return html;
}

// ---------------------------------------------------------------- Force
const LIFT_LABELS = { back_squat: "Back Squat", bench: "Bench", trap_bar_deadlift: "Trap Bar Deadlift" };

function numbers(raw) {
  if (raw == null || raw === "") return [];
  return String(raw).split("-").map((x) => parseFloat(String(x).replace(",", "."))).filter(Number.isFinite);
}

/** Meilleure série d'une entrée d'historique : charge max (charges à tirets
 * comprises) et reps de cette série ; 1RM estimé (Epley) si reps ≤ 12. */
function topSet(entry) {
  const loads = numbers(entry.load);
  if (!loads.length) return null;
  const reps = numbers(entry.reps).map(Math.round);
  let idx = 0;
  loads.forEach((l, i) => { if (l > loads[idx]) idx = i; });
  const r = reps.length ? reps[Math.min(idx, reps.length - 1)] : null;
  return { load: loads[idx], reps: r, e1rm: r && r > 0 && r <= 12 ? loads[idx] * (1 + r / 30) : null };
}

/** Une ligne par date (doublons plan/réalisé fusionnés sur la meilleure
 * série), passé uniquement, plus ancien d'abord. */
function exerciseSeries(entries, today) {
  const byDate = new Map();
  for (const e of entries || []) {
    if (!e.date || e.date > today) continue;
    const t = topSet(e);
    if (!t) continue;
    const prev = byDate.get(e.date);
    if (!prev || t.load > prev.top.load) byDate.set(e.date, { date: e.date, top: t, entry: e });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function fmtKg(v) {
  return `${(Math.round(v * 10) / 10).toString().replace(".", ",")} kg`;
}

function recentRecords(history, today) {
  const records = [];
  for (const [name, entries] of Object.entries(history || {})) {
    const series = exerciseSeries(entries, today);
    let best = null;
    for (const p of series) {
      if (best != null && p.top.load > best) records.push({ name, date: p.date, load: p.top.load, reps: p.top.reps, gain: p.top.load - best });
      best = best == null ? p.top.load : Math.max(best, p.top.load);
    }
  }
  return records.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
}

const PINNED_KEY = "coach_progres_pinned";
const DEFAULT_PINNED = ["Back Squat", "Bench", "Trap Bar Deadlift"];

/** Exercices suivis (mémorisés sur l'appareil) : par défaut les 3 grands
 * mouvements ; ceux qui n'existent plus dans l'historique sont ignorés. */
function pinnedExercises(s) {
  const known = Object.keys(s.exercise_history || {});
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PINNED_KEY)); } catch (_) { saved = null; }
  const list = Array.isArray(saved) ? saved : DEFAULT_PINNED;
  return list.filter((n) => known.includes(n));
}

function forceTabHTML(s) {
  const today = todayISO();
  let html = "";

  let tiles = "";
  for (const [key, label] of Object.entries(LIFT_LABELS)) {
    const entry = s.strength_trajectory && s.strength_trajectory[key];
    if (!entry) continue;
    const best = entry.recent_best;
    tiles += statTile(label, best ? best.load : null, " kg", entry.progress_fraction,
      entry.target ? `Cible 4RM : ${entry.target.four_rm.toFixed(1)} kg` : "Pas de cible calculable", entry.baseline_load, entry.baseline_date);
  }
  if (tiles) html += `<section class="card"><h2>Trajectoire de force</h2><div class="stat-grid three">${tiles}</div></section>`;

  html += `<section class="card exercise-card" id="exercise-card"></section>`;

  const pinned = pinnedExercises(s);
  const records = recentRecords(Object.fromEntries(Object.entries(s.exercise_history || {}).filter(([n]) => pinned.includes(n))), today);
  html += `
    <section class="card">
      <h2>Records récents</h2>
      ${records.length ? `<ul class="record-list">${records.map((r) => `
        <li><span class="record-date">${shortDateFr(r.date)}</span>
          <span class="record-name">${escapeHtmlText(r.name)}</span>
          <span class="record-val">${fmtKg(r.load)}${r.reps ? ` × ${r.reps}` : ""}<small>+${fmtKg(r.gain)}</small></span></li>`).join("")}</ul>`
        : "<p class='muted small'>Pas de nouvelle charge record sur tes exercices suivis.</p>"}
      ${helpHTML("Une charge est un record quand elle dépasse toutes les précédentes de l'exercice parmi ses 10 dernières séances (l'historique tenu par l'app). Seuls tes exercices suivis (fiche exercice) sont listés.")}
    </section>`;

  html += tonnageMilestoneHTML(s.tonnage || {}, LIFT_LABELS);
  html += tonnageSectionHTML(s.tonnage);

  return html;
}

/** Fiche exercice : les exercices SUIVIS (puces), choisis dans une liste de
 * tous les exercices chargés. Meilleure charge par séance en courbe, 1RM
 * estimé, dernières séances. Le choix est mémorisé sur l'appareil. */
function wireExerciseCard(el, s) {
  const card = el.querySelector("#exercise-card");
  if (!card) return;
  const today = todayISO();
  const all = Object.entries(s.exercise_history || {})
    .map(([name, entries]) => ({ name, series: exerciseSeries(entries, today) }))
    .filter((o) => o.series.length >= 1)
    .sort((a, b) => b.series.length - a.series.length || a.name.localeCompare(b.name));
  if (!all.length) { card.remove(); return; }
  const byName = new Map(all.map((o) => [o.name, o]));
  let pinned = pinnedExercises(s).filter((n) => byName.has(n));
  let current = savedChoice(EXERCISE_KEY, pinned[0] || "");
  let picking = false;

  const persistPinned = () => {
    try { localStorage.setItem(PINNED_KEY, JSON.stringify(pinned)); } catch (_) { /* confort seulement */ }
  };

  const detailHTML = (opt) => {
    const series = opt.series;
    const best = series.reduce((a, p) => (p.top.load > a.top.load ? p : a), series[0]);
    const e1rms = series.filter((p) => p.top.e1rm != null);
    const bestE1rm = e1rms.length ? Math.max(...e1rms.map((p) => p.top.e1rm)) : null;
    const first = series[0], last = series[series.length - 1];
    const delta = last.top.load - first.top.load;
    return `
      <div class="mini-stats">
        <div><span>Meilleure charge</span><strong>${fmtKg(best.top.load)}</strong><small>${shortDateFr(best.date)}</small></div>
        <div><span>1RM estimé</span><strong>${bestE1rm != null ? fmtKg(bestE1rm) : "—"}</strong><small>${bestE1rm != null ? "Epley" : "reps &gt; 12"}</small></div>
        <div><span>Évolution</span><strong class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "+" : "−"}${fmtKg(Math.abs(delta))}</strong><small>depuis le ${shortDateFr(first.date)}</small></div>
      </div>
      ${series.length > 1 ? `<div class="sleep-week-summary-label">Meilleure charge par séance</div>${sparklineSVG(series.map((p) => ({ date: p.date, value: p.top.load })), { axis: true })}` : ""}
      <ul class="exercise-sessions">${[...series].reverse().slice(0, 6).map((p) => {
        const e = p.entry;
        const reps = String(e.reps ?? "").split("-").filter((x) => x.trim()).join("-");
        const repsText = reps.includes("-") ? `${reps} reps` : [e.sets ? `${e.sets} ×` : "", reps].join(" ").trim();
        const load = String(e.load ?? "").split("-").filter((x) => x.trim()).join("-");
        return `<li><span>${shortDateFr(p.date)}</span><span>${escapeHtmlText(repsText || "—")}</span><strong>${escapeHtmlText(load)}${/^[\d.,-]+$/.test(load) ? " kg" : ""}</strong></li>`;
      }).join("")}</ul>`;
  };

  const draw = () => {
    if (!pinned.includes(current)) current = pinned[0] || "";
    const chips = pinned.map((n) => `<button type="button" class="suggestion-chip${n === current ? " active" : ""}" data-ex="${escapeAttr(n)}">${escapeHtmlText(n)}</button>`).join("");
    const picker = picking ? `
      <div class="exercise-picklist">
        <p class="muted small">Coche les exercices que tu veux suivre.</p>
        ${all.map((o) => `<label class="exercise-pick"><input type="checkbox" data-pick="${escapeAttr(o.name)}"${pinned.includes(o.name) ? " checked" : ""}><span>${escapeHtmlText(o.name)}</span><small class="muted">${o.series.length} séance${o.series.length > 1 ? "s" : ""}</small></label>`).join("")}
      </div>` : "";
    card.innerHTML = `
      <div class="card-head"><h2>Fiche exercice</h2><button type="button" class="link-button" id="exercise-manage">${picking ? "Terminé" : "Choisir"}</button></div>
      ${chips ? `<div class="exercise-chips">${chips}</div>` : `<p class="muted small">Aucun exercice suivi — touche « Choisir ».</p>`}
      ${picker}
      ${!picking && current && byName.has(current) ? detailHTML(byName.get(current)) : ""}`;
    stripHeadingEmojis(card);
    card.querySelector("#exercise-manage").addEventListener("click", () => { picking = !picking; draw(); });
    card.querySelectorAll("[data-ex]").forEach((b) => b.addEventListener("click", () => {
      current = b.dataset.ex; saveChoice(EXERCISE_KEY, current); draw();
    }));
    card.querySelectorAll("[data-pick]").forEach((cb) => cb.addEventListener("change", () => {
      const name = cb.dataset.pick;
      pinned = cb.checked ? [...pinned, name] : pinned.filter((n) => n !== name);
      persistPinned();
    }));
  };
  draw();
}

// ---------------------------------------------------------------- Corps
function corpsTabHTML(s) {
  let html = "";
  const bp = s.bodyweight_progress;
  const bw = (s.bodyweight_recent && s.bodyweight_recent.history) || [];
  if (bw.length || bp) {
    const first = bw.length ? bw[0].weight_kg : null;
    const last = bw.length ? bw[bw.length - 1].weight_kg : bp.current_kg;
    const delta = first != null ? last - first : null;
    const perWeek = delta != null ? delta / Math.max(1, bw.length - 1) : null;
    html += `
      <section class="card">
        <div class="card-head"><h2>Poids de corps</h2><span class="card-head-value">${last.toFixed(1).replace(".", ",")}<small> kg</small></span></div>
        ${bp ? `<div class="target-bar"><div class="target-bar-fill" style="width:${Math.round(Math.max(0, Math.min(1, bp.fraction)) * 100)}%"></div></div>
        <p class="small target-bar-legend"><span>Départ ${bp.baseline_kg} kg</span><span>${Math.round(bp.fraction * 100)} % de l'objectif</span><span>Cible ${bp.target_kg} kg</span></p>` : ""}
        ${bw.length > 1 ? sparklineSVG(bw.map((h) => ({ date: h.week_start, value: h.weight_kg })), { axis: true }) : ""}
        ${delta != null && bw.length > 1 ? `<p class="small"><span class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1).replace(".", ",")} kg</span> en ${bw.length - 1} semaines (≈ ${perWeek >= 0 ? "+" : "−"}${Math.abs(perWeek).toFixed(2).replace(".", ",")} kg/semaine, moyennes hebdomadaires)</p>` : ""}
      </section>`;
  } else {
    html += `<section class="card"><h2>Poids de corps</h2><p class="muted small">Pas encore assez de pesées récentes.</p></section>`;
  }

  const bc = s.body_composition || [];
  if (bc.length) {
    const latest = bc[bc.length - 1];
    const prev = bc.length > 1 ? bc[bc.length - 2] : null;
    const delta = (field) => (prev && latest[field] != null && prev[field] != null) ? latest[field] - prev[field] : null;
    html += `
      <section class="card">
        <div class="card-head"><h2>Composition corporelle</h2><span class="muted small">InBody du ${shortDateFr(latest.date)}</span></div>
        <div class="stat-grid">
          ${latest.skeletal_muscle_mass_kg != null ? statTileSimple("Masse musculaire", `${latest.skeletal_muscle_mass_kg.toFixed(1)} kg`, delta("skeletal_muscle_mass_kg"), " kg", "up") : ""}
          ${latest.fat_mass_kg != null ? statTileSimple("Masse grasse", `${latest.fat_mass_kg.toFixed(1)} kg`, delta("fat_mass_kg"), " kg", "down") : ""}
        </div>
        ${latest.inbody_score != null ? `<p class="muted small" style="margin-top:8px">Score InBody : ${latest.inbody_score}${prev && prev.inbody_score != null ? ` (avant : ${prev.inbody_score})` : ""}</p>` : ""}
      </section>`;
  } else {
    html += `<section class="card"><h2>Composition corporelle</h2><p class="muted small">Pas encore de scan InBody enregistré.</p></section>`;
  }

  const episodes = ((s.pain_recent && s.pain_recent.episodes) || []).slice(-3).reverse();
  const zones = (s.pain_recent && s.pain_recent.zones) || {};
  html += `
    <section class="card">
      <h2>Douleurs</h2>
      ${episodes.length ? `<ul class="pain-mini-list">${episodes.map((ep) => `
        <li><span class="pain-level-badge" style="background:${painLevelColor(ep.level_end)}">${ep.level_end}</span>
          <span><strong>${escapeHtmlText(zones[ep.zone] || ep.zone)}</strong><small>${shortDateFr(ep.start_date)}${ep.end_date !== ep.start_date ? ` → ${shortDateFr(ep.end_date)}` : ""} · pic ${ep.level_peak}/10</small></span></li>`).join("")}</ul>`
        : "<p class='muted small'>Aucune douleur loguée récemment.</p>"}
      <button type="button" class="primary-button ghost small" data-open-pain>Historique et saisie</button>
    </section>`;
  return html;
}

export const READINESS_LEVEL_LABELS = {
  pret: "Prêt à pousser",
  bonne_forme: "Bonne forme",
  vigilance: "Vigilance",
  repos_recommande: "Repos recommandé",
};
const READINESS_COMPONENT_LABELS = { charge: "Charge", sommeil: "Sommeil", recuperation: "Récupération", bien_etre: "Bien-être" };

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
      ${helpHTML("Croise charge aiguë:chronique, sommeil récent, récupération (FC repos/HRV) et bien-être du check-in du matin — un repère, pas une vérité absolue.")}
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

/** Ligne discrète sous la carte ACWR (voir docs/adr/0065) — "deload
 * proactif" : visible même quand la charge n'est pas encore en zone à
 * risque (transparence sur le compte à rebours), pas seulement au moment
 * où l'alerte `deload_conseille` apparaît dans Aujourd'hui. */
function deloadInfoHTML(deload) {
  if (!deload) return "";
  const weeks = deload.weeks_since_light_week;
  const plural = weeks > 1 ? "s" : "";
  if (deload.due) {
    return `<p class="muted small">📉 Aucune semaine nettement allégée depuis ${weeks} semaine${plural} — une semaine de décharge est conseillée.</p>`;
  }
  return `<p class="muted small">Dernière semaine nettement allégée il y a ${weeks} semaine${plural}.</p>`;
}

/** Ligne discrète sous la carte ACWR, juste après `deloadInfoHTML` (voir
 * docs/adr/0066) — retour direct de l'utilisateur : par le passé, la
 * reprise du rugby a toujours fait disparaître la musculation en dehors
 * des entraînements. Toujours visible dès que le rugby a repris (pas
 * seulement quand l'alerte `prepa_physique_en_baisse` se déclenche) —
 * même logique de transparence que `deloadInfoHTML`. */
function gymFrequencyInfoHTML(gymFrequency) {
  if (!gymFrequency || !gymFrequency.current_week) return "";
  const { target, current_week: current } = gymFrequency;
  const low = gymFrequency.status && gymFrequency.status.low;
  const icon = current.count >= target ? "✅" : low ? "🏋️" : "";
  const prefix = icon ? `${icon} ` : "";
  return `<p class="muted small">${prefix}Musculation cette semaine : ${current.count}/${target} séance${target > 1 ? "s" : ""}${low ? " — en retrait depuis plusieurs semaines, à rattraper." : "."}</p>`;
}

/** "Tendances" (voir docs/adr/0065) — retour direct : "établir des liens
 * de cause à effet cohérents avec la gestion de ma prépa physique".
 * Toujours affichée (même convention que le reste de l'onglet Data,
 * tâche #56 : "always-visible placeholders") — un placeholder tant
 * qu'aucune des trois tendances n'a assez d'observations, jamais une
 * section qui disparaît silencieusement. */
function tendancesHTML(insights) {
  const cards = [];
  const sleep = insights && insights.sleep_vs_rpe;
  if (sleep) {
    cards.push(`
      <div class="tendance-row">
        <p class="small"><strong>Sommeil → ressenti d'effort</strong></p>
        <p class="small">Nuits &lt; ${sleep.threshold_hours}h : RPE moyen ${sleep.short_night_avg_rpe}/10 (${sleep.short_night_n} jours) — nuits correctes : RPE moyen ${sleep.good_night_avg_rpe}/10 (${sleep.good_night_n} jours).</p>
      </div>`);
  }
  const match = insights && insights.match_contact_vs_followup_rpe;
  if (match) {
    const rows = Object.entries(match.by_intensity)
      .map(([intensity, v]) => `${CONTACT_INTENSITY_LABELS_FR[intensity] || intensity} : RPE moyen ${v.avg_followup_rpe}/10 sur les ${match.window_days} jours suivants (${v.n} jours)`)
      .join(" · ");
    cards.push(`
      <div class="tendance-row">
        <p class="small"><strong>Intensité des contacts en match → séances suivantes</strong></p>
        <p class="small">${rows}</p>
      </div>`);
  }
  const pain = insights && insights.pain_onset_vs_load;
  if (pain) {
    cards.push(`
      <div class="tendance-row">
        <p class="small"><strong>Charge d'entraînement → apparition de douleur</strong></p>
        <p class="small">Charge aiguë moyenne au début d'un épisode de douleur : ${pain.onset_avg_acute_load} u.a. (${pain.onset_n} épisode${pain.onset_n > 1 ? "s" : ""}) — contre ${pain.baseline_avg_acute_load} u.a. en moyenne le reste du temps.</p>
      </div>`);
  }

  if (!cards.length) {
    return `
      <section class="card">
        <h2>📊 Tendances</h2>
        <p class="muted small">Pas encore assez d'historique pour un premier repère fiable (échantillon trop réduit) — reviens plus tard.</p>
      </section>`;
  }
  return `
    <section class="card">
      <h2>📊 Tendances</h2>
      ${cards.join("")}
      <p class="muted small">Tendances observées sur ton propre historique, pas une preuve causale — un repère parmi d'autres, jamais une conclusion isolée.</p>
    </section>`;
}
