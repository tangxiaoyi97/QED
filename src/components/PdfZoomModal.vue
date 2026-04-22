<script setup>
import { onBeforeUnmount, watch } from 'vue';
import PdfCanvas from './PdfCanvas.vue';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  },
  payload: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(['close']);
const { t } = useI18n();

function handleKeydown(event) {
  if (event.key === 'Escape' && props.open) {
    emit('close');
  }
}

/**
 * Close the zoom modal when the user clicks on any area that is NOT actual
 * PDF content (the rendered canvas or pagination controls).
 *
 * Previously the intermediate wrapper divs (zoom-content, zoom-canvas-wrap)
 * occupied the full viewport.  Clicks on their padding/empty areas would
 * hit those elements — they are *not* `.pdf-shell`, so the old guard
 * `target.closest('.pdf-shell')` let them through, but because the click
 * originated *inside* the backdrop's child tree it was never treated as a
 * "backdrop click" either.  The fix: use `pointer-events: none` on the
 * wrapper layers (set in CSS) so clicks fall through to the backdrop, and
 * only restore `pointer-events: auto` on `.pdf-shell` itself.
 */
function handleBackdropClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    emit('close');
    return;
  }

  // Keep the modal open only when the user clicks directly on the PDF
  // canvas, the page-control buttons, or the loading/error overlay.
  if (
    target.closest('.pdf-pages') ||
    target.closest('.page-control') ||
    target.closest('.pdf-state')
  ) {
    return;
  }

  emit('close');
}

watch(
  () => props.open,
  (isOpen) => {
    if (typeof window === 'undefined') return;
    if (isOpen) {
      window.addEventListener('keydown', handleKeydown);
    } else {
      window.removeEventListener('keydown', handleKeydown);
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeydown);
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open && payload" class="zoom-backdrop" @click="handleBackdropClick">
      <button class="zoom-close-button" type="button" :aria-label="t('common.close')" @click.stop="emit('close')">×</button>
      <div class="zoom-content">
        <div class="zoom-canvas-wrap">
          <PdfCanvas
            :url="payload.url"
            :label="payload.label"
            :zoomable="false"
            :initial-page="payload.page || 1"
            :high-resolution="true"
            :max-css-scale="2.75"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>
