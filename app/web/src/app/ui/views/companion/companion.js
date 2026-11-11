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

export function createCompanionView({ state }) {
  let root = null;
  let busy = false;

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
    mail.append(iconEl('mail'));
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

  async function refresh() {
    if (busy || !root) return;
    busy = true;
    try {
      const [days, mood, rel] = await Promise.all([daysTogether(), currentMood(), relationship()]);
      root._days.paint(days);
      root._mood.paint(mood);
      root._note.paint(mood);
      root._between.setLevel(rel);
    } catch (err) {
      console.error('[companion] 读取失败', err);
    } finally {
      busy = false;
    }
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
    mount(el) {
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
      const between = betweenBlock();
      const days = daysBlock();

      el.append(hero, mood, note, between, days);

      root._mood = mood;
      root._note = note;
      root._between = between;
      root._days = days;

      refresh().then(() => maybeUpdateMood().then(() => refresh()).catch(() => {}));

      return {
        resume() {
          refresh().then(() => maybeUpdateMood().then(() => refresh()).catch(() => {}));
        },
        destroy() {
          root = null;
        },
      };
    },
  };
}
