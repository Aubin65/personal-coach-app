import { escapeHtmlText, escapeAttr } from "../markdown.js";
import { shortDateFr } from "./data-viz.js";

// Progrès › Activité (docs/adr/0099) — temps passé, fréquence et volume,
// calculés par coach.training_stats (summary.json → `training_stats`).
// Aucune donnée n'est inventée : seules les séances réellement faites comptent.

const TYPE_LABELS = { musculation: "Muscu", rugby: "Rugby", match: "Match", autre: "Autre" };
const METRICS = [
  { id: "minutes", label: "Temps", value: (w) => w.minutes, fmt: (v) => fmtMinutes(v) },
  { id: "sessions", label: "Séances", value: (w) => w.sessions, fmt: (v) => String(v) },
  { id: "tonnage_kg", label: "Tonnage", value: (w) => w.tonnage_kg, fmt: (v) => fmtTonnage(v) },
  { id: "sets", label: "Séries", value: (w) => w.sets, fmt: (v) => String(v) },
];
const METRIC_KEY = "coach_activity_metric";
const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

export function fmtMinutes(min) {
  if (!min) return "0 min";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}
export function fmtTonnage(kg) {
  if (!kg) return "0 kg";
  return kg >= 10000 ? `${(kg / 1000).toFixed(1).replace(".", ",")} t` : `${Math.round(kg).toLocaleString("fr-FR")} kg`;
}
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function tile(label, value, sub) {
  return `<div class="activity-tile"><span class="activity-tile-label">${label}</span><strong>${value}</strong>${sub ? `<span class="activity-tile-sub">${sub}</span>` : ""}</div>`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function level(minutes) {
  if (!minutes) return 1;
  return minutes < 40 ? 1 : minutes < 70 ? 2 : minutes < 100 ? 3 : 4;
}
function kindClass(types) {
  const gym = types.includes("musculation");
  const team = types.some((t) => t === "rugby" || t === "match");
  if (gym && team) return "t-mix";
  if (gym) return "t-gym";
  if (team) return "t-team";
  return "t-other";
}

/** Calendrier façon contributions GitHub : une colonne par semaine (lundi en
 * haut), une case par jour, intensité = durée, teinte = type de séance. */
export function heatmapHTML(stats, today) {
  const byDate = new Map(stats.days.map((d) => [d.date, d]));
  const start = stats.weeks[0].week_start;
  const weeks = stats.weeks.length;
  const monthRow = [];
  let lastMonth = -1;
  const cells = [];
  for (let w = 0; w < weeks; w++) {
    const monday = addDays(start, w * 7);
    const month = Number(monday.slice(5, 7)) - 1;
    monthRow.push(month !== lastMonth ? `<span style="grid-column:${w + 1}">${MONTHS[month]}</span>` : "");
    lastMonth = month;
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      if (date > today) { cells.push(`<span class="hm-cell hm-future"></span>`); continue; }
      const day = byDate.get(date);
      const cls = day ? `${kindClass(day.types)} l${level(day.duration_min)}` : "l0";
      cells.push(`<button type="button" class="hm-cell ${cls}${date === today ? " hm-today" : ""}" data-hm-date="${date}" aria-label="${shortDateFr(date)}${day ? `, ${fmtMinutes(day.duration_min)}` : ", repos"}"></button>`);
    }
  }
  return `
    <div class="hm-wrap">
      <div class="hm-months" style="grid-template-columns:repeat(${weeks},1fr)">${monthRow.join("")}</div>
      <div class="hm-body">
        <div class="hm-weekdays">${WEEKDAYS.map((d, i) => `<span>${i % 2 === 0 ? d : ""}</span>`).join("")}</div>
        <div class="hm-grid" style="grid-template-columns:repeat(${weeks},1fr)">${cells.join("")}</div>
      </div>
    </div>
    <div class="hm-legend small muted">
      <span class="hm-key t-gym l3"></span>Muscu <span class="hm-key t-team l3"></span>Rugby / match <span class="hm-key t-mix l3"></span>Les deux
      <span class="hm-intensity">moins <span class="hm-key t-gym l1"></span><span class="hm-key t-gym l2"></span><span class="hm-key t-gym l3"></span><span class="hm-key t-gym l4"></span> plus</span>
    </div>
    <p class="hm-detail small" id="hm-detail" aria-live="polite">Touche une case pour voir le détail du jour.</p>`;
}

function dayDetailText(day, date) {
  if (!day) return `${shortDateFr(date)} — repos.`;
  const types = day.types.map((t) => TYPE_LABELS[t] || t).join(" + ");
  const parts = [types, day.duration_min ? fmtMinutes(day.duration_min) : null, day.tonnage_kg ? fmtTonnage(day.tonnage_kg) : null].filter(Boolean);
  return `${shortDateFr(date)} — ${parts.join(" · ")}`;
}

function weeksChartHTML(stats, metricId) {
  const metric = METRICS.find((m) => m.id === metricId) || METRICS[0];
  const weeks = stats.weeks.slice(-12);
  const max = Math.max(...weeks.map(metric.value), 1);
  const avgWeeks = weeks.filter((w) => metric.value(w) > 0);
  const avg = avgWeeks.length ? avgWeeks.reduce((a, w) => a + metric.value(w), 0) / avgWeeks.length : 0;
  return `
    <div class="wk-bars">${weeks.map((w, i) => {
      const v = metric.value(w);
      return `<div class="wk-col" title="Sem. du ${shortDateFr(w.week_start)} : ${metric.fmt(v)}">
        <span class="wk-val">${v ? metric.fmt(v).replace(" min", "′") : ""}</span>
        <span class="wk-bar${i === weeks.length - 1 ? " current" : ""}" style="height:${Math.max(v ? 6 : 2, (v / max) * 100)}%"></span>
        <span class="wk-label">${w.week_start.slice(8, 10)}/${w.week_start.slice(5, 7)}</span>
      </div>`;
    }).join("")}</div>
    <p class="small muted">${avg ? `Moyenne des semaines actives : ${metric.fmt(Math.round(avg))}` : "Pas encore de donnée."} · semaine en cours en doré.</p>`;
}

function typeSplitHTML(totals) {
  const entries = Object.entries(totals.by_type);
  const total = entries.reduce((a, [, v]) => a + v.minutes, 0);
  if (!total) return "";
  return `
    <div class="split-bar">${entries.filter(([, v]) => v.minutes).map(([t, v]) => `<span class="split-seg split-${t}" style="flex:${v.minutes}" title="${TYPE_LABELS[t]} : ${fmtMinutes(v.minutes)}"></span>`).join("")}</div>
    <ul class="split-list small">${entries.map(([t, v]) => `<li><span class="split-dot split-${t}"></span>${TYPE_LABELS[t] || t} — ${fmtMinutes(v.minutes)} · ${plural(v.sessions, "séance", "séances")}${v.avg_duration_min ? ` · ${v.avg_duration_min} min en moyenne` : ""}${v.avg_rpe != null ? ` · RPE ${String(v.avg_rpe).replace(".", ",")}` : ""}</li>`).join("")}</ul>`;
}

function weekdayHTML(totals) {
  const max = Math.max(...totals.by_weekday, 1);
  const best = totals.by_weekday.indexOf(Math.max(...totals.by_weekday));
  return `
    <div class="wd-bars">${totals.by_weekday.map((n, i) => `<div class="wd-col"><span class="wd-val">${n || ""}</span><span class="wd-bar${i === best && n ? " best" : ""}" style="height:${Math.max(n ? 8 : 2, (n / max) * 100)}%"></span><span class="wd-label">${WEEKDAYS[i]}</span></div>`).join("")}</div>`;
}

export function activityTabHTML(s) {
  const stats = s.training_stats;
  if (!stats || !stats.totals) {
    return `<section class="card"><h2>Activité</h2><p class="muted">Aucune séance terminée pour l'instant — dès que tu en auras loggé une (durée ou RPE renseignés), le calendrier et les stats apparaîtront ici.</p></section>`;
  }
  const t = stats.totals;
  const today = stats.generated_for;
  const metricId = (() => { try { return localStorage.getItem(METRIC_KEY) || "minutes"; } catch (_) { return "minutes"; } })();
  const records = [
    t.longest_gym ? `<li><span>Plus longue séance en salle</span><strong>${fmtMinutes(t.longest_gym.duration_min)}</strong><small>${shortDateFr(t.longest_gym.date)}</small></li>` : "",
    t.heaviest_gym ? `<li><span>Plus gros tonnage</span><strong>${fmtTonnage(t.heaviest_gym.tonnage_kg)}</strong><small>${shortDateFr(t.heaviest_gym.date)}</small></li>` : "",
    t.best_week ? `<li><span>Semaine la plus chargée</span><strong>${fmtMinutes(t.best_week.minutes)}</strong><small>sem. du ${shortDateFr(t.best_week.week_start)}</small></li>` : "",
    `<li><span>Jours d'affilée avec activité</span><strong>${t.current_run_days}</strong><small>record ${t.longest_run_days}</small></li>`,
  ].join("");
  return `
    <section class="card activity-hero">
      <div class="card-head"><h2>Entraînement</h2><span class="muted small">depuis le ${shortDateFr(t.since)}</span></div>
      <div class="activity-tiles">
        ${tile("Temps en salle", fmtMinutes(t.gym.minutes), `${fmtMinutes(t.gym_month.minutes)} ce mois-ci`)}
        ${tile("Temps total", fmtMinutes(t.all.minutes), `${fmtMinutes(t.month.minutes)} ce mois-ci`)}
        ${tile("Séances", String(t.all.sessions), `${t.gym.sessions} en salle · ${t.active_days} jours actifs`)}
        ${tile("Durée moyenne", t.gym.avg_duration_min ? `${t.gym.avg_duration_min} min` : "—", t.gym.avg_rpe != null ? `RPE moyen ${String(t.gym.avg_rpe).replace(".", ",")}` : "séance de muscu")}
        ${tile("Tonnage soulevé", fmtTonnage(t.gym.tonnage_kg), t.gym.sessions ? `${fmtTonnage(Math.round(t.gym.tonnage_kg / t.gym.sessions))} / séance` : "")}
        ${tile("Séries · reps", `${t.gym.sets} · ${t.gym.reps}`, t.gym.sessions ? `${Math.round(t.gym.sets / t.gym.sessions)} séries / séance` : "")}
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Calendrier d'activité</h2><span class="muted small">${stats.weeks.length} semaines</span></div>
      ${heatmapHTML(stats, today)}
    </section>
    <section class="card">
      <div class="card-head"><h2>Semaine par semaine</h2></div>
      <div class="segmented metric-switch" role="tablist">${METRICS.map((m) => `<button type="button" class="segment${m.id === metricId ? " active" : ""}" data-activity-metric="${m.id}">${m.label}</button>`).join("")}</div>
      <div id="activity-weeks">${weeksChartHTML(stats, metricId)}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Répartition</h2></div>
      ${typeSplitHTML(t)}
    </section>
    <section class="card">
      <div class="card-head"><h2>Jours d'entraînement</h2><span class="muted small">séances / jour</span></div>
      ${weekdayHTML(t)}
    </section>
    <section class="card">
      <div class="card-head"><h2>Records</h2></div>
      <ul class="records-list">${records}</ul>
    </section>`;
}

export function wireActivity(root, s) {
  const stats = s.training_stats;
  if (!stats || !stats.totals) return;
  const byDate = new Map(stats.days.map((d) => [d.date, d]));
  const detail = root.querySelector("#hm-detail");
  root.querySelectorAll("[data-hm-date]").forEach((cell) => cell.addEventListener("click", () => {
    root.querySelectorAll(".hm-cell.selected").forEach((c) => c.classList.remove("selected"));
    cell.classList.add("selected");
    if (detail) detail.textContent = dayDetailText(byDate.get(cell.dataset.hmDate), cell.dataset.hmDate);
  }));
  root.querySelectorAll("[data-activity-metric]").forEach((btn) => btn.addEventListener("click", () => {
    try { localStorage.setItem(METRIC_KEY, btn.dataset.activityMetric); } catch (_) { /* confort seulement */ }
    root.querySelectorAll("[data-activity-metric]").forEach((b) => b.classList.toggle("active", b === btn));
    const target = root.querySelector("#activity-weeks");
    if (target) target.innerHTML = weeksChartHTML(stats, btn.dataset.activityMetric);
  }));
}
