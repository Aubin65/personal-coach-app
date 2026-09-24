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
  const res = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  return res;
}

/** {content, sha} for a file, or null if it doesn't exist (404). Throws on
 * any other error (bad token, rate limit, etc.) so callers can surface it. */
export async function ghGetFile(path) {
  const res = await ghRequest(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} en lisant ${path}`);
  const data = await res.json();
  return { content: b64DecodeUtf8(data.content), sha: data.sha };
}

/** Directory entries [{name, path, type}], or [] if the directory doesn't
 * exist yet. */
export async function ghListDir(path) {
  const res = await ghRequest(path);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status} en listant ${path}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
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
