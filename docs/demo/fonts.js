// node fonts.js -- copies the Claude desktop app's own font into fonts/ (not committed:
// it is the app's, not ours to publish). Looks in the app's install, or in the folder
// named by CLAUDE_APP_DIR. Without it the scene falls back to a system font.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WANT = { 'AnthropicSans.woff2': /^AnthropicSans-Roman-Variable.*\.woff2$/ };

function roots() {
  const out = [];
  if (process.env.CLAUDE_APP_DIR) out.push(process.env.CLAUDE_APP_DIR);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    // %LOCALAPPDATA%\AnthropicClaude\app-<version>\resources, newest first
    const base = path.join(process.env.LOCALAPPDATA, 'AnthropicClaude');
    if (fs.existsSync(base)) {
      const apps = fs.readdirSync(base).filter(d => d.startsWith('app-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const d of apps) out.push(path.join(base, d, 'resources'));
    }
  }
  if (process.platform === 'darwin') {
    out.push('/Applications/Claude.app/Contents/Resources', path.join(os.homedir(), 'Applications/Claude.app/Contents/Resources'));
  }
  return out.filter(p => fs.existsSync(p));
}

function find(dir, re, depth = 0) {
  if (depth > 8) return undefined;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const e of entries) if (e.isFile() && re.test(e.name)) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules') { const hit = find(path.join(dir, e.name), re, depth + 1); if (hit) return hit; }
  return undefined;
}

const outDir = path.join(__dirname, 'fonts');
fs.mkdirSync(outDir, { recursive: true });
let missing = 0;
for (const [name, re] of Object.entries(WANT)) {
  const dest = path.join(outDir, name);
  let src;
  for (const root of roots()) if ((src = find(root, re))) break;
  if (src) { fs.copyFileSync(src, dest); console.log('font', name, '<-', path.basename(src)); }
  else if (fs.existsSync(dest)) console.log('font', name, 'kept (app not found)');
  else { missing++; console.warn(`font ${name} not found: install the Claude desktop app or set CLAUDE_APP_DIR; a system font will stand in`); }
}
if (missing) console.warn('continuing without the app font');
