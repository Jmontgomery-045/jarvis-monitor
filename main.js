const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fsp = require('node:fs/promises');
const { startWatcher, getState, on } = require('./watcher');
const { loadConfig } = require('./config');

const config = loadConfig();

let lastUsage = null;

async function readUsage() {
  if (!config.usageCachePath) return null;
  try {
    const txt = await fsp.readFile(config.usageCachePath, 'utf8');
    const data = JSON.parse(txt.replace(/^﻿/, ''));
    return {
      personal: { value: data.personal_raw, fetchedAt: data.personal_fetched_at, backoffUntil: data.personal_backoff_until },
      work: { value: data.work_raw, fetchedAt: data.work_fetched_at, backoffUntil: data.work_backoff_until }
    };
  } catch {
    return null;
  }
}

const HOOK_PORT = Number(process.env.JARVIS_HOOK_PORT || config.hookPort || 7373);
let win;

app.setAppUserModelId('com.jarvis.monitor');

const dataFile = () => path.join(app.getPath('userData'), 'boards.json');
const notesDir = () => path.join(app.getPath('userData'), 'notes');
const notesIndexFile = () => path.join(app.getPath('userData'), 'notes-index.json');
const NOTE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const noteFile = (id) => path.join(notesDir(), `${id}.txt`);

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 280,
    minHeight: 320,
    title: 'JARVIS Monitor',
    frame: false,
    transparent: false,
    backgroundMaterial: 'mica',
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (process.env.JARVIS_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startHookServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/hook') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try {
          const ev = JSON.parse(body || '{}');
          ev.ts = Date.now();
          getState().pushHookEvent(ev);
          broadcast('hook:event', ev);
          res.writeHead(204);
          res.end();
        } catch (e) {
          res.writeHead(400);
          res.end(String(e));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(HOOK_PORT, '127.0.0.1', () => {
    console.log(`[jarvis] hook endpoint http://127.0.0.1:${HOOK_PORT}/hook`);
  });
}

app.whenReady().then(async () => {
  ipcMain.handle('state:get', () => getState().snapshot());
  ipcMain.handle('usage:get', () => lastUsage);
  ipcMain.on('window:close', () => win && win.close());
  ipcMain.on('window:minimize', () => win && win.minimize());
  on('change', (snapshot) => broadcast('state:full', snapshot));

  ipcMain.handle('data:load', async () => {
    try {
      const txt = await fsp.readFile(dataFile(), 'utf8');
      return JSON.parse(txt);
    } catch {
      return { groups: [] };
    }
  });

  ipcMain.handle('data:save', async (_e, data) => {
    try {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'Invalid payload: expected a non-null object' };
      }
      const dest = dataFile();
      const tmp = dest + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, dest);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('notes:loadIndex', async () => {
    try {
      const txt = await fsp.readFile(notesIndexFile(), 'utf8');
      return JSON.parse(txt);
    } catch {
      return { groups: [] };
    }
  });

  ipcMain.handle('notes:saveIndex', async (_e, data) => {
    try {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'Invalid payload' };
      }
      const dest = notesIndexFile();
      const tmp = dest + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, dest);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('notes:read', async (_e, id) => {
    if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) return '';
    try { return await fsp.readFile(noteFile(id), 'utf8'); }
    catch { return ''; }
  });

  ipcMain.handle('notes:write', async (_e, id, body) => {
    if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) return { ok: false, error: 'Invalid id' };
    try {
      await fsp.mkdir(notesDir(), { recursive: true });
      const dest = noteFile(id);
      const tmp = dest + '.tmp';
      await fsp.writeFile(tmp, typeof body === 'string' ? body : '', 'utf8');
      await fsp.rename(tmp, dest);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('notes:delete', async (_e, id) => {
    if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) return { ok: false };
    try { await fsp.unlink(noteFile(id)); } catch {}
    return { ok: true };
  });

  createWindow();
  startHookServer();
  startWatcher(config);

  const tick = async () => {
    const next = await readUsage();
    if (JSON.stringify(next) !== JSON.stringify(lastUsage)) {
      lastUsage = next;
      broadcast('usage:update', lastUsage);
    }
  };
  await tick();
  setInterval(tick, 30000);
});

app.on('window-all-closed', () => app.quit());
