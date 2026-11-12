// 设置 · 角色卡（二级页）：现在用的是哪张卡、换一张、改「我自己的补充设定」。
//
// 为什么单独一页而不是塞进「陪伴」页：陪伴页那张卡已经管了称呼/关系/脾气/长短四栏，
// 再挂一套角色卡会变成十几行控件，手机上要滚三屏才看得完。这里只做两件事——选卡、写设定。
//
// 为什么文案写在这个文件里：strings.zh.js 现在有别人在改，先落本地常量表，由 Lead 统一收。
import { readPersona, writePersona } from '../../../core/persona.js';
import { applyLoreSelection, describeCard, listCards, readLoreSelection } from '../../../core/lore.js';
import './settings.css';

const TXT = {
  title: '角色卡',
  subtitle: '她是谁，用哪套设定说话。换卡立刻生效，下一句就用新的。',
  cardTitle: '当前角色卡',
  cardHint: '同一个艾莲，区别在关系走到哪、知道多少。切换只换设定，不动聊天记录。',
  mineTitle: '我自己的补充设定',
  mineHint: '写给她的事实（你的作息、你在做的事、你在意的东西）。这里只写事实，别写「要温柔一点」——语气在上面那栏调。',
  minePlaceholder: '比如：我在做一款手机应用，经常熬到一两点；我不吃香菜；我怕黑。',
  save: '保存',
  clear: '清空',
  saved: '已保存，下一句就用新的。',
  cleared: '已清空。',
  switched: '已换成',
  failPrefix: '没存上：',
  chars: (n) => `${n} 字`,
};

export function createLorePage({ state, onChange } = {}) {
  void state; // 这一页不读全局状态：角色卡与 persona 都在 localStorage 里，读一次就够

  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = TXT.title;
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = TXT.subtitle;
      el.append(title, subtitle);

      // ===== 卡一：当前角色卡 =====
      const cardBox = document.createElement('div');
      cardBox.className = 'el-settings-card';
      const cardHead = document.createElement('div');
      cardHead.className = 'el-settings-card-head';
      const cardTitle = document.createElement('div');
      cardTitle.className = 'el-settings-card-title';
      cardTitle.textContent = TXT.cardTitle;
      const cardStatus = document.createElement('div');
      cardStatus.className = 'el-settings-status';
      cardHead.append(cardTitle, cardStatus);
      const cardHint = document.createElement('div');
      cardHint.className = 'el-settings-card-hint';
      cardHint.textContent = TXT.cardHint;

      // 用分段按钮而不是下拉：卡片总共两张，摆出来一眼能对比
      const segs = document.createElement('div');
      segs.className = 'el-settings-segments';
      const cardButtons = listCards().map((card) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-settings-segment';
        b.dataset.card = card.id;
        b.textContent = card.label;
        segs.append(b);
        return b;
      });

      const cardDesc = document.createElement('div');
      cardDesc.className = 'el-settings-note';
      cardBox.append(cardHead, cardHint, segs, cardDesc);

      // ===== 卡二：我自己的补充设定（= persona.note）=====
      const mineBox = document.createElement('div');
      mineBox.className = 'el-settings-card';
      const mineHead = document.createElement('div');
      mineHead.className = 'el-settings-card-head';
      const mineTitle = document.createElement('div');
      mineTitle.className = 'el-settings-card-title';
      mineTitle.textContent = TXT.mineTitle;
      const mineStatus = document.createElement('div');
      mineStatus.className = 'el-settings-status';
      mineHead.append(mineTitle, mineStatus);
      const mineHint = document.createElement('div');
      mineHint.className = 'el-settings-card-hint';
      mineHint.textContent = TXT.mineHint;

      const mineField = document.createElement('div');
      mineField.className = 'el-settings-field';
      // 不再要一行内 label：卡片标题已经写了「我自己的补充设定」，
      // 再写一遍就是同一句话说两次（首屏截图里那处重复）。
      const mineInput = document.createElement('textarea');
      mineInput.className = 'el-settings-input el-settings-textarea';
      mineInput.rows = 6; // 多行：设定本来就不是一句话，3 行写两条就滚
      mineInput.maxLength = 400; // 和陪伴页那一栏同一个上限，免得同一个字段两个页面上限不同
      mineInput.placeholder = TXT.minePlaceholder;
      mineInput.setAttribute('aria-label', TXT.mineTitle);
      mineField.append(mineInput);

      const row = document.createElement('div');
      row.className = 'el-settings-row';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'el-settings-btn';
      saveBtn.textContent = TXT.save;
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'el-settings-btn is-ghost';
      clearBtn.textContent = TXT.clear;
      row.append(saveBtn, clearBtn);

      const mineMsg = document.createElement('div');
      mineMsg.className = 'el-settings-note';

      mineBox.append(mineHead, mineHint, mineField, row, mineMsg);
      el.append(cardBox, mineBox);

      // ===== 状态与绘制 =====
      let persona = readPersona();
      let selection = readLoreSelection();

      function paintCards() {
        const active = describeCard(selection.cardId);
        cardStatus.textContent = `${active.label} · ${active.tag}`;
        for (const b of cardButtons) b.classList.toggle('is-active', b.dataset.card === active.id);
        cardDesc.textContent = active.summary || '';
      }

      function paintNote() {
        mineInput.value = persona.note || '';
        mineStatus.textContent = TXT.chars((persona.note || '').length);
      }

      for (const b of cardButtons) {
        b.addEventListener('click', () => {
          try {
            selection = applyLoreSelection({ cardId: b.dataset.card });
          } catch (err) {
            mineMsg.textContent = `${TXT.failPrefix}${err?.message || err}`;
            return;
          }
          paintCards();
          // 让外层（设置首页的状态摘要 / 聊天页）有机会刷新；没传就当无事发生
          if (typeof onChange === 'function') {
            try { onChange({ lore: selection.cardId }); } catch { /* 外层刷新失败不该打断切卡 */ }
          }
          cardDesc.textContent = `${TXT.switched}${describeCard(selection.cardId).label}。${describeCard(selection.cardId).summary || ''}`;
        });
      }

      // 输入即存：跟陪伴页的称呼栏一致（都是本地字段，没有保存成本）。
      // 不这样做的话，用户写完直接返回上一层就会以为存上了。
      mineInput.addEventListener('input', () => {
        persona = writePersona({ note: mineInput.value.slice(0, 400) });
        mineStatus.textContent = TXT.chars(persona.note.length);
        mineMsg.textContent = '';
      });

      saveBtn.addEventListener('click', () => {
        persona = writePersona({ note: mineInput.value.slice(0, 400) });
        paintNote();
        mineMsg.textContent = TXT.saved;
      });

      clearBtn.addEventListener('click', () => {
        persona = writePersona({ note: '' });
        paintNote();
        mineMsg.textContent = TXT.cleared;
      });

      paintCards();
      paintNote();

      // 横屏两栏：多列流只能挂在块容器上，标题留在外面通栏（跟其它设置页同一套）。
      const flow = document.createElement('div');
      flow.className = 'el-settings-flow';
      for (const node of [...el.children]) {
        if (node === title) continue;
        flow.append(node);
      }
      el.append(flow);
    },
  };
}
