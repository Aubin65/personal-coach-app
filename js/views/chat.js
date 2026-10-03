import { ghGetFile, ghPutJSON, ghDispatchWorkflow } from "../github-api.js";
import { state, stale } from "../nav.js";
import { localISOWithOffset } from "../date-utils.js";
import { registerQueuedOp, runQueued } from "../offline-queue.js";

// ---- Chat ----
let chatPollTimer = null;

registerQueuedOp("chatMessage", async ({ text, at }) => {
  await ghPutJSON(
    "data/app-chat/conversation.json",
    [],
    "App : nouveau message utilisateur",
    // `at` sert de clé : jamais deux fois le même tour si un premier envoi
    // avait abouti sans que la réponse revienne (file hors-ligne).
    (conv) => (conv.some((turn) => turn.role === "user" && turn.at === at && turn.text === text) ? conv : [...conv, { role: "user", text, at }])
  );
  try {
    await ghDispatchWorkflow("app-chat.yml");
    return { dispatched: true };
  } catch (err) {
    return { dispatched: false, dispatchError: err.message };
  }
});

/** Appends a user turn to the shared chat log — used by the Coach tab and
 * by "Ajuster ma semaine" (prompts/app-chat.md routes planning requests to
 * prompts/weekly-plan.md, which writes a proposal to data/plans/pending/
 * for the app to show — see loadPendingProposal — rather than applying it
 * directly, see docs/adr/0018). Also dispatches app-chat.yml immediately
 * instead of waiting for its cron: GitHub only runs scheduled workflows
 * on a best-effort basis, and in practice this one fires every couple of
 * hours (sometimes longer) rather than every 15 minutes, which is why
 * replies used to take so long to show up. The cron stays as a fallback
 * (see app-chat.yml) for anything that reaches conversation.json some
 * other way, so a dispatch failure (e.g. token missing the Actions
 * permission — same requirement as "Nouveau digest", see
 * docs/app-deploy.md) never blocks the send — but it used to be swallowed
 * entirely (`.catch(() => {})`), silently, with the same "quelques
 * minutes" message shown regardless. A real incident (dispatch broken/
 * unused for 3+ days straight — no workflow_dispatch-triggered app-chat
 * run at all between 2026-09-25 and 2026-09-28 despite several messages
 * sent in between, each one waiting hours on the cron instead) showed
 * that silence is indistinguishable from "your message is on its way" —
 * the user has no way to tell a message got stuck. Surface it via the
 * return value instead, so every caller can show an accurate status. */
export async function postUserMessage(text) {
  const outcome = await runQueued("chatMessage", { text, at: localISOWithOffset() }, { label: "Message au coach" });
  if (outcome.queued) return { dispatched: false, queued: true };
  return outcome.result;
}

/** Suffix for a "message sent" status line — call after `postUserMessage`
 * to say plainly when the instant path failed instead of always claiming
 * "quelques minutes" (see postUserMessage's doc comment). */
export function dispatchStatusNote({ dispatched, dispatchError, queued }) {
  if (queued) return " 📡 Hors ligne : message gardé sur le téléphone, envoyé au retour du réseau.";
  if (dispatched) return "";
  return ` ⚠️ Déclenchement immédiat indisponible (${dispatchError || "erreur inconnue"}) — la réponse passera par le cycle automatique, ça peut prendre plusieurs heures. Si ça persiste, vérifie la permission Actions du token (docs/app-deploy.md).`;
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
      const dispatch = await postUserMessage(text);
      showChatStatus(dispatch.dispatched
        ? "Réponse en cours de préparation…"
        : `Message envoyé.${dispatchStatusNote(dispatch)}`);
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

/** Status line below the composer (#chat-status) — separate from
 * `.chat-log` so it survives independently of `refreshChatLog`'s full
 * rebuild of the log every poll (15s). Cleared automatically as soon as
 * an actual reply lands (see refreshChatLog below), never left stale. */
function showChatStatus(text) {
  const el = document.getElementById("chat-status");
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
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
  // A reply landed (or there was never anything pending) — whatever the
  // composer's status line said ("en cours de préparation", a dispatch
  // warning…) no longer applies.
  if (!conv.length || conv[conv.length - 1].role === "assistant") showChatStatus("");
  scrollChatToBottom();
}

function startChatPolling() {
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(() => { if (state.view === "chat") refreshChatLog(); }, 15000);
}
