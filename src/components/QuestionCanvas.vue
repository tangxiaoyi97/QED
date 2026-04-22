<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import PdfCanvas from './PdfCanvas.vue';
import AiChatPanel from './AiChatPanel.vue';
import { formatQuestionTitle, isStarred } from '../utils/format.js';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  questions: {
    type: Array,
    default: () => []
  },
  currentId: {
    type: String,
    default: ''
  },
  progress: {
    type: Object,
    default: () => ({})
  },
  answerIds: {
    type: Array,
    default: () => []
  },
  busy: {
    type: Boolean,
    default: false
  },
  isGuest: {
    type: Boolean,
    default: false
  },
  aiQuestionId: {
    type: String,
    default: ''
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
  }
});

const emit = defineEmits(['active-change', 'show-answer', 'show-question', 'rate', 'toggle-star', 'quick-mark', 'zoom', 'ask-ai', 'send-ai']);
const scroller = ref(null);
const itemRefs = new Map();
let observer = null;
let internalScroll = false;

const { t } = useI18n();

watch(
  () => {
    const qs = props.questions;
    // Lightweight fingerprint: avoids creating a full joined string on
    // every reactive pass.  Length + first/last IDs is sufficient to
    // detect list additions, removals, and reorders.
    return `${qs.length}|${qs[0]?.id ?? ''}|${qs.at(-1)?.id ?? ''}`;
  },
  () => setupObserver(),
  { flush: 'post' }
);

onMounted(() => setupObserver());
onBeforeUnmount(() => observer?.disconnect());

function setItemRef(id, element) {
  if (element) itemRefs.set(id, element);
  else itemRefs.delete(id);
}

async function setupObserver() {
  observer?.disconnect();
  await nextTick();
  if (!scroller.value) return;

  observer = new IntersectionObserver(
    (entries) => {
      if (internalScroll) return;
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const id = visible?.target?.dataset?.questionId;
      if (id && id !== props.currentId) emit('active-change', id);
    },
    {
      root: scroller.value,
      threshold: [0.45, 0.6, 0.8]
    }
  );

  for (const element of itemRefs.values()) {
    observer.observe(element);
  }
}

async function scrollToQuestion(id) {
  await nextTick();
  const element = itemRefs.get(id);
  if (!element) return;
  internalScroll = true;
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => {
    internalScroll = false;
  }, 520);
}

function isAnswerVisible(id) {
  return props.answerIds.includes(id);
}

function pdfUrl(question) {
  return isAnswerVisible(question.id) ? question.urls.solution : question.urls.question;
}

function isAiVisible(id) {
  return props.aiQuestionId === id;
}

defineExpose({ scrollToQuestion });
</script>

<template>
  <main ref="scroller" class="workspace workspace--canvas">
    <section
      v-for="question in questions"
      :key="question.id"
      :ref="(element) => setItemRef(question.id, element)"
      class="canvas-item"
      :class="{ 'canvas-item--active': question.id === currentId }"
      :data-question-id="question.id"
    >
      <header class="canvas-item__header">
        <div>
          <span class="eyebrow">{{ question.suiteTitle }}</span>
          <h1>{{ formatQuestionTitle(question) }}</h1>
          <p>{{ question.sourceLabel }} · {{ question.topicLabel }}</p>
        </div>
        <button class="star-button" :class="{ 'star-button--active': isStarred(progress, question.id) }" type="button" @click="$emit('toggle-star', question.id)">
          ★
        </button>
      </header>

      <section class="question-stage question-stage--snap" @contextmenu.prevent="$emit('quick-mark', question.id, $event)">
        <AiChatPanel
          v-if="isAiVisible(question.id)"
          :conversation="aiConversation"
          :question="question"
          :loading="aiLoading"
          :decompressing="aiDecompressing"
          :can-chat="aiCanChat"
          :error="aiError"
          :disabled-message="aiDisabledMessage"
          @send="$emit('send-ai', $event)"
        />
        <PdfCanvas
          v-else
          :url="pdfUrl(question)"
          :label="`${formatQuestionTitle(question)} ${isAnswerVisible(question.id) ? t('workspace.answer') : t('workspace.question')}`"
          @zoom="$emit('zoom', $event)"
        />
      </section>

      <footer class="canvas-item__actions">
        <button v-if="isAnswerVisible(question.id) || isAiVisible(question.id)" class="pill-button" type="button" @click="$emit('show-question', question.id)">
          {{ t('workspace.backToQuestion') }}
        </button>
        <button
          v-if="!isAnswerVisible(question.id)"
          class="pill-button pill-button--dark"
          type="button"
          :disabled="busy"
          @click="$emit('show-answer', question.id)"
        >
          {{ t('workspace.showAnswer') }}
        </button>
        <button
          v-if="!isGuest && !isAiVisible(question.id)"
          class="pill-button"
          type="button"
          :disabled="busy"
          @click="$emit('ask-ai', question.id)"
        >
          {{ t('workspace.askAi') }}
        </button>
        <template v-if="isAnswerVisible(question.id) && !isAiVisible(question.id)">
          <button class="rating-button rating-button--mastered" type="button" @click="$emit('rate', question.id, 'mastered')">
            {{ t('workspace.rating.mastered') }}
          </button>
          <button class="rating-button rating-button--meh" type="button" @click="$emit('rate', question.id, 'meh')">
            {{ t('workspace.rating.meh') }}
          </button>
          <button class="rating-button rating-button--baffled" type="button" @click="$emit('rate', question.id, 'baffled')">
            {{ t('workspace.rating.baffled') }}
          </button>
          <button class="rating-button rating-button--ignored" type="button" @click="$emit('rate', question.id, 'ignored')">
            {{ t('workspace.rating.ignored') }}
          </button>
        </template>
      </footer>
    </section>
  </main>
</template>
