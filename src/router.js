import { createRouter, createWebHistory } from 'vue-router';
import { readStoredProfile } from './composables/useProfile.js';
import App from './App.vue';

const VALID_MODES = ['random', 'browse', 'stats', 'ai', 'records'];

function normalizeLibraryId(raw) {
  const safe = String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return safe || 'library';
}

function parseModeToken(token) {
  const raw = String(token ?? '');
  const [baseRaw, libraryRaw] = raw.split('@');
  const mode = String(baseRaw || 'random').trim().toLowerCase();
  const hasLibrary = raw.includes('@');
  return {
    mode,
    libraryId: hasLibrary ? normalizeLibraryId(libraryRaw) : '',
    hasLibrary
  };
}

function buildModeToken(mode, libraryId) {
  if (libraryId) return `${mode}@${normalizeLibraryId(libraryId)}`;
  return mode;
}

const routes = [
  {
    // Main app shell — profile + mode both in URL
    path: '/:profile/:mode',
    component: App,
    beforeEnter(to) {
      const parsed = parseModeToken(to.params.mode);
      if (!VALID_MODES.includes(parsed.mode)) {
        return { path: `/${to.params.profile}/random`, replace: true };
      }

      const normalized = buildModeToken(parsed.mode, parsed.hasLibrary ? parsed.libraryId : '');
      if (normalized !== to.params.mode) {
        return { path: `/${to.params.profile}/${normalized}`, replace: true };
      }
    }
  },
  {
    // /:profile → redirect to /:profile/random
    path: '/:profile',
    redirect(to) {
      return `/${to.params.profile}/random`;
    }
  },
  {
    // / → redirect to last used profile's random mode
    path: '/',
    redirect() {
      return `/${readStoredProfile()}/random`;
    }
  }
];

export const router = createRouter({
  history: createWebHistory(),
  routes
});
