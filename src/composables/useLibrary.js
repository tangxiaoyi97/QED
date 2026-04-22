import { computed, ref } from 'vue';

const STORAGE_KEY = 'qed.libraryId';

function normalizeLibraryId(raw, fallback = 'library') {
  const source = String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
  if (!source) return fallback;
  const safe = source.replace(/[^a-z0-9_-]/g, '');
  return safe || fallback;
}

export function readStoredLibrary() {
  try {
    return normalizeLibraryId(localStorage.getItem(STORAGE_KEY) || 'library');
  } catch {
    return 'library';
  }
}

const libraryId = ref(readStoredLibrary());

export function useLibrary() {
  function saveLibrary(nextId) {
    const safe = normalizeLibraryId(nextId, 'library');
    libraryId.value = safe;
    try {
      localStorage.setItem(STORAGE_KEY, safe);
    } catch {
      // ignore storage failures
    }
    return safe;
  }

  return {
    libraryId,
    isDefaultLibrary: computed(() => libraryId.value === 'library'),
    saveLibrary
  };
}

