<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import PdfCanvas from './PdfCanvas.vue';
import { formatExamTime, formatQuestionTitle } from '../utils/format.js';
import { useI18n } from '../composables/useI18n.js';
import { api } from '../services/api.js';

const props = defineProps({
  question: { type: Object, default: null },
  phase: { type: String, required: true },
  currentIndex: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  remainingSeconds: { type: Number, default: 0 },
  paused: { type: Boolean, default: false },
  currentGrade: { type: Number, default: null },
  results: { type: Object, default: null },
  examGrades: { type: Object, default: () => ({}) },
  examRecords: { type: Object, default: () => ({}) },
  examQuestions: { type: Array, default: () => [] },
  probeHistory: { type: Array, default: () => [] }
});

const emit = defineEmits([
  'previous', 'complete', 'skip', 'pause', 'resume',
  'exit', 'finish', 'score', 'next-grade', 'back-random',
  'mark-baffled', 'review-question', 'back-grading'
]);

const { t } = useI18n();

const scoreTiers = ref(null);
const tiersLoading = ref(false);
let tiersController = null;

watch(
  [() => props.question?.id, () => props.phase],
  async ([id, phase]) => {
    // Cancel any in-flight request so a slow response for a previous
    // question can't overwrite the tiers for the current one.
    tiersController?.abort();

    if (phase !== 'grading' || !id) {
      scoreTiers.value = null;
      tiersLoading.value = false;
      return;
    }
    const controller = new AbortController();
    tiersController = controller;
    tiersLoading.value = true;
    scoreTiers.value = null;
    try {
      const data = await api.scoreTiers(id, { signal: controller.signal });
      if (controller.signal.aborted) return;
      scoreTiers.value = Array.isArray(data.scores) ? data.scores : [];
    } catch (error) {
      if (error?.name === 'AbortError') return;
      scoreTiers.value = [];
    } finally {
      if (!controller.signal.aborted) tiersLoading.value = false;
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => tiersController?.abort());

const gradeMax = computed(() => {
  const normalizedTiers = normalizeScoreTiers(scoreTiers.value, props.question);
  if (normalizedTiers.length > 0) return Math.max(...normalizedTiers);
  return props.question?.part === 1 ? 1 : 4;
});

const effectiveScoreOptions = computed(() => {
  const normalizedTiers = normalizeScoreTiers(scoreTiers.value, props.question);
  if (normalizedTiers.length > 0) return normalizedTiers;
  const max = props.question?.part === 1 ? 1 : 4;
  const opts = [];
  for (let i = 0; i <= max * 2; i++) opts.push(i / 2);
  return opts;
});

const reviewItems = computed(() => {
  if (!props.results) return [];
  return props.examQuestions
    .map((q) => {
      const grade = props.examGrades[q.id] ?? null;
      const skipped = props.examRecords[q.id] === 'skipped';
      const ungraded = grade === null && !skipped;
      const max = q.part === 1 ? 1 : 4;
      const isZero = !skipped && grade === 0;
      const isLow = !skipped && !isZero && grade <= max / 2;
      if (!skipped && !ungraded && !isZero && !isLow) return null;
      return { question: q, grade, skipped, ungraded, isZero, isLow };
    })
    .filter(Boolean);
});

const reviewByTopic = computed(() => {
  const groups = new Map();
  for (const item of reviewItems.value) {
    const key = item.question.topic ?? '__t2';
    const label = item.question.topic ? item.question.topicLabel : t('stats.topicPart2');
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
});

const suiteHistory = computed(() =>
  props.probeHistory.filter((h) => h.suiteId === props.results?.suiteId).slice(0, 8)
);

const scoreDelta = computed(() =>
  (props.results ? 36 - props.results.totalScore : null)
);

function markAllBaffled() {
  const ids = reviewItems.value.map((item) => item.question.id);
  if (ids.length) emit('mark-baffled', ids);
}

const customScore = ref('');
const isLast = computed(() => props.currentIndex >= props.total - 1);

watch(() => props.question?.id, () => {
  customScore.value = '';
});

function submitCustomScore() {
  const max = gradeMax.value;
  const normalized = String(customScore.value ?? '').trim().replace(',', '.');
  const n = parseFloat(normalized);
  if (!Number.isFinite(n)) return;
  emit('score', Math.min(max, Math.max(0, Math.round(n * 2) / 2)));
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeScoreTiers(rawTiers, question) {
  if (!Array.isArray(rawTiers) || rawTiers.length === 0) return [];
  const max = question?.part === 1 ? 1 : 4;
  const clean = [...new Set(
    rawTiers
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.round(value * 2) / 2)
      .filter((value) => value >= 0 && value <= max)
  )].sort((a, b) => a - b);
  return clean;
}
</script>

<template>
  <div class="exam-workspace">
    <main class="workspace workspace--exam">
      <template v-if="phase === 'taking' && question">
        <div class="workspace-header">
          <div>
            <span class="eyebrow">{{ question.suiteTitle }} · {{ currentIndex + 1 }}/{{ total }}</span>
            <h1>{{ formatQuestionTitle(question) }}</h1>
            <p>{{ question.sourceLabel }}</p>
          </div>
        </div>

        <section class="question-stage exam-stage">
          <PdfCanvas class="exam-pdf" :url="question.urls.question" :label="`${question.label} ${t('workspace.question')}`" />
        </section>

        <div class="exam-bottom-bar">
          <button class="pill-button" type="button" :disabled="currentIndex === 0" @click="$emit('previous')">{{ t('exam.previous') }}</button>
          <button class="pill-button pill-button--dark" type="button" @click="$emit('complete')">
            {{ isLast ? t('exam.submit') : t('exam.finishCurrent') }}
          </button>
          <button class="pill-button" type="button" :disabled="isLast" @click="$emit('skip')">{{ t('exam.skip') }}</button>
        </div>
      </template>

      <template v-else-if="phase === 'grading' && question">
        <div class="workspace-header">
          <div>
            <span class="eyebrow">{{ t('exam.grading', { index: currentIndex + 1, total }) }}</span>
            <h1>{{ formatQuestionTitle(question) }}</h1>
            <p>
              {{ question.sourceLabel }} ·
              <template v-if="tiersLoading">{{ t('exam.loadingTier') }}</template>
              <template v-else>{{ t('exam.maxScore', { value: gradeMax }) }}</template>
              <span v-if="scoreTiers && scoreTiers.length > 0" class="tiers-source"> · {{ t('exam.scoreFromPdf') }}</span>
            </p>
          </div>
          <div v-if="currentGrade !== null" class="status-chip status-chip--mastered">{{ t('common.points', { value: currentGrade }) }}</div>
        </div>

        <section class="answer-panel answer-panel--grading">
          <div class="answer-panel__heading">
            <h2>{{ t('exam.answerAndCriteria') }}</h2>
            <span v-if="!question.hasSolution" class="inline-warning">{{ t('exam.noSolutionFile') }}</span>
          </div>
          <PdfCanvas class="exam-pdf" :url="question.urls.solution" :label="`${question.label} ${t('workspace.answer')}`" />
        </section>

        <div class="exam-bottom-bar exam-bottom-bar--grading">
          <button class="pill-button" type="button" :disabled="currentIndex === 0" @click="$emit('previous')">{{ t('exam.previousQuestion') }}</button>

          <button
            v-for="score in effectiveScoreOptions"
            :key="score"
            class="score-button"
            :class="{ 'score-button--active': currentGrade === score }"
            type="button"
            @click="$emit('score', score)"
          >{{ t('common.points', { value: score }) }}</button>

          <label class="custom-score">
            <input
              v-model="customScore"
              type="number"
              min="0"
              :max="gradeMax"
              step="0.5"
              :placeholder="t('exam.custom')"
              @keydown.enter.prevent="submitCustomScore"
            />
            <button class="pill-button" type="button" @click="submitCustomScore">{{ t('exam.scoreButton') }}</button>
          </label>

          <button class="pill-button pill-button--dark" type="button" @click="$emit('next-grade')">
            {{ isLast ? t('exam.viewResult') : t('exam.nextQuestion') }}
          </button>
        </div>
      </template>

      <template v-else-if="phase === 'results' && results">
        <div class="workspace-header">
          <div>
            <span class="eyebrow">{{ t('exam.scoreReport', { suite: results.suiteTitle }) }}</span>
            <h1>{{ results.totalScore }}<small class="score-total__max">/36</small> {{ t('common.pointsUnit') }}</h1>
            <p>{{ t('exam.partOne') }} {{ t('common.points', { value: results.t1Score }) }} · {{ t('exam.partTwo') }} {{ t('common.points', { value: results.t2Score }) }}</p>
            <p v-if="results.note !== null">{{ t('exam.noteLine', { note: results.note, label: results.noteLabel }) }}</p>
          </div>
          <div class="score-delta-chip" :class="scoreDelta <= 0 ? 'score-delta-chip--pass' : 'score-delta-chip--gap'">
            {{ scoreDelta <= 0 ? t('exam.reachedTarget') : t('exam.gapToPerfect', { value: scoreDelta }) }}
          </div>
        </div>

        <div class="score-summary">
          <div>
            <span>{{ t('exam.partOne') }}</span>
            <strong>{{ results.t1Score }}</strong>
            <small>{{ t('common.questions', { count: results.t1Count }) }}</small>
          </div>
          <div v-for="item in results.t2Items" :key="item.id">
            <span>{{ item.label }}<small v-if="!item.counted"> · {{ t('exam.bestOfDropped') }}</small></span>
            <strong>{{ item.score }}</strong>
            <small>{{ t('exam.fullScore', { value: item.maxScore ?? 4 }) }}</small>
          </div>
        </div>

        <section v-if="suiteHistory.length > 0" class="review-section">
          <span class="eyebrow">{{ t('exam.suiteHistory', { suite: results.suiteTitle }) }}</span>
          <div class="history-scores">
            <div v-for="h in suiteHistory" :key="h.id" class="history-score-row">
              <span class="history-score-date">{{ formatDate(h.at) }}</span>
              <div class="history-score-bar-wrap">
                <div class="history-score-bar" :style="{ width: `${Math.round((h.totalScore / (h.maxScore || 36)) * 100)}%` }" />
              </div>
              <strong class="history-score-val">{{ h.totalScore }}<small>/{{ h.maxScore ?? 36 }}</small></strong>
            </div>
          </div>
        </section>

        <section class="review-section">
          <div class="review-section__header">
            <span class="eyebrow">
              {{ reviewItems.length > 0 ? t('exam.reviewNeed', { count: reviewItems.length }) : t('exam.review') }}
            </span>
            <button
              v-if="reviewItems.length > 0"
              class="pill-button pill-button--warm"
              type="button"
              @click="markAllBaffled"
            >{{ t('exam.markAllBaffled') }}</button>
          </div>

          <template v-if="reviewItems.length > 0">
            <div v-for="group in reviewByTopic" :key="group.key" class="review-topic-group">
              <p class="review-topic-label">{{ group.label }}</p>
              <div class="review-item-list">
                <div v-for="item in group.items" :key="item.question.id" class="review-item">
                  <div class="review-item__info">
                    <strong>{{ formatQuestionTitle(item.question) }}</strong>
                    <span v-if="item.skipped" class="review-badge review-badge--skip">{{ t('exam.skippedBadge') }}</span>
                    <span v-else-if="item.ungraded" class="review-badge review-badge--skip">{{ t('exam.ungradedBadge') }}</span>
                    <span v-else-if="item.isZero" class="review-badge review-badge--zero">{{ t('exam.zeroBadge') }}</span>
                    <span v-else class="review-badge review-badge--low">{{ t('exam.lowBadge', { value: item.grade }) }}</span>
                  </div>
                  <div class="review-item__actions">
                    <button class="pill-button review-item__action" type="button" @click="emit('review-question', item.question.id)">
                      {{ t('exam.reviewQuestion') }}
                    </button>
                    <button class="pill-button review-item__action" type="button" @click="emit('mark-baffled', [item.question.id])">
                      {{ t('exam.markBaffled') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <p v-else class="muted-copy">{{ t('exam.reviewGreat') }}</p>
        </section>

        <div class="workspace-actions">
          <button class="pill-button" type="button" @click="$emit('back-grading')">{{ t('exam.backToGrading') }}</button>
          <button class="pill-button pill-button--dark" type="button" @click="$emit('back-random')">{{ t('exam.backRandom') }}</button>
        </div>
      </template>
    </main>

    <aside class="exam-toolbar">
      <section>
        <span class="eyebrow">{{ t('exam.countdown') }}</span>
        <strong class="exam-clock">{{ formatExamTime(remainingSeconds) }}</strong>
      </section>
      <button class="pill-button" type="button" @click="$emit(paused ? 'resume' : 'pause')">
        {{ paused ? t('exam.resume') : t('exam.pause') }}
      </button>
      <button class="pill-button" type="button" @click="$emit('exit')">{{ t('exam.exit') }}</button>
      <button v-if="phase === 'taking'" class="pill-button pill-button--dark" type="button" @click="$emit('finish')">
        {{ t('exam.finishExam') }}
      </button>
    </aside>

    <button v-if="paused" class="pause-overlay" type="button" @click="$emit('resume')">
      <span>{{ t('exam.paused') }}</span>
      <small>{{ t('exam.clickResume') }}</small>
    </button>
  </div>
</template>
