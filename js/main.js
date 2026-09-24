import "./nav.js";
import { getToken, TOKEN_KEY, verifyToken } from "./github-api.js";
import { showView } from "./nav.js";
import { loadSyncStatus } from "./sync-status.js";
import { initPushButton } from "./push-notifications.js";

// ============================================================================
// Login
// ============================================================================
async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
    // A new service worker (shipped whenever CACHE_NAME bumps — see
    // service-worker.js) claims control of already-open tabs via
    // clients.claim(); reload once when that happens so an app left open
    // in the background picks up the new shell itself, instead of the
    // person having to manually close/reopen it.
    let reloadedForNewVersion = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForNewVersion) return;
      reloadedForNewVersion = true;
      window.location.reload();
    });
  }

  const loginScreen = document.getElementById("login-screen");
  const app = document.getElementById("app");

  const enterApp = () => {
    loginScreen.hidden = true;
    app.hidden = false;
    showView("today");
    loadSyncStatus();
    // Keeps the relative "il y a X min" text honest as time passes, and
    // picks up a newer sync without needing a manual refresh.
    setInterval(loadSyncStatus, 5 * 60 * 1000);
    initPushButton().catch(() => {});
  };

  if (getToken()) {
    enterApp();
    return;
  }

  document.getElementById("login-button").addEventListener("click", async () => {
    const input = document.getElementById("token-input");
    const errorEl = document.getElementById("login-error");
    const token = input.value.trim();
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    errorEl.hidden = true;
    const button = document.getElementById("login-button");
    button.disabled = true;
    button.textContent = "Vérification…";
    const ok = await verifyToken().catch(() => false);
    button.disabled = false;
    button.textContent = "Se connecter";
    if (!ok) {
      localStorage.removeItem(TOKEN_KEY);
      errorEl.textContent = "Token invalide, ou sans accès en écriture à ce repo.";
      errorEl.hidden = false;
      return;
    }
    enterApp();
  });
}

init();
