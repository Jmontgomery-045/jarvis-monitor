const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const chokidar = require('chokidar');
const { EventEmitter } = require('node:events');

const WIN_PROC_TTL_MS = 4000;
let winProcCache = { fetchedAt: 0, names: new Map(), pending: null };
function loadWindowsProcessNames() {
  const now = Date.now();
  if (winProcCache.pending) return winProcCache.pending;
  if ((now - winProcCache.fetchedAt) < WIN_PROC_TTL_MS) return Promise.resolve(winProcCache.names);
  winProcCache.pending = new Promise((resolve) => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const names = new Map();
      if (!err && stdout) {
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^"([^"]+)","(\d+)"/.exec(line);
          if (m) names.set(Number(m[2]), m[1].toLowerCase());
        }
      }
      winProcCache = { fetchedAt: Date.now(), names, pending: null };
      resolve(names);
    });
  });
  return winProcCache.pending;
}

function buildSource(s) {
  return {
    id: s.id,
    label: s.label,
    color: s.color,
    claudeDir: s.claudeDir,
    sessionsDir: path.join(s.claudeDir, 'sessions'),
    projectsDir: path.join(s.claudeDir, 'projects'),
    shellsRoot: s.shellsRoot || null,
    procPath: s.procPath || null
  };
}

let SOURCES = [];
let SOURCES_BY_ID = {};
function getSource(id) { return SOURCES_BY_ID[id]; }

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

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const PID_CHECK_TTL_MS = 5000;
const pidCheckCache = new Map();
async function isClaudeProcAlive(source, pid, meta) {
  if (!pid || !Number.isFinite(pid)) return false;
  const startedAt = meta && meta.startedAt ? Date.parse(meta.startedAt) : 0;
  const key = `${source.id}:${pid}:${startedAt}`;
  const cached = pidCheckCache.get(key);
  const now = Date.now();
  if (cached && (now - cached.checkedAt) < PID_CHECK_TTL_MS) return cached.alive;

  let alive = false;
  if (source.procPath) {
    try {
      const procDir = path.join(source.procPath, String(pid));
      await fsp.stat(procDir);
      let cmdline = '';
      try { cmdline = (await fsp.readFile(path.join(procDir, 'cmdline'), 'utf8')).replace(/\0/g, ' '); } catch {}
      const cmdlineHasClaude = /claude/i.test(cmdline);
      let startMatches = false;
      if (meta && meta.procStart) {
        try {
          const stat = await fsp.readFile(path.join(procDir, 'stat'), 'utf8');
          const close = stat.lastIndexOf(')');
          const rest = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/) : [];
          const starttime = rest[19];
          if (starttime && String(meta.procStart) === starttime) startMatches = true;
        } catch {}
      }
      alive = cmdlineHasClaude || startMatches;
    } catch { alive = false; }
  } else if (process.platform === 'win32') {
    if (!isPidAlive(pid)) alive = false;
    else {
      try {
        const names = await loadWindowsProcessNames();
        const name = names.get(pid);
        alive = !!name && (name === 'node.exe' || name === 'claude.exe' || name.includes('claude'));
      } catch { alive = isPidAlive(pid); }
    }
  } else {
    alive = isPidAlive(pid);
  }

  for (const [k] of pidCheckCache) {
    if (k.startsWith(`${source.id}:${pid}:`) && k !== key) pidCheckCache.delete(k);
  }
  pidCheckCache.set(key, { alive, checkedAt: now });
  return alive;
}

async function loadInstance(source, pidFile) {
  const meta = await readJson(pidFile);
  if (!meta || !meta.sessionId) {
    const pid = path.basename(pidFile, '.json');
    for (const id of Object.keys(state.instances)) {
      const inst = state.instances[id];
      if (inst.source === source.id && inst.pid === Number(pid)) delete state.instances[id];
    }
    return;
  }
  if (!(await isClaudeProcAlive(source, meta.pid, meta))) {
    if (state.instances[meta.sessionId] && state.instances[meta.sessionId].source === source.id) {
      delete state.instances[meta.sessionId];
    }
    if (source.id === 'win') fsp.unlink(pidFile).catch(() => {});
    return;
  }
  const id = meta.sessionId;
  for (const otherId of Object.keys(state.instances)) {
    if (otherId === id) continue;
    const other = state.instances[otherId];
    if (other.source === source.id && other.pid === meta.pid) delete state.instances[otherId];
  }
  const existing = state.instances[id] || { agents: {}, shells: {} };
  Object.assign(existing, {
    sessionId: id,
    source: source.id,
    sourceLabel: source.label,
    sourceColor: source.color,
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
  await refreshContext(id);
  await refreshMemory(id);
}

async function refreshContext(sessionId) {
  const inst = state.instances[sessionId];
  if (!inst || !inst.encodedCwd) return;
  const source = getSource(inst.source);
  if (!source) return;
  const file = path.join(source.projectsDir, inst.encodedCwd, `${sessionId}.jsonl`);
  try {
    const st = await fsp.stat(file);
    inst.contextBytes = st.size;
  } catch {
    inst.contextBytes = 0;
  }
}

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];

async function refreshMemory(sessionId) {
  const inst = state.instances[sessionId];
  if (!inst || !inst.encodedCwd) return;
  const source = getSource(inst.source);
  if (!source) return;
  const dir = path.join(source.projectsDir, inst.encodedCwd, 'memory');
  let files = [];
  try { files = await fsp.readdir(dir); } catch { inst.memoryFiles = []; return; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md') || f.toLowerCase() === 'memory.md') continue;
    let type = 'other';
    try {
      const fd = await fsp.open(path.join(dir, f), 'r');
      const buf = Buffer.alloc(512);
      const { bytesRead } = await fd.read(buf, 0, 512, 0);
      await fd.close();
      const head = buf.slice(0, bytesRead).toString('utf8');
      const m = /^type:\s*([a-z]+)/im.exec(head);
      if (m && MEMORY_TYPES.includes(m[1].toLowerCase())) type = m[1].toLowerCase();
    } catch {}
    out.push({ name: f, type });
  }
  inst.memoryFiles = out;
}

async function refreshAgents(sessionId) {
  const inst = state.instances[sessionId];
  if (!inst || !inst.encodedCwd) return;
  const source = getSource(inst.source);
  if (!source) return;
  const dir = path.join(source.projectsDir, inst.encodedCwd, sessionId, 'subagents');
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
  const source = getSource(inst.source);
  if (!source || !source.shellsRoot) {
    inst.shells = {};
    for (const ag of Object.values(inst.agents || {})) ag.shells = {};
    return;
  }
  const dir = path.join(source.shellsRoot, inst.encodedCwd, sessionId, 'tasks');
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
  const liveSessionIds = new Set();
  const livePidsBySource = {};
  for (const source of SOURCES) {
    let files = [];
    try { files = await fsp.readdir(source.sessionsDir); } catch { livePidsBySource[source.id] = new Set(); continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      await loadInstance(source, path.join(source.sessionsDir, f));
    }
    try {
      const current = await fsp.readdir(source.sessionsDir);
      livePidsBySource[source.id] = new Set(
        current.filter((f) => f.endsWith('.json')).map((f) => Number(f.replace(/\.json$/, '')))
      );
    } catch { livePidsBySource[source.id] = new Set(); }
  }
  for (const id of Object.keys(state.instances)) {
    const inst = state.instances[id];
    const livePids = livePidsBySource[inst.source];
    if (!livePids || !livePids.has(inst.pid)) delete state.instances[id];
    else liveSessionIds.add(id);
  }
  for (const id of liveSessionIds) {
    await refreshAgents(id);
    await refreshShells(id);
    await refreshContext(id);
    await refreshMemory(id);
  }
}

setInterval(() => {
  rescanInstances().then(scheduleEmit);
}, 3000);

function findInstanceByEncodedCwd(sourceId, encodedCwd, sessionId) {
  for (const inst of Object.values(state.instances)) {
    if (inst.source === sourceId && inst.sessionId === sessionId && inst.encodedCwd === encodedCwd) return inst;
  }
  return null;
}

function startWatcher(config) {
  SOURCES = (config && config.sources ? config.sources : []).map(buildSource);
  SOURCES_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
  return new Promise(async (resolve) => {
    try {
      await rescanInstances();
    } catch (e) {
      console.error('[watcher] initial scan failed:', e);
    }
    scheduleEmit();

    const watchPaths = [];
    const needsPolling = SOURCES.some((s) => s.claudeDir.startsWith('\\\\'));
    for (const source of SOURCES) {
      watchPaths.push(source.sessionsDir, source.projectsDir);
      if (source.shellsRoot) watchPaths.push(source.shellsRoot);
    }

    const watcher = chokidar.watch(watchPaths, {
      ignored: ['**/.lock', '**/file-history/**', '**/shell-snapshots/**', '**/plugins/**', '**/memory/**'],
      ignoreInitial: true,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      usePolling: needsPolling,
      interval: 1500,
      binaryInterval: 3000
    });

    function matchSource(filePath) {
      for (const source of SOURCES) {
        if (filePath.startsWith(source.sessionsDir)) return { source, kind: 'sessions' };
        if (filePath.startsWith(source.projectsDir)) return { source, kind: 'projects' };
        if (source.shellsRoot && filePath.startsWith(source.shellsRoot)) return { source, kind: 'shells' };
      }
      return null;
    }

    watcher.on('all', async (event, filePath) => {
      try {
        const m = matchSource(filePath);
        if (!m) return;
        const { source, kind } = m;
        if (kind === 'sessions') {
          if (filePath.endsWith('.json')) await loadInstance(source, filePath);
          if (event === 'unlink') {
            const pid = Number(path.basename(filePath, '.json'));
            for (const id of Object.keys(state.instances)) {
              const inst = state.instances[id];
              if (inst.source === source.id && inst.pid === pid) delete state.instances[id];
            }
          }
          scheduleEmit();
          return;
        }
        if (kind === 'projects') {
          const rel = path.relative(source.projectsDir, filePath);
          const parts = rel.split(/[\\/]/);
          if (parts.length >= 4 && parts[2] === 'subagents') {
            const encodedCwd = parts[0];
            const sid = parts[1];
            const inst = findInstanceByEncodedCwd(source.id, encodedCwd, sid);
            if (inst) {
              await refreshAgents(sid);
              await refreshShells(sid);
              scheduleEmit();
            }
          }
          return;
        }
        if (kind === 'shells') {
          const rel = path.relative(source.shellsRoot, filePath);
          const parts = rel.split(/[\\/]/);
          if (parts.length >= 4 && parts[2] === 'tasks') {
            const encodedCwd = parts[0];
            const sid = parts[1];
            const inst = findInstanceByEncodedCwd(source.id, encodedCwd, sid);
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
