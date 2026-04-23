import { computed, ref } from 'vue';

const STORAGE_KEY = 'qed.theme';
export const THEME_OPTIONS = ['light', 'dark', 'system'];

function readStoredTheme() {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) || '';
    return THEME_OPTIONS.includes(raw) ? raw : '';
  } catch {
    return '';
  }
}

function writeStoredTheme(next) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Ignore in restricted environments (Safari private mode, etc.).
  }
}

function systemPrefersDark() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

const preference = ref(readStoredTheme() || 'system');
const resolved = ref(preference.value === 'system'
  ? (systemPrefersDark() ? 'dark' : 'light')
  : preference.value);

let systemMql = null;

function applyToDom(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  // Hint to native UI (scrollbars, form controls) that the app is dark.
  document.documentElement.style.colorScheme = theme;
}

function resolveFor(pref) {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return pref;
}

function recompute() {
  resolved.value = resolveFor(preference.value);
  applyToDom(resolved.value);
}

function attachSystemListener() {
  if (typeof window === 'undefined' || systemMql) return;
  systemMql = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!systemMql) return;
  const handler = () => {
    if (preference.value === 'system') recompute();
  };
  // addEventListener is the modern API; addListener is the Safari fallback.
  if (typeof systemMql.addEventListener === 'function') {
    systemMql.addEventListener('change', handler);
  } else if (typeof systemMql.addListener === 'function') {
    systemMql.addListener(handler);
  }
}

export function initTheme() {
  applyToDom(resolved.value);
  attachSystemListener();
}

export function useTheme() {
  const isDark = computed(() => resolved.value === 'dark');

  function setTheme(next) {
    if (!THEME_OPTIONS.includes(next)) return;
    preference.value = next;
    writeStoredTheme(next);
    recompute();
  }

  function toggleTheme() {
    // A two-state toggle is simpler for users than cycling through
    // light/dark/system. If they're currently following system, the first
    // click flips to the opposite of what the system says — the intent is
    // always "switch appearance now".
    setTheme(isDark.value ? 'light' : 'dark');
  }

  return {
    preference,
    resolved,
    isDark,
    setTheme,
    toggleTheme
  };
}
