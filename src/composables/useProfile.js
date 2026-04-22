import { ref, computed } from 'vue';

const STORAGE_KEY = 'qed.profileId';

function normalizeProfileId(raw, fallback = 'guest') {
  const source = String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();

  if (!source) return fallback;
  const normalized = source.replace(/[^a-z0-9_-]/g, '');
  if (!normalized) return fallback;

  const blocked = new Set(['.', '..', 'con', 'prn', 'aux', 'nul']);
  if (blocked.has(normalized)) return fallback;
  if (/^com[1-9]$/.test(normalized) || /^lpt[1-9]$/.test(normalized)) return fallback;

  return normalized.slice(0, 40) || fallback;
}

/**
 * Read the stored profile from localStorage.
 * Falls back to 'guest' if nothing is stored.
 * Exported so that router.js can call it before the app mounts.
 */
export function readStoredProfile() {
  try {
    return normalizeProfileId(localStorage.getItem(STORAGE_KEY) || 'guest');
  } catch {
    return 'guest';
  }
}

// Module-level reactive state — shared across all component instances
const profileId = ref(readStoredProfile());
export const isGuest = computed(() => profileId.value === 'guest');

export function useProfile() {
  function saveProfile(id) {
    const safe = normalizeProfileId(id || 'guest');
    profileId.value = safe;
    try {
      if (safe === 'guest') {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, safe);
      }
    } catch {
      // localStorage may be unavailable (private browsing, etc.)
    }
  }

  function clearProfile() {
    saveProfile('guest');
  }

  return { profileId, isGuest, saveProfile, clearProfile };
}
