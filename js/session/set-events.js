import { runQueued } from "../offline-queue.js";
import { localISOWithOffset } from "../date-utils.js";

// ============================================================================
// Ressenti rattaché à une série (docs/adr/0100) — douleur, imprévu extérieur
// ou simple note, saisi depuis le « + » de la séance guidée. Stocké sur
// l'exercice : `ex.set_events = [{set, kind, zone?, level?, tags?, note?, at}]`
// (`set` = numéro de série, à partir de 1 ; `at` = horodatage ISO, clé stable).
//
// Une douleur est aussi écrite dans le suivi de douleur du jour
// (`data/checkin/<date>.json` → `pain`, même op hors-ligne que l'onglet
// Douleur) avec le même `at` : les alertes, l'historique et le coach la voient
// sans double saisie, et la supprimer ici la retire aussi de là-bas.
// ============================================================================

export const EVENT_KINDS = [
  { id: "douleur", label: "Douleur / gêne" },
  { id: "exterieur", label: "Imprévu extérieur" },
  { id: "ressenti", label: "Ressenti" },
];
export const EXTERNAL_TAGS = ["Interruption", "Matériel / barre", "Chaleur", "Fatigue du jour", "Mal dormi", "Stress", "Distraction", "Contact / choc"];

export function setEventsOf(ex, setNo) {
  return (ex.set_events || []).filter((e) => e.set === setNo);
}

/** Texte lisible d'un événement (zones : id → libellé, depuis summary.json). */
export function describeEvent(ev, zones = {}) {
  if (ev.kind === "douleur") {
    const zone = zones[ev.zone] || (ev.zone || "douleur").replace(/_/g, " ");
    return `${zone}${ev.level != null ? ` ${ev.level}/10` : ""}${ev.note ? ` — ${ev.note}` : ""}`;
  }
  const parts = [...(ev.tags || []), ev.note].filter(Boolean);
  return parts.join(" — ") || (EVENT_KINDS.find((k) => k.id === ev.kind) || {}).label || "";
}

/** Liste des ressentis d'un exercice dans le formulaire (lecture + suppression). */
export function setEventsListHTML(ex, escape) {
  const events = [...(ex.set_events || [])].sort((a, b) => a.set - b.set);
  if (!events.length) return "";
  return `<ul class="set-events">${events.map((e) => `<li><span class="live-event-kind">Série ${e.set} · ${escape(eventKindLabel(e.kind))}</span><span>${escape(describeEvent(e))}</span><button type="button" class="icon-button small danger remove-set-event" data-at="${escape(e.at)}" title="Retirer ce ressenti" aria-label="Retirer ce ressenti">✕</button></li>`).join("")}</ul>`;
}

export function eventKindLabel(kind) {
  return (EVENT_KINDS.find((k) => k.id === kind) || {}).label || kind;
}

/** Ajoute l'événement au modèle ; une douleur avec zone + niveau part aussi
 * dans le suivi de douleur du jour (jamais bloquant : file hors-ligne). */
export function addSetEvent(ex, draft, { date, now = localISOWithOffset() } = {}) {
  const ev = { set: draft.set, kind: draft.kind, at: now };
  if (draft.kind === "douleur") {
    ev.zone = draft.zone;
    ev.level = draft.level;
  }
  if (draft.kind === "exterieur" && draft.tags && draft.tags.length) ev.tags = [...draft.tags];
  const note = (draft.note || "").trim();
  if (note) ev.note = note;
  ex.set_events = [...(ex.set_events || []), ev];
  if (ev.kind === "douleur" && ev.zone && ev.level != null) {
    const context = `${ex.name || "exercice"}, série ${ev.set}`;
    const entry = { zone: ev.zone, level: ev.level, note: ev.note ? `${context} — ${ev.note}` : context, at: ev.at };
    runQueued("pain", { date, entry }, { label: "Douleur" }).catch(() => {});
  }
  return ev;
}

export function removeSetEvent(ex, at, { date } = {}) {
  const ev = (ex.set_events || []).find((e) => e.at === at);
  if (!ev) return;
  ex.set_events = ex.set_events.filter((e) => e.at !== at);
  if (!ex.set_events.length) delete ex.set_events;
  if (ev.kind === "douleur" && date) runQueued("painDelete", { date, at }, { label: "Douleur" }).catch(() => {});
}

/** Une série supprimée : ses événements sont détachés (une douleur reste dans
 * le suivi de douleur), les séries suivantes sont renumérotées. */
export function shiftEventsAfterDelete(ex, deletedSetNo) {
  if (!ex.set_events) return;
  ex.set_events = ex.set_events
    .filter((e) => e.set !== deletedSetNo)
    .map((e) => (e.set > deletedSetNo ? { ...e, set: e.set - 1 } : e));
  if (!ex.set_events.length) delete ex.set_events;
}
