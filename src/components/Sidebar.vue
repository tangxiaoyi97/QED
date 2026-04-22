<script setup>
import StatusDot from './StatusDot.vue';
import { useI18n } from '../composables/useI18n.js';

defineProps({
  title: {
    type: String,
    default: ''
  },
  subtitle: {
    type: String,
    default: ''
  },
  sections: {
    type: Array,
    default: () => []
  },
  currentId: {
    type: String,
    default: ''
  },
  emptyText: {
    type: String,
    default: ''
  },
  collapsible: {
    type: Boolean,
    default: true
  },
  headerOptions: {
    type: Array,
    default: () => []
  },
  headerValue: {
    type: String,
    default: ''
  },
  collapseAriaLabel: {
    type: String,
    default: ''
  }
});

defineEmits(['select', 'toggle-collapse', 'header-change', 'quick-mark']);

const { t } = useI18n();
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-heading">
      <label v-if="headerOptions.length" class="sidebar-title-select">
        <select :value="headerValue" @change="$emit('header-change', $event.target.value)">
          <option v-for="option in headerOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <span v-else>{{ title }}</span>
      <small v-if="subtitle">{{ subtitle }}</small>
    </div>

    <div v-if="sections.length === 0" class="sidebar-empty">{{ emptyText || t('sidebar.noItems') }}</div>

    <section v-for="section in sections" :key="section.title" class="sidebar-section">
      <h2>{{ section.title }}</h2>
      <button
        v-for="item in section.items"
        :key="item.id"
        class="sidebar-item"
        :class="{ 'sidebar-item--active': (item.questionId || item.id) === currentId }"
        type="button"
        @click="$emit('select', item.questionId || item.id)"
        @contextmenu.prevent="$emit('quick-mark', item.questionId || item.id, $event)"
      >
        <span class="sidebar-item__body">
          <strong>{{ item.label }}</strong>
          <small v-if="item.meta">{{ item.meta }}</small>
        </span>
        <span v-if="item.trailing" class="sidebar-item__trailing">{{ item.trailing }}</span>
        <StatusDot :status="item.dotStatus" :label="item.dotLabel" :starred="item.starred" />
      </button>
    </section>
  </aside>
</template>
