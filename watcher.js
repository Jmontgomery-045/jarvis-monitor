const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const chokidar = require('chokidar');
const { EventEmitter } = require('node:events');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SHELLS_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
  'Temp',
  'claude'
);

const ACTIVE_WINDOW_MS = 30 * 1000;
const MAX_HOOK_EVENTS = 50;

const events = new EventEmitter();

const state = {
  startedAt: Date.now(),
  instances: {},
  hooks: [],
  pushHookEvent(ev) {
    this.hooks.unshift(ev);
    if (this.hooks.length > MAX_HOOK_EVENTS) this.hooks.length = MAX_HOOK_EVENTS;
  },
  snapshot() {
    return JSON.parse(JSON.stringify({
      startedAt: this.startedAt,
      instances: this.instances,
      hooks: this.hooks
    }));
  }
};

function encodeCwd(cwd) {
  if (!cwd) return null;
  return cwd
    .replace(/^([A-Za-z]):[\\/]/, (_, d) => `${d.toUpperCase()}--`)
    .replace(/[\\/]/g, '-');
}

function cwdLabel(cwd) {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

async function readJson(file) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function loadInstance(pidFile) {
  const meta = await readJson(pidFile);
  if (!meta || !meta.sessionId) {
    const pid = path.basename(pidFile, '.json');
    for (const id of Object.keys(state.instances)) {
      if (state.instances[id].pid === Number(pid)) delete state.instances[id];
    }
    return;
  }
  const id = meta.sessionId;
  const existing = state.instances[id] || { agents: {}, shells: {} };
  Object.assign(existing, {
    sessionId: id,
    pid: meta.pid,
    cwd: meta.cwd,
    cwdLabel: cwdLabel(meta.cwd),
    encodedCwd: encodeCwd(meta.cwd),
    version: meta.version,
    kind: meta.kind,
    startedAt: meta.startedAt,
    updatedAt: meta.updatedAt,
    status: meta.status || 'idle'
  });
  state.instances[id] = existing;
  await refreshAgents(id);
  await refreshShells(id);
}

async function refreshAgents(sessionId) {
  const inst = state.instances[sessionId];
  if (!inst || !inst.encodedCwd) return;
  const dir = path.join(PROJECTS_DIR, inst.encodedCwd, sessionId, 'subagents');
  const next = {};
  let files = [];
  try { files = await fsp.readdir(dir); } catch { inst.agents = {}; return; }
  const seen = new Set();
  for (const f of files) {
    const m = f.match(/^agent-([A-Za-z0-9]+)/);
    if (!m) continue;
    const rawId = m[1];
    const base = `agent-${rawId}`;
    if (seen.has(base)) continue;
    seen.add(base);
    const metaFile = path.join(dir, `${base}.meta.json`);
    const jsonlFile = path.join(dir, `${base}.jsonl`);
    let info = {};
    try { info = JSON.parse(await fsp.readFile(metaFile, 'utf8')); } catch {}
    let mtime = 0;
    try { mtime = (await fsp.stat(jsonlFile)).mtimeMs; } catch {}
    if (!mtime) continue;
    if ((Date.now() - mtime) >= ACTIVE_WINDOW_MS) continue;
    next[base] = {
      id: base,
      rawId,
      transcript: jsonlFile,
      type: info.agentType || info.type || 'agent',
      description: info.description || '',
      mtime,
      status: 'active',
      shells: {}
    };
  }
  inst.agents = next;
}

const TRANSCRIPT_SCAN_BYTES = 256 * 1024;

async function extractTranscriptShells(transcriptPath) {
  const text = await readTail(transcriptPath, TRANSCRIPT_SCAN_BYTES);
  if (!text) return [];
  const shells = new Map();
  const completed = new Map();
  const lines = text.split('\n');
  for (const raw of lines) {
    if (!raw) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'tool_use' && (item.name === 'Bash' || item.name === 'PowerShell')) {
        const cmd = (item.input && item.input.command) || '';
        const desc = (item.input && item.input.description) || '';
        const preview = (desc || cmd).split(/\r?\n/).find(Boolean) || '';
        shells.set(item.id, {
          id: item.id,
          tool: item.name,
          preview: preview.slice(0, 80),
          mtime: ts || Date.now(),
          status: 'active',
          virtual: true
        });
      } else if (item.type === 'tool_result' && item.tool_use_id) {
        completed.set(item.tool_use_id, ts || Date.now());
      }
    }
  }
  for (const [id, doneAt] of completed) {
    const sh = shells.get(id);
    if (sh) { sh.status = 'idle'; sh.mtime = doneAt || sh.mtime; }
  }
  return [...shells.values()];
}

async function readTail(file, bytes) {
  let fd;
  try {
    const st = await fsp.stat(file);
    fd = await fsp.open(file, 'r');
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

async function refreshShells(sessionId) {
  const inst = state.instances[sessionId];
  if (!inst || !inst.encodedCwd) return;
  const dir = path.join(SHELLS_ROOT, inst.encodedCwd, sessionId, 'tasks');
  let files = [];
  try { files = await fsp.readdir(dir); } catch {
    inst.shells = {};
    for (const ag of Object.values(inst.agents || {})) ag.shells = {};
    return;
  }
  const agentRawIds = new Set(Object.values(inst.agents || {}).map((a) => a.rawId));
  const candidates = [];
  for (const f of files) {
    if (!f.endsWith('.output')) continue;
    const id = f.replace(/\.output$/, '');
    if (agentRawIds.has(id)) continue;
    const full = path.join(dir, f);
    let stat;
    try { stat = await fsp.stat(full); } catch { continue; }
    if ((Date.now() - stat.mtimeMs) >= ACTIVE_WINDOW_MS) continue;
    let preview = '';
    try {
      const fd = await fsp.open(full, 'r');
      const buf = Buffer.alloc(256);
      const { bytesRead } = await fd.read(buf, 0, 256, 0);
      await fd.close();
      preview = buf.slice(0, bytesRead).toString('utf8').split(/\r?\n/).find(Boolean) || '';
      preview = preview.slice(0, 80);
    } catch {}
    candidates.push({
      id,
      file: full,
      mtime: stat.mtimeMs,
      size: stat.size,
      preview,
      status: 'active'
    });
  }

  const ownerByShell = new Map();
  for (const ag of Object.values(inst.agents || {})) {
    if (!ag.transcript) continue;
    const text = await readTail(ag.transcript, TRANSCRIPT_SCAN_BYTES);
    if (!text) continue;
    for (const sh of candidates) {
      if (ownerByShell.has(sh.id)) continue;
      if (text.includes(sh.id)) ownerByShell.set(sh.id, ag.id);
    }
  }

  const instShells = {};
  const agentShells = {};
  for (const ag of Object.values(inst.agents || {})) agentShells[ag.id] = {};
  for (const sh of candidates) {
    const ownerKey = ownerByShell.get(sh.id);
    if (ownerKey && agentShells[ownerKey]) agentShells[ownerKey][sh.id] = sh;
    else instShells[sh.id] = sh;
  }
  inst.shells = instShells;
  for (const ag of Object.values(inst.agents || {})) {
    const merged = agentShells[ag.id] || {};
    if (ag.transcript) {
      const virtualShells = await extractTranscriptShells(ag.transcript);
      for (const sh of virtualShells) {
        if ((Date.now() - sh.mtime) >= ACTIVE_WINDOW_MS) continue;
        if (!merged[sh.id]) merged[sh.id] = sh;
      }
    }
    ag.shells = merged;
  }
}

function refreshStatuses() {
  const now = Date.now();
  for (const inst of Object.values(state.instances)) {
    for (const a of Object.values(inst.agents || {})) {
      a.status = (now - a.mtime) < ACTIVE_WINDOW_MS ? 'active' : 'idle';
      for (const s of Object.values(a.shells || {})) {
        s.status = (now - s.mtime) < ACTIVE_WINDOW_MS ? 'active' : 'idle';
      }
    }
    for (const s of Object.values(inst.shells || {})) {
      s.status = (now - s.mtime) < ACTIVE_WINDOW_MS ? 'active' : 'idle';
    }
  }
}

let pendingEmit;
function scheduleEmit() {
  if (pendingEmit) return;
  pendingEmit = setTimeout(() => {
    pendingEmit = null;
    refreshStatuses();
    events.emit('change', state.snapshot());
  }, 150);
}

async function rescanInstances() {
  let files = [];
  try { files = await fsp.readdir(SESSIONS_DIR); } catch { return; }
  const liveSessionIds = new Set();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    await loadInstance(path.join(SESSIONS_DIR, f));
  }
  try {
    const current = await fsp.readdir(SESSIONS_DIR);
    const livePids = new Set(
      current.filter((f) => f.endsWith('.json')).map((f) => Number(f.replace(/\.json$/, '')))
    );
    for (const id of Object.keys(state.instances)) {
      if (!livePids.has(state.instances[id].pid)) delete state.instances[id];
      else liveSessionIds.add(id);
    }
  } catch {}
  for (const id of liveSessionIds) {
    await refreshAgents(id);
    await refreshShells(id);
  }
}

setInterval(() => {
  rescanInstances().then(scheduleEmit);
}, 3000);

function findInstanceByEncodedCwd(encodedCwd, sessionId) {
  for (const inst of Object.values(state.instances)) {
    if (inst.sessionId === sessionId && inst.encodedCwd === encodedCwd) return inst;
  }
  return null;
}

function startWatcher() {
  return new Promise(async (resolve) => {
    try {
      await rescanInstances();
    } catch (e) {
      console.error('[watcher] initial scan failed:', e);
    }
    scheduleEmit();

    const watcher = chokidar.watch([SESSIONS_DIR, PROJECTS_DIR, SHELLS_ROOT], {
      ignored: ['**/.lock', '**/file-history/**', '**/shell-snapshots/**', '**/plugins/**', '**/memory/**'],
      ignoreInitial: true,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 }
    });

    watcher.on('all', async (event, filePath) => {
      try {
        if (filePath.startsWith(SESSIONS_DIR)) {
          if (filePath.endsWith('.json')) await loadInstance(filePath);
          if (event === 'unlink') {
            const pid = Number(path.basename(filePath, '.json'));
            for (const id of Object.keys(state.instances)) {
              if (state.instances[id].pid === pid) delete state.instances[id];
            }
          }
          scheduleEmit();
          return;
        }
        if (filePath.startsWith(PROJECTS_DIR)) {
          const rel = path.relative(PROJECTS_DIR, filePath);
          const parts = rel.split(path.sep);
          if (parts.length >= 4 && parts[2] === 'subagents') {
            const encodedCwd = parts[0];
            const sid = parts[1];
            const inst = findInstanceByEncodedCwd(encodedCwd, sid);
            if (inst) {
              await refreshAgents(sid);
              await refreshShells(sid);
              scheduleEmit();
            }
          }
          return;
        }
        if (filePath.startsWith(SHELLS_ROOT)) {
          const rel = path.relative(SHELLS_ROOT, filePath);
          const parts = rel.split(path.sep);
          if (parts.length >= 4 && parts[2] === 'tasks') {
            const encodedCwd = parts[0];
            const sid = parts[1];
            const inst = findInstanceByEncodedCwd(encodedCwd, sid);
            if (inst) {
              await refreshShells(sid);
              scheduleEmit();
            }
          }
          return;
        }
      } catch (e) {
        console.error('[watcher]', e);
      }
    });

    watcher.on('error', (e) => console.error('[watcher] error', e));

    resolve();
  });
}

module.exports = {
  startWatcher,
  getState: () => state,
  on: (ev, fn) => events.on(ev, fn)
};
