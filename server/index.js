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

const __filename = fileURLToPath(import.meta.url);
const appRoot = path.resolve(path.dirname(__filename), '..');
const { version: APP_VERSION } = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const APP_GIT_COMMIT = resolveGitCommit(appRoot);
const profileRoot = path.join(appRoot, 'profile');
const userRoot = path.join(appRoot, 'user');
const serverConfigPath = path.join(userRoot, 'server-config.json');
const defaultPromptPath = path.join(appRoot, 'defaultprompt.txt');
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
  '/ai/message',
  '/profiles/create'
]);

if (!fs.existsSync(profileRoot)) {
  fs.mkdirSync(profileRoot, { recursive: true });
}
if (!fs.existsSync(userRoot)) {
  fs.mkdirSync(userRoot, { recursive: true });
}
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
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
  statuses: ['unseen', 'meh', 'baffled'],
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
const EMPTY_PROGRESS = Object.freeze({ mastered: [], meh: [], baffled: [], ignored: [], starred: [] });
const EMPTY_EXAM_DRAFTS = Object.freeze({ version: 1, drafts: [] });
const EMPTY_AI_HISTORY = Object.freeze({ version: 1, conversations: [] });
const guestStorage = {
  async ensure() {},
  async readConfig()       { return { historyLimit: 500, examMinutes: 270, ai: { apiKey: '', model: DEFAULT_AI_MODEL } }; },
  async readProgress()     { return { ...EMPTY_PROGRESS }; },
  async readHistory()      { return []; },
  async readProbeHistory() { return []; },
  async readExamDrafts()   { return { ...EMPTY_EXAM_DRAFTS, drafts: [] }; },
  async writeExamDrafts()  {},
  async readAiHistory()    { return { ...EMPTY_AI_HISTORY, conversations: [] }; },
  async writeAiHistory()   {},
  async writeProgress()    {},
  async recordAttempt()    {
    return {
      progress: { ...EMPTY_PROGRESS },
      history: [],
      config: { historyLimit: 500, examMinutes: 270, ai: { apiKey: '', model: DEFAULT_AI_MODEL } },
      examDrafts: { ...EMPTY_EXAM_DRAFTS, drafts: [] },
      aiHistory: { ...EMPTY_AI_HISTORY, conversations: [] }
    };
  },
  async setStar()          {
    return {
      progress: { ...EMPTY_PROGRESS },
      history: [],
      config: { historyLimit: 500, examMinutes: 270, ai: { apiKey: '', model: DEFAULT_AI_MODEL } },
      examDrafts: { ...EMPTY_EXAM_DRAFTS, drafts: [] },
      aiHistory: { ...EMPTY_AI_HISTORY, conversations: [] }
    };
  },
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

    const { locale, aiApiKey, aiModel } = req.body ?? {};
    const updated = { ...current };
    if (typeof locale === 'string' && locale.length > 0 && locale.length <= 32) {
      updated.locale = locale;
    }
    updated.ai = {
      ...(updated.ai ?? {}),
      apiKey: typeof aiApiKey === 'string' ? aiApiKey.trim().slice(0, 512) : updated.ai?.apiKey ?? '',
      model: sanitizeModelName(typeof aiModel === 'string' ? aiModel : updated.ai?.model ?? DEFAULT_AI_MODEL, DEFAULT_AI_MODEL)
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
      locale: config.locale
    });

    try {
      const assistantContent = await requestAiCompletion({
        apiKey: aiApiKey,
        model,
        systemPrompt: await readDefaultPrompt(config.locale),
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

    upsertConversation(aiHistory, conversation);
    enforceAiCompression(aiHistory);
    await req.storage.writeAiHistory(aiHistory);

    response.json({
      existing: false,
      conversation: hydrateConversation(conversation),
      aiMeta,
      conversations: summarizeAiConversations(aiHistory, activeCatalog.questionsById)
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
    const { conversationId, content, model: requestedModel } = req.body ?? {};
    const safeConversationId = typeof conversationId === 'string' ? conversationId : '';
    const trimmedContent = typeof content === 'string' ? content.trim() : '';
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

    const aiHistory = await req.storage.readAiHistory();
    const conversation = getConversationById(aiHistory, safeConversationId);
    if (!conversation) {
      response.status(404).json({ error: 'CONVERSATION_NOT_FOUND', message: '会话不存在。' });
      return;
    }

    const hydrated = hydrateConversation(conversation);
    const effectiveModel = aiMeta.canUseCustomModel
      ? sanitizeModelName(requestedModel || config.ai?.model || hydrated.model || aiMeta.defaultModel, aiMeta.defaultModel)
      : aiMeta.defaultModel;
    hydrated.model = effectiveModel;
    hydrated.messages.push({
      id: makeMessageId(),
      role: 'user',
      content: trimmedContent.slice(0, MAX_FOLLOWUP_PROMPT_CHARS),
      createdAt: new Date().toISOString(),
      error: false
    });
    hydrated.updatedAt = new Date().toISOString();

    const question = activeCatalog.questionsById.get(hydrated.questionId);
    if (!question) {
      response.status(404).json({ error: 'UNKNOWN_QUESTION', message: '该会话对应题目不存在。' });
      return;
    }

    try {
      const userPrompt = await buildQuestionPrompt({
        catalog: activeCatalog,
        question,
        followup: trimmedContent.slice(0, MAX_FOLLOWUP_PROMPT_CHARS),
        locale: config.locale
      });
      const assistantContent = await requestAiCompletion({
        apiKey: aiApiKey,
        model: effectiveModel,
        systemPrompt: await readDefaultPrompt(config.locale),
        userPrompt
      });
      hydrated.messages.push({
        id: makeMessageId(),
        role: 'assistant',
        content: assistantContent,
        createdAt: new Date().toISOString(),
        error: false
      });
    } catch (error) {
      hydrated.messages.push({
        id: makeMessageId(),
        role: 'assistant',
        content: `AI 请求失败：${error.message || '未知错误'}`,
        createdAt: new Date().toISOString(),
        error: true
      });
    }

    hydrated.updatedAt = new Date().toISOString();
    hydrated.messageCount = hydrated.messages.length;
    hydrated.preview = createConversationPreview(hydrated.messages);
    upsertConversation(aiHistory, hydrated);
    enforceAiCompression(aiHistory);
    await req.storage.writeAiHistory(aiHistory);

    response.json({
      conversation: hydrateConversation(getConversationById(aiHistory, hydrated.id)),
      aiMeta,
      conversations: summarizeAiConversations(aiHistory, activeCatalog.questionsById)
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
  const exists = fs.existsSync(path.join(profileRoot, safeId));
  res.json({ exists, id: safeId });
});

app.post('/api/profiles/create', async (req, res, next) => {
  try {
    const serverConfig = readServerConfig();
    if (serverConfig.showcaseMode) {
      return res.status(403).json({ error: 'SHOWCASE_MODE', message: '展示模式下已关闭登录功能。' });
    }

    const { id, token } = req.body;
    const safeId = normalizeProfileId(id, { fallback: '', allowGuest: false, strict: true });
    if (!safeId) return res.status(400).json({ error: 'INVALID_ID' });
    
    if (fs.existsSync(path.join(profileRoot, safeId))) {
      return res.status(400).json({ error: 'ALREADY_EXISTS' });
    }

    const isValid = await validateToken(appRoot, token);
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

app.listen(port, () => {
  console.log(`QED v${APP_VERSION} running at http://localhost:${port}`);
});

await warmupCatalog();

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
      loadedAt: 0
    };
    catalogCache.set(cacheKey, state);
  }

  if (!force && state.catalog && Date.now() - state.loadedAt < CATALOG_REFRESH_INTERVAL_MS) {
    return state.catalog;
  }

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

function getProgressStatus(progress, id) {
  for (const status of PROGRESS_STATUSES) {
    if (progress[status]?.includes(id)) return status;
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

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
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

function sanitizeModelName(value, fallback = DEFAULT_AI_MODEL) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (!/^[a-zA-Z0-9._:-]{2,64}$/.test(trimmed)) return fallback;
  return trimmed;
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

const pdfTextCache = new Map();
let pdfJsModulePromise = null;

const PROMPT_STRINGS = {
  'zh-CN': {
    id: '题目编号',
    label: '题目标签',
    questionHeader: '【原题 PDF 抽取文本】',
    answerHeader: '【答案 / 评分 PDF 抽取文本】',
    noQuestion: '(未能提取原题文本，请基于题号与通用知识作答并指出该局限。)',
    noAnswer: '(未能提取答案文本，请仅用原题推理，并提醒用户核对官方 Lösung。)',
    followupLead: '用户追加提问：',
    initial: '请按系统提示的固定结构给出高质量讲解，并结合评分规则总结得分点与常见失分点。'
  },
  'en': {
    id: 'Question ID',
    label: 'Question label',
    questionHeader: '[Question PDF — extracted text]',
    answerHeader: '[Answer / rubric PDF — extracted text]',
    noQuestion: '(Could not extract the question text. Answer using the ID and general knowledge, and state this limitation.)',
    noAnswer: '(Could not extract the answer text. Reason only from the question and remind the user to check the official Lösung.)',
    followupLead: 'Follow-up from the user:',
    initial: 'Produce a high-quality explanation in the fixed structure defined in the system prompt, and summarise scoring points and common pitfalls from the rubric.'
  },
  'de': {
    id: 'Aufgaben-ID',
    label: 'Bezeichnung',
    questionHeader: '[Aufgaben-PDF — extrahierter Text]',
    answerHeader: '[Lösungs-/Bewertungs-PDF — extrahierter Text]',
    noQuestion: '(Der Aufgabentext konnte nicht extrahiert werden. Antworte mit Hilfe der ID und Allgemeinwissen und weise auf diese Einschränkung hin.)',
    noAnswer: '(Der Lösungstext konnte nicht extrahiert werden. Argumentiere nur aus der Aufgabe und bitte den Nutzer, die offizielle Lösung zu prüfen.)',
    followupLead: 'Rückfrage der Nutzerin / des Nutzers:',
    initial: 'Liefere eine hochwertige Erklärung in der im System-Prompt festgelegten Struktur und fasse Punkteregel und häufige Fehler aus der Bewertung zusammen.'
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
    if (cached) return cached;
    for (const key of pdfTextCache.keys()) {
      if (key.startsWith(`${filePath}:`)) pdfTextCache.delete(key);
    }

    const { getDocument } = await loadPdfJs();
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
    pdfTextCache.set(cacheKey, normalized);
    return normalized;
  } catch (error) {
    console.warn('[ai] failed to extract pdf text:', path.basename(filePath), error.message);
    return '';
  }
}

async function loadPdfJs() {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfJsModulePromise;
}

// Locale → (language name, worked-example prompt). Each prompt is written so
// the model answers in that language but always preserves German math-exam
// terminology (Teil, Aufgabe, Punkte, etc.) verbatim. LaTeX delimiters match
// what our front-end renderer expects: $...$ inline, $$...$$ display.
const AI_PROMPTS = {
  'zh-CN': [
    '你是一名奥地利 AHS SRDP 数学考试辅导助教，服务对象是正在刷题的学生。',
    '',
    '硬性规则：',
    '1. 严格基于提供的「题目文本」和「答案/评分文本」作答，不得编造题目中未出现的条件或数值。',
    '2. 若题目或答案缺失关键信息，先明确指出缺失项，再给出最合理的假设后的解法。',
    '3. 默认使用简体中文回答；保留德语专有名词原文（Teil, Aufgabe, Punkte, Note, Lösung, WS, AN, AG 等），不翻译。',
    '4. 所有公式使用 LaTeX：行内用 $...$，独立公式用 $$...$$，不要写 \\\\[ \\\\] 或 ``` 代码块包公式。',
    '5. 单位、变量名与德语原卷一致（如 x, k, n, s, p），不要改名。',
    '',
    '首次回答的固定结构：',
    '- **题目理解**：1–3 行概括条件与要求。',
    '- **解题步骤**：按序编号；每一步给出动作与对应公式。',
    '- **评分点**：按 Punkt 可能拆分的得分点分条（1 Punkt / 2 Punkte 等）。',
    '- **易错点**：最多 5 条，写具体情形。',
    '- **一句话总结**：便于记忆。',
    '',
    '追问规则：用户继续提问时，只回答追问本身，不要重复整题长解；若追问与本题无关，礼貌说明并引导回题目。'
  ].join('\n'),
  'en': [
    'You are a tutor for the Austrian AHS SRDP mathematics exam, helping a student practice.',
    '',
    'Hard rules:',
    '1. Ground every claim in the provided question text and answer/rubric text. Do not invent conditions or numbers.',
    '2. If key information is missing, state what is missing first, then proceed with the most reasonable assumption.',
    '3. Reply in English. Keep German exam terminology verbatim (Teil, Aufgabe, Punkte, Note, Lösung, WS, AN, AG, etc.); do not translate these.',
    '4. Use LaTeX for every formula: $...$ inline, $$...$$ for display. Do not use \\\\[ \\\\] or ``` code fences around math.',
    '5. Preserve the original variable names and units from the German source (x, k, n, s, p, …).',
    '',
    'Fixed structure for the initial answer:',
    '- **Understanding**: 1–3 lines summarising the givens and the ask.',
    '- **Solution steps**: numbered; each step states the action and the formula.',
    '- **Scoring points**: one bullet per Punkt that can be earned (1 Punkt / 2 Punkte …).',
    '- **Common mistakes**: at most 5 items, each concrete.',
    '- **One-line takeaway**: short and memorable.',
    '',
    'Follow-ups: answer only what the user asks, do not repeat the full solution. If the follow-up is off-topic, politely redirect to the question.'
  ].join('\n'),
  'de': [
    'Du bist Tutor für die österreichische AHS-SRDP-Mathematikmatura und unterstützt eine Schülerin oder einen Schüler beim Üben.',
    '',
    'Harte Regeln:',
    '1. Jede Aussage muss durch den gegebenen „Aufgabentext“ und die „Lösung/Bewertung“ belegt sein. Keine Bedingungen oder Zahlen erfinden.',
    '2. Fehlen wichtige Informationen, benenne die Lücke zuerst und rechne dann mit der plausibelsten Annahme weiter.',
    '3. Antworte auf Deutsch. Fachbegriffe der Matura (Teil, Aufgabe, Punkte, Note, Lösung, WS, AN, AG …) wörtlich übernehmen.',
    '4. Formeln immer in LaTeX setzen: $...$ inline, $$...$$ für abgesetzte Formeln. Keine \\\\[ \\\\]-Klammern und keine ```-Codeblöcke um Mathematik.',
    '5. Variablen- und Einheitennamen (x, k, n, s, p, …) aus der Originalaufgabe unverändert beibehalten.',
    '',
    'Feste Struktur der Erstantwort:',
    '- **Aufgabenverständnis**: 1–3 Zeilen mit Gegebenem und Gesuchtem.',
    '- **Lösungsschritte**: durchnummeriert; pro Schritt Aktion und Formel.',
    '- **Punkte**: je vergebbarem Punkt einen Spiegelstrich (1 Punkt / 2 Punkte …).',
    '- **Häufige Fehler**: maximal 5, konkret formuliert.',
    '- **Merksatz**: eine Zeile zum Einprägen.',
    '',
    'Rückfragen: beantworte nur die Rückfrage, wiederhole nicht die gesamte Lösung. Ist die Frage themenfremd, höflich zur Aufgabe zurückführen.'
  ].join('\n')
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
  return AI_PROMPTS[key] ?? AI_PROMPTS['zh-CN'];
}

const AI_REQUEST_TIMEOUT_MS = 60_000;
const AI_MAX_OUTPUT_TOKENS = 1200;
const AI_CONTINUATION_MAX_OUTPUT_TOKENS = 900;
const AI_MAX_SEGMENTS = 3;
const AI_CONTINUATION_PROMPT =
  '请从你上一条回复的末尾继续，直接续写未完成内容，不要重复已写过的段落。';

async function requestAiCompletion({ apiKey, model, systemPrompt, userPrompt }) {
  const safeModel = sanitizeModelName(model, DEFAULT_AI_MODEL);
  const effort = resolveReasoningEffort(safeModel);
  const parts = [];
  let previousResponseId = null;

  for (let index = 0; index < AI_MAX_SEGMENTS; index += 1) {
    const continuation = index > 0;
    const body = continuation
      ? {
          model: safeModel,
          reasoning: { effort },
          max_output_tokens: AI_CONTINUATION_MAX_OUTPUT_TOKENS,
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
          max_output_tokens: AI_MAX_OUTPUT_TOKENS,
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

    const incomplete = isResponseIncomplete(payload);
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
