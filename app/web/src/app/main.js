// 应用装配：建外壳（顶栏 / 页面容器 / 底栏），注入依赖，把控制权交给 router。
//
// 这一层的职责边界（§6.5）：
//   - 认识 router 和各视图 → 装配
//   - 认识原生插件（通过 core/native/bridge.js）→ 只在这里和 core 层出现
//   - 视图本身不碰插件、不发请求，只通过 props 回调往上报
import './styles/tokens.css';
// 批 0：绝区零令牌层。只在 .ellen-app 带 data-skin="zzz" 时生效，
// 不挂属性 = 下面一个字节都不参与计算。
import './styles/zz-tokens.css';
import './styles/base.css';
// 批 1 / 批 2 / 批 2.5：骨架层、器件层、壁纸层（同上，全靠 data-skin 开关）。
// 顺序：令牌 → base 兜底 → 皮肤层压在上面（同级选择器时皮肤赢）。
import './styles/zz-frame.css';
import './styles/zz-parts.css';
import './styles/zz-wall.css';
// 批 3：抽屉外壳（记忆 / 相处 / 设置不再换根页面）
import './styles/zz-drawer.css';
// 批 4：动效层（七条节拍 + 降级链）
import './styles/zz-motion.css';

import { s } from './strings.zh.js';
import { iconEl } from './ui/icons.js';
import { call, isNative } from './core/native/bridge.js';
import { defineView, mountRouter, show, push, pop, current, currentName } from './ui/router.js';
import { createDrawer } from './ui/frame-drawer.js';
import { installAndroidBack, minimizeApp, registerBack, requestBack, backChain } from './core/back-stack.js';
import { initMotionGuard } from './ui/motion-guard.js';
import { createChatView } from './ui/views/chat/chat.js';
import { createPlaceholderView } from './ui/views/placeholder.js';
import { createWelcomeView } from './ui/views/welcome/welcome.js';
import { shouldOnboard } from './core/onboarding.js';
import { createMemoryView } from './ui/views/memory/memory.js';
import { createHistoryView } from './ui/views/history/history.js';
import { createJournalView } from './ui/views/journal/journal.js';
import { createFeedbackView } from './ui/views/feedback/feedback.js';
import { readPrefs as readVoicePrefs, maybeClip, writePrefs as writeVoicePrefs, speak as speakOut, stop as stopSpeech, plain as plainVoice } from './core/speech.js';
import { createCompanionView } from './ui/views/companion/companion.js';
import { createAppState } from './core/state.js';
import { createChatSession } from './core/chat/session.js';
import { recall } from './core/chat/recall.js';
import { createSettingsView } from './ui/views/settings/settings.js';
import { createModelPage } from './ui/views/settings/page-model.js';
import { createVoicePage } from './ui/views/settings/page-voice.js';
import { createBackupPage } from './ui/views/settings/page-backup.js';
import { createCompanionPage } from './ui/views/settings/page-companion.js';
// 新一轮补齐的三个全屏页（E 组）：信 / 星图 / 徽章
import { createLetterView } from './ui/views/letter/letter.js';
import { createStarmapView } from './ui/views/starmap/starmap.js';
import { createAchievementsView } from './ui/views/achievements/achievements.js';
import { createAboutPage } from './ui/views/settings/page-about.js';
import { ensureConfigured as ensureUpdateConfigured } from './core/updates.js';
import {
  importSnapshot,
  verifyImport,
  rebuildHeads,
  parseManifest,
  splitArchive,
  extractSnapshot,
} from './core/store/import.js';
import { dropDb } from './core/store/db.js';
import { pushMaterial, takePending, readState as readProactiveState } from './core/proactive.js';
import { maybeCompose as maybeWriteJournal, dueFor as journalDue, todayJournal, dayKey } from './core/journal.js';
import { maybeRemember, rememberNow, dueFor as memoryDue, readMemoryPrefs } from './core/memory.js';
import { setThread as setBackgroundThread, takeChatReply } from './core/background.js';
import { loadConfig as loadAsrConfig, isUsable as asrUsable, transcribe as transcribeAudio } from './core/asr.js';
import { createVoiceInput } from './core/voice-input.js';
import { prepareVoice, pruneVoices, voiceStorage } from './core/voice-message.js';
import { readPersona, writePersona, buildSystemPrompt } from './core/persona.js';
import { buildManifest } from './core/store/export.js';
import { configure as backupConfigure } from './core/backup.js';
import { autoRun as autoBackup, state as backupState, due as backupDue, run as runBackupOnce } from './core/backup.js';
import { readChatPrefs, writeChatPrefs } from './core/chatprefs.js';
import { relationship } from './core/companion.js';
// —— 本轮补齐（2026-11-12）——
import { migrateAll } from './core/store/migrate.js';
import { snapshot as bondSnapshot, touchMessage as bondTouch, onChange as onBondChange, STAGES as BOND_STAGES, markLetterWritten } from './core/bond.js';
import { unreadCount as letterUnread, listLetters, writeLetter, canWrite as letterCanWrite, markRead as markLetterRead } from './core/letter.js';
import { doCheckin, readCheckin } from './core/checkin.js';
import {
  checkAll as checkAchievements,
  list as listAchievements,
  progress as achievementsProgress,
  onUnlock as onAchievementUnlock,
  DEFS as ACH_DEFS,
} from './core/achievements.js';
import { due as ritualDue, markAsk, markGoodnight, morningQuestion, nightRitual } from './core/ritual.js';
import { buildStarmap, dayEvents } from './core/starmap.js';
import { extractTone, toneEnabled, toneToRate, toneLineOf, styleOf } from './core/tone.js';
import { pickStickerReply, replyDelay, slotOf } from './core/sticker-reply.js';
// E4：情绪接线。数值层（affect）→ 事件层（affect-events）→ 提示词/语气/表情
import { loadAffect, saveAffect, effectiveDesire, derivedMood } from './core/affect.js';
import { applyNeglect, applyUtterance, attachToPrompt } from './core/affect-events.js';
import { createAffectPage } from './ui/views/settings/page-affect.js';
import { createLorePage } from './ui/views/settings/page-lore.js';
import { createCallView } from './ui/views/call/call.js';
import { createCallSettingsPage } from './ui/views/settings/page-call.js';
import { pickImage as pickMediaImage, saveToAlbum as saveMediaToAlbum } from './core/media.js';

const THEME_KEY = 'ellen-ui-theme';

function bootError(err) {
  const box = document.createElement('pre');
  box.id = 'ellen-boot-error';
  box.textContent = `启动失败：\n${(err && (err.stack || err.message)) || String(err)}`;
  document.body.appendChild(box);
  console.error('[ellen] boot failed', err);
}

function applyTheme(root, theme) {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略 */
  }
  // 原生侧同步状态栏/导航栏图标明暗与窗口底色
  if (isNative()) {
    call('EllenScreenShell', 'setAppearance', { theme }).catch((err) => {
      console.warn('[ellen] setAppearance 失败', err);
    });
  }
}

function buildShell(root) {
  root.innerHTML = '';

  // —— 顶栏 ——
  const header = document.createElement('header');
  header.className = 'el-chat-header';

  const brand = document.createElement('button');
  brand.type = 'button';
  brand.className = 'el-brand icon-only';
  brand.textContent = s('app.name');
  brand.setAttribute('aria-label', s('header.back'));

  // 顶栏只留一个「⋯」：五个工具收进下拉里。
  // 为什么：五个 25u 图标在 360 CSS 宽下挤成一排，既难点（命中区 25px）又抢了标题的位置；
  // 评审也指出「一排五个图标」是典型的 AI 味排法。收进菜单后每个条目是 40u 高的整行，好点也好认。
  const tools = document.createElement('div');
  tools.className = 'el-header-tools';

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'el-round icon-only el-header-tool is-more';
  moreBtn.dataset.act = 'more';
  moreBtn.setAttribute('aria-label', s('header.more'));
  moreBtn.append(iconEl('more'));
  tools.append(moreBtn);

  const menu = document.createElement('div');
  menu.className = 'el-header-menu';
  menu.hidden = true;
  const menuList = document.createElement('div');
  menuList.className = 'el-header-menu-list';
  menu.append(menuList);

  const toolDefs = [
    { key: 'header.background', icon: 'background', act: 'background' },
    { key: 'header.appearance', icon: 'appearance', act: 'appearance' },
    { key: 'header.history', icon: 'history', act: 'history' },
    { key: 'header.notices', icon: 'notices', act: 'notices' },
    { key: 'header.settings', icon: 'settings', act: 'settings' },
  ];
  const toolButtons = {};
  for (const def of toolDefs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'el-header-menu-item';
    if (def.act === 'appearance') btn.classList.add('el-chat-palette');
    btn.dataset.act = def.act;
    const label = document.createElement('span');
    label.className = 'el-header-menu-label';
    label.textContent = s(def.key);
    btn.append(iconEl(def.icon, 'el-icon'), label);
    menuList.appendChild(btn);
    toolButtons[def.act] = btn;
  }
  header.append(brand, tools);

  // —— 页面容器 ——
  const pages = document.createElement('div');
  pages.className = 'el-pages';

  // —— 底栏 ——
  const nav = document.createElement('nav');
  nav.className = 'el-nav';
  const tabDefs = [
    { name: 'chat', key: 'nav.chat', icon: 'chat' },
    { name: 'memory', key: 'nav.memory', icon: 'memory' },
    { name: 'companion', key: 'nav.companion', icon: 'companion' },
    { name: 'settings', key: 'nav.settings', icon: 'settings' },
  ];
  const tabButtons = new Map();
  for (const def of tabDefs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'el-nav-item';
    btn.dataset.tab = def.name;
    const icon = iconEl(def.icon, 'el-nav-icon el-icon');
    const label = document.createElement('span');
    label.textContent = s(def.key);
    btn.append(icon, label);
    nav.appendChild(btn);
    tabButtons.set(def.name, btn);
  }

  root.append(header, pages, nav, menu);

  function setMenu(open) {
    menu.hidden = !open;
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    moreBtn.classList.toggle('is-open', !!open);
  }
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(menu.hidden);
  });
  menu.addEventListener('click', (e) => {
    // 条目自己会做事；点空白就关
    if (e.target === menu) setMenu(false);
  });
  for (const btn of Object.values(toolButtons)) {
    btn.addEventListener('click', () => setMenu(false));
  }
  document.addEventListener('pointerdown', (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || moreBtn.contains(e.target)) return;
    setMenu(false);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) setMenu(false);
  });

  return { header, pages, nav, menu, brand, moreBtn, toolButtons, tabButtons, setMenu };
}

async function main() {
  const root = document.getElementById('app');
  if (!root) throw new Error('缺少 #app 容器');

  // 皮肤开关（批 1 起默认开）：不挂 data-skin 就是旧外观。
  //   - 默认：挂 data-skin="zzz" → 绝区零骨架/器件/壁纸
  //   - 回退：?skin=legacy 或手动删掉 .ellen-app 上的 data-skin 属性
  //   - 时段（--z-status 状态词 + 壁纸档）：CSS 算不出钟点，这里补一行
  //     root.dataset.slot = hour < 11 ? 'morning' : hour < 18 ? 'tram' : 'night'
  try {
    const want = new URLSearchParams(location.search).get('skin');
    if (want !== 'legacy') root.dataset.skin = 'zzz';
    // 时段：早晨 / 傍晚 / 深夜三档，CSS 里 --z-* 已经为三档写好壁纸与状态词，
    // 只有钟点这种运行时事实必须在这里算。跨档时不刷新页面就不变（够用，别为它加定时器）。
    const hour = new Date().getHours();
    root.dataset.slot = hour < 11 ? 'morning' : hour < 18 ? 'tram' : 'night';
  } catch {
    root.dataset.skin = 'zzz';
  }

  const shell = buildShell(root);
  const appState = createAppState();

  // 主题：先恢复上次选择，再跑起来
  let theme = 'dark';
  try {
    theme = localStorage.getItem(THEME_KEY) || 'dark';
  } catch {
    /* 忽略 */
  }
  applyTheme(root, theme);

  // 情绪状态缓存：一条消息里要读两次（拼 prompt + 记事件），5 秒内复用同一份，
  // 免得同一句话 settle 两遍、也免得两次落盘互相覆盖。
  let affectCache = null; // {state, at}
  async function takeAffect({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && affectCache && now - affectCache.at < 5000) return affectCache.state;
    try {
      const state = await loadAffect({ now, persist: false });
      affectCache = { state, at: now };
      return state;
    } catch (err) {
      console.warn('[main] 情绪状态没读出来，这轮不加注入块', err);
      return null;
    }
  }

  /**
   * 七维派生的心情词 → 表情 slot。
   *
   * 为什么要翻一层：derivedMood() 吐的是「想要你 / 在忍着 / 盯着你」这种处境词，
   * 表情库的 slot 是「比心 / 生气 / 问号」。不翻，shouldAutoKeep 里 mood===slot 那半条
   * （+0.5）永远不成立，自动收藏等于只有 0.15 的底分。
   * 翻不出来就留空 —— 宁可不自动收藏，也不要按错的心情乱收。
   */
  const MOOD_SLOT = {
    想要你: '比心',
    耐不住了: '比心',
    心痒着: '比心',
    想被抱: '比心',
    在忍着: '生气',
    盯着你: '问号',
  };
  // 聊天页 props.mood 读的是这个（getter），每次长按她那张表情时才取当前值
  let moodSlotNow = '';
  function updateMoodSlot(state) {
    try {
      const d = derivedMood(state);
      moodSlotNow = (d && MOOD_SLOT[d.mood]) || '';
    } catch (err) {
      moodSlotNow = '';
    }
  }

  /**
   * 一句话进模型之前先记账：读状态 → 补算「被晾着」 → 归类这句话 → 落盘。
   *
   * 为什么必须在这条路上同步做完：prompt 里要用的是「这句话之后」的状态
   * （他说了想要，那她这一刻就该是想要的，不能等回复回来才生效）；
   * 而且安卓没有常驻进程，读时结算的结果不落盘，关掉 App 这段就白算了。
   * 分类走本地关键词表（affect-events.classify），**不为每条消息多花一次请求**。
   */
  async function touchAffect(text) {
    const now = Date.now();
    try {
      const state = await loadAffect({ now, persist: false });
      applyNeglect(state, { now });
      const hit = applyUtterance(state, text, { now });
      if (hit && (hit.type || hit.safeWord)) {
        console.info('[affect]', hit.safeWord ? '安全词' : hit.type, hit.hit || '', hit.deltas || {});
      }
      await saveAffect({ state });
      affectCache = { state, at: now };
      return state;
    } catch (err) {
      console.warn('[main] 情绪没记上，这次照常回', err);
      return null;
    }
  }

  // 人设每轮现取：设置页改完立刻生效，不用重开会话。
  // E4：人格提示后面再拼两段 ——「此刻」的处境（注入块）与语气/长度约束。
  // 注入块读不出来只降级成旧行为（只发人格提示），绝不给模型一段空串。
  async function currentSystemPrompt(opts) {
    const [persona, relation] = await Promise.all([readPersona(), relationship()]);
    // query 只用来命中世界书：把用户这句话当检索词，命中不到就只剩常驻卡（不报错、不空转）
    const query = (opts && opts.query) || '';
    const base = buildSystemPrompt({ persona, relationship: relation, lore: query ? { query } : undefined });
    const st = await takeAffect();
    if (!st) return base;
    // 顺手把「此刻心情」翻成表情 slot，给聊天页的自动收藏用（见 MOOD_SLOT）
    updateMoodSlot(st);
    let styleLine = '';
    try {
      styleLine = [toneLineOf(st.dims), styleOf(st.dims).line].filter(Boolean).join('\n');
    } catch (err) {
      console.warn('[main] 语气/长度没算出来，这次只带注入块', err);
    }
    return attachToPrompt(base, st, { styleLine });
  }

  const session = createChatSession({ state: appState, getSystemPrompt: currentSystemPrompt });

// 引用状态：聊天页记着「正在回哪一条」，键盘回车路径不会带 extra，靠它补进下一条消息
let quotedOf = null;
// 她回表情的定时器：连着发表情时不叠一串，后一张覆盖前一张
let replyTimer = null;

/** 阶段 id → 中文名（界面提示用，不参与判定）。 */
function stageLabel(id) {
  const found = (Array.isArray(BOND_STAGES) ? BOND_STAGES : []).find((x) => x && (x.id === id || x.key === id));
  return (found && (found.label || found.name)) || { acquainted: '相识', familiar: '熟悉', trusted: '信赖', close: '亲近', lover: '恋人' }[id] || '相识';
}

// 写信状态：生成期间相处页/信页要能显示「她正在写信…」和字数递增
let letterWriting = null; // { chars, target, at } | null
let letterBusy = false;

// 解锁一枚徽章就轻提示一句（弹窗太重，这里用现有的 flash 条）
onAchievementUnlock((ev) => {
  const def = (Array.isArray(ACH_DEFS) ? ACH_DEFS : []).find((d) => d && d.id === (ev && ev.id));
  const name = (def && (def.title || def.name)) || '';
  flash(name ? `${s('ach.popupTitle')} · ${name}` : s('ach.popupTitle'));
});

/**
 * 写一封信。亲密度升阶时自动调，相处页的「让她写一封」也走这里。
 * 硬要求：正文不低于 1500 字（恋人 3000），不够字数 letter.js 会自己重写一次。
 * @param {string} [stage] 升阶到哪一档（触发时传，重写按钮不传）
 * @param {{force?: boolean}} [opts]
 */
async function maybeWriteLetter(stage = null, opts = {}) {
  if (letterBusy) return null;
  let snap = null;
  try {
    snap = await bondSnapshot();
  } catch (err) {
    console.warn('[main] 读亲密度失败，这次不写信', err);
    return null;
  }
  if (!opts.force && stage && snap && snap.lastLetterStage === stage) return null;
  letterBusy = true;
  letterWriting = { chars: 0, target: snap && snap.stage === 'lover' ? 3000 : 1500, at: Date.now() };
  try {
    // 不占聊天流：只给她一句轻提示，信落在「信」页里
    flash(s('letter.writing'));
    const res = await writeLetter({
      config: appState.getConfig(),
      persona: await readPersona(),
      bond: snap,
      onDelta: (delta) => {
        if (!delta) return;
        if (delta.reset) letterWriting = { ...(letterWriting || {}), chars: 0 };
        else letterWriting = { ...(letterWriting || {}), chars: delta.chars || 0 };
        // 信页正开着就把字数推过去（没开着就等下次刷新拿最后状态）
        if (letterHandle && typeof letterHandle.setWriting === 'function') {
          try {
            letterHandle.setWriting(letterWriting);
          } catch (err) {
            console.warn('[main] 写信进度没推进视图', err);
          }
        }
      },
      force: !!opts.force,
    });
    flash(res && res.short ? s('letter.short') : s('letter.noticeInChat'));
    if (res && res.stage) {
      try {
        await markLetterWritten(res.stage, Date.now());
      } catch (err) {
        console.warn('[main] 写信标记没落库', err);
      }
    }
    return res;
  } catch (err) {
    if (err && err.code === 'ALREADY_WRITTEN' && !opts.force) return null;
    flash(s('letter.writeFail'));
    console.warn('[main] 信没写成', err);
    return null;
  } finally {
    letterBusy = false;
    letterWriting = null;
  }
}

// 发一句话（键盘回车和语音转写共用这一条路，别再复制一遍）
function sendMessage(text, extra = null, opts = null) {
  const clean = (text || '').trim();
  // imageTurn：这一轮就是「发了一张图」，没有正文。图已经在消息库里，视觉块会自己去取。
  const imageTurn = !!(opts && opts.imageTurn);
  if (!clean && !imageTurn) return Promise.resolve();
  // 引用：聊天页记着「正在回哪一条」，键盘回车路径不会带 extra，这里补上
  const payload = extra || (quotedOf ? { quoteOf: quotedOf } : null);
  quotedOf = null;
  const sendOpts = imageTurn ? { imageTurn: true, appendUser: false } : {};
  // 先记情绪再发：prompt 里要的是「这句话之后」的状态。记不上也照常发（她不能因此不说话）
  const touched = clean ? touchAffect(clean) : Promise.resolve();
  return touched.then(() => session.send(clean, payload, sendOpts)).then(() => {
    // 亲密度计点：每条 +1、每天首条 +3，凑够阈值她会升一档并发一封信
    bondTouch({ at: Date.now() })
      .then((res) => {
        if (res && res.upgraded) {
          flash(`你们到「${stageLabel(res.stage)}」了。`);
          maybeWriteLetter(res.stage).catch((err) => console.warn('[main] 升阶信没写成', err));
        }
        return checkAchievements();
      })
      .catch((err) => console.warn('[main] 亲密度没记上', err));
    // 每轮聊完顺手看看该不该写手记；不 await 到界面路径上，失败也不影响聊天
    maybeWriteJournal({ config: appState.getConfig(), messages: appState.getMessages() }).catch((err) =>
      console.warn('[main] 手记没写成', err)
    );
    // 顺手看看有没有「值得记住的事」（门槛见 core/memory.js：4 条新消息 + 20 分钟间隔）
    maybeRemember({ config: appState.getConfig(), messages: appState.getMessages() }).catch((err) =>
      console.warn('[main] 记忆没写成', err)
    );
    // 开了「她说完就念」就把这一句读出来（读不出来不影响聊天）
    maybeReadAloud();
    // 开了「随机语音条」，偶尔给这一条挂个语音条（1/7）
    maybeAttachClip();
  });
}

  // 随机语音条：把最后一条她说的话标上 voice，聊天页据此画一条可点的语音条
  function maybeAttachClip() {
    if (!maybeClip()) return;
    const list = appState.getMessages();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (m.role !== 'assistant' || m.pending || m.failed) continue;
      if (!String(m.text || '').trim()) return;
      if (m.voice) return;
      appState.updateMessage(m.id, { voice: true });
      return;
    }
  }

  // —— 朗读 ——
  // 只念她的话，不念自己的；纯文本化后再喂引擎，省得念出星号。
  // 轻提示：一行字，2.6 秒自己走。语音这类「说一句话失败了」用它，不占页面空间。
  let toastTimer = 0;
  function flash(text) {
    if (!text) return;
    let node = document.querySelector('.el-toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'el-toast';
      document.getElementById('app').append(node);
    }
    node.textContent = text;
    node.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('is-on'), 2600);
  }

  // —— 语音输入（按住说话）+ 语音消息 ——
  // 手势与状态机全在 core/voice-input.js；这里只负责「录完这段怎么处理」：
  //   落盘 → 转写（失败不抛）→ 算波形 → 带着转写文本发出去，气泡只显示波形。
  // 转写失败也要发：不能让一次识别失败把你说的那句话吞掉；她收到「没听清」会反问。
  let voiceBusy = false;
  // 切到语音态就把麦克风权限要到：否则第一次按下去会先卡在「在等系统弹权限…」，
  // 要等人点完弹窗才开始录。只问一次（问过就记住，避免每次切页都弹）。
  let micAsked = false;
  async function ensureMicPermission() {
    if (micAsked || !isNative()) return;
    micAsked = true;
    try {
      const res = await call('EllenAudio', 'requestPermission');
      if (res && res.granted === false) flash('要在系统里给录音权限，才能按住说话。');
    } catch (err) {
      // 原生还没上这个方法（老包）就静默退回「按下时再问」，不影响功能
      console.warn('[main] 预请求麦克风权限失败', err);
    }
  }

  async function commitVoice({ base64, durationMs }) {
    if (!base64 || voiceBusy) return;
    voiceBusy = true;
    try {
      if (!chatHandle) return;
      chatHandle.setVoiceState({ phase: 'writing', ms: durationMs, cancel: false });
      let prepared = null;
      try {
        prepared = await prepareVoice({ base64, durationMs });
      } catch (err) {
        const code = (err && err.code) || '';
        flash(code === 'DOCUMENT_TOO_LARGE' ? '这段太长，存不下。' : `这条语音没存上：${(err && err.message) || ''}`);
        return;
      }
      await sendMessage(prepared.speech.text, prepared);
    } finally {
      voiceBusy = false;
      if (chatHandle) chatHandle.setVoiceState({ phase: 'idle', ms: 0, cancel: false });
    }
  }

  const voiceInput = createVoiceInput({
    onCommit: (payload) => {
      commitVoice(payload).catch((err) => console.warn('[main] 语音消息没发出去', err));
    },
    onCancel: () => {
      if (chatHandle) chatHandle.setVoiceState({ phase: 'idle', ms: 0, cancel: false });
    },
    onError: (err) => {
      const code = (err && err.code) || '';
      if (code === 'VOICE_TOO_SHORT') flash(s('chat.voiceTooShort'));
      else if (code === 'AUDIO_PERMISSION') flash('要在系统里给录音权限。');
      else flash(`${s('chat.voiceFailed')}${(err && err.message) || ''}`);
    },
  });

  // 返回键第 60 层：录音/听写中按返回只取消，不导航（防误触把正在说的话弄丢）
  registerBack(
    () => {
      const st = voiceInput.state();
      if (!st || st.phase === 'idle') return false;
      voiceInput.cancel();
      return true;
    },
    { priority: 60, name: 'voice-input' },
  );

  function maybeReadAloud() {
    if (!readVoicePrefs().auto) return;
    const list = appState.getMessages();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m || m.role !== 'assistant' || m.pending || m.failed) continue;
      const body = plainVoice(m.text);
      if (body) {
        // 语气标注：她在气泡里写了「（轻声）」，念的时候也要轻声，不然白标了
        const opts = {};
        if (toneEnabled() && m.tone) {
          try {
            const tone = toneToRate(m.tone) || {};
            const base = Number(readVoicePrefs().rate) || 1;
            if (typeof tone.rate === 'number') opts.rate = Math.max(0.5, Math.min(2, base * tone.rate));
            if (typeof tone.pitch === 'number') opts.pitch = tone.pitch;
          } catch (err) {
            console.warn('[main] 语气换算失败，按默认念', err);
          }
        }
        speakOut(body, opts).catch((err) => console.warn('[main] 朗读失败', err));
      }
      return;
    }
  }

  // —— 聊天页长按菜单的四个后端动作 ——
  /** 把一条消息压成引用块（只留 80 字，正文太长会把引用条撑爆）。 */
  function quoteData(msg) {
    if (!msg) return null;
    return {
      headId: msg.headId || msg.id || null,
      role: msg.role === 'user' ? 'user' : 'assistant',
      text: String(msg.text || '').trim().slice(0, 80),
      createdAt: msg.createdAt || Date.now(),
    };
  }

  /** 点引用条：跳回原消息；原消息已经不在了就给一句轻提示。 */
  function showQuote(quote) {
    const key = quote && (quote.headId || quote.id);
    if (!key) return;
    const hit = appState.getMessages().find((m) => m.headId === key || m.id === key);
    if (hit && chatHandle && typeof chatHandle.scrollToMessage === 'function') chatHandle.scrollToMessage(hit.id);
    else flash(s('msg.quoteMissing'));
  }

  /** 重新生成：把这条她的回复标成撤回，用它前面那句话再问一次（不再落一条「我说的」）。 */
  async function regenerateReply(id) {
    const list = appState.getMessages();
    const idx = list.findIndex((m) => m.id === id || m.headId === id);
    if (idx < 0) return;
    let ask = '';
    for (let i = idx - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (m.role === 'user' && !m.pending && String(m.text || '').trim()) {
        ask = m.text;
        break;
      }
    }
    if (!ask) {
      flash(s('msg.quoteMissing'));
      return;
    }
    // 同一个问题不挂两份答案：旧的先撤回（原文留在库里，不删）
    await appState.recallMessage(list[idx].id);
    await session.send(ask, null, { appendUser: false });
  }

  /** 选图 → 落一条图片消息（图片不进模型上下文，气泡只给人看）。 */
  async function addPickedImage(picked) {
    let res = picked;
    if (!res) {
      try {
        res = await pickMediaImage({ maxSide: 1600 });
      } catch (err) {
        console.warn('[main] 选图失败', err);
        flash(s('msg.imageLoadFail'));
        return;
      }
    }
    if (!res || res.picked === false) return;
    appState.addMessage({
      role: 'user',
      type: 'image',
      text: '',
      image: {
        path: res.uri || res.name || '',
        name: res.name || '',
        uri: res.uri || '',
        src: res.src || '',
        width: res.width || 0,
        height: res.height || 0,
        size: res.bytes || res.size || 0,
        mime: res.mimeType || res.mime || '',
      },
    });
    // 选完就发：老大要的是「点相册 → 选一张 → 她马上看见」，不该再多一步点发送。
    // 这里不带正文（imageTurn），图已经在上面那条消息里，session 的视觉块会把它送出去。
    sendMessage('', null, { imageTurn: true }).catch((err) => console.warn('[main] 图片没发出去', err));
  }

  /**
   * 发表情：表情包是包内素材，不落文件、不走网络，只把 stickerId 记进消息。
   * 发表情不触发模型调用 —— 甩个表情过去，她不用再回一段话。
   */
  function sendSticker(sticker) {
    if (!sticker || !sticker.id) return;
    appState.addMessage({ role: 'user', type: 'expression', text: '', stickerId: sticker.id });
    // 你甩一张过来，她有一半多一点的概率也回一张 —— 不是每次都回，那样太吵。
    // 走本地规则挑图（收藏的 12 张里选），不为挑一张图多发一次请求。
    // E4：好感决定挑哪一组 —— 高走 SAFE（比心/晚安），低走 ECHO（委屈/无语）。
    // 没有缓存就不传，退回旧行为（谁在场挑谁），不为了挑图去读一次库。
    const aff = affectCache && affectCache.state ? affectCache.state.dims.affection : undefined;
    const back = pickStickerReply({ incomingSlot: slotOf(sticker.id), affection: aff });
    // 甩个表情也算在场：推一下 lastEventAt，别让她把「发表情」当成没理她
    touchAffect('');
    if (replyTimer) {
      clearTimeout(replyTimer);
      replyTimer = null;
    }
    if (!back) return;
    replyTimer = setTimeout(() => {
      replyTimer = null;
      appState.addMessage({ role: 'assistant', type: 'expression', text: '', stickerId: back.id });
    }, replyDelay());
  }

  /** 图片气泡长按「保存到相册」。 */
  async function saveImageToAlbum(image) {
    if (!image) return;
    flash(s('msg.imageSaving'));
    try {
      const res = await saveMediaToAlbum({
        name: image.name || image.path,
        mimeType: image.mime || image.mimeType || '',
      });
      if (res && res.saved) flash(s('msg.imageSaved'));
      else flash(`${s('msg.imageSaveFail')}${(res && res.code) || ''}`);
    } catch (err) {
      flash(`${s('msg.imageSaveFail')}${(err && err.message) || ''}`);
    }
  }

  // —— 视图注册 ——
  let chatHandle = null;

  defineView('chat', () => {
    const view = createChatView();
    return {
      mount(el, props) {
        const handle = view.mount(el, {
          messages: appState.getMessages(),
          model: appState.getModelName(),
          // 心情 → 表情 slot，给「她发的表情值不值得自动收藏」用；getter 保证取的是当下而不是挂载时
          get mood() {
            return moodSlotNow;
          },
          onSend: (text, extra) => sendMessage(text, extra),
          onStop: () => session.stop(),
          // —— 长按菜单的五个出口（缺哪个，聊天页就不显示哪一项）——
          // 撤回：窗口（120 秒）由聊天页判，这里只管写库；返回 value|null
          onRecall: (id) => {
            appState.recallMessage(id).catch((err) => console.warn('[main] 撤回失败', err));
          },
          onRegenerate: (id) => {
            regenerateReply(id).catch((err) => {
              console.warn('[main] 重新生成失败', err);
              flash(s('msg.recallTooLate'));
            });
          },
          onQuote: (msg) => {
            quotedOf = quoteData(msg);
            return quotedOf;
          },
          onShowQuote: (quote) => showQuote(quote),
          onPickImage: (picked) => addPickedImage(picked),
          onSaveImage: (image) => saveImageToAlbum(image),
          onSticker: (sticker) => sendSticker(sticker),
          // 语音文件被 200 MB 清理删掉后，让气泡自己变灰（而不是点了没反应）
          onVoiceMissing: (id, audio) => appState.updateMessage(id, { audio: { ...audio, missing: true } }),
          voice: voiceInput,
          onVoiceMode: (mode) => {
            // 语音态切走 / 切回来都别留半段录音
            if (mode !== 'voice') voiceInput.cancel();
            else ensureMicPermission();
          },
          onRequestModel: openSettings,
        });
        chatHandle = handle;
        return handle;
      },
    };
  });

  // 「回忆」页里那个星图页签不再是占位格，改成整页推进自家的星图页。
  // 路由 push 不带参数，所以回调只能在这里注进去。
  defineView('memory', () => {
    const view = createMemoryView();
    return {
      mount(el, props = {}) {
        return view.mount(el, { onOpenStars: () => push('starmap'), ...props });
      },
      resume(...args) {
        if (view.resume) return view.resume(...args);
        return undefined;
      },
      destroy(...args) {
        if (view.destroy) return view.destroy(...args);
        return undefined;
      },
    };
  });
  // 相处页：数据自己读 core（这里只补「答一句 / 说晚安」两条真发消息的回调）
  function companionParams() {
    return {
      onAsk: (text) => sendRitual(text, 'ask'),
      onSay: (text) => sendRitual(text, 'say'),
      // 签到顺手可能解锁徽章 / 触发升阶，两个都在这儿兜一次
      onCheckin: async () => {
        try {
          await checkAchievements();
        } catch (err) {
          console.warn('[main] 签到后算徽章失败', err);
        }
      },
    };
  }

  /** 仪式里回答一句 / 说晚安：先落标记再发出去，发完把人带回聊天页。 */
  async function sendRitual(text, kind) {
    const t = String(text || '').trim();
    if (!t) return;
    const now = Date.now();
    try {
      if (kind === 'ask') await markAsk(now, t);
      else await markGoodnight(now);
    } catch (err) {
      console.warn('[main] 仪式标记没落库', err);
    }
    await sendMessage(t);
    goChat();
  }

  /**
   * 历史补算：老大 2026-11-13「以前有的聊天记录如果能读到的话补发信和加好感度，
   * 每个阶段都有信，最少一千五百字」。
   * 三件事按顺序：先重放历史把点数/档位补上（只升不降），再按缺的档位一封封写。
   */
  async function runBackfill() {
    if (letterBusy) return null;
    const config = appState.getConfig();
    if (!config || !config.endpoint) {
      flash(s('letter.backfillNoModel'));
      return null;
    }
    letterBusy = true;
    try {
      const bf = await import('./core/backfill.js');
      const found = await bf.planFromHistory();
      const gaps = (found && found.gaps) || [];
      const needsPoints = !!(found && found.needsPoints);
      const needsCheckin = !!(found && found.checkin && found.checkin.needs);
      if (!gaps.length && !needsPoints && !needsCheckin) {
        flash(s('letter.backfillNone'));
        return { written: [], skipped: [], failed: [] };
      }
      // 先把点数/档位/签到天数按历史补回来（只升不降），再考虑写信
      if (needsCheckin) {
        try {
          await bf.applyCheckin(found.checkin.plan);
        } catch (err) {
          console.warn('[main] 历史签到天数没补上', err);
        }
      }
      if (needsPoints) {
        try {
          await bf.applyPlan(found.plan);
        } catch (err) {
          console.warn('[main] 历史点数没补上', err);
        }
      }
      if (!gaps.length) {
        flash(s('letter.backfillPointsDone'));
        try {
          await bondSnapshot();
        } catch (err) {
          console.warn('[main] 补完点数没刷新亲密度', err);
        }
        return { written: [], skipped: [], failed: [] };
      }
      letterWriting = { chars: 0, target: 1500, at: Date.now(), stage: gaps[0].label };
      flash(s('letter.backfillStart').replace('{n}', String(gaps.length)));
      const res = await bf.writeGaps({
        config,
        persona: await readPersona(),
        onProgress: (d) => {
          if (!d) return;
          letterWriting = {
            chars: d.chars || 0,
            target: 1500,
            at: Date.now(),
            stage: d.label || '',
            index: typeof d.index === 'number' ? d.index + 1 : 0,
            total: d.total || 0,
          };
          if (letterHandle && typeof letterHandle.setWriting === 'function') {
            try {
              letterHandle.setWriting(letterWriting);
            } catch (err) {
              console.warn('[main] 补写信进度没推进视图', err);
            }
          }
        },
      });
      flash(
        s('letter.backfillDone')
          .replace('{n}', String((res.written || []).length))
          .replace('{fail}', String((res.failed || []).length)),
      );
      return res;
    } catch (err) {
      console.warn('[main] 补写信失败', err);
      flash(s('letter.writeFail'));
      return null;
    } finally {
      letterBusy = false;
      letterWriting = null;
      await refreshLetterView();
    }
  }

  function goChat() {
    if (drawer.isOpen()) drawer.close({ silent: true });
    show('chat');
    syncTabs('chat');
  }

  defineView('companion', () => createCompanionView({ state: appState }));

  // 信：列表自己读库；「让她重写一封」必须由这边起稿（要配置和人设）
  let letterHandle = null;
  function refreshLetterView() {
    const h = letterHandle;
    if (!h) return;
    if (typeof h.setWriting === 'function') h.setWriting(letterWriting);
    if (typeof h.setLetters === 'function') {
      listLetters({ limit: 100 })
        .then((list) => h.setLetters(Array.isArray(list) ? list : []))
        .catch((err) => console.warn('[main] 信列表刷新失败', err));
    }
  }

  defineView('letter', () => {
    const view = createLetterView({ state: appState });
    return {
      mount(el, props) {
        const handle = view.mount(el, {
          ...(props || {}),
          writing: letterWriting,
          // 太短/想再要一封：强制重写，进度直接推回视图
          onRewrite: (id) => maybeWriteLetter(null, { force: true }).then(() => refreshLetterView()),
          onRead: (id) => markLetterRead(id).catch((err) => console.warn('[main] 信已读没落库', err)),
          // 补写历史档位的信（老大的聊天记录里已经走过的阶段，一封都不该缺）
          onBackfill: () => runBackfill(),
        });
        letterHandle = handle;
        return handle;
      },
    };
  });

  defineView('starmap', () => createStarmapView({ state: appState }));

  defineView('achievements', () => createAchievementsView({ state: appState }));

  defineView('settings', () => createSettingsView({ state: appState, onChange: () => session.refresh() }));
  // 设置二级页（老大反馈「一整个平铺太长」）：首页只留入口行，重内容各自成页。
  defineView('settings-model', () => createModelPage({ state: appState, onChange: () => session.refresh() }));
  defineView('settings-voice', () => createVoicePage({ state: appState }));
  defineView('settings-backup', () => createBackupPage({ state: appState, onChange: () => session.refresh() }));
  defineView('settings-companion', () => createCompanionPage({ state: appState }));
  defineView('settings-about', () => createAboutPage({ state: appState }));
  // 情绪只读调试页（七维 / 档位 / 注入块原文）：排期 E4，注册在 settings 抽屉里
  defineView('settings-affect', () => createAffectPage({ state: appState }));
  // 角色卡：换卡 / 写自己的补充设定（排期 4，三层加载由 core/lore.js 管）
  defineView('settings-lore', () => createLorePage({ state: appState, onChange: () => session.refresh() }));
  // 首次打开引导（排期 5）：走完自己写 markDone，这里只负责切回聊天
  defineView('welcome', () => createWelcomeView({ state: appState, onFinished: () => goChat() }));
  // 语音通话（排期 6）：turn 只负责「说一句、拿回她的回复」，状态机全在 core/call.js
  defineView('call', () =>
    createCallView({
      turn: async (text) => {
        await sendMessage(text);
        // 回复落库后取最后一条她说的：通话页只念这一条，历史由聊天页管
        const list = appState.getMessages();
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const m = list[i];
          if (m && m.role === 'assistant' && !m.pending && !m.recalled && String(m.text || '').trim()) {
            return String(m.text);
          }
        }
        return '';
      },
      onEnd: () => pop(),
    })
  );
  defineView('settings-call', () => createCallSettingsPage({ state: appState, onChange: () => session.refresh() }));

  defineView('notices', () =>
    createPlaceholderView({
      titleKey: 'fullpage.noticesTitle',
      subtitleKey: 'fullpage.noticesSubtitle',
      rows: [s('fullpage.todo')],
    })
  );
  defineView('history', () => createHistoryView({ state: appState }));
  defineView('journal', () => createJournalView());
  defineView('feedback', () => createFeedbackView());
  defineView('background', () =>
    createPlaceholderView({
      titleKey: 'fullpage.backgroundTitle',
      subtitleKey: 'fullpage.backgroundSubtitle',
      rows: [s('fullpage.todo')],
    })
  );

  mountRouter(shell.pages, {
    onNavigate: (cur) => {
      // 抽屉里的视图 push 了全屏页（设置子页 / 手记详情）→ 抽屉让开，
      // 否则全屏页会被盖在抽屉下面，看起来像「点了没反应」。
      // 抽屉页不在路由栈里（它是盖在聊天页上的一层），所以二级页 push 时
      // 路由栈里只有 [chat, settings-model]。返回后 cur.name 会是 chat，
      // 靠 cur.name 认不出「刚才在设置里」——必须把 push 前的抽屉页记下来。
      if (cur && cur.depth > 1) {
        const host = drawer.currentName();
        if (host) drawerRootBeforePush = host;
        drawer.yieldToPage();
      } else if (cur && cur.depth === 1 && drawerRootBeforePush) {
        const host = drawerRootBeforePush;
        drawerRootBeforePush = null;
        restoreDrawer(host);
      }
      if (cur) syncTabs(cur.name);
      syncBack(cur);
    },
  });

  // 动效降级收口：系统减弱动效 / 低端机探测 / 键盘弹起
  const motion = initMotionGuard(root);

  const DRAWER_TABS = new Set(['memory', 'companion', 'settings']);
  const drawer = createDrawer({
    root,
    onChange: (name) => {
      syncTabs(name || currentName());
    },
  });
  function openSettings() {
    drawer.open('settings');
    syncTabs('settings');
  }

  /**
   * 全屏页压栈时，左上角「艾莲」变成返回箭头（照旧包：顶栏第一个按钮就是返回）。
   * 栈底时还原成品牌名，且不可点。
   */
  function syncBack(cur) {
    const stacked = !!(cur && cur.depth > 1);
    const btn = shell.brand;
    if (!btn) return;
    btn.classList.toggle('is-back', stacked);
    btn.setAttribute('aria-label', stacked ? s('header.back') : s('app.name'));
    if (stacked) btn.replaceChildren(iconEl('back'));
    else btn.textContent = s('app.name');
  }

  // 抽屉里的根页：返回/退出子页后要把抽屉重新打开到这一页
  const DRAWER_ROOTS = new Set(['memory', 'companion', 'settings']);
  let restoringDrawer = false;
  let drawerRootBeforePush = null;
  function restoreDrawer(name) {
    if (!DRAWER_ROOTS.has(name) || drawer.isOpen() || restoringDrawer) return;
    restoringDrawer = true;
    window.setTimeout(() => {
      try {
        drawer.open(name, { from: null });
      } finally {
        restoringDrawer = false;
      }
    }, 0);
  }

  // 全屏子页不属于任何底栏 tab，但「我还在设置里」这件事得让人看得见：
  // 子页 → 它所属的 tab。对不上就原样用（聊天/记忆/相处/设置四个根页照旧）。
  const TAB_ALIAS = {
    'settings-model': 'settings',
    'settings-voice': 'settings',
    'settings-backup': 'settings',
    'settings-companion': 'settings',
    'settings-about': 'settings',
    'settings-affect': 'settings',
    'settings-lore': 'settings',
    'settings-call': 'settings',
    welcome: 'chat',
    notices: 'settings',
    background: 'settings',
    feedback: 'settings',
    journal: 'memory',
    // 新一轮补齐的三个全屏页：信 / 星图 / 徽章都从「相处」进，底栏高亮跟着相处走
    letter: 'companion',
    starmap: 'companion',
    achievements: 'companion',
  };

  function syncTabs(rawName) {
    const name = TAB_ALIAS[rawName] || rawName;
    for (const [tab, btn] of shell.tabButtons) {
      btn.classList.toggle('is-active', tab === name);
    }
    // 停在聊天页就等于「看过了」，未读点自然消失
    if (name === 'chat' && unread) setUnread(false);
  }

  // —— 未读小圆点 ——
  // 只在「她主动说话、而你不是在聊天页」时亮；切到聊天页就灭。
  // 不做持久化：重启后聊天页就是首屏，本来也就看到了。
  let unread = false;
  function setUnread(on) {
    unread = !!on;
    const btn = shell.tabButtons.get('chat');
    if (btn) btn.classList.toggle('has-unread', unread);
  }

  // 记忆 / 相处 / 设置走抽屉：聊天页不被销毁，草稿和滚动位置都还在。
  // 聊天仍然是根页面，切回它就是关抽屉（不重建）。
  for (const [tab, btn] of shell.tabButtons) {
    btn.addEventListener('click', () => {
      if (DRAWER_TABS.has(tab)) {
        const opts = { from: btn };
        // 相处页要接两条真发消息的回调，抽屉默认不带 props，这里补
        if (tab === 'companion') opts.params = companionParams();
        drawer.toggle(tab, opts);
        syncTabs(drawer.isOpen() ? tab : currentName());
      } else {
        drawer.close({ silent: true });
        show(tab);
        syncTabs(tab);
      }
    });
  }

  shell.brand.addEventListener('click', () => {
    const cur = current();
    if (cur && cur.depth > 1) pop();
  });

  // 顶栏动作
  shell.toolButtons.appearance.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(root, theme);
    const label = theme === 'dark' ? s('header.appearanceLight') : s('header.appearanceDark');
    shell.toolButtons.appearance.setAttribute('aria-label', label);
  });
  shell.toolButtons.settings.addEventListener('click', () => {
    drawer.toggle('settings', { from: shell.toolButtons.settings });
    syncTabs(drawer.isOpen() ? 'settings' : currentName());
  });
  shell.toolButtons.notices.addEventListener('click', () => push('notices'));
  shell.toolButtons.history.addEventListener('click', () => push('history'));
  shell.toolButtons.background.addEventListener('click', () => push('background'));

  // Escape 与系统返回键走同一条链（浮层 > 菜单 > 抽屉 > 页面栈 > 回聊天），
  // 只是 Escape 不触发「再按一次退出」——桌面调试时按 Esc 不该弹退出提示。
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    requestBack({ from: 'ui' });
  });

  // —— 返回键的其余三层 ——
  // 40：顶栏「⋯」菜单开着先收菜单
  registerBack(
    () => {
      if (shell.menu.hidden) return false;
      shell.setMenu(false);
      return true;
    },
    { priority: 40, name: 'header-menu' },
  );
  // 10：不在聊天页就回聊天（通知 / 背景这类全屏页退出后落回聊天，而不是直接退 App）
  registerBack(
    () => {
      if (currentName() === 'chat') return false;
      show('chat');
      syncTabs('chat');
      return true;
    },
    { priority: 10, name: 'back-to-chat' },
  );

  // 0：兜底 = 两秒内再按一次才回桌面（回桌面不杀进程，主动消息与备份闹钟要留着）
  let exitHintAt = 0;
  let exitHintTimer = 0;
  const exitEl = document.createElement('div');
  exitEl.className = 'el-exit-hint';
  exitEl.setAttribute('role', 'status');
  exitEl.setAttribute('aria-live', 'polite');
  exitEl.textContent = s('common.exitHint');
  shell.pages.append(exitEl);
  function clearExitHint() {
    window.clearTimeout(exitHintTimer);
    exitHintAt = 0;
    exitEl.classList.remove('is-on');
  }
  function onBackUnhandled() {
    if (Date.now() - exitHintAt < 2000) {
      clearExitHint();
      minimizeApp();
      return;
    }
    exitHintAt = Date.now();
    exitEl.classList.add('is-on');
    window.clearTimeout(exitHintTimer);
    exitHintTimer = window.setTimeout(clearExitHint, 2000);
  }
  const backInstalled = installAndroidBack(onBackUnhandled);

  // 会话状态 → 聊天视图
  appState.subscribe(() => {
    if (!chatHandle) return;
    chatHandle.setMessages(appState.getMessages());
    chatHandle.setBusy(appState.isBusy());
    chatHandle.setModel(appState.getModelName());
  });

  // 首次打开：先过引导（排期 5）。判断走 localStorage 同步读，不等 IDB，避免先闪一下聊天页。
  show(shouldOnboard() ? 'welcome' : 'chat');
  syncTabs('chat');
  // 读加密配置（异步），读到后刷新聊天页标题上的模型名
  // 先把老消息补成新形状（type/recalled/quoteOf…）：界面按新字段分支渲染，
  // 缺字段会走进奇怪的分支，所以迁移必须在第一次读消息之前。
  try {
    const migrated = await migrateAll();
    if (migrated && migrated.changed) console.info('[main] 消息结构已升级', migrated);
  } catch (err) {
    console.warn('[main] 消息结构升级失败，按老形状继续跑', err);
  }
  await appState.init();
  chatHandle && chatHandle.setModel(appState.getModelName());

  // 老数据里已经发生过的事该发的徽章补发一次（首次上这个版本时口径对齐）
  checkAchievements().catch((err) => console.warn('[main] 启动补算徽章失败', err));

  // 更新清单地址：默认指向自建站，装了包就能直接点「检查更新」，不用先去设置页手打 IP
  ensureUpdateConfigured().catch((err) => console.warn('[main] 同步更新清单地址失败', err));

  // —— 主动消息：把素材推给 native，并把待读的取回来落成一条消息 ——
  /** 把「磁盘上已经没有的语音文件」在消息里标成 missing。
 *  清理和换机恢复都会造成这种状态；只在启动与清理后跑一次，不扫全库（只扫已加载的）。 */
async function reconcileVoiceFiles() {
  try {
    const disk = await voiceStorage();
    const alive = new Set((disk.files || []).map((f) => f.name));
    let marked = 0;
    appState.getMessages().forEach((m) => {
      if (!m.audio || m.audio.missing || !m.audio.name) return;
      if (alive.has(m.audio.name)) return;
      appState.updateMessage(m.id, { audio: { ...m.audio, missing: true } });
      marked += 1;
    });
    return { alive: alive.size, marked };
  } catch (err) {
    console.warn('[main] 核对语音文件失败', err);
    return { alive: 0, marked: 0, error: String((err && err.message) || err) };
  }
}

  // E4：主动消息的门槛（文档 5章2表「主动消息」行）。
  // 为什么宁可不发：主动消息的分量全在「她真的想找你」，凑数的一句「在干嘛」
  // 会把这个分量用光；eff 低的时候安静，比硬找一个话题更对。
  //
  // 门槛为什么是 20 而不是 45：日常值（lust30/resist50/affection40）算出来 eff≈3.8，
  // 45 这条线等于「她永远不主动找你」；eff 自己已经做过「心思量 − 抵抗 × 0.5」的折扣，
  // 20 相当于「有点想要、也不太抗拒」才开口。lust 真上来时（80/ resist30 → eff≈65）照样能过。
  // 【待老大复核】这个数字文档没给，20 是我按默认值反推的。
  const INITIATE_THRESHOLD = 20;

async function syncProactive() {
    if (!isNative()) return;
    try {
      const st = await readProactiveState();
      if (!st || !st.available || !st.enabled) return;
      // 先看情绪：低于门槛就不推新素材，native 那边没有素材自然发不出消息。
      // 读失败（null）按「不知道」处理 —— 照旧推，别因为读不到情绪就彻底不吭声。
      const aff = await takeAffect();
      if (aff) {
        const eff = effectiveDesire(aff.dims);
        if (eff < INITIATE_THRESHOLD) {
          console.info('[affect] eff', eff.toFixed(2), '<', INITIATE_THRESHOLD, '这次不主动开口');
          return;
        }
      }
      await pushMaterial({
        config: appState.getConfig(),
        messages: appState.getMessages(),
        rhythmId: lastRhythmId,
      });
    } catch (err) {
      console.warn('[main] 推送主动消息素材失败', err);
    }
  }

  async function drainProactive() {
    if (!isNative()) return;
    try {
      const st = await readProactiveState();
      if (!st || !st.available || !st.hasPending) return;
      const pending = await takePending();
      if (!pending || !pending.text) return;
      // 同一句不重复落库：native 取走即清空，这里只防刷新时界面重放
      if (pending.at && pending.at === lastDrainedAt) return;
      lastDrainedAt = pending.at;
      appState.addMessage({ role: 'assistant', text: pending.text });
      // 不要在这里 syncTabs('chat') —— 那会把底栏高亮挪到聊天页，
      // 但用户其实还停在设置/回忆页，看起来像「自己跳走了」。
      if (currentName() !== 'chat') setUnread(true);
    } catch (err) {
      console.warn('[main] 取主动消息失败', err);
    }
  }

  /** 后台到齐的聊天回复（WebView 被挂起时 native 先替她收着）。 */
  async function drainChatReply() {
    if (!isNative()) return;
    try {
      const found = await takeChatReply();
      if (!found) return;
      if (found.at && found.at === lastChatReplyAt) return;
      lastChatReplyAt = found.at || 0;
      appState.addMessage({ role: 'assistant', text: found.text });
      if (currentName() !== 'chat') setUnread(true);
    } catch (err) {
      console.warn('[main] 取后台回复失败', err);
    }
  }

  let lastRhythmId = 'normal';
  let lastDrainedAt = 0;
  let lastChatReplyAt = 0;
  setBackgroundThread(appState.snapshot().threadId || '');

  await drainProactive();
  await drainChatReply();
  await syncProactive();
  pruneVoices()
    .then((res) => {
      if (res.removed.length) console.log('[main] 语音清理', res.removed.length, res.freedBytes);
      return reconcileVoiceFiles();
    })
    .catch((err) => console.warn('[main] 语音清理没跑成', err));
  // 备份是慢活（读全表 + 写文件），放到启动收尾，失败只记日志不打断界面
  autoBackup().catch((err) => console.warn('[main] 自动备份跳过', err && (err.code || err.message)));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    drainProactive();
    drainChatReply();
    maybeWriteJournal({ config: appState.getConfig(), messages: appState.getMessages() }).catch(() => {});
    maybeRemember({ config: appState.getConfig(), messages: appState.getMessages() }).catch(() => {});
    autoBackup().catch(() => {});
  });
  // 从后台切回来（点通知）不一定触发 visibilitychange，补一道
  window.addEventListener('focus', () => {
    drainProactive();
    drainChatReply();
  });

  // 暴露给验收脚本（只读快照，不参与业务）
  window.__ellen = {
    version: '0.3.0-m7',
    motion: { reduce: () => motion.reduce(), isReduced: () => motion.isReduced() },
    back: {
      // 验收口：不在真机上点屏幕坐标，直接看链上有谁、当前栈深、提示有没有亮
      chain: () => backChain(),
      probe: () => ({
        drawerOpen: drawer.isOpen(),
        drawerName: drawer.currentName(),
        menuOpen: !shell.menu.hidden,
        page: currentName(),
        depth: (current() || {}).depth || 0,
        hintOn: exitEl.classList.contains('is-on'),
        installed: backInstalled,
        native: isNative(),
      }),
      // 等价于按一次返回键（不触发退出）
      fire: () => requestBack({ from: 'ui' }),
      onBackUnhandled, // 只给验收用：模拟「按两次退出」的第一下
    },
    drawer: {
      open: (name) => drawer.open(name),
      close: () => drawer.close(),
      current: () => drawer.currentName(),
    },
    push,
    state: () => appState.snapshot(),
    show,
    pop,
    currentName,
    theme: () => root.dataset.theme,
    store: { importSnapshot, verifyImport, rebuildHeads, parseManifest, splitArchive, extractSnapshot, dropDb },
    // 备份/导出验收：只生成清单，不落盘
    exportPreview: () => buildManifest().then((r) => ({ stats: r.stats, manifestBytes: r.stats.manifestBytes, head: r.manifestText.slice(0, 200) })),
    recall: (text, opts) => recall(text, opts),
    asr: { load: () => loadAsrConfig(), transcribe: (input) => transcribeAudio(input), isUsable: (cfg) => asrUsable(cfg) },
    voiceStore: { list: () => voiceStorage(), prune: (opts) => pruneVoices(opts), reconcile: () => reconcileVoiceFiles() },
    voice: {
      // 验收口：录音状态机是唯一事实源，别再读一个局部布尔
      state: () => voiceInput.state(),
      cancel: () => voiceInput.cancel(),
      commit: (payload) => commitVoice(payload),
    },
  speech: {
    speak: (text, opts) => speakOut(plainVoice(text), opts),
    stop: () => stopSpeech(),
    prefs: () => readVoicePrefs(),
    setPrefs: (patch) => writeVoicePrefs(patch),
  },
    reload: () => appState.reload(),
    // 备份的验收取数口
    backup: {
      state: () => backupState(),
      due: () => backupDue(),
      configure: (patch) => backupConfigure(patch),
      run: (opts) => runBackupOnce(opts || {}),
    },
    // 角色卡 / 聊天偏好的验收取数口（不暴露写接口以外的东西）
    persona: {
      read: () => readPersona(),
      write: (patch) => writePersona(patch),
      prompt: () => currentSystemPrompt(),
    },
    chatPrefs: {
      read: () => readChatPrefs(),
      write: (patch) => writeChatPrefs(patch),
    },
    proactive: {
      sync: () => syncProactive(),
      drain: () => drainProactive(),
      rhythm: (id) => {
        if (id) lastRhythmId = id;
        return lastRhythmId;
      },
    },
    memory: {
      due: () => memoryDue({ messages: appState.getMessages() }),
      prefs: () => readMemoryPrefs(),
      // 验收用：不看门槛直接抽一次并落库
      force: () => rememberNow({ config: appState.getConfig(), messages: appState.getMessages() }),
    },
    journal: {
      day: () => dayKey(),
      due: () => journalDue({ messages: appState.getMessages() }),
      today: () => todayJournal(),
      compose: () => maybeWriteJournal({ config: appState.getConfig(), messages: appState.getMessages() }),
      // 验收用：不看门槛直接写一篇（force）
      force: async () => {
        const { compose, writeJournal } = await import('./core/journal.js');
        const entry = await compose({
          config: appState.getConfig(),
          messages: appState.getMessages().slice(-20),
        });
        const res = await writeJournal(entry);
        return { ...res, title: entry.title, diary: entry.diary.slice(0, 40) };
      },
    },
    companion: {
      // 验收用：强制问一次心情（跳过 6 小时门槛）——把上次时间清掉再跑
      mood: async () => {
        const m = await import('./core/companion.js');
        const composed = await m.composeMood({
          config: appState.getConfig(),
          messages: appState.getMessages(),
        });
        if (composed.skipped) return composed;
        const { appendRecord } = await import('./core/store/records.js');
        const rec = await appendRecord({
          kind: 'emotion',
          value: composed.value,
          threadId: null,
          at: composed.at,
        });
        return { ok: true, headId: rec.headId, value: composed.value };
      },
      read: async () => {
        const m = await import('./core/companion.js');
        return m.snapshot();
      },
    },
    letter: {
      // 验收用：不等升阶，直接催她写一封（force 才能跨过「同一档只写一次」）
      write: (opts = {}) => maybeWriteLetter(null, { force: true, ...opts }),
      writing: () => letterWriting,
      list: () => listLetters({ limit: 20 }),
      unread: () => letterUnread(),
      bond: () => bondSnapshot(),
      // 验收用：直接加点，看升阶 + 「该写信了」这条路，不去真聊三十条
      addPoints: async (n = 25) => {
        const m = await import('./core/bond.js');
        return m.addPoints(n, { at: Date.now(), reason: 'debug' });
      },
    },
  };
}

main().catch(bootError);
