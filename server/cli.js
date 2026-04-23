/* QED Admin CLI v0.2 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearSpecialToken, generateSpecialToken, generateToken, readTokens, setSpecialToken, writeTokens } from './tokens.js';
import { createStorage } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const appRoot = path.resolve(path.dirname(__filename), '..');
const profileRoot = path.join(appRoot, 'profile');

const [,, command, ...args] = process.argv;

async function run() {
  switch (command) {
    case 'list':
      listProfiles();
      break;
    case 'token':
      await createToken();
      break;
    case 'special-token':
      await upsertSpecialToken(args[0]);
      break;
    case 'clear-special-token':
      await clearSpecialTokenCommand();
      break;
    case 'remove':
      await removeProfile(args[0]);
      break;
    case 'rename':
      await renameProfile(args[0], args[1]);
      break;
    case 'reset':
      await resetProfile(args[0]);
      break;
    case 'create':
      await createProfileAdmin(args[0]);
      break;
    case 'clear-tokens':
      await clearTokens();
      break;
    default:
      console.log(`
Usage: node server/cli.js <command> [args]

Commands:
  list                  List all user profiles
  token                 Generate a new 11-char invitation code
  special-token [code]  Generate or overwrite the single hidden special code
  clear-special-token   Remove the hidden special code
  remove <id>           Rename profile directory to <id>_del (back up)
  rename <old> <new>    Rename a profile directory
  reset <id>            Reset profile records (overwrite with defaults)
  create <id>           Create a profile directory (bypass tokens)
  clear-tokens          Delete all pending invitation codes
      `);
  }
}

function listProfiles() {
  if (!fs.existsSync(profileRoot)) {
    console.log('No profile directory found.');
    return;
  }
  const items = fs.readdirSync(profileRoot).filter(item => {
    const fullPath = path.join(profileRoot, item);
    return fs.statSync(fullPath).isDirectory();
  });
  console.log('Profiles:');
  items.forEach(item => console.log(` - ${item}`));
}

async function createToken() {
  const tokens = await readTokens(appRoot);
  const newToken = generateToken();
  tokens.push(newToken);
  await writeTokens(appRoot, tokens);
  console.log(`Generated Token: ${newToken}`);
  console.log('Copy this token and send it to the user.');
}

async function clearTokens() {
  await writeTokens(appRoot, []);
  console.log('All pending tokens cleared.');
}

async function upsertSpecialToken(rawCode) {
  const code = rawCode || generateSpecialToken();
  try {
    await setSpecialToken(appRoot, code);
  } catch (error) {
    console.error(`Error: ${error?.message || 'Invalid special code.'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Special Code: ${code}`);
  console.log('Only this hidden special code is active; the previous one was overwritten.');
}

async function clearSpecialTokenCommand() {
  await clearSpecialToken(appRoot);
  console.log('Hidden special code cleared.');
}

async function removeProfile(id) {
  const safeId = normalizeProfileId(id);
  if (!safeId) return console.error('Error: valid profile ID required.');
  const src = path.join(profileRoot, safeId);
  if (!fs.existsSync(src)) return console.error(`Error: Profile "${safeId}" not found.`);
  
  const dest = path.join(profileRoot, `${safeId}_del`);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    console.log(`Removed existing backup at "${safeId}_del"`);
  }
  
  fs.renameSync(src, dest);
  console.log(`Profile "${safeId}" has been moved to "${safeId}_del"`);
}

async function renameProfile(oldId, newId) {
  const safeOldId = normalizeProfileId(oldId);
  const safeNewId = normalizeProfileId(newId);
  if (!safeOldId || !safeNewId) return console.error('Usage: node server/cli.js rename <oldId> <newId>');
  const src = path.join(profileRoot, safeOldId);
  const dest = path.join(profileRoot, safeNewId);
  if (!fs.existsSync(src)) return console.error(`Error: Profile "${safeOldId}" not found.`);
  if (fs.existsSync(dest)) return console.error(`Error: Destination "${safeNewId}" already exists.`);
  
  fs.renameSync(src, dest);
  console.log(`Renamed "${safeOldId}" to "${safeNewId}"`);
}

async function resetProfile(id) {
  const safeId = normalizeProfileId(id);
  if (!safeId) return console.error('Error: valid profile ID required.');
  const pDir = path.join(profileRoot, safeId);
  if (!fs.existsSync(pDir)) return console.error(`Error: Profile "${safeId}" not found.`);
  
  // To reset, we delete key data files and re-ensure
  const files = ['history.json', 'progress.json', 'probehistory.json', 'config.json'];
  files.forEach(f => {
    const fPath = path.join(pDir, f);
    if (fs.existsSync(fPath)) fs.unlinkSync(fPath);
  });
  
  const storage = createStorage(appRoot, safeId);
  await storage.ensure();
  console.log(`Profile "${safeId}" data has been reset to defaults.`);
}

async function createProfileAdmin(id) {
  const safeId = normalizeProfileId(id);
  if (!safeId) return console.error('Error: valid profile ID required.');
  const pDir = path.join(profileRoot, safeId);
  if (fs.existsSync(pDir)) return console.error(`Error: Profile "${safeId}" already exists.`);
  
  const storage = createStorage(appRoot, safeId);
  await storage.ensure();
  console.log(`Profile "${safeId}" created successfully via admin.`);
}

function normalizeProfileId(raw) {
  const safe = String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(safe)) return '';
  if (['guest', '.', '..', 'con', 'prn', 'aux', 'nul'].includes(safe)) return '';
  if (/^com[1-9]$/.test(safe) || /^lpt[1-9]$/.test(safe)) return '';
  return safe;
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
