// ============================================================================
// Icônes de type de séance (docs/adr/0082) — une icône au trait par genre de
// journée, dans une pastille teintée, pour distinguer d'un coup d'œil la muscu,
// le rugby, le match, une autre activité et le repos (liste Semaine, carte
// séance d'Aujourd'hui). Même grammaire que le reste de l'app : traits 2 px,
// `currentColor`, aucune couleur codée ici (tout vient de `.kind-icon.k-*`).
// ============================================================================

const PATHS = {
  // haltère
  musculation: '<path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>',
  // ballon ovale et ses coutures
  rugby: '<ellipse cx="12" cy="12" rx="9.5" ry="5.6" transform="rotate(-40 12 12)"/><path d="M8.6 15.4l6.8-6.8M10.3 11.6l2.1 2.1M12.3 9.6l2.1 2.1"/>',
  // poteaux (même motif que l'icône de l'app)
  match: '<path d="M7 3.5v17M17 3.5v17M7 12.5h10"/><circle cx="12" cy="7.5" r="1.6"/>',
  // tracé d'effort (course, rando, vélo…)
  autre: '<path d="M3 12.5h4l2.6-7 4.8 13 2.6-6H21"/>',
  // lune
  repos: '<path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z"/>',
};

/** `kind` : musculation | rugby | match | autre | repos (défaut : musculation). */
export function kindIconHTML(kind, extraClass = "") {
  const k = PATHS[kind] ? kind : "musculation";
  return `<span class="kind-icon k-${k}${extraClass ? ` ${extraClass}` : ""}" aria-hidden="true"><svg viewBox="0 0 24 24">${PATHS[k]}</svg></span>`;
}
