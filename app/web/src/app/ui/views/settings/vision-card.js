// 设置 · 视觉模型一栏（挂在「聊天模型」页下面）。
//
// 为什么单独一张卡、而不是塞进三步向导：向导那三步是「不配就没法聊天」的强制路径，
// 视觉是**可选**的。塞进去只会让人以为又多了两步必答题。
//
// 三件事必须让人看懂：
// 1) 关着就是关着（默认关）——不开不会偷偷发图；
// 2) 模型名留空 = 跟着聊天模型走；聊天模型不吃图要当面说清，别让人以为开了就有用；
// 3) 名字认不出来时给一个「强制按视觉模型用」的开关，而不是硬判死。
//
// 文案先放本文件的 TXT 表：strings.zh.js 这一轮不归我改（lead 统一收）。
import { pages } from '../../../strings.zh.js';
import { pickImage, mediaSupported } from '../../../core/media.js';
import { readDocument } from '../../../core/documents.js';
import {
  normalizeVisionConfig,
  readVisionConfig,
  writeVisionConfig,
  visionPlan,
  resolveVisionTarget,
  describeImage,
} from '../../../core/vision.js';
import { DEFAULT_CONFIG } from '../../../core/config.js';

const TXT = pages.vision;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(cls, text) {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/**
 * 视觉配置卡。
 * @param {{state?:object, onChange?:Function}} opts
 * @returns {HTMLElement}
 */
export function createVisionCard({ state, onChange } = {}) {
  const card = el('div', 'el-settings-card');

  const head = el('div', 'el-settings-card-head');
  const title = el('div', 'el-settings-card-title', TXT.title);
  const status = el('div', 'el-settings-status', TXT.off);
  head.append(title, status);

  const hint = el('div', 'el-settings-card-hint', TXT.cardHint);

  const toggleRow = el('div', 'el-settings-row');
  const toggleBtn = button('el-settings-btn', TXT.toggleOn);
  toggleRow.append(toggleBtn);

  const modelField = el('label', 'el-settings-field');
  const modelLabel = el('span', 'el-settings-label', TXT.modelLabel);
  const modelInput = el('input', 'el-settings-input');
  modelInput.type = 'text';
  modelInput.autocomplete = 'off';
  modelInput.spellcheck = false;
  modelInput.placeholder = TXT.modelPlaceholder;
  const modelHint = el('div', 'el-settings-note', TXT.modelHint);
  modelField.append(modelLabel, modelInput, modelHint);

  // 地址/钥匙：视觉模型可能开在另一家（聊天用 A 家、看图用 B 家）。
  // 留空就回落聊天配置——这样最常见的一种情况（同一家、只是换个能吃图的模型）不用填两遍。
  const baseField = el('label', 'el-settings-field');
  const baseLabel = el('span', 'el-settings-label', TXT.baseLabel);
  const baseInput = el('input', 'el-settings-input');
  baseInput.type = 'text';
  baseInput.autocomplete = 'off';
  baseInput.spellcheck = false;
  baseInput.placeholder = TXT.basePlaceholder;
  baseField.append(baseLabel, baseInput);

  const keyField = el('label', 'el-settings-field');
  const keyLabel = el('span', 'el-settings-label', TXT.keyLabel);
  const keyInput = el('input', 'el-settings-input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = TXT.keyPlaceholder;
  keyField.append(keyLabel, keyInput);

  const forceRow = el('div', 'el-settings-row');
  const forceBtn = button('el-settings-btn is-ghost', TXT.force);
  forceRow.append(forceBtn);
  const forceHint = el('div', 'el-settings-note', TXT.forceHint);

  const tryRow = el('div', 'el-settings-row');
  const tryBtn = button('el-settings-btn is-ghost', TXT.tryLabel);
  tryRow.append(tryBtn);

  const result = el('div', 'el-settings-note', '');
  result.hidden = true;

  card.append(head, hint, toggleRow, modelField, baseField, keyField, forceRow, forceHint, tryRow, result);

  // 先用默认值（关着）铺一层：paint() 会在异步读到配置之前先跑一次，
  // 那时候 cfg 还不能是 null（这正是本轮冒烟测试抓到的一处崩）。
  let cfg = normalizeVisionConfig();
  let busy = false;

  const chatConfig = () => (state && state.getConfig ? state.getConfig() : { ...DEFAULT_CONFIG });

  function plan() {
    return visionPlan({ vision: cfg, chat: chatConfig() });
  }

  function paint() {
    const p = plan();
    status.textContent = p.enabled ? TXT.on : TXT.off;
    toggleBtn.textContent = p.enabled ? TXT.toggleOff : TXT.toggleOn;

    modelInput.value = cfg.model || '';
    baseInput.value = cfg.baseUrl || '';
    keyInput.value = cfg.apiKey || '';
    // 这两个开关没有专用样式（settings.css 里没有 btn.is-active/is-danger），
    // 所以状态全靠文案表达——比硬加一个没人维护的类名可靠。
    forceBtn.textContent = cfg.forceVision === true ? TXT.forced : TXT.force;
    // 认定「不吃图」时才提示；认得出能吃图就不吵人
    if (p.enabled && (p.reason === 'not-vision' || p.reason === 'no-model' || p.reason === 'no-chat')) {
      modelHint.className = 'el-settings-note is-error';
      modelHint.textContent = p.hint;
    } else {
      modelHint.className = 'el-settings-note';
      modelHint.textContent = TXT.modelHint;
    }
  }

  async function save(patch) {
    cfg = await writeVisionConfig(patch);
    paint();
    if (onChange) onChange();
  }

  function say(text, kind = '') {
    result.hidden = !text;
    result.className = `el-settings-note${kind ? ` is-${kind}` : ''}`;
    result.textContent = text || '';
  }

  toggleBtn.addEventListener('click', () => {
    if (busy) return;
    save({ enabled: cfg.enabled !== true });
  });

  modelInput.addEventListener('change', () => {
    save({ model: modelInput.value.trim() });
  });

  baseInput.addEventListener('change', () => {
    save({ baseUrl: baseInput.value.trim() });
  });

  // 钥匙只在失焦时读一次；不回显成明文（type=password）。
  keyInput.addEventListener('change', () => {
    save({ apiKey: keyInput.value.trim() });
  });

  forceBtn.addEventListener('click', () => {
    save({ forceVision: cfg.forceVision !== true });
  });

  // 「用相册试一张」= 降级交付的拍照通路：选一张 → 取字节 → 当多模态消息发一次。
  // 相机帧（1–2fps）要原生 EllenCamera 插件，这版还没有，所以先用相册把整条链路跑通。
  tryBtn.addEventListener('click', async () => {
    if (busy) return;
    const p = plan();
    if (!p.usable) {
      say(TXT.tryNoModel, 'error');
      return;
    }
    if (!mediaSupported()) {
      say(TXT.tryNoMedia, 'error');
      return;
    }
    busy = true;
    tryBtn.disabled = true;
    say(TXT.trying);
    try {
      const picked = await pickImage({ maxSide: 768, maxBytes: 512 * 1024 });
      if (!picked || !picked.picked) {
        say(TXT.tryCancel);
        return;
      }
      const doc = await readDocument(picked.path || picked.uri);
      if (!doc.base64) {
        say(`${TXT.tryFail}图读不出来。`, 'error');
        return;
      }
      const target = resolveVisionTarget({ vision: cfg, chat: chatConfig() });
      const said = await describeImage({
        config: target,
        imageBase64: doc.base64,
        text: '看看这张图，用你平时跟我说话的方式说一句。',
      });
      say(`${TXT.tryOk}${String(said || '').slice(0, 80)}`);
    } catch (err) {
      const msg = String((err && (err.message || err.code)) || err || '');
      say(`${TXT.tryFail}${msg.slice(0, 60)}`, 'error');
    } finally {
      busy = false;
      tryBtn.disabled = false;
    }
  });

  // 读配置是异步的：先按默认（关）画一版，读到再刷。
  paint();
  (async () => {
    cfg = await readVisionConfig();
    paint();
  })();

  return card;
}
