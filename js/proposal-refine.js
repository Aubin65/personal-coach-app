import { state } from "./nav.js";
import { ghGetFile } from "./github-api.js";
import { escapeHtmlText } from "./markdown.js";
import { setupMicButton } from "./voice-input.js";
import { postUserMessage, dispatchStatusNote } from "./views/chat.js";
import { keepDraft, dropDraft } from "./text-drafts.js";

// ============================================================================
// Encart "Adapter la proposition" (docs/adr/0069) — sous chaque proposition
// du coach (squelette Forge, planning de semaine, ajustement de séance), une
// zone de texte/dictée pour demander une retouche en langage naturel au lieu
// de tout refuser. Passe par le chat habituel avec un préfixe
// `[Affiner <type> <date>]` que prompts/app-chat.md route vers le bon
// prompt en "mode révision" : il part de la proposition en attente, pas d'une
// page blanche, et réécrit le même fichier — la proposition reste à valider.
// ============================================================================

const POLL_INTERVAL_MS = 10000;
const POLL_MAX_TICKS = 60;

let pollTimer = null;
let pendingNote = "";

export function refineBoxHTML(placeholder) {
  return `
    <div class="refine-box">
      <p class="small refine-title">✍️ Pas tout à fait ça ? Dis ce que tu veux changer</p>
      <div class="compose-row">
        <textarea class="refine-input" rows="2" placeholder="${escapeHtmlText(placeholder)}"></textarea>
        <button type="button" class="mic-button refine-mic" title="Dicter" aria-label="Dicter"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
      </div>
      <p class="voice-hint refine-voice-hint" hidden></p>
      <p class="live-caption refine-live-caption" hidden></p>
      <button type="button" class="primary-button small refine-send">✏️ Adapter la proposition</button>
      <p class="muted small refine-status"></p>
    </div>`;
}

async function readConversation() {
  const file = await ghGetFile("data/app-chat/conversation.json");
  if (!file) return [];
  try {
    const conv = JSON.parse(file.content);
    return Array.isArray(conv) ? conv : [];
  } catch (_) {
    return [];
  }
}

/** Dernier tour utilisateur commençant par `prefix` et la réponse du coach
 * qui le suit, s'il y en a une — `{ asked: false }` sans demande de ce
 * type, `{ asked: true, reply: null }` tant qu'elle attend une réponse. */
function refineThreadState(conversation, prefix) {
  let askedIdx = -1;
  conversation.forEach((turn, i) => {
    if (turn.role === "user" && (turn.text || "").startsWith(prefix)) askedIdx = i;
  });
  if (askedIdx === -1) return { asked: false, reply: null };
  const reply = conversation.slice(askedIdx + 1).find((t) => t.role === "assistant") || null;
  return { asked: true, reply };
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/** Attend la réponse du coach à la demande d'adaptation : dès qu'elle est
 * là, soit la proposition a changé (re-rendu via `onUpdated`), soit le coach
 * a seulement répondu par message (affiché tel quel, ex. "ce n'est pas
 * possible parce que..."). S'arrête en quittant l'onglet. */
function pollForAnswer({ prefix, pendingPath, initialSha, view, onUpdated, statusEl, sendBtn }) {
  stopPolling();
  let ticks = 0;
  pollTimer = setInterval(async () => {
    ticks += 1;
    if (state.view !== view || ticks > POLL_MAX_TICKS) { stopPolling(); return; }
    try {
      const thread = refineThreadState(await readConversation(), prefix);
      if (!thread.asked || !thread.reply) return;
      stopPolling();
      const file = await ghGetFile(pendingPath);
      if (!file || file.sha !== initialSha) {
        pendingNote = "Proposition mise à jour ✓";
        onUpdated();
        return;
      }
      if (statusEl) statusEl.textContent = `Coach : ${thread.reply.text}`;
      if (sendBtn) sendBtn.disabled = false;
    } catch (_) {
      // erreur réseau ponctuelle : le prochain tick réessaie
    }
  }, POLL_INTERVAL_MS);
}

/** Branche l'encart rendu par `refineBoxHTML` dans `scope`. `prefix` est le
 * signal de routage (ex. "[Affiner Forge 2026-10-05]") ; `pendingPath` le
 * fichier de la proposition en attente, dont le sha sert à détecter la
 * réécriture ; `view` l'onglet courant (arrête l'attente en le quittant) ;
 * `onUpdated` recharge la carte une fois la proposition retouchée. */
export async function wireRefineBox(scope, { prefix, pendingPath, pendingSha, view, onUpdated }) {
  const box = scope.querySelector(".refine-box");
  if (!box) return;
  const input = box.querySelector(".refine-input");
  keepDraft(input, `refine:${prefix}`);
  const sendBtn = box.querySelector(".refine-send");
  const statusEl = box.querySelector(".refine-status");

  setupMicButton(box.querySelector(".refine-mic"), box.querySelector(".refine-voice-hint"), input, box.querySelector(".refine-live-caption"));

  if (pendingNote) { statusEl.textContent = pendingNote; pendingNote = ""; }

  const startWaiting = () => {
    sendBtn.disabled = true;
    pollForAnswer({ prefix, pendingPath, initialSha: pendingSha, view, onUpdated, statusEl, sendBtn });
  };

  sendBtn.addEventListener("click", async () => {
    const instruction = input.value.trim();
    if (!instruction) { statusEl.textContent = "Écris d'abord ce que tu veux changer."; return; }
    sendBtn.disabled = true;
    statusEl.textContent = "Envoi…";
    try {
      const dispatch = await postUserMessage(`${prefix} ${instruction}`);
      input.value = "";
      dropDraft(`refine:${prefix}`);
      statusEl.textContent = `Demande envoyée ✓ — la proposition sera mise à jour ici dans quelques minutes.${dispatchStatusNote(dispatch)}`;
      startWaiting();
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      sendBtn.disabled = false;
    }
  });

  // Une demande déjà envoyée avant un rechargement/changement d'onglet et
  // pas encore traitée : pas de second envoi, on reprend l'attente.
  try {
    const thread = refineThreadState(await readConversation(), prefix);
    if (thread.asked && !thread.reply) {
      statusEl.textContent = "Adaptation en cours de préparation par le coach…";
      startWaiting();
    }
  } catch (_) {}
}
