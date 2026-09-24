import { ghGetFile, ghPutJSON, ghDispatchWorkflow } from "../github-api.js";
import { state, stale } from "../nav.js";
import { localISOWithOffset } from "../date-utils.js";

// ---- Chat ----
let chatPollTimer = null;

/** Appends a user turn to the shared chat log — used by the Coach tab and
 * by "Ajuster ma semaine" (prompts/app-chat.md routes planning requests to
 * prompts/weekly-plan.md, which writes a proposal to data/plans/pending/
 * for the app to show — see loadPendingProposal — rather than applying it
 * directly, see docs/adr/0018). Also dispatches app-chat.yml immediately
 * instead of waiting for its cron: GitHub only runs scheduled workflows
 * on a best-effort basis, and in practice this one fires every couple of
 * hours rather than every 5 minutes, which is why replies used to take so
 * long to show up. The cron stays as a fallback (see app-chat.yml) for
 * anything that reaches conversation.json some other way, so a dispatch
 * failure (e.g. token missing the Actions permission — same requirement
 * as "Nouveau digest", see docs/app-deploy.md) is swallowed rather than
 * blocking the send. */
export async function postUserMessage(text) {
  const result = await ghPutJSON(
    "data/app-chat/conversation.json",
    [],
    "App : nouveau message utilisateur",
    (conv) => [...conv, { role: "user", text, at: localISOWithOffset() }]
  );
  ghDispatchWorkflow("app-chat.yml").catch(() => {});
  return result;
}

export async function renderChat(token) {
  await refreshChatLog(token);
  const form = document.getElementById("chat-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    appendChatBubble(text, "user");
    try {
      await postUserMessage(text);
    } catch (err) {
      appendChatBubble(`Échec de l'envoi : ${err.message}`, "assistant");
    }
    startChatPolling();
  });
  startChatPolling();
  // stop polling when leaving the chat view
  const stop = () => { if (state.view !== "chat") clearInterval(chatPollTimer); else setTimeout(stop, 5000); };
  setTimeout(stop, 5000);
}

/** `.chat-log` itself never scrolls (no overflow/max-height set on it,
 * just natural flex-column growth) — the actual scrollable element is
 * `#content` (`flex:1; overflow-y:auto`, see style.css), shared by every
 * view. Scrolling `.chat-log` was a no-op; scroll `#content` instead so
 * opening the Coach tab lands on the latest message, not the top of a
 * long conversation (direct request). `behavior: "instant"` overrides
 * `#content`'s `scroll-behavior: smooth` (meant for in-page navigation,
 * e.g. jumping to a day in Historique) — an animated multi-second scroll
 * through a long conversation every time the tab opens would look
 * laggy rather than landing straight on the latest message. */
function scrollChatToBottom() {
  const content = document.getElementById("content");
  if (content) content.scrollTo({ top: content.scrollHeight, behavior: "instant" });
}

function appendChatBubble(text, role) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  const placeholder = log.querySelector(".muted");
  if (placeholder) placeholder.remove();
  const div = document.createElement("div");
  div.className = `chat-bubble ${role}`;
  div.textContent = text;
  log.appendChild(div);
  scrollChatToBottom();
}

async function refreshChatLog(token) {
  const file = await ghGetFile("data/app-chat/conversation.json");
  if (token != null && stale(token)) return;
  const log = document.getElementById("chat-log");
  if (!log) return;
  const conv = file ? JSON.parse(file.content) : [];
  log.innerHTML = conv.length
    ? ""
    : "<p class='muted small'>Pose une question au coach — récupération, nutrition, séance du jour, ce que tu veux. La réponse arrive en quelques minutes.</p>";
  for (const turn of conv) {
    const div = document.createElement("div");
    div.className = `chat-bubble ${turn.role}`;
    div.textContent = turn.text;
    log.appendChild(div);
  }
  scrollChatToBottom();
}

function startChatPolling() {
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(() => { if (state.view === "chat") refreshChatLog(); }, 15000);
}
