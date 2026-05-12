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

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const size = Math.min(900, Math.floor(Math.min(width, height) * 0.75));

  win = new BrowserWindow({
    width: size,
    height: size,
    minWidth: 480,
    minHeight: 480,
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
