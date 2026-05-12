const TWO_PI = Math.PI * 2;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '110,224,255';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function phaseOf(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 1000) / 1000) * TWO_PI;
}

const COLOR = {
  core: '#6ee0ff',
  instance: '#6ee0ff',
  instanceBusy: '#ffd166',
  agent: '#ce9bff',
  shell: '#7af1c5',
  link: 'rgba(110,224,255,0.16)',
  linkActive: 'rgba(255,209,102,0.55)',
  linkAgent: 'rgba(206,155,255,0.35)',
  linkShell: 'rgba(122,241,197,0.35)'
};

export class Graph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.state = { instances: {}, hooks: [] };
    this.t0 = performance.now();
    this.lastT = 0;
    this.hover = null;
    this.selected = null;
    this.mouse = null;
    this.onSelect = () => {};
    this.onDismiss = () => {};
    this.flashes = [];
    this.sprites = new Map();
    this.bindEvents();
    requestAnimationFrame(this.frame.bind(this));
  }

  setSize(w, h, dpr) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setState(s) {
    this.state = s || { instances: {}, hooks: [] };
  }

  flashHook(ev) {
    this.flashes.push({ ts: performance.now(), event: ev });
    if (this.flashes.length > 20) this.flashes.shift();
  }

  bindEvents() {
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mouse = null;
    });
    this.canvas.addEventListener('click', () => {
      if (this.hover) {
        if (this.hover.status === 'dead') {
          this.onDismiss(this.hover);
          return;
        }
        this.selected = this.hover;
        this.onSelect(this.hover);
      } else {
        this.selected = null;
        this.onSelect(null);
      }
    });
  }

  layout() {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const minDim = Math.min(this.w, this.h);
    const tt = this.tt || 0;
    const drift = tt * 0.04;
    const childDrift = tt * 0.08;

    const nodes = [];
    const links = [];

    const instances = Object.values(this.state.instances || {})
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const nInst = instances.length;

    if (nInst === 0) {
      nodes.push({ id: 'core', kind: 'core', x: cx, y: cy, r: minDim * 0.07 });
      return { nodes, links, cx, cy, baseRadius: minDim * 0.07 };
    }

    const buildInstanceNode = (inst, x, y, r, asCenter) => {
      const busy = inst.status === 'busy';
      return {
        id: `i:${inst.sessionId}`,
        kind: asCenter ? 'instanceCenter' : 'instance',
        x, y, r,
        label: asCenter ? '' : (inst.cwdLabel || ''),
        cwdLabel: inst.cwdLabel || '',
        sessionId: inst.sessionId,
        source: inst.source,
        sourceLabel: inst.sourceLabel,
        sourceColor: inst.sourceColor,
        pid: inst.pid,
        cwd: inst.cwd,
        version: inst.version,
        status: inst.status,
        startedAt: inst.startedAt,
        updatedAt: inst.updatedAt,
        active: busy,
        agentCount: Object.keys(inst.agents || {}).length,
        shellCount: Object.keys(inst.shells || {}).length +
          Object.values(inst.agents || {}).reduce((n, ag) => n + Object.keys(ag.shells || {}).length, 0),
        contextBytes: inst.contextBytes || 0,
        memoryFiles: inst.memoryFiles || []
      };
    };

    const buildChildrenList = (inst) => {
      const agentList = Object.values(inst.agents || {});
      const instShells = Object.values(inst.shells || {});
      return [
        ...agentList.map((ag) => ({
          kind: 'agent',
          id: `a:${inst.sessionId}:${ag.id}`,
          type: ag.type,
          description: ag.description,
          status: ag.status,
          mtime: ag.mtime,
          shells: Object.values(ag.shells || {})
        })),
        ...instShells.map((sh) => ({
          kind: 'shell',
          id: `s:${inst.sessionId}:${sh.id}`,
          shellId: sh.id,
          preview: sh.preview,
          status: sh.status,
          mtime: sh.mtime,
          size: sh.size
        }))
      ];
    };

    const placeChildren = (instNode, inst, centerAngle, arcSpan, minOrbit, fullCircle) => {
      const children = buildChildrenList(inst);
      const nC = children.length;
      if (!nC) return;
      const baseR = Math.max(5, Math.min(26, (minDim * 0.04) / Math.sqrt(nC)));
      const agentR = baseR * 1.1;
      const shellR = baseR * 0.55;
      const childMaxR = Math.max(agentR, shellR);
      const orbitR = Math.max(minOrbit, instNode.r + childMaxR * 1.5 + 10);
      const denom = fullCircle ? nC : Math.max(1, nC - 1);
      const start = fullCircle ? -Math.PI / 2 + childDrift : centerAngle - arcSpan / 2;
      children.forEach((c, ci) => {
        const ca = fullCircle
          ? start + (ci / denom) * TWO_PI
          : (nC === 1 ? centerAngle : start + (ci / denom) * arcSpan);
        const childPhase = phaseOf(c.id);
        const radialBreath = 1 + Math.sin(tt * 0.45 + childPhase) * 0.08;
        const effOrbit = orbitR * radialBreath;
        const cxn = instNode.x + Math.cos(ca) * effOrbit;
        const cyn = instNode.y + Math.sin(ca) * effOrbit;
        const node = {
          ...c,
          x: cxn,
          y: cyn,
          r: c.kind === 'agent' ? agentR : shellR
        };
        nodes.push(node);
        links.push({ from: instNode, to: node, kind: c.kind, active: c.status === 'active' });

        if (c.kind === 'agent' && c.shells.length) {
          const nS = c.shells.length;
          const subBase = Math.max(3, Math.min(12, (minDim * 0.02) / Math.sqrt(nS)));
          const subOrbit = node.r + subBase * 1.5 + 8;
          const subArc = nS > 1 ? Math.PI * 0.6 : 0;
          const subStart = ca - subArc / 2;
          c.shells.forEach((sh, si) => {
            const sa = nS === 1 ? ca : subStart + (si / (nS - 1)) * subArc;
            const shPhase = phaseOf(sh.id);
            const subBreath = 1 + Math.sin(tt * 0.55 + shPhase) * 0.1;
            const effSubOrbit = subOrbit * subBreath;
            const sx = cxn + Math.cos(sa) * effSubOrbit;
            const sy = cyn + Math.sin(sa) * effSubOrbit;
            const shNode = {
              kind: 'shell',
              id: `s:${inst.sessionId}:${sh.id}`,
              shellId: sh.id,
              preview: sh.preview,
              status: sh.status,
              mtime: sh.mtime,
              size: sh.size,
              x: sx,
              y: sy,
              r: subBase
            };
            nodes.push(shNode);
            links.push({ from: node, to: shNode, kind: 'shell', active: sh.status === 'active' });
          });
        }
      });
    };

    if (nInst === 1) {
      const inst = instances[0];
      const r = minDim * 0.16;
      const instNode = buildInstanceNode(inst, cx, cy, r, true);
      nodes.push(instNode);
      const orbitR = Math.min(this.w, this.h) * 0.32;
      placeChildren(instNode, inst, 0, TWO_PI, orbitR, true);
      return { nodes, links, cx, cy, baseRadius: r };
    }

    const coreR = Math.max(minDim * 0.025, 6);
    const center = { id: 'core', kind: 'core', x: cx, y: cy, r: coreR };
    nodes.push(center);

    const instR = Math.max(14, Math.min(40, (minDim * 0.1) / Math.sqrt(nInst)));
    const instOrbit = minDim * (nInst <= 3 ? 0.26 : nInst <= 6 ? 0.3 : 0.34);
    const childArcFraction = nInst <= 2 ? 0.85 : nInst <= 4 ? 0.75 : 0.6;
    const childArc = (TWO_PI / nInst) * childArcFraction;

    instances.forEach((inst, ii) => {
      const a = (ii / nInst) * TWO_PI - Math.PI / 2 + drift;
      const instPhase = phaseOf(inst.sessionId);
      const instBreath = 1 + Math.sin(tt * 0.35 + instPhase) * 0.06;
      const effInstOrbit = instOrbit * instBreath;
      const ix = cx + Math.cos(a) * effInstOrbit;
      const iy = cy + Math.sin(a) * effInstOrbit;
      const instNode = buildInstanceNode(inst, ix, iy, instR, false);
      nodes.push(instNode);
      links.push({ from: center, to: instNode, kind: 'instance', active: inst.status === 'busy' });

      const childOrbit = instNode.r + 28 + Math.min(28, buildChildrenList(inst).length * 1.6);
      placeChildren(instNode, inst, a, childArc, childOrbit, false);
    });

    return { nodes, links, cx, cy, baseRadius: coreR };
  }

  pickNode(nodes) {
    if (!this.mouse) return null;
    const { x, y } = this.mouse;
    let best = null;
    let bestD = Infinity;
    for (const n of nodes) {
      if (n.kind === 'core') continue;
      const dx = n.x - x;
      const dy = n.y - y;
      const d2 = dx * dx + dy * dy;
      const r = n.r + 4;
      if (d2 < r * r && d2 < bestD) {
        best = n;
        bestD = d2;
      }
    }
    return best;
  }

  frame(t) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const dt = this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 0.016;
    this.lastT = t;
    const tt = (t - this.t0) / 1000;
    this.tt = tt;
    const layout = this.layout();

    const k = 1 - Math.pow(1 - 0.22, dt * 60);
    const lerp = (a, b) => a + (b - a) * k;

    const targetById = new Map();
    for (const n of layout.nodes) targetById.set(n.id, n);

    for (const sp of this.sprites.values()) sp.exiting = true;

    for (const tn of layout.nodes) {
      let sp = this.sprites.get(tn.id);
      if (!sp) {
        const incoming = layout.links.find((l) => l.to.id === tn.id);
        const px = incoming ? incoming.from.x : tn.x;
        const py = incoming ? incoming.from.y : tn.y;
        sp = { x: px, y: py, r: 0, alpha: 0, target: tn, exiting: false };
        this.sprites.set(tn.id, sp);
      } else {
        sp.target = tn;
        sp.exiting = false;
      }
    }

    const drop = [];
    for (const [id, sp] of this.sprites) {
      if (sp.exiting) {
        sp.r = lerp(sp.r, 0, k);
        sp.alpha = lerp(sp.alpha, 0, k);
        if (sp.alpha < 0.02) drop.push(id);
      } else {
        sp.x = lerp(sp.x, sp.target.x, k);
        sp.y = lerp(sp.y, sp.target.y, k);
        sp.r = lerp(sp.r, sp.target.r, k);
        sp.alpha = lerp(sp.alpha, 1, k);
      }
    }
    for (const id of drop) this.sprites.delete(id);

    const drawNodes = [];
    for (const sp of this.sprites.values()) {
      drawNodes.push({ ...sp.target, x: sp.x, y: sp.y, r: sp.r, alpha: sp.alpha });
    }

    this.drawBackdrop(layout, tt);

    for (const l of layout.links) {
      const fromSp = this.sprites.get(l.from.id);
      const toSp = this.sprites.get(l.to.id);
      if (!fromSp || !toSp) continue;
      const linkAlpha = Math.min(fromSp.alpha, toSp.alpha);
      this.drawLink(
        {
          from: { x: fromSp.x, y: fromSp.y },
          to: { x: toSp.x, y: toSp.y },
          kind: l.kind,
          active: l.active,
          alpha: linkAlpha
        },
        tt
      );
    }

    this.hover = this.pickNode(drawNodes);

    for (const n of drawNodes) this.drawNode(n, tt);

    if (this.hover) this.drawTooltip(this.hover);

    const now = performance.now();
    this.flashes = this.flashes.filter((f) => now - f.ts < 1500);
    for (const f of this.flashes) {
      const age = (now - f.ts) / 1500;
      ctx.beginPath();
      ctx.arc(layout.cx, layout.cy, layout.baseRadius + 30 + age * 80, 0, TWO_PI);
      ctx.strokeStyle = `rgba(255,209,102,${(1 - age) * 0.6})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    requestAnimationFrame(this.frame.bind(this));
  }

  drawBackdrop({ cx, cy }, tt) {
    const ctx = this.ctx;
    const minDim = Math.min(this.w, this.h);
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < 4; i++) {
      const r = minDim * (0.12 + i * 0.09);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TWO_PI);
      ctx.strokeStyle = `rgba(110,224,255,${0.05 + i * 0.012})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.rotate(tt * 0.12);
    ctx.beginPath();
    ctx.setLineDash([4, 10]);
    ctx.arc(0, 0, minDim * 0.42, 0, TWO_PI);
    ctx.strokeStyle = 'rgba(110,224,255,0.18)';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.rotate(-tt * 0.18);
    ctx.beginPath();
    ctx.setLineDash([2, 12]);
    ctx.arc(0, 0, minDim * 0.46, 0, TWO_PI);
    ctx.strokeStyle = 'rgba(110,224,255,0.10)';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawLink(l, tt) {
    const ctx = this.ctx;
    const alpha = l.alpha == null ? 1 : l.alpha;
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(l.from.x, l.from.y);
    const cxL = (l.from.x + l.to.x) / 2;
    const cyL = (l.from.y + l.to.y) / 2;
    ctx.quadraticCurveTo(cxL, cyL, l.to.x, l.to.y);
    let stroke;
    if (l.active) stroke = COLOR.linkActive;
    else if (l.kind === 'agent') stroke = COLOR.linkAgent;
    else if (l.kind === 'shell') stroke = COLOR.linkShell;
    else stroke = COLOR.link;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = l.active ? 1.2 : 0.6;
    ctx.stroke();

    if (l.active) {
      const seed = (l.to.x + l.to.y) * 0.001;
      const p = (tt * 0.5 + seed) % 1;
      const px = l.from.x + (l.to.x - l.from.x) * p;
      const py = l.from.y + (l.to.y - l.from.y) * p;
      ctx.beginPath();
      ctx.arc(px, py, 1.6, 0, TWO_PI);
      ctx.fillStyle = 'rgba(255,209,102,0.95)';
      ctx.fill();
    }
    ctx.restore();
  }

  drawNode(n, tt) {
    const ctx = this.ctx;
    const alpha = n.alpha == null ? 1 : n.alpha;
    if (alpha <= 0.01 || n.r <= 0.5) return;
    const isHover = this.hover && this.hover.id === n.id;
    const isSelected = this.selected && this.selected.id === n.id;
    const dead = n.status === 'dead';
    const active = !dead && (n.status === 'busy' || n.status === 'active' || n.active);
    ctx.save();
    ctx.globalAlpha = dead ? alpha * 0.45 : alpha;

    let color;
    switch (n.kind) {
      case 'core': color = COLOR.core; break;
      case 'instance': color = active ? COLOR.instanceBusy : (n.sourceColor || COLOR.instance); break;
      case 'instanceCenter': color = active ? COLOR.instanceBusy : (n.sourceColor || COLOR.core); break;
      case 'agent': color = dead ? '#6b7280' : COLOR.agent; break;
      case 'shell': color = dead ? '#6b7280' : COLOR.shell; break;
      default: color = '#cfe6ff';
    }

    if (n.kind === 'core' || n.kind === 'instanceCenter' || n.kind === 'instance') {
      const pulse = 0.85 + Math.sin(tt * 1.4) * 0.15;
      const drawR = n.r * (n.kind === 'core' ? pulse : 1);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = (n.kind === 'core' ? 32 : 18) * pulse;
      if (n.kind === 'core') {
        ctx.beginPath();
        ctx.arc(n.x, n.y, drawR, 0, TWO_PI);
        const grd = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
        const rgb = hexToRgb(color);
        grd.addColorStop(0, `rgba(${rgb},0.95)`);
        grd.addColorStop(0.55, `rgba(${rgb},0.4)`);
        grd.addColorStop(1, `rgba(${rgb},0.05)`);
        ctx.fillStyle = grd;
        ctx.fill();
      } else {
        this.drawInstanceRings(n, drawR, color, tt, isHover || isSelected);
      }
      ctx.restore();

      if (n.kind === 'instance' && n.label) {
        const fontSize = Math.max(10, Math.min(14, drawR * 0.18));
        this.drawArcText(n.label, n.x, n.y, drawR + fontSize * 0.7, fontSize, color, alpha);
      }
      if (n.kind === 'instanceCenter' && n.cwdLabel) {
        const fontSize = Math.max(11, Math.min(16, drawR * 0.14));
        this.drawArcText(n.cwdLabel, n.x, n.y, drawR + fontSize * 0.7, fontSize, color, alpha);
      }
      ctx.restore();
      return;
    }

    const phase = phaseOf(n.id);
    const breathe = 1 + Math.sin(tt * 1.0 + phase) * 0.09;
    const drawR = n.r * breathe;
    if (active) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14 * breathe;
    }
    ctx.beginPath();
    ctx.arc(n.x, n.y, drawR, 0, TWO_PI);
    ctx.fillStyle = active ? color : '#0a1024';
    ctx.fill();
    ctx.lineWidth = isHover || isSelected ? 2 : 1;
    ctx.strokeStyle = color;
    ctx.stroke();
    if (active) {
      const p = (tt * 0.7 + phase / TWO_PI) % 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, drawR + p * 12, 0, TWO_PI);
      ctx.strokeStyle = `rgba(255,209,102,${(1 - p) * 0.55})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    if (dead) {
      const k = drawR * 0.5;
      ctx.strokeStyle = isHover ? '#ff8a8a' : 'rgba(180,180,180,0.7)';
      ctx.lineWidth = isHover ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(n.x - k, n.y - k);
      ctx.lineTo(n.x + k, n.y + k);
      ctx.moveTo(n.x + k, n.y - k);
      ctx.lineTo(n.x - k, n.y + k);
      ctx.stroke();
    }

    if (n.kind === 'agent') {
      const raw = n.description || n.type || '';
      const MAX_LABEL = 10;
      const label = raw.length > MAX_LABEL ? raw.slice(0, MAX_LABEL - 1).trimEnd() + '…' : raw;
      if (label) {
        const fontSize = Math.max(8, Math.min(11, drawR * 0.85));
        this.drawArcText(label, n.x, n.y, drawR + fontSize * 0.7, fontSize, color, alpha);
      }
    }
    ctx.restore();
  }

  drawInstanceRings(n, r, color, tt, emphasized) {
    const ctx = this.ctx;
    const cx = n.x;
    const cy = n.y;
    const rgb = hexToRgb(color);
    const memTypeColor = {
      user: '#6ee0ff',
      feedback: '#ffd166',
      project: '#7af1c5',
      reference: '#ce9bff',
      other: '#6b829e'
    };

    const coreR = r * 0.32;
    const memInner = r * 0.40;
    const memOuter = r * 0.62;
    const ctxInner = r * 0.68;
    const ctxOuter = r * 0.96;

    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TWO_PI);
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    grd.addColorStop(0, `rgba(${rgb},0.95)`);
    grd.addColorStop(1, `rgba(${rgb},0.45)`);
    ctx.fillStyle = grd;
    ctx.fill();

    const memFiles = n.memoryFiles || [];
    const memN = memFiles.length;
    if (memN > 0) {
      const seg = TWO_PI / memN;
      const gap = Math.min(seg * 0.18, 0.06);
      const rot = tt * 0.05;
      for (let i = 0; i < memN; i++) {
        const a0 = rot + i * seg + gap / 2;
        const a1 = rot + (i + 1) * seg - gap / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, memOuter, a0, a1);
        ctx.arc(cx, cy, memInner, a1, a0, true);
        ctx.closePath();
        const c = memTypeColor[memFiles[i].type] || memTypeColor.other;
        const mrgb = hexToRgb(c);
        ctx.fillStyle = `rgba(${mrgb},0.78)`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${mrgb},0.95)`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, (memInner + memOuter) / 2, 0, TWO_PI);
      ctx.strokeStyle = `rgba(${rgb},0.18)`;
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const bytes = n.contextBytes || 0;
    const segBytes = 32 * 1024;
    const ctxN = Math.min(64, Math.max(0, Math.ceil(bytes / segBytes)));
    if (ctxN > 0) {
      const seg = TWO_PI / Math.max(ctxN, 12);
      const totalArc = seg * ctxN;
      const gap = Math.min(seg * 0.25, 0.05);
      const rot = -Math.PI / 2 - tt * 0.03;
      for (let i = 0; i < ctxN; i++) {
        const a0 = rot + i * seg + gap / 2;
        const a1 = rot + (i + 1) * seg - gap / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, ctxOuter, a0, a1);
        ctx.arc(cx, cy, ctxInner, a1, a0, true);
        ctx.closePath();
        const t = i / Math.max(1, ctxN - 1);
        const alpha = 0.35 + t * 0.5;
        ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        ctx.fill();
      }
      if (totalArc < TWO_PI - 0.01) {
        ctx.beginPath();
        ctx.arc(cx, cy, (ctxInner + ctxOuter) / 2, rot + totalArc, rot + TWO_PI);
        ctx.strokeStyle = `rgba(${rgb},0.12)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, (ctxInner + ctxOuter) / 2, 0, TWO_PI);
      ctx.strokeStyle = `rgba(${rgb},0.15)`;
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TWO_PI);
    ctx.strokeStyle = `rgba(${rgb},${emphasized ? 0.9 : 0.55})`;
    ctx.lineWidth = emphasized ? 1.6 : 1;
    ctx.stroke();
  }

  drawArcText(text, cx, cy, radius, fontSize, color, alpha) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${fontSize}px Segoe UI`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.globalAlpha = (alpha == null ? 1 : alpha) * 0.95;
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 3;

    const chars = [...text];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const totalArc = widths.reduce((sum, w) => sum + w, 0) / radius;
    const maxArc = Math.PI * 1.4;
    const arc = Math.min(totalArc, maxArc);
    const scale = arc / totalArc;
    const top = -Math.PI / 2;
    let angle = top - arc / 2;
    for (let i = 0; i < chars.length; i++) {
      const step = (widths[i] / radius) * scale;
      const charAngle = angle + step / 2;
      const x = cx + Math.cos(charAngle) * radius;
      const y = cy + Math.sin(charAngle) * radius;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(charAngle + Math.PI / 2);
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
      angle += step;
    }
    ctx.restore();
  }

  drawTooltip(n) {
    const ctx = this.ctx;
    let lines = [];
    if (n.kind === 'instance' || n.kind === 'instanceCenter') {
      lines = [
        `${n.cwd || ''}`,
        `pid ${n.pid} · ${n.status}`,
        `${n.agentCount} agent${n.agentCount === 1 ? '' : 's'} · ${n.shellCount} shell${n.shellCount === 1 ? '' : 's'}`
      ];
    } else if (n.kind === 'agent') {
      lines = [`${n.type}`, n.description || ''];
    } else if (n.kind === 'shell') {
      lines = [`shell ${n.shellId}`, n.preview || ''];
    }
    if (n.status === 'dead') lines.push('· click to dismiss');
    lines = lines.filter(Boolean);
    if (!lines.length) return;
    ctx.font = '11px Segoe UI';
    const padding = 6;
    const widths = lines.map((l) => ctx.measureText(l).width);
    const w = Math.max(...widths) + padding * 2;
    const h = lines.length * 14 + padding * 2;
    let x = n.x + n.r + 8;
    let y = n.y - h / 2;
    if (x + w > this.w) x = n.x - n.r - 8 - w;
    if (y < 4) y = 4;
    if (y + h > this.h - 4) y = this.h - h - 4;
    ctx.fillStyle = 'rgba(5,8,16,0.92)';
    ctx.strokeStyle = 'rgba(110,224,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#cfe6ff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x + padding, y + padding + i * 14));
  }
}
