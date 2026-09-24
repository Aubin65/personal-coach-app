import { ghPutFile, ghGetFile, ghListDir } from "../github-api.js";
import { state, stale } from "../nav.js";
import { localISOWithOffset } from "../date-utils.js";
import { skeletonHTML, escapeHtmlText } from "../markdown.js";
import { setupMicButton } from "../voice-input.js";

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
      await ghPutFile(`data/notes/${iso}.md`, `${iso}\n\n${text}`, `Note depuis l'app (${iso})`);
      textEl.value = "";
      statusEl.textContent = "Enregistrée ✓";
      loadRecentNotes(state.renderToken);
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
      const body = lines.slice(1).join(" ").trim();
      return `<div class="note-item"><div class="note-date">${date}</div>${escapeHtmlText(body.slice(0, 200))}</div>`;
    })
    .join("");
  if (entries.length > recent.length) {
    container.insertAdjacentHTML("beforeend", `<button class="details-toggle" id="notes-see-more">Voir plus (${entries.length - recent.length})</button>`);
    document.getElementById("notes-see-more").addEventListener("click", () => loadRecentNotes(state.renderToken, limit + 15));
  }
}
