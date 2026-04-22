<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../services/api.js';
import { formatQuestionTitle } from '../utils/format.js';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  },
  questions: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(['close', 'select']);

const query = ref('');
const textResults = ref([]);
const textLoading = ref(false);
const textReady = ref(false);
const textProgress = ref({ processed: 0, total: 0 });
const textError = ref('');

let debounceHandle = null;
let activeController = null;

const { t } = useI18n();

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      query.value = '';
      textResults.value = [];
      textError.value = '';
      refreshStatus();
    } else {
      if (debounceHandle) window.clearTimeout(debounceHandle);
      if (activeController) activeController.abort();
    }
  }
);

watch(query, (value) => {
  if (debounceHandle) window.clearTimeout(debounceHandle);
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    textResults.value = [];
    textError.value = '';
    textLoading.value = false;
    return;
  }
  debounceHandle = window.setTimeout(() => runFullTextSearch(trimmed), 300);
});

const questionsById = computed(() => new Map(props.questions.map((question) => [question.id, question])));

const metaResults = computed(() => {
  const value = query.value.trim().toLowerCase();
  if (!value) return props.questions.slice(0, 24);
  return props.questions
    .filter((question) =>
      [
        question.id,
        question.fileBase,
        question.suiteTitle,
        question.sourceLabel,
        question.topicLabel,
        question.topic,
        String(question.year),
        formatQuestionTitle(question)
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(value)
    )
    .slice(0, 40);
});

const enrichedTextResults = computed(() => {
  return textResults.value
    .map((result) => ({
      ...result,
      question: questionsById.value.get(result.id) ?? null
    }))
    .filter((result) => result.question);
});

const metaIds = computed(() => new Set(metaResults.value.map((question) => question.id)));
const deduplicatedTextResults = computed(() =>
  enrichedTextResults.value.filter((result) => !metaIds.value.has(result.id))
);

const statusMessage = computed(() => {
  if (query.value.trim().length < 2) return '';
  if (textLoading.value) return t('search.searchingText');
  if (textError.value) return textError.value;
  if (!textReady.value && textProgress.value.total > 0) {
    return t('search.indexing', { processed: textProgress.value.processed, total: textProgress.value.total });
  }
  if (!textReady.value) return t('search.notReady');
  if (enrichedTextResults.value.length === 0 && metaResults.value.length > 0) return '';
  return '';
});

async function runFullTextSearch(value) {
  if (activeController) activeController.abort();
  activeController = new AbortController();
  textLoading.value = true;
  textError.value = '';
  try {
    const payload = await api.searchFullText(value, { limit: 30, signal: activeController.signal });
    textResults.value = payload.results ?? [];
    textReady.value = Boolean(payload.ready);
    textProgress.value = payload.progress ?? textProgress.value;
  } catch (error) {
    if (error.name === 'AbortError') return;
    textError.value = error.message || t('errors.searchFailed');
    textResults.value = [];
  } finally {
    textLoading.value = false;
  }
}

async function refreshStatus() {
  try {
    const payload = await api.searchStatus();
    textReady.value = Boolean(payload.ready);
    textProgress.value = payload.progress ?? textProgress.value;
  } catch {
    // ignore status fetch errors
  }
}

function snippetParts(snippet) {
  const { text, matchStart, matchLength } = snippet;
  if (typeof matchStart !== 'number' || typeof matchLength !== 'number') {
    return [{ type: 'text', value: text }];
  }
  const safeStart = Math.max(0, Math.min(matchStart, text.length));
  const safeEnd = Math.max(safeStart, Math.min(safeStart + matchLength, text.length));
  return [
    { type: 'text', value: text.slice(0, safeStart) },
    { type: 'mark', value: text.slice(safeStart, safeEnd) },
    { type: 'text', value: text.slice(safeEnd) }
  ];
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <section class="modal-panel search-panel" role="dialog" aria-modal="true" :aria-label="t('search.title')">
        <header class="modal-header">
          <div>
            <span class="eyebrow">{{ t('topNav.search') }}</span>
            <h2 class="modal-title">{{ t('search.title') }}</h2>
          </div>
          <button class="icon-button" type="button" :aria-label="t('common.close')" @click="$emit('close')">✕</button>
        </header>

        <input
          v-model="query"
          class="search-input"
          type="search"
          :placeholder="t('search.placeholder')"
          autofocus
        />

        <p v-if="statusMessage" class="search-status-line">{{ statusMessage }}</p>

        <div class="search-results">
          <template v-if="metaResults.length > 0">
            <p v-if="query.trim()" class="search-section-label">{{ t('search.metaMatch') }}</p>
            <button
              v-for="question in metaResults"
              :key="`meta-${question.id}`"
              class="search-result"
              type="button"
              @click="$emit('select', question.id)"
            >
              <strong>{{ formatQuestionTitle(question) }}</strong>
              <span>{{ question.sourceLabel }} · {{ question.topicLabel }}</span>
            </button>
          </template>

          <template v-if="deduplicatedTextResults.length > 0">
            <p class="search-section-label">{{ t('search.textMatch') }}</p>
            <button
              v-for="result in deduplicatedTextResults"
              :key="`text-${result.id}`"
              class="search-result search-result--text"
              type="button"
              @click="$emit('select', result.id)"
            >
              <strong>{{ formatQuestionTitle(result.question) }}</strong>
              <span>{{ result.question.sourceLabel }} · {{ result.question.topicLabel }}</span>
              <p v-for="(snippet, index) in result.snippets" :key="index" class="search-snippet">
                <small class="search-snippet__page">{{ t('search.page', { page: snippet.page }) }}</small>
                <template v-for="(part, partIndex) in snippetParts(snippet)" :key="partIndex">
                  <mark v-if="part.type === 'mark'">{{ part.value }}</mark>
                  <span v-else>{{ part.value }}</span>
                </template>
              </p>
            </button>
          </template>

          <p v-if="query.trim().length >= 2 && metaResults.length === 0 && deduplicatedTextResults.length === 0 && !textLoading" class="search-empty">
            {{ t('search.noResult') }}
          </p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
