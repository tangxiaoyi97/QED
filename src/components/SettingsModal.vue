<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../services/api.js';
import { useI18n } from '../composables/useI18n.js';

const { t, locale, localeOptions } = useI18n();
const appVersion = __APP_VERSION__;
const NORMAL_INVITE_RE = /^%[A-Za-z0-9]{10}$/;
const SPECIAL_SECRET_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{12,128}$/;

const props = defineProps({
  open: { type: Boolean, default: false },
  currentProfile: { type: String, default: 'guest' },
  isGuest: { type: Boolean, default: true },
  currentLibraryId: { type: String, default: 'library' },
  currentTheme: { type: String, default: 'light' },
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

const emit = defineEmits(['close', 'switch-profile', 'switch-library', 'change-theme', 'save-ai-settings']);

const newProfileInput = ref('');
const profileBusy = ref(false);
const profileError = ref('');
const registrationOpen = ref(false);
const registrationProfileInput = ref('');
const registrationTokenInput = ref('');
const registrationBusy = ref(false);
const registrationError = ref('');
const libraryInput = ref('library');
const aiApiKeyInput = ref('');
const aiModelInput = ref('gpt-5.4-mini');
const aiCustomPromptInput = ref('');
const darkThemeInput = ref(false);
const canEditModel = computed(() => aiApiKeyInput.value.trim().length > 0);
const activeLocaleLabel = computed(
  () => localeOptions.find((item) => item.value === locale.value)?.label ?? locale.value
);

watch(() => props.open, (val) => {
  if (val) {
    newProfileInput.value = '';
    profileBusy.value = false;
    profileError.value = '';
    registrationOpen.value = false;
    registrationProfileInput.value = '';
    registrationTokenInput.value = '';
    registrationBusy.value = false;
    registrationError.value = '';
    libraryInput.value = props.currentLibraryId || props.serverState?.activeLibraryId || props.serverState?.defaultLibraryId || 'library';
    aiApiKeyInput.value = props.aiConfig?.apiKey ?? '';
    aiModelInput.value = props.aiConfig?.model ?? props.aiMeta?.defaultModel ?? 'gpt-5.4-mini';
    aiCustomPromptInput.value = props.aiConfig?.customPrompt ?? '';
    darkThemeInput.value = props.currentTheme === 'dark';
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

  profileBusy.value = true;
  profileError.value = '';
  try {
    const { exists } = await api.checkProfile(p);
    if (!exists) {
      openRegistration(p);
      return;
    }

    emit('switch-profile', p);
    emit('close');
  } catch (error) {
    profileError.value = formatRequestError(error);
  } finally {
    profileBusy.value = false;
  }
}

function openRegistration(profile) {
  registrationProfileInput.value = normalizeId(profile);
  registrationTokenInput.value = '';
  registrationError.value = '';
  registrationOpen.value = true;
}

function closeRegistration() {
  registrationOpen.value = false;
  registrationError.value = '';
  registrationBusy.value = false;
}

async function submitRegistration() {
  if (props.serverState?.showcaseMode) return;
  const profile = normalizeId(registrationProfileInput.value);
  if (!profile) {
    registrationError.value = t('settings.profileNameInvalid');
    return;
  }

  let credential;
  try {
    credential = await buildInviteCredential(registrationTokenInput.value);
  } catch (error) {
    registrationError.value = error?.message || t('settings.profileInviteInvalid');
    return;
  }

  registrationBusy.value = true;
  registrationError.value = '';
  try {
    const { exists } = await api.checkProfile(profile);
    if (!exists) {
      await api.createProfile(profile, credential);
    }
    emit('switch-profile', profile);
    emit('close');
  } catch (error) {
    registrationError.value = formatRequestError(error);
  } finally {
    registrationBusy.value = false;
  }
}

async function buildInviteCredential(raw) {
  const token = String(raw ?? '').trim();
  if (!token) throw new Error(t('settings.profileInviteRequired'));
  if (NORMAL_INVITE_RE.test(token)) {
    return { token };
  }

  const specialSecret = normalizeSpecialSecretInput(token);
  if (!specialSecret) throw new Error(t('settings.profileInviteInvalid'));
  if (!globalThis.crypto?.subtle) throw new Error(t('settings.profileInviteHashUnavailable'));
  return { specialTokenHash: await sha256Hex(specialSecret) };
}

function normalizeSpecialSecretInput(raw) {
  const trimmed = String(raw ?? '').normalize('NFKC').trim();
  const candidate = trimmed.startsWith('$') ? trimmed.slice(1) : trimmed;
  return SPECIAL_SECRET_RE.test(candidate) ? candidate : '';
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function formatRequestError(error) {
  if (error?.payload?.error === 'INVALID_ID') return t('settings.profileNameInvalid');
  if (error?.payload?.error === 'ALREADY_EXISTS') return t('settings.profileAlreadyExists');
  if (error?.payload?.error === 'INVALID_TOKEN') return t('settings.profileInviteInvalid');
  return error?.message || t('errors.requestFailed');
}

function saveAiSettings() {
  if (props.isGuest || props.serverState?.showcaseMode) return;
  emit('save-ai-settings', {
    apiKey: aiApiKeyInput.value.trim(),
    model: canEditModel.value
      ? (aiModelInput.value.trim() || props.aiMeta?.defaultModel || 'gpt-5.4-mini')
      : (props.aiMeta?.defaultModel || 'gpt-5.4-mini'),
    customPrompt: aiCustomPromptInput.value.trim()
  });
}

function switchLibrary() {
  const candidate = normalizeId(libraryInput.value) || props.serverState?.defaultLibraryId || 'library';
  emit('switch-library', candidate);
}

function toggleTheme(event) {
  darkThemeInput.value = Boolean(event?.target?.checked);
  emit('change-theme', darkThemeInput.value ? 'dark' : 'light');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <section v-if="!registrationOpen" class="modal-panel modal--settings" role="dialog" aria-modal="true" :aria-label="t('settings.dialogAria')">
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
                    :disabled="profileBusy"
                    @input="newProfileInput = newProfileInput.replace(/[^a-zA-Z0-9_-]/g, '')"
                    @keyup.enter="handleCreate"
                  />
                  <button
                    class="pill-button pill-button--dark"
                    type="button"
                    :disabled="!newProfileInput.trim() || profileBusy"
                    @click="handleCreate"
                  >{{ profileBusy ? t('settings.profileChecking') : isGuest ? t('settings.loginOrCreate') : t('settings.switchUser') }}</button>
                </div>
                <p class="input-hint">{{ t('settings.inputHint') }}</p>
                <p v-if="profileError" class="input-error" role="alert">{{ profileError }}</p>
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

            <label v-if="!serverState.showcaseMode" class="switch-row settings-switch">
              <input type="checkbox" :checked="darkThemeInput" @change="toggleTheme" />
              <span>{{ t('settings.darkTheme') }}</span>
            </label>

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

            <div class="settings-item settings-item--ai">
              <label class="settings-label">{{ t('settings.aiCustomPrompt') }}</label>
              <textarea
                v-model="aiCustomPromptInput"
                class="settings-textarea settings-input--mono"
                rows="8"
                :maxlength="12000"
                :placeholder="t('settings.aiCustomPromptPlaceholder')"
              />
              <p class="input-hint">{{ t('settings.aiCustomPromptHint') }}</p>
            </div>

            <div class="modal-actions">
              <button class="pill-button pill-button--dark" type="button" @click="saveAiSettings">
                {{ t('settings.aiSave') }}
              </button>
            </div>
          </section>
        </div>
      </section>

      <section v-else class="modal-panel modal--register" role="dialog" aria-modal="true" :aria-label="t('settings.registrationTitle')">
        <header class="modal-header">
          <div>
            <span class="eyebrow">{{ t('settings.userProfiles') }}</span>
            <h2 class="modal-title">{{ t('settings.registrationTitle') }}</h2>
          </div>
          <button class="icon-button" type="button" @click="$emit('close')">✕</button>
        </header>

        <form class="modal-body registration-form" @submit.prevent="submitRegistration">
          <div class="settings-item">
            <label class="settings-label" for="register-profile">{{ t('settings.registrationUsername') }}</label>
            <input
              id="register-profile"
              v-model="registrationProfileInput"
              class="settings-input settings-input--mono"
              type="text"
              autocomplete="username"
              :disabled="registrationBusy"
              @input="registrationProfileInput = registrationProfileInput.replace(/[^a-zA-Z0-9_-]/g, '')"
            />
            <p class="input-hint">{{ t('settings.inputHint') }}</p>
          </div>

          <div class="settings-item">
            <label class="settings-label" for="register-token">{{ t('settings.registrationInvite') }}</label>
            <input
              id="register-token"
              v-model="registrationTokenInput"
              class="settings-input settings-input--mono"
              type="password"
              autocomplete="off"
              :disabled="registrationBusy"
            />
          </div>

          <p v-if="registrationError" class="input-error" role="alert">{{ registrationError }}</p>

          <div class="modal-actions modal-actions--split">
            <button class="pill-button" type="button" :disabled="registrationBusy" @click="closeRegistration">
              {{ t('common.cancel') }}
            </button>
            <button
              class="pill-button pill-button--dark"
              type="submit"
              :disabled="registrationBusy || !registrationProfileInput.trim() || !registrationTokenInput.trim()"
            >
              {{ registrationBusy ? t('settings.registrationCreating') : t('settings.registrationSubmit') }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.modal--settings {
  max-width: 520px;
}

.modal--register {
  max-width: 420px;
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 8px;
}

.registration-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
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
  background: var(--surface);
  color: var(--text);
  padding: 0 14px;
  font-size: 14px;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.settings-textarea {
  width: 100%;
  min-height: 160px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.5;
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

.settings-input:focus,
.settings-textarea:focus {
  outline: none;
  border-color: #000;
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.05);
}

.input-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}

.input-error {
  font-size: 12px;
  line-height: 1.45;
  color: #9f1239;
  margin: 0;
}

.modal-actions--split {
  justify-content: space-between;
  gap: 12px;
}

.pill-button:disabled,
.settings-input:disabled {
  opacity: 0.6;
}

.property-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}

.settings-switch {
  margin-top: 16px;
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

:global(:root[data-theme='dark']) .settings-card,
:global(:root[data-theme='dark']) .settings-card--guest {
  background: var(--surface-muted);
  border-color: var(--border-subtle);
}

:global(:root[data-theme='dark']) .guest-cta__text strong,
:global(:root[data-theme='dark']) .settings-label,
:global(:root[data-theme='dark']) .property-label,
:global(:root[data-theme='dark']) .property-code {
  color: var(--text);
}

:global(:root[data-theme='dark']) .guest-cta__text p,
:global(:root[data-theme='dark']) .input-hint {
  color: var(--text-muted);
}

:global(:root[data-theme='dark']) .settings-input,
:global(:root[data-theme='dark']) .settings-textarea {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}

:global(:root[data-theme='dark']) .settings-input:disabled {
  background: #242424;
  color: var(--text-muted);
}

:global(:root[data-theme='dark']) .settings-input:focus,
:global(:root[data-theme='dark']) .settings-textarea:focus {
  border-color: #f4f4f4;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.08);
}

:global(:root[data-theme='dark']) .profile-tag {
  background: #f4f4f4;
  color: #111111;
}

:global(:root[data-theme='dark']) .property-code {
  background: #2a2a2a;
}
</style>
