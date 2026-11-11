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
import { initMotionGuard } from './ui/motion-guard.js';
import { createChatView } from './ui/views/chat/chat.js';
import { createPlaceholderView } from './ui/views/placeholder.js';
import { createMemoryView } from './ui/views/memory/memory.js';
import { createHistoryView } from './ui/views/history/history.js';
import { createJournalView } from './ui/views/journal/journal.js';
import { createFeedbackView } from './ui/views/feedback/feedback.js';
import { readPrefs as readVoicePrefs, writePrefs as writeVoicePrefs, speak as speakOut, stop as stopSpeech, plain as plainVoice } from './core/speech.js';
import { createCompanionView } from './ui/views/companion/companion.js';
import { createAppState } from './core/state.js';
import { createChatSession } from './core/chat/session.js';
import { recall } from './core/chat/recall.js';
import { createSettingsView } from './ui/views/settings/settings.js';
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
import { setThread as setBackgroundThread, takeChatReply } from './core/background.js';
import * as recorder from './core/recorder.js';
import { loadConfig as loadAsrConfig, isUsable as asrUsable, transcribe as transcribeAudio } from './core/asr.js';
import { readPersona, writePersona, buildSystemPrompt } from './core/persona.js';
import { buildManifest } from './core/store/export.js';
import { configure as backupConfigure } from './core/backup.js';
import { autoRun as autoBackup, state as backupState, due as backupDue, run as runBackupOnce } from './core/backup.js';
import { readChatPrefs, writeChatPrefs } from './core/chatprefs.js';
import { relationship } from './core/companion.js';

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

  // 人设每轮现取：设置页改完立刻生效，不用重开会话
  async function currentSystemPrompt() {
    const [persona, relation] = await Promise.all([readPersona(), relationship()]);
    return buildSystemPrompt({ persona, relationship: relation });
  }

  const session = createChatSession({ state: appState, getSystemPrompt: currentSystemPrompt });

// 发一句话（键盘回车和语音转写共用这一条路，别再复制一遍）
function sendMessage(text) {
  const clean = (text || '').trim();
  if (!clean) return Promise.resolve();
  return session.send(clean).then(() => {
    // 每轮聊完顺手看看该不该写手记；不 await 到界面路径上，失败也不影响聊天
    maybeWriteJournal({ config: appState.getConfig(), messages: appState.getMessages() }).catch((err) =>
      console.warn('[main] 手记没写成', err)
    );
    // 开了「她说完就念」就把这一句读出来（读不出来不影响聊天）
    maybeReadAloud();
  });
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

  // —— 语音输入：点麦克风开始录，再点一下结束 → 转写 → 填进输入框（不自动发）——
  let recordingVoice = false;

  // 按住说话：按下 = 开始，松手 = 结束并转写；单击（无障碍/鼠标）仍然当开关用
  async function handleMic(action) {
    if (!chatHandle) return;
    if (action === 'start') {
      if (!recordingVoice) await toggleVoice();
      return;
    }
    if (action === 'stop') {
      if (recordingVoice) await toggleVoice();
      return;
    }
    await toggleVoice();
  }

  async function toggleVoice() {
    if (!chatHandle) return;
    if (recordingVoice) {
      recordingVoice = false;
      chatHandle.setRecording(false);
      let result = null;
      try {
        result = await recorder.stop();
      } catch (err) {
        flash(`${s('chat.voiceFailed')}${(err && err.message) || ''}`);
        return;
      }
      if (!result || !result.bytes) {
        flash(s('chat.voiceTooShort'));
        return;
      }
      if ((result.durationMs || 0) < 700) {
        recorder.release(result.fileId);
        flash(s('chat.voiceTooShort'));
        return;
      }
      try {
        const file = await recorder.readBase64(result.fileId);
        const { text } = await transcribeAudio({ fileId: result.fileId, base64: file && file.base64 });
        chatHandle.setDictation(text);
        const cfgNow = await loadAsrConfig();
        if (cfgNow && cfgNow.autoSend) {
          chatHandle.setDictation('');
          sendMessage(text);
        }
      } catch (err) {
        const message = (err && err.message) || '';
        if (err && err.code === 'ASR_NOT_CONFIGURED') {
          flash(s('chat.voiceNeedConfig'));
          openSettings();
        } else {
          flash(`${s('chat.voiceFailed')}${(err && err.message) || ''}`);
        }
      } finally {
        recorder.release(result.fileId);
      }
      return;
    }

    const cfg = await loadAsrConfig();
    if (!asrUsable(cfg)) {
      flash(s('chat.voiceNeedConfig'));
      openSettings();
      return;
    }
    try {
      await recorder.start({ maxDurationMs: 120000 });
      recordingVoice = true;
      chatHandle.setRecording(true);
    } catch (err) {
      const message = (err && err.message) || '';
      flash(message === 'AUDIO_PERMISSION' || /权限/.test(message) ? '要在系统里给录音权限。' : `${s('chat.voiceFailed')}${message}`);
    }
  }

  function maybeReadAloud() {
    if (!readVoicePrefs().auto) return;
    const list = appState.getMessages();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m || m.role !== 'assistant' || m.pending || m.failed) continue;
      const body = plainVoice(m.text);
      if (body) speakOut(body).catch((err) => console.warn('[main] 朗读失败', err));
      return;
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
          onSend: (text) => sendMessage(text),
          onStop: () => session.stop(),
          onMic: (action) => handleMic(action),
          onRequestModel: openSettings,
        });
        chatHandle = handle;
        return handle;
      },
    };
  });

  defineView('memory', () => createMemoryView());

  defineView('companion', () => createCompanionView({ state: appState }));

  defineView('settings', () => createSettingsView({ state: appState, onChange: () => session.refresh() }));

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
      if (cur && cur.depth > 1) drawer.yieldToPage();
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

  function syncTabs(name) {
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
        drawer.toggle(tab, { from: btn });
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

  // 系统返回键：Android 上 pop 一层
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (drawer.isOpen()) return; // 抽屉自己处理（关抽屉，不 pop 页面）
    pop();
  });

  // 会话状态 → 聊天视图
  appState.subscribe(() => {
    if (!chatHandle) return;
    chatHandle.setMessages(appState.getMessages());
    chatHandle.setBusy(appState.isBusy());
    chatHandle.setModel(appState.getModelName());
  });

  show('chat');
  syncTabs('chat');

  // 读加密配置（异步），读到后刷新聊天页标题上的模型名
  await appState.init();
  chatHandle && chatHandle.setModel(appState.getModelName());

  // —— 主动消息：把素材推给 native，并把待读的取回来落成一条消息 ——
  async function syncProactive() {
    if (!isNative()) return;
    try {
      const st = await readProactiveState();
      if (!st || !st.available || !st.enabled) return;
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
  // 备份是慢活（读全表 + 写文件），放到启动收尾，失败只记日志不打断界面
  autoBackup().catch((err) => console.warn('[main] 自动备份跳过', err && (err.code || err.message)));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    drainProactive();
    drainChatReply();
    maybeWriteJournal({ config: appState.getConfig(), messages: appState.getMessages() }).catch(() => {});
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
    voice: { toggle: () => toggleVoice(), recording: () => recordingVoice },
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
  };
}

main().catch(bootError);
