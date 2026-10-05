import { ghPutFile, ghGetFile, ghListDir, ghDeleteFile } from "../github-api.js";
import { state, stale } from "../nav.js";
import { localISOWithOffset } from "../date-utils.js";
import { skeletonHTML, escapeHtmlText } from "../markdown.js";
import { setupMicButton } from "../voice-input.js";
import { registerQueuedOp, runQueued } from "../offline-queue.js";

/** Crée le fichier de la note — rejouable par la file hors-ligne : si le
 * fichier existe déjà (premier envoi abouti, réponse perdue), rien à refaire. */
registerQueuedOp("note", async ({ iso, text }) => {
  const path = `data/notes/${iso}.md`;
  if (await ghGetFile(path)) return;
  await ghPutFile(path, `${iso}\n\n${text}`, `Note depuis l'app (${iso})`);
});

export async function renderWriteNote(token) {
  setupMicButton(
    document.getElementById("note-mic"),
    document.getElementById("note-voice-hint"),
    document.getElementById("note-text"),
    document.getElementById("note-live-caption")
  );
  document.getElementById("note-save").addEventListener("click", async () => {
    const textEl = document.getElementById("note-text");
    const statusEl = document.getElementById("note-status");
    const text = textEl.value.trim();
    if (!text) return;
    const iso = localISOWithOffset();
    statusEl.textContent = "Enregistrement…";
    try {
      const outcome = await runQueued("note", { iso, text }, { label: "Note vocale" });
      textEl.value = "";
      statusEl.textContent = outcome.queued ? "Gardée sur le téléphone — envoi dès que le réseau revient." : "Enregistrée ✓";
      if (!outcome.queued) loadRecentNotes(state.renderToken);
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    }
  });
  await loadRecentNotes(token);
}

async function loadRecentNotes(token, limit = 5) {
  const container = document.getElementById("recent-notes");
  container.innerHTML = skeletonHTML();
  const entries = (await ghListDir("data/notes")).filter((e) => e.type === "file" && e.name.endsWith(".md"));
  if (token != null && stale(token)) return;
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const recent = entries.slice(0, limit);
  if (recent.length === 0) { container.innerHTML = "<p class='muted small'>Pas encore de note.</p>"; return; }
  const files = await Promise.all(recent.map((e) => ghGetFile(e.path)));
  if (token != null && stale(token)) return;
  container.innerHTML = files
    .map((f, i) => {
      if (!f) return "";
      const lines = f.content.split("\n");
      const date = recent[i].name.slice(0, 10);
      const time = recent[i].name.slice(11, 16);
      const body = lines.slice(1).join("\n").trim();
      // Modifier / supprimer une note (docs/adr/0082) : le coach relit
      // data/notes/ à chaque digest, une note corrigée ou retirée ici l'est
      // aussi pour lui.
      return `<div class="note-item" data-path="${escapeHtmlText(recent[i].path)}" data-i="${i}">
        <div class="note-head"><span class="note-date">${date}${time && time.includes(":") ? ` · ${time}` : ""}</span>
          <span class="note-actions"><button type="button" class="note-edit">Modifier</button><button type="button" class="delete-link note-delete">Supprimer</button></span></div>
        <div class="note-body">${escapeHtmlText(body.length > 280 ? body.slice(0, 280) + "…" : body)}</div>
      </div>`;
    })
    .join("");
  container.querySelectorAll(".note-item").forEach((item) => {
    const file = files[parseInt(item.dataset.i, 10)];
    const path = item.dataset.path;
    item.querySelector(".note-delete").addEventListener("click", async (e) => {
      if (!window.confirm("Supprimer cette note ? Elle reste récupérable dans l'historique Git.")) return;
      e.currentTarget.disabled = true;
      try {
        const current = await ghGetFile(path);
        if (current) await ghDeleteFile(path, `Note supprimée depuis l'app (${path.slice(11, 21)})`, current.sha);
        item.remove();
      } catch (err) {
        e.currentTarget.disabled = false;
        window.alert(`Échec : ${err.message}`);
      }
    });
    item.querySelector(".note-edit").addEventListener("click", () => {
      const [header, ...rest] = file.content.split("\n");
      const text = rest.join("\n").trim();
      item.querySelector(".note-body").innerHTML = `<textarea rows="5" class="note-edit-text">${escapeHtmlText(text)}</textarea>
        <div class="note-edit-actions"><button type="button" class="primary-button small note-save">Enregistrer</button><button type="button" class="primary-button ghost small note-cancel">Annuler</button></div>`;
      item.querySelector(".note-cancel").addEventListener("click", () => loadRecentNotes(state.renderToken, limit));
      item.querySelector(".note-save").addEventListener("click", async (ev) => {
        const next = item.querySelector(".note-edit-text").value.trim();
        if (!next) return;
        ev.currentTarget.disabled = true;
        try {
          const current = await ghGetFile(path);
          await ghPutFile(path, `${header}\n\n${next}`, `Note modifiée depuis l'app (${path.slice(11, 21)})`, current ? current.sha : null);
          loadRecentNotes(state.renderToken, limit);
        } catch (err) {
          ev.currentTarget.disabled = false;
          window.alert(`Échec : ${err.message}`);
        }
      });
    });
  });
  if (entries.length > recent.length) {
    container.insertAdjacentHTML("beforeend", `<button class="details-toggle" id="notes-see-more">Voir plus (${entries.length - recent.length})</button>`);
    document.getElementById("notes-see-more").addEventListener("click", () => loadRecentNotes(state.renderToken, limit + 15));
  }
}
