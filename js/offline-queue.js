import { isNetworkError } from "./github-api.js";

// ============================================================================
// File d'attente des saisies (docs/adr/0070) — une saisie faite sans réseau
// (salle sans réception, cave de club) n'est plus perdue : elle est gardée
// sur le téléphone puis renvoyée dès que la connexion revient. Chaque saisie
// est une "opération" nommée (registerQueuedOp) rejouée avec ses arguments
// sérialisables, jamais une fonction — et toutes relisent le fichier distant
// avant d'écrire (ghPutJSON), donc un rejeu tardif ne piétine pas un
// changement fait entre-temps depuis un autre appareil.
// Les erreurs HTTP de GitHub (403, 422...) ne sont jamais mises en file : ce
// n'est pas un problème de réseau, l'appelant doit les voir tout de suite.
// ============================================================================

const QUEUE_KEY = "coach_write_queue";
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 30000;

const ops = new Map();
const results = new Map();
const listeners = new Set();
let flushing = null;
let retryTimer = null;

export function registerQueuedOp(name, fn) {
  ops.set(name, fn);
}

function readQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeQueue(queue) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (_) {}
  listeners.forEach((cb) => { try { cb(queue); } catch (_) {} });
}

export function queuedEntries() {
  return readQueue();
}

/** Premier élément en attente portant cette clé (ex. `session:2026-10-03`),
 * ou `null` — permet à la vue séance de montrer ce qui a été saisi hors-ligne
 * au lieu de la version distante, plus ancienne. */
export function queuedEntryByKey(key) {
  return readQueue().find((e) => e.key === key && !e.failed) || null;
}

export function onQueueChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function enqueue({ name, args, key, label }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Même clé = même cible (la séance d'une date, le check-in d'un jour) et
  // chaque opération porte l'instantané complet : seul le dernier compte.
  const queue = readQueue().filter((e) => !(key && e.key === key && !e.failed));
  queue.push({ id, name, args, key, label, at: new Date().toISOString(), attempts: 0 });
  writeQueue(queue);
  return id;
}

function updateEntry(id, patch) {
  writeQueue(readQueue().map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

function removeEntry(id) {
  writeQueue(readQueue().filter((e) => e.id !== id));
}

/** Renvoie les saisies en attente dans l'ordre, s'arrête au premier échec
 * réseau. Une erreur HTTP est retentée au prochain passage, puis marquée
 * définitivement en échec après `MAX_ATTEMPTS` pour ne pas bloquer le reste. */
export function flushQueue() {
  if (flushing) return flushing;
  flushing = (async () => {
    for (;;) {
      const entry = readQueue().find((e) => !e.failed);
      if (!entry) break;
      const fn = ops.get(entry.name);
      if (!fn) { updateEntry(entry.id, { failed: "opération inconnue" }); continue; }
      try {
        results.set(entry.id, await fn(entry.args));
        removeEntry(entry.id);
      } catch (err) {
        if (isNetworkError(err)) break;
        const attempts = (entry.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) { updateEntry(entry.id, { attempts, failed: err.message }); continue; }
        updateEntry(entry.id, { attempts });
        break;
      }
    }
  })().finally(() => {
    flushing = null;
    scheduleRetry();
  });
  return flushing;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (readQueue().some((e) => !e.failed)) retryTimer = setTimeout(() => { flushQueue(); }, RETRY_INTERVAL_MS);
}

/** Exécute l'opération maintenant ; hors-ligne (ou si des saisies plus
 * anciennes attendent encore, pour garder l'ordre), la met en file.
 * `{queued: false, result}` quand elle est partie, `{queued: true}` sinon. */
export async function runQueued(name, args, { key = null, label = "" } = {}) {
  const fn = ops.get(name);
  if (!fn) throw new Error(`Opération inconnue : ${name}`);
  if (readQueue().every((e) => e.failed)) {
    try {
      return { queued: false, result: await fn(args) };
    } catch (err) {
      if (!isNetworkError(err)) throw err;
    }
  }
  const id = enqueue({ name, args, key, label });
  await flushQueue();
  const stillQueued = readQueue().some((e) => e.id === id);
  const result = results.get(id);
  results.delete(id);
  return stillQueued ? { queued: true } : { queued: false, result };
}

/** Remet à zéro les saisies définitivement en échec pour les retenter. */
export function retryFailed() {
  writeQueue(readQueue().map((e) => (e.failed ? { ...e, failed: null, attempts: 0 } : e)));
  return flushQueue();
}

// ---------- Bandeau et déclencheurs ----------

function bannerText(queue) {
  const failed = queue.filter((e) => e.failed);
  const waiting = queue.filter((e) => !e.failed);
  if (failed.length) {
    return { text: `⚠️ ${failed.length} saisie(s) n'ont pas pu être envoyées (${failed[0].label || failed[0].name}) : ${failed[0].failed}`, error: true, retry: true };
  }
  if (waiting.length) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return { text: `${offline ? "📡 Hors ligne — " : "⏳ "}${waiting.length} saisie(s) gardée(s) sur le téléphone, envoi dès que possible.`, error: false, retry: !offline };
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { text: "📡 Hors ligne — tes saisies seront gardées sur le téléphone.", error: false, retry: false };
  }
  return null;
}

function renderBanner() {
  const el = document.getElementById("queue-banner");
  if (!el) return;
  const info = bannerText(readQueue());
  if (!info) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.className = `queue-banner${info.error ? " is-error" : ""}`;
  el.innerHTML = `<span>${info.text.replace(/</g, "&lt;")}</span>${info.retry ? `<button type="button" class="primary-button ghost small queue-retry">Réessayer</button>` : ""}`;
  const btn = el.querySelector(".queue-retry");
  if (btn) btn.addEventListener("click", () => { retryFailed(); });
}

/** À appeler une fois au démarrage : bandeau + renvoi au retour du réseau, au
 * retour sur l'app et au lancement. */
export function startQueueWatcher() {
  onQueueChange(renderBanner);
  window.addEventListener("online", () => { renderBanner(); flushQueue(); });
  window.addEventListener("offline", renderBanner);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushQueue(); });
  renderBanner();
  flushQueue();
}
