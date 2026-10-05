import { ghGetFile, ghListDir } from "../github-api.js";
import { renderMarkdown, escapeHtmlText, escapeAttr, skeletonHTML } from "../markdown.js";
import { todayISO, addDaysISO } from "../date-utils.js";
import { currentBlockLabel } from "../training-index.js";
import { splitBlockMarkdown } from "../plan-overview.js";
import { showView, stale, state } from "../nav.js";

// ============================================================================
// Plan › Bloc (docs/adr/0093). Avant : seul le bloc « en cours » (déduit des
// étiquettes de séances B4-S3…) s'affichait, en Markdown brut — un bloc tout
// juste validé dans la Forge de bloc mais qui ne commence que la semaine
// suivante était introuvable. Maintenant : tous les blocs, chacun avec son
// statut (à venir / en cours / terminé), et une mise en page par section.
// ============================================================================

const SHORT_DATE = { day: "numeric", month: "short" };

function frShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("fr-FR", SHORT_DATE);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
}

/** Blocs connus : `data/blocks/B<n>.md`, dates prises dans le brouillon de
 * la Forge de bloc (`drafts/B<n>.json` : `debut`, `duree_semaines`) quand
 * il existe. Les anciens blocs (écrits à la main) n'en ont pas : leur statut
 * vient des étiquettes de séances (`currentBlockLabel`). */
export async function loadBlocks(today = todayISO()) {
  const [entries, labelFromSessions] = await Promise.all([
    ghListDir("data/blocks").catch(() => []),
    currentBlockLabel().catch(() => null),
  ]);
  const labels = entries
    .map((e) => /^B(\d+)\.md$/.exec(e.name || ""))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => `B${m[1]}`);
  const sessionNum = labelFromSessions ? Number(labelFromSessions.slice(1)) : null;
  const blocks = await Promise.all(labels.map(async (label) => {
    let start = null;
    let weeks = null;
    const draft = await ghGetFile(`data/blocks/drafts/${label}.json`).catch(() => null);
    if (draft) {
      try {
        const s = (JSON.parse(draft.content) || {}).sections || {};
        if (/^\d{4}-\d{2}-\d{2}$/.test(s.debut || "")) start = s.debut;
        if (Number(s.duree_semaines) > 0) weeks = Number(s.duree_semaines);
      } catch (_) { /* brouillon illisible : pas de dates */ }
    }
    const end = start && weeks ? addDaysISO(start, weeks * 7 - 1) : null;
    let status;
    let week = null;
    if (start && end) {
      if (today < start) status = "upcoming";
      else if (today > end) status = "done";
      else { status = "current"; week = Math.floor(daysBetween(start, today) / 7) + 1; }
    } else if (sessionNum != null) {
      const n = Number(label.slice(1));
      status = n === sessionNum ? "current" : n < sessionNum ? "done" : "upcoming";
    } else {
      status = "unknown";
    }
    return { label, start, end, weeks, week, status, hasDraft: !!draft };
  }));
  // Deux blocs « en cours » (un ancien bloc sans dates + un bloc daté qui a
  // démarré) : le bloc daté l'emporte, l'ancien est terminé.
  const datedCurrent = blocks.find((b) => b.status === "current" && b.start);
  if (datedCurrent) blocks.forEach((b) => { if (b !== datedCurrent && b.status === "current" && !b.start) b.status = "done"; });
  return blocks;
}

/** Bloc affiché par défaut : celui demandé (Forge de bloc → « Voir »), sinon
 * le bloc en cours, sinon le prochain à venir, sinon le dernier. */
export function defaultBlock(blocks, requested = null) {
  return blocks.find((b) => b.label === requested)
    || blocks.find((b) => b.status === "current")
    || blocks.find((b) => b.status === "upcoming")
    || blocks[blocks.length - 1]
    || null;
}

/** `# Bloc B5 — jusqu'à …` + intro + sections `## …` (sans le planning
 * détaillé, déjà retiré par splitBlockMarkdown). */
export function parseBlockMarkdown(md) {
  const { overview } = splitBlockMarkdown(md);
  const lines = overview.replace(/\r\n/g, "\n").split("\n");
  let title = "";
  const intro = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h1 = /^#\s+(.*)$/.exec(line);
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h1 && !title && !current) { title = h1[1].trim(); continue; }
    if (h2) { current = { heading: h2[1].trim(), body: [] }; sections.push(current); continue; }
    (current ? current.body : intro).push(line);
  }
  // Fin visée : dans le titre (« # Bloc B4 — jusqu'au retour en match… »,
  // anciens blocs) ou sur sa propre ligne (« **Fin visée** : … », ADR-0093).
  let subtitle = (title.split(/\s+—\s+/)[1] || "").replace(/^jusqu'(?:à|au)\s+/i, "").trim();
  const finIdx = intro.findIndex((l) => /^\*\*Fin visée\*\*\s*:/.test(l));
  if (finIdx !== -1) {
    if (!subtitle) subtitle = intro[finIdx].replace(/^\*\*Fin visée\*\*\s*:\s*/, "").trim();
    intro.splice(finIdx, 1);
  }
  return {
    title,
    subtitle: subtitle ? subtitle.charAt(0).toUpperCase() + subtitle.slice(1) : "",
    intro: intro.join("\n").trim(),
    sections: sections.map((s) => ({ heading: s.heading, body: s.body.join("\n").trim() })),
  };
}

const STATUS_LABEL = { current: "En cours", upcoming: "À venir", done: "Terminé", unknown: "" };

function chipLabel(b) {
  if (b.status === "upcoming" && b.start) return `${b.label} · dès le ${frShort(b.start)}`;
  if (b.status === "current") return `${b.label} · en cours`;
  return b.label;
}

function heroHTML(b, parsed, today) {
  const range = b.start && b.end ? `${frShort(b.start)} → ${frShort(b.end)} · ${b.weeks} semaine${b.weeks > 1 ? "s" : ""}` : "";
  let progress = "";
  if (b.status === "current" && b.week && b.weeks) {
    const pct = Math.min(100, Math.round((b.week / b.weeks) * 100));
    progress = `<div class="bloc-hero-progress"><div class="bloc-hero-bar"><span style="width:${pct}%"></span></div><span>Semaine ${b.week} sur ${b.weeks}</span></div>`;
  } else if (b.status === "upcoming" && b.start) {
    const n = daysBetween(today, b.start);
    progress = `<p class="bloc-hero-when">Commence ${n <= 1 ? "demain" : `dans ${n} jours`}</p>`;
  }
  return `
    <section class="bloc-hero status-${b.status}">
      <span class="bloc-hero-kicker">${escapeHtmlText(STATUS_LABEL[b.status] || "Bloc")}</span>
      <h2 class="bloc-hero-title">Bloc ${escapeHtmlText(b.label)}</h2>
      ${range ? `<p class="bloc-hero-range">${escapeHtmlText(range)}</p>` : ""}
      ${parsed.subtitle ? `<p class="bloc-hero-goal"><span>Fin visée</span>${escapeHtmlText(parsed.subtitle)}</p>` : ""}
      ${progress}
    </section>`;
}

function bulletItems(body) {
  return body.split("\n").reduce((items, line) => {
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) items.push(m[1]);
    else if (items.length && line.trim() && !/^#{1,6}\s/.test(line) && !/^\s*\d+\.\s/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    return items;
  }, []);
}

function objectivesHTML(section) {
  const [main, ...subs] = section.body.split(/\n(?=###\s)/);
  const goals = bulletItems(main);
  const qualities = subs.find((s) => /qualit/i.test(s));
  const others = subs.filter((s) => s !== qualities);
  const qualityItems = qualities ? [...qualities.matchAll(/^\s*\d+\.\s+(.*)$/gm)].map((m) => m[1]) : [];
  return `
    <section class="card bloc-section">
      <h3 class="bloc-section-title">Objectifs</h3>
      ${goals.length ? `<ul class="bloc-goals">${goals.map((g) => `<li>${renderMarkdown(g).replace(/^<p>|<\/p>\s*$/g, "")}</li>`).join("")}</ul>` : `<div class="markdown-body">${renderMarkdown(main)}</div>`}
      ${qualityItems.length ? `<p class="bloc-sub-title">Qualités, par priorité</p><ol class="bloc-qualities">${qualityItems.map((q) => `<li>${escapeHtmlText(q)}</li>`).join("")}</ol>` : ""}
      ${others.map((o) => `<div class="markdown-body small">${renderMarkdown(o)}</div>`).join("")}
    </section>`;
}

function structureHTML(section) {
  const items = bulletItems(section.body);
  const tiles = items
    .map((it) => /^(.*?)\s*:\s*(\d+)\s*séance/i.exec(it))
    .filter(Boolean)
    .map((m) => `<div class="bloc-tile"><b>${m[2]}</b><span>${escapeHtmlText(m[1].replace(/\s*club$/i, ""))}<br><small>par semaine</small></span></div>`);
  if (tiles.length === items.length && tiles.length) {
    return `<section class="card bloc-section"><h3 class="bloc-section-title">Semaine type</h3><div class="bloc-tiles">${tiles.join("")}</div></section>`;
  }
  return `<section class="card bloc-section"><h3 class="bloc-section-title">${escapeHtmlText(section.heading)}</h3><div class="markdown-body small">${renderMarkdown(section.body)}</div></section>`;
}

function calloutHTML(section, cls) {
  return `
    <section class="card bloc-section bloc-callout ${cls}">
      <h3 class="bloc-section-title">${escapeHtmlText(section.heading.replace(/\s*\(.*\)$/, ""))}</h3>
      <div class="markdown-body">${renderMarkdown(section.body)}</div>
    </section>`;
}

function detailsHTML(section, open = false) {
  return `
    <details class="card bloc-section bloc-more"${open ? " open" : ""}>
      <summary>${escapeHtmlText(section.heading)}</summary>
      <div class="markdown-body small">${renderMarkdown(section.body)}</div>
    </details>`;
}

export function blockBodyHTML(parsed) {
  const html = [];
  // L'intro « 6 semaines à partir du lundi 19 octobre. » double la ligne de
  // dates du bandeau : retirée ; carte omise si rien d'autre.
  const intro = parsed.intro.replace(/^\d+ semaines? à partir du [^.]+\.\s*/i, "").trim();
  if (intro) html.push(`<section class="card bloc-section bloc-intro"><div class="markdown-body">${renderMarkdown(intro)}</div></section>`);
  const used = new Set();
  const take = (re) => { const s = parsed.sections.find((x) => !used.has(x) && re.test(x.heading)); if (s) used.add(s); return s; };
  const objectives = take(/^objectifs principaux/i);
  const structure = take(/^structure/i);
  const constraints = take(/^contraintes/i);
  const milestones = take(/^jalons/i);
  const feelings = take(/^ressentis/i);
  if (objectives) html.push(objectivesHTML(objectives));
  if (structure) html.push(structureHTML(structure));
  if (constraints) html.push(calloutHTML(constraints, "warn"));
  if (milestones) html.push(calloutHTML(milestones, "info"));
  for (const s of parsed.sections) if (!used.has(s)) html.push(detailsHTML(s));
  if (feelings) html.push(detailsHTML({ ...feelings, heading: feelings.heading.replace(/\s*\(.*\)$/, "") }));
  return html.join("");
}

export async function renderBlockTab(container, token) {
  container.innerHTML = skeletonHTML();
  const today = todayISO();
  const blocks = await loadBlocks(today);
  if (stale(token)) return;
  if (!blocks.length) {
    container.innerHTML = `<section class="card"><p class="muted">Pas encore de bloc.</p><button type="button" class="primary-button" data-open-forge-bloc>🎯 Créer un bloc dans la Forge de bloc</button></section>`;
    container.querySelector("[data-open-forge-bloc]").addEventListener("click", () => showView("forge-bloc"));
    return;
  }
  const selected = defaultBlock(blocks, state.blockTabLabel);
  const file = await ghGetFile(`data/blocks/${selected.label}.md`).catch(() => null);
  if (stale(token)) return;
  const parsed = parseBlockMarkdown(file ? file.content : "");
  container.innerHTML = `
    ${blocks.length > 1 ? `<div class="bloc-picker" role="tablist">${blocks.map((b) => `<button type="button" role="tab" class="bloc-pick status-${b.status}${b === selected ? " active" : ""}" aria-selected="${b === selected}" data-block="${escapeAttr(b.label)}">${escapeHtmlText(chipLabel(b))}</button>`).join("")}</div>` : ""}
    ${heroHTML(selected, parsed, today)}
    ${file ? blockBodyHTML(parsed) : `<section class="card"><p class="muted">Fichier du bloc introuvable.</p></section>`}
    <button type="button" class="week-adjust-button" data-open-forge-bloc>${selected.hasDraft ? `Modifier ${selected.label} dans la Forge de bloc` : "Ouvrir la Forge de bloc"}</button>`;
  container.querySelectorAll("[data-block]").forEach((btn) => btn.addEventListener("click", () => {
    state.blockTabLabel = btn.dataset.block;
    renderBlockTab(container, token).catch(() => {});
  }));
  container.querySelector("[data-open-forge-bloc]").addEventListener("click", () => {
    if (selected.hasDraft) state.forgeBlocLabel = selected.label;
    showView("forge-bloc");
  });
}
