// 信（`letter` 路由）。
//
// 三个态共用一页：
//   列表 —— 时间 + 首行 + 未读点，新的在上；
//   读信 —— 正文按 `paragraphs` 分页（一屏一段或几段，底部翻页 + 页码），
//           `short === true` 时顶上一条提示 + 「让她重写一封」；
//   生成中 —— 标题「她正在写」，下面字数往上跳（`props.writing.chars`）。
//
// 数据：优先吃 `props.letters / props.writing`（Lead 注入），拿不到就自己读
// `core/letter.js`。core 里任何一步失败都只降级成「列表为空」或「读不到这封」，
// 不许把整页搞白 —— 信是关系线的情绪出口，白屏比空列表难看得多。
import { s } from '../../../strings.zh.js';
import { push } from '../../router.js';
import './letter.css';

// core 模块按需拿、只拿一次；缺失时留 null，界面走空态。
let corePromise = null;
function letterCore() {
  if (!corePromise) {
    corePromise = import('../../../core/letter.js').catch((err) => {
      console.warn('[letter] core/letter.js 还不可用', err);
      return null;
    });
  }
  return corePromise;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 列表里的短时间：今年只写「11月12日」，往年补年份。 */
function shortDate(at) {
  const n = Number(at) || 0;
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** 读信页顶部的时间：带时分，读的时候更像一封真的信。 */
function fullDate(at) {
  const n = Number(at) || 0;
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 首行：没标题就取第一段，掐到二十来个字。 */
function firstLine(card) {
  const title = String((card && card.title) || '').trim();
  if (title) return title;
  const ps = (card && card.paragraphs) || [];
  let text = '';
  for (const p of ps) {
    const t = String(p || '').trim();
    if (t) {
      text = t;
      break;
    }
  }
  if (!text) text = String((card && card.text) || '').trim();
  text = text.replace(/\s+/g, ' ');
  return text.length > 26 ? text.slice(0, 26) + '…' : text;
}

/**
 * 把段落切成「一屏能读完」的页：一页最多两段 / 大约 200 字。
 * 单独一段超过预算就独占一页（长段落硬切会断句，宁可一页长一点）。
 */
const PAGE_BUDGET = 200;
function paginate(paragraphs, fallbackText) {
  let list = (Array.isArray(paragraphs) ? paragraphs : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (!list.length) {
    list = String(fallbackText || '')
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (!list.length) return [];
  const pages = [];
  let cur = [];
  let len = 0;
  for (const p of list) {
    const n = p.length;
    if (cur.length && (len + n > PAGE_BUDGET || cur.length >= 2)) {
      pages.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += n;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

export function createLetterView({ state } = {}) {
  let root = null;
  let app = state || null;
  let props = {};
  let cards = [];
  let mode = 'list'; // list | read | writing
  let opened = null; // 正在读的那封
  let pages = [];
  let page = 0;
  let busy = false;
  let backfillPending = false;
  // 「已经走过但还没写信」的档位。列表顶部因此会长出一条补写入口（老大 2026-11-13 要的）。
  let gapStages = [];
  let writingChars = 0;
  let rewritePending = false;
  let disposed = false;

  // ── 骨架 ──────────────────────────────────────────────────────────
  function buildHead() {
    const head = document.createElement('header');
    head.className = 'el-letter-head';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'el-eyebrow';
    eyebrow.textContent = s('letter.eyebrow');

    const title = document.createElement('h1');
    title.className = 'el-page-title';
    title.textContent = s('letter.title');

    const subtitle = document.createElement('p');
    subtitle.className = 'el-page-subtitle';
    subtitle.textContent = s('letter.subtitle');

    head.append(eyebrow, title, subtitle);
    return head;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ── 生成中 ────────────────────────────────────────────────────────
  function paintWriting() {
    mode = 'writing';
    if (!root || !root._body) return;
    const body = root._body;
    clear(body);

    const box = document.createElement('section');
    box.className = 'el-letter-writing';

    const line = document.createElement('div');
    line.className = 'el-letter-writing-line';

    const title = document.createElement('p');
    title.className = 'el-letter-writing-title';
    title.textContent = s('letter.writing');

    const count = document.createElement('p');
    count.className = 'el-letter-writing-count';
    // writingCount 里带 {n}，s() 不做插值，自己换
    count.textContent = s('letter.writingCount').replace('{n}', String(writingChars));

    const dots = document.createElement('span');
    dots.className = 'el-letter-writing-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.textContent = '···';

    line.append(dots);
    box.append(line, title, count);
    body.append(box);
  }

  // ── 列表 ──────────────────────────────────────────────────────────
  function paintList() {
    mode = 'list';
    if (!root || !root._body) return;
    const body = root._body;
    clear(body);

    if (!cards.length) {
      const empty = document.createElement('div');
      empty.className = 'el-letter-empty';

      const text = document.createElement('p');
      text.className = 'el-letter-empty-text';
      text.textContent = s('letter.empty');

      const toChat = document.createElement('button');
      toChat.type = 'button';
      toChat.className = 'el-secondary el-letter-empty-btn';
      toChat.textContent = s('letter.toChat');
      toChat.addEventListener('click', () => push('chat'));

      empty.append(text, toChat);
      body.append(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'el-letter-list';

    const unread = cards.filter((c) => !c.read).length;
    const summary = document.createElement('p');
    summary.className = 'el-letter-summary';
    summary.textContent =
      unread > 0
        ? String(unread) + s('letter.unread')
        : s('letter.readAll');
    list.append(summary);

    if (gapStages.length) list.append(backfillCard());

    cards.forEach((card) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'el-letter-card';
      item.classList.toggle('is-unread', !card.read);

      const main = document.createElement('span');
      main.className = 'el-letter-card-main';

      const time = document.createElement('span');
      time.className = 'el-letter-card-time';
      time.textContent = shortDate(card.at);

      const line = document.createElement('span');
      line.className = 'el-letter-card-line';
      line.textContent = firstLine(card);

      main.append(time, line);

      const meta = document.createElement('span');
      meta.className = 'el-letter-card-meta';
      meta.textContent = s('letter.chars').replace('{n}', String(Number(card.chars) || 0));

      const dot = document.createElement('span');
      dot.className = 'el-letter-dot';
      dot.hidden = !!card.read;

      item.append(main, meta, dot);
      item.addEventListener('click', () => openLetter(card));
      list.append(item);
    });

    body.append(list);
  }

  // ── 补写历史阶段的信 ──────────────────────────────────────────────
  /**
   * 老大 2026-11-13：「以前有的聊天记录如果能读到的话补发信和加好感度，每个阶段都有信」。
   * 这里只放一个入口，真正的重活（重放历史点数、逐档写信）在 `props.onBackfill` 里，
   * 因为写信需要 config/persona，那是 main.js 才知道的事。
   */
  function backfillCard() {
    const box = document.createElement('section');
    box.className = 'el-letter-backfill';

    const text = document.createElement('p');
    text.className = 'el-letter-backfill-text';
    const labels = gapStages.map((g) => (g.label ? g.label : stageLabel(g.id))).join(' · ');
    text.textContent = s('letter.backfillText').replace('{stages}', labels);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'el-secondary el-letter-backfill-btn';
    btn.textContent = s('letter.backfillBtn').replace('{n}', String(gapStages.length));
    btn.addEventListener('click', async () => {
      if (backfillPending) return;
      if (typeof props.onBackfill !== 'function') {
        btn.textContent = s('letter.writeFail');
        return;
      }
      backfillPending = true;
      btn.disabled = true;
      btn.textContent = s('letter.backfillRunning');
      try {
        await props.onBackfill();
      } catch (err) {
        console.warn('[letter] 补写信失败', err);
        btn.textContent = s('letter.writeFail');
      } finally {
        backfillPending = false;
      }
    });

    box.append(text, btn);
    return box;
  }

  async function loadGaps() {
    try {
      const mod = await import('../../../core/backfill.js');
      const plan = await mod.planFromHistory();
      gapStages = Array.isArray(plan && plan.gaps) ? plan.gaps : [];
    } catch (err) {
      console.warn('[letter] 算不出缺哪几封信', err);
      gapStages = [];
    }
  }

  // ── 读信 ──────────────────────────────────────────────────────────
  function paintRead() {
    mode = 'read';
    if (!root || !root._body || !opened) return;
    const body = root._body;
    clear(body);

    const box = document.createElement('section');
    box.className = 'el-letter-read';

    const top = document.createElement('div');
    top.className = 'el-letter-read-top';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'el-letter-back';
    back.textContent = s('letter.backToList');
    back.addEventListener('click', () => {
      opened = null;
      paintList();
      // 退回列表时重扫一遍：刚读过的未读点要消失
      loadCards(true);
    });

    const when = document.createElement('span');
    when.className = 'el-letter-when';
    when.textContent = fullDate(opened.at);

    top.append(back, when);
    box.append(top);

    if (opened.stage) {
      const stage = document.createElement('p');
      stage.className = 'el-letter-stage';
      stage.textContent = s('letter.stageLine').replace('{stage}', stageLabel(opened.stage));
      box.append(stage);
    }

    // 短了：顶部提示 + 「让她重写一封」（Lead 走 props.onRewrite）
    if (opened.short === true) {
      const warn = document.createElement('div');
      warn.className = 'el-letter-short';

      const tip = document.createElement('p');
      tip.className = 'el-letter-short-text';
      tip.textContent = s('letter.short');

      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'el-letter-rewrite';
      again.textContent = rewritePending ? s('letter.rewriting') : s('letter.rewrite');
      again.disabled = rewritePending;
      again.addEventListener('click', () => rewrite(opened, again));

      warn.append(tip, again);
      box.append(warn);
    }

    const paper = document.createElement('div');
    paper.className = 'el-letter-paper';

    const pageParas = pages[page] || [];
    pageParas.forEach((text) => {
      const p = document.createElement('p');
      p.className = 'el-letter-para';
      p.textContent = text;
      paper.append(p);
    });

    if (!pageParas.length) {
      const p = document.createElement('p');
      p.className = 'el-letter-para is-empty';
      p.textContent = s('letter.empty');
      paper.append(p);
    }

    box.append(paper);

    // 翻页：一页装得下就不画控件，别给短文加噪音
    if (pages.length > 1) {
      const nav = document.createElement('div');
      nav.className = 'el-letter-nav';

      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'el-letter-nav-btn';
      prev.textContent = s('msg.prevPage');
      prev.disabled = page <= 0;
      prev.addEventListener('click', () => {
        if (page <= 0) return;
        page -= 1;
        paintRead();
        scrollReadTop();
      });

      const indicator = document.createElement('span');
      indicator.className = 'el-letter-nav-page';
      indicator.textContent = `${page + 1} / ${pages.length}`;

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'el-letter-nav-btn';
      next.textContent = s('msg.nextPage');
      next.disabled = page >= pages.length - 1;
      next.addEventListener('click', () => {
        if (page >= pages.length - 1) return;
        page += 1;
        paintRead();
        scrollReadTop();
      });

      nav.append(prev, indicator, next);
      box.append(nav);
    }

    // 落款（core 里带了 sign 就写，没带就不留空行）
    const sign = String(opened.sign || '').trim();
    if (sign) {
      const p = document.createElement('p');
      p.className = 'el-letter-sign';
      p.textContent = sign;
      box.append(p);
    }

    const foot = document.createElement('p');
    foot.className = 'el-letter-foot';
    foot.textContent = s('letter.chars').replace('{n}', String(Number(opened.chars) || 0));
    box.append(foot);

    body.append(box);
  }

  /** 翻页后把视口拉回信纸顶部（长信翻页停在页脚会很难受）。 */
  function scrollReadTop() {
    if (!root) return;
    const paper = root._body && root._body.querySelector('.el-letter-read');
    if (paper && typeof paper.scrollIntoView === 'function') {
      try {
        paper.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (err) {
        paper.scrollIntoView();
      }
    }
  }

  /** 档位名：bond.* 的键在 strings 里，这里只做 key → 文案，不新造词。 */
  function stageLabel(stage) {
    const map = {
      acquainted: 'bond.stageAcquainted',
      familiar: 'bond.stageFamiliar',
      trusted: 'bond.stageTrusted',
      close: 'bond.stageClose',
      lover: 'bond.stageLover',
    };
    const key = map[stage];
    return key ? s(key) : String(stage || '');
  }

  async function rewrite(card, btn) {
    if (rewritePending || !card) return;
    rewritePending = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = s('letter.rewriting');
    }
    try {
      if (typeof props.onRewrite === 'function') {
        await props.onRewrite(card.id);
      } else {
        // 没人接就退回生成态：Lead 注册时一定会传 onRewrite，
        // 这条分支只是让视图单独跑起来时不至于按钮点了没反应。
        writingChars = 0;
        paintWriting();
      }
    } catch (err) {
      console.warn('[letter] 重写请求失败', err);
      if (btn) btn.textContent = s('letter.writeFail');
    } finally {
      rewritePending = false;
    }
  }

  async function openLetter(card) {
    if (!card || disposed) return;
    opened = card;
    pages = paginate(card.paragraphs, card.text);
    page = 0;
    paintRead();

    // 标已读：失败不影响阅读（下次列表还会带点，但别把人挡在信外面）
    if (card.read !== true && card.id) {
      card.read = true; // 先本地翻，列表回来的时候点就没了
      try {
        const mod = await letterCore();
        if (mod && typeof mod.markRead === 'function') await mod.markRead(card.id);
      } catch (err) {
        console.warn('[letter] 标已读失败', err);
      }
      if (typeof props.onRead === 'function') {
        try {
          props.onRead(card.id);
        } catch (err) {
          console.warn('[letter] onRead 回调失败', err);
        }
      }
    }
  }

  async function loadCards(silent) {
    if (!silent) {
      const body = root && root._body;
      if (body && !cards.length && mode === 'list') {
        // 首屏先给个骨架文案，避免空白一片（不新造键，用空态那句）
        const loading = document.createElement('p');
        loading.className = 'el-letter-loading';
        loading.textContent = s('letter.empty');
        if (!body.firstChild) body.append(loading);
      }
    }
    let list = Array.isArray(props.letters) ? props.letters.slice() : null;
    if (!list) {
      try {
        const mod = await letterCore();
        if (mod && typeof mod.listLetters === 'function') {
          list = await mod.listLetters({ limit: 100 });
        }
      } catch (err) {
        console.warn('[letter] 读信件列表失败', err);
      }
      list = Array.isArray(list) ? list : [];
    }
    if (disposed) return;
    cards = list;
    await loadGaps();
    if (disposed) return;
    if (mode !== 'read' && mode !== 'writing') paintList();
  }

  async function refresh() {
    if (busy || !root || disposed) return;
    busy = true;
    try {
      if (props.writing) {
        const w = props.writing || {};
        writingChars = Number(w.chars) || 0;
        paintWriting();
        return;
      }
      if (mode === 'writing') {
        // 生成结束：回到列表（新写的信由 Lead 刷新 props.letters 或重挂视图）
        mode = 'list';
      }
      await loadCards();
      const openId = props.openId || props.open;
      if (openId) {
        const hit = cards.find((c) => c.id === openId);
        if (hit) {
          await openLetter(hit);
          props.openId = null;
          props.open = null;
        }
      }
    } finally {
      busy = false;
    }
  }

  // ── 对外 ──────────────────────────────────────────────────────────
  return {
    id: 'letter',

    mount(el, mountProps = {}) {
      props = mountProps || {};
      root = el;
      disposed = false;
      el.classList.add('el-scroll-page', 'el-letter-page');
      clear(el);

      const head = buildHead();
      const body = document.createElement('div');
      body.className = 'el-letter-body';

      el.append(head, body);
      root._body = body;

      refresh().catch((err) => console.warn('[letter] 首屏加载失败', err));

      return {
        resume() {
          refresh().catch((err) => console.warn('[letter] resume 失败', err));
        },
        /** 生成中由 Lead 推字数（不用重挂视图）。 */
        setWriting(w) {
          if (!root) return;
          if (!w) {
            props.writing = null;
            mode = 'list';
            refresh().catch(() => {});
            return;
          }
          writingChars = Number(w.chars) || 0;
          props.writing = w;
          paintWriting();
        },
        /** 列表数据换了一批（新信到了 / 重写完了）。 */
        setLetters(list) {
          if (!root) return;
          props.letters = Array.isArray(list) ? list.slice() : null;
          if (mode === 'read') mode = 'list';
          loadCards(true).catch((err) => console.warn('[letter] setLetters 失败', err));
        },
        refresh() {
          return refresh();
        },
        destroy() {
          disposed = true;
          cards = [];
          pages = [];
          opened = null;
          props = {};
          app = null;
          if (root) root._body = null;
          root = null;
        },
      };
    },
  };
}
