// ---- Data — chart/tile rendering primitives, no fetching, no state.
// Generic building blocks reused across the Data tab's sections (sleep,
// bodyweight, trajectory rings) and the Calendrier tab (shortDateFr/
// dayInitial for match-list dates).
const RING_RADIUS = 38;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ringSVG(fraction) {
  const f = fraction == null ? 0 : Math.max(0, Math.min(1, fraction));
  const offset = RING_CIRCUMFERENCE * (1 - f);
  return `
    <svg width="92" height="92" viewBox="0 0 92 92">
      <circle class="ring-track" cx="46" cy="46" r="${RING_RADIUS}" stroke-width="9"></circle>
      <circle class="ring-fill" cx="46" cy="46" r="${RING_RADIUS}" stroke-width="9"
              stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${offset}"></circle>
    </svg>`;
}

/** `startValue` is where the ring's 0% actually is (the season baseline
 * it's progressing from — see bodyweight_progress.baseline_kg /
 * strength_trajectory[x].baseline_load) — without it a ring shows only
 * "how full", never "from where" or "how much of the objective, exactly"
 * ("je ne sais pas de quel point je pars"). `startDate` is when that
 * baseline was recorded (bodyweight_progress.baseline_date /
 * strength_trajectory[x].baseline_date — both anchored to the same
 * `_RETURN_TO_TRAINING_DATE` server-side) — shown alongside the value so
 * it's a specific, checkable point in time, not a bare number of
 * uncertain origin ("les points de départ ne sont pas cohérents"). */
export function statTile(label, current, unit, fraction, help, startValue, startDate) {
  const valueText = current != null ? `${current}${unit}` : "—";
  const pct = fraction != null ? Math.round(fraction * 100) : null;
  return `
    <div class="stat-tile">
      <div class="stat-label">${label}</div>
      <div class="ring-wrap">
        ${ringSVG(fraction)}
        <div class="ring-value">${valueText}</div>
      </div>
      ${pct != null ? `<div class="stat-pct">${pct}% de l'objectif</div>` : ""}
      ${startValue != null ? `<div class="stat-start muted small">Départ ${startValue}${unit}${startDate ? ` (${shortDateFr(startDate)})` : ""}</div>` : ""}
      ${help ? `<div class="stat-help">${help}</div>` : ""}
    </div>`;
}

/** Ring tile for a recurring weekly sleep target (average or cumulative),
 * visually consistent with `statTile`'s trajectory rings — but no
 * `startValue`/`startDate`: a weekly goal resets every week, there's no
 * season baseline to progress from, only "how close to this week's
 * target" ("des indicateurs plus ergonomiques pour le sommeil moyen et
 * cumulé de la semaine" — replaces a plain text line with the same at-a-
 * glance ring language used everywhere else in Data). `valueText` is
 * preformatted (e.g. "7h15" via formatHoursFr) since these are hours, not
 * a bare number+unit like statTile's kg tiles. */
export function sleepGoalTile(label, valueText, fraction, help) {
  const pct = fraction != null ? Math.round(fraction * 100) : null;
  return `
    <div class="stat-tile">
      <div class="stat-label">${label}</div>
      <div class="ring-wrap">
        ${ringSVG(fraction)}
        <div class="ring-value">${valueText}</div>
      </div>
      ${pct != null ? `<div class="stat-pct">${pct}% de l'objectif</div>` : ""}
      ${help ? `<div class="stat-help">${help}</div>` : ""}
    </div>`;
}

/** "dd/mm" from an ISO date — the short form used on chart axes. */
export function shortDateFr(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Minimal inline-SVG line sparkline — no charting dependency. `points`:
 * [{date, value}] ascending. Uses the app's own CSS custom properties so
 * it matches the rest of the palette automatically, light or dark.
 * `opts.axis` adds min/max gridlines with their value, plus the first and
 * last point's date underneath — a bare line with no scale or dates
 * wasn't actually readable ("aucun axe, c'est peu exploitable"). */
export function sparklineSVG(points, opts = {}) {
  const w = 280, h = 60, padRight = 6;
  const padTop = opts.axis ? 12 : 6;
  const padBottom = opts.axis ? 16 : 6;
  const padLeft = opts.axis ? 30 : 6;
  if (points.length < 2) return "";
  const values = points.map((p) => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;
  const stepX = plotW / (points.length - 1);
  const yFor = (v) => padTop + plotH * (1 - (v - min) / range);
  const coords = points.map((p, i) => [padLeft + i * stepX, yFor(p.value)]);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];
  const axis = opts.axis
    ? `
      <line x1="${padLeft}" y1="${padTop.toFixed(1)}" x2="${w - padRight}" y2="${padTop.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="${padLeft - 4}" y="${(padTop + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${max.toFixed(1)}</text>
      <line x1="${padLeft}" y1="${(padTop + plotH).toFixed(1)}" x2="${w - padRight}" y2="${(padTop + plotH).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="${padLeft - 4}" y="${(padTop + plotH + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${min.toFixed(1)}</text>
      <text x="${padLeft}" y="${h - 3}" text-anchor="start" font-size="9" fill="var(--muted)">${shortDateFr(points[0].date)}</text>
      <text x="${w - padRight}" y="${h - 3}" text-anchor="end" font-size="9" fill="var(--muted)">${shortDateFr(points[points.length - 1].date)}</text>`
    : "";
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="sparkline" preserveAspectRatio="none">
      ${axis}
      <path d="${path}" fill="none" stroke="var(--green-light)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--gold)"/>
    </svg>`;
}

/** French single-letter day-of-week initial (L/M/M/J/V/S/D) for an ISO
 * date — parsed as UTC like dayOfYear, so it's never off-by-one against
 * the local timezone. */
export function dayInitial(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return ["D", "L", "M", "M", "J", "V", "S"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Bar chart — used for sleep (a night-by-night series reads better as
 * bars than as a connected line, which implies a continuous quantity).
 * `opts.reference` draws a dashed target line and colors bars below it
 * gold rather than green (e.g. the sleep guideline). `opts.dayLabels`
 * prints each bar's day-of-week initial underneath (`points[i].date`
 * required) — bare numbers with no axis were hard to place in the week
 * otherwise. */
export function barChartSVG(points, opts = {}) {
  const w = 280, h = 70, pad = 6, gap = 3, labelH = 16;
  if (!points.length) return "";
  const totalH = h + (opts.dayLabels ? labelH : 0);
  const values = points.map((p) => p.value);
  const max = (opts.reference != null ? Math.max(...values, opts.reference) : Math.max(...values)) * 1.15;
  const slotW = (w - pad * 2) / points.length;
  const barW = Math.max(slotW - gap, 2);
  const yFor = (v) => pad + (h - pad * 2) * (1 - Math.min(v, max) / max);
  const bars = points
    .map((p, i) => {
      const x = pad + i * slotW;
      const y = yFor(p.value);
      const barH = Math.max(h - pad - y, 1);
      const below = opts.reference != null && p.value < opts.reference;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${below ? "var(--gold)" : "var(--green-light)"}"/>`;
    })
    .join("");
  const refLine = opts.reference != null
    ? `<line x1="${pad}" y1="${yFor(opts.reference).toFixed(1)}" x2="${w - pad}" y2="${yFor(opts.reference).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3,3"/>`
    : "";
  const labels = opts.dayLabels
    ? points
        .map((p, i) => {
          const cx = pad + i * slotW + barW / 2;
          return `<text x="${cx.toFixed(1)}" y="${h + labelH - 4}" text-anchor="middle" font-size="9" fill="var(--muted)">${dayInitial(p.date)}</text>`;
        })
        .join("")
    : "";
  return `
    <svg width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}" class="sparkline" preserveAspectRatio="none">
      ${refLine}
      ${bars}
      ${labels}
    </svg>`;
}

/** "7h30" rather than "7.5h" — how sleep durations are normally written
 * in French. Only handles the half-hour case since that's all this app
 * ever needs (the fixed target, and hour values are shown as decimals
 * elsewhere). */
export function formatHoursFr(hours) {
  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  return minutes ? `${wholeHours}h${String(minutes).padStart(2, "0")}` : `${wholeHours}h`;
}

// ---- Charge aiguë:chronique (ACWR) — gauge + trend chart ----
// Zone boundaries mirror coach.workload.classify_ratio (Gabbett 2016) —
// kept in sync manually since this is presentation-only, no shared source
// of truth is worth the plumbing for 3 numbers that essentially never
// change.
const WORKLOAD_GAUGE_MAX = 2.0;
const WORKLOAD_GAUGE_SEGMENTS = [
  { zone: "sous_charge", upTo: 0.8 },
  { zone: "zone_optimale", upTo: 1.3 },
  { zone: "zone_prudente", upTo: 1.5 },
  { zone: "risque_eleve", upTo: WORKLOAD_GAUGE_MAX },
];

/** Where the current ratio sits across the 4 Gabbett zones, not just which
 * one it's in — a bare zone name doesn't say whether it's just inside a
 * boundary or deep into it. Segments are proportional to `WORKLOAD_GAUGE_MAX`
 * (ratios above it are clamped to the marker's rightmost position rather
 * than distorting the scale for a rare extreme reading). */
export function workloadGaugeHTML(ratio) {
  const markerPct = Math.max(0, Math.min(100, (ratio / WORKLOAD_GAUGE_MAX) * 100));
  let prevBound = 0;
  const segments = WORKLOAD_GAUGE_SEGMENTS.map(({ zone, upTo }) => {
    const widthPct = ((upTo - prevBound) / WORKLOAD_GAUGE_MAX) * 100;
    prevBound = upTo;
    return { zone, widthPct, upTo };
  });
  const bars = segments
    .map((s) => `<div class="workload-gauge-segment zone-${s.zone}" style="width:${s.widthPct}%"></div>`)
    .join("");
  const scale = segments
    .map((s) => `<span class="workload-gauge-scale-label" style="width:${s.widthPct}%">${s.upTo >= WORKLOAD_GAUGE_MAX ? "" : s.upTo}</span>`)
    .join("");
  return `
    <div class="workload-gauge-wrap">
      <div class="workload-gauge-track">
        <div class="workload-gauge-bars">${bars}</div>
        <div class="workload-gauge-marker" style="left:${markerPct.toFixed(1)}%"></div>
      </div>
      <div class="workload-gauge-scale">${scale}</div>
    </div>`;
}

const WORKLOAD_ZONE_STROKE = {
  sous_charge: "var(--muted)",
  zone_optimale: "var(--green-light)",
  zone_prudente: "var(--gold)",
  risque_eleve: "var(--danger)",
};

/** Ratio trend over `readings` ([{date, ratio, zone}], ascending, from
 * `coach.workload.history`) — a fixed 0–2 y-scale (not data-driven like
 * `sparklineSVG`) so the 3 zone-boundary lines stay at consistent heights
 * and are actually comparable to the gauge above, and the trailing point is
 * colored by its own zone so a currently-risky reading reads as risky at a
 * glance even before checking the badge. */
export function workloadTrendSVG(readings) {
  const w = 280, h = 90, padLeft = 30, padRight = 8, padTop = 10, padBottom = 18;
  if (readings.length < 2) return "";
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;
  const maxVal = Math.max(WORKLOAD_GAUGE_MAX, ...readings.map((r) => r.ratio)) * 1.05;
  const yFor = (v) => padTop + plotH * (1 - Math.min(v, maxVal) / maxVal);
  const stepX = plotW / (readings.length - 1);
  const coords = readings.map((r, i) => [padLeft + i * stepX, yFor(r.ratio)]);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const thresholdLines = [0.8, 1.3, 1.5]
    .map((v) => `
      <line x1="${padLeft}" y1="${yFor(v).toFixed(1)}" x2="${w - padRight}" y2="${yFor(v).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="${padLeft - 3}" y="${(yFor(v) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="var(--muted)">${v}</text>`)
    .join("");
  const [lastX, lastY] = coords[coords.length - 1];
  const lastColor = WORKLOAD_ZONE_STROKE[readings[readings.length - 1].zone] || "var(--green-light)";
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="sparkline" preserveAspectRatio="none">
      ${thresholdLines}
      <path d="${path}" fill="none" stroke="var(--green-light)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX}" cy="${lastY}" r="4" fill="${lastColor}"/>
      <text x="${padLeft}" y="${h - 3}" text-anchor="start" font-size="9" fill="var(--muted)">${shortDateFr(readings[0].date)}</text>
      <text x="${w - padRight}" y="${h - 3}" text-anchor="end" font-size="9" fill="var(--muted)">${shortDateFr(readings[readings.length - 1].date)}</text>
    </svg>`;
}

/** Green ≤3 (gênant mais gérable), gold 4-6 (modéré), danger ≥7 (élevé) —
 * mêmes seuils utilisés pour le badge de niveau dans la liste d'historique
 * (pain.js) et pour le point le plus récent du tracé ici, donc jamais
 * deux couleurs différentes pour le même niveau selon où on le regarde. */
export function painLevelColor(level) {
  if (level >= 7) return "var(--danger)";
  if (level >= 4) return "var(--gold)";
  return "var(--green-light)";
}

/** Douleur d'une zone dans le temps ([{date, level}], ascending, depuis
 * `pain_recent.entries` filtré à une zone) — même construction que
 * `workloadTrendSVG` (échelle fixe, ici 0-10, points espacés régulièrement
 * par index plutôt que par date réelle : le rythme de logging n'est pas
 * régulier — un jour sur deux, une pause de plusieurs semaines — un
 * espacement proportionnel au temps écraserait les périodes actives
 * contre les longs silences). Plusieurs entrées le même jour restent des
 * points distincts, volontairement (matin vs après séance peut être le
 * point intéressant). */
export function painTrendSVG(entries) {
  const w = 280, h = 90, padLeft = 20, padRight = 8, padTop = 10, padBottom = 18;
  if (entries.length < 2) return "";
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;
  const maxVal = 10;
  const yFor = (v) => padTop + plotH * (1 - Math.min(v, maxVal) / maxVal);
  const stepX = plotW / (entries.length - 1);
  const coords = entries.map((e, i) => [padLeft + i * stepX, yFor(e.level)]);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const thresholdLines = [3, 6]
    .map((v) => `
      <line x1="${padLeft}" y1="${yFor(v).toFixed(1)}" x2="${w - padRight}" y2="${yFor(v).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="${padLeft - 2}" y="${(yFor(v) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="var(--muted)">${v}</text>`)
    .join("");
  const [lastX, lastY] = coords[coords.length - 1];
  const lastColor = painLevelColor(entries[entries.length - 1].level);
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="sparkline" preserveAspectRatio="none">
      ${thresholdLines}
      <path d="${path}" fill="none" stroke="var(--muted)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX}" cy="${lastY}" r="4" fill="${lastColor}"/>
      <text x="${padLeft}" y="${h - 3}" text-anchor="start" font-size="9" fill="var(--muted)">${shortDateFr(entries[0].date)}</text>
      <text x="${w - padRight}" y="${h - 3}" text-anchor="end" font-size="9" fill="var(--muted)">${shortDateFr(entries[entries.length - 1].date)}</text>
    </svg>`;
}

/** A compact labeled value, for secondary Data-tab metrics that don't
 * warrant a full progress ring (recovery, body composition) — optionally
 * with a small delta vs the previous reading. `goodDirection`: "up"
 * (default — more is better, e.g. muscle mass) or "down" (less is
 * better, e.g. fat mass) — determines which sign of `delta` is shown
 * green vs red, since "positive number" doesn't mean the same thing for
 * every metric on this tab. */
export function statTileSimple(label, valueText, delta, deltaUnit, goodDirection = "up") {
  const isGood = delta != null && (goodDirection === "down" ? delta <= 0 : delta >= 0);
  const deltaHtml = delta != null
    ? ` <span class="${isGood ? "trend-up" : "trend-down"} small">${delta >= 0 ? "+" : ""}${delta.toFixed(1)}${deltaUnit || ""}</span>`
    : "";
  return `
    <div class="stat-tile-simple">
      <div class="stat-label">${label}</div>
      <div class="trend-line small">${valueText}${deltaHtml}</div>
    </div>`;
}
