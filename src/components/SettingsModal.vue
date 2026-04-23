<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../services/api.js';
import { useI18n } from '../composables/useI18n.js';

const { t, locale, localeOptions } = useI18n();
const appVersion = __APP_VERSION__;

const props = defineProps({
  open: { type: Boolean, default: false },
  currentProfile: { type: String, default: 'guest' },
  isGuest: { type: Boolean, default: true },
  currentLibraryId: { type: String, default: 'library' },
  serverState: {
    type: Object,
    default: () => ({
      showcaseMode: false,
      allowLibrarySwitch: false,
      activeLibraryId: 'library',
      activeLibraryPathName: 'library',
      defaultLibraryId: 'library',
      libraries: [{ id: 'library', label: 'library', pathName: 'library' }]
    })
  },
  aiConfig: {
    type: Object,
    default: () => ({ apiKey: '', model: 'gpt-5.4-mini' })
  },
  aiMeta: {
    type: Object,
    default: () => ({
      hasServerApiKey: false,
      hasUserApiKey: false,
      canUseAi: false,
      canUseCustomModel: false,
      defaultModel: 'gpt-5.4-mini'
    })
  }
});

const emit = defineEmits(['close', 'switch-profile', 'switch-library', 'save-ai-settings']);

const newProfileInput = ref('');
const libraryInput = ref('library');
const aiApiKeyInput = ref('');
const aiModelInput = ref('gpt-5.4-mini');
const canEditModel = computed(() => aiApiKeyInput.value.trim().length > 0);
const activeLocaleLabel = computed(
  () => localeOptions.find((item) => item.value === locale.value)?.label ?? locale.value
);

watch(() => props.open, (val) => {
  if (val) {
    newProfileInput.value = '';
    libraryInput.value = props.currentLibraryId || props.serverState?.activeLibraryId || props.serverState?.defaultLibraryId || 'library';
    aiApiKeyInput.value = props.aiConfig?.apiKey ?? '';
    aiModelInput.value = props.aiConfig?.model ?? props.aiMeta?.defaultModel ?? 'gpt-5.4-mini';
  }
});

function normalizeId(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

async function handleCreate() {
  if (props.serverState?.showcaseMode) return;
  const p = normalizeId(newProfileInput.value);
  if (!p) return;

  try {
    const { exists } = await api.checkProfile(p);
    if (!exists) {
      const confirmCreate = window.confirm(t('settings.profileMissingConfirm', { profile: p }));
      if (!confirmCreate) return;

      const token = window.prompt(t('settings.profileInvitePrompt', { profile: p }));
      if (!token) return;

      if (!token.startsWith('%') || token.length !== 11) {
        window.alert(t('settings.profileInviteInvalid'));
        return;
      }

      await api.createProfile(p, token);
      window.alert(t('settings.profileCreateSuccess', { profile: p }));
    }

    emit('switch-profile', p);
    emit('close');
  } catch (error) {
    window.alert(t('settings.profileActionFailed', { message: error?.message || t('errors.requestFailed') }));
  }
}

function saveAiSettings() {
  if (props.isGuest || props.serverState?.showcaseMode) return;
  emit('save-ai-settings', {
    apiKey: aiApiKeyInput.value.trim(),
    model: canEditModel.value
      ? (aiModelInput.value.trim() || props.aiMeta?.defaultModel || 'gpt-5.4-mini')
      : (props.aiMeta?.defaultModel || 'gpt-5.4-mini')
  });
}

function switchLibrary() {
  const candidate = normalizeId(libraryInput.value) || props.serverState?.defaultLibraryId || 'library';
  emit('switch-library', candidate);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <section class="modal-panel modal--settings" role="dialog" aria-modal="true" :aria-label="t('settings.dialogAria')">
        <header class="modal-header">
          <div>
            <span class="eyebrow">{{ t('topNav.brandTitle') }} v{{ appVersion }}</span>
            <h2 class="modal-title">{{ t('settings.title') }}</h2>
          </div>
          <button class="icon-button" type="button" @click="$emit('close')">✕</button>
        </header>

        <div class="modal-body settings-body">
          <section v-if="serverState.showcaseMode" class="settings-card settings-card--guest">
            <div class="guest-cta">
              <div class="guest-cta__icon">ℹ️</div>
              <div class="guest-cta__text">
                <strong>{{ t('settings.showcaseTitle') }}</strong>
                <p>{{ t('settings.showcaseDesc') }}</p>
              </div>
            </div>
          </section>

          <!-- Guest mode prominent CTA -->
          <section v-if="isGuest && !serverState.showcaseMode" class="settings-card settings-card--guest">
            <div class="guest-cta">
              <div class="guest-cta__icon">👤</div>
              <div class="guest-cta__text">
                <strong>{{ t('guest.settingsTitle') }}</strong>
                <p>{{ t('guest.settingsDesc') }}</p>
              </div>
            </div>
          </section>

          <section class="settings-card">
            <span class="eyebrow">{{ t('settings.userProfiles') }}</span>
            <p class="muted-copy">
              {{ t('settings.profileDesc') }}
            </p>

            <div class="profile-grid">
              <div v-if="!isGuest" class="settings-item">
                <label class="settings-label">{{ t('settings.currentActive') }}</label>
                <div class="current-profile-display">
                  <span class="profile-tag">@{{ currentProfile }}</span>
                </div>
              </div>

              <div v-if="!serverState.showcaseMode" class="settings-item">
                <label class="settings-label">
                  {{ isGuest ? t('settings.switchToLogin') : t('settings.switchUser') }}
                </label>
                <div class="input-group">
                  <input
                    type="text"
                    v-model="newProfileInput"
                    class="settings-input"
                    :placeholder="t('settings.exampleProfile')"
                    @input="newProfileInput = newProfileInput.replace(/[^a-zA-Z0-9_-]/g, '')"
                    @keyup.enter="handleCreate"
                  />
                  <button
                    class="pill-button pill-button--dark"
                    type="button"
                    :disabled="!newProfileInput.trim()"
                    @click="handleCreate"
                  >{{ isGuest ? t('settings.loginOrCreate') : t('settings.switchUser') }}</button>
                </div>
                <p class="input-hint">{{ t('settings.inputHint') }}</p>
              </div>
            </div>
          </section>

          <section class="settings-card">
            <span class="eyebrow">{{ t('settings.systemConfig') }}</span>
            <div class="property-list">
              <div class="property-row">
                <span class="property-label">{{ t('settings.catalogPath') }}</span>
                <code class="property-code">{{ serverState.activeLibraryPathName || serverState.activeLibraryId || currentLibraryId || 'library' }}</code>
              </div>
              <div class="property-row">
                <span class="property-label">{{ t('settings.storagePath') }}</span>
                <code class="property-code">
                  {{ isGuest ? '—' : `profile/${currentProfile}/` }}
                </code>
              </div>
            </div>

            <div v-if="serverState.allowLibrarySwitch" class="settings-item settings-item--inline">
              <label class="settings-label">{{ t('settings.librarySwitch') }}</label>
              <div class="input-group">
                <input
                  v-model="libraryInput"
                  class="settings-input"
                  type="text"
                  list="qed-library-ids"
                  :placeholder="serverState.defaultLibraryId || 'library'"
                  @input="libraryInput = normalizeId(libraryInput)"
                  @keyup.enter="switchLibrary"
                />
                <button class="pill-button pill-button--dark" type="button" @click="switchLibrary">
                  {{ t('settings.libraryApply') }}
                </button>
              </div>
              <p class="input-hint">{{ t('settings.libraryHint') }}</p>
              <datalist id="qed-library-ids">
                <template v-for="library in serverState.libraries || []" :key="library.id">
                  <option :value="library.id">{{ library.label || library.id }}</option>
                  <option v-if="library.pathName && library.pathName !== library.id" :value="library.pathName">
                    {{ `${library.label || library.id} (${library.pathName})` }}
                  </option>
                </template>
              </datalist>
            </div>
          </section>

          <section v-if="!isGuest && !serverState.showcaseMode" class="settings-card">
            <span class="eyebrow">{{ t('settings.aiTitle') }}</span>
            <p class="muted-copy">{{ t('settings.aiDesc') }}</p>
            <p class="input-hint">{{ t('settings.aiPromptLocaleHint', { language: activeLocaleLabel }) }}</p>

            <div class="settings-item settings-item--ai">
              <label class="settings-label">{{ t('settings.aiApiKey') }}</label>
              <input
                v-model="aiApiKeyInput"
                class="settings-input settings-input--mono"
                type="password"
                autocomplete="off"
                :placeholder="t('settings.aiApiKeyPlaceholder')"
              />
              <p class="input-hint">
                <template v-if="aiMeta.hasServerApiKey">
                  {{ t('settings.aiServerFallback') }}
                </template>
                <template v-else>
                  {{ t('settings.aiNeedKey') }}
                </template>
              </p>
            </div>

            <div class="settings-item settings-item--ai">
              <label class="settings-label">{{ t('settings.aiModel') }}</label>
              <input
                v-model="aiModelInput"
                class="settings-input settings-input--mono"
                type="text"
                :disabled="!canEditModel"
                :placeholder="aiMeta.defaultModel || 'gpt-5.4-mini'"
              />
              <p class="input-hint">{{ t('settings.aiModelHint') }}</p>
            </div>

            <div class="modal-actions">
              <button class="pill-button pill-button--dark" type="button" @click="saveAiSettings">
                {{ t('settings.aiSave') }}
              </button>
            </div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.modal--settings {
  max-width: 520px;
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 8px;
}

.settings-card {
  padding: 20px;
  background: var(--surface-muted);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
}

.settings-card--guest {
  background: #fffbf0;
  border-color: #f0d080;
}

.guest-cta {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.guest-cta__icon {
  font-size: 28px;
  line-height: 1;
  flex-shrink: 0;
}

.guest-cta__text strong {
  display: block;
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 6px;
  color: var(--text);
}

.guest-cta__text p {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-soft);
  margin: 0;
}

.settings-card .eyebrow {
  margin-bottom: 4px;
}

.settings-card .muted-copy {
  margin-bottom: 20px;
  line-height: 1.5;
}

.profile-grid {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-item--ai {
  gap: 10px;
}

.settings-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-soft);
}

.current-profile-display {
  display: flex;
}

.profile-tag {
  display: inline-block;
  background: #000;
  color: #fff;
  padding: 6px 14px;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.input-group {
  display: flex;
  gap: 8px;
}

.settings-input {
  flex: 1;
  min-height: 42px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: #fff;
  padding: 0 14px;
  font-size: 14px;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.settings-input:disabled {
  background: #f4f4f5;
  color: var(--text-muted);
  cursor: not-allowed;
}

.settings-input--mono {
  font-family: var(--font-mono);
}

.settings-input:focus {
  outline: none;
  border-color: #000;
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.05);
}

.input-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}

.property-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}

.property-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.property-label {
  color: var(--text-soft);
  font-weight: 500;
}

.property-code {
  font-family: var(--font-mono);
  background: rgba(0, 0, 0, 0.04);
  padding: 4px 10px;
  border-radius: 6px;
  color: #000;
  font-size: 12px;
}
</style>
