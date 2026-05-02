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
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop update-backdrop">
      <section class="modal-panel update-panel" role="dialog" aria-modal="true" :aria-label="t('updates.ariaLabel')">
        <header class="update-panel__header">
          <span class="eyebrow">{{ t('updates.eyebrow') }}</span>
          <h2>{{ t('updates.title', { version: appVersion }) }}</h2>
          <p>{{ intro }}</p>
        </header>

        <section class="update-panel__body">
          <strong>{{ t('updates.highlightsTitle') }}</strong>
          <ul>
            <li v-for="item in highlights" :key="item">{{ item }}</li>
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
