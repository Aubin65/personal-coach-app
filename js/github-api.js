// ============================================================================
// Config
// ============================================================================
export const REPO = "Aubin65/personal_coach";
export const API = "https://api.github.com";
export const TOKEN_KEY = "coach_gh_token";

// ============================================================================
// GitHub Contents API — thin client. Every read/write in this app goes
// through here, straight to the browser (CORS-enabled on api.github.com —
// verified), no backend of any kind. Same trust model as the existing iOS
// Shortcuts (docs/adr/0005): a single-repo, contents-scoped fine-grained
// PAT, kept only in this device's localStorage.
// ============================================================================

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function b64DecodeUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function ghRequest(path, options = {}) {
  // Lecture toujours revalidée (ETag, 304 gratuit) : l'API GitHub autorise
  // 60 s de cache navigateur, assez pour relire un contenu et un `sha`
  // périmés juste après une écriture — d'où des 409 et un écran qui ne
  // reflète pas la saisie qu'on vient de faire (ADR-0082).
  const isRead = !options.method || options.method === "GET";
  const res = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    ...(isRead ? { cache: "no-cache" } : {}),
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  return res;
}

/** Vrai pour un échec réseau (hors-ligne, réception coupée) et faux pour une
 * réponse HTTP d'erreur de GitHub — `fetch` rejette alors avec un
 * `TypeError`, alors que les erreurs HTTP sont levées ici en `Error`. La
 * file d'attente hors-ligne (offline-queue.js) ne retient que les premiers. */
export function isNetworkError(err) {
  return err instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false);
}

// Dernière lecture réussie de chaque fichier/dossier, gardée dans le
// navigateur (Cache Storage) et resservie quand le réseau manque : sans ça,
// ouvrir une séance dans une salle sans réception échouait dès le chargement.
// Le nom commence par "coach-data" pour survivre au nettoyage des anciens
// caches du service worker (service-worker.js).
const READ_CACHE_NAME = "coach-data-v1";
const READ_CACHE_MAX_BYTES = 1500000;

async function readCachePut(path, value) {
  try {
    const body = JSON.stringify(value);
    if (body.length > READ_CACHE_MAX_BYTES) return;
    const cache = await caches.open(READ_CACHE_NAME);
    await cache.put(`https://cache.local/${path}`, new Response(body));
  } catch (_) { /* Cache Storage indisponible : le cache n'est qu'un filet */ }
}

async function readCacheGet(path) {
  try {
    const cache = await caches.open(READ_CACHE_NAME);
    const hit = await cache.match(`https://cache.local/${path}`);
    return hit ? await hit.json() : undefined;
  } catch (_) {
    return undefined;
  }
}

/** {content, sha} for a file, or null if it doesn't exist (404). Throws on
 * any other error (bad token, rate limit, etc.) so callers can surface it.
 * Hors-ligne, resservi depuis la dernière lecture réussie s'il y en a une. */
export async function ghGetFile(path) {
  let res;
  try {
    res = await ghRequest(path);
  } catch (err) {
    if (isNetworkError(err)) {
      const cached = await readCacheGet(path);
      if (cached !== undefined) return cached;
    }
    throw err;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} en lisant ${path}`);
  const data = await res.json();
  const file = { content: b64DecodeUtf8(data.content), sha: data.sha };
  readCachePut(path, file);
  return file;
}

/** Directory entries [{name, path, type}], or [] if the directory doesn't
 * exist yet. Même repli hors-ligne que `ghGetFile`. */
export async function ghListDir(path) {
  let res;
  try {
    res = await ghRequest(path);
  } catch (err) {
    if (isNetworkError(err)) {
      const cached = await readCacheGet(`${path}/`);
      if (cached !== undefined) return cached;
    }
    throw err;
  }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status} en listant ${path}`);
  const data = await res.json();
  const entries = Array.isArray(data) ? data : [];
  readCachePut(`${path}/`, entries);
  return entries;
}

/** Create or update a file. Retries once on a 409 (sha changed between our
 * read and this write — refetches the current sha and retries) since the
 * async coach-chat workflow can write concurrently. */
export async function ghPutFile(path, content, message, sha = null, retry = true) {
  const res = await ghRequest(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: b64EncodeUtf8(content),
      sha: sha || undefined,
    }),
  });
  if (res.status === 409 && retry) {
    const current = await ghGetFile(path);
    return ghPutFile(path, content, message, current ? current.sha : null, false);
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} en écrivant ${path}`);
  return res.json();
}

/** Deletes a file via the GitHub Contents API (needs the file's current
 * sha) — used to clear a validated/rejected plan proposal in
 * data/plans/pending/. */
export async function ghDeleteFile(path, message, sha) {
  const res = await ghRequest(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} en supprimant ${path}`);
}

/** Read-modify-write helper for a JSON file: `mutate(currentValueOrDefault)`
 * returns the new value to write. */
export async function ghPutJSON(path, defaultValue, message, mutate) {
  const current = await ghGetFile(path);
  const currentValue = current ? JSON.parse(current.content) : defaultValue;
  const next = mutate(currentValue);
  await ghPutFile(path, JSON.stringify(next, null, 2), message, current ? current.sha : null);
  return next;
}

export async function verifyToken() {
  const res = await fetch(`${API}/repos/${REPO}`, {
    headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return false;
  const data = await res.json();
  return !!(data.permissions && data.permissions.push);
}

/** Triggers a GitHub Actions workflow_dispatch — used by the "Nouveau
 * digest" button so a fresh digest can be regenerated on demand instead of
 * only waiting for the 8h30 cron. Needs the token to also carry an
 * Actions: Read and write permission (Contents alone isn't enough for
 * this one call) — see docs/app-deploy.md and docs/adr/0018. */
export async function ghDispatchWorkflow(fileName, ref = "main") {
  try {
    await dispatchWorkflowRaw(fileName, ref);
    recordDispatch({ ok: true, workflow: fileName });
  } catch (err) {
    recordDispatch({ ok: false, workflow: fileName, error: err.message });
    throw err;
  }
}

const DISPATCH_LOG_KEY = "coach_last_dispatch";

function recordDispatch(entry) {
  try { localStorage.setItem(DISPATCH_LOG_KEY, JSON.stringify({ ...entry, at: new Date().toISOString() })); } catch (_) {}
}

/** Résultat du dernier déclenchement de workflow depuis cet appareil
 * (`{ok, workflow, at, error?}`), ou `null` — alimente "État du système" :
 * seul moyen fiable de savoir si le token a la permission Actions en
 * écriture sans déclencher un workflow pour rien. */
export function lastDispatchResult() {
  try { return JSON.parse(localStorage.getItem(DISPATCH_LOG_KEY)); } catch (_) { return null; }
}

async function dispatchWorkflowRaw(fileName, ref) {
  const res = await fetch(`${API}/repos/${REPO}/actions/workflows/${fileName}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref }),
  });
  if (!res.ok) {
    // GitHub's own message (e.g. "Resource not accessible by personal
    // access token", "Not Found") is always more precise than a guess —
    // a 403/404 here doesn't *only* mean "missing Actions permission"
    // (previously the only diagnosis shown, even when the real cause was
    // something else entirely, e.g. an expired token or a typo'd workflow
    // filename) — surfacing it lets a genuinely different cause actually
    // be seen instead of always pointing at the same likely-but-not-
    // certain explanation.
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch (_) { /* body not JSON */ }
    if (res.status === 401) {
      throw new Error(`Token invalide ou expiré (401)${detail ? ` — ${detail}` : ""}.`);
    }
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `Le token n'a probablement pas la permission Actions (HTTP ${res.status}${detail ? ` — ${detail}` : ""}) — voir docs/app-deploy.md. ` +
        "Si tu l'as déjà ajoutée : vérifie que c'est bien sur ce token précis (pas sur APP_REPO_TOKEN, un secret différent) et laisse quelques minutes — GitHub met parfois du temps à propager un changement de permission sur un token existant."
      );
    }
    throw new Error(`GitHub ${res.status} en déclenchant ${fileName}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Derniers commits qui ont touché `path` — `[{date, message}]`, du plus
 * récent au plus ancien (vide sur erreur ou hors-ligne, jamais bloquant).
 * Sert à « Données du jour » (docs/adr/0075) : l'heure d'arrivée réelle d'un
 * fichier de données, que l'API contents ne donne pas. */
export async function ghRecentCommits(path, perPage = 10) {
  try {
    const res = await fetch(`${API}/repos/${REPO}/commits?path=${encodeURIComponent(path)}&per_page=${perPage}`, {
      headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        const c = item && item.commit;
        if (!c) return null;
        return { date: (c.committer && c.committer.date) || (c.author && c.author.date) || null, message: c.message || "" };
      })
      .filter((x) => x && x.date);
  } catch (_) {
    return [];
  }
}
