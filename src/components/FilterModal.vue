<script setup>
import { reactive, watch } from 'vue';
import { RANDOM_STATUS_FILTERS, STATUS_META } from '../utils/format.js';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  },
  filters: {
    type: Object,
    required: true
  },
  meta: {
    type: Object,
    default: () => ({ years: [], topics: [], parts: [], statuses: [] })
  }
});

const emit = defineEmits(['close', 'apply']);

const local = reactive({
  statuses: [],
  topics: [],
  parts: [],
  years: []
});

const { t } = useI18n();

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) copyFilters();
  },
  { immediate: true }
);

function copyFilters() {
  local.statuses = [...(props.filters.statuses ?? [])];
  local.topics = [...(props.filters.topics ?? [])];
  local.parts = [...(props.filters.parts ?? [])];
  local.years = [...(props.filters.years ?? [])];
}

function toggle(listName, value) {
  const normalized = listName === 'parts' || listName === 'years' ? Number(value) : String(value);
  const list = local[listName];
  const index = list.indexOf(normalized);
  if (index >= 0) list.splice(index, 1);
  else list.push(normalized);
}

function isChecked(listName, value) {
  const normalized = listName === 'parts' || listName === 'years' ? Number(value) : String(value);
  return local[listName].includes(normalized);
}

function selectAll() {
  local.statuses = props.meta.statuses.map((item) => item.id);
  local.topics = props.meta.topics.map((item) => item.id);
  local.parts = props.meta.parts.map((item) => item.id);
  local.years = [...props.meta.years];
}

function reset() {
  local.statuses = [...RANDOM_STATUS_FILTERS];
  local.topics = [];
  local.parts = [1, 2];
  local.years = [];
}

function apply() {
  emit('apply', {
    statuses: [...local.statuses],
    topics: [...local.topics],
    parts: [...local.parts],
    years: [...local.years]
  });
}

function statusLabel(statusId) {
  const meta = STATUS_META[statusId];
  if (!meta) return statusId;
  return t(meta.labelKey);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <section class="modal-panel filter-panel" role="dialog" aria-modal="true" :aria-label="t('filter.title')">
        <header class="modal-header">
          <div>
            <span class="eyebrow">{{ t('filter.eyebrow') }}</span>
            <h2 class="modal-title">{{ t('filter.title') }}</h2>
          </div>
          <button class="icon-button" type="button" :aria-label="t('common.close')" @click="$emit('close')">✕</button>
        </header>

        <div class="filter-grid">
          <fieldset>
            <legend>{{ t('filter.mastery') }}</legend>
            <label v-for="status in meta.statuses" :key="status.id" class="check-row">
              <input
                type="checkbox"
                :checked="isChecked('statuses', status.id)"
                @change="toggle('statuses', status.id)"
              />
              <span>{{ statusLabel(status.id) }}</span>
            </label>
            <p>{{ t('filter.masteryHint') }}</p>
          </fieldset>

          <fieldset>
            <legend>{{ t('filter.topic') }}</legend>
            <label v-for="topic in meta.topics" :key="topic.id" class="check-row">
              <input type="checkbox" :checked="isChecked('topics', topic.id)" @change="toggle('topics', topic.id)" />
              <span>{{ topic.label }}</span>
            </label>
            <p>{{ t('filter.topicHint') }}</p>
          </fieldset>

          <fieldset>
            <legend>{{ t('filter.part') }}</legend>
            <label v-for="part in meta.parts" :key="part.id" class="check-row">
              <input type="checkbox" :checked="isChecked('parts', part.id)" @change="toggle('parts', part.id)" />
              <span>{{ part.label }}</span>
            </label>
          </fieldset>

          <fieldset>
            <legend>{{ t('filter.year') }}</legend>
            <label v-for="year in meta.years" :key="year" class="check-row">
              <input type="checkbox" :checked="isChecked('years', year)" @change="toggle('years', year)" />
              <span>{{ year }}</span>
            </label>
            <p>{{ t('filter.yearHint') }}</p>
          </fieldset>
        </div>

        <footer class="modal-actions">
          <button class="pill-button" type="button" @click="selectAll">{{ t('filter.selectAll') }}</button>
          <button class="pill-button" type="button" @click="reset">{{ t('filter.reset') }}</button>
          <button class="pill-button pill-button--dark" type="button" @click="apply">{{ t('common.apply') }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
