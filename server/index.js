import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { loadCatalog } from './catalog.js';
import { createStorage, PROGRESS_STATUSES } from './storage.js';
import { createSearchIndex } from './search-index.js';
import { getScoreTiers } from './score-parser.js';
import { validateToken } from './tokens.js';
import { loadPdfjs } from './pdfjs.js';
import { clampInteger, sanitizeModelName } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const appRoot = path.resolve(path.dirname(__filename), '..');
const { version: APP_VERSION } = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const APP_GIT_COMMIT = resolveGitCommit(appRoot);
const profileRoot = path.join(appRoot, 'profile');
const userRoot = path.join(appRoot, 'user');
const serverConfigPath = path.join(userRoot, 'server-config.json');
const defaultPromptPath = path.join(appRoot, 'defaultprompt.txt');
const promptsRoot = path.join(appRoot, 'server', 'prompts');
const DEFAULT_LIBRARY_ID = 'library';
const RESERVED_PROFILE_NAMES = new Set(['guest', '.', '..', 'con', 'prn', 'aux', 'nul']);
const READ_ONLY_BLOCKED_PATHS = new Set([
  '/progress',
  '/star',
  '/config',
  '/history/finish',
  '/probe-history',
  '/exam-drafts/save',
  '/exam-drafts/delete',
  '/ai/open',
  '/ai/message'
]);

if (!fs.existsSync(profileRoot)) {
  fs.mkdirSync(profileRoot, { recursive: true });
}
if (!fs.existsSync(userRoot)) {
  fs.mkdirSync(userRoot, { recursive: true });
}
const isProduction = process.env.NODE_ENV === 'production';
const DEFAULT_PORT = 3000;
const requestedPort = parsePort(process.env.PORT, DEFAULT_PORT);
const portRetryLimit = parsePositiveInteger(process.env.PORT_RETRY_LIMIT, process.env.PORT ? 1 : 10);
const CATALOG_REFRESH_INTERVAL_MS = Number(process.env.CATALOG_REFRESH_MS || 5 * 60 * 1000);
const DEFAULT_AI_MODEL = 'gpt-5.4-mini';
const ACTIVE_AI_CONVERSATIONS_LIMIT = 7;
const MAX_PDF_TEXT_CHARS = 12000;
const MAX_FOLLOWUP_PROMPT_CHARS = 2400;
// Cap per-conversation message count so a single long chat cannot bloat the
// AI history file. When exceeded, we drop the oldest pair (user+assistant).
const MAX_AI_CONVERSATION_MESSAGES = 200;
const ONE_TIME_DOWNLOAD_TTL_MS = 5 * 60 * 1000;
const ONE_TIME_DOWNLOAD_MAX_ITEMS = 120;
ensureServerConfig();

const app = express();
app.use(express.json({ limit: '1mb' }));

const BOOTSTRAP_RANDOM_FILTERS = {
  statuses: ['unseen', 'careless', 'meh', 'baffled'],
  topics: [],
  parts: [1, 2],
  years: []
};

console.log('Preparing catalog cache...');
const catalogCache = new Map();
const searchIndexCache = new Map();
const oneTimeDownloadStore = new Map();

console.log('Setting up storage cache...');
const storageCache = new Map();
function getStorage(profileName) {
  const safeName = normalizeProfileId(profileName, { fallback: '', allowGuest: false, strict: true });
  if (!safeName) return guestStorage;
  if (storageCache.has(safeName)) return storageCache.get(safeName);
  const s = createStorage(appRoot, safeName);
  storageCache.set(safeName, s);
  return s;
}

/**
 * Read-only in-memory stub for the 'guest' profile.
 * • Never creates any directory on disk.
 * • Returns sensible empty defaults for all read operations.
 * • Silently discards all write operations.
 * • recordAttempt() returns compatible empty state so the client's
 *   applyRemoteState() call is a no-op (empty progress/history).
 */
const EMPTY_PROGRESS = Object.freeze({ mastered: [], careless: [], meh: [], baffled: [], ignored: [], starred: [] });
const EMPTY_EXAM_DRAFTS = Object.freeze({ version: 1, drafts: [] });
const EMPTY_AI_HISTORY = Object.freeze({ version: 1, conversations: [] });
function buildGuestConfig() {
  return { historyLimit: 500, examMinutes: 270, locale: 'en-US', appVersion: APP_VERSION, ui: { theme: 'light' }, ai: { apiKey: '', model: DEFAULT_AI_MODEL } };
}

function buildGuestState() {
  return {
    progress: { ...EMPTY_PROGRESS },
    history: [],
    config: buildGuestConfig(),
    examDrafts: { ...EMPTY_EXAM_DRAFTS, drafts: [] },
    aiHistory: { ...EMPTY_AI_HISTORY, conversations: [] }
  };
}

const guestStorage = {
  async ensure() {},
  async readConfig()       { return buildGuestConfig(); },
  async readProgress()     { return { ...EMPTY_PROGRESS }; },
  async readHistory()      { return []; },
  async readProbeHistory() { return []; },
  async readExamDrafts()   { return { ...EMPTY_EXAM_DRAFTS, drafts: [] }; },
  async writeExamDrafts()  {},
  async readAiHistory()    { return { ...EMPTY_AI_HISTORY, conversations: [] }; },
  async writeAiHistory()   {},
  async updateAiHistory(operation) {
    const aiHistory = { ...EMPTY_AI_HISTORY, conversations: [] };
    return {
      aiHistory,
      result: typeof operation === 'function' ? await operation(aiHistory) : null
    };
  },
  async writeProgress()    {},
  async recordAttempt()    { return buildGuestState(); },
  async setStar()          { return buildGuestState(); },
  async addProbeResult()   { return []; }
};

console.log('Storage profiles are initialized on demand.');

console.log('Applying middleware...');
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const serverConfig = readServerConfig();
    const requestedProfile = normalizeProfileId(req.headers['x-profile-id'], { fallback: 'guest', allowGuest: true });
    const libraryContext = resolveLibraryContext(serverConfig, req.headers['x-library-id']);

    req.serverConfig = serverConfig;
    req.library = libraryContext;
    req.isShowcase = Boolean(serverConfig.showcaseMode);
    req.isGuest = req.isShowcase || requestedProfile === 'guest';
    req.profileId = req.isGuest ? 'guest' : requestedProfile;
    req.readOnly = req.isGuest;

    if (req.isGuest) {
      req.storage = guestStorage;
      return next();
    }

    if (!profileDirectoryExists(req.profileId)) {
      if (allowsMissingProfile(req.path)) {
        req.isGuest = true;
        req.profileId = 'guest';
        req.readOnly = true;
        req.storage = guestStorage;
        return next();
      }

      return res.status(404).json({
        error: 'PROFILE_NOT_FOUND',
        message: '用户不存在，请先通过设置页使用邀请码创建账户。'
      });
    }

    req.storage = getStorage(req.profileId);
    try {
      await req.storage.ensure();
    } catch (err) {
      return next(err);
    }
  }
  next();
});

app.use('/api', (req, res, next) => {
  if (!req.readOnly) return next();
  if (READ_ONLY_BLOCKED_PATHS.has(req.path)) {
    return res.status(403).json({
      error: 'READ_ONLY_MODE',
      message: req.isShowcase ? '展示模式下禁止写入操作。' : '未登录状态下禁止写入操作。'
    });
  }
  next();
});

console.log('Registering API routes...');

app.get('/api/health', async (request, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(request);
    response.json({
      ok: true,
      questionCount: activeCatalog.questions.length,
      suiteCount: activeCatalog.suites.length
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/about', async (request, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(request);
    response.json({
      appName: 'QED',
      version: APP_VERSION,
      gitCommit: APP_GIT_COMMIT,
      questionCount: activeCatalog.questions.length,
      suiteCount: activeCatalog.suites.length,
      profileCount: getProfileCount(),
      githubUrl: 'https://github.com/tangxiaoyi97/QED',
      authors: '唐晓翼 & 白清',
      acknowledgements: ['Claude', 'Codex'],
      license: 'MIT',
      server: buildServerState(request)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/catalog', async (request, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(request);
    response.json({
      questions: activeCatalog.questions,
      suites: activeCatalog.suites,
      meta: activeCatalog.meta,
      server: buildServerState(request)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/catalog/refresh', async (request, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(request, true);
    response.json({
      ok: true,
      questionCount: activeCatalog.questions.length,
      suiteCount: activeCatalog.suites.length,
      server: buildServerState(request)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/bootstrap', async (req, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(req);
    const [config, progress, history, probeHistory, examDrafts] = await Promise.all([
      req.storage.readConfig(),
      req.storage.readProgress(),
      req.storage.readHistory(),
      req.storage.readProbeHistory(),
      req.storage.readExamDrafts()
    ]);

    const candidates = filterCandidates(activeCatalog.questions, progress, BOOTSTRAP_RANDOM_FILTERS);
    const firstQuestion = candidates.length > 0 ? pickWeighted(candidates, progress, config) : null;

    response.json({
      catalog: {
        questions: activeCatalog.questions,
        suites: activeCatalog.suites,
        meta: activeCatalog.meta
      },
      state: {
        config,
        progress,
        history,
        probeHistory,
        examDrafts,
        aiMeta: buildAiMeta(config, req),
        server: buildServerState(req)
      },
      firstQuestion
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/state', async (req, response, next) => {
  try {
    const config = await req.storage.readConfig();
    response.json({
      config,
      progress: await req.storage.readProgress(),
      history: await req.storage.readHistory(),
      probeHistory: await req.storage.readProbeHistory(),
      examDrafts: await req.storage.readExamDrafts(),
      aiMeta: buildAiMeta(config, req),
      server: buildServerState(req)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/random', async (req, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(req);
    const progress = await req.storage.readProgress();
    const config = await req.storage.readConfig();
    const candidates = filterCandidates(activeCatalog.questions, progress, req.body?.filters);

    if (candidates.length === 0) {
      response.status(404).json({
        error: 'NO_CANDIDATES',
        message: '当前过滤条件下没有可随机抽取的题目。'
      });
      return;
    }

    const question = pickWeighted(candidates, progress, config);

    response.json({
      question,
      history: await req.storage.readHistory(),
      config,
      progress,
      server: buildServerState(req)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/progress', async (req, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(req);
    const { id, status, elapsedSeconds, timed, mode, attemptId } = req.body ?? {};
    if (!activeCatalog.questionsById.has(id)) {
      response.status(404).json({ error: 'UNKNOWN_QUESTION', message: '题目不存在。' });
      return;
    }
    if (!PROGRESS_STATUSES.includes(status)) {
      response.status(400).json({ error: 'INVALID_STATUS', message: '掌握状态无效。' });
      return;
    }

    response.json(
      await req.storage.recordAttempt({
        id,
        status,
        elapsedSeconds,
        timed,
        mode,
        attemptId
      })
    );
  } catch (error) {
    next(error);
  }
});

app.post('/api/star', async (req, response, next) => {
  try {
    const { id, starred } = req.body ?? {};
    if (!id) return response.status(400).json({ error: 'INVALID_ID' });

    response.json(await req.storage.setStar(id, starred));
  } catch (error) {
    next(error);
  }
});

app.post('/api/config', async (req, response, next) => {
  try {
    const current = await req.storage.readConfig();
    if (req.isGuest) return response.json({ config: current, aiMeta: buildAiMeta(current, req), server: buildServerState(req) });

    const { locale, aiApiKey, aiModel, aiCustomPrompt, theme, appVersion } = req.body ?? {};
    const updated = { ...current };
    if (typeof locale === 'string' && locale.length > 0 && locale.length <= 32) {
      updated.locale = locale;
    }
    if (typeof appVersion === 'string' && appVersion.length <= 64) {
      updated.appVersion = appVersion.trim();
    }
    updated.ai = {
      ...(updated.ai ?? {}),
      apiKey: typeof aiApiKey === 'string' ? aiApiKey.trim().slice(0, 512) : updated.ai?.apiKey ?? '',
      model: sanitizeModelName(typeof aiModel === 'string' ? aiModel : updated.ai?.model ?? DEFAULT_AI_MODEL, DEFAULT_AI_MODEL),
      customPrompt: typeof aiCustomPrompt === 'string'
        ? aiCustomPrompt.trim().slice(0, 12000)
        : updated.ai?.customPrompt ?? ''
    };
    updated.ui = {
      ...(updated.ui ?? {}),
      theme: theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : updated.ui?.theme ?? 'light'
    };
    await req.storage.writeConfig(updated);
    const stored = await req.storage.readConfig();
    response.json({ config: stored, aiMeta: buildAiMeta(stored, req), server: buildServerState(req) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/history/start', async (req, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(req);
    const { id } = req.body ?? {};
    if (!activeCatalog.questionsById.has(id)) {
      response.status(404).json({ error: 'UNKNOWN_QUESTION', message: '题目不存在。' });
      return;
    }
    response.json({
      history: await req.storage.readHistory(),
      progress: await req.storage.readProgress(),
      config: await req.storage.readConfig(),
      message: '打开题目不会写入历史；查看答案或评分时才记录。'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/history/finish', async (req, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(req);
    const { id, status = 'skipped', elapsedSeconds = null, timed = false, mode = 'random', attemptId } = req.body ?? {};
    if (!activeCatalog.questionsById.has(id)) {
      response.status(404).json({ error: 'UNKNOWN_QUESTION', message: '题目不存在。' });
      return;
    }
    response.json(
      await req.storage.recordAttempt({
        id,
        status,
        elapsedSeconds,
        timed,
        mode,
        attemptId
      })
    );
  } catch (error) {
    next(error);
  }
});

app.post('/api/probe-history', async (request, response, next) => {
  try {
    const activeCatalog = await refreshCatalogForRequest(request);
    const { suiteId } = request.body ?? {};
    if (!activeCatalog.suitesById.has(suiteId)) {
      response.status(404).json({ error: 'UNKNOWN_SUITE', message: '套卷不存在。' });
      return;
    }
    response.json({
      config: await request.storage.readConfig(),
      probeHistory: await request.storage.addProbeResult(request.body)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ai/meta', async (req, response, next) => {
  try {
    const config = await req.storage.readConfig();
    response.json(buildAiMeta(config, req));
  } catch (error) {
    next(error);
  }
});

app.get('/api/exam-drafts', async (req, response, next) => {
  try {
    response.json({
      examDrafts: await req.storage.readExamDrafts()
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/exam-drafts/save', async (req, response, next) => {
  try {
    if (req.isGuest) {
      response.status(403).json({ error: 'GUEST_MODE', message: '访客模式下不能保存考试草稿。' });
      return;
    }

    const activeCatalog = await refreshCatalogForRequest(req);
    const nextDraft = normalizeIncomingExamDraft(req.body);
    if (!nextDraft.suiteId || !activeCatalog.suitesById.has(nextDraft.suiteId)) {
      response.status(404).json({ error: 'UNKNOWN_SUITE', message: '套卷不存在。' });
      return;
    }

    const current = await req.storage.readExamDrafts();
    const drafts = Array.isArray(current?.drafts) ? current.drafts : [];
    const merged = [nextDraft, ...drafts.filter((draft) => draft.suiteId !== nextDraft.suiteId)].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    await req.storage.writeExamDrafts({ ...current, drafts: merged });
    response.json({ examDrafts: await req.storage.readExamDrafts() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/exam-drafts/delete', async (req, response, next) => {
  try {
    if (req.isGuest) {
      response.status(403).json({ error: 'GUEST_MODE', message: '访客模式下不能删除考试草稿。' });
      return;
    }
    const suiteId = typeof req.body?.suiteId === 'string' ? req.body.suiteId : '';
    if (!suiteId) {
      response.status(400).json({ error: 'INVALID_SUITE', message: 'suiteId 无效。' });
      return;
    }

    const current = await req.storage.readExamDrafts();
    const drafts = Array.isArray(current?.drafts) ? current.drafts : [];
    const nextDrafts = drafts.filter((draft) => draft.suiteId !== suiteId);
    await req.storage.writeExamDrafts({ ...current, drafts: nextDrafts });
    response.json({ examDrafts: await req.storage.readExamDrafts() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ai/history', async (req, response, next) => {
  try {
    if (req.isGuest) {
      response.json({ conversations: [] });
      return;
    }

    const activeCatalog = await refreshCatalogForRequest(req);
    const aiHistory = await req.storage.readAiHistory();
    const conversations = summarizeAiConversations(aiHistory, activeCatalog.questionsById);
    response.json({ conversations });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ai/history/:id', async (req, response, next) => {
  try {
    if (req.isGuest) {
      response.status(403).json({ error: 'GUEST_MODE', message: '访客模式不可使用 AI。' });
      return;
    }

    const activeCatalog = await refreshCatalogForRequest(req);
    const aiHistory = await req.storage.readAiHistory();
    const conversation = getConversationById(aiHistory, req.params.id);
    if (!conversation) {
      response.status(404).json({ error: 'CONVERSATION_NOT_FOUND', message: '会话不存在。' });
      return;
    }

    response.json({
      conversation: hydrateConversation(conversation),
      question: activeCatalog.questionsById.get(conversation.questionId) ?? null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/ai/open', async (req, response, next) => {
  try {
    if (req.isGuest) {
      response.status(403).json({ error: 'GUEST_MODE', message: '访客模式不可使用 AI。' });
      return;
    }

    const activeCatalog = await refreshCatalogForRequest(req);
    const questionId = typeof req.body?.questionId === 'string' ? req.body.questionId : '';
    if (!questionId || !activeCatalog.questionsById.has(questionId)) {
      response.status(404).json({ error: 'UNKNOWN_QUESTION', message: '题目不存在。' });
      return;
    }

    const config = await req.storage.readConfig();
    const requestedLocale = typeof req.body?.locale === 'string' ? req.body.locale : '';
    const promptLocale = resolveAiPromptLocale(requestedLocale, config.locale);
    const aiMeta = buildAiMeta(config, req);
    const aiApiKey = resolveAiApiKey(config, req);
    if (!aiApiKey) {
      response.status(400).json({
        error: 'AI_KEY_MISSING',
        message: '未配置 API Key，请先在设置中填写个人 Key 或在本地 server-config.json 中配置。',
        aiMeta
      });
      return;
    }

    const aiHistory = await req.storage.readAiHistory();
    const existing = findConversationByQuestion(aiHistory, questionId);
    if (existing) {
      response.json({
        existing: true,
        conversation: hydrateConversation(existing),
        aiMeta
      });
      return;
    }

    const now = new Date().toISOString();
    const model = aiMeta.canUseCustomModel ? sanitizeModelName(config.ai?.model, aiMeta.defaultModel) : aiMeta.defaultModel;
    const conversation = {
      id: makeConversationId(questionId),
      questionId,
      model,
      locale: normalizeLocale(promptLocale),
      createdAt: now,
      updatedAt: now,
      compressed: false,
      payload: '',
      messageCount: 0,
      preview: '',
      messages: []
    };

    const question = activeCatalog.questionsById.get(questionId);
    const initialPrompt = await buildQuestionPrompt({
      catalog: activeCatalog,
      question,
      followup: null,
      locale: promptLocale
    });

    try {
      const assistantContent = await requestAiCompletion({
        apiKey: aiApiKey,
        model,
        systemPrompt: await resolveSystemPrompt(config, promptLocale),
        userPrompt: initialPrompt
      });
      conversation.messages.push({
        id: makeMessageId(),
        role: 'assistant',
        content: assistantContent,
        createdAt: new Date().toISOString(),
        error: false
      });
      conversation.messageCount = conversation.messages.length;
      conversation.preview = createConversationPreview(conversation.messages);
      conversation.updatedAt = new Date().toISOString();
    } catch (error) {
      conversation.messages.push({
        id: makeMessageId(),
        role: 'assistant',
        content: `AI 请求失败：${error.message || '未知错误'}`,
        createdAt: new Date().toISOString(),
        error: true
      });
      conversation.messageCount = conversation.messages.length;
      conversation.preview = createConversationPreview(conversation.messages);
      conversation.updatedAt = new Date().toISOString();
    }

    const { aiHistory: persistedAiHistory, result } = await req.storage.updateAiHistory((currentAiHistory) => {
      const currentExisting = findConversationByQuestion(currentAiHistory, questionId);
      if (currentExisting) {
        return { existing: true, conversationId: currentExisting.id };
      }
      upsertConversation(currentAiHistory, conversation);
      enforceAiCompression(currentAiHistory);
      return { existing: false, conversationId: conversation.id };
    });
    const persistedConversation = result?.conversationId
      ? hydrateConversation(getConversationById(persistedAiHistory, result.conversationId))
      : null;

    response.json({
      existing: Boolean(result?.existing),
      conversation: persistedConversation ?? hydrateConversation(conversation),
      aiMeta,
      conversations: summarizeAiConversations(persistedAiHistory, activeCatalog.questionsById)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/ai/message', async (req, response, next) => {
  try {
    if (req.isGuest) {
      response.status(403).json({ error: 'GUEST_MODE', message: '访客模式不可使用 AI。' });
      return;
    }

    const activeCatalog = await refreshCatalogForRequest(req);
    const { conversationId, content, model: requestedModel, locale: requestedLocaleRaw } = req.body ?? {};
    const safeConversationId = typeof conversationId === 'string' ? conversationId : '';
    const trimmedContent = typeof content === 'string' ? content.trim() : '';
    const requestedLocale = typeof requestedLocaleRaw === 'string' ? requestedLocaleRaw : '';
    if (!safeConversationId || !trimmedContent) {
      response.status(400).json({ error: 'INVALID_REQUEST', message: '会话 ID 与消息内容不能为空。' });
      return;
    }

    const config = await req.storage.readConfig();
    const aiMeta = buildAiMeta(config, req);
    const aiApiKey = resolveAiApiKey(config, req);
    if (!aiApiKey) {
      response.status(400).json({
        error: 'AI_KEY_MISSING',
        message: '未配置 API Key，请先在设置中填写个人 Key 或在本地 server-config.json 中配置。',
        aiMeta
      });
      return;
    }

    const aiHistorySnapshot = await req.storage.readAiHistory();
    const conversationSnapshot = getConversationById(aiHistorySnapshot, safeConversationId);
    if (!conversationSnapshot) {
      response.status(404).json({ error: 'CONVERSATION_NOT_FOUND', message: '会话不存在。' });
      return;
    }

    const hydrated = hydrateConversation(conversationSnapshot);
    const promptLocale = resolveAiPromptLocale(requestedLocale, conversationSnapshot.locale || config.locale);
    const effectiveModel = aiMeta.canUseCustomModel
      ? sanitizeModelName(requestedModel || config.ai?.model || hydrated.model || aiMeta.defaultModel, aiMeta.defaultModel)
      : aiMeta.defaultModel;
    const userMessage = {
      id: makeMessageId(),
      role: 'user',
      content: trimmedContent.slice(0, MAX_FOLLOWUP_PROMPT_CHARS),
      createdAt: new Date().toISOString(),
      error: false
    };

    const question = activeCatalog.questionsById.get(hydrated.questionId);
    if (!question) {
      response.status(404).json({ error: 'UNKNOWN_QUESTION', message: '该会话对应题目不存在。' });
      return;
    }

    let assistantMessage;
    try {
      const userPrompt = await buildQuestionPrompt({
        catalog: activeCatalog,
        question,
        followup: trimmedContent.slice(0, MAX_FOLLOWUP_PROMPT_CHARS),
        locale: promptLocale
      });
      const assistantContent = await requestAiCompletion({
        apiKey: aiApiKey,
        model: effectiveModel,
        systemPrompt: await resolveSystemPrompt(config, promptLocale),
        userPrompt
      });
      assistantMessage = {
        id: makeMessageId(),
        role: 'assistant',
        content: assistantContent,
        createdAt: new Date().toISOString(),
        error: false
      };
    } catch (error) {
      assistantMessage = {
        id: makeMessageId(),
        role: 'assistant',
        content: `AI 请求失败：${error.message || '未知错误'}`,
        createdAt: new Date().toISOString(),
        error: true
      };
    }

    const { aiHistory: persistedAiHistory, result } = await req.storage.updateAiHistory((currentAiHistory) => {
      const currentConversation = getConversationById(currentAiHistory, safeConversationId);
      if (!currentConversation) {
        return { missing: true };
      }
      const nextConversation = hydrateConversation(currentConversation);
      nextConversation.model = effectiveModel;
      nextConversation.locale = normalizeLocale(promptLocale);
      nextConversation.messages.push(userMessage, assistantMessage);
      nextConversation.updatedAt = new Date().toISOString();
      nextConversation.messageCount = nextConversation.messages.length;
      nextConversation.preview = createConversationPreview(nextConversation.messages);
      upsertConversation(currentAiHistory, nextConversation);
      enforceAiCompression(currentAiHistory);
      return { missing: false, conversationId: nextConversation.id };
    });
    if (result?.missing) {
      response.status(404).json({ error: 'CONVERSATION_NOT_FOUND', message: '会话不存在。' });
      return;
    }

    response.json({
      conversation: hydrateConversation(getConversationById(persistedAiHistory, result?.conversationId || safeConversationId)),
      aiMeta,
      conversations: summarizeAiConversations(persistedAiHistory, activeCatalog.questionsById)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/search', (request, response) => {
  const searchIndex = getSearchIndexForRequest(request);
  if (!request.readOnly) {
    searchIndex.ensureBuilding();
  }
  const query = typeof request.query.q === 'string' ? request.query.q : '';
  const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
  const outcome = searchIndex.search(query, { limit });
  response.json({
    query,
    ready: outcome.ready,
    progress: outcome.progress,
    results: outcome.results
  });
});

app.get('/api/score-tiers/:id', async (request, response, next) => {
  try {
    const { id } = request.params;
    const activeCatalog = await refreshCatalogForRequest(request);
    if (!activeCatalog.questionsById.has(id)) {
      response.status(404).json({ error: 'UNKNOWN_QUESTION', message: '题目不存在。' });
      return;
    }
    const loPdfPath = activeCatalog.fileMap.lo.get(id) ?? null;
    const scores = await getScoreTiers(id, loPdfPath);
    response.json({ id, scores });
  } catch (error) {
    next(error);
  }
});

app.get('/api/search/status', (request, response) => {
  const searchIndex = getSearchIndexForRequest(request);
  if (!request.readOnly) {
    searchIndex.ensureBuilding();
  }
  response.json(searchIndex.getStatus());
});

app.get('/api/pdf/:kind/:id', async (request, response, next) => {
  try {
    const { kind, id } = request.params;
    if (!['au', 'lo'].includes(kind)) {
      response.status(400).json({ error: 'INVALID_KIND', message: 'PDF 类型无效。' });
      return;
    }

    const activeCatalog = await refreshCatalogForRequest(request);
    const filePath = activeCatalog.fileMap[kind].get(id);
    if (!filePath) {
      response.status(404).json({ error: 'MISSING_PDF', message: 'PDF 文件不存在。' });
      return;
    }

    response.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

app.post('/api/download/question/:id', async (request, response, next) => {
  try {
    const { id } = request.params;
    const activeCatalog = await refreshCatalogForRequest(request);
    const question = activeCatalog.questionsById.get(id);
    if (!question) {
      response.status(404).json({ error: 'UNKNOWN_QUESTION', message: '题目不存在。' });
      return;
    }

    const questionPdfPaths = getPdfPathsForKind(activeCatalog, 'au', id);
    if (questionPdfPaths.length === 0) {
      response.status(404).json({ error: 'MISSING_PDF', message: '题目 PDF 不存在。' });
      return;
    }
    const answerPdfPaths = getPdfPathsForKind(activeCatalog, 'lo', id);
    const mergedBuffer = await mergePdfFiles([...questionPdfPaths, ...answerPdfPaths]);

    cleanupOneTimeDownloads();
    if (oneTimeDownloadStore.size >= ONE_TIME_DOWNLOAD_MAX_ITEMS) {
      const oldestKey = oneTimeDownloadStore.keys().next().value;
      if (oldestKey) oneTimeDownloadStore.delete(oldestKey);
    }

    const token = generateOneTimeToken();
    const filename = buildQuestionDownloadFilename(question, answerPdfPaths.length > 0);
    oneTimeDownloadStore.set(token, {
      createdAt: Date.now(),
      expiresAt: Date.now() + ONE_TIME_DOWNLOAD_TTL_MS,
      filename,
      buffer: mergedBuffer
    });

    response.json({
      token,
      url: `/api/download/file/${encodeURIComponent(token)}`,
      filename,
      expiresInMs: ONE_TIME_DOWNLOAD_TTL_MS
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/download/file/:token', (request, response) => {
  cleanupOneTimeDownloads();
  const token = typeof request.params?.token === 'string' ? request.params.token : '';
  if (!token) {
    response.status(404).json({ error: 'DOWNLOAD_NOT_FOUND', message: '下载链接不存在或已失效。' });
    return;
  }

  const record = oneTimeDownloadStore.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    oneTimeDownloadStore.delete(token);
    response.status(404).json({ error: 'DOWNLOAD_NOT_FOUND', message: '下载链接不存在或已失效。' });
    return;
  }

  oneTimeDownloadStore.delete(token);
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Disposition', buildContentDisposition(record.filename));
  response.send(record.buffer);
});
/* --- Profile Management --- */
app.get('/api/profiles/check/:id', (req, res) => {
  const serverConfig = readServerConfig();
  if (serverConfig.showcaseMode) {
    return res.status(403).json({ error: 'SHOWCASE_MODE', message: '展示模式下已关闭登录功能。' });
  }
  const safeId = normalizeProfileId(req.params.id, { fallback: '', allowGuest: false, strict: true });
  if (!safeId) return res.status(400).json({ error: 'INVALID_ID' });
  const exists = profileDirectoryExists(safeId);
  res.json({ exists, id: safeId });
});

app.post('/api/profiles/create', async (req, res, next) => {
  try {
    const serverConfig = readServerConfig();
    if (serverConfig.showcaseMode) {
      return res.status(403).json({ error: 'SHOWCASE_MODE', message: '展示模式下已关闭登录功能。' });
    }

    const { id, token, specialTokenHash } = req.body ?? {};
    const safeId = normalizeProfileId(id, { fallback: '', allowGuest: false, strict: true });
    if (!safeId) return res.status(400).json({ error: 'INVALID_ID' });
    
    if (profileDirectoryExists(safeId)) {
      return res.status(400).json({ error: 'ALREADY_EXISTS' });
    }

    const hasNormalToken = typeof token === 'string' && token.trim().length > 0;
    const hasSpecialTokenHash = typeof specialTokenHash === 'string' && specialTokenHash.trim().length > 0;
    if (hasNormalToken === hasSpecialTokenHash) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: '邀请码无效或已过期。' });
    }

    const isValid = await validateToken(appRoot, hasNormalToken
      ? { token: token.trim() }
      : { specialTokenHash: specialTokenHash.trim().toLowerCase() });
    if (!isValid) {
      return res.status(403).json({ error: 'INVALID_TOKEN', message: '邀请码无效或已过期。' });
    }

    const storage = getStorage(safeId);
    await storage.ensure();
    res.json({ ok: true, id: safeId });
  } catch (err) {
    next(err);
  }
});
/* --------------------------- */

console.log('Setting up environment...');
if (isProduction) {
  app.use(express.static(path.join(appRoot, 'dist')));
  app.get('*', (_request, response) => {
    response.sendFile(path.join(appRoot, 'dist', 'index.html'));
  });
} else {
  console.log('Creating Vite server...');
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: appRoot,
    server: { middlewareMode: true },
    appType: 'spa'
  });
  app.use(vite.middlewares);
}

app.use((error, _request, response, _next) => {
  console.error(error);
  // Do not echo raw error.message back to the client — it may contain file
  // paths, stack fragments, or third-party API responses with credentials.
  // Clients key off the error code; the human message is intentionally generic.
  response.status(500).json({
    error: 'SERVER_ERROR',
    message: '服务器错误，请稍后重试。'
  });
});

try {
  await startServer(app, requestedPort, {
    host: process.env.HOST,
    retryLimit: portRetryLimit
  });
  await warmupCatalog();
} catch (error) {
  console.error(formatStartupError(error));
  process.exit(1);
}

async function startServer(expressApp, initialPort, { host, retryLimit }) {
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    const candidatePort = initialPort + attempt;
    try {
      const server = await listen(expressApp, candidatePort, host);
      const address = server.address();
      const activePort = typeof address === 'object' && address ? address.port : candidatePort;
      const activeHost = host || 'localhost';
      console.log(`QED v${APP_VERSION} running at http://${activeHost}:${activePort}`);
      return server;
    } catch (error) {
      if (error.code === 'EADDRINUSE' && attempt < retryLimit - 1) {
        console.warn(`[server] Port ${candidatePort} is already in use; trying ${candidatePort + 1}...`);
        continue;
      }
      error.requestedPort = candidatePort;
      throw error;
    }
  }

  throw new Error(`Unable to start server after ${retryLimit} attempts.`);
}

function listen(expressApp, candidatePort, host) {
  return new Promise((resolve, reject) => {
    const server = host
      ? expressApp.listen(candidatePort, host)
      : expressApp.listen(candidatePort);

    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function parsePort(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  console.warn(`[server] Invalid PORT "${value}", using ${fallback}.`);
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatStartupError(error) {
  if (error?.code === 'EADDRINUSE') {
    const busyPort = error.requestedPort || requestedPort;
    const nextPort = busyPort + 1;
    return [
      `[server] Port ${busyPort} is already in use.`,
      `Stop the process using it, or start QED on another port: PORT=${nextPort} npm run start`
    ].join('\n');
  }

  return error?.stack || error?.message || String(error);
}

async function warmupCatalog() {
  try {
    const serverConfig = readServerConfig();
    const defaultContext = resolveLibraryContext(serverConfig, DEFAULT_LIBRARY_ID);
    const activeCatalog = await refreshCatalog(defaultContext.id, false, defaultContext.path, {
      allowIndexBuild: !serverConfig.showcaseMode
    });
    console.log(`Loaded ${activeCatalog.questions.length} questions across ${activeCatalog.suites.length} suites.`);
  } catch (error) {
    console.warn('[catalog] warmup failed:', error.message);
  }
}

async function refreshCatalogForRequest(req, force = false) {
  const context = req?.library ?? resolveLibraryContext(readServerConfig(), DEFAULT_LIBRARY_ID);
  return refreshCatalog(context.id, force, context.path, {
    allowIndexBuild: !Boolean(req?.readOnly)
  });
}

async function refreshCatalog(libraryId = DEFAULT_LIBRARY_ID, force = false, explicitPath = null, options = {}) {
  const { allowIndexBuild = true } = options ?? {};
  const fallbackContext = resolveLibraryContext(readServerConfig(), libraryId);
  const safeLibraryId = normalizeLibraryId(libraryId, fallbackContext.id);
  const resolvedPath = explicitPath || fallbackContext.path;
  const cacheKey = makeLibraryCacheKey(safeLibraryId, resolvedPath);
  let state = catalogCache.get(cacheKey);
  if (!state) {
    state = {
      libraryId: safeLibraryId,
      path: resolvedPath,
      catalog: null,
      loadedAt: 0,
      refreshing: null
    };
    catalogCache.set(cacheKey, state);
  }

  const fresh = state.catalog && Date.now() - state.loadedAt < CATALOG_REFRESH_INTERVAL_MS;
  if (!force && fresh) return state.catalog;

  if (!force && state.catalog) {
    if (!state.refreshing) {
      state.refreshing = loadCatalogIntoState(state, resolvedPath, { cacheKey, safeLibraryId, allowIndexBuild })
        .catch((error) => console.error('[catalog] background refresh failed:', error.message))
        .finally(() => {
          state.refreshing = null;
        });
    }
    return state.catalog;
  }

  if (state.refreshing) await state.refreshing;
  if (force || !state.catalog) {
    await loadCatalogIntoState(state, resolvedPath, { cacheKey, safeLibraryId, allowIndexBuild });
  }
  return state.catalog;
}

async function loadCatalogIntoState(state, resolvedPath, { cacheKey, safeLibraryId, allowIndexBuild }) {
  state.catalog = await loadCatalog(appRoot, resolvedPath);
  state.loadedAt = Date.now();

  if (allowIndexBuild) {
    const searchIndex = getSearchIndex(cacheKey, safeLibraryId, resolvedPath);
    searchIndex.build().catch((error) => {
      console.error('[search-index] incremental build failed:', error.message);
    });
  }
  return state.catalog;
}

function getSearchIndexForRequest(req) {
  const context = req?.library ?? resolveLibraryContext(readServerConfig(), DEFAULT_LIBRARY_ID);
  const key = makeLibraryCacheKey(context.id, context.path);
  return getSearchIndex(key, context.id, context.path);
}

function getSearchIndex(cacheKey, libraryId, libraryPath) {
  if (searchIndexCache.has(cacheKey)) return searchIndexCache.get(cacheKey);
  const index = createSearchIndex({
    projectRoot: appRoot,
    cacheKey,
    getCatalog: async () => refreshCatalog(libraryId, false, libraryPath)
  });
  searchIndexCache.set(cacheKey, index);
  index.init({ eagerBuild: false }).catch((error) => {
    console.error('[search-index] init failed:', error.message);
  });
  return index;
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

function filterCandidates(questions, progress, filters = {}) {
  const selectedStatuses = toSet(filters.statuses);
  const selectedTopics = toSet(filters.topics);
  const selectedParts = toNumberSet(filters.parts);
  const selectedYears = toNumberSet(filters.years);

  return questions.filter((question) => {
    const status = getProgressStatus(progress, question.id);
    if (status === 'mastered' || status === 'ignored') return false;
    if (selectedStatuses && !selectedStatuses.has(status)) return false;
    if (selectedParts && !selectedParts.has(question.part)) return false;
    if (selectedYears && !selectedYears.has(question.year)) return false;
    if (selectedTopics && question.part === 1 && !selectedTopics.has(question.topic)) return false;
    if (selectedTopics && question.part === 2) return false;
    return true;
  });
}

function pickWeighted(questions, progress, config) {
  const weights = config?.randomWeights ?? {
    unseen: 1,
    careless: 1.8,
    meh: 1.35,
    baffled: 2.8
  };

  const weighted = questions.map((question) => ({
    question,
    weight: weights[getProgressStatus(progress, question.id)] ?? 1
  }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * total;

  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor <= 0) return item.question;
  }

  return weighted.at(-1).question;
}

function toSet(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return new Set(value.map(String));
}

function toNumberSet(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return new Set(value.map(Number).filter(Number.isFinite));
}

function resolveGitCommit(root) {
  try {
    const commit = execSync('git rev-parse --short HEAD', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    return commit || null;
  } catch {
    return null;
  }
}

function getProfileCount() {
  try {
    return fs
      .readdirSync(profileRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .length;
  } catch {
    return 0;
  }
}

function ensureServerConfig() {
  try {
    if (!fs.existsSync(serverConfigPath)) {
      fs.writeFileSync(serverConfigPath, `${JSON.stringify(normalizeServerConfig({}), null, 2)}\n`, 'utf8');
      return;
    }
    const raw = fs.readFileSync(serverConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeServerConfig(parsed);
    const nextRaw = `${JSON.stringify(normalized, null, 2)}\n`;
    if (raw !== nextRaw) {
      fs.writeFileSync(serverConfigPath, nextRaw, 'utf8');
    }
  } catch (error) {
    console.warn('[server-config] failed to ensure server-config.json:', error.message);
  }
}

function normalizeServerConfig(value) {
  const libraries = normalizeLibraries(value?.libraries);
  const defaultLibrary = normalizeLibraryId(value?.defaultLibrary, DEFAULT_LIBRARY_ID);
  const libraryIds = new Set(libraries.map((item) => item.id));
  const effectiveDefaultLibrary = libraryIds.has(defaultLibrary) ? defaultLibrary : libraries[0].id;
  return {
    version: 2,
    apiKey: typeof value?.apiKey === 'string' ? value.apiKey.trim().slice(0, 512) : '',
    defaultModel: sanitizeModelName(value?.defaultModel, DEFAULT_AI_MODEL),
    showcaseMode: Boolean(value?.showcaseMode),
    allowLibrarySwitch: Boolean(value?.allowLibrarySwitch),
    defaultLibrary: effectiveDefaultLibrary,
    libraries
  };
}

function readServerConfig() {
  try {
    const raw = fs.readFileSync(serverConfigPath, 'utf8');
    return normalizeServerConfig(JSON.parse(raw));
  } catch {
    return normalizeServerConfig({});
  }
}

function profileDirectoryExists(profileId) {
  const safeId = normalizeProfileId(profileId, { fallback: '', allowGuest: false, strict: true });
  if (!safeId) return false;
  try {
    return fs.statSync(path.join(profileRoot, safeId)).isDirectory();
  } catch {
    return false;
  }
}

function allowsMissingProfile(requestPath) {
  const apiPath = String(requestPath || '').replace(/^\/api(?=\/|$)/, '') || '/';
  if (['/health', '/about', '/catalog', '/catalog/refresh', '/search', '/search/status'].includes(apiPath)) {
    return true;
  }
  return (
    apiPath.startsWith('/profiles/check/') ||
    apiPath === '/profiles/create' ||
    apiPath.startsWith('/score-tiers/') ||
    apiPath.startsWith('/pdf/') ||
    apiPath.startsWith('/download/question/') ||
    apiPath.startsWith('/download/file/')
  );
}

function buildAiMeta(config, req = null) {
  const serverConfig = req?.serverConfig ?? readServerConfig();
  const readOnly = Boolean(req?.readOnly);
  const showcaseMode = Boolean(req?.isShowcase ?? serverConfig.showcaseMode);
  const userApiKey = typeof config?.ai?.apiKey === 'string' ? config.ai.apiKey.trim() : '';
  const hasServerApiKey = Boolean(serverConfig.apiKey);
  const hasUserApiKey = Boolean(userApiKey);
  const canUseAi = !readOnly && !showcaseMode && (hasUserApiKey || hasServerApiKey);
  return {
    hasServerApiKey,
    hasUserApiKey,
    canUseAi,
    canUseCustomModel: canUseAi && hasUserApiKey,
    defaultModel: serverConfig.defaultModel || DEFAULT_AI_MODEL,
    model: sanitizeModelName(config?.ai?.model, serverConfig.defaultModel || DEFAULT_AI_MODEL),
    showcaseMode
  };
}

function buildServerState(req) {
  const context = req?.library ?? resolveLibraryContext(readServerConfig(), DEFAULT_LIBRARY_ID);
  const serverConfig = req?.serverConfig ?? readServerConfig();
  return {
    appVersion: APP_VERSION,
    gitCommit: APP_GIT_COMMIT,
    showcaseMode: Boolean(serverConfig.showcaseMode),
    allowLibrarySwitch: Boolean(serverConfig.allowLibrarySwitch),
    activeLibraryId: context.id,
    activeLibraryPathName: context.pathName,
    defaultLibraryId: context.defaultId,
    libraries: context.available.map((item) => ({ id: item.id, label: item.label, pathName: item.pathName }))
  };
}

function resolveAiApiKey(config, req = null) {
  if (req?.readOnly || req?.isShowcase) return '';
  const userApiKey = typeof config?.ai?.apiKey === 'string' ? config.ai.apiKey.trim() : '';
  if (userApiKey) return userApiKey;
  const serverConfig = req?.serverConfig ?? readServerConfig();
  return serverConfig.apiKey || '';
}

function normalizeProfileId(raw, { fallback = 'guest', allowGuest = true, strict = false } = {}) {
  const source = String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
  if (!source) return fallback;

  let normalized = source;
  if (strict) {
    if (!/^[a-z0-9_-]+$/.test(normalized)) return fallback;
  } else {
    normalized = source.replace(/[^a-z0-9_-]/g, '');
  }
  if (!normalized) return fallback;
  if (normalized.length > 40) {
    return strict ? fallback : normalized.slice(0, 40);
  }
  if (RESERVED_PROFILE_NAMES.has(normalized) || /^com[1-9]$/.test(normalized) || /^lpt[1-9]$/.test(normalized)) {
    if (allowGuest && normalized === 'guest') return 'guest';
    return fallback;
  }
  if (!allowGuest && normalized === 'guest') return fallback;
  return normalized;
}

function normalizeLibraryId(raw, fallback = DEFAULT_LIBRARY_ID) {
  const safe = String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return safe || fallback;
}

function normalizeLibraries(value) {
  const list = Array.isArray(value) ? value : [];
  const output = [];
  const seen = new Set();

  for (const item of list) {
    const normalized = normalizeLibraryEntry(item);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    output.push(normalized);
  }

  if (!seen.has(DEFAULT_LIBRARY_ID)) {
    output.unshift(normalizeLibraryEntry({ id: DEFAULT_LIBRARY_ID, label: 'Default Library', path: 'library' }));
  }

  if (output.length === 0) {
    output.push(normalizeLibraryEntry({ id: DEFAULT_LIBRARY_ID, label: 'Default Library', path: 'library' }));
  }

  return output.filter(Boolean);
}

function normalizeLibraryEntry(item) {
  try {
    const source = item && typeof item === 'object' ? item : {};
    const id = normalizeLibraryId(source.id || source.name || source.key || DEFAULT_LIBRARY_ID, DEFAULT_LIBRARY_ID);
    const label = typeof source.label === 'string' && source.label.trim() ? source.label.trim().slice(0, 64) : id;
    const rawPath = typeof source.path === 'string' && source.path.trim() ? source.path.trim() : (id === DEFAULT_LIBRARY_ID ? 'library' : '');
    if (!rawPath) return null;
    const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(appRoot, rawPath);
    const pathName = normalizeLibraryId(path.basename(absPath), id);
    if (!fs.existsSync(absPath)) {
      if (id === DEFAULT_LIBRARY_ID) {
        return { id, label, path: absPath, pathName };
      } else {
        return null;
      }
    }
    const stats = fs.statSync(absPath);
    if (!stats.isDirectory()) return null;
    return { id, label, path: absPath, pathName };
  } catch {
    return null;
  }
}

function resolveLibraryContext(serverConfig, requestedLibraryId) {
  const libraries = Array.isArray(serverConfig?.libraries) ? serverConfig.libraries : normalizeLibraries([]);
  const byId = new Map(libraries.map((item) => [item.id, item]));
  const defaultId = byId.has(serverConfig?.defaultLibrary) ? serverConfig.defaultLibrary : libraries[0]?.id ?? DEFAULT_LIBRARY_ID;
  const allowSwitch = Boolean(serverConfig?.allowLibrarySwitch);
  const requestedRaw = String(requestedLibraryId ?? '').normalize('NFKC').trim();
  const requestedId = allowSwitch ? normalizeLibraryId(requestedRaw, defaultId) : defaultId;
  const requestedPathName = allowSwitch ? normalizeLibraryId(path.basename(requestedRaw), '') : '';
  const chosen =
    byId.get(requestedId) ??
    (requestedPathName ? libraries.find((item) => item.pathName === requestedPathName) : null) ??
    byId.get(defaultId) ??
    libraries[0];
  return {
    id: chosen?.id ?? DEFAULT_LIBRARY_ID,
    label: chosen?.label ?? DEFAULT_LIBRARY_ID,
    pathName: chosen?.pathName ?? DEFAULT_LIBRARY_ID,
    path: chosen?.path ?? path.join(appRoot, 'library'),
    defaultId,
    allowSwitch,
    available: libraries
  };
}

function makeLibraryCacheKey(id, absolutePath) {
  const safeId = normalizeLibraryId(id, DEFAULT_LIBRARY_ID);
  const encodedPath = Buffer.from(String(absolutePath || ''), 'utf8').toString('base64url').slice(0, 40);
  return `${safeId}-${encodedPath || 'root'}`;
}

function getPdfPathsForKind(catalog, kind, id) {
  const primary = catalog?.fileMap?.[kind]?.get(id);
  const all = catalog?.fileMapAll?.[kind]?.get(id);
  const candidates = Array.isArray(all) ? all : [];
  const withPrimary = primary ? [primary, ...candidates] : candidates;
  return [...new Set(withPrimary.filter((value) => typeof value === 'string' && value.length > 0))];
}

function buildQuestionDownloadFilename(question, hasAnswer) {
  const base = typeof question?.id === 'string' ? question.id : 'question';
  const suffix = hasAnswer ? 'question-answer' : 'question-only';
  return `${base}-${suffix}.pdf`;
}

function generateOneTimeToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return randomBytes(16).toString('hex');
}

function cleanupOneTimeDownloads() {
  const now = Date.now();
  for (const [token, record] of oneTimeDownloadStore.entries()) {
    if (!record || record.expiresAt <= now) {
      oneTimeDownloadStore.delete(token);
    }
  }
}

function buildContentDisposition(filename) {
  const safeName = String(filename || 'download.pdf').replaceAll('\n', '').replaceAll('\r', '');
  const fallback = safeName.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

async function mergePdfFiles(filePaths) {
  const output = await PDFDocument.create();
  for (const filePath of filePaths) {
    const bytes = await fsp.readFile(filePath);
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageIndices = source.getPageIndices();
    if (pageIndices.length === 0) continue;
    const pages = await output.copyPages(source, pageIndices);
    for (const page of pages) {
      output.addPage(page);
    }
  }
  const merged = await output.save();
  return Buffer.from(merged);
}

// Use a broadly supported effort to avoid model-specific validation errors
// (for example "minimal" is rejected by gpt-5.4-mini).
function resolveReasoningEffort(model) {
  void model;
  return 'low';
}

function normalizeIncomingExamDraft(value) {
  const now = new Date().toISOString();
  const draft = value && typeof value === 'object' ? value : {};
  const suiteId = typeof draft.suiteId === 'string' ? draft.suiteId : '';
  const createdAt = typeof draft.createdAt === 'string' ? draft.createdAt : now;
  return {
    suiteId,
    phase: draft.phase === 'grading' ? 'grading' : 'taking',
    currentIndex: clampInteger(draft.currentIndex, 0, 1000, 0),
    remainingSeconds: clampInteger(draft.remainingSeconds, 0, 24 * 60 * 60, 0),
    paused: Boolean(draft.paused),
    records: normalizeExamRecords(draft.records),
    grades: normalizeExamGrades(draft.grades),
    createdAt,
    updatedAt: now
  };
}

function normalizeExamRecords(records) {
  if (!records || typeof records !== 'object') return {};
  const output = {};
  for (const [questionId, status] of Object.entries(records)) {
    if (typeof questionId !== 'string') continue;
    if (status === 'completed' || status === 'skipped') output[questionId] = status;
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

function summarizeAiConversations(aiHistory, questionsById) {
  const conversations = Array.isArray(aiHistory?.conversations) ? aiHistory.conversations : [];
  return conversations
    .map((conversation) => {
      const hydrated = conversation.compressed ? null : hydrateConversation(conversation);
      const question = questionsById.get(conversation.questionId);
      const messageCount = conversation.compressed
        ? Number(conversation.messageCount) || 0
        : hydrated?.messages?.length ?? 0;
      const preview = typeof conversation.preview === 'string' && conversation.preview.trim()
        ? conversation.preview.trim()
        : createConversationPreview(hydrated?.messages ?? []);
      return {
        id: conversation.id,
        questionId: conversation.questionId,
        questionLabel: question?.label ?? conversation.questionId,
        questionTitle: question ? `${question.sourceLabel} · ${question.label}` : conversation.questionId,
        suiteTitle: question?.suiteTitle ?? '',
        model: sanitizeModelName(conversation.model, DEFAULT_AI_MODEL),
        createdAt: typeof conversation.createdAt === 'string' ? conversation.createdAt : new Date().toISOString(),
        updatedAt: typeof conversation.updatedAt === 'string' ? conversation.updatedAt : new Date().toISOString(),
        compressed: Boolean(conversation.compressed),
        messageCount,
        preview
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function findConversationByQuestion(aiHistory, questionId) {
  const conversations = Array.isArray(aiHistory?.conversations) ? aiHistory.conversations : [];
  return conversations
    .filter((conversation) => conversation.questionId === questionId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
}

function getConversationById(aiHistory, id) {
  const conversations = Array.isArray(aiHistory?.conversations) ? aiHistory.conversations : [];
  return conversations.find((conversation) => conversation.id === id) ?? null;
}

function upsertConversation(aiHistory, conversation) {
  if (!aiHistory || typeof aiHistory !== 'object') return;
  aiHistory.conversations = Array.isArray(aiHistory.conversations) ? aiHistory.conversations : [];
  const existingIndex = aiHistory.conversations.findIndex((item) => item.id === conversation.id);
  const rawMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const cappedMessages = rawMessages.length > MAX_AI_CONVERSATION_MESSAGES
    ? rawMessages.slice(rawMessages.length - MAX_AI_CONVERSATION_MESSAGES)
    : rawMessages;
  const normalized = {
    ...conversation,
    model: sanitizeModelName(conversation.model, DEFAULT_AI_MODEL),
    messageCount: cappedMessages.length,
    preview: typeof conversation.preview === 'string' ? conversation.preview.slice(0, 220) : '',
    compressed: Boolean(conversation.compressed),
    payload: typeof conversation.payload === 'string' ? conversation.payload : '',
    messages: cappedMessages
  };
  if (existingIndex >= 0) {
    aiHistory.conversations[existingIndex] = normalized;
  } else {
    aiHistory.conversations.push(normalized);
  }
}

function hydrateConversation(conversation) {
  if (!conversation || typeof conversation !== 'object') return null;
  let messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  if (conversation.compressed) {
    messages = decompressMessages(conversation.payload);
  }
  const normalizedMessages = normalizeMessages(messages);
  return {
    id: conversation.id,
    questionId: conversation.questionId,
    model: sanitizeModelName(conversation.model, DEFAULT_AI_MODEL),
    createdAt: typeof conversation.createdAt === 'string' ? conversation.createdAt : new Date().toISOString(),
    updatedAt: typeof conversation.updatedAt === 'string' ? conversation.updatedAt : new Date().toISOString(),
    compressed: Boolean(conversation.compressed),
    messageCount: normalizedMessages.length,
    preview: typeof conversation.preview === 'string' ? conversation.preview : createConversationPreview(normalizedMessages),
    messages: normalizedMessages
  };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message === 'object')
    .map((message) => ({
      id: typeof message.id === 'string' ? message.id : makeMessageId(),
      role: message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
      content: typeof message.content === 'string' ? message.content.slice(0, 20000) : '',
      createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
      error: Boolean(message.error)
    }))
    .filter((message) => message.content.length > 0)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function enforceAiCompression(aiHistory) {
  if (!aiHistory || typeof aiHistory !== 'object') return;
  const conversations = Array.isArray(aiHistory.conversations) ? aiHistory.conversations : [];
  const sorted = conversations.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  for (let index = 0; index < sorted.length; index += 1) {
    const conversation = sorted[index];
    const hydrated = hydrateConversation(conversation);
    if (!hydrated) continue;

    if (index < ACTIVE_AI_CONVERSATIONS_LIMIT) {
      conversation.compressed = false;
      conversation.payload = '';
      conversation.messages = hydrated.messages;
      conversation.messageCount = hydrated.messages.length;
      conversation.preview = hydrated.preview;
      continue;
    }

    conversation.compressed = true;
    conversation.payload = compressMessages(hydrated.messages);
    conversation.messages = [];
    conversation.messageCount = hydrated.messages.length;
    conversation.preview = hydrated.preview;
  }
}

function compressMessages(messages) {
  try {
    const json = JSON.stringify(normalizeMessages(messages));
    return gzipSync(Buffer.from(json, 'utf8')).toString('base64');
  } catch {
    return '';
  }
}

function decompressMessages(payload) {
  try {
    if (!payload || typeof payload !== 'string') return [];
    const raw = gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
    return normalizeMessages(JSON.parse(raw));
  } catch {
    return [];
  }
}

function createConversationPreview(messages) {
  const source = [...messages].reverse().find((message) => typeof message.content === 'string' && message.content.trim());
  if (!source) return '';
  return source.content.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function makeConversationId(questionId) {
  if (globalThis.crypto?.randomUUID) return `${questionId}-${globalThis.crypto.randomUUID()}`;
  return `${questionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeMessageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const PDF_TEXT_CACHE_LIMIT = 96;
const pdfTextCache = new Map();

const PROMPT_STRINGS = {
  'zh-CN': {
    id: '题目编号',
    label: '题目标签',
    questionHeader: '【原题 PDF 抽取文本】',
    answerHeader: '【答案 / 评分 PDF 抽取文本】',
    noQuestion: '(未能提取原题文本，请基于题号与通用知识作答并指出该局限。)',
    noAnswer: '(未能提取答案文本，请仅用原题推理，并提醒用户核对官方 Lösung。)',
    followupLead: '用户追加提问：',
    initial: '请按系统提示结构输出精炼讲解，优先覆盖解题步骤、评分点与易错点；篇幅控制在必要范围内。'
  },
  'en': {
    id: 'Question ID',
    label: 'Question label',
    questionHeader: '[Question PDF — extracted text]',
    answerHeader: '[Answer / rubric PDF — extracted text]',
    noQuestion: '(Could not extract the question text. Answer using the ID and general knowledge, and state this limitation.)',
    noAnswer: '(Could not extract the answer text. Reason only from the question and remind the user to check the official Lösung.)',
    followupLead: 'Follow-up from the user:',
    initial: 'Follow the fixed structure and keep the explanation concise; prioritise solution steps, scoring points, and common pitfalls.'
  },
  'de': {
    id: 'Aufgaben-ID',
    label: 'Bezeichnung',
    questionHeader: '[Aufgaben-PDF — extrahierter Text]',
    answerHeader: '[Lösungs-/Bewertungs-PDF — extrahierter Text]',
    noQuestion: '(Der Aufgabentext konnte nicht extrahiert werden. Antworte mit Hilfe der ID und Allgemeinwissen und weise auf diese Einschränkung hin.)',
    noAnswer: '(Der Lösungstext konnte nicht extrahiert werden. Argumentiere nur aus der Aufgabe und bitte den Nutzer, die offizielle Lösung zu prüfen.)',
    followupLead: 'Rückfrage der Nutzerin / des Nutzers:',
    initial: 'Nutze die feste Struktur und antworte prägnant; fokussiere auf Lösungsschritte, Punktevergabe und typische Fehler.'
  }
};

async function buildQuestionPrompt({ catalog, question, followup, locale = 'zh-CN' }) {
  const questionPdfPath = catalog.fileMap.au.get(question.id);
  const answerPdfPath = catalog.fileMap.lo.get(question.id) ?? null;
  const [questionText, answerText] = await Promise.all([
    extractPdfText(questionPdfPath),
    answerPdfPath ? extractPdfText(answerPdfPath) : Promise.resolve('')
  ]);

  const strings = PROMPT_STRINGS[normalizeLocale(locale)] ?? PROMPT_STRINGS['zh-CN'];
  const baseInstruction = followup
    ? `${strings.followupLead}\n${followup.trim().slice(0, MAX_FOLLOWUP_PROMPT_CHARS)}`
    : strings.initial;

  return [
    `${strings.id}: ${question.id}`,
    `${strings.label}: ${question.sourceLabel} · ${question.label}`,
    '',
    strings.questionHeader,
    questionText || strings.noQuestion,
    '',
    strings.answerHeader,
    answerText || strings.noAnswer,
    '',
    baseInstruction
  ].join('\n');
}

async function extractPdfText(filePath) {
  if (!filePath) return '';
  try {
    const stat = await fsp.stat(filePath);
    const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
    const cached = pdfTextCache.get(cacheKey);
    if (cached !== undefined) {
      pdfTextCache.delete(cacheKey);
      pdfTextCache.set(cacheKey, cached);
      return cached;
    }
    for (const key of pdfTextCache.keys()) {
      if (key.startsWith(`${filePath}:`)) pdfTextCache.delete(key);
    }

    const { getDocument } = await loadPdfjs();
    const buffer = await fsp.readFile(filePath);
    const loadingTask = getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;
    const pages = Math.min(pdf.numPages, 12);
    const chunks = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const lines = textContent.items
        .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean);
      if (lines.length > 0) {
        chunks.push(lines.join(' '));
      }
      const currentLength = chunks.join('\n').length;
      if (currentLength >= MAX_PDF_TEXT_CHARS) break;
    }
    const normalized = chunks.join('\n').replace(/\s+/g, ' ').trim().slice(0, MAX_PDF_TEXT_CHARS);
    setPdfTextCache(cacheKey, normalized);
    return normalized;
  } catch (error) {
    console.warn('[ai] failed to extract pdf text:', path.basename(filePath), error.message);
    return '';
  }
}

function setPdfTextCache(key, value) {
  if (pdfTextCache.has(key)) pdfTextCache.delete(key);
  pdfTextCache.set(key, value);
  while (pdfTextCache.size > PDF_TEXT_CACHE_LIMIT) {
    const oldestKey = pdfTextCache.keys().next().value;
    if (!oldestKey) break;
    pdfTextCache.delete(oldestKey);
  }
}

const PROMPT_FILES = {
  'zh-CN': 'zh-CN.txt',
  en: 'en.txt',
  de: 'de.txt'
};

function normalizeLocale(value) {
  if (typeof value !== 'string') return 'zh-CN';
  const trimmed = value.trim();
  if (!trimmed) return 'zh-CN';
  if (/^zh/i.test(trimmed)) return 'zh-CN';
  if (/^de/i.test(trimmed)) return 'de';
  if (/^en/i.test(trimmed)) return 'en';
  return 'zh-CN';
}

function resolveAiPromptLocale(requestedLocale, fallbackLocale = 'en-US') {
  const requested = typeof requestedLocale === 'string' ? requestedLocale.trim() : '';
  if (requested) return requested;
  const fallback = typeof fallbackLocale === 'string' ? fallbackLocale.trim() : '';
  return fallback || 'en-US';
}

async function readDefaultPrompt(locale = 'zh-CN') {
  const key = normalizeLocale(locale);
  // An operator-overridden defaultprompt.txt still wins for the default
  // locale (zh-CN), so self-hosted deployments can keep their customisation.
  if (key === 'zh-CN') {
    try {
      const raw = await fsp.readFile(defaultPromptPath, 'utf8');
      const trimmed = raw.trim();
      if (trimmed.length > 0) return trimmed.slice(0, 12000);
    } catch {
      // fall through to built-in prompt
    }
  }
  return (await readPromptFile(key)) || (await readPromptFile('zh-CN')) || '';
}

async function resolveSystemPrompt(config, locale = 'zh-CN') {
  const customPrompt = typeof config?.ai?.customPrompt === 'string' ? config.ai.customPrompt.trim() : '';
  if (customPrompt) return customPrompt.slice(0, 12000);
  return readDefaultPrompt(locale);
}

async function readPromptFile(localeKey) {
  const filename = PROMPT_FILES[localeKey] ?? PROMPT_FILES['zh-CN'];
  try {
    const raw = await fsp.readFile(path.join(promptsRoot, filename), 'utf8');
    const trimmed = raw.trim();
    return trimmed ? trimmed.slice(0, 12000) : '';
  } catch {
    return '';
  }
}

const AI_REQUEST_TIMEOUT_MS = 60_000;
const AI_MAX_OUTPUT_TOKENS = 1200;
const AI_CONTINUATION_MAX_OUTPUT_TOKENS = 900;
const AI_MAX_SEGMENTS = 3;
const AI_CONTINUATION_PROMPT =
  'Continue exactly where your previous reply stopped. Do not repeat. Finish any unfinished sentence, list, Markdown marker, or LaTeX delimiter.';

async function requestAiCompletion({ apiKey, model, systemPrompt, userPrompt }) {
  const safeModel = sanitizeModelName(model, DEFAULT_AI_MODEL);
  const effort = resolveReasoningEffort(safeModel);
  const parts = [];
  let previousResponseId = null;

  for (let index = 0; index < AI_MAX_SEGMENTS; index += 1) {
    const continuation = index > 0;
    const maxOutputTokens = continuation ? AI_CONTINUATION_MAX_OUTPUT_TOKENS : AI_MAX_OUTPUT_TOKENS;
    const body = continuation
      ? {
          model: safeModel,
          reasoning: { effort },
          max_output_tokens: maxOutputTokens,
          previous_response_id: previousResponseId,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: AI_CONTINUATION_PROMPT }]
            }
          ]
        }
      : {
          model: safeModel,
          reasoning: { effort },
          max_output_tokens: maxOutputTokens,
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: systemPrompt }]
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: userPrompt }]
            }
          ]
        };

    let payload;
    try {
      payload = await sendResponsesRequest(apiKey, body);
    } catch (error) {
      // If continuation fails after we already have useful content, keep the
      // partial reply instead of failing the whole request.
      if (parts.length > 0) break;
      throw error;
    }

    const text = pickResponseText(payload);
    if (text) parts.push(text);

    const incomplete = isResponseIncomplete(payload)
      || isLikelyTokenCapped(payload, maxOutputTokens)
      || isLikelyTruncatedText(text);
    previousResponseId = typeof payload?.id === 'string' ? payload.id : null;
    if (!incomplete || !previousResponseId) break;
  }

  const merged = parts.join('\n\n').trim();
  if (!merged) {
    throw new Error('AI 未返回可用文本。');
  }
  return merged;
}

async function sendResponsesRequest(apiKey, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
      throw new Error(`AI 请求超时（${Math.round(AI_REQUEST_TIMEOUT_MS / 1000)}s）。`);
    }
    throw new Error(`AI 网络异常：${error?.message || '未知错误'}`);
  }
  clearTimeout(timeout);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `AI 请求失败 (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

function isResponseIncomplete(payload) {
  const status = typeof payload?.status === 'string' ? payload.status.toLowerCase() : '';
  if (status === 'incomplete') return true;
  if (payload?.incomplete_details && typeof payload.incomplete_details === 'object') return true;
  for (const item of payload?.output ?? []) {
    const itemStatus = typeof item?.status === 'string' ? item.status.toLowerCase() : '';
    if (itemStatus === 'incomplete') return true;
  }
  return false;
}

function isLikelyTokenCapped(payload, maxOutputTokens) {
  const used = Number(payload?.usage?.output_tokens);
  if (!Number.isFinite(used) || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return false;
  return used >= maxOutputTokens - 8;
}

function isLikelyTruncatedText(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const codeFenceCount = (trimmed.match(/```/g) ?? []).length;
  if (codeFenceCount % 2 === 1) return true;

  const boldCount = (trimmed.match(/\*\*/g) ?? []).length;
  if (boldCount % 2 === 1) return true;

  if (/(\*\*|\*|`|\$|\$\$|\\|\(|\[|\{|:|：|、|-)$/.test(trimmed)) return true;
  return false;
}

function pickResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const chunks = [];
  for (const item of payload?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }
  return chunks.join('\n\n').trim();
}
