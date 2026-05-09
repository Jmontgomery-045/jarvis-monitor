import { Graph } from './viz.js';

const stage = document.getElementById('stage');
const hudSummary = document.getElementById('hud-summary');
const hudDetail = document.getElementById('hud-detail');

const graph = new Graph(stage);
graph.onSelect = (node) => renderDetail(node);

const seenAgents = new Map();
const seenShells = new Map();
const dismissed = new Set();

graph.onDismiss = (node) => {
  dismissed.add(node.id);
  if (node.kind === 'agent') seenAgents.delete(node.id);
  else if (node.kind === 'shell') seenShells.delete(node.id);
  if (graph.selected && graph.selected.id === node.id) {
    graph.selected = null;
    renderDetail(null);
  }
};

const DEAD_TTL_MS = 60 * 1000;

function decorate(snapshot) {
  if (!snapshot || !snapshot.instances) return snapshot;
  const now = Date.now();
  for (const [sid, inst] of Object.entries(snapshot.instances)) {
    for (const [aid, ag] of Object.entries(inst.agents || {})) {
      const key = `a:${sid}:${aid}`;
      dismissed.delete(key);
      const prev = seenAgents.get(key);
      seenAgents.set(key, {
        sessionId: sid,
        agent: { ...ag, shells: undefined },
        deadSince: null,
        lastSeen: now
      });
      for (const [shid, sh] of Object.entries(ag.shells || {})) {
        const skey = `s:${sid}:${shid}`;
        dismissed.delete(skey);
        seenShells.set(skey, {
          sessionId: sid, shell: { ...sh }, ownerAgentId: aid, deadSince: null, lastSeen: now
        });
      }
    }
    for (const [shid, sh] of Object.entries(inst.shells || {})) {
      const skey = `s:${sid}:${shid}`;
      dismissed.delete(skey);
      seenShells.set(skey, {
        sessionId: sid, shell: { ...sh }, ownerAgentId: null, deadSince: null, lastSeen: now
      });
    }
  }
  for (const [key, rec] of seenAgents) {
    if (dismissed.has(key)) continue;
    const inst = snapshot.instances[rec.sessionId];
    if (!inst) { seenAgents.delete(key); continue; }
    inst.agents = inst.agents || {};
    if (!inst.agents[rec.agent.id]) {
      if (!rec.deadSince) rec.deadSince = now;
      if (now - rec.deadSince > DEAD_TTL_MS) { seenAgents.delete(key); continue; }
      inst.agents[rec.agent.id] = { ...rec.agent, status: 'dead', shells: {} };
    }
  }
  for (const [key, rec] of seenShells) {
    if (dismissed.has(key)) continue;
    const inst = snapshot.instances[rec.sessionId];
    if (!inst) { seenShells.delete(key); continue; }
    if (rec.ownerAgentId) {
      const ag = (inst.agents || {})[rec.ownerAgentId];
      if (!ag) { seenShells.delete(key); continue; }
      ag.shells = ag.shells || {};
      if (!ag.shells[rec.shell.id]) {
        if (!rec.deadSince) rec.deadSince = now;
        if (now - rec.deadSince > DEAD_TTL_MS) { seenShells.delete(key); continue; }
        ag.shells[rec.shell.id] = { ...rec.shell, status: 'dead' };
      }
    } else {
      inst.shells = inst.shells || {};
      if (!inst.shells[rec.shell.id]) {
        if (!rec.deadSince) rec.deadSince = now;
        if (now - rec.deadSince > DEAD_TTL_MS) { seenShells.delete(key); continue; }
        inst.shells[rec.shell.id] = { ...rec.shell, status: 'dead' };
      }
    }
  }
  return snapshot;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  stage.width = Math.floor(r.width * dpr);
  stage.height = Math.floor(r.height * dpr);
  graph.setSize(r.width, r.height, dpr);
}
window.addEventListener('resize', resize);
resize();

function renderSummary(state) {
  const instances = Object.values(state.instances || {});
  let nBusy = 0;
  let nAgents = 0;
  let nShells = 0;
  let nActiveShells = 0;
  let nActiveAgents = 0;
  for (const i of instances) {
    if (i.status === 'busy') nBusy++;
    for (const a of Object.values(i.agents || {})) {
      nAgents++;
      if (a.status === 'active') nActiveAgents++;
      for (const s of Object.values(a.shells || {})) {
        nShells++;
        if (s.status === 'active') nActiveShells++;
      }
    }
    for (const s of Object.values(i.shells || {})) {
      nShells++;
      if (s.status === 'active') nActiveShells++;
    }
  }
  hudSummary.innerHTML = `
    <div class="row"><span>Instances</span><span class="v">${instances.length}</span></div>
    <div class="row"><span>Busy</span><span class="v" style="color:var(--accent-warm)">${nBusy}</span></div>
    <div class="row"><span>Agents</span><span class="v" style="color:var(--agent)">${nAgents}${nActiveAgents ? ` · ${nActiveAgents} live` : ''}</span></div>
    <div class="row"><span>Shells</span><span class="v" style="color:var(--shell)">${nShells}${nActiveShells ? ` · ${nActiveShells} live` : ''}</span></div>
  `;
}

function fmtAgo(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function renderDetail(node) {
  if (!node) {
    hudDetail.classList.remove('show');
    return;
  }
  let html = '';
  if (node.kind === 'instance' || node.kind === 'instanceCenter') {
    html = `<h3>Instance</h3><div class="kv">
      <span class="k">Cwd</span><span class="v">${esc(node.cwd || '—')}</span>
      <span class="k">PID</span><span class="v">${esc(node.pid)}</span>
      <span class="k">Session</span><span class="v">${esc(node.sessionId.slice(0, 8))}…</span>
      <span class="k">Status</span><span class="v">${esc(node.status)}</span>
      <span class="k">Version</span><span class="v">${esc(node.version || '—')}</span>
      <span class="k">Started</span><span class="v">${fmtAgo(node.startedAt)}</span>
      <span class="k">Updated</span><span class="v">${fmtAgo(node.updatedAt)}</span>
      <span class="k">Agents</span><span class="v">${node.agentCount}</span>
      <span class="k">Shells</span><span class="v">${node.shellCount}</span></div>`;
  } else if (node.kind === 'agent') {
    html = `<h3>Agent</h3><div class="kv">
      <span class="k">Type</span><span class="v">${esc(node.type)}</span>
      <span class="k">Task</span><span class="v">${esc(node.description)}</span>
      <span class="k">Status</span><span class="v">${esc(node.status)}</span>
      <span class="k">Last</span><span class="v">${fmtAgo(node.mtime)}</span></div>`;
  } else if (node.kind === 'shell') {
    html = `<h3>Shell</h3><div class="kv">
      <span class="k">ID</span><span class="v">${esc(node.shellId)}</span>
      <span class="k">Status</span><span class="v">${esc(node.status)}</span>
      <span class="k">Last</span><span class="v">${fmtAgo(node.mtime)}</span>
      <span class="k">Output</span><span class="v">${esc(node.preview || '—')}</span></div>`;
  }
  hudDetail.innerHTML = html;
  hudDetail.classList.add('show');
}

async function init() {
  const initial = decorate(await window.jarvis.getState());
  graph.setState(initial);
  renderSummary(initial);
  window.jarvis.onState((s) => {
    const decorated = decorate(s);
    graph.setState(decorated);
    renderSummary(decorated);
  });
  window.jarvis.onHook((e) => graph.flashHook(e));
}
init();
