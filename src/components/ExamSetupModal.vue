<script setup>
import { ref, watch } from 'vue';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  },
  suites: {
    type: Array,
    default: () => []
  },
  selectedSuiteId: {
    type: String,
    default: ''
  },
  probeHistory: {
    type: Array,
    default: () => []
  },
  examDrafts: {
    type: Object,
    default: () => ({ version: 1, drafts: [] })
  }
});

const emit = defineEmits(['close', 'start']);
const localSuiteId = ref('');
const { t } = useI18n();

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) localSuiteId.value = props.selectedSuiteId || props.suites[0]?.id || '';
  },
  { immediate: true }
);

function latestScore(suiteId) {
  return props.probeHistory.find((entry) => entry.suiteId === suiteId);
}

function draftForSuite(suiteId) {
  const drafts = Array.isArray(props.examDrafts?.drafts) ? props.examDrafts.drafts : [];
  return drafts.find((draft) => draft.suiteId === suiteId) ?? null;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <section class="modal-panel exam-setup" role="dialog" aria-modal="true" :aria-label="t('examSetup.ariaLabel')">
        <header class="modal-header">
          <div>
            <span class="eyebrow">{{ t('examSetup.eyebrow') }}</span>
            <h2 class="modal-title">{{ t('examSetup.title') }}</h2>
          </div>
          <button class="icon-button" type="button" :aria-label="t('common.close')" @click="$emit('close')">✕</button>
        </header>

        <div class="suite-list">
          <label v-for="suite in suites" :key="suite.id" class="suite-option">
            <input v-model="localSuiteId" type="radio" name="exam-suite" :value="suite.id" />
            <span>
              <strong>{{ suite.title }}</strong>
              <small>{{ t('examSetup.suiteMeta', { count: suite.questionCount, t1: suite.t1Count, t2: suite.t2Count }) }}</small>
              <em
                v-if="latestScore(suite.id)"
              >{{ t('examSetup.latestScore', { score: latestScore(suite.id).totalScore, date: latestScore(suite.id).at.slice(0, 10) }) }}</em>
              <em
                v-if="draftForSuite(suite.id)"
                class="suite-option__draft"
              >{{ t('examSetup.interrupted', { date: draftForSuite(suite.id).updatedAt.slice(0, 10) }) }}</em>
            </span>
          </label>
        </div>

        <footer class="modal-actions">
          <button class="pill-button" type="button" @click="$emit('close')">{{ t('common.cancel') }}</button>
          <button
            class="pill-button pill-button--dark"
            type="button"
            :disabled="!localSuiteId"
            @click="$emit('start', localSuiteId)"
          >
            {{ draftForSuite(localSuiteId) ? t('examSetup.resume') : t('examSetup.enter') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
