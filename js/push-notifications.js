import { ghPutJSON, ghGetFile, ghDeleteFile } from "./github-api.js";

// ============================================================================
// Notifications push (Web Push, VAPID) — replaces the Telegram bot as the
// "ping me même quand je ne suis pas dans l'app" channel (see docs/adr/0025). This
// public key has nothing to protect (only the matching private key, held
// server-side as a GitHub Actions secret, can actually sign a push) — safe
// to ship in the client.
// ============================================================================
const VAPID_PUBLIC_KEY = "BLFn9QoifLmwUBlO7AXZmG8A0qFTZUUZKdYr6apkpSw82iE6NFRapZ-HQ7dn9DpYi8MC7ju_VUyM96FyCyTxlh0";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function setPushButtonState(button, subscribed) {
  button.classList.toggle("is-active", subscribed);
  button.title = subscribed ? "Notifications activées (appuyer pour désactiver)" : "Activer les notifications";
  button.setAttribute("aria-label", button.title);
}

async function subscribeToPush(button) {
  if (Notification.permission === "denied") {
    alert("Notifications bloquées pour cette app — active-les dans Réglages iOS puis réessaie.");
    return;
  }
  button.disabled = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    await ghPutJSON("data/app/push-subscription.json", null, "App : abonnement notifications activé", () => subscription.toJSON());
    setPushButtonState(button, true);
  } catch (err) {
    alert(`Impossible d'activer les notifications : ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

async function unsubscribeFromPush(button) {
  button.disabled = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    const current = await ghGetFile("data/app/push-subscription.json");
    if (current) await ghDeleteFile("data/app/push-subscription.json", "App : abonnement notifications désactivé", current.sha);
    setPushButtonState(button, false);
  } catch (err) {
    alert(`Impossible de désactiver les notifications : ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

/** Hides the bell entirely when Push isn't supported (no service worker,
 * or Safari on an iOS old enough to lack Web Push — 16.4+ required, and
 * only once the app is installed to the home screen) rather than showing a
 * button that would just fail on tap. */
export async function initPushButton() {
  const button = document.getElementById("push-subscribe-button");
  if (!button) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  setPushButtonState(button, !!existing);
  button.addEventListener("click", async () => {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await unsubscribeFromPush(button);
    } else {
      await subscribeToPush(button);
    }
  });
}
