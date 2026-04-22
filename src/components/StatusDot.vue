<script setup>
import { computed } from 'vue';
import { STATUS_META } from '../utils/format.js';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  status: {
    type: String,
    default: 'unseen'
  },
  label: {
    type: String,
    default: ''
  },
  starred: {
    type: Boolean,
    default: false
  }
});

const meta = computed(() => STATUS_META[props.status] ?? STATUS_META.unseen);
const marker = computed(() => meta.value.marker ?? 'empty-light');
const { t } = useI18n();
const title = computed(() => {
  const base = props.label || t(meta.value.labelKey);
  return props.starred ? `${base} · ${t('status.starredSuffix')}` : base;
});
</script>

<template>
  <span class="marker-stack" :title="title" aria-hidden="true">
    <span class="status-marker" :class="[`status-marker--${marker}`, `status-marker--${status}`]" />
    <span v-if="starred" class="star-marker">★</span>
  </span>
</template>
