import fs from 'node:fs/promises';
import path from 'node:path';
import { loadPdfjs } from './pdfjs.js';

const CACHE_VERSION = 1;
const SNIPPET_RADIUS = 60;
const MAX_SNIPPETS_PER_HIT = 2;

export function createSearchIndex({ projectRoot, getCatalog, cacheKey = 'library' }) {
  const safeKey = String(cacheKey || 'library').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'library';
  const cachePath = path.join(projectRoot, 'user', `pdf-search-index-${safeKey}.json`);
  let entries = new Map();
  let ready = false;
  let building = false;
  let progress = { processed: 0, total: 0 };

  async function load() {
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === CACHE_VERSION && Array.isArray(parsed.entries)) {
        entries = new Map(parsed.entries.map((entry) => [entry.id, entry]));
        ready = entries.size > 0;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[search-index] load failed:', error.message);
    }
  }

  async function persist() {
    const payload = {
      version: CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      entries: [...entries.values()]
    };
    const tempPath = `${cachePath}.tmp`;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(payload), 'utf8');
    await fs.rename(tempPath, cachePath);
  }

  async function extractText(pdfPath) {
    const { getDocument } = await loadPdfjs();
    const buffer = await fs.readFile(pdfPath);
    const data = new Uint8Array(buffer);
    const doc = await getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false
    }).promise;
    const pages = [];
    try {
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => (typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        pages.push(text);
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    return pages;
  }

  async function build({ force = false } = {}) {
    if (building) return;
    building = true;
    try {
      const catalog = await getCatalog();
      const fileMap = catalog.fileMap?.au;
      if (!fileMap || fileMap.size === 0) return;

      const targets = [];
      for (const [id, filePath] of fileMap.entries()) {
        try {
          const stat = await fs.stat(filePath);
          const mtime = stat.mtimeMs;
          const existing = entries.get(id);
          if (!force && existing && existing.mtime === mtime && Array.isArray(existing.pages)) continue;
          targets.push({ id, filePath, mtime });
        } catch {
          continue;
        }
      }

      progress = { processed: 0, total: targets.length };
      if (targets.length === 0) {
        ready = true;
        return;
      }

      let dirty = 0;
      for (const target of targets) {
        try {
          const pages = await extractText(target.filePath);
          entries.set(target.id, { id: target.id, mtime: target.mtime, pages });
          dirty += 1;
          progress.processed += 1;
          if (dirty % 20 === 0) {
            await persist().catch(() => {});
          }
        } catch (error) {
          progress.processed += 1;
          console.error(`[search-index] failed ${target.id}:`, error.message);
        }
      }

      const liveIds = new Set(fileMap.keys());
      for (const id of [...entries.keys()]) {
        if (!liveIds.has(id)) entries.delete(id);
      }

      await persist().catch((error) => console.error('[search-index] persist failed:', error.message));
      ready = true;
    } finally {
      building = false;
    }
  }

  function ensureBuilding() {
    if (ready || building) return;
    build().catch((error) => console.error('[search-index] build failed:', error.message));
  }

  function search(rawQuery, { limit = 20 } = {}) {
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (!query) return { ready, results: [], progress };

    const needle = query.toLowerCase();
    const results = [];

    for (const entry of entries.values()) {
      const snippets = [];
      let pageHit = 0;
      let firstHitScore = Infinity;

      for (let pageIndex = 0; pageIndex < entry.pages.length; pageIndex += 1) {
        const page = entry.pages[pageIndex];
        if (!page) continue;
        const lowerPage = page.toLowerCase();
        let searchStart = 0;
        let pageSnippets = 0;
        while (snippets.length < MAX_SNIPPETS_PER_HIT && pageSnippets < MAX_SNIPPETS_PER_HIT) {
          const idx = lowerPage.indexOf(needle, searchStart);
          if (idx === -1) break;
          if (firstHitScore > pageIndex * 10000 + idx) firstHitScore = pageIndex * 10000 + idx;
          const start = Math.max(0, idx - SNIPPET_RADIUS);
          const end = Math.min(page.length, idx + needle.length + SNIPPET_RADIUS);
          const prefix = start > 0 ? '…' : '';
          const suffix = end < page.length ? '…' : '';
          snippets.push({
            page: pageIndex + 1,
            text: `${prefix}${page.slice(start, end)}${suffix}`,
            matchStart: start > 0 ? idx - start + prefix.length : idx,
            matchLength: needle.length
          });
          pageSnippets += 1;
          pageHit += 1;
          searchStart = idx + needle.length;
        }
        if (snippets.length >= MAX_SNIPPETS_PER_HIT) break;
      }

      if (snippets.length > 0) {
        results.push({
          id: entry.id,
          snippets,
          score: firstHitScore - pageHit * 0.1
        });
      }
    }

    results.sort((a, b) => a.score - b.score);
    return {
      ready,
      results: results.slice(0, Math.max(1, limit)),
      progress
    };
  }

  async function init({ background = true, eagerBuild = true } = {}) {
    await load();
    if (!eagerBuild) return;
    if (background) {
      build().catch((error) => console.error('[search-index] build failed:', error.message));
    } else {
      await build();
    }
  }

  return {
    init,
    build,
    ensureBuilding,
    search,
    getStatus: () => ({ ready, building, progress, size: entries.size })
  };
}
