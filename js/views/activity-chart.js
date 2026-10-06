import { escapeHtmlText, escapeAttr } from "../markdown.js";
import { TYPE_LABELS, TYPE_ORDER, fmtMinutes, fmtLoad, fmtTonnage, rpeText } from "./activity-fmt.js";

// Graphique d'évolution de Progrès › Activité (docs/adr/0099, amendements) :
// barres empilées par type (muscu / rugby / match), au jour, à la semaine ou
// au mois, sur la métrique choisie, avec en option les douleurs signalées, une
// ligne de moyenne, et un détail au toucher qui compare la période à la
// moyenne des périodes actives précédentes.

export const METRICS = [
  { id: "load_ua", label: "Charge", fmt: fmtLoad, short: (v) => String(Math.round(v)) },
  { id: "minutes", label: "Temps", fmt: fmtMinutes, short: (v) => fmtMinutes(v).replace(" min", "′") },
  { id: "sessions", label: "Séances", fmt: (v) => String(v), short: (v) => String(v) },
  { id: "tonnage_kg", label: "Tonnage", fmt: fmtTonnage, short: (v) => fmtTonnage(v).replace(" kg", "") },
  { id: "sets", label: "Séries", fmt: (v) => String(v), short: (v) => String(v) },
  { id: "avg_rpe", label: "RPE", fmt: rpeText, short: rpeText },
];
export const GRANULARITIES = [
  { id: "day", label: "Jour", size: 28 },
  { id: "week", label: "Semaine", size: 12 },
  { id: "month", label: "Mois", size: 6 },
];
const PREFS_KEY = "coach_activity_chart";
const DEFAULTS = { gran: "week", metric: "load_ua", pain: false, avg: false, stack: true };

function loadPrefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; } catch (_) { return { ...DEFAULTS }; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* confort seulement */ }
}

// ---- dates (ISO, midi local pour éviter les décalages d'heure d'été) ----
const at = (iso) => new Date(`${iso}T12:00:00`);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function addDays(isoDate, n) { const d = at(isoDate); d.setDate(d.getDate() + n); return iso(d); }
function mondayOf(isoDate) { const d = at(isoDate); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); }
export function periodKey(date, gran) {
  return gran === "day" ? date : gran === "week" ? mondayOf(date) : date.slice(0, 7);
}

/** Périodes continues (sans trou) du premier jour de données à aujourd'hui,
 * chacune agrégée depuis `stats.days`. Pur, testable. */
export function buildPeriods(stats, gran, today) {
  const start = stats.weeks[0].week_start;
  const keys = [];
  const map = new Map();
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const key = periodKey(d, gran);
    if (!map.has(key)) {
      const p = { key, sessions: 0, minutes: 0, load_ua: 0, tonnage_kg: 0, sets: 0, rpes: [], by_type: {} };
      map.set(key, p);
      keys.push(key);
    }
  }
  for (const day of stats.days) {
    const p = map.get(periodKey(day.date, gran));
    if (!p) continue;
    p.sessions += day.sessions;
    p.minutes += day.duration_min;
    p.load_ua += day.load_ua || 0;
    p.tonnage_kg += day.tonnage_kg;
    p.rpes.push(...(day.rpes || []));
    for (const [t, v] of Object.entries(day.by_type || {})) {
      const bt = p.by_type[t] || (p.by_type[t] = { sessions: 0, minutes: 0, load_ua: 0, tonnage_kg: 0, sets: 0 });
      for (const k of Object.keys(bt)) bt[k] += v[k] || 0;
      p.sets += v.sets || 0;
    }
  }
  return keys.map((k) => {
    const p = map.get(k);
    p.avg_rpe = p.rpes.length ? Math.round((p.rpes.reduce((a, b) => a + b, 0) / p.rpes.length) * 10) / 10 : 0;
    return p;
  });
}

export function periodValue(p, metricId) { return p[metricId] || 0; }

/** Moyenne des `n` périodes actives (valeur > 0) qui précèdent l'indice `i`. */
export function previousActiveMean(periods, i, metricId, n = 4) {
  const prev = periods.slice(0, i).map((p) => periodValue(p, metricId)).filter((v) => v > 0).slice(-n);
  return prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;
}

function periodLabel(p, gran) {
  if (gran === "day") return at(p.key).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  if (gran === "week") return `Semaine du ${at(p.key).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} au ${at(addDays(p.key, 6)).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}`;
  const label = at(`${p.key}-01`).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function axisLabel(p, gran) {
  if (gran === "day") return String(Number(p.key.slice(8, 10)));
  if (gran === "week") return `${p.key.slice(8, 10)}/${p.key.slice(5, 7)}`;
  return at(`${p.key}-01`).toLocaleDateString("fr-FR", { month: "short" }).replace(".", "");
}
function rangeLabel(first, last, gran) {
  if (!first) return "";
  const f = (p) => (gran === "month" ? axisLabel(p, gran) : `${p.key.slice(8, 10)}/${p.key.slice(5, 7)}`);
  return `${f(first)} → ${f(last)}`;
}

function painByPeriod(events, gran) {
  const map = new Map();
  for (const e of events || []) {
    const key = periodKey(e.date, gran);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}
const zoneLabel = (zone, zones) => (zones && zones[zone]) || String(zone || "douleur").replace(/_/g, " ");

function chartInner(stats, zones, today, st) {
  const gran = GRANULARITIES.find((g) => g.id === st.prefs.gran) || GRANULARITIES[1];
  const metric = METRICS.find((m) => m.id === st.prefs.metric) || METRICS[0];
  const periods = buildPeriods(stats, gran.id, today);
  const pains = painByPeriod(stats.pain_events, gran.id);
  const end = Math.max(gran.size > periods.length ? periods.length : periods.length - st.offset * gran.size, Math.min(gran.size, periods.length));
  const start = Math.max(0, end - gran.size);
  const view = periods.slice(start, end);
  const canOlder = start > 0;
  const canNewer = end < periods.length;
  if (st.selected == null || !view.some((p) => p.key === st.selected)) st.selected = view[view.length - 1].key;

  const values = view.map((p) => periodValue(p, metric.id));
  const max = Math.max(...values, 1);
  const active = values.filter((v) => v > 0);
  const avg = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
  const stackable = metric.id !== "avg_rpe" && st.prefs.stack;
  const present = TYPE_ORDER.filter((t) => view.some((p) => ((p.by_type[t] || {})[metric.id] || 0) > 0));
  const dense = view.length > 14;
  const labelStep = gran.id === "day" ? 4 : gran.id === "week" ? 2 : 1;

  const cols = view.map((p, i) => {
    const v = values[i];
    const h = v ? Math.max(4, (v / max) * 100) : 0;
    let bar = "";
    if (v) {
      const segs = stackable ? present.map((t) => [t, (p.by_type[t] || {})[metric.id] || 0]).filter(([, tv]) => tv > 0) : [];
      bar = segs.length
        ? `<span class="ch-bar stacked" style="height:${h}%">${segs.map(([t, tv]) => `<span class="ch-seg split-${t}" style="flex:${tv}"></span>`).join("")}</span>`
        : `<span class="ch-bar" style="height:${h}%"></span>`;
    }
    const ev = pains.get(p.key) || [];
    const worst = ev.reduce((a, e) => Math.max(a, Number(e.level) || 0), 0);
    const dot = st.prefs.pain && ev.length ? `<span class="ch-pain-dot" style="--s:${(dense ? 6 : 8) + worst * (dense ? 0.4 : 0.8)}px" aria-label="${ev.length} douleur(s), max ${worst}/10"></span>` : "";
    const showLabel = (view.length - 1 - i) % labelStep === 0 || gran.id === "month";
    return `
      <button type="button" class="ch-col${p.key === st.selected ? " selected" : ""}" data-ch-key="${escapeAttr(p.key)}" aria-label="${escapeAttr(periodLabel(p, gran.id))} : ${escapeAttr(metric.fmt(v))}">
        <span class="ch-val">${v && !dense ? escapeHtmlText(metric.short(v)) : ""}</span>
        <span class="ch-plot">${bar}${st.prefs.avg && avg ? `<span class="ch-avg" style="bottom:${(avg / max) * 100}%"></span>` : ""}</span>
        ${st.prefs.pain ? `<span class="ch-pain">${dot}</span>` : ""}
        <span class="ch-label">${showLabel ? escapeHtmlText(axisLabel(p, gran.id)) : ""}</span>
      </button>`;
  }).join("");

  // ---- détail de la période sélectionnée ----
  const idx = periods.findIndex((p) => p.key === st.selected);
  const sel = periods[idx];
  const selValue = periodValue(sel, metric.id);
  const base = previousActiveMean(periods, idx, metric.id);
  const ratio = base > 0 && selValue > 0 ? selValue / base : null;
  const ratioHTML = ratio != null && metric.id !== "avg_rpe"
    ? `<span class="ch-ratio${ratio >= 1.5 ? " high" : ""}">×${ratio.toFixed(1).replace(".", ",")}</span> la moyenne des 4 périodes actives précédentes (${escapeHtmlText(metric.fmt(Math.round(base * 10) / 10))})`
    : "";
  const typeRows = TYPE_ORDER.filter((t) => ((sel.by_type[t] || {})[metric.id] || 0) > 0 && metric.id !== "avg_rpe")
    .map((t) => `<li><span class="split-dot split-${t}"></span>${TYPE_LABELS[t]} — ${escapeHtmlText(metric.fmt((sel.by_type[t] || {})[metric.id]))}</li>`).join("");
  const selPains = pains.get(sel.key) || [];
  const painHTML = st.prefs.pain
    ? (selPains.length
      ? `<div class="ch-detail-pain"><strong>Douleurs signalées</strong><ul>${selPains.map((e) => `<li>${e.date.slice(8, 10)}/${e.date.slice(5, 7)} — ${escapeHtmlText(zoneLabel(e.zone, zones))}${e.level != null ? ` ${e.level}/10` : ""}</li>`).join("")}</ul></div>`
      : `<p class="small muted">Aucune douleur signalée sur cette période.</p>`)
    : "";
  const detail = `
    <div class="ch-detail">
      <div class="ch-detail-title">${escapeHtmlText(periodLabel(sel, gran.id))}</div>
      <div class="ch-detail-main"><strong>${escapeHtmlText(metric.fmt(selValue))}</strong><span class="small muted">${metric.label.toLowerCase()}</span></div>
      ${ratioHTML ? `<p class="small ch-detail-ratio">${ratioHTML}</p>` : ""}
      ${typeRows ? `<ul class="ch-detail-types small">${typeRows}</ul>` : ""}
      <p class="small muted ch-detail-all">${sel.sessions} séance${sel.sessions > 1 ? "s" : ""} · ${escapeHtmlText(fmtMinutes(sel.minutes))} · ${escapeHtmlText(fmtLoad(sel.load_ua))}${sel.avg_rpe ? ` · RPE ${rpeText(sel.avg_rpe)}` : ""}</p>
      ${painHTML}
    </div>`;

  const legend = stackable && present.length > 1
    ? `<div class="wk-legend small muted">${present.map((t) => `<span><span class="split-dot split-${t}"></span>${TYPE_LABELS[t]}</span>`).join("")}${st.prefs.pain ? `<span><span class="ch-pain-key"></span>Douleur</span>` : ""}${st.prefs.avg && avg ? `<span><span class="ch-avg-key"></span>Moyenne ${escapeHtmlText(metric.fmt(Math.round(avg * 10) / 10))}</span>` : ""}</div>`
    : (st.prefs.pain || (st.prefs.avg && avg) ? `<div class="wk-legend small muted">${st.prefs.pain ? `<span><span class="ch-pain-key"></span>Douleur</span>` : ""}${st.prefs.avg && avg ? `<span><span class="ch-avg-key"></span>Moyenne ${escapeHtmlText(metric.fmt(Math.round(avg * 10) / 10))}</span>` : ""}</div>` : "");

  const check = (id, label, on) => `<label class="ch-check"><input type="checkbox" data-ch-toggle="${id}"${on ? " checked" : ""}> ${label}</label>`;
  return `
    <div class="segmented ch-gran" role="tablist">${GRANULARITIES.map((g) => `<button type="button" class="segment${g.id === gran.id ? " active" : ""}" data-ch-gran="${g.id}">${g.label}</button>`).join("")}</div>
    <div class="segmented ch-metrics" role="tablist">${METRICS.map((m) => `<button type="button" class="segment${m.id === metric.id ? " active" : ""}" data-ch-metric="${m.id}">${m.label}</button>`).join("")}</div>
    <div class="ch-options">
      ${check("pain", "Douleurs", st.prefs.pain)}${check("stack", "Par type", st.prefs.stack)}${check("avg", "Moyenne", st.prefs.avg)}
    </div>
    <div class="ch-pager">
      <button type="button" class="live-link" data-ch-page="older"${canOlder ? "" : " disabled"} aria-label="Période précédente">‹ Avant</button>
      <span class="small muted">${escapeHtmlText(rangeLabel(view[0], view[view.length - 1], gran.id))}</span>
      <button type="button" class="live-link" data-ch-page="newer"${canNewer ? "" : " disabled"} aria-label="Période suivante">Après ›</button>
    </div>
    <div class="ch-bars${dense ? " dense" : ""}">${cols}</div>
    ${legend}
    ${detail}`;
}

export function activityChartCardHTML() {
  return `
    <section class="card activity-chart-card">
      <div class="card-head"><h2>Évolution</h2></div>
      <p class="small muted activity-note">Charge = RPE × minutes (u.a.), la même unité que la charge aiguë:chronique. Touche une barre pour le détail.</p>
      <div id="activity-chart"></div>
    </section>`;
}

export function wireActivityChart(root, stats, zones) {
  const host = root.querySelector("#activity-chart");
  if (!host || !stats || !stats.totals) return;
  const today = stats.generated_for;
  const st = { prefs: loadPrefs(), offset: 0, selected: null };
  const draw = () => {
    host.innerHTML = chartInner(stats, zones || {}, today, st);
    host.querySelectorAll("[data-ch-gran]").forEach((b) => b.addEventListener("click", () => { st.prefs.gran = b.dataset.chGran; st.offset = 0; st.selected = null; savePrefs(st.prefs); draw(); }));
    host.querySelectorAll("[data-ch-metric]").forEach((b) => b.addEventListener("click", () => { st.prefs.metric = b.dataset.chMetric; savePrefs(st.prefs); draw(); }));
    host.querySelectorAll("[data-ch-toggle]").forEach((c) => c.addEventListener("change", () => { st.prefs[c.dataset.chToggle] = c.checked; savePrefs(st.prefs); draw(); }));
    host.querySelectorAll("[data-ch-page]").forEach((b) => b.addEventListener("click", () => { st.offset = Math.max(0, st.offset + (b.dataset.chPage === "older" ? 1 : -1)); st.selected = null; draw(); }));
    host.querySelectorAll("[data-ch-key]").forEach((c) => c.addEventListener("click", () => { st.selected = c.dataset.chKey; draw(); }));
  };
  draw();
}
