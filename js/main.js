import "./nav.js";
import { getToken, TOKEN_KEY, verifyToken } from "./github-api.js";
import { showView } from "./nav.js";
import { loadSyncStatus } from "./sync-status.js";
import { initPushButton } from "./push-notifications.js";
import { startQueueWatcher } from "./offline-queue.js";
import { startSummaryWatch } from "./summary-watch.js";
import { sessionRuntime } from "./session/session-state.js";
import { applyTheme } from "./theme.js";
import { applyDeepLink } from "./deeplink.js";
import { clearStatus } from "./lockscreen.js";

applyTheme();

// ============================================================================
// Login
// ============================================================================
async function init() {
  if ("serviceWorker" in navigator) {
    // updateViaCache "none" : le navigateur revérifie service-worker.js sans
    // passer par le cache HTTP. Et une PWA iOS reprise depuis l'arrière-plan
    // ne renavigue pas, donc ne cherche jamais de mise à jour d'elle-même :
    // on la demande à chaque retour au premier plan (ADR-0082).
    navigator.serviceWorker.register("service-worker.js", { updateViaCache: "none" })
      .then((reg) => {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      })
      .catch(() => {});
    // A new service worker (shipped whenever CACHE_NAME bumps — see
    // service-worker.js) claims control of already-open tabs via
    // clients.claim(); reload once when that happens so an app left open
    // in the background picks up the new shell itself, instead of the
    // person having to manually close/reopen it.
    // Notification touchée alors que l'app est déjà ouverte : le service worker
    // nous passe le lien. Jamais en pleine séance (saisie en mémoire).
    navigator.serviceWorker.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type !== "deeplink" || sessionRuntime.working) return;
      applyDeepLink(new URL(msg.url, window.location.href).search, showView);
    });
    let reloadedForNewVersion = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForNewVersion) return;
      // Jamais en pleine séance : la saisie en cours vit en mémoire. La
      // nouvelle version s'appliquera au prochain lancement.
      if (sessionRuntime.working) return;
      reloadedForNewVersion = true;
      window.location.reload();
    });
  }

  const loginScreen = document.getElementById("login-screen");
  const app = document.getElementById("app");

  const enterApp = () => {
    loginScreen.hidden = true;
    app.hidden = false;
    // Lien profond (notification, raccourci d'icône) : ouvre l'écran visé ; la
    // query est ensuite retirée pour qu'un rechargement revienne à l'accueil.
    if (!applyDeepLink(window.location.search, showView)) showView("today");
    if (window.location.search) history.replaceState(null, "", window.location.pathname);
    loadSyncStatus();
    // Keeps the relative "il y a X min" text honest as time passes, and
    // picks up a newer sync without needing a manual refresh.
    setInterval(loadSyncStatus, 5 * 60 * 1000);
    clearStatus(); // reste d'une séance guidée interrompue (app fermée en cours de route)
    initPushButton().catch(() => {});
    startQueueWatcher();
    startSummaryWatch();
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
