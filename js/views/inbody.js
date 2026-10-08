// Progrès › InBody (ADR-0102) : l'analyse complète d'un scan et son
// évolution. Les chiffres, écarts et lectures viennent de
// `summary.json › inbody` (coach.body_analysis) : ici, de l'affichage.
import { ringSVG, sparklineSVG, shortDateFr } from "./data-viz.js";
import { escapeHtmlText } from "../markdown.js";

const METRIC_KEY = "coach_inbody_metric";
const state = { idx: null, metric: null, segMode: "lean" };

function saved(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* confort */ } }

const fr = (n, d = 1) => (n == null ? "—" : Number(n).toFixed(d).replace(".", ",").replace("-", "−"));
const sgn = (n, d = 1) => (n == null ? "" : (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toFixed(d).replace(".", ","));
const dateLong = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

// key, libellé, unité, sens favorable, décimales
const METRICS = [
  ["lean_mass_kg", "Masse non grasse", "kg", "up", 1],
  ["muscle_kg", "Muscle (MMS)", "kg", "up", 1],
  ["fat_mass_kg", "Masse grasse", "kg", "down", 1],
  ["body_fat_percent", "% de graisse", "%", "down", 1],
  ["score", "Score InBody", "/100", "up", 0],
  ["visceral_level", "Graisse viscérale", "niv.", "down", 0],
  ["bmr_kcal", "Métabolisme de base", "kcal", "neutral", 0],
  ["water_l", "Eau corporelle", "L", "neutral", 1],
];

function tone(delta, good) {
  if (delta == null || Math.abs(delta) < 1e-9 || good === "neutral") return "";
  return (good === "up") === (delta > 0) ? "ib-good" : "ib-bad";
}

const SEG_LABELS = { arm_left: "Bras G", trunk: "Tronc", arm_right: "Bras D", leg_left: "Jambe G", leg_right: "Jambe D" };

function chipsHTML(scans, idx) {
  if (scans.length < 2) return "";
  return `<div class="segmented ib-chips" role="tablist" aria-label="Choisir un scan">${scans.map((sc, i) =>
    `<button type="button" role="tab" class="segment${i === idx ? " active" : ""}" aria-selected="${i === idx}" data-ib-scan="${i}">${shortDateFr(sc.date)}</button>`).join("")}</div>`;
}

function heroHTML(scan) {
  const verdict = scan.insights.find((i) => ["recomposition", "clean_gain", "fat_gain", "lean_loss", "fat_loss", "stable"].includes(i.kind));
  const d = scan.delta;
  const sf = scan.since_first;
  const score = scan.score;
  return `
    <div class="ib-hero">
      <div class="ib-hero-main">
        <div class="ib-big">${fr(scan.lean_mass_kg)}<small> kg</small></div>
        <div class="muted small">masse non grasse · scan du ${dateLong(scan.date)}</div>
        ${d && d.lean_mass_kg != null ? `<div class="ib-hero-delta ${tone(d.lean_mass_kg, "up")}">${sgn(d.lean_mass_kg)} kg <span class="muted">vs ${shortDateFr(scan.previous_date)} (${scan.days_since_previous} j)</span></div>` : `<div class="muted small">Premier scan : point de départ.</div>`}
      </div>
      ${score != null ? `<div class="ib-score"><div class="ring-wrap">${ringSVG(score / 100)}<div class="ring-value"><span class="ring-num">${fr(score, 0)}</span></div></div><div class="muted small">score</div></div>` : ""}
    </div>
    ${verdict ? `<div class="ib-verdict ib-lvl-${verdict.level}"><b>${escapeHtmlText(verdict.title)}</b><span>${escapeHtmlText(verdict.text)}</span></div>` : ""}
    ${sf ? `<p class="small muted ib-since">Depuis le premier scan (il y a ${sf.days} j) : <b class="${tone(sf.lean_mass_kg, "up")}">${sgn(sf.lean_mass_kg)} kg</b> de masse non grasse, <b class="${tone(sf.fat_mass_kg, "down")}">${sgn(sf.fat_mass_kg)} kg</b> de gras${sf.muscle_kg != null ? `, <b class="${tone(sf.muscle_kg, "up")}">${sgn(sf.muscle_kg)} kg</b> de muscle (MMS)` : ""}.</p>` : ""}`;
}

function tilesHTML(scan, metric) {
  return `<div class="ib-tiles">${METRICS.filter(([k]) => scan[k] != null).map(([k, label, unit, good, dec]) => {
    const dv = scan.delta ? scan.delta[k] : null;
    return `<button type="button" class="ib-tile${k === metric ? " selected" : ""}" data-ib-metric="${k}" aria-pressed="${k === metric}">
      <span class="ib-tile-label">${label}</span>
      <span class="ib-tile-value">${fr(scan[k], dec)}<small> ${unit}</small></span>
      <span class="ib-tile-delta ${tone(dv, good)}">${dv != null ? sgn(dv, dec) : "&nbsp;"}</span>
    </button>`;
  }).join("")}</div><p class="muted small ib-hint">Touche une tuile pour voir son évolution plus bas.</p>`;
}

const COMPONENTS = [
  ["water_l", "Eau", "ib-c-water", "L"],
  ["protein_kg", "Protéines", "ib-c-protein", "kg"],
  ["mineral_kg", "Minéraux", "ib-c-mineral", "kg"],
  ["fat_mass_kg", "Graisse", "ib-c-fat", "kg"],
];

function changeHTML(scan) {
  const comp = scan.delta && scan.delta.composition;
  if (!comp) return "";
  const max = Math.max(...COMPONENTS.map(([k]) => Math.abs(comp[k])), 0.01);
  const rows = COMPONENTS.map(([k, label, cls, unit]) => {
    const v = comp[k];
    const w = Math.round((Math.abs(v) / max) * 100);
    return `<div class="ib-div-row"><span class="ib-div-label">${label}</span>
      <span class="ib-div-track"><span class="ib-div-bar ${cls} ${v < 0 ? "neg" : "pos"}" style="width:${w / 2}%"></span></span>
      <span class="ib-div-val">${sgn(v, 2)} ${unit}</span></div>`;
  }).join("");
  return `
    <section class="card">
      <div class="card-head"><h2>Ce qui a changé</h2><span class="muted small">vs ${shortDateFr(scan.previous_date)}</span></div>
      <div class="ib-div">${rows}</div>
      <p class="small ib-div-sum">Somme : <b>${sgn(scan.delta.weight_kg)} kg</b> sur la balance. Les protéines reflètent le tissu musculaire ; l'eau, l'hydratation du jour.</p>
    </section>`;
}

function insightsHTML(scan) {
  const rest = scan.insights.filter((i) => !["recomposition", "clean_gain", "fat_gain", "lean_loss", "fat_loss", "stable"].includes(i.kind));
  if (!rest.length) return "";
  return `
    <section class="card">
      <h2>Lecture</h2>
      <ul class="ib-insights">${rest.map((i) => `<li class="ib-lvl-${i.level}"><span class="ib-dot"></span><div><b>${escapeHtmlText(i.title)}</b><span>${escapeHtmlText(i.text)}</span></div></li>`).join("")}</ul>
    </section>`;
}

function segmentsHTML(scan, prev) {
  const seg = scan.segments;
  if (!seg || !seg.lean_kg) return "";
  const lean = state.segMode === "lean";
  const kg = lean ? seg.lean_kg : seg.fat_kg;
  const pct = lean ? seg.lean_percent : seg.fat_percent;
  if (!kg) return "";
  const prevKg = prev && prev.segments && (lean ? prev.segments.lean_kg : prev.segments.fat_kg);
  const cell = (name) => {
    const p = pct ? pct[name] : null;
    const width = p != null ? Math.min(100, (p / 160) * 100) : 0;
    const warn = !lean && p != null && p > 115;
    const dv = prevKg && prevKg[name] != null ? kg[name] - prevKg[name] : null;
    return `<div class="ib-seg ib-seg-${name}">
      <span class="ib-seg-name">${SEG_LABELS[name]}</span>
      <span class="ib-seg-kg">${fr(kg[name], kg[name] < 1 ? 1 : 2)}<small> kg</small></span>
      ${p != null ? `<span class="ib-seg-bar"><span class="ib-seg-fill${warn ? " warn" : ""}" style="width:${width}%"></span><i style="left:${(100 / 160) * 100}%"></i></span><span class="ib-seg-pct">${fr(p, 0)} % de la norme</span>` : ""}
      ${dv != null ? `<span class="ib-tile-delta ${tone(dv, lean ? "up" : "down")}">${sgn(dv, 2)}</span>` : ""}
    </div>`;
  };
  const sym = scan.symmetry || {};
  const symLine = (key, label) => {
    const s = sym[key];
    if (!s) return "";
    const side = s.stronger_side === "left" ? "G" : s.stronger_side === "right" ? "D" : "";
    return `<span class="ib-sym ib-lvl-${s.level}"><span class="ib-dot"></span>${label} ${fr(Math.abs(s.gap_percent))} %${side ? ` (${side} +)` : ""}</span>`;
  };
  return `
    <section class="card">
      <div class="card-head"><h2>Équilibre du corps</h2>
        <div class="segmented ib-mini" role="tablist"><button type="button" role="tab" class="segment${lean ? " active" : ""}" data-ib-seg="lean">Maigre</button><button type="button" role="tab" class="segment${lean ? "" : " active"}" data-ib-seg="fat">Gras</button></div></div>
      <div class="ib-body">
        ${cell("arm_left")}${cell("trunk")}${cell("arm_right")}
        ${cell("leg_left")}<div class="ib-sym-box">${lean ? `${symLine("arms", "Bras")}${symLine("legs", "Jambes")}` : `<span class="muted small">Repère : la barre dorée = 100 % de la norme.</span>`}</div>${cell("leg_right")}
      </div>
      <p class="muted small">${lean ? "Masse maigre par segment et % de la norme de l'appareil (trait = 100 %)." : "Masse grasse par segment ; le tronc concentre naturellement la plus grande part."}</p>
    </section>`;
}

function trendHTML(scans, scan, metric) {
  const def = METRICS.find(([k]) => k === metric) || METRICS[0];
  const [key, label, unit, good, dec] = def;
  const points = scans.filter((sc) => sc[key] != null).map((sc) => ({ date: sc.date, value: sc[key] }));
  const rows = [...points].reverse().map((p, i, arr) => {
    const older = arr[i + 1];
    const dv = older ? p.value - older.value : null;
    return `<tr><td>${dateLong(p.date)}</td><td><b>${fr(p.value, dec)} ${unit}</b></td><td class="${tone(dv, good)}">${dv != null ? sgn(dv, dec) : "—"}</td></tr>`;
  }).join("");
  return `
    <section class="card" id="ib-trend">
      <div class="card-head"><h2>Évolution</h2><span class="muted small">${label}</span></div>
      ${points.length > 1 ? sparklineSVG(points, { axis: true }) : `<p class="muted small">Le graphe apparaît dès le 2ᵉ scan.</p>`}
      <table class="quarter-table"><tbody>${rows}</tbody></table>
    </section>`;
}

function gaugesHTML(scan) {
  const r = scan.ranges || {};
  const items = [
    ["Eau", scan.water_l, r.water_l, "L", 1],
    ["Protéines", scan.protein_kg, r.protein_kg, "kg", 1],
    ["Minéraux", scan.mineral_kg, r.mineral_kg, "kg", 2],
    ["Masse grasse", scan.fat_mass_kg, r.fat_mass_kg, "kg", 1],
    ["Métabolisme de base", scan.bmr_kcal, r.bmr_kcal, "kcal", 0],
  ].filter(([, v, range]) => v != null && range);
  if (!items.length) return "";
  const rows = items.map(([label, v, [lo, hi], unit, dec]) => {
    const min = lo * 0.7, max = hi * 1.3;
    const pos = (x) => Math.max(0, Math.min(100, ((x - min) / (max - min)) * 100));
    const status = v < lo ? "sous" : v > hi ? "au-dessus" : "dans la plage";
    return `<div class="ib-gauge">
      <div class="ib-gauge-head"><span>${label}</span><b>${fr(v, dec)} ${unit}</b></div>
      <div class="ib-gauge-track"><span class="ib-gauge-band" style="left:${pos(lo)}%;width:${pos(hi) - pos(lo)}%"></span><span class="ib-gauge-mark ${status === "dans la plage" ? "in" : "out"}" style="left:${pos(v)}%"></span></div>
      <div class="ib-gauge-foot muted small"><span>${fr(lo, dec)}</span><span>${status}</span><span>${fr(hi, dec)}</span></div>
    </div>`;
  }).join("");
  return `
    <details class="card ib-details">
      <summary><h2>Repères de l'appareil</h2></summary>
      ${rows}
      <p class="muted small">Plages calées sur un profil moyen pour ta taille : être au-dessus pour l'eau, les protéines ou les minéraux ne signale pas un problème (c'est souvent le signe d'une corpulence musclée). Ce ne sont pas des objectifs.</p>
    </details>`;
}

function footerHTML(inbody) {
  const next = inbody.next_scan_suggested;
  return `
    <section class="card">
      <h2>Prochain scan</h2>
      <p>${next ? `Vers le <b>${dateLong(next)}</b> (environ tous les 3 mois).` : "Un scan tous les ~3 mois suffit."}</p>
      <details class="card-help"><summary>Pour comparer à conditions égales</summary><p>Même heure de la journée, à jeun ou ~3 h après un repas, sans grosse séance ni alcool la veille, hydratation habituelle (ni plus, ni moins). L'eau fait varier la masse non grasse de plusieurs centaines de grammes : c'est la tendance sur plusieurs scans qui compte.</p></details>
    </section>`;
}

export function inbodyTabHTML(s) {
  const inbody = s.inbody;
  const scans = (inbody && inbody.scans) || [];
  if (!scans.length) {
    return `<section class="card"><h2>InBody</h2><p class="muted small">Pas encore de scan enregistré. Envoie la photo du ticket à Claude : il saisit les valeurs et cette page se remplit.</p></section>`;
  }
  if (state.idx == null || state.idx >= scans.length) state.idx = scans.length - 1;
  if (!state.metric) state.metric = saved(METRIC_KEY, "lean_mass_kg");
  const scan = scans[state.idx];
  const prev = state.idx > 0 ? scans[state.idx - 1] : null;
  return `
    <div id="inbody-root">
      <section class="card">
        ${chipsHTML(scans, state.idx)}
        ${heroHTML(scan)}
        ${tilesHTML(scan, state.metric)}
      </section>
      ${changeHTML(scan)}
      ${insightsHTML(scan)}
      ${segmentsHTML(scan, prev)}
      ${trendHTML(scans, scan, state.metric)}
      ${gaugesHTML(scan)}
      ${footerHTML(inbody)}
    </div>`;
}

export function wireInbody(el, s) {
  const root = el.querySelector("#inbody-root");
  if (!root) return;
  const redraw = (scrollToTrend) => {
    root.outerHTML = inbodyTabHTML(s).trim();
    wireInbody(el, s);
    if (scrollToTrend) {
      const t = el.querySelector("#ib-trend");
      if (t) t.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
  root.querySelectorAll("[data-ib-scan]").forEach((b) => b.addEventListener("click", () => { state.idx = Number(b.dataset.ibScan); redraw(false); }));
  root.querySelectorAll("[data-ib-metric]").forEach((b) => b.addEventListener("click", () => { state.metric = b.dataset.ibMetric; save(METRIC_KEY, state.metric); redraw(true); }));
  root.querySelectorAll("[data-ib-seg]").forEach((b) => b.addEventListener("click", () => { state.segMode = b.dataset.ibSeg; redraw(false); }));
}
