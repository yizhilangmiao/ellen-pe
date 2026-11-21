// 记忆页（底栏「回忆」）。
//
// 版式照 `_verify/ui-baseline/08-memory-tab.png`：
//   eyebrow → h1 → 副标题 → 三段（我们的回忆 / 记忆 / 我眼里的你）
//   → 胶囊组（她的过去 / 共同经历 / 星图）→ 一行说明 → 米白记忆卡片
//
// 数据来自本地库（`memory` / `journal` 两类记录），不再是空壳。
import { s } from '../../../strings.zh.js';
import { iconEl } from '../../icons.js';
import { openMemoryEditor } from '../../memory-editor.js';
import { openAnniversaryEditor, openDaySheet } from '../../anniversary-editor.js';
import { attachLongPress } from '../../long-press.js';
import {
  listAll as listAnniversaries,
  create as createAnniversary,
  update as updateAnniversary,
  remove as removeAnniversary,
  markedDaysOfMonth,
  sortByUpcoming,
  normalizeValue,
  describeDaysAway,
  nextOccurrence,
} from '../../../core/anniversary.js';
import {
  createMemory,
  updateMemory,
  removeMemory,
  retireMemory,
  restoreMemory,
  splitByState,
} from '../../../core/memory.js';
import { readUnderstanding, maybeRefresh as refreshUnderstanding } from '../../../core/understanding.js';
import { loadModelConfig, isUsable } from '../../../core/config.js';
import { listLatest } from '../../../core/store/library.js';
import { push } from '../../router.js';
import './memory.css';
import './memory-calendar.css';

function dayLabel(at) {
  const d = new Date(at || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEK_HEADS = ['日', '一', '二', '三', '四', '五', '六'];

/** 把 journal 列表按 `YYYY-MM-DD` 建索引：day → 列表下标（点日历格直接跳那一篇）。 */
function byDay(rows) {
  const map = new Map();
  rows.forEach((r, i) => {
    const day = (r.value && r.value.day) || dayLabel(r.at);
    if (day && !map.has(day)) map.set(day, i);
  });
  return map;
}

function ymd(y, m, d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

/**
 * 手记日历（照旧包 `04-memory.png`：月份箭头 + 星期行 + 日格 + 最近一篇）。
 * 有手记的日子点开那一篇；空日子点了给一句提示（老大 2026-11-21 定：不能点了没反应）；
 * 长按任意一格开菜单（翻开 / 标成纪念日 / 改 / 取消这一标）。
 * 有纪念日的格子上留一个点：每年重复的是实心点、只这一年的空心点。
 */
function journalCalendar(rows, cursor, onOpen, onShiftMonth, opts = {}) {
  const days = byDay(rows);
  const marked = opts.marked || new Map();
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  const box = document.createElement('div');
  box.className = 'el-journal-cal';

  const head = document.createElement('div');
  head.className = 'el-journal-cal-head';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'el-journal-month-arrow';
  prev.dataset.journalControl = 'previous';
  prev.textContent = '‹';
  prev.addEventListener('click', () => onShiftMonth(-1));

  const label = document.createElement('span');
  label.className = 'el-journal-cal-title';
  label.textContent = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'el-journal-month-arrow';
  next.dataset.journalControl = 'next';
  next.textContent = '›';
  next.addEventListener('click', () => onShiftMonth(1));
  // 往后翻允许到「今天所在月 + 12 个月」：纪念日都落在未来一年里，翻得过去才看得到。
  // 再往后就没意义了 —— 那边没有手记，也没有哪一年的落点。
  const now = new Date();
  const horizon = new Date(now.getFullYear(), now.getMonth() + 12, 1);
  next.disabled = new Date(y, m, 1).getTime() >= horizon.getTime();

  head.append(prev, label, next);

  const week = document.createElement('div');
  week.className = 'el-journal-week';
  for (const w of WEEK_HEADS) {
    const cell = document.createElement('span');
    cell.className = 'el-journal-week-cell';
    cell.textContent = w;
    week.append(cell);
  }

  const grid = document.createElement('div');
  grid.className = 'el-journal-grid';
  const firstDow = new Date(y, m, 1).getDay();
  const total = new Date(y, m + 1, 0).getDate();
  const todayKey = dayLabel(Date.now());

  for (let i = 0; i < firstDow; i += 1) {
    const filler = document.createElement('span');
    filler.className = 'el-journal-day-cell is-blank';
    grid.append(filler);
  }
  for (let d = 1; d <= total; d += 1) {
    const key = ymd(y, m, d);
    const idx = days.get(key);
    const annivRows = marked.get(key) || [];
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'el-journal-day-cell';
    cell.dataset.day = key;
    // status 仍只讲「有没有手记」：老验收脚本按 filled/empty 判，不改它的语义
    cell.dataset.status = idx === undefined ? 'empty' : 'filled';
    cell.textContent = String(d);
    if (key === todayKey) cell.classList.add('is-today');
    if (idx !== undefined) cell.classList.add('has-entry');
    if (annivRows.length) {
      const yearly = annivRows.some((a) => a.value.yearly);
      cell.classList.add(yearly ? 'is-anniv' : 'is-anniv-once');
      cell.dataset.anniv = '1';
      cell.dataset.annivTitle = annivRows
        .map((a) => a.value.title || s('memory.annivUntitled'))
        .join('、');
      cell.setAttribute('aria-label', `${key} ${cell.dataset.annivTitle}`);
    }
    // 空日子不再 disabled：这一天也能标成纪念日，点了至少给一句提示
    cell.addEventListener('click', () => {
      if (idx !== undefined) {
        onOpen(idx);
        return;
      }
      if (annivRows.length && typeof opts.onAnnivTap === 'function') opts.onAnnivTap(key, annivRows);
      else if (typeof opts.onEmptyTap === 'function') opts.onEmptyTap(key);
    });
    if (typeof opts.onLongPress === 'function') {
      cell.dataset.longPress = 'day';
      attachLongPress(cell, () => opts.onLongPress(key));
    }
    grid.append(cell);
  }

  box.append(head, week, grid);
  return box;
}
// 记忆列表分页：压测 5,014 条时一次性渲染出 60,182 个 DOM 节点、4,261 ms、
// scrollHeight 76 万 px —— 真机上等于进页面就卡。改成先渲染 60 条，点「再多看几条」追加，
// 与手记列表（JOURNAL_PAGE）同一套做法，不重建已渲染的节点，滚动位置不跳。
const MEMORY_PAGE = 60;

function paintMemoryRows(host, rows, onChanged) {
  const wrap = document.createElement('div');
  wrap.className = 'el-memory-cards';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'el-journal-more';
  let shown = 0;
  const grow = () => {
    const slice = rows.slice(shown, shown + MEMORY_PAGE);
    for (const r of slice) wrap.append(memoryCard(r, onChanged));
    shown += slice.length;
    if (shown >= rows.length) more.remove();
    else more.textContent = `再多看几条（还剩 ${rows.length - shown} 条）`;
  };
  more.addEventListener('click', grow);
  host.append(wrap, more);
  grow();
}

// R3 的界面文案。先放在这里，最后统一并进 strings.zh.js ——
// 别人的文件里加 key 容易被同批改动覆盖，文案自己留着不会丢。
const MEMORY_STATE_TEXT = {
  superseded: '已翻篇',
  retired: '别再提',
};

function clockLabel(at) {
  const d = new Date(at || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 「这条是从哪几句来的」。
 * 光看一条总结没法判断她记错没有；把原话摊在下面，他才能一眼看出是哪次对话被理解歪了。
 */
function sourceList(item) {
  const v = item.value || {};
  const refs = Array.isArray(v.sourceRefs) ? v.sourceRefs.filter((r) => r && r.text) : [];
  const box = document.createElement('div');
  box.className = 'el-memory-src';
  if (!refs.length) {
    const none = document.createElement('div');
    none.className = 'el-memory-src-none';
    none.textContent = '这条没有留下出处（早期版本记的）。';
    box.append(none);
    return box;
  }
  const head = document.createElement('div');
  head.className = 'el-memory-src-head';
  head.textContent = '记自这几句';
  box.append(head);
  for (const r of refs.slice(-4)) {
    const row = document.createElement('div');
    row.className = 'el-memory-src-row';
    const who = document.createElement('span');
    who.className = 'el-memory-src-who';
    who.textContent = r.role === 'assistant' ? '我' : '他';
    const text = document.createElement('span');
    text.className = 'el-memory-src-text';
    text.textContent = r.text;
    const at = document.createElement('span');
    at.className = 'el-memory-src-at';
    at.textContent = r.at ? clockLabel(r.at) : '';
    row.append(who, text, at);
    box.append(row);
  }
  return box;
}

function memoryCard(item, onChanged) {
  const card = document.createElement('article');
  card.className = 'el-memory-card';
  card.dataset.memoryId = item.headId;

  const v = item.value || {};
  const state = v.state || 'active';
  if (state !== 'active') card.classList.add(`is-${state}`);

  const head = document.createElement('div');
  head.className = 'el-memory-head';
  const mark = document.createElement('div');
  mark.className = 'el-memory-mark';
  mark.append(iconEl('book'));
  head.append(mark);
  // 角标：翻篇/退役的条目还在列表里（能点回来看看她原来怎么记的），
  // 但要一眼看出它现在不算数了，否则他改口之后会以为她记岔了。
  if (MEMORY_STATE_TEXT[state]) {
    const badge = document.createElement('span');
    badge.className = `el-memory-state is-${state}`;
    badge.textContent = MEMORY_STATE_TEXT[state];
    head.append(badge);
  }

  const title = document.createElement('h2');
  title.className = 'el-memory-title';
  title.textContent = v.title || v.subject || '一段回忆';

  const body = document.createElement('p');
  body.className = 'el-memory-body';
  body.textContent = v.summary || v.body || '';

  const sources = sourceList(item);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'el-memory-more';
  more.innerHTML = `${s('memory.openMemory')}<span class="el-memory-arrow">→</span>`;
  more.addEventListener('click', () => card.classList.toggle('is-expanded'));

  // 改 / 删 / 别再提：自动抽出来的东西一定有错的时候，得能就地改。
  // 用 stopPropagation 是因为卡片外层的「翻开这段回忆」是个 button，别让点击冒泡过去。
  const tools = document.createElement('div');
  tools.className = 'el-memory-tools';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'el-memory-tool';
  editBtn.textContent = s('memory.editMemory');
  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'el-memory-tool';
  muteBtn.textContent = state === 'retired' ? '恢复' : '别再提';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'el-memory-tool is-danger';
  delBtn.textContent = s('memory.deleteMemory');

  editBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const res = await openMemoryEditor({
      item,
      onSave: (patch) => updateMemory(item.headId, patch),
      onDelete: () => removeMemory(item.headId),
    });
    if (res !== 'cancelled' && typeof onChanged === 'function') onChanged();
  });

  // 「别再提」：留档但不召回。跟删除的区别 —— 删了她连聊过都不知道，
  // 下一句同样的内容又被记一遍；退役是「知道，但不再主动拿出来说」。
  muteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    muteBtn.disabled = true;
    try {
      if (state === 'retired') await restoreMemory(item.headId);
      else await retireMemory(item.headId);
      if (typeof onChanged === 'function') onChanged();
    } catch (err) {
      console.error('[memory] 状态切换失败', err);
      muteBtn.disabled = false;
    }
  });
  // 删：就地二次确认，**绝不打开编辑面板**（老版本这里错调了 openMemoryEditor，
  // 于是点「删」弹出来的是「改」的界面）。首点只进入「待确认」，3 秒不点自动还原。
  let delArmed = false;
  let delTimer = 0;
  const disarmDelete = () => {
    delArmed = false;
    window.clearTimeout(delTimer);
    delTimer = 0;
    delBtn.disabled = false;
    delBtn.classList.remove('is-armed');
    delBtn.textContent = s('memory.deleteMemory');
  };
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!delArmed) {
      delArmed = true;
      delBtn.classList.add('is-armed');
      delBtn.textContent = s('memory.confirmDelete');
      window.clearTimeout(delTimer);
      delTimer = window.setTimeout(disarmDelete, 3000);
      return;
    }
    window.clearTimeout(delTimer);
    delArmed = false;
    delBtn.disabled = true;
    delBtn.textContent = s('memory.deleting');
    try {
      await removeMemory(item.headId);
      if (typeof onChanged === 'function') onChanged();
    } catch (err) {
      console.error('[memory] 删除失败', err);
      disarmDelete();
    }
  });
  tools.append(editBtn, muteBtn, delBtn);

  card.append(head, title, body, sources, tools, more);
  return card;
}

/** 「最近一篇」大卡（旧包 `button.el-journal-latest`）：日历下面那一眼就能看到的最新手记。 */
function latestJournal(item, onOpen) {
  const v = item.value || {};
  const card = document.createElement('article');
  card.className = 'el-journal-card el-journal-latest';

  const day = document.createElement('div');
  day.className = 'el-journal-day';
  day.textContent = v.day || dayLabel(item.at);

  const title = document.createElement('h2');
  title.className = 'el-journal-title';
  title.textContent = v.title || s('journal.untitled');

  const body = document.createElement('p');
  body.className = 'el-journal-body';
  body.textContent = v.diary || '';

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'el-memory-more';
  more.innerHTML = `${s('memory.openMemory')}<span class="el-memory-arrow">→</span>`;
  more.addEventListener('click', onOpen);

  card.append(day, title, body, more);
  return card;
}
function journalCard(item, onOpen) {
  const v = item.value || {};
  const card = document.createElement('article');
  card.className = 'el-journal-card';
  card.dataset.journalDay = v.day || dayLabel(item.at);

  const day = document.createElement('div');
  day.className = 'el-journal-day';
  day.textContent = v.day || dayLabel(item.at);

  const title = document.createElement('h2');
  title.className = 'el-journal-title';
  title.textContent = v.title || '这一天';

  const body = document.createElement('p');
  body.className = 'el-journal-body';
  body.textContent = v.diary || v.thoughts || '';

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'el-memory-more';
  more.innerHTML = `${s('memory.openMemory')}<span class="el-memory-arrow">→</span>`;
  more.addEventListener('click', () => {
    if (onOpen) onOpen(item);
    else card.classList.toggle('is-expanded');
  });

  card.append(day, title, body, more);
  return card;
}

// 「我眼里的你」这几句文案没走 strings.zh.js：那个文件这一批不归我改（有人在动），
// 数量少，就近放这里，省得两边版本对不上。
const U_TEXT = {
  title: '我眼里的你',
  emptyTitle: '还没有足够的回忆',
  emptySub: '再聊几天，我才知道该怎么写你。想让我现在就试试也可以。',
  thinkNow: '现在就想一想',
  thinkAgain: '再想一想',
  thinking: '正在想…',
  when: '写于',
  noConfig: '还没填聊天模型，填完再来。',
  noData: '记忆和手记都还是空的，先聊几句吧。',
  failed: '这次没写出来，过会儿再试。',
  tagPrefix: '',
};

function shortDate(at) {
  const d = new Date(at || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 「我眼里的你」正文卡：沿用 `.el-memory-card` 的米白纸与硬影，
 * 里面换成一段第二人称的话 + 标签 + 一行「写于 / 再想一想」。
 */
function understandingCard(rec, onAgain) {
  const v = rec.value || {};
  const card = document.createElement('article');
  card.className = 'el-memory-card el-understanding-card';
  card.dataset.understandingId = rec.headId;

  const mark = document.createElement('div');
  mark.className = 'el-memory-mark';
  mark.append(iconEl('book'));

  const title = document.createElement('h2');
  title.className = 'el-memory-title';
  title.textContent = U_TEXT.title;

  const body = document.createElement('p');
  body.className = 'el-understanding-body';
  body.textContent = v.body || '';

  card.append(mark, title, body);

  if (Array.isArray(v.tags) && v.tags.length) {
    const tags = document.createElement('div');
    tags.className = 'el-understanding-tags';
    for (const t of v.tags) {
      const chip = document.createElement('span');
      chip.className = 'el-understanding-tag';
      chip.textContent = String(t);
      tags.append(chip);
    }
    card.append(tags);
  }

  const foot = document.createElement('div');
  foot.className = 'el-understanding-foot';
  const when = document.createElement('span');
  when.className = 'el-understanding-when';
  when.textContent = `${U_TEXT.when} ${shortDate(v.updatedAt || rec.at)}`;
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'el-understanding-again';
  again.textContent = U_TEXT.thinkAgain;
  again.addEventListener('click', onAgain);
  foot.append(when, again);
  card.append(foot);
  return card;
}

export function createMemoryView() {
  return {
    mount(el, mountProps = {}) {
      el.classList.add('el-scroll-page', 'el-memory-page');

      const eyebrow = document.createElement('div');
      eyebrow.className = 'el-eyebrow';
      eyebrow.textContent = s('memory.eyebrow');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('memory.title');

      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('memory.subtitle');

      // 一排页签（原来分两排：三段页签 + 三条胶囊，同一件事摆了两次，还占两行高）。
      // 现在五件事平铺成一行：日常 / 她的过去 / 共同经历 / 星图 / 我眼里的你。
      const pages = document.createElement('div');
      pages.className = 'el-segments el-memory-tabs';
      const pageDefs = [
        ['daily', s('memory.pageDaily')],
        ['past', s('memory.past')],
        ['shared', s('memory.shared')],
        ['stars', s('memory.stars')],
        ['understanding', s('memory.pageUnderstanding')],
      ];
      const pageBtns = pageDefs.map(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-segment';
        b.dataset.memoryTab = id;
        // 兼容老选择器与老验收脚本
        b.dataset.memoryPage = id === 'past' || id === 'shared' || id === 'stars' ? 'memories' : id;
        if (id === 'past' || id === 'shared' || id === 'stars') b.dataset.recallGroup = id;
        b.textContent = label;
        pages.append(b);
        return b;
      });

      const hint = document.createElement('p');
      hint.className = 'el-section-hint';

      const list = document.createElement('div');
      list.className = 'el-memory-list';

      el.append(eyebrow, title, subtitle, pages, hint, list);

      // 手记列表分页：一次只往 DOM 里塞 60 张。
      // 为什么：500 篇的库里一次性渲染 401 张卡片，DOM 两千多个节点、页面高 61000 px，
      // 低端机上滚动会掉帧；而且原来写死 limit:400，超过 400 篇的老手记在列表里根本到不了。
      const JOURNAL_PAGE = 60;
      // pending：切换页签时若上一次 load 还在跑，先记下来，等它落地后再补跑一次。
      // 否则 load() 开头的 loading 守卫会把这次点击整个吞掉（状态改了、界面不变）。
      const state = { tab: 'daily', loading: false, pending: false, month: null, journalRows: null, journalShown: 0, annivs: [] };

      function paintButtons() {
        for (const b of pageBtns) b.classList.toggle('is-active', b.dataset.memoryTab === state.tab);
      }

      function emptyBox(text, sub) {
        const box = document.createElement('div');
        box.className = 'el-memory-empty';
        const t = document.createElement('div');
        t.className = 'el-memory-empty-title';
        t.textContent = text;
        box.append(t);
        if (sub) {
          const p = document.createElement('div');
          p.className = 'el-memory-empty-sub';
          p.textContent = sub;
          box.append(p);
        }
        return box;
      }

      // 一句两秒就散的提示。点空格子、标完、取消标完都要有回应 ——
      // 之前空日子点了什么也不发生，那等于让人以为手滑了。
      let flashTimer = 0;
      function flash(text) {
        if (!text) return;
        let box = document.querySelector('.el-memory-toast');
        if (box) box.remove();
        box = document.createElement('div');
        box.className = 'el-memory-toast';
        box.textContent = text;
        (document.querySelector('.ellen-app') || document.body).append(box);
        requestAnimationFrame(() => box.classList.add('is-open'));
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          box.classList.remove('is-open');
          setTimeout(() => box.remove(), 220);
        }, 2000);
      }

      // 把「我们的回忆」的日常视图画出来：日历 + 最新一篇大卡 + 前 N 张卡 + 「再多看几篇」
      // 点「再多看几篇」只往末尾追加，不重建整棵树（重建会把滚动位置甩回顶部）。
      function paintDaily() {
        const rows = state.journalRows || [];
        list.replaceChildren();
        const open = (i) => push('journal', { items: rows, index: i });
        const onShift = (step) => {
          state.month = new Date(state.month.getFullYear(), state.month.getMonth() + step, 1);
          paintDaily();
        };
        // 第一次进来把日历翻到最新那篇所在的月份；一篇都没有就翻到今天这个月
        // （纪念日挂在日历上，没有手记也得能看见、能标）。
        if (!state.month) {
          const newest = rows.length
            ? (rows[0].value && rows[0].value.day) || dayLabel(rows[0].at)
            : dayLabel(Date.now());
          const d = new Date(`${newest}T00:00:00`);
          state.month = new Date(d.getFullYear(), d.getMonth(), 1);
        }
        const marked = markedDaysOfMonth(state.annivs, state.month.getFullYear(), state.month.getMonth());
        list.append(
          journalCalendar(rows, state.month, open, onShift, {
            marked,
            onEmptyTap: () => flash(s('memory.calEmptyTap')),
            onAnnivTap: (day, annivRows) => {
              const v = (annivRows[0] || {}).value || {};
              const next = nextOccurrence(v.day, v.yearly);
              flash(`${v.title || s('memory.annivUntitled')} · ${describeDaysAway(next ? next.daysAway : 0)}`);
            },
            onLongPress: onDayLongPress,
          })
        );
        // 纪念日单独一段，紧跟日历（老大 2026-11-21 定：不混进记忆、共同经历）
        list.append(annivSection());
        if (!rows.length) {
          list.append(emptyBox(s('memory.empty'), s('memory.journalEmpty')));
          return;
        }
        list.append(latestJournal(rows[0], () => open(0)));
        const allHead = document.createElement('p');
        allHead.className = 'el-journal-all-head';
        allHead.textContent = s('memory.journalAll');
        list.append(allHead);

        const cards = document.createElement('div');
        cards.className = 'el-journal-cards';
        list.append(cards);

        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'el-journal-more';

        function syncMore() {
          const shown = state.journalShown;
          const left = rows.length - shown;
          if (left <= 0) {
            more.remove();
            return;
          }
          more.textContent = s('memory.journalMore').replace('{n}', String(left));
          if (!more.isConnected) list.append(more);
        }

        function grow() {
          const from = state.journalShown;
          const to = Math.min(from + JOURNAL_PAGE, rows.length);
          const frag = document.createDocumentFragment();
          for (let i = from; i < to; i += 1) frag.append(journalCard(rows[i], () => open(i)));
          cards.append(frag);
          state.journalShown = to;
          syncMore();
        }

        more.addEventListener('click', grow);
        grow();
      }

      /**
       * 「纪念日」那一段：按「下一个先到」排，今天那一条高亮。
       * 一次性且已经过去的日子排在最后（daysAway 为负），不隐藏 —— 它是发生过的事。
       */
      function annivSection() {
        const box = document.createElement('div');
        box.className = 'el-anniv-section';
        const head = document.createElement('p');
        head.className = 'el-anniv-head';
        head.textContent = s('memory.annivSection');
        box.append(head);
        const rows = sortByUpcoming(state.annivs || []);
        if (!rows.length) {
          const empty = document.createElement('p');
          empty.className = 'el-anniv-empty';
          empty.textContent = s('memory.annivEmpty');
          box.append(empty);
          return box;
        }
        const wrap = document.createElement('div');
        wrap.className = 'el-anniv-list';
        for (const item of rows) wrap.append(annivCard(item));
        box.append(wrap);
        return box;
      }

      function annivCard(item) {
        const { row, value, daysAway } = item;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'el-anniv-card';
        card.dataset.annivDay = value.day;
        if (daysAway === 0) card.classList.add('is-today');

        const date = document.createElement('span');
        date.className = 'el-anniv-date';
        date.textContent = value.day.slice(5).replace('-', '/');

        const main = document.createElement('span');
        main.className = 'el-anniv-main';
        const title = document.createElement('span');
        title.className = 'el-anniv-title';
        title.textContent = value.title || s('memory.annivUntitled');
        main.append(title);
        if (value.note) {
          const note = document.createElement('span');
          note.className = 'el-anniv-note';
          note.textContent = value.note;
          main.append(note);
        }

        const away = document.createElement('span');
        away.className = 'el-anniv-away';
        away.textContent = describeDaysAway(daysAway);

        card.append(date, main, away);
        card.addEventListener('click', async () => {
          const res = await openAnniversaryEditor({
            item: { headId: row.headId, value },
            onSave: (patch) => updateAnniversary(row.headId, patch),
            onDelete: () => removeAnniversary(row.headId),
          });
          if (res === 'deleted') flash(s('memory.calAnnivRemoved'));
          if (res === 'saved' || res === 'deleted') load();
        });
        return card;
      }

      /**
       * 长按日历某一格：先弹一杯菜单，拿到选择再开下一个面板。
       * 两个面板都挂 .ellen-app，同时开会叠在一起、返回键也会互相抢层。
       */
      async function onDayLongPress(day) {
        const idx = byDay(state.journalRows || []).get(day);
        const hit = (state.annivs || []).find((r) => normalizeValue(r.value).day === day) || null;
        const anniv = hit ? normalizeValue(hit.value) : null;
        const choice = await openDaySheet({ day, hasEntry: idx !== undefined, anniv });
        if (choice === 'entry' && idx !== undefined) {
          push('journal', { items: state.journalRows, index: idx });
          return;
        }
        if (choice === 'set') {
          const res = await openAnniversaryEditor({
            day,
            onSave: (patch) => createAnniversary(patch),
          });
          if (res === 'saved') {
            flash(s('memory.calAnnivSaved'));
            load();
          }
          return;
        }
        if (choice === 'edit' && hit) {
          const res = await openAnniversaryEditor({
            item: { headId: hit.headId, value: normalizeValue(hit.value) },
            onSave: (patch) => updateAnniversary(hit.headId, patch),
            onDelete: () => removeAnniversary(hit.headId),
          });
          if (res === 'deleted') flash(s('memory.calAnnivRemoved'));
          if (res === 'saved' || res === 'deleted') load();
          return;
        }
        if (choice === 'clear' && hit) {
          await removeAnniversary(hit.headId);
          flash(s('memory.calAnnivRemoved'));
          load();
        }
      }

      /**
       * 「我眼里的你」：有记录就画那张纸卡，没有就给「还没有足够的回忆」+ 一个立刻生成的按钮。
       * 生成走 core/understanding.js 的 maybeRefresh（force 越过 24h 门槛），
       * 模型调用与落库在那边是分开的两步，这里只负责把结果画出来。
       */
      async function paintUnderstanding() {
        hint.textContent = s('memory.understandingHint');
        const rec = await readUnderstanding();
        list.replaceChildren();
        if (rec && rec.value && rec.value.body) {
          hint.textContent = '';
          list.append(understandingCard(rec, () => think('again')));
          return;
        }
        const box = emptyBox(U_TEXT.emptyTitle, U_TEXT.emptySub);
        const cta = document.createElement('button');
        cta.type = 'button';
        cta.className = 'el-understanding-cta';
        cta.textContent = U_TEXT.thinkNow;
        cta.addEventListener('click', () => think('now'));
        box.append(cta);
        list.append(box);
      }

      async function think(kind) {
        const btn = list.querySelector(kind === 'again' ? '.el-understanding-again' : '.el-understanding-cta');
        const label = kind === 'again' ? U_TEXT.thinkAgain : U_TEXT.thinkNow;
        if (btn) {
          btn.disabled = true;
          btn.textContent = U_TEXT.thinking;
        }
        try {
          const config = await loadModelConfig();
          if (!isUsable(config)) {
            hint.textContent = U_TEXT.noConfig;
            return;
          }
          const [memories, journals] = await Promise.all([
            listLatest('memory', { limit: 0 }),
            listLatest('journal', { limit: 0 }),
          ]);
          if (!memories.length && !journals.length) {
            hint.textContent = U_TEXT.noData;
            return;
          }
          hint.textContent = U_TEXT.thinking;
          const res = await refreshUnderstanding({
            config,
            memories,
            journals,
            at: Date.now(),
            force: true,
          });
          if (res.status !== 'written') {
            hint.textContent = res.reason === 'noConfig' ? U_TEXT.noConfig : U_TEXT.failed;
            return;
          }
          await load();
        } catch (err) {
          console.warn('[memory] 生成我眼里的你失败', err);
          hint.textContent = U_TEXT.failed;
        } finally {
          // load() 成功会重建整棵树，按钮已经不在文档里；只兜住提前 return 的那些分支
          if (btn && btn.isConnected) {
            btn.disabled = false;
            btn.textContent = label;
          }
        }
      }

      async function load() {
        if (state.loading) {
          state.pending = true;
          return;
        }
        state.loading = true;
        list.replaceChildren();
        const loading = document.createElement('div');
        loading.className = 'el-memory-loading';
        loading.textContent = s('memory.loading');
        list.append(loading);
        paintButtons();

        try {
          if (state.tab === 'past') {
            hint.textContent = s('memory.pastHint');
            const rows = await listLatest('memory', { limit: 0 });
            // 在用的排在前面；翻篇/退役的留在下面 —— 留档的意义就是「能翻回去看他原来怎么说的」，
            // 但混在一起会让人以为她记着两份互相矛盾的事实。
            const grouped = splitByState(rows);
            const cold = [...grouped.superseded, ...grouped.retired].sort(
              (a, b) => (Number((b.value || {}).updatedAt) || b.at || 0) - (Number((a.value || {}).updatedAt) || a.at || 0),
            );
            const ordered = [...grouped.active, ...cold];
            list.replaceChildren();

            const bar = document.createElement('div');
            bar.className = 'el-memory-bar';
            const count = document.createElement('span');
            count.className = 'el-memory-count';
            count.textContent = rows.length
              ? cold.length
                ? `${grouped.active.length} 条 · ${cold.length} 条不算数了`
                : `${rows.length} 条`
              : '';
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'el-memory-add';
            addBtn.textContent = `+ ${s('memory.addMemory')}`;
            addBtn.addEventListener('click', async () => {
              const res = await openMemoryEditor({
                onSave: (patch) => createMemory(patch),
              });
              if (res === 'saved') load();
            });
            bar.append(count, addBtn);
            list.append(bar);

            if (!rows.length) {
              list.append(emptyBox(s('memory.emptyTitle'), s('memory.emptyAddHint')));
            } else {
              // 第二参是「数据动过了」的回调：编辑面板存/删之后重载这一页
              paintMemoryRows(list, ordered, () => load());
            }
          } else if (state.tab === 'shared') {
            hint.textContent = s('memory.sharedHint');
            // 共同经历 = scope 标记为 shared 的记忆（两人一起经历过的），
            // 卡片直接复用 memoryCard()：改/删那一套（.el-memory-tools）只实现一次。
            // 只取 active：翻篇的「一起去过」不该继续算作共同经历。
            const all = await listLatest('memory', { limit: 0 });
            const rows = all.filter(
              (r) => ((r.value || {}).scope || '') === 'shared' && (!r.value.state || r.value.state === 'active'),
            );
            list.replaceChildren();
            if (!rows.length) {
              list.append(emptyBox(s('memory.empty'), s('memory.sharedHint')));
            } else {
              const bar = document.createElement('div');
              bar.className = 'el-memory-bar';
              const count = document.createElement('span');
              count.className = 'el-memory-count';
              count.textContent = `${rows.length} 条`;
              bar.append(count);
              list.append(bar);
              paintMemoryRows(list, rows, () => load());
            }
          } else if (state.tab === 'stars') {
            hint.textContent = s('memory.starsHint');
            list.replaceChildren(emptyBox(s('memory.empty'), s('memory.starsHint')));
          } else if (state.tab === 'daily') {
            hint.textContent = '';
            // limit:0 = 全量。日历要标出「哪天有手记」和「哪天是纪念日」，两者都要整份数据；
            // DOM 只渲染前 state.journalShown 张（见 paintDaily）。
            const [rows, annivs] = await Promise.all([
              listLatest('journal', { limit: 0 }),
              listAnniversaries(),
            ]);
            state.journalRows = rows;
            state.annivs = annivs;
            state.journalShown = 0; // 由 paintDaily 里的 grow() 从 0 开始铺第一批
            paintDaily();
          } else {
            await paintUnderstanding();
          }
        } catch (err) {
          console.error('[memory] 读取失败', err);
          list.replaceChildren(emptyBox('读不出来了', String((err && err.message) || err)));
        } finally {
          state.loading = false;
          if (state.pending) {
            state.pending = false;
            load();
          }
        }
      }

      // 事件委托挂在容器上，只挂一次：将来谁重建 pages 也不会把 handler 丢掉。
      pages.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-memory-tab]') : null;
        if (!btn || !pages.contains(btn)) return;
        const tab = btn.dataset.memoryTab;
        if (!tab || state.tab === tab) return;
        // 星图已经不是这里的一格内容，而是一整页（相处页也有入口）。
        // 点它就整页推进去，不切页签、不白读一次库；没有回调时才落回老占位。
        if (tab === 'stars' && typeof mountProps.onOpenStars === 'function') {
          mountProps.onOpenStars();
          return;
        }
        state.tab = tab;
        paintButtons(); // 同步给反馈，不等 load() 里的异步刷新
        load();
      });

      paintButtons();
      load();

      return {
        resume() {
          load();
        },
        destroy() {},
      };
    },
  };
}
