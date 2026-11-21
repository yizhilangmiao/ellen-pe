// 纪念日的编辑面板 + 日历格的长按菜单。
//
// 为什么不用原生 prompt：跟 memory-editor 同一个理由 —— WebView 里的 prompt 是阻塞式
// 原生对话框，暗色皮肤下白底浅字，还拿不到「取消」与「每年重复」这种分支。
//
// 结构照 memory-editor.js：一层遮罩 + 一张卡片，挂进 .ellen-app（--el-* 令牌都在那上面，
// 挂 body 会拿到全透明底色）。返回 'saved' | 'deleted' | 'cancelled'。
import { s } from '../strings.zh.js';
import { registerBack } from '../core/back-stack.js';
import { describeDaysAway, nextOccurrence } from '../core/anniversary.js';
import './anniversary-editor.css';

let openedEditor = null;

/** 一天的手记 + 纪念日 → 长按后弹的那张菜单。返回 Promise<'entry'|'edit'|'set'|'clear'|'cancelled'>。 */
export function openDaySheet({ day, hasEntry = false, anniv = null } = {}) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'el-sheet-scrim';
    const sheet = document.createElement('div');
    sheet.className = 'el-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');

    const title = document.createElement('div');
    title.className = 'el-sheet-title';
    title.textContent = day;

    const sub = document.createElement('div');
    sub.className = 'el-sheet-sub';
    sub.textContent = anniv
      ? `${anniv.title || s('memory.annivUntitled')} · ${describeDaysAway(nextOccurrence(anniv.day, anniv.yearly).daysAway)}`
      : hasEntry
        ? s('memory.calSheetHasEntry')
        : s('memory.calSheetEmpty');

    const listEl = document.createElement('div');
    listEl.className = 'el-sheet-list';

    const rows = [];
    if (hasEntry) rows.push(['entry', s('memory.calSheetOpen')]);
    if (anniv) {
      rows.push(['edit', s('memory.calSheetEdit')]);
    } else {
      // 「标成纪念日」是这杯菜单的主操作，给主色，别让人找不着能按的地方
      rows.push(['set', s('memory.calSheetSet'), 'is-primary']);
    }
    if (anniv) rows.push(['clear', s('memory.calSheetClear'), 'is-danger']);

    for (const [id, label, cls] of rows) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `el-sheet-item${cls ? ` ${cls}` : ''}`;
      b.dataset.sheetAction = id;
      b.textContent = label;
      b.addEventListener('click', () => close(id));
      listEl.append(b);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'el-sheet-cancel';
    cancel.textContent = s('common.cancel');
    cancel.addEventListener('click', () => close('cancelled'));

    sheet.append(title, sub, listEl, cancel);
    scrim.append(sheet);
    (document.querySelector('.ellen-app') || document.body).append(scrim);
    requestAnimationFrame(() => {
      scrim.classList.add('is-open');
      sheet.classList.add('is-open');
    });

    const unregister = registerBack(
      () => {
        if (!scrim.isConnected) return false;
        close('cancelled');
        return true;
      },
      { priority: 51, name: 'day-sheet' },
    );

    function close(result) {
      unregister();
      scrim.classList.remove('is-open');
      sheet.classList.remove('is-open');
      setTimeout(() => {
        scrim.remove();
        resolve(result);
      }, 140);
    }

    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) close('cancelled');
    });
  });
}

/**
 * 新建 / 修改一个纪念日。
 * @param {{ item?: {headId, value}, day?: string, onSave?: (patch) => Promise<any>, onDelete?: () => Promise<any> }} opts
 */
export function openAnniversaryEditor({ item = null, day = '', onSave, onDelete } = {}) {
  if (openedEditor) openedEditor.close('cancelled');
  const value = (item && item.value) || {};
  const editing = !!item;
  const when = value.day || day;

  const scrim = document.createElement('div');
  scrim.className = 'el-editor-scrim';

  const card = document.createElement('div');
  card.className = 'el-editor-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', editing ? s('memory.annivEditTitle') : s('memory.annivAddTitle'));

  const head = document.createElement('h2');
  head.className = 'el-editor-head';
  head.textContent = editing ? s('memory.annivEditTitle') : s('memory.annivAddTitle');

  const dayLine = document.createElement('p');
  dayLine.className = 'el-anniv-day';
  dayLine.textContent = when;

  const hint = document.createElement('p');
  hint.className = 'el-editor-hint';
  hint.textContent = s('memory.annivHint');

  const titleLabel = document.createElement('label');
  titleLabel.className = 'el-editor-label';
  titleLabel.textContent = s('memory.annivFieldTitle');
  const titleInput = document.createElement('input');
  titleInput.className = 'el-editor-input';
  titleInput.type = 'text';
  titleInput.maxLength = 20;
  titleInput.value = value.title || '';
  titleInput.placeholder = s('memory.annivFieldTitlePlaceholder');
  titleLabel.append(titleInput);

  const noteLabel = document.createElement('label');
  noteLabel.className = 'el-editor-label';
  noteLabel.textContent = s('memory.annivFieldNote');
  const noteInput = document.createElement('textarea');
  noteInput.className = 'el-editor-input el-editor-textarea';
  noteInput.rows = 3;
  noteInput.maxLength = 60;
  noteInput.value = value.note || '';
  noteInput.placeholder = s('memory.annivFieldNotePlaceholder');
  noteLabel.append(noteInput);

  const repeatRow = document.createElement('div');
  repeatRow.className = 'el-editor-scope';
  const repeatLabel = document.createElement('span');
  repeatLabel.className = 'el-editor-label';
  repeatLabel.textContent = s('memory.annivFieldRepeat');
  const segs = document.createElement('div');
  segs.className = 'el-segments el-editor-segs';
  let yearly = value.yearly !== false;
  const REPEAT_DEFS = [
    [true, s('memory.annivYearly')],
    [false, s('memory.annivOnce')],
  ];
  const repeatBtns = REPEAT_DEFS.map(([val, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'el-segment';
    b.dataset.yearly = val ? '1' : '0';
    b.textContent = label;
    b.classList.toggle('is-active', val === yearly);
    b.addEventListener('click', () => {
      yearly = val;
      repeatBtns.forEach((x) => x.classList.toggle('is-active', x === b));
    });
    segs.append(b);
    return b;
  });
  repeatRow.append(repeatLabel, segs);

  const note = document.createElement('p');
  note.className = 'el-editor-note';

  const actions = document.createElement('div');
  actions.className = 'el-editor-actions';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'el-secondary is-danger';
  del.textContent = s('common.delete');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'el-secondary';
  cancel.textContent = s('common.cancel');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'el-primary';
  save.textContent = s('common.save');
  if (editing && onDelete) actions.append(del);
  actions.append(cancel, save);

  card.append(head, dayLine, hint, titleLabel, noteLabel, repeatRow, note, actions);
  scrim.append(card);
  const host = document.querySelector('.ellen-app') || document.body;
  host.append(scrim);
  requestAnimationFrame(() => {
    scrim.classList.add('is-open');
    card.classList.add('is-open');
    titleInput.focus();
  });

  const unregisterBack = registerBack(
    () => {
      if (!openedEditor) return false;
      close('cancelled');
      return true;
    },
    { priority: 52, name: 'anniversary-editor' },
  );

  let resolveOuter = null;
  const finished = new Promise((r) => {
    resolveOuter = r;
  });

  function close(result) {
    if (!openedEditor) return;
    openedEditor = null;
    unregisterBack();
    card.classList.remove('is-open');
    scrim.classList.remove('is-open');
    setTimeout(() => {
      scrim.remove();
      if (resolveOuter) resolveOuter(result);
    }, 140);
  }

  function busy(on, text) {
    save.disabled = on;
    del.disabled = on;
    cancel.disabled = on;
    note.textContent = text || '';
  }

  function fail(err) {
    note.classList.add('is-bad');
    note.textContent = `${s('memory.annivErrSave')}${(err && err.message) || err}`;
  }

  save.addEventListener('click', async () => {
    const patch = {
      day: when,
      title: titleInput.value.trim(),
      note: noteInput.value.trim(),
      yearly,
    };
    busy(true, s('memory.saving'));
    try {
      if (onSave) await onSave(patch);
      close('saved');
    } catch (err) {
      busy(false, '');
      fail(err);
    }
  });

  if (editing && onDelete) {
    del.addEventListener('click', async () => {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = s('memory.confirmDelete');
        note.classList.remove('is-bad');
        note.textContent = s('memory.annivDeleteHint');
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
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close('cancelled');
    }
  });

  openedEditor = { close };
  return finished;
}
