<script setup>
import { computed } from 'vue';
import { useI18n } from '../composables/useI18n.js';
import { getChangelog } from '../changelog/index.js';

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  },
  appVersion: {
    type: String,
    default: ''
  }
});

defineEmits(['start', 'details']);

const { t, locale } = useI18n();
const changelog = computed(() => getChangelog(props.appVersion, locale.value));
const intro = computed(() => changelog.value?.intro ?? '');
const highlights = computed(() => changelog.value?.highlights ?? []);
const titleParts = computed(() => {
  const tpl = t('updates.title', { version: '' });
  const [head, tail = ''] = String(tpl).split('');
  return { head, tail };
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop update-backdrop">
      <section class="modal-panel update-panel update-panel--colorful" role="dialog" aria-modal="true" :aria-label="t('updates.ariaLabel')">
        <header class="update-panel__header">
          <span class="eyebrow eyebrow--accent">{{ t('updates.eyebrow') }}</span>
          <h2>
            <span>{{ titleParts.head }}</span>
            <span class="update-panel__version">{{ appVersion }}</span>
            <span v-if="titleParts.tail">{{ titleParts.tail }}</span>
          </h2>
          <p>{{ intro }}</p>
        </header>

        <section class="update-panel__body">
          <strong>{{ t('updates.highlightsTitle') }}</strong>
          <ul>
            <li v-for="(item, index) in highlights" :key="item" :data-index="index % 6">{{ item }}</li>
          </ul>
        </section>

        <footer class="modal-actions update-panel__actions">
          <button class="pill-button" type="button" @click="$emit('details')">
            {{ t('updates.details') }}
          </button>
          <button class="pill-button pill-button--dark" type="button" @click="$emit('start')">
            {{ t('updates.start') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style>
.update-panel--colorful {
  position: relative;
  overflow: hidden;
}

.update-panel--colorful::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(
    90deg,
    var(--green) 0%,
    var(--blue) 25%,
    var(--orange) 50%,
    var(--yellow) 70%,
    var(--red) 90%,
    var(--gray) 100%
  );
}

.update-panel--colorful .eyebrow--accent {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--green) 14%, transparent);
  color: var(--green);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.update-panel--colorful .update-panel__version {
  margin-left: 6px;
  color: var(--blue);
  font-weight: 500;
}

.update-panel--colorful .update-panel__body {
  position: relative;
  border: 1px solid color-mix(in srgb, var(--blue) 18%, var(--border));
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--blue) 4%, var(--surface-muted)) 0%,
    var(--surface-muted) 60%
  );
}

.update-panel--colorful .update-panel__body strong {
  color: var(--text);
}

.update-panel--colorful .update-panel__body strong::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 8px;
  border-radius: 50%;
  background: var(--blue);
  vertical-align: 2px;
}

.update-panel--colorful .update-panel__body ul {
  list-style: none;
  padding-left: 4px;
}

.update-panel--colorful .update-panel__body li {
  position: relative;
  padding-left: 20px;
}

.update-panel--colorful .update-panel__body li::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0.55em;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gray);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--gray) 18%, transparent);
}

.update-panel--colorful .update-panel__body li[data-index='0']::before {
  background: var(--green);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 18%, transparent);
}
.update-panel--colorful .update-panel__body li[data-index='1']::before {
  background: var(--blue);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 18%, transparent);
}
.update-panel--colorful .update-panel__body li[data-index='2']::before {
  background: var(--orange);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--orange) 18%, transparent);
}
.update-panel--colorful .update-panel__body li[data-index='3']::before {
  background: var(--yellow);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--yellow) 18%, transparent);
}
.update-panel--colorful .update-panel__body li[data-index='4']::before {
  background: var(--red);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--red) 18%, transparent);
}
.update-panel--colorful .update-panel__body li[data-index='5']::before {
  background: var(--gray);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--gray) 18%, transparent);
}
</style>
