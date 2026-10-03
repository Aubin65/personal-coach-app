// Feuille modale basse, partagée par la fiche exercice et la saisie rapide
// du RPE : même fond, même fermeture (croix, tap hors de la feuille).
export function openSheet(innerHTML, { onClose } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><button type="button" class="sheet-close" aria-label="Fermer">✕</button>${innerHTML}</div>`;
  document.body.appendChild(overlay);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    if (onClose) onClose();
  };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".sheet-close").addEventListener("click", close);
  return { el: overlay.querySelector(".sheet"), close };
}
