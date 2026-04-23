import fs from 'node:fs/promises';
import path from 'node:path';
import { clampInteger, sanitizeModelName } from './utils.js';

export const PROGRESS_STATUSES = ['mastered', 'meh', 'baffled', 'ignored'];
export const ATTEMPT_STATUSES = [...PROGRESS_STATUSES, 'skipped'];

const DEFAULT_CONFIG = {
  version: 1,
  locale: 'en-US',
  historyLimit: 500,
  probeHistoryLimit: 200,
  examMinutes: 270,
  ai: {
    apiKey: '',
    model: 'gpt-5.4-mini',
    customPrompt: ''
  },
  randomWeights: {
    unseen: 1,
    meh: 1.35,
    baffled: 2.8
  },
  ui: {
    defaultMode: 'random',
    snapScroll: true,
    autoAdvanceAfterRating: true,
    theme: 'light'
  }
};

const DEFAULT_PROGRESS = {
  version: 2,
  mastered: [],
  meh: [],
  baffled: [],
  ignored: [],
  starred: [],
  attempts: {}
};

const DEFAULT_EXAM_DRAFTS = {
  version: 1,
  drafts: []
};

const DEFAULT_AI_HISTORY = {
  version: 1,
  conversations: []
};

export function createStorage(panelRoot, profileId = 'mathlover') {
  const profileDir = path.join(panelRoot, 'profile', profileId);
  const historyPath = path.join(profileDir, 'history.json');
  const progressPath = path.join(profileDir, 'progress.json');
  const configPath = path.join(profileDir, 'config.json');
  const probeHistoryPath = path.join(profileDir, 'probehistory.json');
  const examDraftsPath = path.join(profileDir, 'examdrafts.json');
  const aiHistoryPath = path.join(profileDir, 'aihistory.json');
  const lockKey = profileDir;

  async function ensure() {
    await withProfileLock(lockKey, async () => {
      await fs.mkdir(profileDir, { recursive: true });
      await ensureJson(configPath, DEFAULT_CONFIG);
      await ensureJson(historyPath, []);
      await ensureJson(progressPath, DEFAULT_PROGRESS);
      await ensureJson(probeHistoryPath, []);
      await ensureJson(examDraftsPath, DEFAULT_EXAM_DRAFTS);
      await ensureJson(aiHistoryPath, DEFAULT_AI_HISTORY);

      await writeConfig(await readConfig());
      await writeProgress(await readProgress());
      await writeHistory(await readHistory());
      await writeProbeHistory(await readProbeHistory());
      await writeExamDrafts(await readExamDrafts());
      await writeAiHistory(await readAiHistory());
    });
  }

  async function readConfig() {
    const raw = await readJson(configPath, DEFAULT_CONFIG);
    return normalizeConfig(raw);
  }

  async function writeConfig(config) {
    await writeJson(configPath, normalizeConfig(config));
  }

  async function readHistory() {
    const config = await readConfig();
    const value = await readJson(historyPath, []);
    return normalizeHistory(value).slice(0, config.historyLimit);
  }

  async function writeHistory(history) {
    const config = await readConfig();
    await writeJson(historyPath, normalizeHistory(history).slice(0, config.historyLimit));
  }

  async function readProbeHistory() {
    const config = await readConfig();
    const value = await readJson(probeHistoryPath, []);
    return normalizeProbeHistory(value).slice(0, config.probeHistoryLimit);
  }

  async function writeProbeHistory(probeHistory) {
    const config = await readConfig();
    await writeJson(probeHistoryPath, normalizeProbeHistory(probeHistory).slice(0, config.probeHistoryLimit));
  }

  async function readProgress() {
    return normalizeProgress(await readJson(progressPath, DEFAULT_PROGRESS));
  }

  async function writeProgress(progress) {
    await writeJson(progressPath, normalizeProgress(progress));
  }

  async function readExamDrafts() {
    const value = await readJson(examDraftsPath, DEFAULT_EXAM_DRAFTS);
    return normalizeExamDrafts(value);
  }

  async function writeExamDrafts(examDrafts) {
    await writeJson(examDraftsPath, normalizeExamDrafts(examDrafts));
  }

  async function readAiHistory() {
    const value = await readJson(aiHistoryPath, DEFAULT_AI_HISTORY);
    return normalizeAiHistory(value);
  }

  async function writeAiHistory(aiHistory) {
    await writeJson(aiHistoryPath, normalizeAiHistory(aiHistory));
  }

  async function updateAiHistory(operation) {
    return withProfileLock(lockKey, async () => {
      const aiHistory = await readAiHistory();
      const result = await operation(aiHistory);
      await writeAiHistory(aiHistory);
      return {
        aiHistory: await readAiHistory(),
        result
      };
    });
  }

  async function recordAttempt({
    id,
    status,
    elapsedSeconds = null,
    timed = false,
    mode = 'random',
    attemptId = null
  }) {
    return withProfileLock(lockKey, async () => {
      if (!ATTEMPT_STATUSES.includes(status)) {
        throw new Error(`Unsupported attempt status: ${status}`);
      }

      const normalizedAttemptId = attemptId || `${Date.now()}-${id}`;
      const at = new Date().toISOString();
      const attempt = {
        attemptId: normalizedAttemptId,
        at,
        status,
        mode,
        timed: Boolean(timed),
        elapsedSeconds: Number.isFinite(Number(elapsedSeconds)) ? Math.max(0, Number(elapsedSeconds)) : null
      };

      const progress = await readProgress();
      progress.attempts[id] = Array.isArray(progress.attempts[id]) ? progress.attempts[id] : [];
      const existingAttemptIndex = progress.attempts[id].findIndex((entry) => entry.attemptId === normalizedAttemptId);
      if (existingAttemptIndex >= 0) {
        progress.attempts[id][existingAttemptIndex] = {
          ...progress.attempts[id][existingAttemptIndex],
          ...attempt
        };
      } else {
        progress.attempts[id].unshift(attempt);
      }

      if (PROGRESS_STATUSES.includes(status)) {
        moveProgressStatus(progress, id, status);
      }

      const masteryStatus = getProgressStatus(progress, id);
      await writeProgress(progress);
      const history = await upsertHistory({
        id,
        status,
        masteryStatus,
        at,
        mode,
        attemptId: normalizedAttemptId,
        timed: Boolean(timed),
        elapsedSeconds: attempt.elapsedSeconds
      });

      return {
        config: await readConfig(),
        progress: await readProgress(),
        history,
        probeHistory: await readProbeHistory()
      };
    });
  }

  async function setStar(id, starred = true) {
    return withProfileLock(lockKey, async () => {
      const progress = await readProgress();
      progress.starred = Array.isArray(progress.starred) ? progress.starred : [];
      if (starred && !progress.starred.includes(id)) {
        progress.starred.unshift(id);
      }
      if (!starred) {
        progress.starred = progress.starred.filter((storedId) => storedId !== id);
      }
      await writeProgress(progress);
      return {
        config: await readConfig(),
        progress: await readProgress(),
        history: await readHistory(),
        probeHistory: await readProbeHistory()
      };
    });
  }

  async function upsertHistory(entry) {
    const history = await readHistory();
    const previous = history.find((item) => item.id === entry.id) ?? null;
    const nextMasteryStatus = normalizeMasteryStatus(entry.masteryStatus)
      || normalizeMasteryStatus(entry.status)
      || normalizeMasteryStatus(previous?.masteryStatus)
      || normalizeMasteryStatus(previous?.status)
      || 'unseen';
    const nextHistoryStatus = ATTEMPT_STATUSES.includes(entry.status) ? entry.status : 'skipped';
    const normalized = {
      id: entry.id,
      at: entry.at,
      status: nextHistoryStatus,
      action: nextHistoryStatus === 'skipped' ? 'viewed_answer' : 'rated',
      masteryStatus: nextMasteryStatus,
      mode: entry.mode,
      attemptId: entry.attemptId,
      timed: Boolean(entry.timed),
      elapsedSeconds: entry.elapsedSeconds
    };

    const deduplicated = history.filter((item) => item.id !== entry.id);
    deduplicated.unshift(normalized);
    await writeHistory(deduplicated);
    return readHistory();
  }

  async function addProbeResult(result) {
    return withProfileLock(lockKey, async () => {
      const at = new Date().toISOString();
      const probeHistory = await readProbeHistory();
      probeHistory.unshift({
        id: result.id || `${result.suiteId}-${Date.now()}`,
        at,
        suiteId: result.suiteId,
        suiteTitle: result.suiteTitle,
        totalScore: roundHalf(result.totalScore),
        maxScore: Number(result.maxScore) || 36,
        note: normalizeNote(result.note),
        t1Score: roundHalf(result.t1Score),
        t2Score: roundHalf(result.t2Score),
        t2Items: Array.isArray(result.t2Items) ? result.t2Items : [],
        grades: result.grades && typeof result.grades === 'object' ? result.grades : {},
        durationSeconds: Number.isFinite(Number(result.durationSeconds)) ? Math.max(0, Number(result.durationSeconds)) : null
      });
      await writeProbeHistory(probeHistory);
      return readProbeHistory();
    });
  }

  return {
    ensure,
    readConfig,
    writeConfig,
    readHistory,
    readProgress,
    writeProgress,
    readProbeHistory,
    readExamDrafts,
    writeExamDrafts,
    readAiHistory,
    writeAiHistory,
    updateAiHistory,
    recordAttempt,
    setStar,
    addProbeResult
  };
}

function normalizeConfig(value) {
  const merged = mergeDeep(DEFAULT_CONFIG, value && typeof value === 'object' ? value : {});
  merged.historyLimit = clampInteger(merged.historyLimit, 1, 5000, DEFAULT_CONFIG.historyLimit);
  merged.probeHistoryLimit = clampInteger(merged.probeHistoryLimit, 1, 2000, DEFAULT_CONFIG.probeHistoryLimit);
  merged.examMinutes = clampInteger(merged.examMinutes, 1, 600, DEFAULT_CONFIG.examMinutes);
  merged.ai = normalizeAiConfig(merged.ai);
  merged.ui = normalizeUiConfig(merged.ui);
  delete merged.randomWeights.understood;
  merged.version = DEFAULT_CONFIG.version;
  return merged;
}

function normalizeAiConfig(value) {
  const fallback = structuredClone(DEFAULT_CONFIG.ai);
  if (!value || typeof value !== 'object') return fallback;
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : fallback.model;
  const customPrompt = typeof value.customPrompt === 'string' ? value.customPrompt.trim() : '';
  return {
    apiKey: apiKey.slice(0, 512),
    model: sanitizeModelName(model, fallback.model),
    customPrompt: customPrompt.slice(0, 12000)
  };
}

function normalizeUiConfig(value) {
  const fallback = structuredClone(DEFAULT_CONFIG.ui);
  if (!value || typeof value !== 'object') return fallback;
  return {
    ...fallback,
    defaultMode: typeof value.defaultMode === 'string' ? value.defaultMode : fallback.defaultMode,
    snapScroll: typeof value.snapScroll === 'boolean' ? value.snapScroll : fallback.snapScroll,
    autoAdvanceAfterRating: typeof value.autoAdvanceAfterRating === 'boolean'
      ? value.autoAdvanceAfterRating
      : fallback.autoAdvanceAfterRating,
    theme: value.theme === 'dark' ? 'dark' : 'light'
  };
}

function normalizeProgress(value) {
  const normalized = structuredClone(DEFAULT_PROGRESS);
  if (!value || typeof value !== 'object') return normalized;

  const seen = new Set();
  for (const status of PROGRESS_STATUSES) {
    const items = Array.isArray(value[status]) ? value[status] : [];
    normalized[status] = [];
    for (const id of items) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      normalized[status].push(id);
    }
  }

  const starredSeen = new Set();
  const starredSources = [
    ...(Array.isArray(value.starred) ? value.starred : []),
    ...(Array.isArray(value.understood) ? value.understood : [])
  ];
  normalized.starred = [];
  for (const id of starredSources) {
    if (typeof id !== 'string' || starredSeen.has(id)) continue;
    starredSeen.add(id);
    normalized.starred.push(id);
  }

  if (value.attempts && typeof value.attempts === 'object') {
    for (const [id, attempts] of Object.entries(value.attempts)) {
      if (!Array.isArray(attempts)) continue;
      normalized.attempts[id] = attempts
        .filter((attempt) => attempt && typeof attempt === 'object')
        .map((attempt) => ({
          attemptId: typeof attempt.attemptId === 'string' ? attempt.attemptId : `${attempt.at ?? Date.now()}-${id}`,
          at: typeof attempt.at === 'string' ? attempt.at : new Date().toISOString(),
          status: attempt.status === 'understood' ? 'skipped' : ATTEMPT_STATUSES.includes(attempt.status) ? attempt.status : 'skipped',
          mode: typeof attempt.mode === 'string' ? attempt.mode : 'random',
          timed: Boolean(attempt.timed),
          elapsedSeconds: Number.isFinite(Number(attempt.elapsedSeconds)) ? Math.max(0, Number(attempt.elapsedSeconds)) : null
        }))
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    }
  }

  return normalized;
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
    .map((entry) => {
      const masteryStatus = normalizeMasteryStatus(entry.masteryStatus)
        || normalizeMasteryStatus(entry.status)
        || 'unseen';
      const normalizedStatus = ATTEMPT_STATUSES.includes(entry.status) ? entry.status : 'skipped';
      return {
        id: entry.id,
        at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
        status: normalizedStatus,
        action:
          normalizedStatus === 'skipped'
            ? 'viewed_answer'
            : typeof entry.action === 'string' && entry.action !== 'started'
              ? entry.action
              : 'rated',
        masteryStatus,
        mode: typeof entry.mode === 'string' ? entry.mode : 'random',
        attemptId: typeof entry.attemptId === 'string' ? entry.attemptId : null,
        timed: Boolean(entry.timed),
        elapsedSeconds: Number.isFinite(Number(entry.elapsedSeconds)) ? Math.max(0, Number(entry.elapsedSeconds)) : null
      };
    })
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const seenQuestionIds = new Set();
  const uniqueByQuestion = [];
  for (const entry of normalized) {
    if (seenQuestionIds.has(entry.id)) continue;
    seenQuestionIds.add(entry.id);
    uniqueByQuestion.push(entry);
  }
  return uniqueByQuestion;
}

function normalizeProbeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.suiteId === 'string')
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : `${entry.suiteId}-${entry.at ?? Date.now()}`,
      at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
      suiteId: entry.suiteId,
      suiteTitle: typeof entry.suiteTitle === 'string' ? entry.suiteTitle : entry.suiteId,
      totalScore: roundHalf(entry.totalScore),
      maxScore: Number(entry.maxScore) || 36,
      note: normalizeNote(entry.note),
      t1Score: roundHalf(entry.t1Score),
      t2Score: roundHalf(entry.t2Score),
      t2Items: Array.isArray(entry.t2Items) ? entry.t2Items : [],
      grades: entry.grades && typeof entry.grades === 'object' ? entry.grades : {},
      durationSeconds: Number.isFinite(Number(entry.durationSeconds)) ? Math.max(0, Number(entry.durationSeconds)) : null
    }))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

function normalizeExamDrafts(value) {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_EXAM_DRAFTS);
  const drafts = Array.isArray(value.drafts) ? value.drafts : [];
  const normalizedDrafts = drafts
    .filter((draft) => draft && typeof draft === 'object' && typeof draft.suiteId === 'string')
    .map((draft) => ({
      suiteId: draft.suiteId,
      phase: draft.phase === 'grading' ? 'grading' : 'taking',
      currentIndex: clampInteger(draft.currentIndex, 0, 1000, 0),
      remainingSeconds: clampInteger(draft.remainingSeconds, 0, 24 * 60 * 60, 0),
      paused: Boolean(draft.paused),
      records: normalizeExamRecords(draft.records),
      grades: normalizeExamGrades(draft.grades),
      createdAt: typeof draft.createdAt === 'string' ? draft.createdAt : new Date().toISOString(),
      updatedAt: typeof draft.updatedAt === 'string' ? draft.updatedAt : new Date().toISOString()
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return {
    version: DEFAULT_EXAM_DRAFTS.version,
    drafts: normalizedDrafts
  };
}

function normalizeAiHistory(value) {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_AI_HISTORY);
  const conversations = Array.isArray(value.conversations) ? value.conversations : [];
  const normalized = conversations
    .filter((conversation) => conversation && typeof conversation === 'object' && typeof conversation.id === 'string' && typeof conversation.questionId === 'string')
    .map((conversation) => {
      const compressed = Boolean(conversation.compressed);
      const messages = compressed ? [] : normalizeAiMessages(conversation.messages);
      return {
        id: conversation.id,
        questionId: conversation.questionId,
        model: sanitizeModelName(conversation.model, DEFAULT_CONFIG.ai.model),
        createdAt: typeof conversation.createdAt === 'string' ? conversation.createdAt : new Date().toISOString(),
        updatedAt: typeof conversation.updatedAt === 'string' ? conversation.updatedAt : new Date().toISOString(),
        compressed,
        payload: compressed && typeof conversation.payload === 'string' ? conversation.payload : '',
        messageCount: clampInteger(conversation.messageCount, 0, 10000, messages.length),
        preview: sanitizePreview(conversation.preview),
        messages
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return {
    version: DEFAULT_AI_HISTORY.version,
    conversations: normalized
  };
}

function normalizeExamRecords(records) {
  if (!records || typeof records !== 'object') return {};
  const output = {};
  for (const [questionId, status] of Object.entries(records)) {
    if (typeof questionId !== 'string') continue;
    if (status === 'completed' || status === 'skipped') {
      output[questionId] = status;
    }
  }
  return output;
}

function normalizeExamGrades(grades) {
  if (!grades || typeof grades !== 'object') return {};
  const output = {};
  for (const [questionId, score] of Object.entries(grades)) {
    if (typeof questionId !== 'string') continue;
    const numeric = Number(score);
    if (!Number.isFinite(numeric)) continue;
    output[questionId] = Math.max(0, Math.round(numeric * 2) / 2);
  }
  return output;
}

function normalizeAiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message === 'object')
    .map((message) => ({
      id: typeof message.id === 'string' ? message.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: normalizeAiRole(message.role),
      content: typeof message.content === 'string' ? message.content.slice(0, 20000) : '',
      createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
      error: Boolean(message.error)
    }))
    .filter((message) => message.content.length > 0)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function normalizeAiRole(role) {
  if (role === 'assistant' || role === 'system') return role;
  return 'user';
}

function sanitizePreview(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function moveProgressStatus(progress, id, status) {
  for (const key of PROGRESS_STATUSES) {
    progress[key] = progress[key].filter((storedId) => storedId !== id);
  }
  progress[status].unshift(id);
}

const progressSetCache = new WeakMap();

function getProgressSets(progress) {
  if (!progress || typeof progress !== 'object') return null;
  const cached = progressSetCache.get(progress);
  if (cached) return cached;
  const sets = new Map(PROGRESS_STATUSES.map((status) => [status, new Set(progress[status] ?? [])]));
  progressSetCache.set(progress, sets);
  return sets;
}

function getProgressStatus(progress, id) {
  if (!progress || typeof id !== 'string') return 'unseen';
  const sets = getProgressSets(progress);
  if (!sets) return 'unseen';
  for (const status of PROGRESS_STATUSES) {
    if (sets.get(status)?.has(id)) return status;
  }
  return 'unseen';
}

function normalizeMasteryStatus(value) {
  return PROGRESS_STATUSES.includes(value) ? value : '';
}

function roundHalf(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 2) / 2;
}

function normalizeNote(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return null;
  if (numeric < 1 || numeric > 5) return null;
  return numeric;
}

function mergeDeep(base, override) {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === 'object' &&
      !Array.isArray(output[key])
    ) {
      output[key] = mergeDeep(output[key], value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

async function ensureJson(filePath, fallback) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeJson(filePath, fallback);
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function writeJson(filePath, value) {
  // Serialize writes to the same file.  Without this lock, rapid clicks
  // (e.g. star button spam) produce concurrent write→rename pairs that
  // race on the same `.tmp` file — one rename succeeds while the other
  // gets ENOENT because the .tmp was already moved.
  const pending = writeLocks.get(filePath) ?? Promise.resolve();
  const next = pending.then(() => doWriteJson(filePath, value), () => doWriteJson(filePath, value));
  writeLocks.set(filePath, next);
  return next;
}

const writeLocks = new Map();
const profileLocks = new Map();

function withProfileLock(lockKey, operation) {
  const pending = profileLocks.get(lockKey) ?? Promise.resolve();
  const next = pending.then(operation, operation);
  profileLocks.set(lockKey, next.finally(() => {
    if (profileLocks.get(lockKey) === next) {
      profileLocks.delete(lockKey);
    }
  }));
  return next;
}

async function doWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}
