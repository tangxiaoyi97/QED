<script setup>
import { computed } from 'vue';
import { STATUS_META, formatQuestionTitle, formatSeconds } from '../utils/format.js';
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
  timerEnabled: {
    type: Boolean,
    default: false
  },
  elapsedSeconds: {
    type: Number,
    default: 0
  },
  randomBlocked: {
    type: String,
    default: ''
  },
  downloadBusy: {
    type: Boolean,
    default: false
  },
  mode: {
    type: String,
    default: 'random'
  }
});

defineEmits(['toggle-timer', 'open-filter', 'draw-random', 'download-question', 'toggle-collapse']);

const { t } = useI18n();

const statusMeta = computed(() => {
  const meta = STATUS_META[props.progressStatus] ?? STATUS_META.unseen;
  return {
    ...meta,
    label: t(meta.labelKey),
    description: t(meta.descriptionKey)
  };
});
</script>

<template>
  <aside class="inspector">
    <div class="inspector-heading">
      <span>{{ t('inspector.title') }}</span>
    </div>

    <section v-if="timerEnabled" class="inspector-block inspector-timer">
      <span class="eyebrow">{{ t('inspector.timer') }}</span>
      <strong>{{ formatSeconds(elapsedSeconds) }}</strong>
    </section>

    <section class="inspector-block">
      <span class="eyebrow">{{ t('inspector.currentQuestion') }}</span>
      <template v-if="question">
        <h2>{{ formatQuestionTitle(question) }}</h2>
        <dl class="meta-list">
          <div>
            <dt>{{ t('inspector.year') }}</dt>
            <dd>{{ question.year }}</dd>
          </div>
          <div>
            <dt>{{ t('inspector.term') }}</dt>
            <dd>{{ question.termName }}</dd>
          </div>
          <div>
            <dt>{{ t('inspector.part') }}</dt>
            <dd>{{ question.part }}</dd>
          </div>
          <div>
            <dt>{{ t('inspector.number') }}</dt>
            <dd>{{ question.number }}</dd>
          </div>
          <div>
            <dt>{{ t('inspector.topic') }}</dt>
            <dd>{{ question.topicLabel }}</dd>
          </div>
        </dl>
      </template>
      <p v-else class="muted-copy">{{ t('inspector.noQuestion') }}</p>
    </section>

    <section class="inspector-block">
      <span class="eyebrow">{{ t('inspector.mastery') }}</span>
      <div class="large-status" :class="`large-status--${statusMeta.tone}`">
        <strong>{{ statusMeta.label }}</strong>
        <span>{{ statusMeta.description }}</span>
      </div>
    </section>

    <section class="inspector-block">
      <span class="eyebrow">{{ t('inspector.timer') }}</span>
      <label class="switch-row">
        <input type="checkbox" :checked="timerEnabled" @change="$emit('toggle-timer', $event.target.checked)" />
        <span>{{ t('inspector.timerSwitch') }}</span>
      </label>
    </section>

    <section class="inspector-block inspector-actions">
      <button
        v-if="question"
        class="pill-button"
        type="button"
        :disabled="downloadBusy"
        @click="$emit('download-question')"
      >
        {{ downloadBusy ? t('inspector.downloading') : t('inspector.downloadQuestion') }}
      </button>
      <button v-if="mode !== 'records'" class="pill-button pill-button--warm" type="button" @click="$emit('open-filter')">
        {{ t('inspector.openFilter') }}
      </button>
      <button v-if="mode !== 'records'" class="pill-button" type="button" @click="$emit('draw-random')">{{ t('inspector.redraw') }}</button>
      <p v-if="randomBlocked && mode !== 'records'" class="warning-copy">{{ randomBlocked }}</p>
    </section>
  </aside>
</template>
