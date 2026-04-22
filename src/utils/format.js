export const MASTERY_STATUSES = ['mastered', 'meh', 'baffled', 'ignored'];

export const STATUS_META = {
  unseen: {
    labelKey: 'status.unseen.label',
    shortLabelKey: 'status.unseen.short',
    tone: 'unseen',
    marker: 'empty-light',
    descriptionKey: 'status.unseen.description'
  },
  mastered: {
    labelKey: 'status.mastered.label',
    shortLabelKey: 'status.mastered.short',
    tone: 'mastered',
    marker: 'solid',
    descriptionKey: 'status.mastered.description'
  },
  meh: {
    labelKey: 'status.meh.label',
    shortLabelKey: 'status.meh.short',
    tone: 'meh',
    marker: 'half',
    descriptionKey: 'status.meh.description'
  },
  baffled: {
    labelKey: 'status.baffled.label',
    shortLabelKey: 'status.baffled.short',
    tone: 'baffled',
    marker: 'empty',
    descriptionKey: 'status.baffled.description'
  },
  ignored: {
    labelKey: 'status.ignored.label',
    shortLabelKey: 'status.ignored.short',
    tone: 'ignored',
    marker: 'dashed',
    descriptionKey: 'status.ignored.description'
  },
  starred: {
    labelKey: 'status.starred.label',
    shortLabelKey: 'status.starred.short',
    tone: 'starred',
    marker: 'star',
    descriptionKey: 'status.starred.description'
  },
  skipped: {
    labelKey: 'status.skipped.label',
    shortLabelKey: 'status.skipped.short',
    tone: 'skipped',
    marker: 'empty',
    descriptionKey: 'status.skipped.description'
  },
  completed: {
    labelKey: 'status.completed.label',
    shortLabelKey: 'status.completed.short',
    tone: 'mastered',
    marker: 'solid',
    descriptionKey: 'status.completed.description'
  },
  graded: {
    labelKey: 'status.graded.label',
    shortLabelKey: 'status.graded.short',
    tone: 'mastered',
    marker: 'solid',
    descriptionKey: 'status.graded.description'
  },
  ungraded: {
    labelKey: 'status.ungraded.label',
    shortLabelKey: 'status.ungraded.short',
    tone: 'unseen',
    marker: 'empty-light',
    descriptionKey: 'status.ungraded.description'
  }
};

export const RANDOM_STATUS_FILTERS = ['unseen', 'meh', 'baffled'];

/* ── Cached O(1) progress lookups ────────────────────────────────────── */
const progressSetCache = new WeakMap();

/**
 * Lazily build and cache a Map<status, Set<id>> for the given progress
 * object.  The cache is keyed on the progress object *reference* via
 * WeakMap — whenever App.vue swaps the ref to a new object (which happens
 * on every API response via `applyRemoteState`), the old cache entry is
 * automatically garbage-collected.
 */
function getProgressSets(progress) {
  if (!progress) return null;
  let cached = progressSetCache.get(progress);
  if (cached) return cached;

  cached = {};
  for (const status of MASTERY_STATUSES) {
    cached[status] = new Set(progress[status] ?? []);
  }
  cached.starred = new Set(progress.starred ?? []);
  progressSetCache.set(progress, cached);
  return cached;
}

export function getProgressStatus(progress, id) {
  if (!progress || !id) return 'unseen';
  const sets = getProgressSets(progress);
  if (!sets) return 'unseen';
  for (const status of MASTERY_STATUSES) {
    if (sets[status].has(id)) return status;
  }
  return 'unseen';
}

export function isStarred(progress, id) {
  if (!progress || !id) return false;
  const sets = getProgressSets(progress);
  return sets ? sets.starred.has(id) : false;
}

export function formatQuestionTitle(question) {
  if (!question) return 'Question';
  return `Teil ${question.part} - Aufgabe ${String(question.number).padStart(2, '0')}`;
}

export function formatQuestionCompact(question) {
  if (!question) return '';
  const topic = question.topic ? ` · ${question.topic.toUpperCase()}` : '';
  return `T${question.part}-${String(question.number).padStart(2, '0')}${topic}`;
}

export function formatSeconds(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function formatExamTime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function groupByPart(questions, formatTitle = (part, count) => `Teil ${part} · ${count}`) {
  const partOne = questions.filter((question) => question.part === 1);
  const partTwo = questions.filter((question) => question.part === 2);
  return [
    { title: formatTitle(1, partOne.length), items: partOne },
    { title: formatTitle(2, partTwo.length), items: partTwo }
  ].filter((section) => section.items.length > 0);
}

export function scoreMaxFor(question) {
  if (!question) return 4;
  return question.part === 1 ? 1 : 4;
}

export function clampScore(question, value) {
  const max = scoreMaxFor(question);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(max, Math.max(0, Math.round(numeric * 2) / 2));
}
