<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from '../composables/useI18n.js';

let pdfRuntimePromise = null;

async function getPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.mjs?url')
    ]).then(([pdfModule, workerModule]) => {
      const runtime = pdfModule.default ?? pdfModule;
      runtime.GlobalWorkerOptions.workerSrc = workerModule.default;
      return runtime;
    });
  }
  return pdfRuntimePromise;
}

/* ── PDF document LRU cache ────────────────────────────────────────────── */
const PDF_CACHE_MAX = 8;
const pdfDocCache = new Map(); // url → { doc, ts }

function getCachedDoc(url) {
  const entry = pdfDocCache.get(url);
  if (entry) {
    entry.ts = Date.now();
    return entry.doc;
  }
  return null;
}

function setCachedDoc(url, doc) {
  pdfDocCache.set(url, { doc, ts: Date.now() });
  // Evict the least-recently-used entry when over capacity.
  if (pdfDocCache.size > PDF_CACHE_MAX) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, value] of pdfDocCache) {
      if (value.ts < oldestTs) {
        oldestTs = value.ts;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const evicted = pdfDocCache.get(oldestKey);
      pdfDocCache.delete(oldestKey);
      evicted?.doc?.destroy?.();
    }
  }
}

const props = defineProps({
  url: {
    type: String,
    default: null
  },
  blurred: {
    type: Boolean,
    default: false
  },
  label: {
    type: String,
    default: 'PDF'
  },
  fitPage: {
    type: Boolean,
    default: true
  },
  zoomable: {
    type: Boolean,
    default: true
  },
  initialPage: {
    type: Number,
    default: 1
  },
  highResolution: {
    type: Boolean,
    default: false
  },
  maxCssScale: {
    type: Number,
    default: 1.65
  }
});

const emit = defineEmits(['zoom']);
const viewport = ref(null);
const canvasHost = ref(null);
const loading = ref(false);
const errorMessage = ref('');
const pageCount = ref(0);
const currentPage = ref(1);
const pageLabel = computed(() => `${currentPage.value}/${Math.max(pageCount.value, 1)}`);
const { t, locale } = useI18n();
const loadingText = computed(() => {
  const currentLocale = locale.value;
  return t('pdf.loading', { label: props.label, locale: currentLocale });
});
const paginationAria = computed(() => {
  const currentLocale = locale.value;
  return t('pdf.paginationAria', { locale: currentLocale });
});

let pdfDocument = null;
let renderToken = 0;
let resizeTimer = null;
let resizeObserver = null;
let activeRenderTask = null;
let lastRenderBox = { width: 0, height: 0 };

watch(
  () => props.url,
  () => loadDocument(),
  { immediate: true }
);

watch(
  () => props.initialPage,
  () => {
    if (!pdfDocument || pageCount.value <= 1) return;
    const nextPage = normalizePage(props.initialPage);
    if (nextPage === currentPage.value) return;
    currentPage.value = nextPage;
    renderToken += 1;
    renderPage(renderToken);
  }
);

onMounted(() => {
  if (!viewport.value || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    const height = Math.round(entry.contentRect.height);
    if (Math.abs(width - lastRenderBox.width) < 2 && Math.abs(height - lastRenderBox.height) < 2) return;
    lastRenderBox = { width, height };
    scheduleRender();
  });
  resizeObserver.observe(viewport.value);
});

onBeforeUnmount(() => {
  renderToken += 1;
  resizeObserver?.disconnect();
  // Fire-and-forget cancellation here is fine: the component is going away,
  // so we don't need to await the prior render's promise to settle.
  if (activeRenderTask) {
    try { activeRenderTask.cancel(); } catch { /* ignore */ }
    activeRenderTask = null;
  }
  if (resizeTimer) window.clearTimeout(resizeTimer);
  // Don't destroy pdfDocument here — the module-level LRU cache
  // manages document lifecycle.  Destroying it would invalidate
  // the cache entry for other component instances.
  pdfDocument = null;
});

function scheduleRender() {
  if (!pdfDocument) return;
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    renderToken += 1;
    renderPage(renderToken);
  }, 120);
}

async function loadDocument() {
  renderToken += 1;
  const token = renderToken;
  await nextTick();
  clearCanvas();
  errorMessage.value = '';
  pageCount.value = 0;

  if (!props.url) {
    errorMessage.value = t('pdf.noPdf');
    return;
  }

  loading.value = true;
  try {
    // Try the module-level LRU cache first.
    const cached = getCachedDoc(props.url);
    if (cached) {
      pdfDocument = cached;
    } else {
      const pdfjsLib = await getPdfRuntime();
      const newDoc = await pdfjsLib.getDocument(props.url).promise;
      if (token !== renderToken) return;
      setCachedDoc(props.url, newDoc);
      pdfDocument = newDoc;
    }
    if (token !== renderToken) return;
    pageCount.value = pdfDocument.numPages;
    currentPage.value = normalizePage(props.initialPage);
    await renderPage(token);
  } catch (error) {
    if (token === renderToken) {
      errorMessage.value = error.message || t('pdf.renderFailed');
    }
  } finally {
    if (token === renderToken) loading.value = false;
  }
}

async function cancelActiveRender() {
  // PDF.js's renderTask.cancel() is asynchronous: it schedules cancellation
  // but already-queued canvas commands can keep running until the task's
  // promise rejects with RenderingCancelledException. WebKit (Safari on Mac
  // and iPad) is strict about this — if we detach the canvas while a stale
  // render is still flushing, the next render can present mixed output and
  // the user sees the wrong PDF when toggling between question and answer.
  // Awaiting the rejection here makes the canvas swap deterministic across
  // Chromium, Firefox and WebKit.
  if (!activeRenderTask) return;
  const task = activeRenderTask;
  activeRenderTask = null;
  try {
    task.cancel();
    await task.promise;
  } catch {
    // RenderingCancelledException (or any failure of the prior render) is
    // expected here — we're tearing it down.
  }
}

async function renderPage(existingToken = renderToken) {
  const token = existingToken;
  await nextTick();
  if (!pdfDocument || !viewport.value || !canvasHost.value) return;
  if (token !== renderToken) return;

  await cancelActiveRender();
  if (token !== renderToken) return;

  clearCanvas();
  loading.value = true;
  try {
    const page = await pdfDocument.getPage(currentPage.value);
    if (token !== renderToken) {
      page.cleanup?.();
      return;
    }

    const baseViewport = page.getViewport({ scale: 1 });
    const box = viewport.value.getBoundingClientRect();
    const availableWidth = Math.max(280, box.width);
    const availableHeight = Math.max(320, box.height - (pageCount.value > 1 ? 42 : 0));
    const widthScale = availableWidth / baseViewport.width;
    const heightScale = availableHeight / baseViewport.height;
    const maxScale = Math.max(1, props.maxCssScale);
    const cssScale = props.fitPage ? Math.min(widthScale, heightScale, maxScale) : Math.min(widthScale, maxScale);
    const deviceRatio = window.devicePixelRatio || 1;
    const pixelRatio = props.highResolution
      ? Math.min(deviceRatio * 1.5, 3)
      : Math.min(deviceRatio, 2);
    const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    canvas.style.width = `${Math.floor(baseViewport.width * cssScale)}px`;
    canvas.style.height = 'auto';
    canvas.style.maxWidth = '100%';
    canvas.setAttribute('aria-label', t('pdf.pageAria', { label: props.label, page: currentPage.value }));

    const context = canvas.getContext('2d', { alpha: false });
    if (context && 'imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high';
    canvasHost.value.appendChild(canvas);
    const renderTask = page.render({ canvasContext: context, viewport: renderViewport });
    activeRenderTask = renderTask;
    await renderTask.promise;
    if (activeRenderTask === renderTask) activeRenderTask = null;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException') return;
    if (token === renderToken) errorMessage.value = error.message || t('pdf.renderFailed');
  } finally {
    if (token === renderToken) loading.value = false;
  }
}

function clearCanvas() {
  if (canvasHost.value) canvasHost.value.replaceChildren();
}

function normalizePage(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return 1;
  return Math.min(Math.max(1, Math.round(requested)), Math.max(pageCount.value, 1));
}

function goPage(direction) {
  const nextPage = Math.min(Math.max(1, currentPage.value + direction), pageCount.value);
  if (nextPage === currentPage.value) return;
  currentPage.value = nextPage;
  renderToken += 1;
  renderPage(renderToken);
}

function openZoom() {
  if (!props.zoomable || !props.url) return;
  emit('zoom', {
    url: props.url,
    label: props.label,
    page: currentPage.value
  });
}
</script>

<template>
  <div ref="viewport" class="pdf-shell" :class="{ 'pdf-shell--blurred': blurred }">
    <div v-if="loading" class="pdf-state">{{ loadingText }}</div>
    <div v-if="errorMessage" class="pdf-state pdf-state--error">{{ errorMessage }}</div>
    <button ref="canvasHost" class="pdf-pages pdf-pages--button" type="button" :disabled="!zoomable" @click="openZoom" />

    <div v-if="pageCount > 1" class="page-control" :aria-label="paginationAria">
      <button class="page-control__button" type="button" :disabled="currentPage === 1" @click="goPage(-1)">↑</button>
      <span>{{ pageLabel }}</span>
      <button class="page-control__button" type="button" :disabled="currentPage === pageCount" @click="goPage(1)">↓</button>
    </div>
  </div>
</template>
