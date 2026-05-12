const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandPath(p) {
  if (!p) return p;
  let out = p;
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  out = out.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
  return out;
}

function loadConfig() {
  const candidates = [
    path.join(__dirname, 'config.json'),
    path.join(__dirname, 'config.example.json')
  ];
  let raw = null;
  for (const f of candidates) {
    try {
      raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      break;
    } catch {}
  }
  if (!raw) raw = { hookPort: 7373, sources: [] };

  const sources = (raw.sources || []).map((s) => ({
    id: s.id,
    label: s.label || s.id,
    color: s.color || '#6ee0ff',
    claudeDir: expandPath(s.claudeDir),
    shellsRoot: s.shellsRoot ? expandPath(s.shellsRoot) : null,
    procPath: s.procPath ? expandPath(s.procPath) : null
  }));

  return {
    hookPort: Number(raw.hookPort || 7373),
    usageCachePath: raw.usageCachePath ? expandPath(raw.usageCachePath) : null,
    sources
  };
}

module.exports = { loadConfig, expandPath };
