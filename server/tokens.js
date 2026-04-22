import fs from 'node:fs/promises';
import path from 'node:path';

export async function readTokens(appRoot) {
  const filePath = path.join(appRoot, 'tokens.json');
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

export async function writeTokens(appRoot, tokens) {
  const filePath = path.join(appRoot, 'tokens.json');
  await fs.writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
}

export function generateToken() {
  const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '%';
  for (let i = 0; i < 10; i++) {
    result += charSet.charAt(Math.floor(Math.random() * charSet.length));
  }
  return result;
}

export async function validateToken(appRoot, token) {
  if (!token || !token.startsWith('%')) return false;
  return consumeToken(appRoot, token);
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
    const tokens = await readTokens(appRoot);
    const index = tokens.indexOf(token);
    if (index === -1) return false;
    tokens.splice(index, 1);
    await writeTokens(appRoot, tokens);
    return true;
  });
}
