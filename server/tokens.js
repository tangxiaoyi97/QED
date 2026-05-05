import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const NORMAL_TOKEN_RE = /^%[A-Za-z0-9]{10}$/;
const SPECIAL_SECRET_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{12,128}$/;
const SPECIAL_CLIENT_HASH_RE = /^[a-f0-9]{64}$/;
const SPECIAL_PARTITION_KEY = '$';
const SPECIAL_HASH_ALGORITHM = 'pbkdf2-sha256';
const SPECIAL_HASH_ITERATIONS = 310000;
const SPECIAL_HASH_BYTES = 32;

export async function readTokens(appRoot) {
  const store = await readTokenStore(appRoot);
  return store.tokens;
}

export async function writeTokens(appRoot, tokens) {
  const store = await readTokenStore(appRoot);
  store.tokens = normalizeNormalTokens(tokens);
  await writeTokenStore(appRoot, store);
}

/**
 * Re-add a previously consumed normal token. Used to roll back a token
 * consumption if the subsequent profile-creation step failed.
 * Returns true if the token was added (or already present), false if invalid.
 */
export async function restoreToken(appRoot, token) {
  const safeToken = typeof token === 'string' ? token.trim() : '';
  if (!NORMAL_TOKEN_RE.test(safeToken)) return false;
  const filePath = path.join(appRoot, 'tokens.json');
  return withTokenLock(filePath, async () => {
    const store = await readTokenStore(appRoot);
    if (!store.tokens.includes(safeToken)) {
      store.tokens.push(safeToken);
      await writeTokenStore(appRoot, store);
    }
    return true;
  });
}

export function generateToken() {
  const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '%';
  for (let i = 0; i < 10; i++) {
    result += charSet.charAt(Math.floor(Math.random() * charSet.length));
  }
  return result;
}

export function generateSpecialToken(length = 24) {
  const safeLength = Math.min(128, Math.max(12, Number.isInteger(length) ? length : 24));
  const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let result = '';
    for (let i = 0; i < safeLength; i += 1) {
      result += charSet.charAt(randomBytes(1)[0] % charSet.length);
    }
    if (SPECIAL_SECRET_RE.test(result)) return result;
  }
  return `QED${randomBytes(Math.ceil((safeLength - 3) / 2)).toString('hex').slice(0, safeLength - 4)}7`.slice(0, safeLength);
}

export async function setSpecialToken(appRoot, secret) {
  const normalized = normalizeSpecialSecret(secret);
  if (!normalized) {
    throw new Error('Special token must be 12-128 alphanumeric characters with at least one letter and one number.');
  }

  const store = await readTokenStore(appRoot);
  const salt = randomBytes(16).toString('base64url');
  const clientHash = hashSpecialSecretForClient(normalized);
  store[SPECIAL_PARTITION_KEY] = {
    algorithm: SPECIAL_HASH_ALGORITHM,
    input: 'sha256-hex',
    iterations: SPECIAL_HASH_ITERATIONS,
    salt,
    hash: deriveSpecialHash(clientHash, salt, SPECIAL_HASH_ITERATIONS).toString('base64url'),
    updatedAt: new Date().toISOString()
  };
  await writeTokenStore(appRoot, store);
  return normalized;
}

export async function clearSpecialToken(appRoot) {
  const store = await readTokenStore(appRoot);
  delete store[SPECIAL_PARTITION_KEY];
  await writeTokenStore(appRoot, store);
}

export async function validateToken(appRoot, credential) {
  const normalToken = typeof credential === 'string' ? credential : credential?.token;
  const specialTokenHash = typeof credential === 'object' && credential ? credential.specialTokenHash : '';
  const hasNormalToken = typeof normalToken === 'string' && normalToken.trim().length > 0;
  const hasSpecialTokenHash = typeof specialTokenHash === 'string' && specialTokenHash.trim().length > 0;
  if (hasNormalToken === hasSpecialTokenHash) return false;

  if (hasNormalToken) {
    const safeToken = normalToken.trim();
    if (!NORMAL_TOKEN_RE.test(safeToken)) return false;
    return consumeToken(appRoot, safeToken);
  }

  return validateSpecialTokenHash(appRoot, specialTokenHash.trim().toLowerCase());
}

const tokenLocks = new Map();

function withTokenLock(filePath, operation) {
  const pending = tokenLocks.get(filePath) ?? Promise.resolve();
  const next = pending.then(operation, operation);
  tokenLocks.set(filePath, next.finally(() => {
    if (tokenLocks.get(filePath) === next) {
      tokenLocks.delete(filePath);
    }
  }));
  return next;
}

async function consumeToken(appRoot, token) {
  const filePath = path.join(appRoot, 'tokens.json');
  return withTokenLock(filePath, async () => {
    const store = await readTokenStore(appRoot);
    const index = store.tokens.indexOf(token);
    if (index === -1) return false;
    store.tokens.splice(index, 1);
    await writeTokenStore(appRoot, store);
    return true;
  });
}

async function validateSpecialTokenHash(appRoot, clientHash) {
  if (!SPECIAL_CLIENT_HASH_RE.test(clientHash)) return false;
  const store = await readTokenStore(appRoot);
  const record = normalizeSpecialRecord(store[SPECIAL_PARTITION_KEY]);
  if (!record) return false;

  try {
    const expected = Buffer.from(record.hash, 'base64url');
    const actual = deriveSpecialHash(clientHash, record.salt, record.iterations);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

async function readTokenStore(appRoot) {
  const filePath = path.join(appRoot, 'tokens.json');
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return normalizeTokenStore(JSON.parse(data));
  } catch {
    return normalizeTokenStore({});
  }
}

async function writeTokenStore(appRoot, store) {
  const filePath = path.join(appRoot, 'tokens.json');
  await fs.writeFile(filePath, `${JSON.stringify(normalizeTokenStore(store), null, 2)}\n`, 'utf8');
}

function normalizeTokenStore(value) {
  if (Array.isArray(value)) {
    return {
      version: 2,
      tokens: normalizeNormalTokens(value)
    };
  }

  const source = value && typeof value === 'object' ? value : {};
  const output = {
    version: 2,
    tokens: normalizeNormalTokens(source.tokens ?? source.inviteTokens ?? [])
  };
  const specialRecord = normalizeSpecialRecord(source[SPECIAL_PARTITION_KEY] ?? source.special);
  if (specialRecord) output[SPECIAL_PARTITION_KEY] = specialRecord;
  return output;
}

function normalizeNormalTokens(tokens) {
  if (!Array.isArray(tokens)) return [];
  return [...new Set(tokens.map((token) => String(token ?? '').trim()).filter((token) => NORMAL_TOKEN_RE.test(token)))];
}

function normalizeSpecialRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const iterations = Number(record.iterations);
  if (record.algorithm !== SPECIAL_HASH_ALGORITHM) return null;
  if (record.input !== 'sha256-hex') return null;
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return null;
  if (typeof record.salt !== 'string' || record.salt.length < 16) return null;
  if (typeof record.hash !== 'string' || record.hash.length < 32) return null;
  return {
    algorithm: SPECIAL_HASH_ALGORITHM,
    input: 'sha256-hex',
    iterations,
    salt: record.salt,
    hash: record.hash,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : ''
  };
}

function normalizeSpecialSecret(value) {
  const normalized = String(value ?? '').normalize('NFKC').trim();
  return SPECIAL_SECRET_RE.test(normalized) ? normalized : '';
}

function hashSpecialSecretForClient(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function deriveSpecialHash(clientHash, salt, iterations) {
  return pbkdf2Sync(clientHash, salt, iterations, SPECIAL_HASH_BYTES, 'sha256');
}
