import { formatHoursFr, dayInitial } from "./views/data-viz.js";

// ============================================================================
// Carte « Sommeil » interactive (docs/adr/0108) : barres empilées par phase,
// une nuit sélectionnable (tap, ‹ ›, flèches clavier), détail de la nuit
// (coucher/lever, phases, réveils, efficacité, écart à la moyenne, FC repos/
// HRV/FR du jour) et hypnogramme explorable au doigt. Aucune donnée n'est
// calculée ici : tout vient de `sleep_recent.history[].night` (coach.progression
// .sleep_night_detail). Une nuit sans `night` (ancien résumé) reste affichée
// en barre unie, sans détail de phases.
// ============================================================================

const TARGET_H = 7.5;
const RANGES = [7, 14];
// code de segment (SLEEP_SEGMENT_CODES côté Python) → phase
const BY_CODE = { 0: "awake", 1: "rem", 2: "light", 3: "deep" };
const STAGES = {
  deep: { label: "Profond", ref: [13, 23] },
  rem: { label: "Paradoxal", ref: [20, 25] },
  light: { label: "Léger", ref: [45, 55] },
  awake: { label: "Éveillé" },
};
// Repères indicatifs usuels chez l'adulte jeune (% du temps endormi) : à lire
// comme des ordres de grandeur, pas comme des normes individuelles.
const STACK = ["deep", "rem", "light"]; // du bas vers le haut
const HYP_ROWS = ["awake", "rem", "light", "deep"]; // du haut vers le bas, comme Apple Santé

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

const dm = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const hhmm = (iso) => `${iso.slice(11, 13)}h${iso.slice(14, 16)}`;
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, "0")}` : `${Math.round(min)} min`);
const dayName = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const clock = (startIso, offsetMin) => {
  const base = Number(startIso.slice(11, 13)) * 60 + Number(startIso.slice(14, 16));
  const t = (base + Math.round(offsetMin)) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}h${String(t % 60).padStart(2, "0")}`;
};
const asleepMin = (n) => n.light + n.deep + n.rem;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function nightRangeLabel(entry) {
  const n = entry.night;
  if (!n) return `Nuit du ${dm(entry.date)}`;
  const a = n.start.slice(0, 10), b = n.end.slice(0, 10);
  return a === b ? `Nuit du ${dm(a)}` : `Nuit du ${Number(a.slice(8, 10))} au ${dm(b)}`;
}

// ---------- graphique principal ----------
const W = 320, PLOT_H = 112, PAD_L = 24, PAD_R = 6, PAD_T = 8, LABEL_H = 26;

function chartSVG(nights, sel) {
  const n = nights.length;
  const max = Math.max(9, ...nights.map((e) => e.hours)) * 1.08;
  const slot = (W - PAD_L - PAD_R) / n;
  const barW = Math.max(slot - (n > 7 ? 4 : 8), 6);
  const y = (h) => PAD_T + PLOT_H * (1 - Math.min(h, max) / max);
  const base = PAD_T + PLOT_H;
  let body = "";
  [4, 8].forEach((h) => {
    body += `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(h).toFixed(1)}" y2="${y(h).toFixed(1)}" class="sl-grid"/><text x="${PAD_L - 4}" y="${(y(h) + 3).toFixed(1)}" text-anchor="end" class="sl-axis">${h}h</text>`;
  });
  nights.forEach((e, i) => {
    const x0 = PAD_L + i * slot;
    const bx = x0 + (slot - barW) / 2;
    const isSel = i === sel;
    const lowCls = e.hours < TARGET_H ? " is-low" : "";
    if (isSel) body += `<rect x="${x0.toFixed(1)}" y="${PAD_T - 4}" width="${slot.toFixed(1)}" height="${PLOT_H + LABEL_H + 4}" rx="6" class="sl-sel"/>`;
    const night = e.night;
    if (night) {
      let top = base;
      const k = (PLOT_H / max) / 60; // px par minute
      STACK.forEach((st) => {
        const h = night[st] * k;
        if (h <= 0) return;
        top -= h;
        body += `<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" class="sl-bar sl-${st}"/>`;
      });
    } else {
      body += `<rect x="${bx.toFixed(1)}" y="${y(e.hours).toFixed(1)}" width="${barW.toFixed(1)}" height="${(base - y(e.hours)).toFixed(1)}" rx="2" class="sl-bar sl-plain"/>`;
    }
    const cx = x0 + slot / 2;
    body += `<text x="${cx.toFixed(1)}" y="${base + 12}" text-anchor="middle" class="sl-day${lowCls}${isSel ? " is-sel" : ""}">${dayInitial(e.date)}</text>`;
    if (n <= 7 || isSel) body += `<text x="${cx.toFixed(1)}" y="${base + 23}" text-anchor="middle" class="sl-num${isSel ? " is-sel" : ""}">${Number(e.date.slice(8, 10))}</text>`;
    body += `<rect x="${x0.toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${base + LABEL_H}" class="sl-hit" data-i="${i}" tabindex="0" role="button" aria-pressed="${isSel}" aria-label="${escapeAttrText(ariaFor(e))}"/>`;
  });
  body += `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(TARGET_H).toFixed(1)}" y2="${y(TARGET_H).toFixed(1)}" class="sl-target"/>`;
  body += `<text x="${W - PAD_R}" y="${(y(TARGET_H) - 3).toFixed(1)}" text-anchor="end" class="sl-axis sl-target-lbl">${formatHoursFr(TARGET_H)}</text>`;
  return `<svg class="sl-chart" viewBox="0 0 ${W} ${base + LABEL_H}" role="group" aria-label="Durée de sommeil par nuit, empilée par phase">${body}</svg>`;
}

const escapeAttrText = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function ariaFor(e) {
  const n = e.night;
  const base = `${dayName(e.date)} ${dm(e.date)} : ${formatHoursFr(e.hours)}`;
  return n ? `${base}, profond ${dur(n.deep)}, paradoxal ${dur(n.rem)}, léger ${dur(n.light)}` : base;
}

// ---------- détail d'une nuit ----------
function stageRowsHTML(n) {
  const total = asleepMin(n) || 1;
  return STACK.map((st) => {
    const pct = (n[st] / total) * 100;
    const [lo, hi] = STAGES[st].ref;
    const out = pct < lo ? "is-below" : pct > hi ? "is-above" : "is-in";
    return `<div class="sl-row">
      <span class="sl-row-lbl"><i class="sl-dot sl-${st}"></i>${STAGES[st].label}</span>
      <span class="sl-track" aria-hidden="true"><span class="sl-ref" style="left:${lo}%;width:${hi - lo}%"></span><span class="sl-fill sl-${st}" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="sl-row-val ${out}"><strong>${dur(n[st])}</strong> <small>${Math.round(pct)} %</small></span>
    </div>`;
  }).join("");
}

function hypnogramHTML(n) {
  const w = 320, padL = 4, padR = 4, rowH = 17, gap = 3, top = 4, axisH = 14;
  const plotW = w - padL - padR;
  const h = top + HYP_ROWS.length * (rowH + gap) + axisH;
  const span = Math.max(n.span_min, 1);
  const x = (m) => padL + (m / span) * plotW;
  const rowY = (st) => top + HYP_ROWS.indexOf(st) * (rowH + gap);
  let body = HYP_ROWS.map((st, i) => `<rect x="${padL}" y="${top + i * (rowH + gap)}" width="${plotW}" height="${rowH}" rx="4" class="sl-hyp-lane"/>`).join("");
  let prev = null;
  n.segments.forEach(([off, d, code]) => {
    const st = BY_CODE[code];
    if (prev != null) {
      const ya = rowY(prev.st) + rowH / 2, yb = rowY(st) + rowH / 2;
      body += `<line x1="${x(off).toFixed(1)}" x2="${x(off).toFixed(1)}" y1="${ya}" y2="${yb}" class="sl-hyp-link"/>`;
    }
    body += `<rect x="${x(off).toFixed(1)}" y="${rowY(st)}" width="${Math.max((d / span) * plotW, 1.2).toFixed(1)}" height="${rowH}" rx="2.5" class="sl-hyp-seg sl-${st}"/>`;
    prev = { st };
  });
  // repères horaires (une graduation par heure pleine, une étiquette sur deux au-delà de 8 h)
  const startMin = Number(n.start.slice(11, 13)) * 60 + Number(n.start.slice(14, 16));
  const step = span > 480 ? 120 : 60;
  for (let off = (60 - (startMin % 60)) % 60; off < span; off += 60) {
    const hour = Math.floor(((startMin + off) % 1440) / 60);
    body += `<line x1="${x(off).toFixed(1)}" x2="${x(off).toFixed(1)}" y1="${top}" y2="${h - axisH}" class="sl-hyp-tick"/>`;
    if ((off + startMin) % step === 0 || step === 60) body += `<text x="${x(off).toFixed(1)}" y="${h - 3}" text-anchor="middle" class="sl-axis">${String(hour).padStart(2, "0")}h</text>`;
  }
  const laneLabels = HYP_ROWS.map((st, i) => `<text x="${padL + 3}" y="${top + i * (rowH + gap) + 12}" class="sl-hyp-name">${STAGES[st].label}</text>`).join("");
  return `<svg class="sl-hyp-svg" viewBox="0 0 ${w} ${h}" data-span="${span}" data-padl="${padL}" data-padr="${padR}" role="img" aria-label="Hypnogramme de la nuit : phases au fil du temps">
    ${body}${laneLabels}<line class="sl-cursor" x1="0" x2="0" y1="${top}" y2="${h - axisH}" hidden/></svg>`;
}

function chipsHTML(rec) {
  if (!rec) return "";
  const chips = [
    ["HRV", rec.hrv_ms, "ms"],
    ["FC repos", rec.resting_heart_rate, "bpm"],
    ["Fréq. resp.", rec.respiratory_rate, "/min"],
  ].filter(([, v]) => v != null);
  if (!chips.length) return "";
  return `<div class="sl-chips">${chips.map(([l, v, u]) => `<span class="sl-chip"><small>${l}</small><strong>${Math.round(v * 10) / 10}</strong><small>${u}</small></span>`).join("")}</div>`;
}

function detailHTML(nights, i, recByDate) {
  const e = nights[i];
  const n = e.night;
  const withNight = nights.filter((x) => x.night);
  const avgHours = avg(nights.map((x) => x.hours));
  const delta = avgHours != null ? Math.round((e.hours - avgHours) * 60) : null;
  const rec = recByDate[e.date];
  const head = `
    <div class="sl-detail-head">
      <button type="button" class="sl-nav" data-nav="-1" aria-label="Nuit précédente" ${i === 0 ? "disabled" : ""}>‹</button>
      <div class="sl-detail-title"><strong>${nightRangeLabel(e)}</strong><small>${dayName(e.date)} ${dm(e.date)}</small></div>
      <button type="button" class="sl-nav" data-nav="1" aria-label="Nuit suivante" ${i === nights.length - 1 ? "disabled" : ""}>›</button>
    </div>
    <div class="sl-total"><span class="sl-total-val">${formatHoursFr(e.hours)}</span><span class="sl-total-sub">${
      delta == null ? "" : `<span class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "+" : "−"}${Math.abs(delta)} min</span> vs moyenne ${nights.length} nuits`
    }${e.hours < TARGET_H ? ` · <span class="sl-low">sous ${formatHoursFr(TARGET_H)}</span>` : ""}</span></div>`;
  if (!n) return `${head}${chipsHTML(rec)}<p class="muted small">Pas de détail par phase pour cette nuit.</p>`;

  const eff = n.span_min ? Math.round((asleepMin(n) / n.span_min) * 100) : null;
  const facts = [
    ["Coucher → lever", `${hhmm(n.start)} → ${hhmm(n.end)}`],
    ["Dans le lit", dur(n.span_min)],
    ["Éveillé", `${dur(n.awake)} · ${n.awakenings} réveil${n.awakenings > 1 ? "s" : ""}`],
    ["Efficacité", eff != null ? `${eff} %` : "—"],
  ];
  const mean = (k) => avg(withNight.map((x) => x.night[k]));
  const meanLine = withNight.length > 1
    ? `<p class="sl-avg small muted">Moyenne ${withNight.length} nuits : profond ${dur(mean("deep"))} · paradoxal ${dur(mean("rem"))} · léger ${dur(mean("light"))}</p>`
    : "";
  return `${head}
    <div class="sl-facts">${facts.map(([l, v]) => `<div><small>${l}</small><strong>${v}</strong></div>`).join("")}</div>
    ${stageRowsHTML(n)}
    <p class="sl-hyp-readout small" aria-live="polite">Glisse le doigt sur l'hypnogramme pour voir l'heure et la phase.</p>
    ${hypnogramHTML(n)}
    ${chipsHTML(rec)}
    ${meanLine}
    <p class="sl-note small muted">Bande claire = repère indicatif habituel (adulte). Les phases sont estimées par la montre : à lire en tendance, pas à la minute.</p>`;
}

// ---------- API ----------
export function sleepCardHTML(sr, recovery) {
  const history = (sr && sr.history) || [];
  if (!history.length) return "";
  return `<div class="sl-card" data-sleep-card></div>`;
}

export function wireSleepCard(root, sr, recovery) {
  const host = root.querySelector("[data-sleep-card]");
  if (!host) return;
  const history = sr.history || [];
  const recByDate = Object.fromEntries((recovery || []).map((r) => [r.date, r]));
  let range = RANGES.includes(Number(host.dataset.range)) ? Number(host.dataset.range) : 7;
  let sel = Math.min(range, history.length) - 1; // dernière nuit
  let readoutNight = null;

  const view = () => history.slice(-range);
  const render = () => {
    const nights = view();
    sel = Math.max(0, Math.min(sel, nights.length - 1));
    readoutNight = nights[sel].night || null;
    host.innerHTML = `
      <div class="sl-top">
        <div class="segmented sl-range" role="tablist" aria-label="Période">${RANGES.map((r) => `<button type="button" role="tab" class="segment${r === range ? " active" : ""}" aria-selected="${r === range}" data-range="${r}">${r} nuits</button>`).join("")}</div>
      </div>
      ${chartSVG(nights, sel)}
      <div class="sl-legend" aria-hidden="true">${STACK.slice().reverse().map((st) => `<span><i class="sl-dot sl-${st}"></i>${STAGES[st].label}</span>`).join("")}<span><i class="sl-dash"></i>${formatHoursFr(TARGET_H)}</span></div>
      <div class="sl-detail">${detailHTML(nights, sel, recByDate)}</div>`;
  };

  const select = (i, focus) => {
    sel = i;
    render();
    if (focus) host.querySelector(`.sl-hit[data-i="${sel}"]`)?.focus();
  };

  host.addEventListener("click", (ev) => {
    const hit = ev.target.closest(".sl-hit");
    if (hit) return select(Number(hit.dataset.i));
    const nav = ev.target.closest("[data-nav]");
    if (nav && !nav.disabled) return select(sel + Number(nav.dataset.nav));
    const rg = ev.target.closest("[data-range]");
    if (rg) {
      const next = Number(rg.dataset.range);
      if (next === range) return;
      host.dataset.range = String(next);
      range = next;
      sel = view().length - 1;
      render();
    }
  });
  host.addEventListener("keydown", (ev) => {
    const hit = ev.target.closest && ev.target.closest(".sl-hit");
    if (!hit) return;
    const i = Number(hit.dataset.i), last = view().length - 1;
    if (ev.key === "ArrowLeft" && i > 0) { ev.preventDefault(); select(i - 1, true); }
    else if (ev.key === "ArrowRight" && i < last) { ev.preventDefault(); select(i + 1, true); }
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(i, true); }
  });

  // Hypnogramme : survol (souris) ou doigt posé/glissé (tactile) → curseur + phase.
  let pressed = false;
  const readout = (ev) => {
    const svg = ev.target.closest && ev.target.closest(".sl-hyp-svg");
    if (!svg || !readoutNight) return;
    const box = svg.getBoundingClientRect();
    const vbW = svg.viewBox.baseVal.width;
    const padL = Number(svg.dataset.padl), padR = Number(svg.dataset.padr), span = Number(svg.dataset.span);
    const vx = ((ev.clientX - box.left) / box.width) * vbW;
    const frac = Math.max(0, Math.min(1, (vx - padL) / (vbW - padL - padR)));
    const off = frac * span;
    const seg = readoutNight.segments.find(([s, d]) => off >= s && off < s + d) || null;
    const cursor = svg.querySelector(".sl-cursor");
    const cx = padL + frac * (vbW - padL - padR);
    cursor.setAttribute("x1", cx.toFixed(1)); cursor.setAttribute("x2", cx.toFixed(1)); cursor.removeAttribute("hidden");
    const out = host.querySelector(".sl-hyp-readout");
    out.textContent = seg
      ? `${clock(readoutNight.start, off)} · ${STAGES[BY_CODE[seg[2]]].label} · ${dur(seg[1])} (de ${clock(readoutNight.start, seg[0])} à ${clock(readoutNight.start, seg[0] + seg[1])})`
      : `${clock(readoutNight.start, off)} · pas de donnée`;
  };
  host.addEventListener("pointerdown", (ev) => { if (ev.target.closest(".sl-hyp-svg")) { pressed = true; readout(ev); } });
  host.addEventListener("pointermove", (ev) => { if (pressed || ev.pointerType === "mouse") readout(ev); });
  const release = () => { pressed = false; };
  host.addEventListener("pointerup", release);
  host.addEventListener("pointercancel", release);

  render();
}
