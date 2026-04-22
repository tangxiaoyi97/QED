<script setup>
import { computed } from 'vue';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  },
  title: {
    type: String,
    default: ''
  },
  message: {
    type: String,
    default: ''
  },
  confirmLabel: {
    type: String,
    default: ''
  },
  cancelLabel: {
    type: String,
    default: ''
  }
});

defineEmits(['confirm', 'cancel']);

const { t } = useI18n();

const resolvedTitle = computed(() => props.title || t('confirm.defaultTitle'));
const resolvedConfirmLabel = computed(() => props.confirmLabel || t('common.confirm'));
const resolvedCancelLabel = computed(() => props.cancelLabel || t('common.cancel'));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('cancel')">
      <section class="modal-panel confirm-panel" role="dialog" aria-modal="true" :aria-label="resolvedTitle">
        <header class="modal-header">
          <div>
            <span class="eyebrow">{{ t('confirm.eyebrow') }}</span>
            <h2>{{ resolvedTitle }}</h2>
          </div>
        </header>
        <p>{{ message }}</p>
        <footer class="modal-actions">
          <button class="pill-button" type="button" @click="$emit('cancel')">{{ resolvedCancelLabel }}</button>
          <button class="pill-button pill-button--dark" type="button" @click="$emit('confirm')">
            {{ resolvedConfirmLabel }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
