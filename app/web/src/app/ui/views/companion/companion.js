// 相处页（底栏「相处」）。
//
// 版式照 `_verify/ui-baseline/03-companion.png`：
//   WITH YOU → 「今天，也在一起。」→ 右侧圆形立绘
//   → 艾莲的此刻（心情词 + 一句解释）→ 米白便签卡
//   → 我们之间（关系徽章 + 感受一句话）→ 点线块「OUR DAYS, OUR STORY / 每一天，都算数。」
//
// 数据全是真的（core/companion.js）：相处天数来自最早一条消息，
// 心情与便签来自 `emotion` 记录，关系存在 meta 里。
import { s } from '../../../strings.zh.js';
import { push } from '../../router.js';
import { iconEl } from '../../icons.js';
import {
  RELATIONSHIPS,
  daysTogether,
  currentMood,
  relationship,
  setRelationship,
  maybeRecordMood,
} from '../../../core/companion.js';
import { isUsable } from '../../../core/config.js';
import portraitUrl from '../../../assets/ellen-portrait.webp';
import './companion.css';

// ── E 组新增四块的数据兜底（签到 / 亲密度 / 信·星图·徽章入口 / 仪式）──
// 数据优先吃 props（Lead 在 mount 时注入），拿不到就自己 await import core。
// 并行开发期 core 模块可能还没落地：哪个模块缺就只让那一张卡隐身，
// 不许把整页带崩 —— 相处页是首屏之一，白屏比少一张卡严重得多。
const coreCache = new Map();

async function core(name) {
  if (coreCache.has(name)) return coreCache.get(name);
  let mod = null;
  try {
    // 四个分支写死字面量：Vite 只认字面量动态导入，模板串会让产物里留一条跑不通的路径。
    if (name === 'checkin') mod = await import('../../../core/checkin.js');
    else if (name === 'bond') mod = await import('../../../core/bond.js');
    else if (name === 'letter') mod = await import('../../../core/letter.js');
    else if (name === 'ritual') mod = await import('../../../core/ritual.js');
  } catch (err) {
    console.warn('[companion] core/' + name + '.js 还不可用', err);
    mod = null;
  }
  coreCache.set(name, mod);
  return mod;
}

/** 今天的 'YYYY-MM-DD'（本地时区）。 */
function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** core 里的 lastDay 可能是 'YYYY-MM-DD'、ISO 串或时间戳 —— 三种都认。 */
function sameDay(value, now = new Date()) {
  if (value == null || value === '') return false;
  if (typeof value === 'number') return dayKey(new Date(value)) === dayKey(now);
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str === dayKey(now);
  if (/^\d+$/.test(str)) return dayKey(new Date(Number(str))) === dayKey(now);
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? false : dayKey(d) === dayKey(now);
}

// 契约 §4 的档位与升阶门槛（写死在这里是**兜底**：core/bond.js 在时以它的 nextThreshold 为准）
const STAGE_ORDER = ['acquainted', 'familiar', 'trusted', 'close', 'lover'];
const STAGE_AT = { acquainted: 25, familiar: 80, trusted: 165, close: 390, lover: null };
const STAGE_FROM = { acquainted: 0, familiar: 25, trusted: 80, close: 165, lover: 390 };

function stageText(stage) {
  const key = STAGE_ORDER.includes(stage) ? stage : 'acquainted';
  return s('bond.stage' + key.charAt(0).toUpperCase() + key.slice(1));
}

function stageNext(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1] : null;
}

/**
 * 星图图标：icons.js 是公共文件（不归我改），里面没有星星，就地补一个同规格的。
 * 属性照抄 icons.js 的 ICON_ATTRS，尺寸由 `.el-icon svg` 统一控制。
 */
const STAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m12 3 2.7 5.7 6.3.9-4.6 4.4 1.2 6.2-5.6-3.1-5.6 3.1 1.2-6.2L3 9.6l6.3-.9Z"></path></svg>';

function starIcon() {
  const span = document.createElement('span');
  span.className = 'el-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = STAR_SVG;
  return span;
}

export function createCompanionView({ state }) {
  let root = null;
  let busy = false;
  let props = {};
  // 本页自己刚写过的数据（例如点了签到）：有值时优先于 props 里的旧快照。
  const live = { checkin: null };

  function moodBlock() {
    const box = document.createElement('div');
    box.className = 'el-companion-mood';

    const label = document.createElement('p');
    label.className = 'el-companion-label';
    label.textContent = s('companion.moodLabel');

    const wordEl = document.createElement('p');
    wordEl.className = 'el-companion-mood-word';

    const noteEl = document.createElement('p');
    noteEl.className = 'el-companion-mood-note';

    box.append(label, wordEl, noteEl);
    box.paint = (mood) => {
      const moodText = (mood && mood.mood) || '';
      const noteText = (mood && mood.note) || '';
      wordEl.textContent = moodText || s('companion.moodUnknown');
      wordEl.classList.toggle('is-empty', !moodText);
      // 便签卡已经把那句话写了一遍，这里就别再说第二遍 ——
      // 只在「还没心情」时用这行解释一下为什么是「待了解」。
      noteEl.hidden = !!noteText;
      noteEl.textContent = s('companion.moodHint');
      noteEl.classList.remove('is-note');
    };
    return box;
  }

  function noteCard() {
    const card = document.createElement('article');
    card.className = 'el-companion-note';

    const label = document.createElement('p');
    label.className = 'el-companion-note-label';
    label.textContent = s('companion.noteLabel');

    const body = document.createElement('p');
    body.className = 'el-companion-note-body';

    card.append(label, body);
    card.paint = (mood) => {
      const text = (mood && mood.note) || '';
      body.textContent = text || s('companion.noteEmpty');
      body.classList.toggle('is-empty', !text);
    };
    return card;
  }

  function betweenBlock() {
    const box = document.createElement('div');
    box.className = 'el-companion-between';

    const head = document.createElement('div');
    head.className = 'el-companion-between-head';

    const title = document.createElement('h2');
    title.className = 'el-companion-between-title';
    title.textContent = s('companion.between');

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'el-companion-level';

    const menu = document.createElement('div');
    menu.className = 'el-companion-levels';
    menu.hidden = true;
    const options = RELATIONSHIPS.map((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'el-companion-level-option';
      b.dataset.level = r.id;
      b.textContent = r.label;
      menu.append(b);
      return b;
    });

    head.append(title, badge);
    box.append(head, menu);

    const hint = document.createElement('p');
    hint.className = 'el-companion-between-hint';
    hint.textContent = s('companion.betweenHint');
    box.append(hint);

    const mail = document.createElement('button');
    mail.type = 'button';
    mail.className = 'el-companion-mail';
    mail.setAttribute('aria-label', s('companion.mail'));
    // 「写信给她」用寄出箭头，别和下面「她写给你的信」抢同一个信封图标。
    mail.append(iconEl('send'));
    // 信箱 = 写信给她（旧包是一份草稿，新壳直接进反馈页，M7 · D12）
    mail.addEventListener('click', () => push('feedback'));
    box.append(mail);

    let current = RELATIONSHIPS[0];
    badge.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
    });
    for (const b of options) {
      b.addEventListener('click', async () => {
        current = await setRelationship(b.dataset.level);
        paint();
        menu.hidden = true;
      });
    }
    function paint() {
      badge.textContent = current.label;
      for (const b of options) b.classList.toggle('is-active', b.dataset.level === current.id);
    }
    box.setLevel = (rel) => {
      current = rel || RELATIONSHIPS[0];
      paint();
    };
    return box;
  }

  function daysBlock() {
    const box = document.createElement('div');
    box.className = 'el-companion-days';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'el-eyebrow';
    eyebrow.textContent = 'OUR DAYS, OUR STORY';

    const title = document.createElement('h2');
    title.className = 'el-companion-days-title';
    title.textContent = '每一天，都算数。';

    const pill = document.createElement('p');
    pill.className = 'el-companion-days-pill';

    const peek = document.createElement('div');
    peek.className = 'el-companion-peek';
    const img = document.createElement('img');
    img.src = portraitUrl;
    img.alt = '';
    peek.append(img);

    box.append(eyebrow, title, pill, peek);
    box.paint = (days) => {
      pill.replaceChildren();
      const label = document.createElement('span');
      label.textContent = s('companion.daysLabel');
      const num = document.createElement('b');
      num.textContent = String(days);
      const unit = document.createElement('span');
      unit.textContent = s('companion.daysUnit');
      pill.append(label, num, unit);
      // 节拍 6：里程碑（每 100 天）才给一次 glitch，单屏一次，别每天抖
      if (days > 0 && days % 100 === 0) {
        pill.classList.remove('zz-anim-glitch');
        // 强制重排，让同名动画能重播（一天最多一次，代价可忽略）
        void pill.offsetWidth;
        pill.classList.add('zz-anim-glitch');
        window.setTimeout(() => pill.classList.remove('zz-anim-glitch'), 320);
      }
    };
    return box;
  }

  /** 签到卡：未签给按钮，已签给连签数。数据 props.checkin 或 core/checkin.js。 */
  function checkinCard() {
    const box = document.createElement('section');
    box.className = 'el-companion-checkin';

    const text = document.createElement('div');
    text.className = 'el-companion-checkin-text';

    const streakEl = document.createElement('p');
    streakEl.className = 'el-companion-checkin-streak';

    const subEl = document.createElement('p');
    subEl.className = 'el-companion-checkin-sub';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'el-companion-checkin-btn';

    text.append(streakEl, subEl);
    box.append(text, btn);

    let signed = false;
    let snap = null;

    btn.addEventListener('click', async () => {
      if (signed) return;
      signed = true; // 防连点：写库是幂等的，但按钮连闪三下很丑
      btn.classList.add('is-done');
      try {
        const mod = await core('checkin');
        let res = null;
        if (mod && typeof mod.checkIn === 'function') res = await mod.checkIn(new Date());
        if (res && res.state) {
          live.checkin = res.state;
          paint({ state: res.state });
          // checkIn 顺手加了亲密度点数：亲密度卡立刻刷一次，不然要等下次进页面
          if (res.bond && root && root._bond) {
            readBond().catch((err) => console.warn('[companion] 签到后刷新亲密度失败', err));
          }
          // 签到也可能顺手解锁徽章：交给 Lead 去算（那边才知道弹窗长什么样）
          if (typeof props.onCheckin === 'function') {
            try {
              await props.onCheckin(res.state);
            } catch (err) {
              console.warn('[companion] onCheckin 回调失败', err);
            }
          }
        } else {
          paint({ state: snap || {} });
        }
      } catch (err) {
        console.warn('[companion] 签到失败', err);
        signed = false;
        btn.classList.remove('is-done');
      }
    });

    function paint({ state }) {
      snap = state || null;
      const st = snap || {};
      const streak = Number(st.streak) || 0;
      const best = Number(st.best) || 0;
      const total = Number(st.days) || 0;
      signed = sameDay(st.lastDay);
      streakEl.textContent = s('checkin.streak').replace('{n}', String(streak));
      subEl.textContent =
        best > 0
          ? s('checkin.best').replace('{n}', String(best))
          : s('checkin.total').replace('{n}', String(total));
      btn.textContent = signed ? s('checkin.done') : s('checkin.button');
      btn.classList.toggle('is-done', signed);
      box.hidden = false;
    }

    box.paint = paint;
    box.hidden = true;
    return box;
  }

  /** 亲密度卡：阶段名 + 进度条 + 「距 <下一阶> 还差 N」。 */
  function bondCard() {
    const box = document.createElement('section');
    box.className = 'el-companion-bond';

    const head = document.createElement('div');
    head.className = 'el-companion-bond-head';

    const stageEl = document.createElement('span');
    stageEl.className = 'el-companion-bond-stage';

    const pointsEl = document.createElement('span');
    pointsEl.className = 'el-companion-bond-points';

    head.append(stageEl, pointsEl);

    const track = document.createElement('div');
    track.className = 'el-companion-bond-track';
    const fill = document.createElement('i');
    fill.className = 'el-companion-bond-fill';
    track.append(fill);

    const nextEl = document.createElement('p');
    nextEl.className = 'el-companion-bond-next';

    const subEl = document.createElement('p');
    subEl.className = 'el-companion-bond-sub';

    box.append(head, track, nextEl, subEl);

    box.paint = (info) => {
      const { points, stage, stageMessages, enabled, hasData, nextAt } = info || {};
      if (!hasData) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      const pts = Math.max(0, Number(points) || 0);
      const key = STAGE_ORDER.includes(stage) ? stage : 'acquainted';
      // core/bond.js 的 snapshot() 直接给了 stageLabel 和 progress（含 ratio / remaining），
      // 有就用它的算好的数；没有才按契约常量自己兜。
      const nextStage = stageNext(key);
      const next = info && Number.isFinite(Number(info.nextAt)) ? Number(info.nextAt) : STAGE_AT[key];
      const from = STAGE_FROM[key] || 0;

      stageEl.textContent = (info && info.stageLabel) || stageText(key);
      pointsEl.textContent = s('bond.points').replace('{n}', String(pts));

      if (enabled === false) {
        fill.style.width = '0%';
        nextEl.textContent = s('bond.disabled');
        subEl.hidden = true;
        return;
      }
      if (Number.isFinite(Number(info && info.ratio))) {
        fill.style.width = `${(Number(info.ratio) * 100).toFixed(1)}%`;
      } else if (next == null || !nextStage) {
        fill.style.width = '100%';
      } else {
        const span = Math.max(1, next - from);
        const ratio = Math.min(1, Math.max(0, (pts - from) / span));
        fill.style.width = `${(ratio * 100).toFixed(1)}%`;
      }

      if (next == null || !nextStage) {
        nextEl.textContent = s('bond.top');
      } else {
        const remain = Number.isFinite(Number(info && info.remaining)) ? Number(info.remaining) : Math.max(0, next - pts);
        nextEl.textContent = s('bond.toNext')
          .replace('{n}', String(Math.max(0, remain)))
          .replace('{next}', stageText(nextStage));
      }
      const msgs = Number(stageMessages) || 0;
      subEl.hidden = msgs <= 0;
      subEl.textContent = s('bond.milestones').replace('{n}', String(msgs));
    };

    box.hidden = true;
    return box;
  }

  /** 入口条：她写给你的信（未读点）+ 星图 + 徽章。 */
  function entryBar() {
    const box = document.createElement('div');
    box.className = 'el-companion-entries';

    const letter = document.createElement('button');
    letter.type = 'button';
    letter.className = 'el-companion-entry el-companion-entry-mail';

    const titleEl = document.createElement('span');
    titleEl.className = 'el-companion-entry-title';
    titleEl.textContent = s('letter.title');

    const countEl = document.createElement('span');
    countEl.className = 'el-companion-entry-count';
    countEl.textContent = s('letter.readAll');

    const dot = document.createElement('span');
    dot.className = 'el-companion-dot';
    dot.hidden = true;

    letter.append(iconEl('mail'), titleEl, countEl, dot);
    letter.addEventListener('click', () => push('letter'));

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'el-companion-entry el-companion-entry-round';
    const starLabel = document.createElement('span');
    starLabel.className = 'el-companion-entry-label';
    starLabel.textContent = s('starmap.title');
    star.append(starIcon(), starLabel);
    star.addEventListener('click', () => push('starmap'));

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'el-companion-entry el-companion-entry-round';
    const badgeLabel = document.createElement('span');
    badgeLabel.className = 'el-companion-entry-label';
    badgeLabel.textContent = s('ach.title');
    badge.append(iconEl('check'), badgeLabel);
    badge.addEventListener('click', () => push('achievements'));

    box.append(letter, star, badge);

    box.paintLetters = (unread) => {
      const n = Math.max(0, Number(unread) || 0);
      dot.hidden = n <= 0;
      letter.classList.toggle('has-unread', n > 0);
      // 「3未读」/「都读过了」—— 都从现成键拼，不新造文案
      countEl.textContent = n > 0 ? String(n) + s('letter.unread') : s('letter.readAll');
    };
    return box;
  }

  /** 仪式卡：每日一问 + 晚安。只在 core/ritual 的 due() 说该给时才出现。 */
  function ritualBlocks() {
    const wrap = document.createElement('div');
    wrap.className = 'el-companion-rituals';

    // —— 每日一问 ——
    const ask = document.createElement('section');
    ask.className = 'el-companion-ritual el-companion-ask';
    ask.hidden = true;

    const askTitle = document.createElement('h2');
    askTitle.className = 'el-companion-ritual-title';
    askTitle.textContent = s('ritual.askTitle');

    const questionEl = document.createElement('p');
    questionEl.className = 'el-companion-ask-question';
    questionEl.hidden = true;

    const form = document.createElement('form');
    form.className = 'el-companion-ask-form';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'el-companion-ask-input';
    input.placeholder = s('ritual.askPlaceholder');
    input.setAttribute('aria-label', s('ritual.askPlaceholder'));

    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'el-primary el-companion-ask-send';
    send.textContent = s('ritual.askAnswer');

    form.append(input, send);

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'el-companion-ask-skip';
    skip.textContent = s('ritual.askSkip');

    const doneEl = document.createElement('p');
    doneEl.className = 'el-companion-ask-done';
    doneEl.textContent = s('ritual.askDone');
    doneEl.hidden = true;

    ask.append(askTitle, questionEl, form, skip, doneEl);

    let answering = false;
    let askHandled = false; // 答过 / 跳过 / 今天的已经给过 —— 同一屏不再弹回来

    async function markAsk(text) {
      const mod = await core('ritual');
      if (mod && typeof mod.markAsk === 'function') {
        try {
          // 契约 §6 的 markAsk(now, text)：把答的话一起存下来，手记里能对上号
          await mod.markAsk(Date.now(), String(text || ''));
        } catch (err) {
          console.warn('[companion] markAsk 失败', err);
        }
      }
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (answering) return;
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      answering = true;
      send.disabled = true;
      try {
        if (typeof props.onAsk === 'function') await props.onAsk(text);
        askHandled = true;
        form.hidden = true;
        skip.hidden = true;
        doneEl.hidden = false;
        await markAsk(text);
      } catch (err) {
        console.warn('[companion] 每日一问发送失败', err);
      } finally {
        answering = false;
        send.disabled = false;
      }
    });

    skip.addEventListener('click', async () => {
      askHandled = true;
      ask.hidden = true;
      await markAsk('');
    });

    // —— 晚安 ——
    const night = document.createElement('section');
    night.className = 'el-companion-ritual el-companion-night';
    night.hidden = true;

    const nightTitle = document.createElement('h2');
    nightTitle.className = 'el-companion-ritual-title';
    nightTitle.textContent = s('ritual.goodnightTitle');

    const nightBody = document.createElement('p');
    nightBody.className = 'el-companion-night-body';
    nightBody.textContent = s('ritual.goodnightBody');

    const nightRow = document.createElement('div');
    nightRow.className = 'el-companion-night-row';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'el-primary el-companion-night-ok';
    okBtn.textContent = s('ritual.goodnightOk');

    const laterBtn = document.createElement('button');
    laterBtn.type = 'button';
    laterBtn.className = 'el-companion-night-later';
    laterBtn.textContent = s('ritual.goodnightLater');

    nightRow.append(okBtn, laterBtn);
    night.append(nightTitle, nightBody, nightRow);

    let nightDismissed = false;

    okBtn.addEventListener('click', async () => {
      if (okBtn.disabled) return;
      okBtn.disabled = true;
      try {
        // 说晚安 = 把这句话真的发出去（Lead 接 props.onSay）
        if (typeof props.onSay === 'function') await props.onSay(nightBody.textContent || '');
        nightDismissed = true;
        night.hidden = true;
        const mod = await core('ritual');
        if (mod && typeof mod.markGoodnight === 'function') {
          try {
            await mod.markGoodnight();
          } catch (err) {
            console.warn('[companion] markGoodnight 失败', err);
          }
        }
      } catch (err) {
        console.warn('[companion] 说晚安失败', err);
      } finally {
        okBtn.disabled = false;
      }
    });

    laterBtn.addEventListener('click', () => {
      nightDismissed = true;
      night.hidden = true;
    });

    wrap.append(ask, night);

    wrap.paint = ({ due, nightText, question }) => {
      const d = due || {};

      if (d.ask && !askHandled) {
        ask.hidden = false;
        const q = String(question || d.question || '').trim();
        questionEl.hidden = !q;
        questionEl.textContent = q;
      } else if (!d.ask) {
        ask.hidden = true;
      }

      if (d.goodnight && !nightDismissed) {
        night.hidden = false;
        const t = String(nightText || '').trim();
        nightBody.textContent = t || s('ritual.goodnightBody');
      } else {
        night.hidden = true;
      }
    };

    return wrap;
  }

  // ── 每块数据各自读、各自 catch：任一块炸了只留它自己空白，其余照常画 ──
  async function readBasics() {
    const [days, mood, rel] = await Promise.all([daysTogether(), currentMood(), relationship()]);
    if (!root) return;
    root._days.paint(days);
    root._mood.paint(mood);
    root._note.paint(mood);
    root._between.setLevel(rel);
  }

  async function readCheckin() {
    const mod = await core('checkin');
    let snap = live.checkin || props.checkin || null;
    if (!snap && mod && typeof mod.read === 'function') {
      try {
        snap = await mod.read();
      } catch (err) {
        console.warn('[companion] 签到数据读取失败', err);
      }
    }
    if (!root || !root._checkin) return;
    root._checkin.paint({ state: snap });
  }

  async function readBond() {
    const mod = await core('bond');
    let bond = props.bond || null;
    if (!bond && mod && typeof mod.readBond === 'function') {
      try {
        bond = await mod.readBond();
      } catch (err) {
        console.warn('[companion] 亲密度读取失败', err);
      }
    }
    let enabled = props.bondEnabled;
    if (enabled === undefined && mod && typeof mod.isEnabled === 'function') {
      try {
        enabled = await mod.isEnabled();
      } catch (err) {
        enabled = true;
      }
    }
    let stage = bond && bond.stage;
    if (!stage && bond && mod && typeof mod.stageOf === 'function') {
      try {
        stage = mod.stageOf(Number(bond.points) || 0);
      } catch (err) {
        stage = null;
      }
    }
    let nextAt;
    if (mod && typeof mod.nextThreshold === 'function' && stage) {
      try {
        nextAt = mod.nextThreshold(stage);
      } catch (err) {
        nextAt = undefined;
      }
    }
    if (!root || !root._bond) return;
    const prog = (bond && bond.progress) || null;
    root._bond.paint({
      points: bond && bond.points,
      stage,
      stageLabel: (bond && bond.stageLabel) || '',
      stageMessages: bond && bond.stageMessages,
      enabled: enabled !== false,
      hasData: !!bond,
      nextAt,
      ratio: prog && prog.ratio,
      remaining: prog && prog.remaining,
    });
  }

  async function readLetters() {
    let unread = Number(props.letterUnread);
    if (!Number.isFinite(unread)) {
      unread = 0;
      const mod = await core('letter');
      if (mod && typeof mod.unreadCount === 'function') {
        try {
          unread = Number(await mod.unreadCount()) || 0;
        } catch (err) {
          console.warn('[companion] 未读数读取失败', err);
        }
      }
    }
    if (!root || !root._entries) return;
    root._entries.paintLetters(unread);
  }

  async function readRitual() {
    const mod = await core('ritual');
    let due = props.ritual || null;
    if (!due && mod && typeof mod.due === 'function') {
      try {
        due = await mod.due();
      } catch (err) {
        console.warn('[companion] 仪式状态读取失败', err);
      }
    }
    let nightText = props.ritualNight || '';
    // 契约 §6 只写了 due/markAsk/markGoodnight；nightRitual 是方案里的文案来源，
    // 有就用（可能是字符串，也可能是 {text}），没有就退回 ritual.goodnightBody。
    if (!nightText && mod && typeof mod.nightRitual === 'function') {
      try {
        const got = await mod.nightRitual();
        nightText = typeof got === 'string' ? got : (got && got.text) || '';
      } catch (err) {
        nightText = '';
      }
    }
    // 每日一问的题面在 core/ritual.js 的 QUESTIONS 里（morningQuestion 按日轮换）；
    // 契约没给这个函数名，所以有就取、没有就留空，卡片只显示标题不显示题面。
    let question = props.ritualQuestion || '';
    if (!question && due && due.ask && mod && typeof mod.morningQuestion === 'function') {
      try {
        question = String(mod.morningQuestion() || '');
      } catch (err) {
        question = '';
      }
    }
    if (!root || !root._ritual) return;
    root._ritual.paint({ due, nightText, question });
  }

  async function refresh() {
    if (busy || !root) return;
    busy = true;
    const jobs = [readBasics(), readCheckin(), readBond(), readLetters(), readRitual()];
    await Promise.all(jobs.map((job) => job.catch((err) => console.warn('[companion] 数据块读取失败', err))));
    busy = false;
  }

  /** 有门槛地更新心情（6 小时内不重复问）。resume 时蹭一次。 */
  async function maybeUpdateMood() {
    const cfg = state && state.config;
    if (!isUsable(cfg)) return { skipped: 'noConfig' };
    const messages = (state && state.snapshot().messages) || [];
    return maybeRecordMood({ config: cfg, messages });
  }

  return {
    id: 'companion',
    mount(el, mountProps = {}) {
      props = mountProps || {};
      root = el;
      el.classList.add('el-scroll-page', 'el-companion-page');

      const hero = document.createElement('div');
      hero.className = 'el-companion-hero';

      const eyebrow = document.createElement('p');
      eyebrow.className = 'el-eyebrow';
      eyebrow.textContent = 'WITH YOU';

      const title = document.createElement('h1');
      title.className = 'el-companion-title';
      title.innerHTML = '今天，<br>也在一起。';

      const portrait = document.createElement('div');
      portrait.className = 'el-companion-portrait';
      const img = document.createElement('img');
      img.src = portraitUrl;
      img.alt = '';
      portrait.append(img);

      hero.append(eyebrow, title, portrait);

      const mood = moodBlock();
      const note = noteCard();
      const checkin = checkinCard();
      const bond = bondCard();
      const between = betweenBlock();
      const entries = entryBar();
      const rituals = ritualBlocks();
      const days = daysBlock();

      el.append(hero, mood, note, checkin, bond, between, entries, rituals, days);

      root._mood = mood;
      root._note = note;
      root._checkin = checkin;
      root._bond = bond;
      root._between = between;
      root._entries = entries;
      root._ritual = rituals;
      root._days = days;

      refresh().then(() => maybeUpdateMood().then(() => refresh()).catch(() => {}));

      return {
        resume() {
          refresh().then(() => maybeUpdateMood().then(() => refresh()).catch(() => {}));
        },
        destroy() {
          root = null;
          props = {};
          live.checkin = null;
        },
      };
    },
  };
}
