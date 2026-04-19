/** Canonical theme ids for `document.documentElement[data-theme]`, localStorage, and server `settings_json.theme`. */
export const HERMES_THEME_ORDER = Object.freeze([
  'light',
  'dark',
  'muted-orange',
  'muted-green',
  'muted-blue',
]);

const ALLOWED = new Set(HERMES_THEME_ORDER);

export function normalizeHermesTheme(input) {
  if (input == null || typeof input !== 'string') return 'light';
  return ALLOWED.has(input) ? input : 'light';
}

/** Toolbar / PWA `theme-color` meta (approximate page background). */
export function themeMetaThemeColor(themeId) {
  switch (normalizeHermesTheme(themeId)) {
    case 'dark':
      return '#15181c';
    case 'muted-orange':
      return '#f3ebe3';
    case 'muted-green':
      return '#e8f0e9';
    case 'muted-blue':
      return '#e6eef6';
    case 'light':
    default:
      return '#f4f3f0';
  }
}

/** Browser `color-scheme` meta: only `dark` uses dark native controls. */
export function themeMetaColorScheme(themeId) {
  return normalizeHermesTheme(themeId) === 'dark' ? 'dark' : 'light';
}

export const HERMES_THEME_LABELS = Object.freeze({
  light: 'Light',
  dark: 'Dark',
  'muted-orange': 'Muted orange',
  'muted-green': 'Muted green',
  'muted-blue': 'Muted blue',
});

export function nextHermesTheme(current) {
  const t = normalizeHermesTheme(current);
  const i = HERMES_THEME_ORDER.indexOf(t);
  const idx = i < 0 ? 0 : i;
  return HERMES_THEME_ORDER[(idx + 1) % HERMES_THEME_ORDER.length];
}
