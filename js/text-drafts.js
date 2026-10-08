// ---------- Brouillons des zones de texte (ADR-0103) ----------
// « Adapter la proposition », « Cette séance ne convient pas ? », « Ajuster
// ma semaine », message au coach… : ce qu'on y écrit survit à un changement
// d'onglet ou à un rechargement tant que ce n'est pas envoyé.
const PREFIX = "coach_text_draft_";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function read(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return "";
    const d = JSON.parse(raw);
    if (!d || Date.now() - d.at > MAX_AGE_MS) { localStorage.removeItem(PREFIX + key); return ""; }
    return d.text || "";
  } catch (_) { return ""; }
}

/** Restaure le brouillon `key` dans `el` (s'il est vide) et l'écrit à chaque
 * frappe. Retourne `true` si un brouillon a été restauré. */
export function keepDraft(el, key) {
  if (!el || el.dataset.keepDraft === key) return false;
  el.dataset.keepDraft = key;
  let restored = false;
  const saved = read(key);
  if (saved && !el.value) { el.value = saved; restored = true; }
  el.addEventListener("input", () => {
    try {
      if (el.value.trim()) localStorage.setItem(PREFIX + key, JSON.stringify({ text: el.value, at: Date.now() }));
      else localStorage.removeItem(PREFIX + key);
    } catch (_) { /* confort seulement */ }
  });
  return restored;
}

/** À appeler une fois le texte envoyé. */
export function dropDraft(key) {
  try { localStorage.removeItem(PREFIX + key); } catch (_) { /* rien à nettoyer */ }
}
