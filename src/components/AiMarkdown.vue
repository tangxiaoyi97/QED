<script setup>
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

const props = defineProps({
  content: {
    type: String,
    default: ''
  }
});

const renderer = new marked.Renderer();

renderer.code = ({ text, lang }) => {
  const safe = escapeHtml(text ?? '');
  const encoded = encodeForCopy(text ?? '');
  const language = typeof lang === 'string' ? lang.trim() : '';
  const langLabel = language ? `<span class="ai-code-lang">${escapeHtml(language)}</span>` : '';
  return `
    <div class="ai-code-wrap">
      <div class="ai-code-head">
        ${langLabel}
        <button type="button" class="ai-copy-chip" data-copy="${encoded}">Copy</button>
      </div>
      <pre class="ai-code-block"><code>${safe}</code></pre>
    </div>
  `;
};

renderer.link = ({ href, title, text }) => {
  const safeHref = escapeHtml(typeof href === 'string' ? href : '#');
  const safeText = escapeHtml(typeof text === 'string' ? text : safeHref);
  const safeTitle = typeof title === 'string' ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${safeHref}"${safeTitle} target="_blank" rel="noopener noreferrer">${safeText}</a>`;
};

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer
});

const renderedHtml = computed(() => renderMarkdown(props.content));

// Use Private Use Area sentinels so marked/GFM never treats the placeholder as
// markdown syntax. `__QED_MATH_0__` would otherwise be interpreted as bold and
// the inner underscores stripped, which is why raw `QED_MATH_N` tokens leaked
// into rendered output.
const MATH_OPEN = '\uE000';
const MATH_CLOSE = '\uE001';
const MATH_PLACEHOLDER_RE = new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, 'g');

function renderMarkdown(raw) {
  const source = typeof raw === 'string' ? raw : '';
  const tokenStore = [];
  let next = source;

  const addToken = (latex, block) => {
    const id = tokenStore.length;
    tokenStore.push({ latex: latex.trim(), block });
    return `${MATH_OPEN}${id}${MATH_CLOSE}`;
  };

  next = next.replace(/```math\s*([\s\S]*?)```/gi, (_, latex) => addToken(latex, true));
  next = next.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => addToken(latex, true));
  next = next.replace(/\\\[([\s\S]*?)\\\]/g, (_, latex) => addToken(latex, true));
  next = next.replace(/\\\((.+?)\\\)/g, (_, latex) => addToken(latex, false));
  next = next.replace(/(^|[^$])\$([^$\n]+?)\$/g, (_, prefix, latex) => `${prefix}${addToken(latex, false)}`);

  let html = marked.parse(next);
  html = html.replace(MATH_PLACEHOLDER_RE, (_, indexText) => {
    const token = tokenStore[Number(indexText)];
    if (!token || !token.latex) return '';
    return renderMath(token.latex, token.block);
  });
  return DOMPurify.sanitize(html);
}

function renderMath(latex, displayMode) {
  const safeLatex = String(latex ?? '').trim();
  if (!safeLatex) return '';
  const rendered = katex.renderToString(safeLatex, {
    throwOnError: false,
    displayMode,
    strict: 'ignore'
  });
  const encoded = encodeForCopy(safeLatex);
  if (displayMode) {
    return `
      <div class="ai-math-block ai-copy-target" data-copy="${encoded}" tabindex="0" title="Click to copy formula">
        <div class="ai-math-body">${rendered}</div>
      </div>
    `;
  }
  return `<span class="ai-math-inline ai-copy-target" data-copy="${encoded}" title="Click to copy formula">${rendered}</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function encodeForCopy(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeFromCopy(value) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function handleCopyClick(event) {
  const trigger = event.target?.closest?.('[data-copy]');
  if (!trigger) return;
  const payload = decodeFromCopy(trigger.getAttribute('data-copy') ?? '');
  if (!payload) return;
  event.preventDefault();
  event.stopPropagation();
  navigator.clipboard?.writeText(payload).then(() => {
    trigger.classList.add('ai-copy-target--ok');
    window.setTimeout(() => trigger.classList.remove('ai-copy-target--ok'), 900);
  }).catch(() => {});
}
</script>

<template>
  <div class="ai-markdown" @click="handleCopyClick" v-html="renderedHtml" />
</template>

<style scoped>
.ai-markdown {
  color: var(--text);
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}

.ai-markdown :deep(p) {
  margin: 0 0 10px;
}

.ai-markdown :deep(ul),
.ai-markdown :deep(ol) {
  margin: 0 0 10px 20px;
}

.ai-markdown :deep(li + li) {
  margin-top: 2px;
}

.ai-markdown :deep(.ai-code-wrap) {
  margin: 10px 0;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #fff;
  overflow: hidden;
}

.ai-markdown :deep(.ai-code-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 30px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-muted);
}

.ai-markdown :deep(.ai-code-lang) {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
}

.ai-markdown :deep(.ai-code-block) {
  margin: 0;
  padding: 10px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.55;
}

.ai-markdown :deep(.ai-copy-chip) {
  min-height: 22px;
  border: 0;
  border-radius: 6px;
  padding: 0 8px;
  background: #fff;
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 700;
  box-shadow: var(--shadow-soft);
}

.ai-markdown :deep(.ai-copy-chip--ok) {
  background: #000;
  color: #fff;
}

.ai-markdown :deep(.ai-math-block) {
  position: relative;
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  cursor: copy;
  transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease, background-color 140ms ease;
}

.ai-markdown :deep(.ai-math-body) {
  overflow: auto;
}

.ai-markdown :deep(.ai-math-inline) {
  display: inline-flex;
  align-items: center;
  cursor: copy;
  border-radius: 6px;
  padding: 1px 2px;
  transition: background-color 140ms ease, box-shadow 140ms ease;
}

.ai-markdown :deep(.ai-copy-target:hover),
.ai-markdown :deep(.ai-copy-target:focus-visible) {
  border-color: #93c5fd;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.14);
  background: #f8fbff;
}

.ai-markdown :deep(.ai-math-inline.ai-copy-target:hover),
.ai-markdown :deep(.ai-math-inline.ai-copy-target:focus-visible) {
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.18);
}

.ai-markdown :deep(.ai-copy-target--ok) {
  animation: ai-copy-flash 560ms ease;
}

@keyframes ai-copy-flash {
  0% {
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.42);
    border-color: #22c55e;
  }
  70% {
    box-shadow: 0 0 0 6px rgba(34, 197, 94, 0);
    border-color: #22c55e;
  }
  100% {
    box-shadow: none;
    border-color: var(--border);
  }
}

.ai-markdown :deep(a) {
  color: #1a56db;
}
</style>
