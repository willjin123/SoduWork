'use strict';
/*
 * Folders the user chose through a native dialog, per Hub address and account.
 * This list backs "recent folders" and is the only source for extra folders a
 * conversation may access: renderer paths that are not registered here are
 * never granted. Each conversation's manually added folders are kept here too.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isTrusted } = require('./recent-workspace');

const SCHEMA = 1;
const MAX_FOLDERS = 200;
const MAX_SESSION_FOLDERS = 10;
const file = app => path.join(app.getPath('userData'), 'workspace-folders.json');

function accountKey(identity) {
  const account = require('../device-auth-request').accountScopeKey(identity);
  const hub = String(identity?.hub || '');
  if (!account || !hub) return '';
  return crypto.createHash('sha256').update(hub + '\n' + account).digest('hex');
}
// Windows paths compare without case; the stored spelling is the first one chosen.
const key = dir => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
function directory(dir) {
  const value = typeof dir === 'string' ? dir.trim() : '';
  if (!value || value.length > 1024 || !path.isAbsolute(value) || value.includes('\0')) return '';
  try { return fs.statSync(value).isDirectory() ? path.resolve(value) : ''; } catch { return ''; }
}
function read(app) {
  try {
    const value = JSON.parse(fs.readFileSync(file(app), 'utf8'));
    if (value?.schema === SCHEMA && value.accounts && typeof value.accounts === 'object') return value;
  } catch { /* A missing or damaged file starts empty. */ }
  return { schema: SCHEMA, accounts: {} };
}
function write(app, value) {
  const destination = file(app), temporary = destination + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function account(store, identity) {
  const id = accountKey(identity);
  if (!id) return null;
  const entry = store.accounts[id] ||= { folders: [], sessions: {} };
  entry.folders = Array.isArray(entry.folders) ? entry.folders.filter(row => row && typeof row.dir === 'string') : [];
  entry.sessions = entry.sessions && typeof entry.sessions === 'object' ? entry.sessions : {};
  return entry;
}
function create({ app, identityOf, workRoot = () => '' }) {
  const identity = () => Promise.resolve(identityOf(app));
  // Scratch folders under the work root are per-conversation, never reusable choices.
  function scratch(dir) {
    const root = workRoot();
    if (!root) return false;
    const base = key(root), target = key(dir);
    return target === base || target.startsWith(key(path.join(root, 'temp')) + path.sep);
  }
  async function register(dir, name) {
    const resolved = directory(dir);
    if (!resolved || scratch(resolved)) return '';
    const store = read(app), entry = account(store, await identity());
    if (!entry) return '';
    const existing = entry.folders.find(row => key(row.dir) === key(resolved));
    if (existing) Object.assign(existing, { usedAt: Date.now(), hidden: false });
    else entry.folders.push({ dir: resolved, name: String(name || path.basename(resolved) || resolved).slice(0, 200), usedAt: Date.now() });
    entry.folders.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
    entry.folders = entry.folders.slice(0, MAX_FOLDERS);
    write(app, store);
    return existing?.dir || resolved;
  }
  async function touch(dir) {
    const resolved = directory(dir);
    if (!resolved) return false;
    const store = read(app), entry = account(store, await identity());
    const existing = entry?.folders.find(row => key(row.dir) === key(resolved));
    if (!existing) return false;
    existing.usedAt = Date.now();
    write(app, store);
    return true;
  }
  async function list(limit = 5) {
    let entry = account(read(app), await identity());
    if (!entry) return [];
    if (!entry.folders.length && !entry.migrated) {
      // The earlier single "last selected" folder was also chosen through the native dialog.
      const previous = require('./recent-workspace').snapshot(app);
      const store = read(app), current = account(store, await identity());
      current.migrated = true; write(app, store);
      if (previous?.dir) await register(previous.dir, previous.name);
      entry = account(read(app), await identity());
    }
    return entry.folders.filter(row => !row.hidden && directory(row.dir) && !scratch(row.dir))
      .sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0)).slice(0, Math.max(0, Math.min(20, limit)))
      .map(row => ({ dir: row.dir, name: row.name || path.basename(row.dir) }));
  }
  async function hide(dir) {
    const store = read(app), entry = account(store, await identity());
    const existing = entry?.folders.find(row => typeof dir === 'string' && key(row.dir) === key(dir));
    if (!existing) return false;
    existing.hidden = true;
    write(app, store);
    return true;
  }
  // The subset of dirs that exist and were chosen by this account through a native dialog.
  async function granted(dirs) {
    const entry = account(read(app), await identity());
    if (!entry) return [];
    const known = new Map(entry.folders.map(row => [key(row.dir), row.dir]));
    const result = [];
    for (const dir of Array.isArray(dirs) ? dirs.slice(0, 50) : []) {
      const resolved = directory(dir);
      if (resolved && known.has(key(resolved)) && !result.some(item => key(item) === key(resolved))) result.push(resolved);
    }
    return result;
  }
  async function status(dirs) {
    const allowed = new Set((await granted(dirs)).map(key));
    return (Array.isArray(dirs) ? dirs.slice(0, 50) : []).map(dir => {
      const resolved = directory(dir);
      return { dir: String(dir || ''), exists: !!resolved, granted: !!resolved && allowed.has(key(resolved)),
        network: /^\\\\|^\/\//.test(String(dir || '')) };
    });
  }
  async function sessionFolders(sessionId) {
    const id = String(sessionId || '');
    const entry = account(read(app), await identity());
    return id && entry ? (Array.isArray(entry.sessions[id]) ? entry.sessions[id].slice() : []) : [];
  }
  async function setSessionFolders(sessionId, dirs) {
    const id = String(sessionId || '').slice(0, 200);
    if (!id) return [];
    const allowed = (await granted(dirs)).slice(0, MAX_SESSION_FOLDERS);
    const store = read(app), entry = account(store, await identity());
    if (!entry) return [];
    if (allowed.length) entry.sessions[id] = allowed; else delete entry.sessions[id];
    write(app, store);
    return allowed;
  }
  /*
   * Automations bound to a sidebar project: schedule id -> the project's current folders.
   * Projects live in the renderer, which refreshes these folders whenever projects change,
   * so unattended runs here use the latest folders without reading renderer storage.
   */
  const cleanFolders = list => (Array.isArray(list) ? list : []).filter(dir => typeof dir === 'string' && path.isAbsolute(dir)).slice(0, MAX_SESSION_FOLDERS + 1);
  async function automation(scheduleId) {
    const entry = account(read(app), await identity());
    const row = entry?.automations?.[String(scheduleId || '')];
    return row && typeof row === 'object' ? { projectId: String(row.projectId || ''), name: String(row.name || ''), folders: cleanFolders(row.folders) } : null;
  }
  async function setAutomation(scheduleId, project) {
    const id = String(scheduleId || '').slice(0, 200);
    if (!id) return false;
    const store = read(app), entry = account(store, await identity());
    if (!entry) return false;
    entry.automations = entry.automations && typeof entry.automations === 'object' ? entry.automations : {};
    if (project && project.id) entry.automations[id] = { projectId: String(project.id).slice(0, 200), name: String(project.name || '').slice(0, 200), folders: cleanFolders(project.folders) };
    else delete entry.automations[id];
    write(app, store);
    return true;
  }
  async function refreshAutomations(projects) {
    const store = read(app), entry = account(store, await identity());
    if (!entry?.automations) return false;
    const byId = new Map((Array.isArray(projects) ? projects : []).filter(item => item && item.id).map(item => [String(item.id), item]));
    let changed = false;
    for (const row of Object.values(entry.automations)) {
      const project = byId.get(row.projectId);
      // A removed project leaves its automation without folders rather than with stale access.
      const folders = project ? cleanFolders(project.folders) : [];
      if (JSON.stringify(folders) !== JSON.stringify(row.folders || []) || (project && project.name !== row.name)) {
        row.folders = folders; if (project) row.name = String(project.name || ''); changed = true;
      }
    }
    if (changed) write(app, store);
    return changed;
  }
  // Applies a bound project to an automation's open options: its default folder when the
  // automation has none, and the other registered folders as extra roots.
  async function applyAutomation(scheduleId, options) {
    const bound = scheduleId ? await automation(scheduleId) : null;
    if (!bound || !bound.folders.length) return options;
    const cwd = String(options.cwd || '').trim() || (directory(bound.folders[0]) ? bound.folders[0] : '');
    const roots = await granted(bound.folders.filter(dir => !cwd || key(dir) !== key(cwd)));
    return { ...options, cwd, additionalRoots: roots };
  }
  return { register, touch, list, hide, granted, status, sessionFolders, setSessionFolders, scratch,
    automation, setAutomation, refreshAutomations, applyAutomation };
}

function install({ app, ipcMain, dialog, BrowserWindow, shell, registry }) {
  const trusted = handler => async (event, ...args) => isTrusted(event) ? handler(event, ...args) : { ok: false, reason: '请在 SoduWork 工作区中操作' };
  ipcMain.handle('workspace-folders-list', trusted(async (_event, options) => ({ ok: true, folders: await registry.list(Number(options?.limit) || 5) })));
  ipcMain.handle('workspace-folders-hide', trusted(async (_event, dir) => ({ ok: await registry.hide(dir) })));
  ipcMain.handle('workspace-folders-status', trusted(async (_event, dirs) => ({ ok: true, folders: await registry.status(dirs) })));
  ipcMain.handle('workspace-folders-session', trusted(async (_event, sessionId) => ({ ok: true, folders: await registry.sessionFolders(sessionId) })));
  ipcMain.handle('workspace-folders-session-set', trusted(async (_event, sessionId, dirs) =>
    ({ ok: true, folders: await registry.setSessionFolders(sessionId, dirs) })));
  // Folders saved in projects before this registry existed need one explicit, native confirmation.
  ipcMain.handle('workspace-folders-confirm', trusted(async (event, dirs, label) => {
    const known = new Set((await registry.granted(dirs)).map(key));
    const pending = (Array.isArray(dirs) ? dirs.slice(0, 20) : []).map(directory).filter(dir => dir && !known.has(key(dir)) && !registry.scratch(dir));
    if (!pending.length) return { ok: true, folders: await registry.granted(dirs) };
    const win = BrowserWindow.fromWebContents(event.sender);
    const locale = require('../native-locale.cjs');
    const answer = await dialog.showMessageBox(win, locale.dialogOptions({
      type: 'question', buttons: ['允许', '取消'], defaultId: 0, cancelId: 1, noLink: true,
      title: '允许访问文件夹', message: '允许 SoduWork 会话访问这些文件夹吗？',
      detail: (label ? String(label).slice(0, 80) + '\n\n' : '') + pending.join('\n') +
        '\n\n允许后，Agent 可以按当前权限读写这些文件夹。',
    }));
    if (answer.response !== 0) return { ok: false, cancelled: true, folders: await registry.granted(dirs) };
    for (const dir of pending) await registry.register(dir);
    return { ok: true, folders: await registry.granted(dirs) };
  }));
  ipcMain.handle('workspace-folders-automation', trusted(async (_event, scheduleId) => ({ ok: true, binding: await registry.automation(scheduleId) })));
  ipcMain.handle('workspace-folders-automation-set', trusted(async (_event, scheduleId, project) => ({ ok: await registry.setAutomation(scheduleId, project) })));
  ipcMain.handle('workspace-folders-automation-refresh', trusted(async (_event, projects) => ({ ok: true, changed: await registry.refreshAutomations(projects) })));
  // Opens only the conversation's own registered folders, never an arbitrary renderer path.
  ipcMain.handle('workspace-folders-open', trusted(async (_event, dir) => {
    const [allowed] = await registry.granted([dir]);
    if (!allowed) return { ok: false, reason: '这个文件夹不可用或未授权' };
    const error = await shell.openPath(allowed);
    return error ? { ok: false, reason: error } : { ok: true };
  }));
}

module.exports = { create, install, accountKey, MAX_SESSION_FOLDERS };
