<script setup>
import { computed } from 'vue';
import PdfCanvas from './PdfCanvas.vue';
import AiChatPanel from './AiChatPanel.vue';
import { STATUS_META, formatQuestionTitle } from '../utils/format.js';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  question: {
    type: Object,
    default: null
  },
  progressStatus: {
    type: String,
    default: 'unseen'
  },
  answerVisible: {
    type: Boolean,
    default: false
  },
  aiVisible: {
    type: Boolean,
    default: false
  },
  aiConversation: {
    type: Object,
    default: null
  },
  aiLoading: {
    type: Boolean,
    default: false
  },
  aiDecompressing: {
    type: Boolean,
    default: false
  },
  aiCanChat: {
    type: Boolean,
    default: false
  },
  aiError: {
    type: String,
    default: ''
  },
  aiDisabledMessage: {
    type: String,
    default: ''
  },
  timerEnabled: {
    type: Boolean,
    default: false
  },
  timerStarted: {
    type: Boolean,
    default: false
  },
  timerRunning: {
    type: Boolean,
    default: false
  },
  elapsedSeconds: {
    type: Number,
    default: 0
  },
  canSkip: {
    type: Boolean,
    default: false
  },
  busy: {
    type: Boolean,
    default: false
  },
  starred: {
    type: Boolean,
    default: false
  },
  isGuest: {
    type: Boolean,
    default: false
  }
});

defineEmits(['start-timer', 'show-answer', 'show-question', 'rate', 'skip', 'toggle-star', 'zoom', 'ask-ai', 'send-ai']);

const concealed = computed(() => props.timerEnabled && !props.timerStarted && !props.answerVisible && !props.aiVisible);
const { t } = useI18n();

const statusMeta = computed(() => {
  const meta = STATUS_META[props.progressStatus] ?? STATUS_META.unseen;
  return {
    ...meta,
    label: t(meta.labelKey)
  };
});

const activePdfUrl = computed(() => (props.answerVisible ? props.question?.urls.solution : props.question?.urls.question));
const activePdfLabel = computed(() => `${props.question?.label ?? 'Question'} ${props.answerVisible ? t('workspace.answer') : t('workspace.question')}`);
</script>

<template>
  <main class="workspace">
    <div v-if="!question" class="empty-workspace">
      <h1>{{ t('boot.noQuestionTitle') }}</h1>
      <p>{{ t('boot.noQuestionDesc') }}</p>
    </div>

    <template v-else>
      <div class="workspace-header">
        <div>
          <span class="eyebrow">{{ question.suiteTitle }}</span>
          <h1 class="workspace-title-line">
            {{ formatQuestionTitle(question) }}
            <span class="status-text-inline">{{ statusMeta.label }}</span>
          </h1>
          <p>{{ question.sourceLabel }} · {{ question.topicLabel }}</p>
        </div>
        <div class="workspace-header__actions">
          <button
            v-if="!isGuest"
            class="star-button"
            :class="{ 'star-button--active': starred }"
            type="button"
            @click="$emit('toggle-star', question.id)"
          >
            ★
          </button>
        </div>
      </div>

      <section class="question-stage">
        <AiChatPanel
          v-if="aiVisible"
          :conversation="aiConversation"
          :question="question"
          :loading="aiLoading"
          :decompressing="aiDecompressing"
          :can-chat="aiCanChat"
          :error="aiError"
          :disabled-message="aiDisabledMessage"
          @send="$emit('send-ai', $event)"
        />
        <PdfCanvas v-else :url="activePdfUrl" :blurred="concealed" :label="activePdfLabel" @zoom="$emit('zoom', $event)" />
        <button v-if="concealed" class="start-overlay" type="button" @click="$emit('start-timer')">
          <span>{{ t('workspace.clickStart') }}</span>
          <small>{{ t('workspace.clickStartHint') }}</small>
        </button>
      </section>

      <div class="workspace-actions">
        <span v-if="answerVisible && !question.hasSolution" class="inline-warning inline-warning--actions">
          {{ t('workspace.missingSolution') }}
        </span>
        <button
          v-if="answerVisible || aiVisible"
          class="pill-button"
          type="button"
          :disabled="busy"
          @click="$emit('show-question')"
        >
          {{ t('workspace.backToQuestion') }}
        </button>
        <button
          v-if="!answerVisible"
          class="pill-button pill-button--dark"
          type="button"
          :disabled="concealed || busy"
          @click="$emit('show-answer')"
        >
          {{ t('workspace.showAnswer') }}
        </button>
        <button
          v-if="!isGuest && !aiVisible"
          class="pill-button"
          type="button"
          :disabled="concealed || busy"
          @click="$emit('ask-ai')"
        >
          {{ t('workspace.askAi') }}
        </button>
        <button v-if="canSkip && !isGuest" class="pill-button" type="button" :disabled="busy" @click="$emit('skip')">
          {{ t('workspace.skip') }}
        </button>
        <!-- Rating panel — hidden for guests -->
        <div v-if="answerVisible && !aiVisible && !isGuest" class="rating-panel rating-panel--inline">
          <button class="rating-button rating-button--mastered" type="button" @click="$emit('rate', 'mastered')">
            {{ t('workspace.rating.mastered') }}
          </button>
          <button class="rating-button rating-button--meh" type="button" @click="$emit('rate', 'meh')">
            {{ t('workspace.rating.meh') }}
          </button>
          <button class="rating-button rating-button--baffled" type="button" @click="$emit('rate', 'baffled')">
            {{ t('workspace.rating.baffled') }}
          </button>
          <button class="rating-button rating-button--ignored" type="button" @click="$emit('rate', 'ignored')">
            {{ t('workspace.rating.ignored') }}
          </button>
        </div>
        <!-- Guest lock prompt -->
        <div v-if="isGuest" class="guest-lock-row">
          <span class="guest-lock-text">{{ t('guest.loginPrompt') }}</span>
        </div>
      </div>
    </template>
  </main>
</template>
