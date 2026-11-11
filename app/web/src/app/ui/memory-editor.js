// 记忆编辑面板（手记一条 / 改一条）。
//
// 为什么不用原生 prompt/confirm：WebView 里的 prompt 是阻塞原生对话框，
// 暗色皮肤下白底浅字糊成一片（导入确认框踩过一次），而且拿不到「取消/保存」的分支文案。
//
// 结构：一层遮罩 + 一张卡片，卡片里 标题 / 内容 / 标签 三个输入 + 三个按钮。
// 打开期间 焦点进标题框、Escape 关闭、点遮罩关闭；关闭时还原滚动锁。
import { s } from '../strings.zh.js';
import { registerBack } from '../core/back-stack.js';
import './memory-editor.css';

let opened = null;

/**
 * @param {{ item?: {headId, value}, onSave?: (patch) => Promise<any>, onDelete?: () => Promise<any> }} opts
 * @returns {Promise<'saved'|'deleted'|'cancelled'>}
 */
export function openMemoryEditor({ item = null, onSave, onDelete } = {}) {
  if (opened) opened.close('cancelled');
  const value = (item && item.value) || {};
  const editing = !!item;

  const scrim = document.createElement('div');
  scrim.className = 'el-editor-scrim';

  const card = document.createElement('div');
  card.className = 'el-editor-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', editing ? s('memory.editTitle') : s('memory.addTitle'));

  const head = document.createElement('h2');
  head.className = 'el-editor-head';
  head.textContent = editing ? s('memory.editTitle') : s('memory.addTitle');

  const hint = document.createElement('p');
  hint.className = 'el-editor-hint';
  hint.textContent = s('memory.editHint');

  const titleLabel = document.createElement('label');
  titleLabel.className = 'el-editor-label';
  titleLabel.textContent = s('memory.fieldTitle');
  const titleInput = document.createElement('input');
  titleInput.className = 'el-editor-input';
  titleInput.type = 'text';
  titleInput.maxLength = 12;
  titleInput.value = value.title || '';
  titleInput.placeholder = s('memory.fieldTitlePlaceholder');
  titleLabel.append(titleInput);

  const bodyLabel = document.createElement('label');
  bodyLabel.className = 'el-editor-label';
  bodyLabel.textContent = s('memory.fieldBody');
  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'el-editor-input el-editor-textarea';
  bodyInput.rows = 4;
  bodyInput.maxLength = 120;
  bodyInput.value = value.summary || value.body || '';
  bodyInput.placeholder = s('memory.fieldBodyPlaceholder');
  bodyLabel.append(bodyInput);

  const tagLabel = document.createElement('label');
  tagLabel.className = 'el-editor-label';
  tagLabel.textContent = s('memory.fieldTags');
  const tagInput = document.createElement('input');
  tagInput.className = 'el-editor-input';
  tagInput.type = 'text';
  tagInput.maxLength = 40;
  tagInput.value = (Array.isArray(value.tags) ? value.tags : []).join('、');
  tagInput.placeholder = s('memory.fieldTagsPlaceholder');
  tagLabel.append(tagInput);

  const scopeRow = document.createElement('div');
  scopeRow.className = 'el-editor-scope';
  const scopeLabel = document.createElement('span');
  scopeLabel.className = 'el-editor-label';
  scopeLabel.textContent = s('memory.fieldScope');
  const segs = document.createElement('div');
  segs.className = 'el-segments el-editor-segs';
  let scope = value.scope === 'past' ? 'past' : 'shared';
  const SCOPE_DEFS = [
    ['shared', 'memory.scopeShared'],
    ['past', 'memory.scopePast'],
  ];
  const scopeBtns = SCOPE_DEFS.map(([id, key]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'el-segment';
    b.dataset.scope = id;
    b.textContent = s(key);
    b.classList.toggle('is-active', id === scope);
    b.addEventListener('click', () => {
      scope = id;
      scopeBtns.forEach((x) => x.classList.toggle('is-active', x === b));
    });
    segs.append(b);
    return b;
  });
  scopeRow.append(scopeLabel, segs);

  const note = document.createElement('p');
  note.className = 'el-editor-note';

  const actions = document.createElement('div');
  actions.className = 'el-editor-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'el-secondary';
  cancel.textContent = s('common.cancel');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'el-primary';
  save.textContent = s('common.save');
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'el-secondary is-danger';
  del.textContent = s('common.delete');
  if (editing && onDelete) actions.append(del);
  actions.append(cancel, save);

  card.append(head, hint, titleLabel, bodyLabel, tagLabel, scopeRow, note, actions);
  scrim.append(card);
  // 挂到 .ellen-app 里面而不是 body：--el-* / --z-* 令牌全定义在 .ellen-app 上，
  // 挂 body 会让整块面板拿不到任何颜色（实测卡片底色 rgba(0,0,0,0)、遮罩全透明）。
  const host = document.querySelector('.ellen-app') || document.body;
  host.append(scrim);
  requestAnimationFrame(() => {
    // 遮罩和卡片都要上 is-open：遮罩靠它把 background 从 0 过渡到 0.72
    scrim.classList.add('is-open');
    card.classList.add('is-open');
    titleInput.focus();
  });

  // 返回键第 50 层：面板开着就只关面板，不动导航
  const unregisterBack = registerBack(
    () => {
      if (!opened) return false;
      close('cancelled');
      return true;
    },
    { priority: 50, name: 'memory-editor' },
  );

  function close(result) {
    if (!opened) return;
    opened = null;
    unregisterBack();
    card.classList.remove('is-open');
    scrim.classList.remove('is-open');
    const done = () => {
      scrim.remove();
      if (resolveOuter) resolveOuter(result);
    };
    setTimeout(done, 140);
  }
  let resolveOuter = null;
  const finished = new Promise((r) => {
    resolveOuter = r;
  });

  function busy(on, text) {
    save.disabled = on;
    if (del) del.disabled = on;
    cancel.disabled = on;
    note.textContent = text || '';
    note.classList.toggle('is-bad', !!text && on === false && note.dataset.bad === '1');
  }

  function fail(err) {
    const code = err && err.code;
    note.dataset.bad = '1';
    note.classList.add('is-bad');
    note.textContent =
      code === 'MEMORY_EMPTY' ? s('memory.errEmpty') : `${s('memory.errSave')}${(err && err.message) || err}`;
  }

  save.addEventListener('click', async () => {
    const patch = { title: titleInput.value, summary: bodyInput.value, tags: tagInput.value, scope };
    if (!patch.title.trim() && !patch.summary.trim()) {
      fail({ code: 'MEMORY_EMPTY' });
      return;
    }
    busy(true, s('memory.saving'));
    try {
      if (onSave) await onSave(patch);
      close('saved');
    } catch (err) {
      busy(false, '');
      fail(err);
    }
  });

  if (del) {
    del.addEventListener('click', async () => {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = s('memory.confirmDelete');
        note.textContent = s('memory.deleteHint');
        note.classList.remove('is-bad');
        return;
      }
      busy(true, s('memory.deleting'));
      try {
        await onDelete();
        close('deleted');
      } catch (err) {
        busy(false, '');
        fail(err);
      }
    });
  }

  cancel.addEventListener('click', () => close('cancelled'));
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) close('cancelled');
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close('cancelled');
    }
  };
  scrim.addEventListener('keydown', onKey);

  opened = { close };
  return finished;
}
