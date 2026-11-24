'use strict';
// Conversation workspace label rules (#1327): every entry point describes the
// working folder the same way, and only a folder owned by the project shows it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function load(extra = {}) {
  const window = { addEventListener() {}, ...extra };
  vm.runInContext(read('components/panels/work-composer.js'), vm.createContext({ window, innerWidth: 1000, innerHeight: 800 }));
  return window.WorkComposer.workspaceLocation;
}
const project = { id: 'p1', name: '前端项目', folders: ['D:\\work\\web', 'D:\\work\\api'] };

test('a draft without a folder shows the default workspace', () => {
  const location = load()({ dir: '' });
  assert.equal(location.kind, 'pending');
  assert.equal(location.label, '默认工作区');
  assert.equal(location.user, false);
});

test('a scratch or default folder shows the default workspace and its path', () => {
  const location = load()({ dir: 'C:\\SoduWork\\temp\\chat-1', defaultWorkspace: true });
  assert.deepEqual([location.kind, location.label, location.tooltip], ['default', '默认工作区', 'C:\\SoduWork\\temp\\chat-1']);
});

test('a chosen folder without a project shows the folder name and the full path', () => {
  const location = load()({ dir: 'D:\\notes\\' });
  assert.deepEqual([location.kind, location.icon, location.label, location.tooltip, location.user],
    ['folder', 'folder', 'notes', 'D:\\notes\\', true]);
  assert.equal(load()({ dir: '/home/me/notes' }).label, 'notes');
  assert.equal(load()({ dir: 'C:\\' }).label, 'C:', 'a drive root still has a visible label');
});

test('a working folder owned by the project shows the project', () => {
  for (const dir of ['D:\\work\\web', 'd:/work/web/', 'D:\\Work\\Web']) {
    const location = load()({ dir, project });
    assert.deepEqual([location.kind, location.icon, location.label], ['project', 'project', '前端项目'], dir);
    assert.equal(location.tooltip, '前端项目\n工作文件夹：' + dir);
  }
});

test('a working folder outside the project shows the folder and names the project', () => {
  const location = load()({ dir: 'D:\\notes', project });
  assert.deepEqual([location.kind, location.label], ['folder', 'notes']);
  assert.equal(location.tooltip, 'D:\\notes\n所属项目：前端项目（工作文件夹不在项目中）');
  const scratch = load()({ dir: 'C:\\SoduWork\\temp\\chat-2', defaultWorkspace: true, project: { ...project, folders: [] } });
  assert.equal(scratch.label, '默认工作区', 'a project without folders on this device keeps the default workspace');
  assert.match(scratch.tooltip, /所属项目：前端项目/);
});

test('POSIX paths compare exactly', () => {
  const posix = { name: 'P', folders: ['/srv/App'] };
  assert.equal(load()({ dir: '/srv/App', project: posix }).kind, 'project');
  assert.equal(load()({ dir: '/srv/app', project: posix }).kind, 'folder');
});

test('cloud results keep their remote label and never use project names', () => {
  const location = load()({ dir: 'C:\\cache\\private-hash', remoteLabel: '云端成果', project });
  assert.deepEqual([location.kind, location.icon, location.label, location.tooltip], ['cloud', 'cloud', '云端成果', 'C:\\cache\\private-hash']);
});

test('tooltip phrases go through the localization catalog', () => {
  const t = (key, fallback, params) => ({ '工作文件夹：{value1}': 'Working folder: {value1}' }[key] || fallback)
    .replace(/\{(\w+)\}/g, (all, name) => params?.[name] ?? all);
  const location = load({ SoduWorkI18n: { t } })({ dir: 'D:\\work\\web', project });
  assert.equal(location.tooltip, '前端项目\nWorking folder: D:\\work\\web');
});

test('the project icon is distinct from the folder icon', () => {
  const window = { addEventListener() {} };
  vm.runInContext(read('components/panels/work-composer.js'), vm.createContext({ window, innerWidth: 1000, innerHeight: 800 }));
  const { icons } = window.WorkComposer;
  assert.ok(icons.project && icons.cloud);
  assert.notEqual(icons.project, icons.folder);
});
