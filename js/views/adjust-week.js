import { showView } from "../nav.js";
import { setupMicButton } from "../voice-input.js";
import { postUserMessage } from "./chat.js";

// ---- Ajuster ma semaine ----
const ADJUST_SUGGESTIONS = [
  "Je suis fatigué, allège cette semaine",
  "J'ai un empêchement, décale une séance",
  "Reprogramme en tenant compte du prochain match",
];

export async function renderAdjustWeek() {
  setupMicButton(
    document.getElementById("adjust-mic"),
    document.getElementById("adjust-voice-hint"),
    document.getElementById("adjust-text"),
    document.getElementById("adjust-live-caption")
  );

  const chipsEl = document.getElementById("adjust-suggestions");
  chipsEl.innerHTML = ADJUST_SUGGESTIONS.map((s) => `<button type="button" class="suggestion-chip">${s}</button>`).join("");
  chipsEl.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const textEl = document.getElementById("adjust-text");
      textEl.value = chip.textContent;
      textEl.focus();
    });
  });

  document.getElementById("adjust-send").addEventListener("click", async (e) => {
    const textEl = document.getElementById("adjust-text");
    const statusEl = document.getElementById("adjust-status");
    const text = textEl.value.trim();
    if (!text) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    statusEl.textContent = "Envoi…";
    try {
      await postUserMessage(text);
      textEl.value = "";
      statusEl.innerHTML = "";
      const ok = document.createElement("span");
      ok.textContent = "Envoyé ✓ — le coach prépare une proposition (quelques minutes), à valider ensuite dans Semaine → Planning. ";
      const link = document.createElement("button");
      link.textContent = "Voir dans Coach →";
      link.className = "suggestion-chip";
      link.addEventListener("click", () => showView("chat"));
      statusEl.appendChild(ok);
      statusEl.appendChild(link);
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}
