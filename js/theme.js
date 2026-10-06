// Thème (docs/adr/0096) : « auto » suit le réglage du téléphone ; « light » /
// « dark » le forcent via data-theme sur <html> (style.css redéfinit les
// couleurs pour chaque cas). Préférence de cet appareil seulement.
const THEME_KEY = "coach_theme";

export function currentTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch (_) {
    return "auto";
  }
}

export function applyTheme(theme = currentTheme()) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export function setTheme(theme) {
  try {
    if (theme === "light" || theme === "dark") localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch (_) { /* confort seulement */ }
  applyTheme(theme);
}
