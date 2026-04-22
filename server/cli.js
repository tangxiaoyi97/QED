/* QED Admin CLI v0.2 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTokens, writeTokens, generateToken } from './tokens.js';
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

async function removeProfile(id) {
  if (!id) return console.error('Error: Profile ID required.');
  const src = path.join(profileRoot, id);
  if (!fs.existsSync(src)) return console.error(`Error: Profile "${id}" not found.`);
  
  const dest = path.join(profileRoot, `${id}_del`);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    console.log(`Removed existing backup at "${id}_del"`);
  }
  
  fs.renameSync(src, dest);
  console.log(`Profile "${id}" has been moved to "${id}_del"`);
}

async function renameProfile(oldId, newId) {
  if (!oldId || !newId) return console.error('Usage: node server/cli.js rename <oldId> <newId>');
  const src = path.join(profileRoot, oldId);
  const dest = path.join(profileRoot, newId);
  if (!fs.existsSync(src)) return console.error(`Error: Profile "${oldId}" not found.`);
  if (fs.existsSync(dest)) return console.error(`Error: Destination "${newId}" already exists.`);
  
  fs.renameSync(src, dest);
  console.log(`Renamed "${oldId}" to "${newId}"`);
}

async function resetProfile(id) {
  if (!id) return console.error('Error: Profile ID required.');
  const pDir = path.join(profileRoot, id);
  if (!fs.existsSync(pDir)) return console.error(`Error: Profile "${id}" not found.`);
  
  // To reset, we delete key data files and re-ensure
  const files = ['history.json', 'progress.json', 'probehistory.json', 'config.json'];
  files.forEach(f => {
    const fPath = path.join(pDir, f);
    if (fs.existsSync(fPath)) fs.unlinkSync(fPath);
  });
  
  const storage = createStorage(appRoot, id);
  await storage.ensure();
  console.log(`Profile "${id}" data has been reset to defaults.`);
}

async function createProfileAdmin(id) {
  if (!id) return console.error('Error: Profile ID required.');
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const pDir = path.join(profileRoot, safeId);
  if (fs.existsSync(pDir)) return console.error(`Error: Profile "${safeId}" already exists.`);
  
  const storage = createStorage(appRoot, safeId);
  await storage.ensure();
  console.log(`Profile "${safeId}" created successfully via admin.`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
