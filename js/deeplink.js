import { todayISO } from "./date-utils.js";

// ============================================================================
// Liens profonds (docs/adr/0120) : une notification ou un raccourci d'icône
// ouvre l'écran utile, pas l'accueil. Forme : `?go=<cible>[&date=ISO][&slot=second]`.
//   checkin → Aujourd'hui, carte du check-in
//   review  → Aujourd'hui, bilan de la semaine
//   match   → Aujourd'hui, fiche de ressenti du match
//   session → la séance du jour (ou de `date`) ; `slot=second` : la 2e séance
// ============================================================================

const SCROLL_TARGETS = { checkin: "checkin-content", review: "today-weekly-review", match: "today-match-feel" };

/** `{view, params, scrollTo}` pour une query string, ou `null` (lien inconnu/absent). */
export function parseDeepLink(search, today = todayISO()) {
  const q = new URLSearchParams(search || "");
  const go = q.get("go");
  if (!go) return null;
  if (SCROLL_TARGETS[go]) return { view: "today", params: {}, scrollTo: SCROLL_TARGETS[go] };
  if (go === "session") {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "") ? q.get("date") : today;
    return { view: "session", params: { date, focusSecondary: q.get("slot") === "second" }, scrollTo: null };
  }
  return null;
}

/** Fait défiler jusqu'à `id` dès que sa carte est rendue (elles se chargent en
 * asynchrone) ; abandonne au bout de 4 s si elle reste vide (rien à montrer). */
export function scrollWhenReady(id, tries = 27) {
  const el = document.getElementById(id);
  if (el && el.innerHTML.trim()) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  if (tries > 0) setTimeout(() => scrollWhenReady(id, tries - 1), 150);
}

/** Applique un lien profond ; retourne false s'il n'y en a pas. */
export function applyDeepLink(search, showView) {
  const link = parseDeepLink(search);
  if (!link) return false;
  showView(link.view, link.params);
  if (link.scrollTo) scrollWhenReady(link.scrollTo);
  return true;
}
