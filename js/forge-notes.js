import { ghGetFile, ghPutJSON } from "./github-api.js";
import { addDaysISO, todayISO } from "./date-utils.js";
import { escapeHtmlText } from "./markdown.js";

// ============================================================================
// Consignes de la semaine pour le coach (docs/adr/0124) : une note libre par
// semaine dans la Forge (« match samedi, pas plus de 3 séances, focus
// jambes… »). Stockée dans data/config/forge-week-notes.json ({lundi: texte}) —
// lisible par le coach (squelette Forge, plan hebdo) — et recopiée dans la
// demande de squelette, qui reste ainsi complète même sans relire le fichier.
// ============================================================================

export const NOTES_PATH = "data/config/forge-week-notes.json";
export const MAX_NOTE_CHARS = 1500;
const KEEP_DAYS = 42;

async function readAll() {
  try {
    const file = await ghGetFile(NOTES_PATH);
    return (file && JSON.parse(file.content)) || {};
  } catch (_) { return {}; }
}

export async function loadWeekNote(monday) {
  const all = await readAll();
  return typeof all[monday] === "string" ? all[monday] : "";
}

/** Enregistre (ou efface, si vide) la note d'un lundi ; purge les semaines anciennes. */
export async function saveWeekNote(monday, text) {
  const clean = String(text || "").trim().slice(0, MAX_NOTE_CHARS);
  const oldest = addDaysISO(todayISO(), -KEEP_DAYS);
  await ghPutJSON(NOTES_PATH, {}, "App : consignes de la semaine pour le coach", (cur) => {
    const next = { ...(cur || {}) };
    if (clean) next[monday] = clean; else delete next[monday];
    for (const d of Object.keys(next)) if (d < oldest) delete next[d];
    return next;
  });
  return clean;
}

/** Texte ajouté à la demande de squelette (vide s'il n'y a pas de note). */
export function noteForRequest(note) {
  const clean = String(note || "").trim();
  return clean ? ` Consignes d'Aubin pour cette semaine, à respecter en priorité dans les limites des règles de sécurité : « ${clean} ».` : "";
}

/** Branche la zone de saisie : chargement pour `getMonday()`, enregistrement
 * automatique 1,2 s après la dernière frappe ou à la sortie du champ.
 * Retourne `{ load(monday), flush() }`. */
export function mountWeekNote(box, getMonday) {
  box.innerHTML = `<details class="forge-notes">
    <summary><strong>📝 Consignes pour le coach</strong> <span class="muted small forge-notes-flag"></span></summary>
    <textarea class="forge-notes-input" rows="3" maxlength="${MAX_NOTE_CHARS}" placeholder="Ex. : match samedi, 3 séances max, focus jambes, genou un peu sensible, pas de rameur…"></textarea>
    <p class="muted small forge-notes-status">Lu par le coach quand tu demandes un squelette. Une note par semaine.</p>
  </details>`;
  const details = box.querySelector("details");
  const input = box.querySelector("textarea");
  const status = box.querySelector(".forge-notes-status");
  const flag = box.querySelector(".forge-notes-flag");
  let loadedFor = null;
  let lastSaved = "";
  let timer = null;

  const showFlag = () => { flag.textContent = input.value.trim() ? "· renseignée" : ""; };
  async function flush() {
    clearTimeout(timer);
    const monday = loadedFor;
    if (!monday || input.value.trim() === lastSaved.trim()) return;
    status.textContent = "Enregistrement…";
    try {
      lastSaved = await saveWeekNote(monday, input.value);
      status.textContent = "Enregistré ✓ — lu par le coach à la prochaine demande.";
    } catch (err) {
      status.textContent = `Échec de l'enregistrement : ${escapeHtmlText(err.message)}`;
    }
  }
  input.addEventListener("input", () => { showFlag(); clearTimeout(timer); timer = setTimeout(flush, 1200); });
  input.addEventListener("blur", flush);

  return {
    async load(monday) {
      await flush(); // ne pas perdre une frappe de la semaine qu'on quitte
      loadedFor = null;
      input.disabled = true;
      const text = await loadWeekNote(monday);
      if (getMonday() !== monday) return; // on a déjà changé de semaine
      input.value = text; lastSaved = text; loadedFor = monday; input.disabled = false;
      details.open = !!text.trim();
      showFlag();
    },
    flush,
    value: () => input.value,
  };
}
