import fs from 'node:fs/promises';
import path from 'node:path';

const QUESTION_RE = /^\[(\d{4})([a-z]\d)\]t([12])-(\d+)(?:-([a-z]{2}))?\.pdf$/i;
const SUITE_DIR_RE = /^\[(au|lo)\](.+)$/i;

const TOPIC_LABELS = {
  ag: 'AG · Algebra und Geometrie',
  fa: 'FA · Funktionale Abhängigkeiten',
  an: 'AN · Analysis',
  ws: 'WS · Wahrscheinlichkeit und Statistik'
};

const TERM_ORDER = {
  wintertermin: 1,
  haupttermin: 2,
  'nebentermin-1': 3,
  'nebentermin-2': 4,
  herbsttermin: 5
};

function normalizeId(year, termCode, part, number, topic) {
  return `${year}${termCode}-t${part}-${Number(number)}${topic ? `-${topic.toLowerCase()}` : ''}`;
}

function parseSuiteDirectory(dirName) {
  const match = dirName.match(SUITE_DIR_RE);
  if (!match) return null;

  const [, kind, rawSlug] = match;
  const yearMatch = rawSlug.match(/-(\d{4})$/);
  if (!yearMatch) return null;

  const year = Number(yearMatch[1]);
  const termSlug = rawSlug.replace(/-\d{4}$/, '').toLowerCase();
  const id = `${termSlug}-${year}`;

  return {
    id,
    kind: kind.toLowerCase(),
    year,
    termSlug,
    title: formatSuiteTitle(termSlug, year)
  };
}

function formatSuiteTitle(termSlug, year) {
  const termNames = {
    haupttermin: 'Haupttermin',
    herbsttermin: 'Herbsttermin',
    wintertermin: 'Wintertermin',
    'nebentermin-1': 'Nebentermin 1',
    'nebentermin-2': 'Nebentermin 2'
  };

  return `${termNames[termSlug] ?? titleCase(termSlug.replaceAll('-', ' '))} ${year}`;
}

function titleCase(value) {
  return value
    .split(' ')
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ');
}

function parseQuestionFile(fileName, suite) {
  const match = fileName.match(QUESTION_RE);
  if (!match || !suite) return null;

  const [, year, termCode, part, number, topic] = match;
  const id = normalizeId(year, termCode.toLowerCase(), part, number, topic);
  const numericYear = Number(year);
  const numericPart = Number(part);
  const numericNumber = Number(number);

  return {
    id,
    fileBase: fileName.replace(/\.pdf$/i, ''),
    year: numericYear,
    termCode: termCode.toLowerCase(),
    termSlug: suite.termSlug,
    termName: formatSuiteTitle(suite.termSlug, numericYear).replace(` ${numericYear}`, ''),
    suiteId: suite.id,
    suiteTitle: suite.title,
    part: numericPart,
    number: numericNumber,
    topic: topic ? topic.toLowerCase() : null,
    topicLabel: topic ? TOPIC_LABELS[topic.toLowerCase()] ?? topic.toUpperCase() : 'Teil 2',
    label: `T${numericPart}-${String(numericNumber).padStart(2, '0')}${topic ? ` · ${topic.toUpperCase()}` : ''}`,
    sourceLabel: `${formatSuiteTitle(suite.termSlug, numericYear)} · Teil ${numericPart} · Aufgabe ${numericNumber}`,
    sortKey: [
      numericYear,
      TERM_ORDER[suite.termSlug] ?? 99,
      numericPart,
      numericNumber,
      topic ?? ''
    ].join(':')
  };
}

function compareQuestions(a, b) {
  if (a.part !== b.part) return a.part - b.part;
  if (a.number !== b.number) return a.number - b.number;
  return (a.topic ?? '').localeCompare(b.topic ?? '');
}

function compareSuites(a, b) {
  if (a.year !== b.year) return b.year - a.year;
  return (TERM_ORDER[b.termSlug] ?? 99) - (TERM_ORDER[a.termSlug] ?? 99);
}

export async function loadCatalog(projectRoot, libraryRoot = path.join(projectRoot, 'library')) {
  const archiveRoot = path.isAbsolute(libraryRoot)
    ? libraryRoot
    : path.resolve(projectRoot, libraryRoot);
  const questionsById = new Map();
  const suitesById = new Map();
  const fileMap = {
    au: new Map(),
    lo: new Map()
  };
  const fileMapAll = {
    au: new Map(),
    lo: new Map()
  };

  const suiteDirs = await safeReadDir(archiveRoot);

  for (const suiteDir of suiteDirs) {
    if (!suiteDir.isDirectory()) continue;
    const suiteInfo = parseSuiteDirectory(suiteDir.name);
    if (!suiteInfo) continue;

    const suitePath = path.join(archiveRoot, suiteDir.name);
    const files = await safeReadDir(suitePath);

      if (suiteInfo.kind === 'au' && !suitesById.has(suiteInfo.id)) {
        suitesById.set(suiteInfo.id, {
          id: suiteInfo.id,
          title: suiteInfo.title,
          year: suiteInfo.year,
          termSlug: suiteInfo.termSlug,
          questionIds: []
        });
      }

      for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith('.pdf')) continue;
        const parsed = parseQuestionFile(file.name, suiteInfo);
        if (!parsed) continue;

        const absolutePath = path.join(suitePath, file.name);
        const allMapForKind = fileMapAll[suiteInfo.kind];
        const existingPaths = allMapForKind.get(parsed.id) ?? [];
        if (!existingPaths.includes(absolutePath)) {
          existingPaths.push(absolutePath);
          allMapForKind.set(parsed.id, existingPaths);
        }
        if (!fileMap[suiteInfo.kind].has(parsed.id)) {
          fileMap[suiteInfo.kind].set(parsed.id, absolutePath);
        }

        if (!questionsById.has(parsed.id)) {
          questionsById.set(parsed.id, {
            ...parsed,
            urls: {
              question: null,
              solution: null
            },
            hasSolution: false
          });
        }

        const question = questionsById.get(parsed.id);
        if (suiteInfo.kind === 'au') {
          question.urls.question = `/api/pdf/au/${encodeURIComponent(parsed.id)}`;
          const suite = suitesById.get(suiteInfo.id);
          if (suite && !suite.questionIds.includes(parsed.id)) {
            suite.questionIds.push(parsed.id);
          }
        }
      }
    }

  const allQuestions = [...questionsById.values()]
    .filter((question) => fileMap.au.has(question.id))
    .map((question) => {
      const hasSolution = fileMap.lo.has(question.id);
      return {
        ...question,
        hasSolution,
        urls: {
          question: `/api/pdf/au/${encodeURIComponent(question.id)}`,
          solution: hasSolution ? `/api/pdf/lo/${encodeURIComponent(question.id)}` : null
        }
      };
    })
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      if (a.termSlug !== b.termSlug) {
        return (TERM_ORDER[b.termSlug] ?? 99) - (TERM_ORDER[a.termSlug] ?? 99);
      }
      return compareQuestions(a, b);
    });

  const allQuestionIds = new Set(allQuestions.map((question) => question.id));
  for (const suite of suitesById.values()) {
    suite.questionIds = suite.questionIds
      .filter((id) => allQuestionIds.has(id))
      .sort((a, b) => compareQuestions(questionsById.get(a), questionsById.get(b)));
    suite.questionCount = suite.questionIds.length;
    suite.t1Count = suite.questionIds.filter((id) => questionsById.get(id)?.part === 1).length;
    suite.t2Count = suite.questionIds.filter((id) => questionsById.get(id)?.part === 2).length;
  }

  const suites = [...suitesById.values()]
    .filter((suite) => suite.questionCount > 0)
    .sort(compareSuites);

  const topics = Object.entries(TOPIC_LABELS).map(([id, label]) => ({ id, label }));
  const years = [...new Set(allQuestions.map((question) => question.year))].sort((a, b) => b - a);

  return {
    questions: allQuestions,
    suites,
    questionsById,
    suitesById,
    fileMap,
    fileMapAll,
    meta: {
      years,
      topics,
      parts: [
        { id: 1, label: 'Teil 1' },
        { id: 2, label: 'Teil 2' }
      ],
      statuses: [
        { id: 'unseen', label: '未做过' },
        { id: 'mastered', label: '完全会' },
        { id: 'meh', label: '有点模糊' },
        { id: 'baffled', label: '不会' },
        { id: 'ignored', label: '排除' }
      ]
    }
  };
}

async function safeReadDir(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
