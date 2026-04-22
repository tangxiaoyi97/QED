<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import AiMarkdown from './AiMarkdown.vue';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  conversation: {
    type: Object,
    default: null
  },
  question: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  },
  decompressing: {
    type: Boolean,
    default: false
  },
  canChat: {
    type: Boolean,
    default: true
  },
  error: {
    type: String,
    default: ''
  },
  emptyTitle: {
    type: String,
    default: ''
  },
  emptyDesc: {
    type: String,
    default: ''
  },
  disabledMessage: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['send']);
const draft = ref('');
const scroller = ref(null);
const { t } = useI18n();

// Distinguish "loading first reply for this question" (no messages yet) from
// "loading a follow-up" (append a thinking bubble after existing messages).
const hasMessages = computed(() => (props.conversation?.messages?.length ?? 0) > 0);
const showInitialThinking = computed(() => props.loading && !hasMessages.value && !props.decompressing);
const showFollowupThinking = computed(() => props.loading && hasMessages.value && !props.decompressing);

watch(
  () => [props.conversation?.id, props.conversation?.messages?.length, props.decompressing, props.loading],
  async () => {
    if (props.decompressing) return;
    await nextTick();
    if (!scroller.value) return;
    scroller.value.scrollTop = scroller.value.scrollHeight;
  },
  { flush: 'post' }
);

watch(
  () => props.conversation?.id,
  () => {
    draft.value = '';
  }
);

function submit() {
  const text = draft.value.trim();
  if (!text || props.loading || !props.canChat) return;
  emit('send', text);
  draft.value = '';
}

function roleLabel(role) {
  if (role === 'assistant') return 'AI';
  if (role === 'system') return 'System';
  return t('ai.you');
}

function messageTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
</script>

<template>
  <section class="ai-chat-shell">
    <div v-if="decompressing" class="ai-chat-empty">
      <h2>{{ t('ai.decompressing') }}</h2>
      <p>{{ t('ai.decompressingDesc') }}</p>
    </div>

    <div v-else-if="showInitialThinking" class="ai-chat-empty ai-chat-empty--thinking">
      <div class="ai-thinking-hero">
        <span class="ai-thinking-dot" />
        <span class="ai-thinking-dot" />
        <span class="ai-thinking-dot" />
      </div>
      <h2>{{ t('ai.thinking') }}</h2>
      <p>{{ t('ai.thinkingInitial') }}</p>
    </div>

    <div v-else-if="!conversation" class="ai-chat-empty">
      <h2>{{ emptyTitle || t('ai.emptyTitle') }}</h2>
      <p>{{ emptyDesc || t('ai.emptyDesc') }}</p>
    </div>

    <template v-else>
      <header class="ai-chat-head">
        <div>
          <span class="eyebrow">{{ question?.suiteTitle || t('topNav.brandTitle') }}</span>
          <h2>{{ question?.sourceLabel || conversation.questionId }}</h2>
          <p>{{ question?.label || '' }}</p>
        </div>
        <span class="ai-chat-head__meta">
          {{ t('ai.messageCount', { count: conversation.messages?.length ?? 0 }) }}
        </span>
      </header>

      <div ref="scroller" class="ai-chat-log">
        <article
          v-for="message in conversation.messages"
          :key="message.id"
          class="ai-message"
          :class="`ai-message--${message.role}`"
        >
          <header class="ai-message-head">
            <strong>{{ roleLabel(message.role) }}</strong>
            <small>{{ messageTime(message.createdAt) }}</small>
          </header>
          <AiMarkdown :content="message.content" />
        </article>

        <article v-if="showFollowupThinking" class="ai-message ai-message--assistant ai-message--thinking">
          <header class="ai-message-head">
            <strong>AI</strong>
            <small>{{ t('ai.thinking') }}</small>
          </header>
          <div class="ai-thinking-row" aria-live="polite">
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-dot" />
          </div>
        </article>
      </div>

      <p v-if="error" class="warning-copy">{{ error }}</p>
      <p v-if="!canChat && disabledMessage" class="warning-copy">{{ disabledMessage }}</p>

      <footer class="ai-chat-compose">
        <textarea
          v-model="draft"
          :placeholder="t('ai.inputPlaceholder')"
          :disabled="loading || !canChat"
          @keydown.enter.exact.prevent="submit"
        />
        <button class="pill-button pill-button--dark" type="button" :disabled="loading || !canChat || !draft.trim()" @click="submit">
          {{ loading ? t('ai.thinking') : t('ai.send') }}
        </button>
      </footer>
    </template>
  </section>
</template>
