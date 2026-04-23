<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import QuestionWorkspace from './components/QuestionWorkspace.vue';
import RightInspector from './components/RightInspector.vue';
import Sidebar from './components/Sidebar.vue';
import TopNav from './components/TopNav.vue';

import OnboardingGuide from './components/OnboardingGuide.vue';
import { useI18n } from './composables/useI18n.js';
import { useStopwatch } from './composables/useStopwatch.js';
import { useProfile } from './composables/useProfile.js';
import { useLibrary } from './composables/useLibrary.js';
import { useTheme } from './composables/useTheme.js';
import { api } from './services/api.js';
import {
  RANDOM_STATUS_FILTERS,
  STATUS_META,
  clampScore,
  formatQuestionCompact,
  formatQuestionTitle,
  formatSeconds,
  getProgressStatus,
  groupByPart,
  isStarred
} from './utils/format.js';

const StatsView = defineAsyncComponent(() => import('./components/StatsView.vue'));
const QuestionCanvas = defineAsyncComponent(() => import('./components/QuestionCanvas.vue'));
const SearchModal = defineAsyncComponent(() => import('./components/SearchModal.vue'));
const FilterModal = defineAsyncComponent(() => import('./components/FilterModal.vue'));
const PdfZoomModal = defineAsyncComponent(() => import('./components/PdfZoomModal.vue'));
const ExamSetupModal = defineAsyncComponent(() => import('./components/ExamSetupModal.vue'));
const ExamWorkspace = defineAsyncComponent(() => import('./components/ExamWorkspace.vue'));
const ConfirmDialog = defineAsyncComponent(() => import('./components/ConfirmDialog.vue'));
const SettingsModal = defineAsyncComponent(() => import('./components/SettingsModal.vue'));
const AppInfoModal = defineAsyncComponent(() => import('./components/AppInfoModal.vue'));
const AiChatPanel = defineAsyncComponent(() => import('./components/AiChatPanel.vue'));

const { locale, localeOptions, setLocale, t } = useI18n();
const { profileId, isGuest, saveProfile } = useProfile();
const { libraryId, saveLibrary } = useLibrary();
const { theme, setTheme } = useTheme();
const route = useRoute();
const router = useRouter();

const UI_STORAGE_KEYS = {
  leftCollapsed: 'qed.ui.leftCollapsed',
  rightCollapsed: 'qed.ui.rightCollapsed'
};

function readStoredBoolean(key, fallback = false) {
  if (typeof window === 'undefined') return fallback;
  const value = window.localStorage.getItem(key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function writeStoredBoolean(key, value) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, value ? 'true' : 'false');
}

const loading = ref(true);
const bootError = ref('');
const catalog = ref({ questions: [], suites: [], meta: { years: [], topics: [], parts: [], statuses: [] } });
const config = ref({ historyLimit: 500, examMinutes: 270, ui: {} });
const progress = ref({ mastered: [], meh: [], baffled: [], ignored: [], starred: [], attempts: {} });
const history = ref([]);
const probeHistory = ref([]);
const examDrafts = ref({ version: 1, drafts: [] });
const mode = ref('random');
const selectedSuiteId = ref('');
const currentQuestionId = ref('');
const answerVisible = ref(false);
const timerEnabled = ref(false);
const timerStarted = ref(false);
const currentAttemptId = ref('');
const randomBusy = ref(false);
const randomBlocked = ref('');
const downloadBusy = ref(false);
const aiBlocked = ref('');
const aiBusy = ref(false);
const aiDecompressing = ref(false);
const aiVisible = ref(false);
const browseAiQuestionId = ref('');
const aiHistory = ref([]);
const aiConversations = ref(new Map());
const activeAiConversationId = ref('');
const aiMeta = ref({
  hasServerApiKey: false,
  hasUserApiKey: false,
  canUseAi: false,
  canUseCustomModel: false,
  defaultModel: 'gpt-5.4-mini',
  model: 'gpt-5.4-mini'
});
const serverState = ref({
  showcaseMode: false,
  allowLibrarySwitch: false,
  activeLibraryId: 'library',
  activeLibraryPathName: 'library',
  defaultLibraryId: 'library',
  libraries: [{ id: 'library', label: 'library', pathName: 'library' }]
});
const filterOpen = ref(false);
const examSetupOpen = ref(false);
const searchOpen = ref(false);
const settingsOpen = ref(false);
const appInfoOpen = ref(false);
const zoomPayload = ref(null);
const leftCollapsed = ref(readStoredBoolean(UI_STORAGE_KEYS.leftCollapsed, false));
const rightCollapsed = ref(readStoredBoolean(UI_STORAGE_KEYS.rightCollapsed, false));
const browseAnswerIds = ref([]);
const browseAttemptIds = reactive({});
const browseCanvas = ref(null);
const browseSourceValue = ref('');
const statsSelectedStatus = ref('baffled');
const quickMenu = reactive({
  open: false,
  id: '',
  x: 0,
  y: 0
});
const aiRequestState = reactive({
  seq: 0,
  controller: null
});
let aiConversationLoadSeq = 0;

const appInfoLoading = ref(false);
const appInfoRefreshing = ref(false);
const appInfoError = ref('');
const appInfo = ref({
  appName: 'QED',
  version: __APP_VERSION__,
  gitCommit: null,
  questionCount: 0,
  suiteCount: 0,
  profileCount: 0,
  githubUrl: 'https://github.com/tangxiaoyi97/QED',
  authors: '唐晓翼 & 白清',
  acknowledgements: ['Claude', 'Codex'],
  license: 'MIT'
});

const filters = ref({
  statuses: [...RANDOM_STATUS_FILTERS],
  topics: [],
  parts: [1, 2],
  years: []
});

const stopwatch = useStopwatch();

const exam = reactive({
  active: false,
  suiteId: '',
  phase: 'taking',
  currentIndex: 0,
  remainingSeconds: 270 * 60,
  paused: false,
  records: {},
  grades: {},
  resultSaved: false
});

const confirmDialog = reactive({
  open: false,
  title: '',
  message: '',
  confirmLabel: '',
  onConfirm: null
});

let examInterval = null;

const NOTE_LABELS = {
  1: 'Sehr gut',
  2: 'Gut',
  3: 'Befriedigend',
  4: 'Genügend',
  5: 'Nicht genügend'
};

const effectiveGuest = computed(() => isGuest.value || serverState.value.showcaseMode);

const questions = computed(() => catalog.value.questions ?? []);
const suites = computed(() => catalog.value.suites ?? []);
const meta = computed(() => catalog.value.meta ?? { years: [], topics: [], parts: [], statuses: [] });
const questionsById = computed(() => new Map(questions.value.map((question) => [question.id, question])));
const suitesById = computed(() => new Map(suites.value.map((suite) => [suite.id, suite])));
const selectedSuite = computed(() => suitesById.value.get(selectedSuiteId.value) ?? suites.value[0] ?? null);
const selectedSuiteQuestions = computed(() => questionsForSuite(selectedSuite.value));
const browseQuestions = computed(() => {
  const value = browseSourceValue.value || (selectedSuite.value ? `suite:${selectedSuite.value.id}` : 'status:baffled');
  if (value === 'starred') {
    return idsToQuestions(progress.value.starred ?? []);
  }
  if (value.startsWith('status:')) {
    const status = value.slice('status:'.length);
    if (status === 'unseen') {
      return questions.value.filter((question) => getProgressStatus(progress.value, question.id) === 'unseen');
    }
    return idsToQuestions(progress.value[status] ?? []);
  }
  if (value.startsWith('suite:')) {
    return questionsForSuite(suitesById.value.get(value.slice('suite:'.length)));
  }
  return selectedSuiteQuestions.value;
});
const currentQuestion = computed(() => questionsById.value.get(currentQuestionId.value) ?? null);
const currentProgressStatus = computed(() => getProgressStatus(progress.value, currentQuestionId.value));
const currentStarred = computed(() => isStarred(progress.value, currentQuestionId.value));
const examDraftBySuiteId = computed(() => {
  const map = new Map();
  const drafts = Array.isArray(examDrafts.value?.drafts) ? examDrafts.value.drafts : [];
  for (const draft of drafts) {
    if (draft?.suiteId) map.set(draft.suiteId, draft);
  }
  return map;
});
const currentAiConversation = computed(() => {
  if (!activeAiConversationId.value) return null;
  return aiConversations.value.get(activeAiConversationId.value) ?? null;
});
const browseAiConversation = computed(() => {
  if (!browseAiQuestionId.value) return null;
  const meta = aiHistory.value.find((item) => item.questionId === browseAiQuestionId.value);
  if (!meta) return null;
  return aiConversations.value.get(meta.id) ?? null;
});
const aiTabConversation = computed(() => currentAiConversation.value);
const aiTabQuestion = computed(() => {
  const questionId = aiTabConversation.value?.questionId;
  return questionId ? questionsById.value.get(questionId) ?? null : null;
});
const displayProfileId = computed(() => (effectiveGuest.value ? 'guest' : profileId.value));

function normalizeLibraryToken(value) {
  const safe = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return safe || 'library';
}

function parseRouteModeToken(rawToken) {
  const token = String(rawToken ?? '');
  const [baseRaw, libraryRaw] = token.split('@');
  return {
    mode: (baseRaw || 'random').trim().toLowerCase(),
    libraryId: token.includes('@') ? normalizeLibraryToken(libraryRaw) : ''
  };
}

function modeTokenForRoute(baseMode) {
  if (serverState.value.allowLibrarySwitch) {
    const activeLibrary = normalizeLibraryToken(serverState.value.activeLibraryId || libraryId.value || 'library');
    return `${baseMode}@${activeLibrary}`;
  }
  return baseMode;
}

function buildRoutePath(profile, baseMode) {
  return `/${profile}/${modeTokenForRoute(baseMode)}`;
}

function statusLabel(status) {
  const metaItem = STATUS_META[status] ?? STATUS_META.unseen;
  return t(metaItem.labelKey);
}

function statusDescription(status) {
  const metaItem = STATUS_META[status] ?? STATUS_META.unseen;
  return t(metaItem.descriptionKey);
}

function statusOptionLabel(status, count) {
  return `${statusLabel(status)} (${count})`;
}

const browseSourceLabel = computed(() => {
  const option = browseHeaderOptions.value.find((item) => item.value === browseSourceValue.value);
  return option?.label?.replace(/\s*\(\d+\)$/, '') ?? t('sidebar.browseFallback');
});

const browseHeaderOptions = computed(() => [
  { value: 'starred', label: `★ ${statusOptionLabel('starred', progress.value.starred?.length ?? 0)}` },
  { value: 'status:baffled', label: statusOptionLabel('baffled', progress.value.baffled?.length ?? 0) },
  { value: 'status:meh', label: statusOptionLabel('meh', progress.value.meh?.length ?? 0) },
  { value: 'status:mastered', label: statusOptionLabel('mastered', progress.value.mastered?.length ?? 0) },
  { value: 'status:ignored', label: statusOptionLabel('ignored', progress.value.ignored?.length ?? 0) },
  { value: 'status:unseen', label: statusLabel('unseen') },
  ...suites.value.map((suite) => ({ value: `suite:${suite.id}`, label: suite.title }))
]);

const statsHeaderOptions = computed(() => [
  { value: 'baffled', label: statusOptionLabel('baffled', progress.value.baffled?.length ?? 0) },
  { value: 'meh', label: statusOptionLabel('meh', progress.value.meh?.length ?? 0) },
  { value: 'mastered', label: statusOptionLabel('mastered', progress.value.mastered?.length ?? 0) },
  { value: 'ignored', label: statusOptionLabel('ignored', progress.value.ignored?.length ?? 0) },
  { value: 'starred', label: statusOptionLabel('starred', progress.value.starred?.length ?? 0) },
  { value: 'unseen', label: statusLabel('unseen') }
]);

const sidebarSections = computed(() => {
  if (mode.value === 'random' || mode.value === 'records') return randomSidebarSections.value;
  if (mode.value === 'browse') return browseSidebarSections.value;
  if (mode.value === 'stats') return statsSidebarSections.value;
  if (mode.value === 'ai') return aiSidebarSections.value;
  return examSidebarSections.value;
});

const sidebarTitle = computed(() => {
  if (mode.value === 'random') return t('sidebar.title.history');
  if (mode.value === 'records') return t('sidebar.title.records');
  if (mode.value === 'browse') return t('sidebar.title.browse');
  if (mode.value === 'stats') return t('sidebar.title.stats');
  if (mode.value === 'ai') return t('sidebar.title.ai');
  if (exam.phase === 'grading') return t('sidebar.title.grading');
  if (exam.phase === 'results') return t('sidebar.title.results');
  return t('sidebar.title.exam');
});

const sidebarSubtitle = computed(() => {
  if (mode.value === 'random' || mode.value === 'records') return `${history.value.length}/${config.value.historyLimit ?? 500}`;
  if (mode.value === 'browse') return t('common.questions', { count: browseQuestions.value.length });
  if (mode.value === 'stats') return t('common.questions', { count: statsQuestions.value.length });
  if (mode.value === 'ai') return t('common.count', { count: aiHistory.value.length });
  if (exam.phase === 'results') return examResults.value ? `${examResults.value.totalScore}/36` : '';
  return `${exam.currentIndex + 1}/${examQuestions.value.length}`;
});

const randomSidebarSections = computed(() => {
  const items = history.value
    .map((entry, index) => {
      const question = questionsById.value.get(entry.id);
      if (!question) return null;
      const dotStatus = getProgressStatus(progress.value, question.id);
      const rowId = entry.attemptId || `${entry.at || 'history'}-${index}`;
      return {
        id: rowId,
        questionId: question.id,
        label: formatQuestionTitle(question),
        meta: question.suiteTitle,
        dotStatus,
        starred: isStarred(progress.value, question.id),
        dotLabel: statusLabel(dotStatus)
      };
    })
    .filter(Boolean);

  return items.length ? [{ title: t('sidebar.recent', { count: items.length }), items }] : [];
});

const browseSidebarSections = computed(() =>
  groupByPart(browseQuestions.value, (part, count) => t('groups.part', { part, count })).map((section) => ({
    title: section.title,
    items: section.items.map((question) => {
      const dotStatus = getProgressStatus(progress.value, question.id);
      return {
        id: question.id,
        label: formatQuestionCompact(question),
        dotStatus,
        starred: isStarred(progress.value, question.id),
        dotLabel: statusLabel(dotStatus)
      };
    })
  }))
);

const statsQuestions = computed(() => {
  const status = statsSelectedStatus.value;
  if (status === 'starred') return idsToQuestions(progress.value.starred ?? []);
  if (status === 'unseen') return questions.value.filter((question) => getProgressStatus(progress.value, question.id) === 'unseen');
  return idsToQuestions(progress.value[status] ?? []);
});

const statsSidebarSections = computed(() => [
  {
    title: statusLabel(statsSelectedStatus.value),
    items: statsQuestions.value.map((question) => {
      const dotStatus = getProgressStatus(progress.value, question.id);
      return {
        id: question.id,
        label: formatQuestionTitle(question),
        meta: `${question.suiteTitle} · ${question.topicLabel}`,
        dotStatus,
        starred: isStarred(progress.value, question.id),
        dotLabel: statusLabel(dotStatus)
      };
    })
  }
]);

const aiSidebarSections = computed(() => {
  const items = aiHistory.value.map((item) => {
    const question = questionsById.value.get(item.questionId);
    return {
      id: item.id,
      label: question ? formatQuestionCompact(question) : item.questionId,
      meta: item.preview || (question?.suiteTitle ?? ''),
      trailing: item.compressed ? t('ai.compressedTag') : '',
      dotStatus: item.compressed ? 'ungraded' : 'graded',
      dotLabel: item.compressed ? t('ai.compressedTag') : t('status.graded.label')
    };
  });
  return items.length > 0
    ? [{ title: t('ai.sidebarTitle', { count: items.length }), items }]
    : [];
});

const examQuestions = computed(() => questionsForSuite(suitesById.value.get(exam.suiteId)));
const currentExamQuestion = computed(() => examQuestions.value[exam.currentIndex] ?? null);
const currentExamGrade = computed(() => {
  const id = currentExamQuestion.value?.id;
  return id && Object.hasOwn(exam.grades, id) ? exam.grades[id] : null;
});

const examSidebarSections = computed(() => {
  if (exam.phase === 'results') {
    return [
      {
        title: t('sidebar.settlement'),
        items: examQuestions.value.map((question) => ({
          id: question.id,
          label: formatQuestionCompact(question),
          meta: t('common.points', { value: exam.grades[question.id] ?? 0 }),
          dotStatus: Object.hasOwn(exam.grades, question.id) ? 'graded' : 'ungraded',
          hollow: !Object.hasOwn(exam.grades, question.id),
          dotLabel: statusLabel(Object.hasOwn(exam.grades, question.id) ? 'graded' : 'ungraded')
        }))
      }
    ];
  }

  return groupByPart(examQuestions.value, (part, count) => t('groups.part', { part, count })).map((section) => ({
    title: section.title,
    items: section.items.map((question) => {
      if (exam.phase === 'grading') {
        const graded = Object.hasOwn(exam.grades, question.id);
        return {
          id: question.id,
          label: formatQuestionCompact(question),
          meta: graded ? t('common.points', { value: exam.grades[question.id] }) : statusLabel('ungraded'),
          dotStatus: graded ? 'graded' : 'ungraded',
          hollow: !graded,
          dotLabel: statusLabel(graded ? 'graded' : 'ungraded')
        };
      }

      const record = exam.records[question.id];
      const completed = record === 'completed';
      return {
        id: question.id,
        label: formatQuestionCompact(question),
        meta: completed ? statusLabel('completed') : record === 'skipped' ? t('exam.skip') : statusLabel('ungraded'),
        dotStatus: completed ? 'completed' : 'ungraded',
        hollow: !completed,
        dotLabel: completed ? statusLabel('completed') : statusLabel('ungraded')
      };
    })
  }));
});

const examResults = computed(() => {
  if (!exam.active) return null;
  const suite = suitesById.value.get(exam.suiteId);
  const t1Questions = examQuestions.value.filter((question) => question.part === 1);
  const t2Questions = examQuestions.value
    .filter((question) => question.part === 2)
    .sort((a, b) => a.number - b.number);
  const t1Score = roundScore(sumScores(t1Questions));
  const mandatoryQuestion = t2Questions[0] ?? null;
  const optionalQuestions = t2Questions.slice(1);
  const optionalRanked = optionalQuestions
    .map((question) => ({
      question,
      score: roundScore(exam.grades[question.id] ?? 0)
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.question.number - b.question.number;
    });
  const countedOptionalIds = new Set(optionalRanked.slice(0, 2).map((item) => item.question.id));
  const t2Items = t2Questions.map((question) => {
    const score = roundScore(exam.grades[question.id] ?? 0);
    const counted = question.id === mandatoryQuestion?.id || countedOptionalIds.has(question.id);
    return {
      id: question.id,
      label: formatQuestionTitle(question),
      score,
      maxScore: 4,
      counted
    };
  });
  const t2Score = roundScore(
    t2Items
      .filter((item) => item.counted)
      .reduce((sum, item) => sum + item.score, 0)
  );
  const totalScore = roundScore(t1Score + t2Score);
  const note = scoreToNote(totalScore);

  return {
    suiteId: exam.suiteId,
    suiteTitle: suite?.title ?? t('sidebar.title.exam'),
    totalScore,
    note,
    noteLabel: note ? NOTE_LABELS[note] ?? '' : '',
    t1Score,
    t2Score,
    t1Count: t1Questions.length,
    t2Items
  };
});

// Sync profile and mode from route params
watch(
  () => route.params,
  async (params) => {
    if (!params) return;
    const routeProfile = String(params.profile || '');
    const parsedRoute = parseRouteModeToken(params.mode);

    // If profile changed, re-bootstrap
    if (routeProfile && routeProfile !== profileId.value) {
      saveProfile(routeProfile);
      await bootstrap();
      return;
    }

    if (parsedRoute.libraryId && parsedRoute.libraryId !== libraryId.value) {
      saveLibrary(parsedRoute.libraryId);
    }

    // Sync mode
    if (parsedRoute.mode && parsedRoute.mode !== mode.value) {
      switchModeLocal(parsedRoute.mode);
    }
  },
  { immediate: false }
);

// Generation counter — incremented each time bootstrap() starts.
// Any in-flight bootstrap that sees its gen no longer matches the latest
// will discard its response, preventing races when the user switches
// profiles rapidly across multiple tabs or clicks.
let _bootstrapGen = 0;

async function bootstrap() {
  cancelAiRequest();
  const gen = ++_bootstrapGen;
  loading.value = true;
  bootError.value = '';
  catalog.value = { questions: [], suites: [], meta: { years: [], topics: [], parts: [], statuses: [] } };
  progress.value = { mastered: [], meh: [], baffled: [], ignored: [], starred: [], attempts: {} };
  history.value = [];
  probeHistory.value = [];
  examDrafts.value = { version: 1, drafts: [] };
  aiHistory.value = [];
  aiConversations.value = new Map();
  activeAiConversationId.value = '';
  aiVisible.value = false;
  browseAiQuestionId.value = '';
  aiBlocked.value = '';

  try {
    if (isGuest.value) {
      // Guest mode: only load catalog (no user data written).
      // Keep whatever locale useI18n already resolved from localStorage/browser —
      // guests have no server-side persistence, so do not force a default here.
      const catalogData = await api.catalog();
      if (gen !== _bootstrapGen) return; // a newer bootstrap superseded this one
      catalog.value = catalogData;
      if (catalogData?.server) {
        serverState.value = catalogData.server;
        if (catalogData.server.activeLibraryId) saveLibrary(catalogData.server.activeLibraryId);
      }
      config.value = { historyLimit: 500, examMinutes: 270, locale: locale.value, ui: { theme: theme.value } };
      aiMeta.value = {
        hasServerApiKey: false,
        hasUserApiKey: false,
        canUseAi: false,
        canUseCustomModel: false,
        defaultModel: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini'
      };
      selectedSuiteId.value = suites.value[0]?.id ?? '';
      browseSourceValue.value = selectedSuiteId.value ? `suite:${selectedSuiteId.value}` : 'status:baffled';
      currentQuestionId.value = selectedSuiteQuestions.value[0]?.id ?? '';
    } else {
      const payload = await api.bootstrap();
      if (gen !== _bootstrapGen) return; // superseded
      catalog.value = payload.catalog;
      config.value = payload.state.config;
      if (config.value.locale) setLocale(config.value.locale);
      if (config.value.ui?.theme) setTheme(config.value.ui.theme);
      progress.value = payload.state.progress;
      history.value = payload.state.history;
      probeHistory.value = payload.state.probeHistory;
      examDrafts.value = payload.state.examDrafts ?? { version: 1, drafts: [] };
      aiMeta.value = payload.state.aiMeta ?? aiMeta.value;
      if (payload.state.server) {
        serverState.value = payload.state.server;
        if (payload.state.server.activeLibraryId) saveLibrary(payload.state.server.activeLibraryId);
      }
      selectedSuiteId.value = suites.value[0]?.id ?? '';
      browseSourceValue.value = selectedSuiteId.value ? `suite:${selectedSuiteId.value}` : 'status:baffled';
      currentQuestionId.value = payload.firstQuestion?.id ?? selectedSuiteQuestions.value[0]?.id ?? '';
      await loadAiHistory();
    }
  } catch (error) {
    if (gen !== _bootstrapGen) return;
    if (error?.payload?.error === 'PROFILE_NOT_FOUND') {
      saveProfile('guest');
      const targetPath = buildRoutePath('guest', mode.value);
      if (route.path !== targetPath) {
        await router.replace(targetPath);
      }
      if (gen === _bootstrapGen) {
        await bootstrap();
      }
      return;
    }
    bootError.value = error.message || t('errors.startupFailed');
  } finally {
    if (gen === _bootstrapGen) loading.value = false;
  }

  if (gen === _bootstrapGen && !bootError.value && mode.value === 'random' && !currentQuestionId.value) {
    drawRandom();
  }

  if (gen === _bootstrapGen && !bootError.value) {
    if (serverState.value.showcaseMode && profileId.value !== 'guest') {
      saveProfile('guest');
    }
    const targetPath = buildRoutePath(serverState.value.showcaseMode ? 'guest' : profileId.value, mode.value);
    if (route.path !== targetPath) {
      router.replace(targetPath);
    }
  }
}

onMounted(async () => {
  // Sync profile from route on first load
  const routeProfile = route.params?.profile;
  if (routeProfile && routeProfile !== profileId.value) {
    saveProfile(routeProfile);
  }
  const parsedRoute = parseRouteModeToken(route.params?.mode);
  if (parsedRoute.libraryId) {
    saveLibrary(parsedRoute.libraryId);
  }
  // Sync mode from route on first load
  if (parsedRoute.mode && parsedRoute.mode !== mode.value) {
    switchModeLocal(parsedRoute.mode);
  }
  await bootstrap();
});

watch(
  () => [exam.active, exam.paused, exam.phase],
  () => syncExamClock()
);

watch(
  leftCollapsed,
  (value) => writeStoredBoolean(UI_STORAGE_KEYS.leftCollapsed, value),
  { immediate: true }
);

watch(
  rightCollapsed,
  (value) => writeStoredBoolean(UI_STORAGE_KEYS.rightCollapsed, value),
  { immediate: true }
);

watch(
  aiHistory,
  (items) => {
    if (!Array.isArray(items) || items.length === 0) {
      activeAiConversationId.value = '';
      return;
    }
    if (!activeAiConversationId.value || !items.some((item) => item.id === activeAiConversationId.value)) {
      activeAiConversationId.value = items[0].id;
    }
  },
  { deep: true }
);

onBeforeUnmount(() => {
  stopExamClock();
  cancelAiRequest();
});

function questionsForSuite(suite) {
  if (!suite) return [];
  return suite.questionIds.map((id) => questionsById.value.get(id)).filter(Boolean);
}

function idsToQuestions(ids) {
  return ids.map((id) => questionsById.value.get(id)).filter(Boolean);
}

function applyRemoteState(payload) {
  if (payload.config) {
    config.value = payload.config;
    if (payload.config.ui?.theme) setTheme(payload.config.ui.theme);
  }
  if (payload.progress) progress.value = payload.progress;
  if (payload.history) history.value = payload.history;
  if (payload.probeHistory) probeHistory.value = payload.probeHistory;
  if (payload.examDrafts) examDrafts.value = payload.examDrafts;
  if (payload.aiMeta) aiMeta.value = payload.aiMeta;
  if (payload.server) {
    serverState.value = payload.server;
    if (payload.server.activeLibraryId) saveLibrary(payload.server.activeLibraryId);
  }
}

function applyCatalogData(nextCatalog) {
  if (!nextCatalog || !Array.isArray(nextCatalog.questions) || !Array.isArray(nextCatalog.suites)) return;
  const previousQuestionId = currentQuestionId.value;
  const previousSuiteId = selectedSuiteId.value;

  catalog.value = nextCatalog;
  selectedSuiteId.value = previousSuiteId && suitesById.value.has(previousSuiteId)
    ? previousSuiteId
    : (suites.value[0]?.id ?? '');

  if (previousQuestionId && questionsById.value.has(previousQuestionId)) {
    currentQuestionId.value = previousQuestionId;
    return;
  }

  if (mode.value === 'browse') {
    currentQuestionId.value = browseQuestions.value[0]?.id ?? '';
    return;
  }

  if (mode.value === 'stats') {
    currentQuestionId.value = statsQuestions.value[0]?.id ?? '';
    return;
  }

  const latest = history.value.find((entry) => questionsById.value.has(entry.id));
  currentQuestionId.value = latest?.id ?? selectedSuiteQuestions.value[0]?.id ?? '';
}

async function loadAppInfo() {
  appInfoLoading.value = true;
  appInfoError.value = '';
  try {
    const payload = await api.about();
    appInfo.value = {
      ...appInfo.value,
      ...payload
    };
  } catch (error) {
    appInfoError.value = error.message || t('errors.requestFailed');
  } finally {
    appInfoLoading.value = false;
  }
}

function openAppInfoModal() {
  appInfoOpen.value = true;
  loadAppInfo();
}

async function refreshCatalogFromInfoModal() {
  if (appInfoRefreshing.value) return;
  appInfoRefreshing.value = true;
  appInfoError.value = '';
  try {
    await api.refreshCatalog();
    const latestCatalog = await api.catalog();
    applyCatalogData(latestCatalog);
    await loadAppInfo();
  } catch (error) {
    appInfoError.value = error.message || t('errors.requestFailed');
  } finally {
    appInfoRefreshing.value = false;
  }
}

async function handleLocaleChange(nextLocale) {
  setLocale(nextLocale);
  if (effectiveGuest.value) return;
  try {
    const payload = await api.setConfig({ locale: nextLocale });
    if (payload?.config) config.value = payload.config;
  } catch {
    // Non-fatal: localStorage already holds the new locale so the UI stays consistent.
  }
}

async function handleThemeChange(nextTheme) {
  const safeTheme = setTheme(nextTheme === 'dark' ? 'dark' : 'light');
  config.value = {
    ...config.value,
    ui: {
      ...(config.value.ui ?? {}),
      theme: safeTheme
    }
  };
  if (effectiveGuest.value) return;
  try {
    const payload = await api.setConfig({ theme: safeTheme });
    applyRemoteState(payload);
  } catch {
    // Theme is already persisted locally; server sync can retry on the next settings save.
  }
}

function resetQuestionSurface() {
  answerVisible.value = false;
  aiVisible.value = false;
  timerStarted.value = false;
  currentAttemptId.value = '';
  stopwatch.reset();
}

function cancelAiRequest() {
  if (aiRequestState.controller) {
    aiRequestState.controller.abort();
    aiRequestState.controller = null;
  }
  aiBusy.value = false;
}

async function drawRandom(options = {}) {
  const { force = false } = options;
  if (randomBusy.value && !force) return;
  randomBusy.value = true;
  randomBlocked.value = '';
  try {
    const payload = await api.random(filters.value);
    applyRemoteState(payload);
    currentQuestionId.value = payload.question.id;
    mode.value = 'random';
    rightCollapsed.value = false;
    resetQuestionSurface();
  } catch (error) {
    randomBlocked.value = error.message || t('errors.randomFailed');
    currentQuestionId.value = '';
    resetQuestionSurface();
  } finally {
    randomBusy.value = false;
  }
}

// Switch mode without touching the URL (called from route watcher)
function switchModeLocal(nextMode) {
  if (nextMode !== 'ai') {
    cancelAiRequest();
  }
  if (nextMode === 'random') {
    mode.value = 'random';
    rightCollapsed.value = false;
    if (!currentQuestion.value) drawRandom();
    return;
  }
  if (nextMode === 'stats') {
    mode.value = 'stats';
    rightCollapsed.value = true;
    const first = statsQuestions.value[0];
    currentQuestionId.value = first?.id ?? '';
    resetQuestionSurface();
    return;
  }
  if (nextMode === 'ai') {
    if (effectiveGuest.value) {
      mode.value = 'random';
      rightCollapsed.value = false;
      if (parseRouteModeToken(route.params?.mode).mode === 'ai') {
        router.replace(buildRoutePath(profileId.value, 'random'));
      }
      return;
    }
    mode.value = 'ai';
    rightCollapsed.value = true;
    if (!activeAiConversationId.value && aiHistory.value.length > 0) {
      activeAiConversationId.value = aiHistory.value[0].id;
    }
    if (activeAiConversationId.value) {
      loadAiConversationById(activeAiConversationId.value);
    }
    return;
  }
  if (nextMode === 'records') {
    mode.value = 'records';
    rightCollapsed.value = false;
    const latest = history.value.find((entry) => questionsById.value.has(entry.id));
    currentQuestionId.value = latest?.id ?? currentQuestionId.value;
    resetQuestionSurface();
    return;
  }
  mode.value = 'browse';
  rightCollapsed.value = true;
  if (!browseSourceValue.value) browseSourceValue.value = selectedSuiteId.value ? `suite:${selectedSuiteId.value}` : 'status:baffled';
  const first = browseQuestions.value[0];
  if (first) currentQuestionId.value = first.id;
  resetQuestionSurface();
}

// Called by TopNav — updates the URL which triggers route watcher
function switchMode(nextMode) {
  const profile = profileId.value;
  router.push(buildRoutePath(profile, nextMode));
}

function selectSuite(suiteId) {
  cancelAiRequest();
  selectedSuiteId.value = suiteId;
  browseSourceValue.value = `suite:${suiteId}`;
  // Apply state immediately, then sync URL (router.replace — no new history entry)
  mode.value = 'browse';
  rightCollapsed.value = true;
  browseAnswerIds.value = [];
  browseAiQuestionId.value = '';
  const first = browseQuestions.value[0];
  currentQuestionId.value = first?.id ?? '';
  resetQuestionSurface();
  router.replace(buildRoutePath(profileId.value, 'browse'));
}

function changeSidebarHeader(value) {
  if (mode.value === 'browse') {
    cancelAiRequest();
    browseSourceValue.value = value;
    if (value.startsWith('suite:')) selectedSuiteId.value = value.slice('suite:'.length);
    browseAnswerIds.value = [];
    browseAiQuestionId.value = '';
    const first = browseQuestions.value[0];
    currentQuestionId.value = first?.id ?? '';
    resetQuestionSurface();
    return;
  }

  if (mode.value === 'stats') {
    statsSelectedStatus.value = value;
    const first = statsQuestions.value[0];
    currentQuestionId.value = first?.id ?? '';
  }
}

function selectSidebarItem(id) {
  cancelAiRequest();
  if (mode.value === 'ai') {
    selectAiConversation(id);
    return;
  }

  if (mode.value === 'exam') {
    const index = examQuestions.value.findIndex((question) => question.id === id);
    if (index >= 0) {
      if (exam.phase === 'results') exam.phase = 'grading';
      exam.currentIndex = index;
    }
    return;
  }

  currentQuestionId.value = id;
  if (mode.value === 'browse') {
    browseCanvas.value?.scrollToQuestion(id);
    return;
  }
  if (mode.value === 'stats') {
    // Jumping to a question from stats switches to records mode — keep URL in sync
    mode.value = 'records';
    router.replace(buildRoutePath(profileId.value, 'records'));
  }
  resetQuestionSurface();
}

function startTimer() {
  timerStarted.value = true;
  stopwatch.start();
}

function toggleTimer(enabled) {
  timerEnabled.value = enabled;
  resetQuestionSurface();
}

async function showAnswer() {
  if (!currentQuestion.value) return;
  cancelAiRequest();
  aiVisible.value = false;
  answerVisible.value = true;
  stopwatch.stop();
  const attemptId = ensureCurrentAttemptId(currentQuestion.value.id);
  await recordViewedAttempt(currentQuestion.value.id, attemptId, mode.value);
}

function showQuestion() {
  cancelAiRequest();
  answerVisible.value = false;
  aiVisible.value = false;
}

function canUseAiNow() {
  if (effectiveGuest.value) return false;
  if (aiMeta.value?.canUseAi) return true;
  return Boolean(config.value?.ai?.apiKey);
}

function aiDisabledReason() {
  if (effectiveGuest.value) return t('ai.disabledGuest');
  if (!canUseAiNow()) return t('ai.disabledNoKey');
  return '';
}

function upsertAiConversation(conversation) {
  if (!conversation || !conversation.id) return;
  const map = new Map(aiConversations.value);
  map.set(conversation.id, conversation);
  aiConversations.value = map;
}

function upsertAiHistoryItem(item) {
  if (!item || !item.id) return;
  const merged = [item, ...aiHistory.value.filter((entry) => entry.id !== item.id)].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  aiHistory.value = merged;
}

function toAiHistoryItem(conversation) {
  if (!conversation) return null;
  const question = questionsById.value.get(conversation.questionId);
  const previewMessage = [...(conversation.messages ?? [])]
    .reverse()
    .find((message) => typeof message.content === 'string' && message.content.trim());
  return {
    id: conversation.id,
    questionId: conversation.questionId,
    questionLabel: question?.label ?? conversation.questionId,
    questionTitle: question ? `${question.sourceLabel} · ${question.label}` : conversation.questionId,
    suiteTitle: question?.suiteTitle ?? '',
    model: conversation.model ?? config.value?.ai?.model ?? aiMeta.value?.defaultModel ?? 'gpt-5.4-mini',
    createdAt: conversation.createdAt ?? new Date().toISOString(),
    updatedAt: conversation.updatedAt ?? new Date().toISOString(),
    compressed: false,
    messageCount: conversation.messages?.length ?? 0,
    preview: previewMessage?.content?.slice(0, 220) ?? ''
  };
}

function applyAiPayload(payload) {
  if (payload?.aiMeta) {
    aiMeta.value = payload.aiMeta;
  }
  if (Array.isArray(payload?.conversations)) {
    aiHistory.value = payload.conversations;
  }
  if (payload?.conversation) {
    upsertAiConversation(payload.conversation);
    if (!Array.isArray(payload?.conversations)) {
      const meta = toAiHistoryItem(payload.conversation);
      if (meta) upsertAiHistoryItem(meta);
    }
  }
}

async function loadAiHistory() {
  if (effectiveGuest.value) {
    aiHistory.value = [];
    return;
  }
  try {
    const payload = await api.aiHistory();
    aiHistory.value = Array.isArray(payload?.conversations) ? payload.conversations : [];
    if (!activeAiConversationId.value && aiHistory.value.length > 0) {
      activeAiConversationId.value = aiHistory.value[0].id;
    }
    if (mode.value === 'ai' && activeAiConversationId.value) {
      await loadAiConversationById(activeAiConversationId.value);
    }
  } catch (error) {
    aiBlocked.value = error.message || t('errors.requestFailed');
  }
}

async function loadAiConversationById(conversationId) {
  if (!conversationId) return null;
  const already = aiConversations.value.get(conversationId);
  if (already) return already;
  const loadSeq = ++aiConversationLoadSeq;
  aiDecompressing.value = true;
  aiBlocked.value = '';
  try {
    const payload = await api.aiConversation(conversationId);
    applyAiPayload(payload);
    return payload?.conversation ?? null;
  } catch (error) {
    if (loadSeq === aiConversationLoadSeq && activeAiConversationId.value === conversationId) {
      aiBlocked.value = error.message || t('errors.requestFailed');
    }
    return null;
  } finally {
    if (loadSeq === aiConversationLoadSeq) {
      aiDecompressing.value = false;
    }
  }
}

async function openAiForQuestion(questionId, surface = 'main') {
  if (!questionId) return;
  aiBlocked.value = '';
  if (!canUseAiNow()) {
    if (surface === 'main') {
      answerVisible.value = false;
      aiVisible.value = true;
    }
    if (surface === 'browse') {
      browseAnswerIds.value = browseAnswerIds.value.filter((id) => id !== questionId);
      browseAiQuestionId.value = questionId;
    }
    aiBlocked.value = aiDisabledReason();
    return;
  }

  if (surface === 'main') {
    answerVisible.value = false;
    aiVisible.value = true;
    // Point the active conversation at whatever we already have for this
    // question (if anything); otherwise clear it so the panel doesn't keep
    // rendering the previous question's chat while we wait for the server.
    const existingMeta = aiHistory.value.find((item) => item.questionId === questionId);
    activeAiConversationId.value = existingMeta?.id ?? '';
  }
  if (surface === 'browse') {
    browseAnswerIds.value = browseAnswerIds.value.filter((id) => id !== questionId);
    browseAiQuestionId.value = questionId;
  }

  cancelAiRequest();
  const requestSeq = ++aiRequestState.seq;
  const controller = new AbortController();
  aiRequestState.controller = controller;
  aiBusy.value = true;
  try {
    const payload = await api.aiOpen(questionId, {
      signal: controller.signal,
      locale: locale.value
    });
    // Always merge payload into local history so records are not "lost" even if
    // the user switched tabs/views while the request was in flight.
    applyAiPayload(payload);
    // Drop stale response: user may have switched questions or surfaces while
    // this request was in flight.
    const stillRelevant = surface === 'main'
      ? aiVisible.value && currentQuestionId.value === questionId
      : browseAiQuestionId.value === questionId;
    if (surface === 'main' && stillRelevant && payload?.conversation?.id) {
      activeAiConversationId.value = payload.conversation.id;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    aiBlocked.value = error.message || t('errors.requestFailed');
  } finally {
    if (aiRequestState.seq === requestSeq) {
      aiBusy.value = false;
    }
    if (aiRequestState.controller === controller) {
      aiRequestState.controller = null;
    }
  }
}

async function sendAiMessage(conversationId, content, { surface = 'main' } = {}) {
  if (!conversationId || !content?.trim()) return;
  if (!canUseAiNow()) {
    aiBlocked.value = aiDisabledReason();
    return;
  }

  cancelAiRequest();
  const requestSeq = ++aiRequestState.seq;
  const controller = new AbortController();
  aiRequestState.controller = controller;
  aiBusy.value = true;
  aiBlocked.value = '';
  try {
    const payload = await api.aiMessage(
      conversationId,
      content,
      config.value?.ai?.model ?? 'gpt-5.4-mini',
      {
        signal: controller.signal,
        locale: locale.value
      }
    );
    applyAiPayload(payload);
    if (surface !== 'browse' && payload?.conversation?.id) {
      activeAiConversationId.value = payload.conversation.id;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    aiBlocked.value = error.message || t('errors.requestFailed');
  } finally {
    if (aiRequestState.seq === requestSeq) {
      aiBusy.value = false;
    }
    if (aiRequestState.controller === controller) {
      aiRequestState.controller = null;
    }
  }
}

async function askCurrentQuestionAi() {
  if (!currentQuestion.value) return;
  if (aiBusy.value) return;
  const questionId = currentQuestion.value.id;
  stopwatch.stop();
  // Mirror showAnswer: asking AI explanation counts as viewing the item.
  const attemptId = ensureCurrentAttemptId(questionId);
  recordViewedAttempt(questionId, attemptId, mode.value).catch(() => {});
  await openAiForQuestion(questionId, 'main');
}

async function askBrowseQuestionAi(id) {
  if (!id) return;
  if (aiBusy.value) return;
  if (!effectiveGuest.value && questionsById.value.has(id)) {
    const attemptId = ensureBrowseAttemptId(id);
    recordViewedAttempt(id, attemptId, 'browse').catch(() => {});
  }
  await openAiForQuestion(id, 'browse');
}

async function sendCurrentAiMessage(content) {
  if (!activeAiConversationId.value) return;
  await sendAiMessage(activeAiConversationId.value, content, { surface: 'main' });
}

async function sendBrowseAiMessage(content) {
  const conversationId = browseAiConversation.value?.id ?? '';
  if (!conversationId) return;
  await sendAiMessage(conversationId, content, { surface: 'browse' });
}

async function selectAiConversation(conversationId) {
  if (!conversationId) return;
  activeAiConversationId.value = conversationId;
  await loadAiConversationById(conversationId);
}

async function saveAiSettings({ apiKey, model, customPrompt }) {
  if (effectiveGuest.value) return;
  try {
    const payload = await api.setConfig({
      aiApiKey: apiKey ?? '',
      aiModel: model ?? config.value?.ai?.model ?? 'gpt-5.4-mini',
      aiCustomPrompt: customPrompt ?? config.value?.ai?.customPrompt ?? ''
    });
    applyRemoteState(payload);
    if (payload?.aiMeta) aiMeta.value = payload.aiMeta;
  } catch (error) {
    aiBlocked.value = error.message || t('errors.requestFailed');
  }
}

async function rateQuestion(status) {
  if (!currentQuestion.value || effectiveGuest.value) return;
  if (randomBusy.value) return;
  randomBusy.value = true;
  let shouldDrawNext = false;
  const attemptId = ensureCurrentAttemptId(currentQuestion.value.id);
  try {
    const payload = await api.setProgress(currentQuestion.value.id, status, interactionPayload(attemptId, mode.value));
    applyRemoteState(payload);
    shouldDrawNext = mode.value === 'random';
  } catch (error) {
    randomBlocked.value = error.message || t('errors.saveProgressFailed');
  } finally {
    randomBusy.value = false;
  }
  if (shouldDrawNext) {
    await drawRandom({ force: true });
  }
}

async function toggleStar(id = currentQuestionId.value) {
  if (!id || effectiveGuest.value) return;
  const currentlyStarred = isStarred(progress.value, id);
  // Optimistic UI update
  const newStarred = currentlyStarred
    ? (progress.value.starred || []).filter((sid) => sid !== id)
    : [...(progress.value.starred || []), id];
  progress.value = { ...progress.value, starred: newStarred };

  try {
    const payload = await api.setStar(id, !currentlyStarred);
    applyRemoteState(payload);
  } catch (error) {
    // Revert optimistic update on error
    const revertedStarred = currentlyStarred
      ? [...(progress.value.starred || []), id]
      : (progress.value.starred || []).filter((sid) => sid !== id);
    progress.value = { ...progress.value, starred: revertedStarred };
    randomBlocked.value = error.message || t('errors.starFailed');
  }
}

async function skipQuestion() {
  if (!currentQuestion.value) return;
  if (randomBusy.value) return;
  stopwatch.stop();
  // Keep Reroll behavior aligned with toolbar "Draw Again":
  // draw a new question without writing a history entry.
  await drawRandom();
}

async function showBrowseAnswer(id) {
  if (!questionsById.value.has(id)) return;
  cancelAiRequest();
  if (browseAiQuestionId.value === id) browseAiQuestionId.value = '';
  if (!browseAnswerIds.value.includes(id)) browseAnswerIds.value.push(id);
  const attemptId = ensureBrowseAttemptId(id);
  await recordViewedAttempt(id, attemptId, 'browse');
}

function showBrowseQuestion(id) {
  cancelAiRequest();
  browseAnswerIds.value = browseAnswerIds.value.filter((storedId) => storedId !== id);
  if (browseAiQuestionId.value === id) {
    browseAiQuestionId.value = '';
  }
}

async function rateBrowseQuestion(id, status) {
  if (!questionsById.value.has(id) || effectiveGuest.value) return;
  const attemptId = ensureBrowseAttemptId(id);
  try {
    applyRemoteState(await api.setProgress(id, status, interactionPayload(attemptId, 'browse')));
  } catch (error) {
    randomBlocked.value = error.message || t('errors.saveProgressFailed');
  }
}

async function quickMarkQuestion(id, status) {
  if (effectiveGuest.value) return;
  closeQuickMenu();
  if (status === 'starred') {
    await toggleStar(id);
    return;
  }
  const attemptId = mode.value === 'browse' ? ensureBrowseAttemptId(id) : makeAttemptId(id);
  try {
    applyRemoteState(await api.setProgress(id, status, interactionPayload(attemptId, mode.value)));
  } catch (error) {
    randomBlocked.value = error.message || t('errors.quickMarkFailed');
  }
}

function openQuickMenu(id, event) {
  if (mode.value === 'exam') return;
  quickMenu.open = true;
  quickMenu.id = id;
  quickMenu.x = Math.max(8, Math.min(event.clientX, window.innerWidth - 188));
  quickMenu.y = Math.max(8, Math.min(event.clientY, window.innerHeight - 196));
}

function closeQuickMenu() {
  quickMenu.open = false;
  quickMenu.id = '';
}

function openZoom(payload) {
  zoomPayload.value = payload;
}

function selectSearchResult(id) {
  searchOpen.value = false;
  mode.value = 'records';
  rightCollapsed.value = false;
  currentQuestionId.value = id;
  resetQuestionSurface();
}

function setBrowseActive(id) {
  currentQuestionId.value = id;
}

async function downloadCurrentQuestion() {
  if (!currentQuestion.value?.id || downloadBusy.value) return;
  downloadBusy.value = true;
  randomBlocked.value = '';
  try {
    const payload = await api.createQuestionDownloadLink(currentQuestion.value.id);
    const linkUrl = new URL(payload.url, window.location.origin).toString();
    const anchor = document.createElement('a');
    anchor.href = linkUrl;
    anchor.download = payload.filename || `${currentQuestion.value.id}.pdf`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    randomBlocked.value = error.message || t('errors.requestFailed');
  } finally {
    downloadBusy.value = false;
  }
}

function ensureCurrentAttemptId(id) {
  if (!currentAttemptId.value) currentAttemptId.value = makeAttemptId(id);
  return currentAttemptId.value;
}

function ensureBrowseAttemptId(id) {
  if (!browseAttemptIds[id]) browseAttemptIds[id] = makeAttemptId(id);
  return browseAttemptIds[id];
}

function interactionPayload(attemptId, interactionMode) {
  return {
    attemptId,
    mode: interactionMode,
    timed: Boolean(timerEnabled.value),
    elapsedSeconds: timerEnabled.value ? stopwatch.elapsedSeconds.value : null
  };
}

async function recordViewedAttempt(questionId, attemptId, interactionMode) {
  // Guests can view answers/AI but these actions should not write state.
  if (effectiveGuest.value) return true;
  try {
    const payload = await api.finishHistory(questionId, 'skipped', interactionPayload(attemptId, interactionMode));
    applyRemoteState(payload);
    return true;
  } catch (error) {
    randomBlocked.value = error.message || t('errors.saveHistoryFailed');
    return false;
  }
}

function makeAttemptId(id) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${id}-${Math.random().toString(16).slice(2)}`;
}

function applyFilters(nextFilters) {
  filters.value = nextFilters;
  filterOpen.value = false;
  drawRandom();
}

async function startExam(suiteId) {
  if (effectiveGuest.value) return;
  const suite = suitesById.value.get(suiteId);
  if (!suite) return;

  const draft = examDraftBySuiteId.value.get(suiteId) ?? null;
  let shouldResume = false;
  if (draft) {
    shouldResume = window.confirm(t('exam.resumePrompt', { date: draft.updatedAt.slice(0, 10) }));
    if (!shouldResume) {
      await clearExamDraft(suiteId);
    }
  }

  examSetupOpen.value = false;
  mode.value = 'exam';
  exam.active = true;
  exam.suiteId = suiteId;
  exam.phase = shouldResume ? draft.phase ?? 'taking' : 'taking';
  exam.currentIndex = shouldResume ? Math.max(0, Number(draft.currentIndex) || 0) : 0;
  exam.remainingSeconds = shouldResume
    ? Math.max(0, Number(draft.remainingSeconds) || 0)
    : (config.value.examMinutes ?? 270) * 60;
  exam.paused = shouldResume ? Boolean(draft.paused) : false;
  exam.records = shouldResume ? { ...(draft.records ?? {}) } : {};
  exam.grades = shouldResume ? { ...(draft.grades ?? {}) } : {};
  exam.resultSaved = false;

  try {
    if (document.fullscreenElement !== document.documentElement) {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // Fullscreen can be denied by the browser; the exam flow still runs.
  }
}

function completeExamQuestion() {
  const question = currentExamQuestion.value;
  if (!question) return;

  if (exam.currentIndex >= examQuestions.value.length - 1) {
    askConfirm({
      title: t('confirm.submitPaperTitle'),
      message: t('confirm.submitPaperMessage'),
      confirmLabel: t('confirm.startGrading'),
      onConfirm: () => {
        exam.records[question.id] = 'completed';
        beginGrading();
      }
    });
    return;
  }

  exam.records[question.id] = 'completed';
  exam.currentIndex += 1;
}

function skipExamQuestion() {
  const question = currentExamQuestion.value;
  if (!question || exam.currentIndex >= examQuestions.value.length - 1) return;
  exam.records[question.id] = 'skipped';
  exam.currentIndex += 1;
}

function previousExamQuestion() {
  if (exam.currentIndex > 0) exam.currentIndex -= 1;
}

function requestFinishExam() {
  askConfirm({
    title: t('confirm.finishExamTitle'),
    message: t('confirm.finishExamMessage'),
    confirmLabel: t('confirm.startGrading'),
    onConfirm: beginGrading
  });
}

function beginGrading() {
  stopExamClock();
  exam.phase = 'grading';
  exam.paused = false;
  exam.currentIndex = 0;
}

function pauseExam() {
  if (exam.phase === 'taking') exam.paused = true;
}

function resumeExam() {
  exam.paused = false;
}

async function exitExam() {
  const hasDraftWorthSaving =
    exam.active &&
    exam.phase !== 'results' &&
    (Object.keys(exam.records).length > 0 ||
      Object.keys(exam.grades).length > 0 ||
      exam.currentIndex > 0 ||
      exam.remainingSeconds < (config.value.examMinutes ?? 270) * 60);

  if (hasDraftWorthSaving) {
    const saveDraft = window.confirm(t('exam.exitSavePrompt'));
    if (saveDraft) {
      await persistExamDraft();
    } else {
      await clearExamDraft(exam.suiteId);
    }
  } else {
    await clearExamDraft(exam.suiteId);
  }

  stopExamClock();
  exam.active = false;
  exam.phase = 'taking';
  exam.paused = false;
  mode.value = 'random';
  exitFullscreen();
  drawRandom();
}

function setExamScore(score) {
  const question = currentExamQuestion.value;
  if (!question) return;
  exam.grades[question.id] = clampScore(question, score);
  window.setTimeout(() => nextGradingQuestion(), 140);
}

function nextGradingQuestion() {
  if (exam.currentIndex >= examQuestions.value.length - 1) {
    exam.phase = 'results';
    saveProbeResult();
    return;
  }
  exam.currentIndex += 1;
}

async function backToRandomFromResults() {
  await clearExamDraft(exam.suiteId);
  exam.active = false;
  mode.value = 'random';
  exitFullscreen();
  drawRandom();
}

function reviewExamQuestion(id) {
  const index = examQuestions.value.findIndex((question) => question.id === id);
  if (index < 0) return;
  exam.phase = 'grading';
  exam.currentIndex = index;
}

function backToGradingFromResults() {
  if (examQuestions.value.length === 0) return;
  exam.phase = 'grading';
  if (exam.currentIndex >= examQuestions.value.length) {
    exam.currentIndex = examQuestions.value.length - 1;
  }
}

async function markExamQuestionsBaffled(ids) {
  if (effectiveGuest.value) return;
  for (const id of ids) {
    try {
      const attemptId = makeAttemptId(id);
      applyRemoteState(await api.setProgress(id, 'baffled', interactionPayload(attemptId, 'exam')));
    } catch (error) {
      console.error('mark baffled failed:', error.message);
    }
  }
}

function startPracticeFromStats({ statuses, topics, parts, years }) {
  filters.value = {
    statuses: statuses ?? ['unseen', 'meh', 'baffled'],
    topics: topics ?? [],
    parts: parts ?? [1, 2],
    years: years ?? []
  };
  currentQuestionId.value = '';
  switchMode('random');
}

async function saveProbeResult() {
  if (exam.resultSaved || !examResults.value) return;
  exam.resultSaved = true;
  try {
    const payload = await api.addProbeHistory({
      suiteId: exam.suiteId,
      suiteTitle: examResults.value.suiteTitle,
      totalScore: examResults.value.totalScore,
      maxScore: 36,
      t1Score: examResults.value.t1Score,
      t2Score: examResults.value.t2Score,
      t2Items: examResults.value.t2Items,
      grades: exam.grades,
      durationSeconds: (config.value.examMinutes ?? 270) * 60 - exam.remainingSeconds,
      note: examResults.value.note
    });
    if (payload.probeHistory) probeHistory.value = payload.probeHistory;
  } catch (error) {
    console.error(error);
  }
}

async function persistExamDraft() {
  if (effectiveGuest.value || !exam.suiteId) return;
  try {
    const payload = await api.saveExamDraft({
      suiteId: exam.suiteId,
      phase: exam.phase,
      currentIndex: exam.currentIndex,
      remainingSeconds: exam.remainingSeconds,
      paused: exam.paused,
      records: exam.records,
      grades: exam.grades
    });
    if (payload?.examDrafts) examDrafts.value = payload.examDrafts;
  } catch (error) {
    console.error('save exam draft failed:', error.message);
  }
}

async function clearExamDraft(suiteId) {
  if (effectiveGuest.value || !suiteId) return;
  try {
    const payload = await api.deleteExamDraft(suiteId);
    if (payload?.examDrafts) examDrafts.value = payload.examDrafts;
  } catch (error) {
    console.error('delete exam draft failed:', error.message);
  }
}

function askConfirm({ title, message, confirmLabel, onConfirm }) {
  confirmDialog.open = true;
  confirmDialog.title = title;
  confirmDialog.message = message;
  confirmDialog.confirmLabel = confirmLabel;
  confirmDialog.onConfirm = onConfirm;
}

function confirmAction() {
  const action = confirmDialog.onConfirm;
  confirmDialog.open = false;
  confirmDialog.onConfirm = null;
  if (typeof action === 'function') action();
}

function cancelConfirm() {
  confirmDialog.open = false;
  confirmDialog.onConfirm = null;
}

function syncExamClock() {
  stopExamClock();
  if (!exam.active || exam.phase !== 'taking' || exam.paused) return;
  examInterval = window.setInterval(() => {
    exam.remainingSeconds = Math.max(0, exam.remainingSeconds - 1);
    if (exam.remainingSeconds === 0) beginGrading();
  }, 1000);
}

function stopExamClock() {
  if (examInterval) {
    window.clearInterval(examInterval);
    examInterval = null;
  }
}

function exitFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

function handleSwitchProfile(newProfileId) {
  if (serverState.value.showcaseMode) return;
  // Route-driven: navigate to new profile's random mode
  // The route watcher will detect the profile change and re-bootstrap
  router.push(buildRoutePath(newProfileId, 'random'));
}

async function handleSwitchLibrary(nextLibraryId) {
  saveLibrary(nextLibraryId || 'library');
  const targetPath = buildRoutePath(profileId.value, mode.value);
  if (route.path !== targetPath) {
    await router.replace(targetPath);
  }
  await bootstrap();
}

function sumScores(items) {
  return items.reduce((sum, question) => sum + (exam.grades[question.id] ?? 0), 0);
}

function roundScore(value) {
  return Math.round(value * 2) / 2;
}

function scoreToNote(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 32) return 1;
  if (numeric >= 27) return 2;
  if (numeric >= 22) return 3;
  if (numeric >= 17) return 4;
  return 5;
}
</script>

<template>
  <div class="app-shell">
    <TopNav
      v-if="mode !== 'exam'"
      :mode="mode"
      :search-count="questions.length"
      :locale="locale"
      :locale-options="localeOptions"
      :is-guest="effectiveGuest"
      :profile="displayProfileId"
      @switch-mode="switchMode"
      @open-exam="examSetupOpen = true"
      @open-search="searchOpen = true"
      @open-settings="settingsOpen = true"
      @change-locale="handleLocaleChange"
      @open-about="openAppInfoModal"
    />

    <div v-if="loading" class="boot-state">
      <div class="boot-spinner" aria-hidden="true" />
      <h1>{{ t('boot.loadingTitle') }}</h1>
      <p>{{ t('boot.loadingDesc') }}</p>
    </div>

    <div v-else-if="bootError" class="boot-state boot-state--error">
      <h1>{{ t('boot.errorTitle') }}</h1>
      <p>{{ bootError }}</p>
    </div>

    <OnboardingGuide v-else-if="questions.length === 0" />

    <div
      v-else
      class="app-body"
      :class="{
        'app-body--two-col': mode === 'browse',
        'app-body--exam': mode === 'exam',
        'app-body--left-collapsed': leftCollapsed,
        'app-body--right-collapsed': rightCollapsed || mode === 'exam'
      }"
    >
      <Sidebar
        v-if="!leftCollapsed"
        :title="sidebarTitle"
        :subtitle="sidebarSubtitle"
        :sections="sidebarSections"
        :current-id="mode === 'exam' ? currentExamQuestion?.id : mode === 'ai' ? activeAiConversationId : currentQuestionId"
        :header-options="mode === 'browse' ? browseHeaderOptions : mode === 'stats' ? statsHeaderOptions : []"
        :header-value="mode === 'browse' ? browseSourceValue : mode === 'stats' ? statsSelectedStatus : ''"
        :collapse-aria-label="t('sidebar.collapseLeft')"
        @select="selectSidebarItem"
        @toggle-collapse="leftCollapsed = true"
        @header-change="changeSidebarHeader"
        @quick-mark="openQuickMenu"
      />
      <button
        v-if="!leftCollapsed"
        class="edge-collapse-button edge-collapse-button--left"
        type="button"
        :aria-label="t('sidebar.collapseLeft')"
        @click="leftCollapsed = true"
      >
        ‹
      </button>
      <button
        v-else
        class="edge-expand-button edge-expand-button--left"
        type="button"
        :aria-label="t('sidebar.expandLeft')"
        @click="leftCollapsed = false"
      >
        ›
      </button>

      <template v-if="mode === 'exam'">
        <ExamWorkspace
          :question="currentExamQuestion"
          :phase="exam.phase"
          :current-index="exam.currentIndex"
          :total="examQuestions.length"
          :remaining-seconds="exam.remainingSeconds"
          :paused="exam.paused"
          :current-grade="currentExamGrade"
          :results="examResults"
          :exam-grades="exam.grades"
          :exam-records="exam.records"
          :exam-questions="examQuestions"
          :probe-history="probeHistory"
          @previous="previousExamQuestion"
          @complete="completeExamQuestion"
          @skip="skipExamQuestion"
          @pause="pauseExam"
          @resume="resumeExam"
          @exit="exitExam"
          @finish="requestFinishExam"
          @score="setExamScore"
          @next-grade="nextGradingQuestion"
          @back-random="backToRandomFromResults"
          @mark-baffled="markExamQuestionsBaffled"
          @review-question="reviewExamQuestion"
          @back-grading="backToGradingFromResults"
        />
      </template>

      <template v-else-if="mode === 'stats'">
        <StatsView
          :questions="questions"
          :progress="progress"
          :history="history"
          :selected-status="statsSelectedStatus"
          :is-guest="effectiveGuest"
          @select-status="changeSidebarHeader"
          @start-practice="startPracticeFromStats"
        />
      </template>

      <template v-else-if="mode === 'ai'">
        <main class="workspace">
          <AiChatPanel
            :conversation="aiTabConversation"
            :question="aiTabQuestion"
            :loading="aiBusy"
            :decompressing="aiDecompressing"
            :can-chat="canUseAiNow()"
            :error="aiBlocked"
            :disabled-message="aiDisabledReason()"
            @send="sendCurrentAiMessage"
          />
        </main>
      </template>

      <template v-else-if="mode === 'browse'">
        <QuestionCanvas
          ref="browseCanvas"
          :questions="browseQuestions"
          :current-id="currentQuestionId"
          :progress="progress"
          :answer-ids="browseAnswerIds"
          :busy="randomBusy"
          :is-guest="effectiveGuest"
          :ai-question-id="browseAiQuestionId"
          :ai-conversation="browseAiConversation"
          :ai-loading="aiBusy"
          :ai-decompressing="aiDecompressing"
          :ai-can-chat="canUseAiNow()"
          :ai-error="aiBlocked"
          :ai-disabled-message="aiDisabledReason()"
          @active-change="setBrowseActive"
          @show-answer="showBrowseAnswer"
          @show-question="showBrowseQuestion"
          @rate="rateBrowseQuestion"
          @ask-ai="askBrowseQuestionAi"
          @send-ai="sendBrowseAiMessage"
          @toggle-star="toggleStar"
          @quick-mark="openQuickMenu"
          @zoom="openZoom"
        />

        <aside v-if="!rightCollapsed" class="inspector">
          <div class="inspector-heading">
            <span>{{ t('inspector.title') }}</span>
          </div>
          <section class="inspector-block">
            <span class="eyebrow">{{ t('inspector.category') }}</span>
            <h2>{{ browseSourceLabel }}</h2>
            <p class="muted-copy">{{ t('common.questions', { count: browseQuestions.length }) }}</p>
          </section>
          <section class="inspector-block">
            <span class="eyebrow">{{ t('inspector.mastery') }}</span>
            <div class="large-status" :class="`large-status--${STATUS_META[currentProgressStatus]?.tone}`">
              <strong>{{ statusLabel(currentProgressStatus) }}</strong>
              <span>{{ statusDescription(currentProgressStatus) }}</span>
            </div>
          </section>
        </aside>
        <button
          v-if="!rightCollapsed"
          class="edge-collapse-button edge-collapse-button--right"
          type="button"
          :aria-label="t('sidebar.collapseRight')"
          @click="rightCollapsed = true"
        >
          ›
        </button>
        <button
          v-else
          class="edge-expand-button edge-expand-button--right"
          type="button"
          :aria-label="t('sidebar.expandRight')"
          @click="rightCollapsed = false"
        >
          ‹
        </button>
      </template>

      <template v-else>
        <QuestionWorkspace
          :question="currentQuestion"
          :progress-status="currentProgressStatus"
          :starred="currentStarred"
          :answer-visible="answerVisible"
          :ai-visible="aiVisible"
          :ai-conversation="currentAiConversation"
          :ai-loading="aiBusy"
          :ai-decompressing="aiDecompressing"
          :ai-can-chat="canUseAiNow()"
          :ai-error="aiBlocked"
          :ai-disabled-message="aiDisabledReason()"
          :timer-enabled="timerEnabled"
          :timer-started="timerStarted"
          :timer-running="stopwatch.running.value"
          :elapsed-seconds="stopwatch.elapsedSeconds.value"
          :can-skip="mode === 'random'"
          :busy="randomBusy"
          :is-guest="effectiveGuest"
          @start-timer="startTimer"
          @show-answer="showAnswer"
          @show-question="showQuestion"
          @ask-ai="askCurrentQuestionAi"
          @send-ai="sendCurrentAiMessage"
          @rate="rateQuestion"
          @skip="skipQuestion"
          @toggle-star="toggleStar"
          @zoom="openZoom"
        />

        <RightInspector
          v-if="!rightCollapsed"
          :question="currentQuestion"
          :progress-status="currentProgressStatus"
          :timer-enabled="timerEnabled"
          :elapsed-seconds="stopwatch.elapsedSeconds.value"
          :random-blocked="randomBlocked"
          :download-busy="downloadBusy"
          :mode="mode"
          @toggle-timer="toggleTimer"
          @open-filter="filterOpen = true"
          @draw-random="drawRandom"
          @download-question="downloadCurrentQuestion"
          @toggle-collapse="rightCollapsed = true"
        />
        <button
          v-if="!rightCollapsed"
          class="edge-collapse-button edge-collapse-button--right"
          type="button"
          :aria-label="t('sidebar.collapseRight')"
          @click="rightCollapsed = true"
        >
          ›
        </button>
        <button
          v-else
          class="edge-expand-button edge-expand-button--right"
          type="button"
          :aria-label="t('sidebar.expandRight')"
          @click="rightCollapsed = false"
        >
          ‹
        </button>
        <div v-if="rightCollapsed && timerEnabled" class="timer-float">
          {{ formatSeconds(stopwatch.elapsedSeconds.value) }}
        </div>
      </template>
    </div>

    <FilterModal :open="filterOpen" :filters="filters" :meta="meta" @close="filterOpen = false" @apply="applyFilters" />
    <SearchModal :open="searchOpen" :questions="questions" @close="searchOpen = false" @select="selectSearchResult" />
    <SettingsModal
      :open="settingsOpen"
      :current-profile="displayProfileId"
      :is-guest="effectiveGuest"
      :ai-config="config.ai ?? { apiKey: '', model: 'gpt-5.4-mini' }"
      :ai-meta="aiMeta"
      :server-state="serverState"
      :current-library-id="libraryId"
      :current-theme="theme"
      @close="settingsOpen = false"
      @switch-profile="handleSwitchProfile"
      @switch-library="handleSwitchLibrary"
      @change-theme="handleThemeChange"
      @save-ai-settings="saveAiSettings"
    />
    <AppInfoModal
      :open="appInfoOpen"
      :loading="appInfoLoading"
      :refreshing="appInfoRefreshing"
      :error="appInfoError"
      :info="appInfo"
      @close="appInfoOpen = false"
      @refresh-catalog="refreshCatalogFromInfoModal"
    />
    <PdfZoomModal :open="Boolean(zoomPayload)" :payload="zoomPayload" @close="zoomPayload = null" />
    <ExamSetupModal
      :open="examSetupOpen"
      :suites="suites"
      :selected-suite-id="selectedSuiteId"
      :probe-history="probeHistory"
      :exam-drafts="examDrafts"
      @close="examSetupOpen = false"
      @start="startExam"
    />
    <ConfirmDialog
      :open="confirmDialog.open"
      :title="confirmDialog.title"
      :message="confirmDialog.message"
      :confirm-label="confirmDialog.confirmLabel"
      @confirm="confirmAction"
      @cancel="cancelConfirm"
    />
    <Teleport to="body">
      <div v-if="quickMenu.open" class="quick-menu-backdrop" @click="closeQuickMenu" @contextmenu.prevent="closeQuickMenu">
        <div class="quick-menu" :style="{ left: `${quickMenu.x}px`, top: `${quickMenu.y}px` }" @click.stop>
          <button type="button" @click="quickMarkQuestion(quickMenu.id, 'mastered')">{{ t('quickMenu.mastered') }}</button>
          <button type="button" @click="quickMarkQuestion(quickMenu.id, 'meh')">{{ t('quickMenu.meh') }}</button>
          <button type="button" @click="quickMarkQuestion(quickMenu.id, 'baffled')">{{ t('quickMenu.baffled') }}</button>
          <button type="button" @click="quickMarkQuestion(quickMenu.id, 'ignored')">{{ t('quickMenu.ignored') }}</button>
          <button type="button" @click="quickMarkQuestion(quickMenu.id, 'starred')">{{ t('quickMenu.starred') }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
