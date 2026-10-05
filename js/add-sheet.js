import { openSheet } from "./sheet.js";
import { showView } from "./nav.js";
import { todayISO } from "./date-utils.js";

// Feuille du bouton « + » de la barre du bas (docs/adr/0071) : un seul point
// d'entrée pour toutes les saisies, qui étaient éparpillées entre la grille
// d'actions d'Aujourd'hui, le bandeau « Ajuster ma semaine » et l'onglet
// Coach. Chaque entrée ne fait que naviguer vers la vue existante — aucune
// logique de saisie n'est dupliquée ici.

const ICONS = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  session: '<svg viewBox="0 0 24 24"><path d="M6 8v8M18 8v8M3 10v4M21 10v4M6 12h12"/></svg>',
  pain: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10z"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  adjust: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
};

/** Ouvre la vue Aujourd'hui puis amène le check-in à l'écran une fois rendu
 * (rendu asynchrone : on attend que #checkin-content ait du contenu). */
function goToCheckin() {
  showView("today");
  const started = Date.now();
  const tick = () => {
    const el = document.getElementById("checkin-content");
    if (el && el.childElementCount > 0) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (Date.now() - started < 4000) setTimeout(tick, 120);
  };
  setTimeout(tick, 120);
}

export function openAddSheet() {
  const { el, close } = openSheet(`
    <h2>Ajouter</h2>
    <button type="button" class="add-sheet-voice" data-add="note">
      <span class="add-sheet-voice-icon">${ICONS.mic}</span>
      <span><strong>Note vocale</strong><small>Ressenti, feedback de séance ou de match, repas…</small></span>
    </button>
    <div class="add-sheet-grid">
      <button type="button" class="add-sheet-tile" data-add="session">
        <span class="add-sheet-ico gold">${ICONS.session}</span>
        <span><strong>Loguer la séance</strong><small>Celle d'aujourd'hui</small></span>
      </button>
      <button type="button" class="add-sheet-tile" data-add="pain">
        <span class="add-sheet-ico red">${ICONS.pain}</span>
        <span><strong>Douleur / gêne</strong><small>Zone, côté, niveau</small></span>
      </button>
      <button type="button" class="add-sheet-tile" data-add="checkin">
        <span class="add-sheet-ico green">${ICONS.sun}</span>
        <span><strong>Check-in</strong><small>Arrivée, bien-être</small></span>
      </button>
      <button type="button" class="add-sheet-tile" data-add="adjust">
        <span class="add-sheet-ico gold">${ICONS.adjust}</span>
        <span><strong>Ajuster ma semaine</strong><small>Le coach propose</small></span>
      </button>
    </div>
    <button type="button" class="add-sheet-row" data-add="chat">${ICONS.chat}Poser une question au coach</button>
  `);
  const actions = {
    note: () => showView("write-note"),
    session: () => showView("session", { date: todayISO() }),
    pain: () => showView("pain"),
    checkin: goToCheckin,
    adjust: () => showView("adjust-week"),
    chat: () => showView("chat"),
  };
  el.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      close();
      actions[btn.dataset.add]();
    });
  });
}
