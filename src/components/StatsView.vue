<script setup>
import { computed, ref } from 'vue';
import { STATUS_META, formatSeconds, getProgressStatus } from '../utils/format.js';
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  questions: { type: Array, default: () => [] },
  progress: { type: Object, default: () => ({}) },
  history: { type: Array, default: () => [] },
  selectedStatus: { type: String, default: 'baffled' },
  isGuest: { type: Boolean, default: false }
});

const emit = defineEmits(['select-status', 'start-practice']);

const activeTab = ref('topic');
const { t } = useI18n();

function statusCounts(ids) {
  const counts = { mastered: 0, meh: 0, baffled: 0, ignored: 0, unseen: 0 };
  for (const id of ids) {
    const s = getProgressStatus(props.progress, id);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

function avgTimeSec(ids) {
  let total = 0;
  let count = 0;
  for (const id of ids) {
    for (const a of props.progress.attempts?.[id] ?? []) {
      if (a.timed && a.elapsedSeconds != null) {
        total += a.elapsedSeconds;
        count++;
      }
    }
  }
  return count > 0 ? Math.round(total / count) : null;
}

function buildBreakdown(groupFn, labelFn, filterFn) {
  const groups = new Map();
  for (const q of props.questions) {
    if (filterFn && !filterFn(q)) continue;
    const key = String(groupFn(q));
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(q, key), ids: [], questions: [] });
    const g = groups.get(key);
    g.ids.push(q.id);
    g.questions.push(q);
  }
  return [...groups.values()].map((g) => {
    const counts = statusCounts(g.ids);
    const total = g.ids.length || 1;
    return {
      ...g,
      counts,
      pct: Math.round((counts.mastered / total) * 100),
      avgSec: avgTimeSec(g.ids)
    };
  });
}

const topicBreakdown = computed(() =>
  buildBreakdown(
    (q) => q.topic ?? '__t2',
    (q) => (q.topic ? q.topicLabel : t('stats.topicPart2')),
    null
  ).sort((a, b) => a.label.localeCompare(b.label))
);

const yearBreakdown = computed(() =>
  buildBreakdown((q) => q.year, (q) => String(q.year), null).sort((a, b) => Number(b.key) - Number(a.key))
);

const terminBreakdown = computed(() =>
  buildBreakdown((q) => q.termSlug, (q) => q.termName, null).sort((a, b) => a.label.localeCompare(b.label))
);

const teilBreakdown = computed(() =>
  buildBreakdown(
    (q) => q.part,
    (_, key) => (key === '1' ? t('stats.part1Label') : t('stats.part2Label')),
    null
  ).sort((a, b) => Number(a.key) - Number(b.key))
);

const activeBreakdown = computed(() => {
  if (activeTab.value === 'year') return yearBreakdown.value;
  if (activeTab.value === 'termin') return terminBreakdown.value;
  if (activeTab.value === 'teil') return teilBreakdown.value;
  return topicBreakdown.value;
});

function recentSummary(days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const items = (props.history ?? []).filter((h) => new Date(h.at).getTime() >= cutoff);
  const byStatus = { mastered: 0, meh: 0, baffled: 0, ignored: 0 };
  const ratedItems = [];
  for (const h of items) {
    if (Object.hasOwn(byStatus, h.status)) {
      byStatus[h.status]++;
      ratedItems.push(h);
    }
  }
  const uniqueIds = new Set(ratedItems.map((h) => h.id));
  const timedItems = ratedItems.filter((h) => h.timed && h.elapsedSeconds);
  const avgSec = timedItems.length
    ? Math.round(timedItems.reduce((s, h) => s + h.elapsedSeconds, 0) / timedItems.length)
    : null;
  return { count: uniqueIds.size, byStatus, avgSec };
}

const activity7 = computed(() => recentSummary(7));
const activity30 = computed(() => recentSummary(30));
const activityCards = computed(() => [
  { label: t('stats.last7Days'), data: activity7.value },
  { label: t('stats.last30Days'), data: activity30.value }
]);

const statItems = computed(() => {
  const total = props.questions.length || 1;
  const counts = {
    baffled: props.progress.baffled?.length ?? 0,
    meh: props.progress.meh?.length ?? 0,
    mastered: props.progress.mastered?.length ?? 0,
    ignored: props.progress.ignored?.length ?? 0
  };
  counts.unseen = props.questions.filter(
    (q) => !['mastered', 'meh', 'baffled', 'ignored'].some((k) => props.progress[k]?.includes(q.id))
  ).length;

  const order = ['baffled', 'meh', 'mastered', 'ignored', 'unseen'];
  let offset = 0;
  return order.map((key, i) => {
    const value = counts[key] ?? 0;
    const start = offset;
    const size = total > 0 ? (value / total) * 100 : 0;
    offset += size;
    const statusMeta = STATUS_META[key] ?? STATUS_META.unseen;
    const label = t(statusMeta.labelKey);
    return {
      key,
      value,
      label,
      title: `${label} · ${t('common.questions', { count: value })}`,
      path: donutSlice(start, offset),
      shade: `var(--chart-${key === 'unseen' ? 6 : i + 1})`
    };
  });
});

function donutSlice(s, e) {
  const size = e - s;
  if (size <= 0) return '';
  if (size >= 99.999) return 'M 60 6 A 54 54 0 1 1 59.99 6 A 54 54 0 1 1 60 6 M 60 28 A 32 32 0 1 0 59.99 28 A 32 32 0 1 0 60 28 Z';
  const outerS = pt(60, 60, 54, e);
  const outerE = pt(60, 60, 54, s);
  const innerS = pt(60, 60, 32, s);
  const innerE = pt(60, 60, 32, e);
  const la = size > 50 ? 1 : 0;
  return `M ${outerS.x} ${outerS.y} A 54 54 0 ${la} 0 ${outerE.x} ${outerE.y} L ${innerS.x} ${innerS.y} A 32 32 0 ${la} 1 ${innerE.x} ${innerE.y} Z`;
}

function pt(cx, cy, r, pct) {
  const rad = ((pct / 100) * 360 - 90) * (Math.PI / 180);
  return { x: +(cx + r * Math.cos(rad)).toFixed(3), y: +(cy + r * Math.sin(rad)).toFixed(3) };
}

function startPractice(group) {
  const filter = { statuses: ['baffled', 'meh', 'unseen'], topics: [], parts: [1, 2], years: [] };
  if (activeTab.value === 'topic') {
    filter.topics = group.key !== '__t2' ? [group.key] : [];
    filter.parts = group.key !== '__t2' ? [1] : [2];
  } else if (activeTab.value === 'year') {
    filter.years = [Number(group.key)];
  } else if (activeTab.value === 'teil') {
    filter.parts = [Number(group.key)];
  }
  emit('start-practice', filter);
}

const tabItems = computed(() => [
  ['topic', t('stats.tabs.topic')],
  ['year', t('stats.tabs.year')],
  ['termin', t('stats.tabs.term')],
  ['teil', t('stats.tabs.part')]
]);
</script>

<template>
  <main class="workspace stats-workspace">
    <!-- Guest lock overlay -->
    <div v-if="isGuest" class="stats-guest-lock">
      <div class="stats-guest-lock__inner">
        <div class="stats-guest-lock__icon">🔒</div>
        <h2>{{ t('guest.statsTitle') }}</h2>
        <p>{{ t('guest.statsDesc') }}</p>
      </div>
    </div>

    <header class="workspace-header workspace-header--flat">
      <div>
        <span class="eyebrow">{{ t('stats.eyebrow') }}</span>
        <h1>{{ t('stats.title') }}</h1>
        <p>{{ t('stats.subtitle', { count: questions.length }) }}</p>
      </div>
    </header>

    <div class="stats-top-row">
      <section class="stats-overview">
        <div class="pie-chart">
          <svg viewBox="0 0 120 120" role="img" :aria-label="t('stats.pieAria')">
            <path
              v-for="item in statItems"
              v-show="item.value > 0"
              :key="item.key"
              class="pie-slice"
              :class="{ 'pie-slice--active': selectedStatus === item.key }"
              :d="item.path"
              :fill="item.shade"
              @click="$emit('select-status', item.key)"
            ><title>{{ item.title }}</title></path>
          </svg>
          <span>{{ questions.length }}</span>
        </div>
        <div class="stats-legend">
          <button
            v-for="item in statItems"
            :key="item.key"
            class="legend-row"
            :class="{ 'legend-row--active': selectedStatus === item.key }"
            type="button"
            @click="$emit('select-status', item.key)"
          >
            <span class="legend-swatch" :style="{ background: item.shade }" />
            <strong>{{ item.label }}</strong>
            <em>{{ item.value }}</em>
          </button>
        </div>
      </section>

      <section class="stats-activity">
        <span class="eyebrow">{{ t('stats.recentPractice') }}</span>
        <div class="activity-cards">
          <div v-for="item in activityCards" :key="item.label" class="activity-card">
            <span class="activity-card__label">{{ item.label }}</span>
            <strong class="activity-card__count">{{ item.data.count }}</strong>
            <small>{{ t('stats.questionCount') }}</small>
            <div class="activity-breakdown">
              <span v-if="item.data.byStatus.mastered" class="act-chip act-chip--mastered">{{ t('stats.masteredChip', { count: item.data.byStatus.mastered }) }}</span>
              <span v-if="item.data.byStatus.meh" class="act-chip act-chip--meh">{{ t('stats.mehChip', { count: item.data.byStatus.meh }) }}</span>
              <span v-if="item.data.byStatus.baffled" class="act-chip act-chip--baffled">{{ t('stats.baffledChip', { count: item.data.byStatus.baffled }) }}</span>
            </div>
            <small v-if="item.data.avgSec" class="activity-card__time">{{ t('stats.avgTime', { value: formatSeconds(item.data.avgSec) }) }}</small>
          </div>
        </div>
      </section>
    </div>

    <div class="stats-breakdown">
      <div class="stats-tabs">
        <button
          v-for="[key, label] in tabItems"
          :key="key"
          class="stats-tab"
          :class="{ 'stats-tab--active': activeTab === key }"
          type="button"
          @click="activeTab = key"
        >{{ label }}</button>
      </div>

      <div class="breakdown-list">
        <div v-for="group in activeBreakdown" :key="group.key" class="breakdown-row">
          <div class="breakdown-row__label">
            <strong>{{ group.label }}</strong>
            <small>{{ t('common.questions', { count: group.ids.length }) }}</small>
          </div>

          <div class="mastery-bar">
            <div class="mastery-bar__seg mastery-bar__seg--mastered" :style="{ width: `${(group.counts.mastered / group.ids.length) * 100}%` }">
              <span v-if="group.counts.mastered">{{ group.counts.mastered }}</span>
            </div>
            <div class="mastery-bar__seg mastery-bar__seg--meh" :style="{ width: `${(group.counts.meh / group.ids.length) * 100}%` }">
              <span v-if="group.counts.meh">{{ group.counts.meh }}</span>
            </div>
            <div class="mastery-bar__seg mastery-bar__seg--baffled" :style="{ width: `${(group.counts.baffled / group.ids.length) * 100}%` }">
              <span v-if="group.counts.baffled">{{ group.counts.baffled }}</span>
            </div>
            <div class="mastery-bar__seg mastery-bar__seg--ignored" :style="{ width: `${(group.counts.ignored / group.ids.length) * 100}%` }">
              <span v-if="group.counts.ignored">{{ group.counts.ignored }}</span>
            </div>
          </div>

          <div class="breakdown-row__stats">
            <span class="pct-label">{{ group.pct }}%</span>
            <span v-if="group.avgSec" class="stat-chip stat-chip--time">{{ t('stats.timeChip', { value: formatSeconds(group.avgSec) }) }}</span>
          </div>

          <button class="pill-button" type="button" @click="startPractice(group)">{{ t('stats.practice') }}</button>
        </div>
      </div>
    </div>

    <section class="stats-selected">
      <p class="muted-copy">{{ t('stats.footerHint') }}</p>
    </section>
  </main>
</template>
