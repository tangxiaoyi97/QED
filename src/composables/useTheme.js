import { ref } from 'vue';

const STORAGE_KEY = 'qed.theme';
const VALID_THEMES = new Set(['light', 'dark']);

function normalizeTheme(value) {
  return VALID_THEMES.has(value) ? value : 'light';
}

function readStoredTheme() {
  if (typeof window === 'undefined') return 'light';
  try {
    return normalizeTheme(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'light';
  }
}

function applyTheme(nextTheme) {
  if (typeof document === 'undefined') return;
  const safe = normalizeTheme(nextTheme);
  document.documentElement.dataset.theme = safe;
  document.documentElement.style.colorScheme = safe;
}

const theme = ref(readStoredTheme());
applyTheme(theme.value);

export function useTheme() {
  function setTheme(nextTheme) {
    const safe = normalizeTheme(nextTheme);
    theme.value = safe;
    applyTheme(safe);
    try {
      window.localStorage.setItem(STORAGE_KEY, safe);
    } catch {
      // Ignore storage failures in restricted environments.
    }
    return safe;
  }

  return { theme, setTheme };
}
