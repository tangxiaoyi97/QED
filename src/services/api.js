import { useProfile } from '../composables/useProfile.js';
import { useLibrary } from '../composables/useLibrary.js';

async function fetchJson(url, options = {}) {
  const { profileId } = useProfile();
  const { libraryId } = useLibrary();
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'X-Profile-ID': profileId.value,
      'X-Library-ID': libraryId.value,
      ...(options.headers ?? {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'Request failed.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}


export const api = {
  bootstrap() {
    return fetchJson('/api/bootstrap');
  },
  catalog() {
    return fetchJson('/api/catalog');
  },
  about() {
    return fetchJson('/api/about');
  },
  refreshCatalog() {
    return fetchJson('/api/catalog/refresh', {
      method: 'POST'
    });
  },
  state() {
    return fetchJson('/api/state');
  },
  random(filters) {
    return fetchJson('/api/random', {
      method: 'POST',
      body: JSON.stringify({ filters })
    });
  },
  setProgress(id, status, options = {}) {
    return fetchJson('/api/progress', {
      method: 'POST',
      body: JSON.stringify({ id, status, ...options })
    });
  },
  setStar(id, starred) {
    return fetchJson('/api/star', {
      method: 'POST',
      body: JSON.stringify({ id, starred })
    });
  },
  setConfig(patch) {
    return fetchJson('/api/config', {
      method: 'POST',
      body: JSON.stringify(patch)
    });
  },
  aiMeta() {
    return fetchJson('/api/ai/meta');
  },
  aiHistory() {
    return fetchJson('/api/ai/history');
  },
  aiConversation(id) {
    return fetchJson(`/api/ai/history/${encodeURIComponent(id)}`);
  },
  aiOpen(questionId, { signal, locale } = {}) {
    return fetchJson('/api/ai/open', {
      method: 'POST',
      signal,
      body: JSON.stringify({ questionId, locale })
    });
  },
  aiMessage(conversationId, content, model, { signal, locale } = {}) {
    return fetchJson('/api/ai/message', {
      method: 'POST',
      signal,
      body: JSON.stringify({ conversationId, content, model, locale })
    });
  },
  createQuestionDownloadLink(id) {
    return fetchJson(`/api/download/question/${encodeURIComponent(id)}`, {
      method: 'POST'
    });
  },
  examDrafts() {
    return fetchJson('/api/exam-drafts');
  },
  saveExamDraft(draft) {
    return fetchJson('/api/exam-drafts/save', {
      method: 'POST',
      body: JSON.stringify(draft)
    });
  },
  deleteExamDraft(suiteId) {
    return fetchJson('/api/exam-drafts/delete', {
      method: 'POST',
      body: JSON.stringify({ suiteId })
    });
  },
  finishHistory(id, status, options = {}) {
    return fetchJson('/api/history/finish', {
      method: 'POST',
      body: JSON.stringify({ id, status, ...options })
    });
  },
  startHistory(id) {
    return fetchJson('/api/history/start', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
  },
  addProbeHistory(result) {
    return fetchJson('/api/probe-history', {
      method: 'POST',
      body: JSON.stringify(result)
    });
  },
  searchFullText(query, { limit = 20, signal } = {}) {
    const url = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    return fetchJson(url, { signal });
  },
  searchStatus() {
    return fetchJson('/api/search/status');
  },
  scoreTiers(id, { signal } = {}) {
    return fetchJson(`/api/score-tiers/${encodeURIComponent(id)}`, { signal });
  },
  checkProfile(id) {
    return fetchJson(`/api/profiles/check/${id}`);
  },
  createProfile(id, credential) {
    const body = typeof credential === 'string'
      ? { id, token: credential }
      : { id, ...(credential ?? {}) };
    return fetchJson('/api/profiles/create', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }
};
