// ============================================================================
// Voice input — Web Speech API (on-device dictation, same idea as the iOS
// Shortcut's dictation step). Tap once to start, tap again to stop; the
// transcript is appended live to the target textarea so the user can still
// review/edit before saving. Falls back silently (button hidden) where
// unsupported rather than a broken control — notably this can also behave
// inconsistently in an installed (standalone) PWA on iOS, so text input
// always remains the reliable fallback.
// ============================================================================
export function setupMicButton(buttonEl, hintEl, textareaEl, captionEl) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { buttonEl.hidden = true; return; }

  const recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.continuous = true;
  recognition.interimResults = true;

  const ERROR_MESSAGES = {
    "not-allowed": "Micro refusé — autorise l'accès au micro dans les réglages de Safari.",
    "service-not-allowed": "Micro refusé — autorise l'accès au micro dans les réglages de Safari.",
    "audio-capture": "Pas de micro détecté.",
    network: "Problème réseau pendant la dictée.",
  };
  const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

  let recording = false; // the person wants to be recording (drives auto-restart)
  let stoppedByUser = false;
  let baseText = "";
  let finalText = "";

  // Only *final* (confirmed) chunks land in the textarea — the still-being-
  // recognized interim text is shown separately in captionEl, closer to
  // how iOS dictation itself shows a live line before committing words.
  // Tapping the mic again to stop, then reviewing/editing the textarea
  // before hitting the screen's own Save/Envoyer button, is the validation
  // step before anything is actually sent.
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk + " ";
      else interim += chunk;
    }
    textareaEl.value = (baseText + finalText).trim();
    if (captionEl) captionEl.textContent = interim || "…";
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech") return; // just a pause, not an error worth surfacing
    hintEl.textContent = ERROR_MESSAGES[event.error] || `Erreur dictée (${event.error}).`;
    if (FATAL_ERRORS.has(event.error)) { stoppedByUser = true; recording = false; }
  };

  recognition.onend = () => {
    // iOS Safari ends recognition on its own after a short pause even with
    // continuous=true — restart transparently so the person doesn't have
    // to keep re-tapping the mic mid-dictation.
    if (recording && !stoppedByUser) {
      try { recognition.start(); } catch (_) { /* restart already pending */ }
    } else {
      finishStopUI();
    }
  };

  async function start() {
    // Some browsers (notably inside an installed iOS PWA) never prompt for
    // mic permission from recognition.start() alone — asking explicitly
    // first surfaces a clear "not-allowed" instead of a silent no-op.
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); }
      catch (_) { hintEl.textContent = ERROR_MESSAGES["not-allowed"]; hintEl.hidden = false; return; }
    }
    baseText = textareaEl.value ? textareaEl.value + " " : "";
    finalText = "";
    recording = true;
    stoppedByUser = false;
    buttonEl.classList.add("recording");
    buttonEl.textContent = "⏹️";
    hintEl.textContent = "🔴 Enregistrement… appuie à nouveau pour arrêter";
    hintEl.hidden = false;
    if (captionEl) { captionEl.textContent = "…"; captionEl.hidden = false; }
    try { recognition.start(); } catch (_) { /* already started */ }
  }
  function stop() {
    recording = false;
    stoppedByUser = true;
    try { recognition.stop(); } catch (_) { /* already stopped */ }
    finishStopUI();
  }
  function finishStopUI() {
    buttonEl.classList.remove("recording");
    buttonEl.textContent = "🎙️";
    hintEl.hidden = true;
    if (captionEl) captionEl.hidden = true;
  }

  buttonEl.addEventListener("click", () => (recording ? stop() : start()));
}
