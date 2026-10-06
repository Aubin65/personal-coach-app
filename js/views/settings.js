import { ghGetFile, ghListDir, ghPutFile, REPO, TOKEN_KEY, getToken } from "../github-api.js";
import { escapeHtmlText, escapeAttr, skeletonHTML } from "../markdown.js";
import { todayISO, formatFrDate, addDaysISO } from "../date-utils.js";
import { stale } from "../nav.js";
import { loadTodayDataState } from "../today-data-check.js";
import { renderSystemStatus } from "../system-status.js";
import { loadClubConfig, saveClubWeekdays } from "../club-training.js";
import { loadPlayingTeams, savePlayingTeams, ALL_TEAMS } from "../match-teams.js";
import { queuedEntries, flushQueue, retryFailed } from "../offline-queue.js";
import { healthPath, checkinPath } from "../data-paths.js";
import { currentTheme, setTheme } from "../theme.js";

// ============================================================================
// Réglages (docs/adr/0096) — demande d'Aubin : une page de réglages
// accessible depuis l'en-tête, avec l'état des données (« ai-je bien reçu
// les données d'aujourd'hui ? ») et l'accès à la donnée brute, modifiable à
// la main. Regroupe ce qui était éparpillé (jours de club dans la Forge,
// équipe dans Matchs, état du système en bas d'Aujourd'hui).
// ============================================================================

const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** Sections de données brutes : dossier, libellé, et qui écrit ces fichiers
 * (un seul écrivain par fichier, ADR-0083) — affiché avant toute modif. */
export const DATA_SECTIONS = [
  { dir: "data/health", label: "Santé (iPhone)", writer: "le raccourci Santé de l'iPhone", warn: "Une modification manuelle sera remplacée à la prochaine synchro de ce jour-là." },
  { dir: "data/checkin", label: "Check-in & charge", writer: "l'app (check-in, douleurs, charge des séances)" },
  { dir: "data/training/app-log", label: "Séances", writer: "l'app (séances loguées, Forge validée)" },
  { dir: "data/training/app-log/pending", label: "Propositions du coach", writer: "le coach", warn: "Après modification, garde le format attendu : le coach valide ces fichiers avec coach.validate." },
  { dir: "data/schedule", label: "Matchs", writer: "l'app (performance, ressenti) et le coach (scores)" },
  { dir: "data/blocks", label: "Blocs", writer: "l'app (Forge de bloc)" },
  { dir: "data/blocks/drafts", label: "Brouillons de bloc", writer: "l'app ; les fichiers .coach.json par le coach" },
  { dir: "data/config", label: "Réglages", writer: "l'app" },
  { dir: "data/feelings", label: "Ressentis classés", writer: "le coach (digest du matin)" },
  { dir: "data/notes", label: "Notes vocales", writer: "l'app" },
  { dir: "data/digests", label: "Digests", writer: "le coach (digest du matin)" },
  { dir: "data/alerts", label: "Alertes", writer: "le digest du matin" },
  { dir: "data/app", label: "Résumé de l'app", writer: "le digest du matin (généré)", warn: "summary.json est recalculé à chaque digest : une modification ici sera écrasée." },
];

export function sectionFor(path) {
  return [...DATA_SECTIONS].sort((a, b) => b.dir.length - a.dir.length).find((s) => path === s.dir || path.startsWith(`${s.dir}/`)) || null;
}

/** JSON valide ? `null` si oui, sinon le message d'erreur (pur). */
export function jsonError(path, text) {
  if (!/\.json$/i.test(path)) return null;
  try { JSON.parse(text); return null; } catch (err) { return err.message; }
}

let viewDate = null;
let browsing = { dir: null, showAll: false };

function card(title, body, extraClass = "") {
  return `<section class="card settings-card ${extraClass}"><h2>${escapeHtmlText(title)}</h2>${body}</section>`;
}

function statusRow(state, title, detail, actionsHTML = "") {
  return `<li class="settings-row ${state}"><span class="settings-dot" aria-hidden="true"></span><div class="settings-row-text"><strong>${escapeHtmlText(title)}</strong><span>${detail}</span></div>${actionsHTML ? `<div class="settings-row-actions">${actionsHTML}</div>` : ""}</li>`;
}

function hhmm(iso) {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

async function renderDayData(box, token) {
  box.innerHTML = skeletonHTML();
  const date = viewDate;
  const today = todayISO();
  const s = await loadTodayDataState(date).catch(() => null);
  if (stale(token)) return;
  if (!s) { box.innerHTML = `<p class="muted small">Lecture impossible pour l'instant.</p>`; return; }
  const open = (path) => `<button type="button" class="link-button" data-open-file="${escapeAttr(path)}">Ouvrir</button>`;
  const rows = [
    s.health.received
      ? statusRow("ok", "Santé (iPhone)", `reçue${s.health.at ? ` à ${hhmm(s.health.at)}` : ""} : ${escapeHtmlText(s.health.fields.join(", "))}.`, open(healthPath(date)))
      : statusRow(date === today ? "warn" : "info", "Santé (iPhone)", "aucune donnée reçue pour ce jour.", open(healthPath(date))),
    s.checkin
      ? statusRow("ok", "Check-in", "fait.", open(checkinPath(date)))
      : statusRow("info", "Check-in", "pas de check-in ce jour-là.", open(checkinPath(date))),
    s.digest.exists
      ? statusRow(s.digestBeforeHealth ? "warn" : "ok", "Digest", `${s.digest.at ? `calculé à ${hhmm(s.digest.at)}` : "présent"}${s.digestBeforeHealth ? " — avant l'arrivée des données santé" : ""}.`, open(`data/digests/${date}.md`))
      : statusRow("info", "Digest", "pas de digest ce jour-là."),
  ];
  box.innerHTML = `
    <div class="settings-date-nav">
      <button type="button" class="icon-button small" data-day="-1" aria-label="Jour précédent"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
      <input type="date" id="settings-date" value="${date}" max="${today}" aria-label="Jour affiché">
      <button type="button" class="icon-button small" data-day="1" aria-label="Jour suivant"${date >= today ? " disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <p class="settings-date-label">${escapeHtmlText(date === today ? "Aujourd'hui" : formatFrDate(date))}</p>
    <ul class="settings-rows">${rows.join("")}</ul>`;
  const go = (d) => { viewDate = d > today ? today : d; renderDayData(box, token).catch(() => {}); };
  box.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => go(addDaysISO(date, Number(b.dataset.day)))));
  box.querySelector("#settings-date").addEventListener("change", (e) => { if (e.target.value) go(e.target.value); });
  wireOpenFile(box);
}

async function renderTraining(box) {
  const [club, teams] = await Promise.all([loadClubConfig(), loadPlayingTeams()]);
  const days = [...club.weekdays];
  let playing = [...teams];
  const draw = () => {
    box.innerHTML = `
      <p class="settings-label">Entraînements club</p>
      <div class="settings-chips">${WEEKDAYS.map((l, i) => `<button type="button" class="suggestion-chip${days.includes(i + 1) ? " active" : ""}" data-wd="${i + 1}" aria-pressed="${days.includes(i + 1)}">${l}</button>`).join("")}</div>
      <p class="muted small">Jours où un entraînement club est prévu par défaut (annulable au jour le jour depuis Aujourd'hui).</p>
      <p class="settings-label">Je joue en</p>
      <div class="settings-chips">${ALL_TEAMS.map((t) => `<button type="button" class="suggestion-chip${playing.includes(t) ? " active" : ""}" data-team="${escapeAttr(t)}" aria-pressed="${playing.includes(t)}">${escapeHtmlText(t)}</button>`).join("")}</div>
      <p class="muted small">Seuls ces matchs déclenchent rappels et fiche de ressenti.</p>
      <p class="muted small settings-saved" aria-live="polite"></p>`;
    const saved = box.querySelector(".settings-saved");
    box.querySelectorAll("[data-wd]").forEach((b) => b.addEventListener("click", async () => {
      const wd = Number(b.dataset.wd);
      const i = days.indexOf(wd);
      if (i === -1) days.push(wd); else days.splice(i, 1);
      draw();
      try { await saveClubWeekdays(days); box.querySelector(".settings-saved").textContent = "Enregistré ✓"; } catch (err) { saved.textContent = `Échec : ${err.message}`; }
    }));
    box.querySelectorAll("[data-team]").forEach((b) => b.addEventListener("click", async () => {
      const t = b.dataset.team;
      playing = playing.includes(t) ? playing.filter((x) => x !== t) : [...playing, t];
      draw();
      try { await savePlayingTeams(playing); box.querySelector(".settings-saved").textContent = "Enregistré ✓"; } catch (err) { saved.textContent = `Échec : ${err.message}`; }
    }));
  };
  draw();
}

async function appVersion() {
  try {
    const keys = await caches.keys();
    const shell = keys.filter((k) => /^coach-shell-v\d+$/.test(k)).sort((a, b) => Number(b.split("v").pop()) - Number(a.split("v").pop()))[0];
    return shell ? shell.replace("coach-shell-", "") : null;
  } catch (_) {
    return null;
  }
}

async function pushState() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return "off";
    return (await reg.pushManager.getSubscription()) ? "on" : "off";
  } catch (_) {
    return "unsupported";
  }
}

async function renderApp(box) {
  const [version, push] = await Promise.all([appVersion(), pushState()]);
  const queue = queuedEntries();
  const pending = queue.filter((e) => !e.failed);
  const failed = queue.filter((e) => e.failed);
  const theme = currentTheme();
  const themes = [["auto", "Auto"], ["light", "Clair"], ["dark", "Sombre"]];
  box.innerHTML = `
    <p class="settings-label">Thème</p>
    <div class="segmented settings-theme" role="radiogroup">${themes.map(([id, label]) => `<button type="button" class="segment${theme === id ? " active" : ""}" role="radio" aria-checked="${theme === id}" data-theme-choice="${id}">${label}</button>`).join("")}</div>
    <ul class="settings-rows">
      ${statusRow(push === "on" ? "ok" : "info", "Notifications", push === "on" ? "activées sur cet appareil." : push === "off" ? "désactivées sur cet appareil." : "non disponibles ici (installe l'app sur l'écran d'accueil, iOS 16.4+).",
        push === "unsupported" ? "" : `<button type="button" class="link-button" data-toggle-push>${push === "on" ? "Désactiver" : "Activer"}</button>`)}
      ${statusRow(failed.length ? "warn" : pending.length ? "info" : "ok", "Saisies hors-ligne",
        failed.length ? `${failed.length} en échec, ${pending.length} en attente.` : pending.length ? `${pending.length} en attente d'envoi.` : "tout est envoyé.",
        queue.length ? `<button type="button" class="link-button" data-flush>Renvoyer maintenant</button>` : "")}
      ${statusRow("info", "Version", `${version ? `app ${escapeHtmlText(version)}` : "version inconnue"}.`, `<button type="button" class="link-button" data-force-update>Forcer la mise à jour</button>`)}
    </ul>`;
  box.querySelectorAll("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => {
    setTheme(b.dataset.themeChoice);
    renderApp(box).catch(() => {});
  }));
  const pushBtn = box.querySelector("[data-toggle-push]");
  if (pushBtn) pushBtn.addEventListener("click", () => {
    const bell = document.getElementById("push-subscribe-button");
    if (bell) bell.click();
    setTimeout(() => renderApp(box).catch(() => {}), 2500);
  });
  const flushBtn = box.querySelector("[data-flush]");
  if (flushBtn) flushBtn.addEventListener("click", () => {
    retryFailed();
    flushQueue();
    setTimeout(() => renderApp(box).catch(() => {}), 2000);
  });
  box.querySelector("[data-force-update]").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("coach-shell")).map((k) => caches.delete(k)));
    } catch (_) { /* on recharge quand même */ }
    window.location.reload();
  });
}

function renderAccount(box) {
  const token = getToken() || "";
  box.innerHTML = `
    <ul class="settings-rows">
      ${statusRow("info", "Dépôt de données", `<code>${escapeHtmlText(REPO)}</code>`)}
      ${statusRow("info", "Token GitHub", token ? `enregistré sur cet appareil (…${escapeHtmlText(token.slice(-4))}).` : "absent.", `<button type="button" class="link-button danger" data-logout>Changer de token</button>`)}
    </ul>`;
  box.querySelector("[data-logout]").addEventListener("click", () => {
    if (!window.confirm("Retirer le token de cet appareil ? Il faudra en saisir un à nouveau.")) return;
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
    window.location.reload();
  });
}

// ------------------------------------------------------------- données brutes
async function renderBrowser(box, token) {
  if (!browsing.dir) {
    box.innerHTML = `
      <p class="muted small">Toutes les données de l'app, fichier par fichier. Touche une section, puis un fichier pour le lire ou le corriger.</p>
      <div class="settings-sections">${DATA_SECTIONS.map((s) => `<button type="button" class="settings-section" data-dir="${escapeAttr(s.dir)}"><strong>${escapeHtmlText(s.label)}</strong><small>${escapeHtmlText(s.dir.replace(/^data\//, ""))}</small></button>`).join("")}</div>`;
    box.querySelectorAll("[data-dir]").forEach((b) => b.addEventListener("click", () => { browsing = { dir: b.dataset.dir, showAll: false }; renderBrowser(box, token).catch(() => {}); }));
    return;
  }
  const section = sectionFor(browsing.dir);
  box.innerHTML = skeletonHTML();
  const entries = await ghListDir(browsing.dir).catch(() => []);
  if (stale(token)) return;
  const files = entries.filter((e) => e.type === "file").sort((a, b) => b.name.localeCompare(a.name));
  const dirs = entries.filter((e) => e.type === "dir");
  const shown = browsing.showAll ? files : files.slice(0, 20);
  box.innerHTML = `
    <div class="settings-crumbs"><button type="button" class="link-button" data-up>← Sections</button><span>${escapeHtmlText(section ? section.label : browsing.dir)}</span></div>
    ${section ? `<p class="muted small">Écrit par ${escapeHtmlText(section.writer)}.</p>` : ""}
    ${dirs.length ? `<div class="settings-chips">${dirs.map((d) => `<button type="button" class="suggestion-chip" data-subdir="${escapeAttr(d.path)}">📁 ${escapeHtmlText(d.name)}</button>`).join("")}</div>` : ""}
    ${files.length ? `<ul class="settings-files">${shown.map((f) => `<li><button type="button" data-open-file="${escapeAttr(f.path)}"><span>${escapeHtmlText(f.name)}</span><small>${f.size != null ? `${Math.max(1, Math.round(f.size / 1024))} ko` : ""}</small></button></li>`).join("")}</ul>` : `<p class="muted small">Aucun fichier.</p>`}
    ${files.length > shown.length ? `<button type="button" class="primary-button ghost small" data-more>Voir les ${files.length - shown.length} autres</button>` : ""}`;
  box.querySelector("[data-up]").addEventListener("click", () => { browsing = { dir: null, showAll: false }; renderBrowser(box, token).catch(() => {}); });
  box.querySelectorAll("[data-subdir]").forEach((b) => b.addEventListener("click", () => { browsing = { dir: b.dataset.subdir, showAll: false }; renderBrowser(box, token).catch(() => {}); }));
  const more = box.querySelector("[data-more]");
  if (more) more.addEventListener("click", () => { browsing.showAll = true; renderBrowser(box, token).catch(() => {}); });
  wireOpenFile(box);
}

function wireOpenFile(root) {
  root.querySelectorAll("[data-open-file]").forEach((b) => b.addEventListener("click", () => openFileEditor(b.dataset.openFile)));
}

/** Éditeur plein écran d'un fichier de données : lecture, correction,
 * enregistrement (JSON vérifié avant l'envoi, `sha` pour ne jamais écraser
 * une version plus récente sans le savoir). */
export async function openFileEditor(path) {
  const overlay = document.createElement("div");
  overlay.className = "raw-editor";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <header class="raw-editor-head">
      <button type="button" class="icon-button" data-close aria-label="Fermer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="raw-editor-title"><strong>${escapeHtmlText(path.split("/").pop())}</strong><small>${escapeHtmlText(path)}</small></div>
    </header>
    <div class="raw-editor-body">${skeletonHTML()}</div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("[data-close]").addEventListener("click", close);
  const body = overlay.querySelector(".raw-editor-body");
  const file = await ghGetFile(path).catch(() => null);
  const section = sectionFor(path);
  const original = file ? file.content : "";
  let sha = file ? file.sha : null;
  const isJson = /\.json$/i.test(path);
  const pretty = (() => {
    if (!file || !isJson) return original;
    try { return JSON.stringify(JSON.parse(original), null, 2); } catch (_) { return original; }
  })();
  body.innerHTML = `
    ${section && section.warn ? `<p class="raw-editor-warn">⚠️ ${escapeHtmlText(section.warn)}</p>` : ""}
    ${!file ? `<p class="muted small">Ce fichier n'existe pas encore : l'enregistrer le crée.</p>` : ""}
    <textarea class="raw-editor-text" spellcheck="false" autocapitalize="off" autocorrect="off">${escapeHtmlText(pretty || (isJson ? "{\n  \n}" : ""))}</textarea>
    <p class="raw-editor-status muted small" aria-live="polite"></p>
    <div class="raw-editor-actions">
      ${isJson ? `<button type="button" class="primary-button ghost" data-format>Mettre en forme</button>` : ""}
      <button type="button" class="primary-button" data-save>Enregistrer</button>
    </div>`;
  const text = body.querySelector(".raw-editor-text");
  const status = body.querySelector(".raw-editor-status");
  const check = () => {
    const err = jsonError(path, text.value);
    status.textContent = err ? `JSON invalide : ${err}` : (text.value !== pretty ? "Modifié, non enregistré." : "");
    status.classList.toggle("error-text", !!err);
    return !err;
  };
  text.addEventListener("input", check);
  const fmt = body.querySelector("[data-format]");
  if (fmt) fmt.addEventListener("click", () => { if (check()) { text.value = JSON.stringify(JSON.parse(text.value), null, 2); check(); } });
  body.querySelector("[data-save]").addEventListener("click", async (e) => {
    if (!check()) return;
    if (section && section.warn && !window.confirm(`${section.warn}\n\nEnregistrer quand même ?`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    status.textContent = "Enregistrement…";
    try {
      const content = isJson ? `${JSON.stringify(JSON.parse(text.value), null, 2)}\n` : text.value;
      const res = await ghPutFile(path, content, `Édition manuelle : ${path}`, sha, false);
      if (res && res.content && res.content.sha) sha = res.content.sha;
      status.textContent = "Enregistré ✓";
    } catch (err) {
      status.textContent = /409|422|sha/i.test(err.message)
        ? "Ce fichier a changé entre-temps (synchro, coach…). Ferme et rouvre-le pour repartir de la dernière version."
        : `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

export async function renderSettings(token) {
  const root = document.getElementById("settings-root");
  if (!root) return;
  if (!viewDate) viewDate = todayISO();
  browsing = { dir: null, showAll: false };
  root.innerHTML = `
    ${card("Données du jour", `<div id="settings-day"></div>`)}
    <div id="system-status"></div>
    ${card("Entraînement", `<div id="settings-training"></div>`)}
    ${card("Application", `<div id="settings-app"></div>`)}
    ${card("Compte", `<div id="settings-account"></div>`)}
    ${card("Données brutes", `<div id="settings-raw"></div>`, "settings-raw-card")}`;
  renderAccount(root.querySelector("#settings-account"));
  await Promise.all([
    renderDayData(root.querySelector("#settings-day"), token),
    renderSystemStatus(token).catch(() => {}),
    renderTraining(root.querySelector("#settings-training")).catch(() => {}),
    renderApp(root.querySelector("#settings-app")).catch(() => {}),
    renderBrowser(root.querySelector("#settings-raw"), token),
  ]);
}
