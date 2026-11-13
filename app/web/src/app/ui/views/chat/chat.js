// 聊天页视图。只做"渲染 + 收集输入"，不认识插件、不发网络请求
// （§6.5 第 1 条：视图单向依赖；验收 grep 本文件出现 fetch(/registerPlugin 必须 0 条）。
// 真正的发送走 props.onSend（由 app 层注入，app 层再交给 core/chat 会话）。
import { s } from '../../../strings.zh.js';
import { push } from '../../router.js';
import { iconEl } from '../../icons.js';
import { renderRichText } from '../../richtext.js';
import { speak, stop as stopSpeaking, plain, synthesizeUrl } from '../../../core/speech.js';
import { readDocument, toBlobUrl, revokeAll } from '../../../core/documents.js';
import { readVolume, writeVolume, volumeSupported, flushVolume, onVolumeChange } from '../../../core/volume.js';
import { pickImage, mediaSupported } from '../../../core/media.js';
import { STICKERS, STICKER_FAVORITES, stickerById, stickerUrl } from '../../../assets/stickers.js';
import {
  MAX_CUSTOM_STICKERS,
  customStickerUrl,
  customStickerUrlSync,
  customStickers,
  deleteCustomSticker,
  ensureCustomStickers,
  importCustomSticker,
  isCustomStickerId,
  isKept,
  noteHerSticker,
  onCustomStickersChange,
  prefetchCustomStickers,
  releaseCustomUrls,
  toggleKeepSticker,
} from '../../../core/sticker-library.js';
import './chat.css';

// 语音态文案。lead 在改 strings.zh.js，这里先用本地常量，别两头改同一个文件。
// 文案统一走 strings.zh.js 的 chat 段（getter：切换语言时立刻生效，不必重建视图）
// arming 超过这个时长还没进 recording，就是卡在系统权限弹窗上了
const ARMING_WAIT_MS = 600;

// —— 消息级交互的三个常量 ——
// 450ms 与老包长按一致：再短一点，手指滚动消息时就会弹菜单；再长一点，人会以为按不动。
const LONG_PRESS_MS = 450;
// 位移超过这个量就算「在滚动」，不弹菜单（8 是 Android touch slop 的同一量级）
const LONG_PRESS_SLOP = 8;
// 撤回窗口 2 分钟：方案 §六 老大拍板「撤回 2 分钟够」
const RECALL_WINDOW_MS = 2 * 60 * 1000;

/**
 * 文案取值：新键优先、旧键兜底。
 * strings.zh.js 归 Lead，视图不许自己往里加键；而 s() 遇到缺键会把 key 原样返回。
 * 所以这里先试任务书里的键名，没命中就退回同义的既有键 —— Lead 补键之后自动生效，
 * 不必再回来改这个文件。
 */
function sOr(primary, fallback) {
  const hit = s(primary);
  return hit === primary ? s(fallback) : hit;
}

/**
 * 复制一段文字。
 * navigator.clipboard 在 WebView 里常常因为「不在安全上下文 / 没给权限」直接 reject，
 * 所以必须留 textarea + execCommand 这条老路；两条都不行就静默失败（菜单里点一下没反应，
 * 比弹一个红色报错轻）。
 * @param {string} text
 * @returns {Promise<boolean>} 是否真的复制到了剪贴板
 */
async function copyText(text) {
  const body = String(text || '');
  if (!body) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(body);
      return true;
    }
  } catch (err) {
    /* 走下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = body;
    ta.setAttribute('readonly', '');
    // 不能用 display:none —— 看不见的 textarea 选不中，execCommand 什么都不做
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, body.length);
    const ok = document.execCommand ? document.execCommand('copy') : false;
    ta.remove();
    return !!ok;
  } catch (err) {
    return false;
  }
}

/** 截断引用文本：引用条是一行，原句太长会把 × 顶出屏幕。 */
function truncateQuote(text, max = 42) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/**
 * 引用条 / 撤回行前面那个「你 / 她」。
 * strings.zh.js 里没有独立的人称键（只有整句文案），所以：
 *   · Lead 补上 msg.quoteByMe / msg.quoteByHer 之后自动改用新键；
 *   · 没补时，她自己就用角色名（app.name），「你」取撤回文案的首字 —— 不新增中文字面量。
 */
function speakerLabel(role) {
  if (role === 'user') {
    const own = s('msg.quoteByMe');
    if (own !== 'msg.quoteByMe') return own;
    return s('msg.recalledByMe').slice(0, 1);
  }
  const hers = s('msg.quoteByHer');
  return hers !== 'msg.quoteByHer' ? hers : s('app.name');
}

const VT = {
  get hold() { return s('chat.voiceHold'); },
  get arming() { return s('chat.voiceArming'); },
  get slideCancel() { return s('chat.voiceSlideCancel'); },
  get releaseSend() { return s('chat.voiceReleaseSend'); },
  get releaseCancel() { return s('chat.voiceReleaseCancel'); },
  get writing() { return s('chat.voiceWriting'); },
  get tooShort() { return s('chat.voiceTooShort'); },
  get keyboard() { return s('chat.voiceKeyboard'); },
  get missing() { return s('chat.voiceMissing'); },
  get asrFailed() { return s('chat.voiceAsrFailed'); },
};

export function createChatView() {
  return {
    mount(el, props = {}) {
      const state = {
        messages: props.messages ? props.messages.slice() : [],
        model: props.model || null,
        busy: false,
        // 输入区三态：text（键盘） / voice（按住说话） / panel（「+」面板），彼此互斥。
        // 空串 = 还没落定：mount 末尾的 setMode('text', false) 会一次性把 DOM 摆到键盘态
        // （早返回的幂等判断需要「当前不是 text」才肯干活，所以初值不能写 'text'）。
        mode: '',
      };

      el.classList.add('el-chat-page');
      el.innerHTML = '';

      const stream = document.createElement('div');
      stream.className = 'el-chat-stream';

      // —— 输入区骨架：三行 + 一块面板（照 QQ 的排法重排）——
      // 为什么不再是一行：一行里塞 8 个图标时，输入框被压到 150u 上下，写半句就折行；
      // 发送键又和常驻动作挤在同一排，右拇指每次都要在两个小图标之间挑。
      //   ① .el-composer-entry   输入框独占一行（语音态换成整条「按住说话」）
      //   ② .el-composer-sendrow 发送/停止，有字或在等回复时才出现，自己一行靠右
      //   ③ .el-composer-tools   三个常驻动作（语音/键盘、表情、+），固定靠右下
      //   ④ .el-chat-panel       点「+」升起的面板
      const composer = document.createElement('div');
      composer.className = 'el-chat-composer';

      // 第一行：输入框独占整行。它不能和任何动作按钮同排，否则「占满宽度」就是假的。
      const entry = document.createElement('div');
      entry.className = 'el-composer-entry';

      const field = document.createElement('textarea');
      field.className = 'el-composer-field';
      field.rows = 1;
      field.placeholder = s('chat.placeholder');
      field.setAttribute('aria-label', s('chat.placeholder'));

      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'el-composer-send';
      sendBtn.append(iconEl('send'));
      sendBtn.setAttribute('aria-label', s('chat.send'));
      sendBtn.disabled = true;

      // 麦克风：现在只负责「切到语音态」（微信式），不再点一下开录、再点一下结束。
      const micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.className = 'el-composer-mic';
      micBtn.append(iconEl('mic'));
      micBtn.setAttribute('aria-label', s('chat.voice'));
      micBtn.setAttribute('aria-pressed', 'false');

      // 语音态左边那个「键盘」：切回文字。icons.js 里没有 keyboard，这里照同一套属性手写一个
      const keyboardBtn = document.createElement('button');
      keyboardBtn.type = 'button';
      keyboardBtn.className = 'el-composer-keyboard';
      const kbIcon = document.createElement('span');
      kbIcon.className = 'el-icon';
      kbIcon.setAttribute('aria-hidden', 'true');
      kbIcon.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="2.5" y="6" width="19" height="12" rx="3"></rect>' +
        '<path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 14h.01M17 14h.01M9.5 14h5"></path>' +
        '</svg>';
      keyboardBtn.append(kbIcon);
      keyboardBtn.setAttribute('aria-label', VT.keyboard);
      keyboardBtn.hidden = true;

      // 按住说话。高 36u，按下变暗；上滑进取消态。
      const holdBtn = document.createElement('button');
      holdBtn.type = 'button';
      holdBtn.className = 'el-composer-hold';
      holdBtn.textContent = VT.hold;
      holdBtn.setAttribute('aria-label', s('chat.voiceHoldAria'));
      holdBtn.hidden = true;

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'el-composer-stop';
      stopBtn.append(iconEl('stop'));
      stopBtn.setAttribute('aria-label', s('chat.stop'));
      stopBtn.hidden = true;

      entry.append(field, holdBtn);

      // 第二行：发送 / 停止，靠右独占一行。
      // 发送是「这一下真要发出去」的决定性动作，混进图标堆里最容易误触；
      // 没有字时整行收起（有字才显示），输入区平时保持两行高度。
      const sendRow = document.createElement('div');
      sendRow.className = 'el-composer-sendrow';
      sendRow.hidden = true;
      sendRow.append(sendBtn, stopBtn);

      const tools = document.createElement('div');
      tools.className = 'el-composer-tools';

      // 「+」：三个常驻动作里最右那个，点开是面板态。再点一次收回键盘态。
      const plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'el-composer-plus';
      plusBtn.append(iconEl('plus'));
      plusBtn.setAttribute('aria-label', s('chat.panelAria'));
      plusBtn.setAttribute('aria-expanded', 'false');

      // 顺序照拇指动线：语音/键盘切换 → 表情 → +
      tools.append(micBtn, keyboardBtn, plusBtn);

      // 第三行下面那块面板。它挂在 composer 里（不是 fixed 遮罩）：
      // 面板一长高，flex 就把高度从 .el-chat-stream 里拿走，消息列表被顶起来，
      // 最后几条不会被盖住 —— 遮挡问题从布局上消失，不需要自己算偏移。
      const panel = document.createElement('div');
      panel.className = 'el-chat-panel';
      panel.hidden = true;

      const panelGrid = document.createElement('div');
      panelGrid.className = 'el-chat-panel-grid';

      // 「我的表情」页签的内容容器：这一轮只有空态，
      // 下一条任务往 renderPanelMine() 里填真内容即可（入口已经通，不用再改面板）。
      const panelMine = document.createElement('div');
      panelMine.className = 'el-chat-panel-mine';
      panelMine.hidden = true;

      panel.append(panelGrid, panelMine);

      composer.append(entry, sendRow, tools, panel);

      // 系统条：技术性失败（HTTP 404 / 钥匙不对）只在这里出现一行，不塞进她的气泡里。
      // 评审原话「404 进系统条」：错误不是她说的话，长得像气泡就会让人以为是她在推卸。
      const systemStrip = document.createElement('button');
      systemStrip.type = 'button';
      systemStrip.className = 'el-system-strip';
      systemStrip.hidden = true;
      systemStrip.addEventListener('click', () => {
        dismissedAt = state.messages.length;
        paintSystemStrip();
      });

      // 录音浮层：贴在输入条上方（position:fixed），四个 class 由 setVoiceState 驱动：
      // is-recording / is-cancelling / is-writing / is-error。不写内联 style，波形高度走 nth-child。
      const hud = document.createElement('div');
      hud.className = 'el-voice-hud';
      hud.hidden = true;
      hud.setAttribute('role', 'status');
      hud.setAttribute('aria-live', 'polite');

      const hudWave = document.createElement('span');
      hudWave.className = 'el-voice-hud-wave';
      for (let i = 0; i < 12; i += 1) hudWave.append(document.createElement('i'));

      const hudTimer = document.createElement('span');
      hudTimer.className = 'el-voice-hud-time';
      hudTimer.textContent = '0:00';

      const hudHint = document.createElement('span');
      hudHint.className = 'el-voice-hud-hint';
      hudHint.textContent = VT.slideCancel;

      hud.append(hudWave, hudTimer, hudHint);

      el.append(stream, systemStrip, composer, hud);

      // 通话入口在「+」面板里（老大 2026-11-13 定：从顶栏浮钮挪进输入区）。
      // 为什么不再浮一颗按钮：右上角那块地方本来就靠「在线 / …」，多一颗图标既挤又抢眼；
      // 通话属于「换一种跟她说」的动作，和相册/表情/音量是同一层的事。

      let dismissedAt = -1;

      // ============================================================
      // 消息级交互层（批 2）：引用条 / 长按菜单 / 图片查看器 / 音量台
      // 全部 fixed 挂在页面根节点下，不塞进消息流 —— 否则 100 条消息就是 100 份菜单 DOM。
      // ============================================================

      // —— 引用条：输入条上方的兄弟节点（挂在 composer 之前，不挤动消息流高度）——
      let quoteRef = null;

      const quoteBar = document.createElement('div');
      quoteBar.className = 'el-chat-quote';
      quoteBar.hidden = true;

      const quoteWho = document.createElement('span');
      quoteWho.className = 'el-chat-quote-who';

      const quoteBody = document.createElement('span');
      quoteBody.className = 'el-chat-quote-text';

      const quoteClose = document.createElement('button');
      quoteClose.type = 'button';
      quoteClose.className = 'el-chat-quote-x';
      quoteClose.append(iconEl('close'));
      quoteClose.setAttribute('aria-label', s('common.cancel'));

      quoteBar.append(quoteWho, quoteBody, quoteClose);
      el.insertBefore(quoteBar, composer);

      /** 打开引用条。view 是消息视图对象（自带 headId / id / role / type / text / createdAt）。 */
      function beginQuote(view) {
        if (!view) return;
        quoteRef = {
          headId: String(view.headId || view.id || ''),
          role: view.role === 'user' ? 'user' : 'assistant',
          type: String(view.type || ''),
          text: String(view.text || ''),
          createdAt: Number(view.createdAt) || 0,
        };
        quoteWho.textContent = `${speakerLabel(quoteRef.role)}:`;
        quoteBody.textContent = truncateQuote(quoteRef.text);
        quoteBar.hidden = false;
      }

      function clearQuote() {
        quoteRef = null;
        quoteBar.hidden = true;
        quoteWho.textContent = '';
        quoteBody.textContent = '';
      }

      quoteClose.addEventListener('click', () => clearQuote());

      // —— 图片：字节 → blob URL ——
      // 原生只有 EllenDocuments.open 能把附件读回字节，所以 uri / path / name 都往那一条路上送。
      // 消息里自带 base64 的（导入包、以后的表情包）直接用，省一次跨进程读盘。
      const imageCache = new Map();

      function imageKeyOf(image, fallback) {
        return String((image && (image.uri || image.path || image.name)) || fallback || '');
      }

      async function loadImage(key, image) {
        if (!key) return '';
        const hit = imageCache.get(key);
        if (hit) return hit;
        // 刚拍/刚选的图：core/media.js 已经把 src 拼好了（content:// 进不了 img src），直接用
        const preset = image && typeof image.src === 'string' ? image.src : '';
        if (preset) {
          imageCache.set(key, preset);
          return preset;
        }
        try {
          const inline = image && (image.base64 || image.data);
          const base64 = inline || (await readDocument(key)).base64;
          if (!base64) return '';
          const mime = (image && (image.mimeType || image.mime)) || 'image/jpeg';
          const url = toBlobUrl(base64, mime, `img:${key}`);
          if (url) imageCache.set(key, url);
          return url;
        } catch (err) {
          return '';
        }
      }

      // 长按弹菜单之后抬手会补一次 click：这一小段时间里不许把大图打开
      let suppressTapUntil = 0;

      /** 图片气泡：等比缩略 + 圆角，点开全屏，长按出菜单（renderMessage 统一挂）。 */
      function imageBubble(msg) {
        const wrap = document.createElement('button');
        wrap.type = 'button';
        wrap.className = 'el-msg-image';

        const img = document.createElement('img');
        img.className = 'el-msg-image-img';
        img.decoding = 'async';
        img.alt = String((msg.image && msg.image.name) || '');

        const note = document.createElement('span');
        note.className = 'el-msg-note';
        note.hidden = true;

        wrap.append(img, note);
        const key = imageKeyOf(msg.image, msg.id);
        loadImage(key, msg.image).then((url) => {
          if (!url) {
            // 附件被 200MB 清理删掉了：留一块带虚线边的占位，比整条消息消失好解释
            wrap.classList.add('is-failed');
            note.hidden = false;
            note.textContent = s('msg.imageLoadFail');
            return;
          }
          img.src = url;
        });

        wrap.addEventListener('click', () => {
          if (suppressTapUntil > Date.now()) return;
          openViewer(img.currentSrc || img.src);
        });
        return wrap;
      }

      /** 表情气泡：96u 方块。素材还空着时画占位（别去造图，也别让气泡塌成 0 高）。 */
      function expressionBubble(msg) {
        const box = document.createElement('div');
        box.className = 'el-msg-expr';

        const placeholder = (text) => {
          box.classList.add('is-placeholder');
          const ph = document.createElement('span');
          ph.className = 'el-msg-expr-ph';
          ph.textContent = text;
          box.append(ph);
        };

        // 表情包：包内素材直接给 URL；用户导入的那批要先从原生读回字节（异步），
        // 所以先进「加载中」态，拿到 blob URL 再贴 src —— 不然会闪一下占位再跳图。
        if (msg.stickerId) {
          const st = stickerById(msg.stickerId);
          const url = st ? stickerUrl(st) : '';
          const custom = isCustomStickerId(msg.stickerId);
          if (!url && !custom) {
            placeholder(sOr('msg.expressionPlaceholder', 'msg.expressionEmpty'));
            return box;
          }
          const sit = document.createElement('img');
          sit.className = 'el-msg-expr-img';
          sit.decoding = 'async';
          sit.alt = (st && st.label) || msg.stickerId;
          if (url) sit.src = url;
          box.append(sit);
          if (!url) {
            // 自定义表情：占位淡一点，图到了再显形。读失败（文件被清理掉）就退回占位文字，
            // 别留一个永远空白的方块
            box.classList.add('is-loading');
            customStickerUrl(msg.stickerId)
              .then((real) => {
                if (!real) {
                  box.classList.remove('is-loading');
                  sit.remove();
                  placeholder(sOr('msg.expressionPlaceholder', 'msg.expressionEmpty'));
                  return;
                }
                sit.src = real;
                box.classList.remove('is-loading');
              })
              .catch(() => {
                box.classList.remove('is-loading');
              });
          }
          // 表情贴纸自带透明底：气泡底色留着就成了一个黑方块，把底去掉只留图
          box.classList.add('is-tappable', 'is-sticker');
          box.addEventListener('click', () => {
            if (suppressTapUntil > Date.now()) return;
            openViewer(sit.currentSrc || sit.src);
          });
          // 她发出来的这张在「性格层」记一笔：要不要自动收藏由 core 的纯函数判
          // （没有情绪证据就不动，别替用户决定）。写在渲染里是因为这是唯一
          // 「她真的发出去了」的地方 —— 池子挑中但被丢掉的图不该记账。
          if (msg.role !== 'user') {
            noteHerSticker({
              id: msg.stickerId,
              slot: (st && st.slot) || '',
              src: custom ? 'custom' : 'builtin',
              mood: String(props.mood || ''),
            }).catch(() => {});
          }
          return box;
        }

        const key = imageKeyOf(msg.image, '');
        if (!key) {
          placeholder(sOr('msg.expressionPlaceholder', 'msg.expressionEmpty'));
          return box;
        }

        const img = document.createElement('img');
        img.className = 'el-msg-expr-img';
        img.decoding = 'async';
        img.alt = String((msg.image && (msg.image.name || msg.image.path)) || '');
        box.append(img);
        loadImage(key, msg.image).then((url) => {
          if (!url) {
            img.remove();
            placeholder(s('msg.imageLoadFail'));
            return;
          }
          img.src = url;
          box.classList.add('is-tappable');
          box.addEventListener('click', () => {
            if (suppressTapUntil > Date.now()) return;
            openViewer(img.currentSrc || img.src);
          });
        });
        return box;
      }

      /** 撤回行：只剩一行灰字，正文一律不渲染（撤回就是撤回，别留半句还能翻）。 */
      function recallLine(msg) {
        const line = document.createElement('div');
        line.className = 'el-msg-recall';
        const self = typeof msg.recallSelf === 'boolean' ? msg.recallSelf : msg.role === 'user';
        line.textContent = self ? s('msg.recalledByMe') : s('msg.recalledByHer');
        return line;
      }

      // —— 全屏查看器：自带遮罩，点任意处关 ——
      const viewer = document.createElement('div');
      viewer.className = 'el-chat-viewer';
      viewer.hidden = true;
      const viewerImg = document.createElement('img');
      viewerImg.className = 'el-chat-viewer-img';
      viewer.append(viewerImg);
      el.append(viewer);

      function openViewer(src) {
        if (!src) return;
        viewerImg.src = src;
        viewer.hidden = false;
        requestAnimationFrame(() => viewer.classList.add('is-open'));
      }

      function closeViewer() {
        viewer.classList.remove('is-open');
        viewer.hidden = true;
        viewerImg.removeAttribute('src');
      }

      viewer.addEventListener('click', () => closeViewer());

      // —— 底部 sheet：长按菜单与音量台共用一套壳 ——
      const sheetMask = document.createElement('div');
      sheetMask.className = 'el-chat-sheet-mask';
      sheetMask.hidden = true;

      const sheet = document.createElement('div');
      sheet.className = 'el-chat-sheet';
      sheet.hidden = true;
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');

      const sheetTitle = document.createElement('div');
      sheetTitle.className = 'el-chat-sheet-title';
      sheetTitle.hidden = true;

      const sheetList = document.createElement('div');
      sheetList.className = 'el-chat-sheet-list';

      const sheetCancel = document.createElement('button');
      sheetCancel.type = 'button';
      sheetCancel.className = 'el-chat-sheet-cancel';
      sheetCancel.textContent = s('common.cancel');

      sheet.append(sheetTitle, sheetList, sheetCancel);
      el.append(sheetMask, sheet);

      let sheetOpen = false;

      /** 表情 sheet 开着时对「自定义表情清单」的订阅；关掉 sheet 必须退订，否则闭包攥着整棵 DOM。 */
      let stickerSheetUnsubs = [];

      function clearStickerSheetSubs() {
        stickerSheetUnsubs.forEach((fn) => {
          try {
            fn();
          } catch (err) {
            /* 退订失败不用管，反正下一次重开会重建 */
          }
        });
        stickerSheetUnsubs = [];
      }

      /**
       * 开一个底部 sheet。
       * @param {string} title 标题（空串 = 不显示标题行）
       * @param {(list: HTMLElement) => void} build 往列表里塞内容
       */
      function openSheet(title, build) {
        sheetTitle.textContent = title || '';
        sheetTitle.hidden = !title;
        sheetList.innerHTML = '';
        if (typeof build === 'function') build(sheetList);
        sheetMask.hidden = false;
        sheet.hidden = false;
        // 同一帧里加 is-open 不会触发 transition，必须等下一帧
        requestAnimationFrame(() => {
          sheetMask.classList.add('is-open');
          sheet.classList.add('is-open');
        });
        sheetOpen = true;
      }

      function closeSheet() {
        if (!sheetOpen) return;
        sheetOpen = false;
        // 表情 sheet 的订阅在这里退：sheetList 马上要被清空，
        // 留着订阅只会在下一次清单变化时对着已摘掉的节点重画
        if (typeof clearStickerSheetSubs === 'function') clearStickerSheetSubs();
        sheetMask.classList.remove('is-open');
        sheet.classList.remove('is-open');
        sheet.hidden = true;
        sheetMask.hidden = true;
        sheetList.innerHTML = '';
        volUi = null;
      }

      sheetMask.addEventListener('click', () => closeSheet());
      sheetCancel.addEventListener('click', () => closeSheet());

      /** sheet 里的一行。disabled 的行不绑事件（点不动，但看得到为什么）。 */
      function sheetRow({ label, run, disabled = false, icon = '' }) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-chat-sheet-item';
        if (disabled) {
          btn.classList.add('is-disabled');
          btn.disabled = true;
          btn.setAttribute('aria-disabled', 'true');
        }
        if (icon) btn.append(iconEl(icon));
        const text = document.createElement('span');
        text.className = 'el-chat-sheet-label';
        text.textContent = label;
        btn.append(text);
        if (!disabled && typeof run === 'function') {
          btn.addEventListener('click', () => {
            closeSheet();
            run();
          });
        }
        return btn;
      }

      // —— 长按手势 ——
      let pressTimer = 0;
      let pressOrigin = null;

      function cancelPress() {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = 0;
        }
        pressOrigin = null;
      }

      function nodeOf(msg) {
        const key = String(msg.headId || msg.id || '');
        if (!key) return null;
        const nodes = stream.querySelectorAll('.el-msg');
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          if (nodes[i].dataset.headId === key || nodes[i].dataset.keyId === key) return nodes[i];
        }
        return null;
      }

      /** 最后一条她说的话（「重新生成」只对它开放）。 */
      function isLastAssistant(msg) {
        const list = state.messages || [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const m = list[i];
          if (!m || m.role === 'user') continue;
          if (m.pending || m.failed || m.recalled === true) return false;
          return m === msg || (msg.headId && m.headId === msg.headId) || m.id === msg.id;
        }
        return false;
      }

      /**
       * 长按开菜单。450ms 内位移超过 8 就当成滚动，直接放弃。
       * 不在 pointerdown 里 preventDefault —— 那样消息流就滚不动了。
       */
      function attachLongPress(node, msg) {
        node.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          cancelPress();
          pressOrigin = { x: e.clientX, y: e.clientY };
          pressTimer = setTimeout(() => {
            pressTimer = 0;
            pressOrigin = null;
            suppressTapUntil = Date.now() + 600;
            openMessageMenu(msg);
          }, LONG_PRESS_MS);
        });
        node.addEventListener('pointermove', (e) => {
          if (!pressOrigin) return;
          const dx = Math.abs(e.clientX - pressOrigin.x);
          const dy = Math.abs(e.clientY - pressOrigin.y);
          if (dx > LONG_PRESS_SLOP || dy > LONG_PRESS_SLOP) cancelPress();
        });
        node.addEventListener('pointerup', cancelPress);
        node.addEventListener('pointercancel', cancelPress);
        node.addEventListener('pointerleave', cancelPress);
        // 桌面 / 外接鼠标：右键与长按同义
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          suppressTapUntil = Date.now() + 600;
          openMessageMenu(msg);
        });
      }

      /**
       * 这条消息能做什么。菜单项只在对应 props 存在时出现（契约 §7：
       * onRecall / onRegenerate / onQuote / onSaveImage / onShowQuote 都是可选的）。
       */
      function menuRowsFor(msg) {
        const rows = [];
        const text = String(msg.text || '');
        const mine = msg.role === 'user';
        const recalled = msg.recalled === true;
        const isImage = msg.type === 'image' || (!msg.type && !!msg.image);
        const hasText = !!text.trim();

        if (!recalled && hasText) {
          rows.push({ label: s('msg.menuCopy'), run: () => copyText(text) });
        }
        // 引用只对「有字」的消息开放：引用一张图或一个表情没有内容可回显
        if (!recalled && hasText && typeof props.onQuote === 'function') {
          rows.push({ label: s('msg.menuQuote'), run: () => beginQuote(msg) });
        }
        // 朗读只给她的话，且复用气泡右下角那个朗读按钮的同一套逻辑（别在菜单里另造一条路）
        if (!recalled && !mine && hasText) {
          rows.push({ label: s('msg.menuSpeak'), run: () => toggleSpeak(msg, nodeOf(msg)) });
        }
        if (!recalled && mine && typeof props.onRecall === 'function') {
          const at = Number(msg.createdAt) || 0;
          const fresh = at > 0 && Date.now() - at < RECALL_WINDOW_MS;
          // 过期不给可点的「撤回」：点了才说不行，比一开始就说清楚更气人
          rows.push({
            label: fresh ? s('msg.menuRecall') : s('msg.recallTooLate'),
            disabled: !fresh,
            run: () => props.onRecall(msg.headId || msg.id || ''),
          });
        }
        if (!mine && !recalled && typeof props.onRegenerate === 'function' && isLastAssistant(msg)) {
          rows.push({ label: s('msg.menuRegenerate'), run: () => props.onRegenerate(msg.headId || msg.id || '') });
        }
        if (!recalled && isImage && typeof props.onSaveImage === 'function') {
          rows.push({
            label: sOr('msg.menuSaveImage', 'common.save'),
            run: () => saveImageOf(msg),
          });
        }
        // 她发的表情：收藏 = 记进她「会想再发一次」的池子（包内 s0xx 和自定义 u:xxx 都认）。
        // 只对她这一侧开放 —— 自己发出去的那张本来就在库里，没有「收藏自己」这回事。
        const isSticker = msg.type === 'expression' && !!msg.stickerId;
        if (!recalled && !mine && isSticker) {
          const kept = isKept(msg.stickerId);
          rows.push({
            label: kept ? s('msg.stickerUnkeep') : s('msg.stickerKeep'),
            run: () => {
              toggleKeepSticker(msg.stickerId, {
                slot: (stickerById(msg.stickerId) || {}).slot || '',
              })
                .then((nowKept) => flashStickerNote(nowKept ? s('msg.stickerKept') : s('msg.stickerUnkept')))
                .catch(() => {});
            },
          });
        }
        // 自己发的自定义表情：删掉它（只在「我的」里也有，但这里更顺手）
        if (!recalled && mine && isSticker && isCustomStickerId(msg.stickerId)) {
          rows.push({
            label: s('msg.stickerDelete'),
            run: () => {
              deleteCustomSticker(msg.stickerId)
                .then((ok) => flashStickerNote(ok ? s('msg.stickerDeleted') : s('msg.stickerDeleteFail')))
                .catch(() => flashStickerNote(s('msg.stickerDeleteFail')));
            },
          });
        }
        if (msg.quoteOf && typeof props.onShowQuote === 'function') {
          rows.push({ label: s('msg.menuShowQuote'), run: () => props.onShowQuote(msg.quoteOf) });
        }
        return rows;
      }

      async function saveImageOf(msg) {
        const node = nodeOf(msg);
        let note = null;
        if (node) {
          note = document.createElement('span');
          note.className = 'el-msg-note';
          note.textContent = s('msg.imageSaving');
          node.append(note);
        }
        try {
          const res = await props.onSaveImage(msg.image || {});
          if (note) note.textContent = res && res.saved === false ? s('msg.imageSaveFail') : s('msg.imageSaved');
        } catch (err) {
          if (note) note.textContent = `${s('msg.imageSaveFail')}${String((err && err.message) || err).slice(0, 40)}`;
        }
        if (note) setTimeout(() => note.remove(), 1800);
      }

      function openMessageMenu(msg) {
        const rows = menuRowsFor(msg);
        if (!rows.length) return;
        openSheet('', (list) => {
          rows.forEach((row) => list.append(sheetRow(row)));
        });
      }

      // —— 音量（A5）：面板里的「音量」磁贴就是静音开关，长按才给滑杆 ——
      // 没有原生音量能力时整块磁贴不建：改不动系统音量的按钮，只会让人以为界面在骗人。
      let volumeTile = null;
      // 选图重入锁：系统选择器不能同时开两个，第二个会把第一个顶掉，回来的结果就对不上号。
      let pickingImage = false;

      // —— 表情面板（A1）：素材已经在包里（225 张 webp），分「常用 + 三套」，一页 8 个 ——
      // 打开的是底部 sheet（浮层）：先把键盘和面板收掉，
      // 否则 sheet 下面还压着键盘，关掉后人会以为「点了没反应」。
      let stickerBtn = null;
      if (typeof props.onSticker === 'function') {
        stickerBtn = document.createElement('button');
        stickerBtn.type = 'button';
        stickerBtn.className = 'el-composer-sticker';
        stickerBtn.append(iconEl('smile'));
        stickerBtn.setAttribute('aria-label', s('msg.stickerPanel'));
        stickerBtn.addEventListener('click', () => {
          setMode('text', false, false);
          field.blur();
          openStickers();
        });
        tools.insertBefore(stickerBtn, plusBtn);
      }

      const STICKER_PAGE = 8;

      /** 导入进行中：选择器是单槽的，连点两下第二下只会拿到 MEDIA_BUSY。 */
      let importing = false;

      /**
       * 「常用」在前，其余按素材里真实的套名分组（套名是中文：米仔 / 绝区零官方 / 丽都漫步）。
       * 别用 STICKER_SETS 的 key 去对 STICKERS[].kind —— kind 只有 character / bangboo 两种，
       * 照着对只会有「米仔」一个标签，另外两套整批消失。
       */
      function stickerPools() {
        const fav = STICKER_FAVORITES
          .map((f) => stickerById(f.id) || STICKERS.find((x) => x.id === f.id) || null)
          .filter(Boolean);
        const pools = [];
        if (fav.length) pools.push({ key: 'fav', label: s('msg.stickerFav'), list: fav });
        const buckets = new Map();
        STICKERS.forEach((st) => {
          const key = st.set || s('msg.stickerPanel');
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(st);
        });
        Array.from(buckets.entries())
          .sort((a, b) => b[1].length - a[1].length)
          .forEach(([label, list]) => pools.push({ key: label, label, list }));
        return pools;
      }

      /**
       * 表情面板。第一页永远是「我的」（自己导入的），后面才是包内的常用 + 三套。
       *
       * 为什么「我的」放最前：导入一张图的人，下一步一定是想发出去；
       * 把它排在四五个包内页签后面，等于让人每次先翻三页。
       *
       * 长按删除做成「页内确认条」而不是再弹一层 sheet：
       * 二次 sheet 会盖掉当前页签和页码，取消回来就不知道自己刚才在哪了。
       *
       * 永远从「我的」页开：外部入口（「+」面板的「我的表情」磁贴）只需要落到
       * 自己的表情上，不猜包内页签的序号 —— 页签数量取决于素材分组，写死 1/2/3 早晚错位。
       */
      function openStickers() {
        const pools = stickerPools();
        clearStickerSheetSubs();
        let tab = 0;
        let page = 0;
        // 待删除的自定义表情 id（长按后出现在顶部确认条里，点「删除」才真删）
        let pendingDelete = '';
        let unsubscribe = null;

        openSheet('', (list) => {
          const wrap = document.createElement('div');
          wrap.className = 'el-stk';
          const tabs = document.createElement('div');
          tabs.className = 'el-stk-tabs';
          const confirm = document.createElement('div');
          confirm.className = 'el-stk-confirm';
          const grid = document.createElement('div');
          grid.className = 'el-stk-grid';
          const pager = document.createElement('div');
          pager.className = 'el-stk-pager';
          wrap.append(tabs, confirm, grid, pager);
          list.append(wrap);

          /** 「我的」页：导入磁贴 + 已导入的格子，按 8 格一页。 */
          const mineEntries = () => [
            { add: true, id: '__add__' },
            ...customStickers().map((it) => ({ add: false, item: it })),
          ];

          const paintConfirm = () => {
            confirm.innerHTML = '';
            if (!pendingDelete) {
              confirm.hidden = true;
              return;
            }
            confirm.hidden = false;
            const tip = document.createElement('span');
            tip.className = 'el-stk-confirm-tip';
            tip.textContent = s('msg.stickerDeleteHint');
            const no = document.createElement('button');
            no.type = 'button';
            no.className = 'el-stk-confirm-btn';
            no.textContent = s('msg.stickerCancel');
            no.addEventListener('click', () => {
              pendingDelete = '';
              paintConfirm();
            });
            const yes = document.createElement('button');
            yes.type = 'button';
            yes.className = 'el-stk-confirm-btn is-danger';
            yes.textContent = s('msg.stickerDelete');
            yes.addEventListener('click', () => {
              const target = pendingDelete;
              pendingDelete = '';
              paintConfirm();
              // 删完重画：清单变化会通过订阅再触发一次 paint，这里先本地收一格免得闪
              deleteCustomSticker(target)
                .then((ok) => {
                  if (!ok) flashStickerNote(s('msg.stickerDeleteFail'));
                })
                .catch(() => flashStickerNote(s('msg.stickerDeleteFail')));
            });
            confirm.append(tip, no, yes);
          };

          const paint = () => {
            const isMine = tab === 0;
            const pool = isMine ? null : pools[tab - 1] || pools[0];
            const total = isMine ? mineEntries().length : pool.list.length;
            const pages = Math.max(1, Math.ceil(total / STICKER_PAGE));
            if (page >= pages) page = pages - 1;

            tabs.innerHTML = '';
            const myTab = document.createElement('button');
            myTab.type = 'button';
            myTab.className = 'el-stk-tab' + (isMine ? ' is-on' : '');
            myTab.textContent = s('msg.stickerMine');
            myTab.addEventListener('click', () => {
              tab = 0;
              page = 0;
              pendingDelete = '';
              paint();
            });
            tabs.append(myTab);
            pools.forEach((p, i) => {
              const b = document.createElement('button');
              b.type = 'button';
              b.className = 'el-stk-tab' + (tab === i + 1 ? ' is-on' : '');
              b.textContent = p.label;
              b.addEventListener('click', () => {
                tab = i + 1;
                page = 0;
                pendingDelete = '';
                paint();
              });
              tabs.append(b);
            });

            grid.innerHTML = '';
            paintConfirm();

            if (isMine) {
              const slice = mineEntries().slice(page * STICKER_PAGE, page * STICKER_PAGE + STICKER_PAGE);
              slice.forEach((ent) => {
                if (ent.add) {
                  grid.append(addStickerCell());
                  return;
                }
                grid.append(customStickerCell(ent.item, (id) => {
                  pendingDelete = id;
                  paintConfirm();
                }));
              });
              // 预取本页缩略图：一格一格亮起来很难看，而且面板本来就是「一眼挑一张」
              prefetchCustomStickers(
                slice.filter((e) => !e.add).map((e) => e.item.id),
              );
            } else {
              pool.list.slice(page * STICKER_PAGE, page * STICKER_PAGE + STICKER_PAGE).forEach((st) => {
                grid.append(builtinStickerCell(st));
              });
            }

            pager.innerHTML = '';
            if (pages > 1) {
              const prev = document.createElement('button');
              prev.type = 'button';
              prev.className = 'el-stk-arrow';
              prev.textContent = '‹';
              prev.disabled = page <= 0;
              prev.addEventListener('click', () => {
                if (page > 0) {
                  page -= 1;
                  paint();
                }
              });
              const info = document.createElement('span');
              info.className = 'el-stk-page';
              info.textContent = `${page + 1} / ${pages}`;
              const next = document.createElement('button');
              next.type = 'button';
              next.className = 'el-stk-arrow';
              next.textContent = '›';
              next.disabled = page >= pages - 1;
              next.addEventListener('click', () => {
                if (page < pages - 1) {
                  page += 1;
                  paint();
                }
              });
              pager.append(prev, info, next);
            }
          };

          /** 包内那一格：本来就是同步 URL，照旧。 */
          function builtinStickerCell(st) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'el-stk-cell';
            cell.setAttribute('aria-label', st.label || st.id);
            const im = document.createElement('img');
            im.src = stickerUrl(st);
            im.alt = st.label || st.id;
            im.decoding = 'async';
            im.loading = 'lazy';
            cell.append(im);
            cell.addEventListener('click', () => {
              closeSheet();
              if (typeof props.onSticker === 'function') {
                props.onSticker({ id: st.id, file: st.file, label: st.label || '' });
              }
            });
            return cell;
          }

          /** 「导入」磁贴：永远在第一格，空表时它也是唯一的格子。 */
          function addStickerCell() {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'el-stk-cell is-add';
            cell.setAttribute('aria-label', s('msg.stickerAdd'));
            cell.append(iconEl('plus'));
            const count = document.createElement('span');
            count.className = 'el-stk-add-count';
            count.textContent = `${customStickers().length}/${MAX_CUSTOM_STICKERS}`;
            cell.append(count);
            cell.addEventListener('click', () => {
              runImport(cell);
            });
            return cell;
          }

          /** 用户自己那张：URL 是异步来的，先占位再贴；长按进入删除确认。 */
          function customStickerCell(item, askDelete) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'el-stk-cell is-custom';
            cell.setAttribute('aria-label', item.label || item.name);
            const im = document.createElement('img');
            im.alt = item.label || item.name;
            im.decoding = 'async';
            im.loading = 'lazy';
            const known = customStickerUrlSync(item.id);
            if (known) im.src = known;
            else {
              cell.classList.add('is-loading');
              customStickerUrl(item.id).then((url) => {
                cell.classList.remove('is-loading');
                if (url) im.src = url;
                else cell.classList.add('is-missing');
              });
            }
            cell.append(im);

            // 长按删除：用 pointer 事件而不是 contextmenu —— WebView 里长按图片
            // 会先弹系统菜单，contextmenu 拿不到干净的一次事件。
            let timer = 0;
            let moved = false;
            let startAt = 0;
            const clear = () => {
              if (timer) clearTimeout(timer);
              timer = 0;
              moved = false;
            };
            cell.addEventListener('pointerdown', (ev) => {
              if (ev.button !== undefined && ev.button !== 0) return;
              moved = false;
              startAt = Date.now();
              timer = setTimeout(() => {
                timer = 0;
                if (moved) return;
                askDelete(item.id);
              }, 550);
            });
            cell.addEventListener('pointermove', () => {
              if (!timer) return;
              if (Date.now() - startAt > 120) moved = true;
              clear();
            });
            ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => {
              cell.addEventListener(name, clear);
            });
            cell.addEventListener('contextmenu', (ev) => ev.preventDefault());
            cell.addEventListener('click', () => {
              // 长按已触发过删除确认时，抬手那一下不该把图发出去
              if (timer || Date.now() - startAt < 250) return;
              closeSheet();
              if (typeof props.onSticker === 'function') {
                props.onSticker({ id: item.id, file: item.name, label: item.label || '' });
              }
            });
            return cell;
          }

          paint();
          // 导入/删除之后清单会变，页签内容要跟着重画（不然删了还留在格子里）
          unsubscribe = onCustomStickersChange(() => {
            if (pendingDelete) return; // 确认条还开着，别在用户点「删除」前把格子换掉
            paint();
          });
          stickerSheetUnsubs.push(unsubscribe);
        });
      }

      /**
       * 一句轻提示（导入成功 / 删掉了 / 已收藏）。
       * 挂到视图根节点而不是 sheetList：长按菜单点完那一行 sheet 就关了，
       * 提示要是跟着 sheet 一起消失，用户会以为「刚才那下没生效」。
       */
      function flashStickerNote(text) {
        const node = document.createElement('div');
        node.className = 'el-stk-note';
        node.textContent = text;
        el.append(node);
        setTimeout(() => node.remove(), 1800);
      }

      /** 导入一张自定义表情。原生负责缩放/判动图，这里只处理结果与提示。 */
      async function runImport(cell) {
        if (importing) return;
        importing = true;
        if (cell) cell.classList.add('is-busy');
        try {
          const res = await importCustomSticker({
            slot: '',
            label: '',
          });
          if (res) flashStickerNote(s('msg.stickerImported'));
        } catch (err) {
          const code = (err && err.code) || '';
          if (code === 'STICKER_LIMIT') flashStickerNote(s('msg.stickerLimit'));
          else if (code === 'MEDIA_TOO_LARGE' || code === 'STICKER_TOO_LARGE') {
            flashStickerNote(s('msg.stickerTooLarge'));
          } else if (code === 'STICKER_NO_NATIVE') flashStickerNote(s('msg.stickerImportUnsupported'));
          else flashStickerNote(`${s('msg.stickerImportFail')}${code || ''}`);
        } finally {
          importing = false;
          if (cell) cell.classList.remove('is-busy');
        }
      }

      let volume = 60;
      let muted = false;
      let lastLoud = 60;
      // 面板打开时指向面板里的几个控件；面板关了置 null（paintVolumeUi 靠它判断要不要画）
      let volUi = null;

      function volumePercent(v) {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(100, n));
      }

      /** 面板磁贴 / sheet 控件的显示。只在有控件时才碰 DOM。 */
      function paintVolumeUi(supported) {
        const ok = typeof supported === 'boolean' ? supported : volumeSupported();
        // 磁贴是每次开面板现建的：这里只管「当前这一块」的样子，别去创建它
        if (volumeTile) {
          volumeTile.classList.toggle('is-muted', muted);
          volumeTile.setAttribute('aria-pressed', muted ? 'true' : 'false');
          const ico = volumeTile.querySelector('.el-chat-panel-ico');
          if (ico) ico.replaceChildren(iconEl(muted ? 'muted' : 'volume'));
          const sub = volumeTile.querySelector('.el-chat-panel-sub');
          if (sub) sub.textContent = muted ? s('volume.muted') : `${volume}%`;
        }
        if (!volUi) return;
        if (volUi.slider.value !== String(volume)) volUi.slider.value = String(volume);
        volUi.slider.disabled = !ok;
        volUi.pct.textContent = `${volume}%`;
        volUi.mute.classList.toggle('is-on', muted);
        volUi.mute.replaceChildren(iconEl(muted ? 'muted' : 'volume'));
        volUi.hint.textContent = muted
          ? s('volume.muted')
          : ok
            ? s('volume.hint')
            : sOr('volume.notOnDevice', 'volume.unsupported');
      }

      /** 立刻把音量写下去（滑杆本体的节流在 core/volume.js 里，这里是「松手/点静音」的即时值）。 */
      function applyVolume(next) {
        volume = volumePercent(next);
        if (volume > 0) lastLoud = volume;
        muted = volume === 0;
        writeVolume(volume);
        paintVolumeUi();
      }

      function openVolumePanel() {
        const supported = volumeSupported();
        openSheet(s('volume.title'), (list) => {
          const row = document.createElement('div');
          row.className = 'el-volume-row';

          const slider = document.createElement('input');
          slider.type = 'range';
          slider.min = '0';
          slider.max = '100';
          slider.step = '1';
          slider.className = 'el-volume-slider';
          slider.value = String(volume);
          slider.disabled = !supported;
          slider.setAttribute('aria-label', s('volume.title'));

          const pct = document.createElement('span');
          pct.className = 'el-volume-pct';
          pct.textContent = `${volume}%`;

          const mute = document.createElement('button');
          mute.type = 'button';
          mute.className = 'el-volume-mute';
          mute.setAttribute('aria-label', s('volume.muted'));
          mute.append(iconEl(muted ? 'muted' : 'volume'));

          row.append(slider, pct, mute);

          const hint = document.createElement('p');
          hint.className = 'el-volume-hint';

          list.append(row, hint);
          volUi = { slider, pct, mute, hint };

          slider.addEventListener('input', (e) => applyVolume(e.target.value));
          slider.addEventListener('change', () => {
            // 松手那一刻不等节流窗口，直接把尾包写掉（人已经停了）
            flushVolume();
          });
          mute.addEventListener('click', () => applyVolume(muted ? lastLoud || 60 : 0));

          paintVolumeUi(supported);
        });
        // 面板先按镜像画，再问原生要真实值（避免打开时闪一下 0%）
        readVolume().then((res) => {
          if (!volUi) return;
          volume = volumePercent(res && res.volume);
          if (volume > 0) lastLoud = volume;
          muted = volume === 0;
          paintVolumeUi(!!(res && res.supported));
        });
      }

      // ============================================================
      // 「+」面板：按「本机真能做」的能力现生成磁贴
      // 这一轮的实际清单（2026-11）：
      //   · 相册     app 层给了 onPickImage 且在原生壳里（mediaSupported）
      //   · 拍照     只有能力表里有 CAMERA / app 层给了 onTakePhoto 才建（当前壳没有相机通路）
      //   · 我的表情 永远在，占位页签，下一条任务接
      //   · 音量     只有原生能改系统音量才建（volumeSupported），行为 = 静音开关
      // 空着的面板比一排点了没反应的按钮诚实，所以缺能力的项一律不建节点。
      // ============================================================

      let panelTab = 'tools';

      /**
       * 一块磁贴。icon 传节点或返回节点的函数（音量表要随静音状态换图标）。
       * keepOpen=true 的动作不关闭面板（切页签、切静音这类「还想继续看」的操作）。
       */
      function panelTile(spec) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'el-chat-panel-tile';
        tile.dataset.tile = spec.key;

        const ico = document.createElement('span');
        ico.className = 'el-chat-panel-ico';
        ico.append(typeof spec.icon === 'function' ? spec.icon() : spec.icon);

        const label = document.createElement('span');
        label.className = 'el-chat-panel-label';
        label.textContent = spec.label;

        tile.append(ico, label);
        if (spec.sub) {
          const sub = document.createElement('span');
          sub.className = 'el-chat-panel-sub';
          sub.textContent = spec.sub;
          tile.append(sub);
        }
        if (typeof spec.run === 'function') {
          tile.addEventListener('click', () => {
            // 关面板必须走 setMode('text')，不能只 closePanel()：
            // 后者只收 DOM，state.mode 还停在 'panel' —— 下次点「+」会被当成
            // 「面板已经开着，再点=收起」，结果弹出键盘、面板不出现。
            // focusInput=false：选图/拍照马上要开系统界面，这里别把软键盘顶起来。
            if (!spec.keepOpen) setMode('text', false, false);
            spec.run();
          });
        }
        if (typeof spec.long === 'function') {
          // Android WebView 的长按走 contextmenu；音量滑杆这条进阶入口挂在这儿
          tile.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            setMode('text', false, false);
            spec.long();
          });
        }
        return tile;
      }

      /** 相册：和旧「+」按钮同一条路（core/media.js 的 pickImage → app 层 onPickImage）。 */
      async function pickFromAlbum() {
        if (pickingImage || !mediaSupported() || typeof props.onPickImage !== 'function') return;
        pickingImage = true;
        try {
          const picked = await pickImage();
          // picked:false = 用户取消 / 浏览器环境 / 上一次还没回来，都不用说话
          if (picked && picked.picked) await props.onPickImage(picked);
        } catch (err) {
          console.warn('[chat] 选图失败', err);
        } finally {
          pickingImage = false;
        }
      }

      /**
       * 拍照能力探测。core/media.js 目前只有 pickImage / saveToAlbum，
       * 所以默认没有相机 —— 别在这里假装调一个不存在的原生方法，
       * 那正是「按钮点了没反应」那一类老 bug 的来源。
       */
      function cameraSupported() {
        if (typeof props.onTakePhoto === 'function') return true;
        const caps = props.capabilities;
        if (Array.isArray(caps)) return caps.includes('CAMERA');
        if (caps && typeof caps === 'object') return caps.CAMERA === true;
        return false;
      }

      function albumTile() {
        return panelTile({
          key: 'album',
          icon: iconEl('background'),
          label: s('chat.panelAlbum'),
          run: () => pickFromAlbum(),
        });
      }

      function cameraTile() {
        // icons.js 里没有相机图标（那文件不归这条任务改），就地手写一个同规格的
        const cam = document.createElement('span');
        cam.className = 'el-icon';
        cam.setAttribute('aria-hidden', 'true');
        cam.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"></path>' +
          '<circle cx="12" cy="13" r="3.2"></circle>' +
          '</svg>';
        return panelTile({
          key: 'camera',
          icon: cam,
          label: s('chat.panelCamera'),
          run: () => {
            if (typeof props.onTakePhoto === 'function') props.onTakePhoto();
          },
        });
      }

      /** 通话：和相册/表情/音量同一层，点进去是全屏通话页（不是开关，所以 keepOpen 不设）。 */
      function callTile() {
        const phone = document.createElement('span');
        phone.className = 'el-icon';
        phone.setAttribute('aria-hidden', 'true');
        phone.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M6.5 3.5h3l1.5 4-2 1.4a11.5 11.5 0 0 0 6.1 6.1l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z"></path>' +
          '</svg>';
        return panelTile({
          key: 'call',
          icon: phone,
          label: sOr('chat.panelCall', '语音通话'),
          run: () => {
            // 进通话页前把输入区收回键盘态：面板/语音态留在下面，回来时不会半开着
            setMode('text', false, false);
            props.onOpenCall ? props.onOpenCall() : push('call');
          },
        });
      }

      function mineTile() {
        return panelTile({
          key: 'mine',
          icon: iconEl('smile'),
          label: s('chat.panelMine'),
          // 不再进面板里的占位页：直接开表情 sheet 的第一页（「我的」），
          // 那里才是真正的导入 / 收藏 / 长按删除。两处各写一套必然走偏。
          run: () => {
            setMode('text', false, false);
            openStickers();
          },
        });
      }

      function volumeTileEl() {
        return panelTile({
          key: 'volume',
          icon: () => iconEl(muted ? 'muted' : 'volume'),
          label: s('chat.panelVolume'),
          sub: muted ? s('volume.muted') : `${volume}%`,
          keepOpen: true,
          // 面板里这块就是「静音开关」；要连续调音量走长按 → 滑杆 sheet
          run: () => applyVolume(muted ? lastLoud || 60 : 0),
          long: () => openVolumePanel(),
        });
      }

      /**
       * 「我的表情」占位页。
       * 下一条任务接法：把这里换成真实的表情管理（收藏 / 上传 / 长按删除）。
       * 入口已经通了 —— plusBtn 打开面板后点「我的表情」磁贴，
       * 或者外部直接 api.openComposerPanel('mine')；磁贴本身不用改。
       */
      function renderPanelMine() {
        panelMine.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'el-chat-panel-head';

        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'el-chat-panel-back';
        back.append(iconEl('back'));
        back.setAttribute('aria-label', s('chat.panelBack'));
        back.addEventListener('click', () => openPanel('tools'));

        const title = document.createElement('span');
        title.className = 'el-chat-panel-title';
        title.textContent = s('chat.panelMine');

        head.append(back, title);

        const empty = document.createElement('p');
        empty.className = 'el-chat-panel-empty';
        empty.textContent = s('chat.panelMineEmpty');

        panelMine.append(head, empty);
      }

      /** 面板内容按「这一瞬间的能力」重建：静音状态、原生能力都可能在这期间变过。 */
      function paintPanel() {
        panelGrid.innerHTML = '';
        volumeTile = null;

        const tiles = [];
        if (typeof props.onPickImage === 'function' && mediaSupported()) tiles.push(albumTile());
        if (cameraSupported()) tiles.push(cameraTile());
        tiles.push(mineTile());
        tiles.push(callTile());
        if (volumeSupported()) {
          volumeTile = volumeTileEl();
          tiles.push(volumeTile);
        }
        tiles.forEach((tile) => panelGrid.append(tile));

        panelGrid.hidden = panelTab !== 'tools';
        panelMine.hidden = panelTab !== 'mine';
        if (panelTab === 'mine') renderPanelMine();
        paintVolumeUi();
      }

      /**
       * 开面板。它是 composer 最后一个子节点：一长高，flex 就从 .el-chat-stream 里
       * 拿走对应高度 —— 消息列表被顶起来，最后几条不会被面板盖住。
       */
      function openPanel(tab = 'tools') {
        panelTab = tab === 'mine' ? 'mine' : 'tools';
        paintPanel();
        panel.hidden = false;
        plusBtn.setAttribute('aria-expanded', 'true');
        // 同一帧里改 transform 不会触发过渡，必须等下一帧
        requestAnimationFrame(() => panel.classList.add('is-open'));
        // 顶起之后仍然停在最后一条，别让人以为消息被吃掉了几条
        stream.scrollTop = stream.scrollHeight;
      }

      function closePanel() {
        if (panel.hidden) return;
        panel.classList.remove('is-open');
        // 直接收，不做退场：退场动画会让 stream 的高度晚一帧才回来，滚动位置会跳
        panel.hidden = true;
        panelGrid.innerHTML = '';
        panelMine.innerHTML = '';
        panelTab = 'tools';
        volumeTile = null;
        plusBtn.setAttribute('aria-expanded', 'false');
      }


      // 原生按档位取整，set 回来的是「真实百分比」：必须回填，否则界面显示 37%、手机实际 40%。
      const offVolume = onVolumeChange((snap) => {
        if (!snap) return;
        volume = volumePercent(snap.volume);
        if (volume > 0) lastLoud = volume;
        muted = volume === 0 || !!snap.muted;
        paintVolumeUi(!!snap.supported);
      });

      // 首屏：先按镜像画（不闪），再问一次原生。浏览器里连问都不问。
      paintVolumeUi(volumeSupported());
      if (volumeSupported()) {
        readVolume().then((res) => {
          volume = volumePercent(res && res.volume);
          if (volume > 0) lastLoud = volume;
          muted = volume === 0;
          paintVolumeUi(!!(res && res.supported));
        });
      }

      // —— 定位到某条消息（引用条点击 / 外部调用）——
      function scrollToId(id) {
        const key = String(id || '');
        if (!key) return false;
        const nodes = stream.querySelectorAll('.el-msg');
        for (let i = 0; i < nodes.length; i += 1) {
          const node = nodes[i];
          if (node.dataset.headId !== key && node.dataset.keyId !== key) continue;
          node.scrollIntoView({ block: 'center', behavior: 'smooth' });
          node.classList.add('is-target');
          setTimeout(() => node.classList.remove('is-target'), 1400);
          return true;
        }
        return false;
      }

      /** 找最后一条带 detail 的失败消息，把它挂到系统条上；点一下算「知道了」。 */
      function paintSystemStrip() {
        const msgs = state.messages || [];
        let idx = -1;
        // 只看最后两条：历史里的旧失败不该每次开 App 都挂一条在顶上。
        for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 2); i -= 1) {
          if (msgs[i] && msgs[i].detail) { idx = i; break; }
        }
        if (idx < 0 || idx <= dismissedAt) {
          systemStrip.hidden = true;
          systemStrip.textContent = '';
          return;
        }
        systemStrip.hidden = false;
        systemStrip.textContent = String(msgs[idx].detail);
      }

      function fmtMs(v) {
        const total = Math.max(0, Math.round((Number(v) || 0) / 1000));
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      }

      let voiceErrorTimer = null;

      /** 录音浮层只认这一个入口：控制器的 onState 直接调它，视图不自己猜状态。 */
      function setVoiceState(st) {
        const phase = (st && st.phase) || 'idle';
        const cancel = !!(st && st.cancel);
        // arming 只是「手指按下了，还在等录音器就绪」，不算在录：
        // 权限被拒、录音器起不来的时候，点亮 is-recording 会骗人。
        const arming = phase === 'arming';
        const active = phase === 'recording' || phase === 'cancelling';
        if (voiceErrorTimer) {
          clearTimeout(voiceErrorTimer);
          voiceErrorTimer = null;
          hud.classList.remove('is-error');
        }
        hud.hidden = !arming && !active && phase !== 'transcribing';
        hud.classList.toggle('is-arming', arming);
        hud.classList.toggle('is-recording', active);
        hud.classList.toggle('is-cancelling', cancel && active);
        hud.classList.toggle('is-writing', phase === 'transcribing');
        holdBtn.classList.toggle('is-pressed', arming || active);
        holdBtn.classList.toggle('is-cancel', cancel && active);
        hudTimer.textContent = fmtMs(st && st.ms);
        if (phase === 'transcribing') hudHint.textContent = VT.writing;
        else if (cancel) hudHint.textContent = VT.releaseCancel;
        else if (phase === 'recording') hudHint.textContent = VT.releaseSend;
        else if (arming) hudHint.textContent = (Number(st && st.ms) || 0) > ARMING_WAIT_MS ? s('chat.voiceArmingWait') : VT.arming;
        else hudHint.textContent = VT.slideCancel;
      }

      /** 错误码 → 一行人话，浮层变红 1.4 s 后自己收起（别卡在「在听写…」）。 */
      function setVoiceError(err) {
        const code = (err && err.code) || '';
        const text =
          code === 'VOICE_TOO_SHORT'
            ? VT.tooShort
            : code === 'AUDIO_PERMISSION'
              ? s('chat.voiceNeedPermission')
              : code === 'AUDIO_BUSY'
                ? s('chat.voiceBusy')
                : code === 'ASR_NOT_CONFIGURED'
                  ? s('chat.voiceNeedConfig')
                  : code === 'ASR_NETWORK'
                    ? s('chat.voiceNetFail')
                    : `${s('chat.voiceFailed')}${String((err && err.message) || code).slice(0, 40)}`;
        hud.hidden = false;
        hud.classList.remove('is-recording', 'is-cancelling', 'is-writing', 'is-arming');
        hud.classList.add('is-error');
        hudHint.textContent = text;
        hudTimer.textContent = '';
        if (voiceErrorTimer) clearTimeout(voiceErrorTimer);
        voiceErrorTimer = setTimeout(() => {
          voiceErrorTimer = null;
          hud.classList.remove('is-error');
          hud.hidden = true;
        }, 1400);
      }

      /**
       * 三态互斥：text（键盘） / voice（按住说话） / panel（「+」面板）。
       * 切走时先把上一个态带出来的东西收干净 —— 面板收起、录音作废、键盘落下：
       *   · 进 voice：收面板 + 失焦（键盘落下去），只留「按住说话」；
       *   · 进 panel：收语音（正在录的那条作废）+ 失焦，面板顶起消息流；
       *   · 进 text ：收面板 + 收起录音浮层，焦点回到输入框。
       * 同一态的重复调用直接返回：不然「再点一次 +」会先走一遍关闭流程，把面板自己关掉。
       * 第三个参数 focusInput=false 用于「只要收起、别把键盘叫起来」（开浮层前）。
       */
      function setMode(next, notify = true, focusInput = true) {
        const mode = next === 'voice' ? 'voice' : next === 'panel' ? 'panel' : 'text';
        const prev = state.mode;
        if (prev === mode) {
          // panel 重复进来要重画（切页签 / 能力变了），其它态直接当作已就位
          if (mode === 'panel') openPanel(panelTab);
          return;
        }
        state.mode = mode;

        const voice = mode === 'voice';
        const panelMode = mode === 'panel';

        if (!panelMode) closePanel();

        if (prev === 'voice' && !voice) {
          // 从语音态切走：还在录的那条直接作废，别留半段录音在后台
          holdPointer = null;
          if (props.voice) props.voice.cancel();
          hud.hidden = true;
        }

        composer.classList.toggle('is-voice', voice);
        composer.classList.toggle('is-panel', panelMode);
        micBtn.hidden = voice;
        keyboardBtn.hidden = !voice;
        field.hidden = voice;
        holdBtn.hidden = !voice;

        if (mode === 'text' && focusInput) field.focus();
        else field.blur();

        if (panelMode) openPanel(panelTab);

        syncBusy();
        // app 层只认两态：面板态对它是「文字态」（面板不该把人当成在说话）
        if (notify && props.onVoiceMode) props.onVoiceMode(voice ? 'voice' : 'text');
      }

      function renderEmpty() {
        const wrap = document.createElement('div');
        wrap.className = 'el-chat-empty';

        const title = document.createElement('h2');
        title.className = 'el-chat-empty-title';
        title.textContent = s('chat.emptyTitle');

        const hint = document.createElement('p');
        hint.className = 'el-chat-empty-hint';
        hint.textContent = state.model ? s('chat.emptyHintReady') : s('chat.emptyHint');

        const actions = document.createElement('div');
        actions.className = 'el-chat-empty-actions';

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'el-chat-model-chip';
        if (state.model) {
          chip.textContent = state.model;
        } else {
          chip.classList.add('is-unset');
          chip.textContent = s('chat.noModel');
          chip.addEventListener('click', () => props.onRequestModel && props.onRequestModel());
        }

        const thinking = document.createElement('span');
        thinking.className = 'el-chat-thinking-chip';
        thinking.textContent = s('chat.thinkingChip');

        actions.append(chip, thinking);
        wrap.append(title, hint, actions);
        return wrap;
      }

      // 正在念的那条气泡。点同一个再点一次 = 停下来。
      let speakingNode = null;

      /**
       * 念这一条；再念同一条 = 停下。
       * 气泡上的朗读按钮和长按菜单里的「朗读」共用这一个函数 —— 各写一套的话
       * 「当前在念哪条」会记两份，从另一条路进来就关不掉了。
       */
      async function toggleSpeak(msg, node) {
        if (!node) return;
        // 朗读和语音条共用一对耳朵：先按掉正在放的那条，再念
        stopActiveBar();
        const same = speakingNode === node;
        if (speakingNode) {
          speakingNode.classList.remove('is-speaking');
          speakingNode = null;
        }
        await stopSpeaking().catch(() => {});
        if (same) return;
        const body = plain(msg.text);
        if (!body) return;
        node.classList.add('is-speaking');
        speakingNode = node;
        const res = await speak(body).catch((err) => ({ error: String(err) }));
        if (res && (res.error || res.speaking === false)) {
          node.classList.remove('is-speaking');
          if (speakingNode === node) speakingNode = null;
        }
      }

      function speakButton(msg, node) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-msg-speak';
        btn.setAttribute('aria-label', '念出来');
        btn.append(iconEl('volume'));
        btn.addEventListener('click', () => {
          toggleSpeak(msg, node);
        });
        return btn;
      }


      // —— 波形条 ——
      // 她发的随机语音条、自己发出去的语音消息共用这一套（waveBar）。
      // peaks 是 0-100 的整数数组，高度只给 6 档 class：视图层不许写内联 style。
      const clipCache = new Map();
      const voiceCache = new Map();

      function levelOf(v) {
        const n = Math.max(0, Math.min(100, Number(v) || 0));
        if (n < 12) return 1;
        if (n < 30) return 2;
        if (n < 50) return 3;
        if (n < 68) return 4;
        if (n < 86) return 5;
        return 6;
      }

      // 同一时刻只许一条在放：语音条 / 语音消息 / 朗读按钮共用这一个「当前播放」槽。
      // 不互斥的话，点第二条时第一条还在响，两条声音叠在一起（真机上很难听清是哪句）。
      let activeBar = null;

      function stopActiveBar() {
        const cur = activeBar;
        activeBar = null;
        if (!cur) return;
        cur.bar.classList.remove('is-playing');
        if (!cur.audio) return;
        try {
          cur.audio.pause();
        } catch (err) {
          /* 已经结束/被回收，忽略 */
        }
      }

      /**
       * @param {{peaks?: number[], durationMs: number, label?: string, className?: string,
       *          bars?: number, onPlay?: () => Promise<string>}} opts
       * onPlay 返回可播的 blob URL；返回空串/抛错 = 这一条播不出来（条变红，不崩）。
       */
      function waveBar(opts = {}) {
        const bar = document.createElement('button');
        bar.type = 'button';
        bar.className = `el-msg-clip ${opts.className || ''}`.trim();
        if (opts.label) bar.setAttribute('aria-label', opts.label);
        const dot = document.createElement('span');
        dot.className = 'el-msg-clip-dot';
        const wave = document.createElement('span');
        wave.className = 'el-msg-clip-wave';
        const bars = Math.max(1, Math.min(24, opts.bars || 12));
        const peaks = Array.isArray(opts.peaks) && opts.peaks.length ? opts.peaks : [];
        for (let i = 0; i < bars; i += 1) {
          const tick = document.createElement('i');
          const at = peaks.length ? peaks[Math.floor((i / bars) * peaks.length)] : 0;
          if (peaks.length) tick.className = `lv${levelOf(at)}`;
          wave.append(tick);
        }
        const len = document.createElement('span');
        len.className = 'el-msg-clip-len';
        len.textContent = `${Math.max(1, Math.round((Number(opts.durationMs) || 0) / 1000))}″`;

        let audio = null;
        bar.addEventListener('click', async () => {
          if (bar.disabled) return;
          if (audio && !audio.paused) {
            audio.pause();
            bar.classList.remove('is-playing');
            if (activeBar && activeBar.bar === bar) activeBar = null;
            return;
          }
          if (!opts.onPlay) return;
          bar.classList.remove('is-failed');
          bar.classList.add('is-loading');
          let url = '';
          try {
            url = await opts.onPlay();
          } catch (err) {
            url = '';
          }
          bar.classList.remove('is-loading');
          if (!url) {
            bar.classList.add('is-failed');
            return;
          }
          // 换这条之前先把上一条按掉（合成/读盘是异步的，等回来时上一条可能已经在放了）
          stopActiveBar();
          // 她的朗读和气泡播放会打架：播放前先让她闭嘴
          stopSpeaking().catch(() => {});
          audio = new Audio(url);
          activeBar = { bar, audio };
          audio.addEventListener('ended', () => {
            bar.classList.remove('is-playing');
            if (activeBar && activeBar.bar === bar) activeBar = null;
          });
          bar.classList.add('is-playing');
          audio.play().catch(() => {
            bar.classList.remove('is-playing');
            if (activeBar && activeBar.bar === bar) activeBar = null;
          });
        });

        bar.append(dot, wave, len);
        return bar;
      }

      // 她的随机语音条：点一下才合成播放（合成要花 minimax 的钱，没人点就别花）。
      function clipBar(msg, node) {
        // 失败时贴在气泡里的一行人话：下一次点击自动消失。
        // 没有它的话，重试虽然真的在跑（synthesize 会被再调一次），但界面上什么都没变，
        // 用户看到的就是「点了没反应」，只能杀进程重进。
        const note = document.createElement('span');
        note.className = 'el-msg-clip-note';
        note.hidden = true;
        const clearFail = () => {
          node.classList.remove('is-clip-failed');
          note.hidden = true;
          note.textContent = '';
        };
        const chars = plain(msg.text).length;

        const bar = waveBar({
          durationMs: Math.max(2, Math.round(chars / 5)) * 1000,
          label: '语音条',
          onPlay: async () => {
            // 一按下去就把上一次的失败痕迹摘干净，加载态才看得见
            clearFail();
            const hit = clipCache.get(msg.id);
            if (hit) return hit;
            const res = await synthesizeUrl(msg.text).catch((err) => ({
              error: String((err && err.message) || err),
              code: (err && err.code) || '',
            }));
            if (!res || res.error) {
              node.classList.add('is-clip-failed');
              note.textContent =
                res && res.code === 'NO_API_KEY'
                  ? '还没配朗读的 key，去设置 → 声音里填一下'
                  : '这条念不出来，等下再点一次';
              // 文案挂在条下面（当条的小字注释），不是条上面——否则读起来像正文的一部分
              if (!note.isConnected) node.insertBefore(note, bar.nextSibling);
              note.hidden = false;
              return '';
            }
            clipCache.set(msg.id, res.url);
            return res.url;
          },
        });
        return bar;
      }

      // 自己发出去的语音消息：气泡里只有波形 + 时长，文字只挂 aria-label。
      // 播放要先把附件读回 base64 再转 blob URL（WebView 不能直接播 content://）。
      function voiceBubble(msg) {
        const audio = msg.audio || {};
        const missing = !!audio.missing;
        const asrFailed = !!(msg.speech && msg.speech.failed);
        const classes = ['el-msg-voice'];
        if (missing) classes.push('is-missing');
        if (asrFailed) classes.push('is-asr-failed');
        if (audio.preparing) classes.push('is-preparing');

        const bar = waveBar({
          peaks: audio.peaks,
          durationMs: audio.durationMs,
          bars: 14,
          label: String(msg.text || s('chat.voiceMessageLabel')),
          className: classes.join(' '),
          onPlay: missing
            ? null
            : async () => {
                const key = String(audio.uri || audio.name || msg.id);
                const hit = voiceCache.get(key);
                if (hit) return hit;
                const res = await readDocument(audio.uri || audio.name).catch(() => null);
                if (!res || !res.base64) {
                  // 文件被 200 MB 清理删掉了：就地标 missing 并落库，下次打开就不用再试
                  if (typeof props.onVoiceMissing === 'function') props.onVoiceMissing(msg.id, audio);
                  return '';
                }
                const url = toBlobUrl(res.base64, res.mimeType || 'audio/wav', `voice:${key}`);
                voiceCache.set(key, url);
                return url;
              },
        });
        if (missing) {
          bar.disabled = true;
          bar.setAttribute('aria-disabled', 'true');
          bar.setAttribute('title', VT.missing);
        }
        return bar;
      }

      /** 气泡正文：富文本 + tone 小字（12 号档）。renderMessage 与 patchLast 共用同一套。 */
      function paintBody(body, msg) {
        body.innerHTML = renderRichText(msg.text);
        const tone = String(msg.tone || '').trim();
        if (!tone) return;
        const tag = document.createElement('span');
        tag.className = 'el-msg-tone';
        tag.textContent = `${s('msg.tonePrefix')}${tone}`;
        body.append(tag);
      }

      /**
       * 引用块：这条消息引的是哪一句。
       * 原消息被撤回/清掉了（quoteMissing）就明说「原消息不见了」，不给一个点了没反应的框。
       */
      function quotedBlock(msg) {
        const quote = msg.quoteOf;
        if (!quote) return null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-msg-quoted';
        if (msg.quoteMissing) btn.classList.add('is-missing');
        const who = document.createElement('span');
        who.className = 'el-msg-quoted-who';
        who.textContent = `${speakerLabel(quote.role || 'assistant')}:`;
        const text = document.createElement('span');
        text.className = 'el-msg-quoted-text';
        text.textContent = msg.quoteMissing ? s('msg.quoteMissing') : truncateQuote(quote.text, 60);
        btn.append(who, text);
        btn.addEventListener('click', () => {
          if (suppressTapUntil > Date.now()) return;
          // app 层给了回调就交给它（可能要跨页跳）；没给就自己滚过去
          if (typeof props.onShowQuote === 'function') {
            props.onShowQuote(quote);
            return;
          }
          scrollToId(quote.headId);
        });
        return btn;
      }

      /** 一条消息长什么样：撤回 / 表情 / 图片 / 语音气泡 / 文字。patchLast 也用它比对结构。 */
      function shapeOf(msg) {
        if (msg.recalled === true) return 'recalled';
        const type = String(msg.type || '');
        if (type === 'expression') return 'expression';
        if (type === 'image') return 'image';
        if (msg.audio) return 'voice';
        return 'text';
      }

      function renderMessage(msg, enter) {
        const node = document.createElement('div');
        node.className = 'el-msg';
        if (enter) node.classList.add('zz-anim-pop');
        node.dataset.role = msg.role === 'user' ? 'user' : 'assistant';
        // 长按菜单、引用回跳、撤回都靠这两个 data 反查 DOM；headId 是「这一轮」的 id
        node.dataset.headId = String(msg.headId || msg.id || '');
        node.dataset.keyId = String(msg.id || '');
        if (msg.pending) node.dataset.pending = '1';
        if (msg.failed) node.dataset.failed = '1';

        const shape = shapeOf(msg);
        node.dataset.shape = shape;

        // 撤回：只剩一行灰字。正文一个字都不渲染 —— 留着正文等于「撤回」这两个字没有意义，
        // 而且整包导出时会把撤回的内容一起带走。
        if (shape === 'recalled') {
          node.classList.add('el-msg-recalled');
          node.append(recallLine(msg));
          return node;
        }

        const quote = quotedBlock(msg);

        if (shape === 'expression') {
          node.append(expressionBubble(msg));
        } else if (shape === 'image') {
          node.append(imageBubble(msg));
        } else if (shape === 'voice') {
          // 语音消息：气泡里只有波形，一个字都不渲染（text 走 aria-label，复制/搜索仍拿得到）
          node.classList.add('el-msg-has-voice');
          const body = document.createElement('div');
          body.className = 'el-msg-body';
          body.hidden = true;
          node.append(voiceBubble(msg), body);
        } else {
          // type === 'voice'（老语音条）也落到这条分支：正文照排，右下角多一个播放条
          const body = document.createElement('div');
          body.className = 'el-msg-body';
          paintBody(body, msg);
          node.append(body);
        }

        if (quote) node.append(quote);

        // 只有她说的话带朗读按钮（自己说的话自己知道）
        if (msg.role !== 'user' && !msg.pending && !msg.failed && String(msg.text || '').trim()) {
          if (msg.voice) node.append(clipBar(msg, node));
          node.append(speakButton(msg, node));
        }
        // 撤回的、待定的一律不给菜单（能做的动作要么不存在，要么点了没意义）
        if (!msg.pending) attachLongPress(node, msg);
        return node;
      }

      /** 只更新最后一条气泡，不做整页重排（流式时每块都走这里）。 */
      function patchLast(patch) {
        const last = state.messages[state.messages.length - 1];
        if (!last) return;
        Object.assign(last, patch);
        const nodes = stream.querySelectorAll('.el-msg');
        const node = nodes[nodes.length - 1];
        if (!node) return;
        // 结构变了（刚被撤回 / 刚变成图片或表情）就不是改字能解决的：整块换掉
        const shape = shapeOf(last);
        if (node.dataset.shape && node.dataset.shape !== shape) {
          node.replaceWith(renderMessage(last));
          paintSystemStrip();
          return;
        }
        const body = node.querySelector('.el-msg-body');
        if (body) {
          // 语音消息不渲染文字：只在收尾补 patch 时把 body 藏起来（气泡里的波形节点已经在了）
          if (last.audio) {
            node.classList.add('el-msg-has-voice');
            body.hidden = true;
          } else {
            body.hidden = false;
            paintBody(body, last);
          }
        }
        if (last.pending) node.dataset.pending = '1';
        else delete node.dataset.pending;
        if (last.failed) node.dataset.failed = '1';
        else delete node.dataset.failed;
        paintSystemStrip();
      }

      let painted = false;

      function render() {
        stream.innerHTML = '';
        if (!state.messages.length) {
          stream.append(renderEmpty());
          return;
        }
        // 只有「新到的最后两条」播入场；历史不重播（否则每次切页都像下暴雨）
        const last = state.messages.length - 1;
        state.messages.forEach((msg, i) => {
          stream.append(renderMessage(msg, painted && i >= last - 1));
        });
        painted = true;
        paintSystemStrip();
        stream.scrollTop = stream.scrollHeight;
      }

      function syncBusy() {
        const voice = state.mode === 'voice';
        // 发送只在「有字要发」时才出现（QQ/微信同款），所以整行跟着它一起收：
        // 空输入区里挂着一个半透明的发送键，会让人以为按了能发空消息。
        const canSend = !state.busy && !voice && !!field.value.trim();
        sendBtn.hidden = !canSend;
        stopBtn.hidden = !state.busy;
        sendBtn.disabled = !canSend;
        sendRow.hidden = sendBtn.hidden && stopBtn.hidden;
        // 她在说话的时候不许开新录音：一次只跑一条
        holdBtn.disabled = state.busy;
      }

      function autosize() {
        // 语音态下输入框是隐藏的，scrollHeight 读出来是 0，会把高度写成一行
        if (field.hidden) return;
        field.style.height = 'auto';
        field.style.height = `${Math.min(field.scrollHeight, 126 * 0.2315 * 0.5 + 60)}px`;
      }

      function submit() {
        const text = field.value.trim();
        if (!text || state.busy) return;
        // 引用只在这一条消息上有效：先取下来再清条，别让下一条也带着它
        const extra = quoteRef ? { quoteOf: quoteRef } : null;
        clearQuote();
        field.value = '';
        autosize();
        syncBusy();
        // 第一个参数永远是 string（老 main.js 只认一个参数），引用这种附加信息走第二参数
        if (props.onSend) {
          if (extra) props.onSend(text, extra);
          else props.onSend(text);
        }
      }

      field.addEventListener('input', () => {
        autosize();
        syncBusy();
      });
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
      });
      // 按住说话：pointerdown 开录、上滑取消、松手收尾。
      // 状态机（300ms 起录、700ms 下限、48px 取消、60s 上限）全在 core/voice-input.js，
      // 这里只负责把坐标搬过去，不做任何判定。
      const voice = props.voice || (window.__ellenChatDebug && window.__ellenChatVoice) || null;
      let holdPointer = null;
      holdBtn.addEventListener('pointerdown', (e) => {
        if (!voice || state.busy || holdPointer !== null) return;
        e.preventDefault();
        holdPointer = e.pointerId;
        try {
          holdBtn.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 老 WebView 没有 capture，靠 pointerup 兜底 */
        }
        voice.press(e.clientX, e.clientY);
      });
      holdBtn.addEventListener('pointermove', (e) => {
        if (!voice || e.pointerId !== holdPointer) return;
        voice.move(e.clientX, e.clientY);
      });
      const endHold = (e, cancelled) => {
        if (!voice || e.pointerId !== holdPointer) return;
        holdPointer = null;
        if (cancelled) voice.cancel();
        else voice.release();
      };
      holdBtn.addEventListener('pointerup', (e) => endHold(e, false));
      // pointercancel / lostpointercapture 一律当「松手」处理，不当「取消」：
      // 手指稍微斜着走，浏览器可能把手势判给滚动条并发 pointercancel ——
      // 这时已经录了你说的那句话，丢掉是最难解释的行为。真要取消请走「上滑」，
      // 那条路会先置 cancelArmed，finalize() 里照样丢弃。
      holdBtn.addEventListener('pointercancel', (e) => endHold(e, false));
      holdBtn.addEventListener('lostpointercapture', (e) => endHold(e, false));
      holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
      // 键盘兜底：没有 pointer 事件的环境（无障碍开关/外接键盘）按一下就能录，
      // 再按一下收尾——状态机自己会处理 arming 阶段的误触。
      holdBtn.addEventListener('keydown', (e) => {
        if (!voice || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        if (holdPointer === null) {
          holdPointer = 'key';
          // 键盘兜底：原点取按钮中心，免得 (0,0) 让任何一次移动都被算成上滑
          const box = holdBtn.getBoundingClientRect();
          voice.press(box.left + box.width / 2, box.top + box.height / 2);
        } else {
          holdPointer = null;
          voice.release();
        }
      });
      // 麦克风：短按 = 切到语音态（QQ 同款，键盘落下、出现「按住说话」）；
      // 长按 = 同一条路，只是提前在 pointerdown 上就进态 —— 手指还按着的时候
      // 输入条已经换成按住说话了，抬起来正好接上 holdBtn 的 press。
      let micHoldTimer = null;
      const clearMicHold = () => {
        if (micHoldTimer) {
          clearTimeout(micHoldTimer);
          micHoldTimer = null;
        }
      };
      micBtn.addEventListener('pointerdown', () => {
        clearMicHold();
        micHoldTimer = setTimeout(() => {
          micHoldTimer = null;
          setMode('voice');
        }, 180);
      });
      micBtn.addEventListener('pointerup', clearMicHold);
      micBtn.addEventListener('pointercancel', clearMicHold);
      micBtn.addEventListener('pointerleave', clearMicHold);
      micBtn.addEventListener('click', () => {
        clearMicHold();
        setMode('voice');
      });
      keyboardBtn.addEventListener('click', () => setMode('text'));

      // 「+」：面板态再点一次 = 把键盘叫回来（同键盘按钮的手感），其它态进面板。
      plusBtn.addEventListener('click', () => {
        if (state.mode === 'panel') setMode('text');
        else setMode('panel');
      });

      // 面板开着时点输入框：先收面板再让键盘起来。
      // 监听 focus 而不是 click —— 外部（api.focus）也会把焦点给它，两种入口都要收面板。
      field.addEventListener('focus', () => {
        if (state.mode === 'panel') setMode('text');
      });

      function setRecording(on) {
        micBtn.classList.toggle('is-recording', !!on);
        micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        field.placeholder = on ? s('chat.voiceRecording') : s('chat.placeholder');
      }

      function setDictation(text) {
        field.value = text || '';
        field.dispatchEvent(new Event('input'));
        field.focus();
      }

      sendBtn.addEventListener('click', submit);
      stopBtn.addEventListener('click', () => props.onStop && props.onStop());

      render();
      syncBusy();
      setMode('text', false);
      // 自定义表情的清单在 IndexedDB 里，读出来之前 stickerById 认不出 u:xxx，
      // 首屏那几条表情会先画成占位。读完补一次 render：只在真有自定义表情时才多这一趟。
      ensureCustomStickers()
        .then(() => {
          if (customStickers().length) render();
        })
        .catch(() => {});
      // 控制器每次状态变化都会喊一声；主入口是 props.voice 的 onState，这里只是
      // 多一条订阅通道（老版本 main.js 还没接 onState 时不至于完全没有反馈）。
      if (voice && typeof voice.subscribe === 'function') {
        voice.subscribe((st) => {
          // 控制器把失败也顺着 state 广播一份（st.error）：权限被拒、录音器起不来
          // 的时候浮层要变红说话，否则界面一声不吭，看着像按钮坏了。
          if (st && st.error) setVoiceError(st.error);
          else if (st && st.phase === 'error') setVoiceError(st);
          else setVoiceState(st);
        });
      }

      // 页面切走 / Activity 暂停时把正在录的那段收掉：
      // 手指滑出元素还能补 lostpointercapture，人按 Home 键就没 pointerup 可等了。
      const onHidden = () => {
        if (document.visibilityState !== 'hidden' || !voice) return;
        const st = typeof voice.state === 'function' ? voice.state() : null;
        if (st && st.phase !== 'idle' && st.phase !== 'transcribing') voice.cancel();
      };
      document.addEventListener('visibilitychange', onHidden);

      const api = {
        setVoiceState,
        setVoiceError,
        setMode,
        setRecording,
        setDictation,
        // 语音条 / 语音消息的 blob URL 只在当前这棵 stream 上还有用；视图销毁就全撤掉。
        // 不撤的话 1/7 概率攒下来的 blob 会一直常驻（聊 700 句就是 100 个 URL）。
        destroy() {
          document.removeEventListener('visibilitychange', onHidden);
          // 切页时正在放的那条要停：否则人已经离开聊天页，声音还在后面念
          stopActiveBar();
          // 批 2 的挂件都是挂在 el 下的常驻节点，视图没了就一并摘掉：
          // 不摘的话（比如视图复用同一个 el）第二次进来会叠出第二个遮罩。
          cancelPress();
          closeSheet();
          closeViewer();
          clearQuote();
          if (typeof offVolume === 'function') offVolume();
          quoteBar.remove();
          sheet.remove();
          sheetMask.remove();
          viewer.remove();
          // 面板里挂着磁贴和「我的表情」节点，视图走了要连容器一起清干净
          closePanel();
          imageCache.clear();
          // 最后一次拖动可能还在节流窗口里：视图走了也要把音量落地，否则人就白拖了
          flushVolume();
          clipCache.forEach((url) => {
            try {
              URL.revokeObjectURL(url);
            } catch (err) {
              /* 已经释放过就忽略 */
            }
          });
          clipCache.clear();
          voiceCache.clear();
          revokeAll();
          // 自定义表情的 blob URL 是这一层自己建的（不复用 documents 的缓存），
          // 视图走了也要自己撤，否则切页几次就把几十 MB 留在内存里
          clearStickerSheetSubs();
          releaseCustomUrls();
        },
        // 供 app 层推送状态
        setMessages(list) {
          const prev = state.messages;
          const sameCount = prev.length === list.length;
          const samePrefix =
            sameCount &&
            list.length > 0 &&
            prev.slice(0, -1).every((m, i) => m.id === list[i].id && m.text === list[i].text);
          state.messages = list.slice();
          // 只有最后一条在变（流式）时走增量，避免整页重绘闪一下
          if (samePrefix) {
            patchLast({});
            stream.scrollTop = stream.scrollHeight;
            return;
          }
          render();
        },
        appendMessage(msg) {
          state.messages.push(msg);
          const node = renderMessage(msg, true);
          const empty = stream.querySelector('.el-chat-empty');
          if (empty) empty.remove();
          stream.append(node);
          stream.scrollTop = stream.scrollHeight;
          return node;
        },
        updateLast(patch) {
          patchLast(patch);
          stream.scrollTop = stream.scrollHeight;
        },
        setModel(name) {
          state.model = name;
          render();
        },
        setBusy(flag) {
          state.busy = !!flag;
          syncBusy();
        },
        focus() {
          field.focus();
        },
        // —— 批 2 新增（只加不改：上面那些名字一个都没动）——
        /** 外部设音量（0-100）。滑杆/面板跟着走，浏览器里只改显示不报错。 */
        setVolume(v) {
          applyVolume(v);
          return volume;
        },
        /** 外部打开引用条（比如从「看她引用的是哪句」跳回来）。 */
        openQuote(view) {
          beginQuote(view);
        },
        /** 关掉引用条。 */
        closeQuote() {
          clearQuote();
        },
        /** 滚到某条消息；找不到返回 false（别让调用方以为滚过去了）。 */
        scrollToMessage(id) {
          return scrollToId(id);
        },
        /** 打开某条消息的长按菜单（验收 / 无障碍入口用）。 */
        showMessageMenu(id) {
          const key = String(id || '');
          const msg = (state.messages || []).find(
            (m) => m && (String(m.headId || m.id || '') === key || String(m.id || '') === key),
          );
          if (!msg) return false;
          openMessageMenu(msg);
          return true;
        },
        /**
         * 直接打开「+」面板，可指定页签（'tools' / 'mine'）。
         * 下一轮做「我的表情」时从这里进：不必让用户先点 + 再点磁贴，
         * 也不用再改面板结构 —— 页签容器和返回键已经在了。
         */
        openComposerPanel(tab) {
          setMode('panel');
          if (tab === 'mine') openPanel('mine');
          return state.mode;
        },
      };
      // 验收临时探针：页面显式置 window.__ellenChatDebug 才暴露（验完删）
      if (window.__ellenChatDebug) {
        window.__chatApi = api;
        // 批 2 的交互不太好从外面点：把几个入口和内部状态挂出来，CDP 里能直接验收
        window.__chatUi = {
          openMessageMenu: (msg) => openMessageMenu(msg),
          openVolumePanel,
          openViewer,
          closeSheet,
          quoteOf: () => quoteRef,
          volumeOf: () => ({ volume, muted }),
          rowsOf: (msg) => menuRowsFor(msg).map((row) => row.label),
          shapeOf,
          openComposerPanel: (tab) => api.openComposerPanel(tab),
          panelOf: () => ({ mode: state.mode, tab: panelTab, open: !panel.hidden }),
        };
      }
      return api;
    },
  };
}
