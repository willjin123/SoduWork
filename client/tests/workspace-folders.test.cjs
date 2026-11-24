'use strict';
// Extra workspace folders (#1327): the native-dialog registry, the policy's
// additionalRoots and the live roots change are the only ways to widen access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = require('./renderer-source.cjs');
const registryModule = require('../main/workspace/folder-registry');
const rules = require('../main/access-control/policy');
const { rootsHandler } = require('../main/access-control/ipc');

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-folders-')));
  const dirs = {};
  for (const name of ['data', 'work', 'extra', 'other', 'root']) {
    dirs[name] = path.join(base, name); fs.mkdirSync(dirs[name]);
  }
  fs.mkdirSync(path.join(dirs.root, 'temp', 'chat-1'), { recursive: true });
  fs.mkdirSync(path.join(dirs.extra, 'nested'));
  let user = 'u1';
  const app = { getPath: () => dirs.data };
  const registry = registryModule.create({ app, identityOf: () => ({ hub: 'http://hub.test', session: 'session-' + user }), workRoot: () => dirs.root });
  return { base, dirs, registry, switchUser: value => { user = value; }, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('only folders registered through the dialog are granted, per account', async () => {
  const s = sandbox();
  try {
    assert.deepEqual(await s.registry.granted([s.dirs.extra]), []);
    assert.equal(await s.registry.register(s.dirs.extra), s.dirs.extra);
    assert.deepEqual(await s.registry.granted([s.dirs.extra, s.dirs.other, path.join(s.base, 'missing')]), [s.dirs.extra]);
    assert.deepEqual((await s.registry.list()).map(row => row.dir), [s.dirs.extra]);
    s.switchUser('u2');
    assert.deepEqual(await s.registry.granted([s.dirs.extra]), [], 'another account does not inherit grants');
    assert.deepEqual(await s.registry.list(), []);
  } finally { s.done(); }
});

test('scratch folders are never registered and hidden folders leave the recent list', async () => {
  const s = sandbox();
  try {
    assert.equal(await s.registry.register(path.join(s.dirs.root, 'temp', 'chat-1')), '');
    await s.registry.register(s.dirs.work); await s.registry.register(s.dirs.extra);
    assert.equal(await s.registry.hide(s.dirs.work), true);
    assert.deepEqual((await s.registry.list()).map(row => row.dir), [s.dirs.extra]);
    assert.deepEqual(await s.registry.granted([s.dirs.work]), [s.dirs.work], 'hiding a recent entry keeps its grant');
    const status = await s.registry.status([s.dirs.extra, s.dirs.other, '\\\\server\\share']);
    assert.deepEqual(status.map(row => [row.exists, row.granted, row.network]), [[true, true, false], [true, false, false], [false, false, true]]);
  } finally { s.done(); }
});

test('session folders keep only granted folders and automations use the bound project', async () => {
  const s = sandbox();
  try {
    await s.registry.register(s.dirs.work); await s.registry.register(s.dirs.extra);
    assert.deepEqual(await s.registry.setSessionFolders('chat-1', [s.dirs.extra, s.dirs.other]), [s.dirs.extra]);
    assert.deepEqual(await s.registry.sessionFolders('chat-1'), [s.dirs.extra]);
    await s.registry.setAutomation('sch-1', { id: 'p1', name: 'P', folders: [s.dirs.work, s.dirs.extra, s.dirs.other] });
    const applied = await s.registry.applyAutomation('sch-1', { cwd: '' });
    assert.equal(applied.cwd, s.dirs.work, 'an automation without a folder uses the project default');
    assert.deepEqual(applied.additionalRoots, [s.dirs.extra], 'unregistered project folders are not granted');
    assert.deepEqual((await s.registry.applyAutomation('sch-1', { cwd: s.dirs.extra })).additionalRoots, [s.dirs.work]);
    assert.equal(await s.registry.refreshAutomations([{ id: 'p1', name: 'P2', folders: [s.dirs.work] }]), true);
    assert.deepEqual((await s.registry.applyAutomation('sch-1', { cwd: '' })).additionalRoots, []);
    await s.registry.refreshAutomations([]);
    assert.deepEqual(await s.registry.applyAutomation('sch-1', { cwd: 'X' }), { cwd: 'X' }, 'a deleted project grants nothing');
    assert.deepEqual(await s.registry.applyAutomation('', { cwd: 'Y' }), { cwd: 'Y' });
  } finally { s.done(); }
});

test('policy additionalRoots drop nested, duplicate, missing and workspace folders', () => {
  const s = sandbox();
  try {
    const nested = path.join(s.dirs.extra, 'nested');
    const roots = rules.additionalRoots([nested, s.dirs.extra, s.dirs.extra, path.join(s.dirs.work, 'x'), 'relative', path.join(s.base, 'gone'), s.dirs.other], s.dirs.work);
    assert.deepEqual(roots, [s.dirs.extra, s.dirs.other]);
    const plain = rules.create('standard', s.dirs.work);
    assert.equal(Object.hasOwn(plain, 'additionalRoots'), false, 'no extra folders keeps the original policy shape');
    const widened = rules.next('standard', s.dirs.work, plain, plain.revision, [s.dirs.extra]);
    assert.deepEqual(widened.additionalRoots, [s.dirs.extra]);
    assert.equal(widened.revision, plain.revision + 1);
    assert.equal(rules.withinRoots(widened, path.join(s.dirs.extra, 'a.md')), true);
    assert.equal(rules.withinRoots(widened, path.join(s.dirs.other, 'a.md')), false);
    assert.equal(rules.withinRoots(widened, path.join(s.dirs.work, 'a.md')), true);
    // A later change keeps the roots unless it replaces them.
    assert.deepEqual(rules.next('readonly', s.dirs.work, widened, widened.revision).additionalRoots, [s.dirs.extra]);
  } finally { s.done(); }
});

test('a saved policy whose folder is gone reopens in the fallback folder; an existing folder still must match', () => {
  const s = sandbox();
  try {
    const gone = path.join(s.base, 'gone');
    fs.mkdirSync(gone);
    const saved = rules.create('standard', gone, [s.dirs.extra]);
    fs.rmSync(gone, { recursive: true });
    const restored = rules.restoreState(saved, null, s.dirs.work);
    assert.equal(restored.accessPolicy.workspaceRoot, s.dirs.work);
    assert.equal(restored.accessPolicy.mode, 'standard');
    assert.deepEqual(restored.accessPolicy.additionalRoots, [s.dirs.extra]);
    const existing = rules.create('standard', s.dirs.other);
    assert.throws(() => rules.restoreState(existing, null, s.dirs.work), /workspace mismatch/);
  } finally { s.done(); }
});

test('Pi file tools treat extra folders like the workspace, with the same protections', () => {
  const s = sandbox();
  try {
    const policy = rules.create('standard', s.dirs.work, [s.dirs.extra]);
    assert.equal(rules.operation(policy, 'write', { path: path.join(s.dirs.extra, 'a.md') }).verdict, 'allow');
    assert.equal(rules.operation(policy, 'read', { path: path.join(s.dirs.extra, 'nested') }).verdict, 'allow');
    assert.equal(rules.operation(policy, 'write', { path: path.join(s.dirs.extra, '.git', 'config') }).verdict, 'ask');
    assert.equal(rules.operation(policy, 'write', { path: path.join(s.dirs.other, 'a.md') }).verdict, 'ask');
    const readonly = rules.create('readonly', s.dirs.work, [s.dirs.extra]);
    assert.equal(rules.operation(readonly, 'read', { path: path.join(s.dirs.extra, 'a.md') }).verdict, 'allow');
    assert.equal(rules.operation(readonly, 'write', { path: path.join(s.dirs.extra, 'a.md') }).verdict, 'deny');
  } finally { s.done(); }
});

function liveSession(policy, { supported = true } = {}) {
  const webContents = { id: 7 };
  const handle = {
    cwd: policy.workspaceRoot, attachedWindow: { webContents }, applied: [],
    snapshot: () => ({ accessPolicy: handle.policy, accessControl: { supported, canChangeDuringSession: supported } }),
    policy,
    async setAccessPolicy(next) { handle.applied.push(next); handle.policy = next; return { ok: true }; },
  };
  return { handle, event: { sender: webContents }, session: { get: ref => ref === 'r1' ? handle : null } };
}

test('roots handler widens only to granted folders and only for the owning window', async () => {
  const s = sandbox();
  try {
    await s.registry.register(s.dirs.extra);
    const live = liveSession(rules.create('standard', s.dirs.work));
    const handler = rootsHandler({ session: live.session, registry: s.registry });
    assert.equal((await handler({ sender: { id: 8 } }, 'r1', [s.dirs.extra], 1)).ok, false, 'other windows are refused');
    const result = await handler(live.event, 'r1', [s.dirs.extra, s.dirs.other], live.handle.policy.revision);
    assert.equal(result.ok, true);
    assert.deepEqual(result.additionalRoots, [s.dirs.extra]);
    assert.deepEqual(live.handle.applied.at(-1).additionalRoots, [s.dirs.extra]);
    assert.equal((await handler(live.event, 'r1', [s.dirs.extra], live.handle.policy.revision)).unchanged, true);
    const removed = await handler(live.event, 'r1', [], live.handle.policy.revision);
    assert.equal(removed.ok, true);
    assert.equal(Object.hasOwn(live.handle.applied.at(-1), 'additionalRoots'), false);
    const legacy = liveSession(rules.create('standard', s.dirs.work), { supported: false });
    const refused = await rootsHandler({ session: legacy.session, registry: s.registry })(legacy.event, 'r1', [s.dirs.extra], 1);
    assert.equal(refused.unsupported, true);
  } finally { s.done(); }
});

function location() {
  const window = { addEventListener() {} };
  vm.runInContext(source.readFileSync(path.join(__dirname, '..', 'components/panels/work-composer.js'), 'utf8'),
    vm.createContext({ window, innerWidth: 1000, innerHeight: 800 }));
  return window.WorkComposer.workspaceLocation;
}

test('chip counts extra folders and lists them in the tooltip', () => {
  const where = location()({ dir: 'D:\\work\\web', extraFolders: ['D:\\work\\api', 'd:/work/web', 'E:\\docs'] });
  assert.equal(where.extraCount, 2, 'the working folder is not counted twice');
  assert.match(where.tooltip, /附加文件夹：D:\\work\\api\n附加文件夹：E:\\docs$/);
  assert.equal(location()({ dir: 'D:\\work\\web' }).extraCount, 0);
});

test('an unavailable working folder falls back to the default workspace with a warning', () => {
  const where = location()({ dir: 'C:\\root\\temp\\chat-1', unavailable: 'D:\\gone', defaultWorkspace: true });
  assert.deepEqual([where.kind, where.label, where.warning, where.user], ['unavailable', '默认工作区', true, false]);
  assert.match(where.tooltip, /^工作文件夹不可用：D:\\gone\n本轮在默认工作区执行：C:\\root\\temp\\chat-1$/);
  assert.equal(location()({ dir: 'X', remoteLabel: '云端成果', unavailable: 'D:\\gone' }).kind, 'cloud');
});
