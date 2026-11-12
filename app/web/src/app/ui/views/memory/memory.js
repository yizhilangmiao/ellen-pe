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
import { createMemory, updateMemory, removeMemory } from '../../../core/memory.js';
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
 * 只有写过手记的日子是可点的，其余灰掉 —— 点空日子什么也不发生，别给假反馈。
 */
function journalCalendar(rows, cursor, onOpen, onShiftMonth) {
  const days = byDay(rows);
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
  // 不给翻到未来的月份：那边一定没有手记
  const now = new Date();
  const atLatestMonth =
    cursor.getFullYear() === now.getFullYear() && cursor.getMonth() === now.getMonth();
  next.disabled = atLatestMonth;

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
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
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
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'el-journal-day-cell';
    cell.dataset.day = key;
    cell.dataset.status = idx === undefined ? 'empty' : 'filled';
    cell.textContent = String(d);
    if (key === todayKey) cell.classList.add('is-today');
    if (idx !== undefined) {
      cell.classList.add('has-entry');
      cell.addEventListener('click', () => onOpen(idx));
    } else {
      cell.disabled = true;
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

function memoryCard(item, onChanged) {
  const card = document.createElement('article');
  card.className = 'el-memory-card';
  card.dataset.memoryId = item.headId;

  const mark = document.createElement('div');
  mark.className = 'el-memory-mark';
  mark.append(iconEl('book'));

  const title = document.createElement('h2');
  title.className = 'el-memory-title';
  const v = item.value || {};
  title.textContent = v.title || v.subject || '一段回忆';

  const body = document.createElement('p');
  body.className = 'el-memory-body';
  body.textContent = v.summary || v.body || '';

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'el-memory-more';
  more.innerHTML = `${s('memory.openMemory')}<span class="el-memory-arrow">→</span>`;
  more.addEventListener('click', () => card.classList.toggle('is-expanded'));

  // 改 / 删：自动抽出来的东西一定有错的时候，得能就地改。
  // 用 stopPropagation 是因为卡片外层的「翻开这段回忆」是个 button，别让点击冒泡过去。
  const tools = document.createElement('div');
  tools.className = 'el-memory-tools';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'el-memory-tool';
  editBtn.textContent = s('memory.editMemory');
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
  tools.append(editBtn, delBtn);

  card.append(mark, title, body, tools, more);
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
      const state = { tab: 'daily', loading: false, pending: false, month: null, journalRows: null, journalShown: 0 };

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

      // 把「我们的回忆」的日常视图画出来：日历 + 最新一篇大卡 + 前 N 张卡 + 「再多看几篇」
      // 点「再多看几篇」只往末尾追加，不重建整棵树（重建会把滚动位置甩回顶部）。
      function paintDaily() {
        const rows = state.journalRows || [];
        list.replaceChildren();
        if (!rows.length) {
          list.append(emptyBox(s('memory.empty'), s('memory.journalEmpty')));
          return;
        }
        const open = (i) => push('journal', { items: rows, index: i });
        // 第一次进来时把日历翻到最新那篇所在的月份
        if (!state.month) {
          const newest = rows[0].value && rows[0].value.day ? rows[0].value.day : dayLabel(rows[0].at);
          const d = new Date(`${newest}T00:00:00`);
          state.month = new Date(d.getFullYear(), d.getMonth(), 1);
        }
        list.append(
          journalCalendar(rows, state.month, open, (step) => {
            state.month = new Date(state.month.getFullYear(), state.month.getMonth() + step, 1);
            paintDaily();
          })
        );
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
            list.replaceChildren();

            const bar = document.createElement('div');
            bar.className = 'el-memory-bar';
            const count = document.createElement('span');
            count.className = 'el-memory-count';
            count.textContent = rows.length ? `${rows.length} 条` : '';
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
              paintMemoryRows(list, rows, () => load());
            }
          } else if (state.tab === 'shared') {
            hint.textContent = s('memory.sharedHint');
            // 共同经历 = scope 标记为 shared 的记忆（两人一起经历过的），
            // 卡片直接复用 memoryCard()：改/删那一套（.el-memory-tools）只实现一次。
            const all = await listLatest('memory', { limit: 0 });
            const rows = all.filter((r) => ((r.value || {}).scope || '') === 'shared');
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
            // limit:0 = 全量。日历要标出「哪天有手记」，必须有全部日期；
            // DOM 只渲染前 state.journalShown 张（见 paintDaily）。
            const rows = await listLatest('journal', { limit: 0 });
            state.journalRows = rows;
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
