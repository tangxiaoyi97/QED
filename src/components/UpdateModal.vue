<script setup>
import { computed } from 'vue';
import { useI18n } from '../composables/useI18n.js';

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

const { t } = useI18n();
const highlights = computed(() => {
  const value = t('updates.highlights');
  return Array.isArray(value) ? value : [];
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop update-backdrop">
      <section class="modal-panel update-panel" role="dialog" aria-modal="true" :aria-label="t('updates.ariaLabel')">
        <header class="update-panel__header">
          <span class="eyebrow">{{ t('updates.eyebrow') }}</span>
          <h2>{{ t('updates.title', { version: appVersion }) }}</h2>
          <p>{{ t('updates.intro') }}</p>
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
