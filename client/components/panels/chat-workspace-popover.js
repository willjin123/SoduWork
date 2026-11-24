/*
 * Working-location popover for an open conversation (#1327). It shows what the
 * conversation can access and where it belongs. The working folder is fixed; extra
 * folders and project membership change only through the main process and the
 * sidebar, and take effect from the next turn. No toast: the popover repaints.
 */
(function (global) {
  'use strict';
  let pop = null, anchor = null, seq = 0;
  // Windows paths compare without case or separator differences; other platforms compare exactly.
  const key = value => {
    const text = String(value || '').trim().replace(/[\\/]+$/, '');
    return /^[a-z]:|^\\\\/i.test(text) ? text.replace(/\//g, '\\').toLowerCase() : text;
  };
  const nameOf = dir => String(dir || '').split(/[\\/]/).filter(Boolean).pop() || String(dir || '');
  const api = () => global.soduWorkAPI && (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession);
  const folders = () => global.soduWorkAPI?.workspaceFolders;
  const say = message => { if (typeof global.petSay === 'function') global.petSay(message); };
  const icon = name => global.WorkComposer?.icons?.[name] || global.WorkComposer?.icons?.folder || '';
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function action(label, run, { disabled = false, title = '' } = {}) {
    const button = el('button', 'cwp-action', label);
    button.type = 'button'; button.disabled = disabled;
    if (title) button.title = title;
    button.addEventListener('click', async event => {
      event.stopPropagation();
      button.disabled = true;
      try { await run(); } catch (error) { say(String(error?.message || error || '操作没成功，请重试')); }
      finally { if (button.isConnected) button.disabled = disabled; }
    });
    return button;
  }
  function folderRow(dir, tags, actions) {
    const row = el('div', 'cwp-folder');
    row.innerHTML = icon('folder');
    const copy = el('div', 'cwp-copy');
    const name = el('b', '', nameOf(dir)); name.setAttribute('data-user-content', '');
    const path = el('small', '', dir); path.setAttribute('data-user-content', '');
    const line = el('div', 'cwp-line'); line.appendChild(name);
    for (const tag of tags.filter(Boolean)) line.appendChild(el('span', 'cwp-tag' + (tag.warn ? ' is-warn' : ''), tag.text));
    copy.append(line, path);
    row.title = dir;
    row.append(copy, ...actions);
    return row;
  }
  async function pickFolder(defaultPath, purpose) {
    const bridge = api();
    if (!bridge?.pickCwd) throw Error('请在桌面客户端选择文件夹');
    const result = await bridge.pickCwd({ ...(defaultPath ? { defaultPath } : {}), purpose });
    if (result?.ok && result.dir) return result.dir;
    if (!result?.canceled) throw Error(result?.reason || '未能选择文件夹，请重试');
    return '';
  }
  async function openFolder(dir, own) {
    if (own) {
      const bridge = api(), info = global.NativeChat?.workspaceInfo?.() || {};
      if (bridge && info.ref && typeof bridge.openSessionWorkdir === 'function') return bridge.openSessionWorkdir(info.ref);
      return bridge?.openWorkdir?.();
    }
    const reply = await folders()?.open?.(dir);
    if (reply && reply.ok === false) throw Error(reply.reason || '这个文件夹暂时打不开');
    return reply;
  }
  async function render() {
    if (!pop) return;
    const info = global.NativeChat?.workspaceInfo?.() || {};
    const current = ++seq;
    const listed = [info.dir, ...(info.extras || [])].filter(Boolean);
    let status = [];
    try { status = (await folders()?.status?.(listed))?.folders || []; } catch (_) {}
    if (current !== seq || !pop) return;
    const exists = new Map(status.map(item => [key(item.dir), item.exists]));
    const missing = dir => exists.get(key(dir)) === false ? { text: '已不存在', warn: true } : null;
    const applied = new Set((info.policyRoots || []).map(key));
    const granted = new Map(status.map(item => [key(item.dir), item.granted]));
    // A folder not yet in the policy joins it before the next turn.
    const pending = dir => info.rootsSupported && !applied.has(key(dir)) ? { text: '下一轮生效' } : null;
    const unconfirmed = dir => exists.get(key(dir)) && granted.get(key(dir)) === false ? { text: '待确认' } : null;
    const nodes = [];
    nodes.push(el('div', 'wc-pop-title', '本会话可访问'));
    if (info.remote) {
      nodes.push(folderRow(info.dir || '', [{ text: '本机缓存' }], info.dir ? [action('打开', () => openFolder(info.dir, true))] : []));
      nodes.push(el('p', 'cwp-note', '云端执行的会话不能添加附加文件夹。'));
    } else if (!info.dir) {
      nodes.push(el('p', 'cwp-note', '发送后会在工作根目录下创建本会话专用的文件夹。'));
    } else {
      const ownTag = info.unavailable ? { text: '原文件夹不可用，本轮在默认工作区执行', warn: true }
        : info.defaultWorkspace ? { text: '默认工作区 · 本会话专用' } : { text: '工作文件夹 · 固定' };
      nodes.push(folderRow(info.dir, [ownTag], [action('打开', () => openFolder(info.dir, true))]));
      const project = info.project, manual = new Set((info.manual || []).map(key));
      for (const dir of info.extras || []) {
        const own = manual.has(key(dir));
        const tags = [{ text: own ? '手动添加' : '项目文件夹' }, missing(dir) || unconfirmed(dir) || pending(dir)];
        const actions = [action('打开', async () => {
          // Project folders saved before the registry need one native confirmation first.
          if (granted.get(key(dir)) === false) {
            const answer = await folders()?.confirm?.([dir], info.project?.name || '');
            if (!answer?.ok) return;
          }
          await openFolder(dir, false);
          await render();
        }, { disabled: exists.get(key(dir)) === false })];
        if (own) actions.push(action('移除', async () => {
          await folders()?.setSession?.(info.sessionId, (info.manual || []).filter(item => key(item) !== key(dir)));
          global.NativeChat?.reloadWorkspaceFolders?.();
          await render();
        }));
        nodes.push(folderRow(dir, tags, actions));
      }
      if (!info.rootsSupported) {
        nodes.push(el('p', 'cwp-note', '此 Agent 只使用工作文件夹，访问其他位置时会逐次询问。'));
      } else if (info.readonly) {
        nodes.push(el('p', 'cwp-note', '只读会话：以上文件夹只能读取。'));
      }
      const full = (info.manual || []).length >= 10;
      nodes.push(action('＋ 添加文件夹', async () => {
        const dir = await pickFolder(info.dir, 'extra');
        if (!dir) return;
        const reply = await folders()?.setSession?.(info.sessionId, [...(info.manual || []), dir]);
        if (!reply?.ok) throw Error('文件夹没有添加成功，请重试');
        global.NativeChat?.reloadWorkspaceFolders?.();
        await render();
      }, { disabled: !info.sessionId || !info.rootsSupported || full,
        title: !info.sessionId ? '发送第一条消息后可添加文件夹' : full ? '最多添加 10 个文件夹' : '' }));
      nodes.at(-1).classList.add('cwp-add');
    }
    nodes.push(el('div', 'wc-pop-title cwp-section', '所属项目'));
    const shell = global.WorkspaceShell;
    if (info.project) {
      const head = el('div', 'cwp-project');
      head.innerHTML = icon('project');
      const name = el('b', '', info.project.name); name.setAttribute('data-user-content', '');
      head.appendChild(name);
      if (info.sessionId) head.append(action('更换', () => { close(); shell?.openMoveMenu?.(info.sessionId); }),
        action('移出', async () => { shell?.moveChat?.(info.sessionId, 'recent'); await render(); }));
      nodes.push(head);
      if (info.dir && !(info.project.folders || []).some(dir => key(dir) === key(info.dir)) && !info.remote) {
        nodes.push(el('p', 'cwp-note', 'ⓘ 本会话的工作文件夹不在这个项目里。'));
      }
      if (!info.remote) {
        nodes.push(action('＋ 添加文件夹到项目', async () => {
          const dir = await pickFolder(info.project.folders?.[0] || info.dir, 'project');
          if (!dir) return;
          shell?.addProjectFolder?.(info.project.id, dir);
          await render();
        }));
        nodes.at(-1).classList.add('cwp-add');
      }
    } else {
      const head = el('div', 'cwp-project'); head.appendChild(el('span', 'cwp-muted', '未关联项目'));
      if (info.sessionId) head.append(action('关联到项目', () => { close(); shell?.openMoveMenu?.(info.sessionId); }),
        action('＋ 新建项目…', () => { close(); shell?.createProjectFor?.(info.sessionId); }));
      nodes.push(head);
    }
    pop.replaceChildren(...nodes);
    place();
  }
  function place() {
    if (!pop || !anchor?.isConnected) return;
    const box = anchor.getBoundingClientRect(), width = Math.min(380, innerWidth - 24);
    pop.style.width = width + 'px';
    pop.style.left = Math.max(12, Math.min(box.left, innerWidth - width - 12)) + 'px';
    const below = innerHeight - box.bottom - 12, above = box.top - 12;
    const upward = above > below;
    pop.style.maxHeight = Math.max(160, Math.min(520, upward ? above - 8 : below - 8)) + 'px';
    pop.style.top = upward ? 'auto' : (box.bottom + 8) + 'px';
    pop.style.bottom = upward ? (innerHeight - box.top + 8) + 'px' : 'auto';
  }
  function close(restoreFocus = false) {
    if (!pop) return;
    pop.remove(); pop = null; seq++;
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) anchor?.focus();
    anchor = null;
  }
  function open(button) {
    close();
    anchor = button;
    pop = el('div', 'wc-popover show cwp-pop');
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '工作位置');
    pop.addEventListener('click', event => event.stopPropagation());
    pop.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(true); } });
    document.body.appendChild(pop);
    button.setAttribute('aria-expanded', 'true');
    void render().then(() => pop?.querySelector('button')?.focus({ preventScroll: true }));
  }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('#nchatWd');
    if (button && !button.classList.contains('wc-context-static')) {
      event.preventDefault();
      if (pop && anchor === button) close(); else open(button);
      return;
    }
    if (pop && !pop.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && pop) close(true); });
  global.addEventListener('resize', place);
  // Membership changes in the sidebar repaint an open popover in place.
  global.addEventListener('soduwork-sidebar-projects-changed', () => { if (pop) void render(); });
  global.ChatWorkspacePopover = { open, close, render, isOpen: () => !!pop };
})(window);
