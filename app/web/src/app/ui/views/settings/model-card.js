// 聊天模型配置：给「什么都不懂的人」用的三步向导。
//
// 为什么另开一个文件：原来那一版把「平台三选一 / key / 模型名 / 服务地址」四行平铺在同一张卡上，
// 每一样都要用户自己知道该填什么。真实用户（老大）第一反应是「我不知道去哪领 key」。
// 所以这里把配置拆成三件可以顺序点完的事，并且每一屏只问一个问题。
//
// 三条硬规矩：
// 1) 服务地址不给用户看（除非他选「我自己有地址」）——那是我们该填的东西，不是他要懂的东西。
// 2) 存完立刻试连一次，把 401/402/404 翻成「钥匙不对 / 没钱了 / 地址不对」，别让人对着 JSON 猜。
// 3) 领钥匙的网址只做「复制」，不做跳转：WebView 里的 <a target=_blank> 会被拦，假装能跳更糟。
import { s } from '../../../strings.zh.js';
import { saveModelConfig, clearModelConfig, DEFAULT_CONFIG, PLATFORMS, platformOf } from '../../../core/config.js';
import { ask } from '../../../core/chat/oneshot.js';

/** 复制到剪贴板；WebView 里 clipboard API 可能被拒，退回到 textarea + execCommand。 */
export async function copyText(text) {
  const t = String(text || '');
  if (!t) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {
    /* 退回老办法 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 把试连失败翻成一句人话（不出现 error.code、不出现 JSON）。 */
export function explainTestError(err) {
  const code = String((err && err.code) || '');
  const raw = String((err && err.message) || err || '');
  if (code === 'HTTP_401' || code === 'HTTP_403' || /HTTP 40[13]/.test(raw)) return s('wiz.errKey');
  if (code === 'HTTP_402' || /HTTP 402/.test(raw)) return s('wiz.errNoMoney');
  if (code === 'HTTP_404' || /HTTP 404/.test(raw)) return s('wiz.errModel');
  if (code === 'HTTP_429' || /HTTP 429/.test(raw)) return s('wiz.errBusy');
  if (/^HTTP_5/.test(code) || /HTTP 5\d\d/.test(raw)) return s('wiz.errServer');
  if (/HTTP_400/.test(code) || /HTTP 400/.test(raw)) return s('wiz.errModel');
  if (/NETWORK|UnknownHost|Connect|TIMEOUT|timeout/i.test(code + raw)) return s('wiz.errNetwork');
  return `${s('wiz.errOther')}${raw ? `（${raw.slice(0, 80)}）` : ''}`;
}

/**
 * 三步向导：选一家 → 贴钥匙 → 挑模型，最后「存下并试一下」。
 * @param {{state?:object, onChange?:Function}} opts
 * @returns {HTMLElement}
 */
export function createModelCard({ state, onChange } = {}) {
  const cfg = (state && state.getConfig()) || { ...DEFAULT_CONFIG };

  let platformId = cfg.platform ? platformOf(cfg.platform).id : '';
  let step = platformId ? (cfg.apiKey && cfg.model ? 3 : 2) : 1;
  let keyValue = cfg.apiKey || '';
  let modelValue = cfg.model || '';
  let endpointValue = cfg.endpoint || '';
  let busy = false;

  const card = document.createElement('div');
  card.className = 'el-settings-card el-wiz';

  const head = document.createElement('div');
  head.className = 'el-settings-card-head';
  const title = document.createElement('div');
  title.className = 'el-settings-card-title';
  title.textContent = s('settings.modelSectionTitle');
  const status = document.createElement('div');
  status.className = 'el-settings-status';
  head.append(title, status);

  const hint = document.createElement('div');
  hint.className = 'el-settings-card-hint';
  hint.textContent = s('wiz.hint');

  const rail = document.createElement('div');
  rail.className = 'el-wiz-rail';
  const railButtons = [s('wiz.step1'), s('wiz.step2'), s('wiz.step3')].map((label, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'el-wiz-step';
    b.dataset.step = String(i + 1);
    const num = document.createElement('span');
    num.className = 'el-wiz-step-num';
    num.textContent = String(i + 1);
    const txt = document.createElement('span');
    txt.className = 'el-wiz-step-text';
    txt.textContent = label;
    b.append(num, txt);
    b.addEventListener('click', () => {
      if (i + 1 > step) return;
      step = i + 1;
      paint();
    });
    rail.append(b);
    return b;
  });

  // —— 第一步：选一家 ——
  const pane1 = document.createElement('div');
  pane1.className = 'el-wiz-pane';

  const providers = document.createElement('div');
  providers.className = 'el-wiz-providers';
  const providerButtons = PLATFORMS.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'el-wiz-provider';
    b.dataset.platform = p.id;
    const top = document.createElement('span');
    top.className = 'el-wiz-provider-top';
    const name = document.createElement('span');
    name.className = 'el-wiz-provider-name';
    name.textContent = p.title || p.label;
    top.append(name);
    if (p.id === 'deepseek') {
      const badge = document.createElement('span');
      badge.className = 'el-wiz-badge';
      badge.textContent = s('wiz.suggested');
      top.append(badge);
    }
    const tag = document.createElement('span');
    tag.className = 'el-wiz-provider-tag';
    tag.textContent = p.tagline || '';
    b.append(top, tag);
    b.addEventListener('click', () => {
      platformId = p.id;
      if (p.endpoint) endpointValue = p.endpoint;
      modelValue = p.models && p.models.length ? p.models[0].id : '';
      paint();
    });
    providers.append(b);
    return b;
  });

  // 领钥匙指路（选中哪家显示哪家）
  const signup = document.createElement('div');
  signup.className = 'el-wiz-signup';
  const signupTitle = document.createElement('div');
  signupTitle.className = 'el-wiz-signup-title';
  const urlRow = document.createElement('div');
  urlRow.className = 'el-wiz-url-row';
  const urlText = document.createElement('span');
  urlText.className = 'el-wiz-url';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'el-settings-btn is-ghost el-wiz-copy';
  copyBtn.textContent = s('wiz.copyUrl');
  urlRow.append(urlText, copyBtn);
  const steps = document.createElement('ol');
  steps.className = 'el-wiz-signup-steps';
  signup.append(signupTitle, urlRow, steps);
  const next1 = document.createElement('button');
  next1.type = 'button';
  next1.className = 'el-settings-btn is-primary-wide el-wiz-next';
  next1.textContent = s('wiz.nextKey');
  next1.addEventListener('click', () => {
    step = 2;
    paint();
    keyInput.focus();
  });
  pane1.append(providers, signup, next1);

  // —— 第二步：贴钥匙 ——
  const pane2 = document.createElement('div');
  pane2.className = 'el-wiz-pane';

  const keyField = document.createElement('label');
  keyField.className = 'el-settings-field';
  const keyLabel = document.createElement('span');
  keyLabel.className = 'el-settings-label';
  keyLabel.textContent = s('wiz.keyLabel');
  const keyWrap = document.createElement('div');
  keyWrap.className = 'el-wiz-key-wrap';
  const keyInput = document.createElement('input');
  keyInput.className = 'el-settings-input';
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = s('wiz.keyPlaceholder');
  keyInput.value = keyValue;
  const eyeBtn = document.createElement('button');
  eyeBtn.type = 'button';
  eyeBtn.className = 'el-wiz-eye';
  eyeBtn.textContent = s('wiz.show');
  eyeBtn.addEventListener('click', () => {
    const hidden = keyInput.type === 'password';
    keyInput.type = hidden ? 'text' : 'password';
    eyeBtn.textContent = hidden ? s('wiz.hide') : s('wiz.show');
  });
  keyWrap.append(keyInput, eyeBtn);
  const keyHint = document.createElement('div');
  keyHint.className = 'el-settings-note';
  keyField.append(keyLabel, keyWrap, keyHint);
  keyInput.addEventListener('input', () => {
    keyValue = keyInput.value.trim();
    paintKeyHint();
    // 粘完立刻能点下一步：disabled 只在 paint() 里刷会让人以为「没粘上」
    next2.disabled = keyValue.length < 8;
  });

  const back2 = document.createElement('button');
  back2.type = 'button';
  back2.className = 'el-settings-btn is-ghost el-wiz-back';
  back2.textContent = s('wiz.back');
  back2.addEventListener('click', () => {
    step = 1;
    paint();
  });
  const next2 = document.createElement('button');
  next2.type = 'button';
  next2.className = 'el-settings-btn is-primary-wide el-wiz-next';
  next2.textContent = s('wiz.nextModel');
  next2.addEventListener('click', () => {
    if (keyValue.length < 8) {
      keyHint.className = 'el-settings-note is-error';
      keyHint.textContent = s('wiz.keyTooShort');
      return;
    }
    step = 3;
    paint();
  });
  const row2 = document.createElement('div');
  row2.className = 'el-settings-row';
  row2.append(back2, next2);
  pane2.append(keyField, row2);

  // —— 第三步：挑模型 ——
  const pane3 = document.createElement('div');
  pane3.className = 'el-wiz-pane';

  const modelField = document.createElement('label');
  modelField.className = 'el-settings-field';
  const modelLabel = document.createElement('span');
  modelLabel.className = 'el-settings-label';
  modelLabel.textContent = s('wiz.modelLabel');
  const chips = document.createElement('div');
  chips.className = 'el-settings-chips';
  const modelInput = document.createElement('input');
  modelInput.className = 'el-settings-input';
  modelInput.type = 'text';
  modelInput.autocomplete = 'off';
  modelInput.spellcheck = false;
  modelInput.placeholder = s('wiz.modelPlaceholder');
  modelInput.value = modelValue;
  modelInput.addEventListener('input', () => {
    modelValue = modelInput.value.trim();
    paintChips();
  });
  const modelHint = document.createElement('div');
  modelHint.className = 'el-settings-note';
  modelHint.textContent = s('wiz.modelHint');
  modelField.append(modelLabel, chips, modelInput, modelHint);

  // 服务地址：只有「我自己有地址」才给人看
  const endpointField = document.createElement('label');
  endpointField.className = 'el-settings-field';
  const endpointLabel = document.createElement('span');
  endpointLabel.className = 'el-settings-label';
  endpointLabel.textContent = s('wiz.endpointLabel');
  const endpointInput = document.createElement('input');
  endpointInput.className = 'el-settings-input';
  endpointInput.type = 'url';
  endpointInput.autocomplete = 'off';
  endpointInput.spellcheck = false;
  endpointInput.inputMode = 'url';
  endpointInput.placeholder = 'https://…/chat/completions';
  endpointInput.value = endpointValue;
  endpointInput.addEventListener('input', () => {
    endpointValue = endpointInput.value.trim();
  });
  endpointField.append(endpointLabel, endpointInput);

  const result = document.createElement('div');
  result.className = 'el-wiz-result';
  result.hidden = true;

  const back3 = document.createElement('button');
  back3.type = 'button';
  back3.className = 'el-settings-btn is-ghost el-wiz-back';
  back3.textContent = s('wiz.back');
  back3.addEventListener('click', () => {
    step = 2;
    paint();
  });
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'el-settings-btn is-primary-wide el-wiz-save';
  saveBtn.textContent = s('wiz.saveTest');
  saveBtn.addEventListener('click', () => {
    submit();
  });
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'el-settings-btn is-ghost el-wiz-clear';
  clearBtn.textContent = s('settings.clearModel');
  clearBtn.addEventListener('click', () => {
    reset();
  });
  const row3 = document.createElement('div');
  row3.className = 'el-settings-row';
  row3.append(back3, saveBtn);
  const rowClear = document.createElement('div');
  rowClear.className = 'el-settings-row';
  rowClear.append(clearBtn);
  pane3.append(modelField, endpointField, result, row3, rowClear);

  card.append(head, hint, rail, pane1, pane2, pane3);

  // —— 渲染 ——
  function paintStatus() {
    const cur = (state && state.getConfig()) || null;
    status.textContent = cur && cur.apiKey && cur.model
      ? `${s('settings.configuredAs')}${cur.model}`
      : s('settings.notConfigured');
  }

  function paintKeyHint() {
    const p = platformOf(platformId || 'deepseek');
    keyHint.className = 'el-settings-note';
    keyHint.textContent = `${s('wiz.keyLooks')}${p.keyShape || 'sk-…'}`;
  }

  function paintChips() {
    const p = platformOf(platformId || 'deepseek');
    const list = (p.models || []).map((m) => (typeof m === 'string' ? { id: m, note: '' } : m));
    chips.replaceChildren();
    for (const m of list) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'el-settings-chip';
      if (m.id === modelValue) c.classList.add('is-active');
      c.textContent = m.id;
      if (m.note) c.title = m.note;
      c.addEventListener('click', () => {
        modelValue = m.id;
        modelInput.value = m.id;
        paintChips();
      });
      chips.append(c);
    }
    chips.hidden = list.length === 0;
  }

  function paint() {
    for (const b of railButtons) {
      const n = Number(b.dataset.step);
      b.classList.toggle('is-active', n === step);
      b.classList.toggle('is-done', n < step);
    }
    paintStatus();

    const p = platformOf(platformId || 'deepseek');
    for (const b of providerButtons) b.classList.toggle('is-active', b.dataset.platform === platformId);

    // 第一步的指路块：没选家之前不显示
    signup.hidden = !platformId;
    if (platformId) {
      signupTitle.textContent = s('wiz.signupTitle');
      urlText.textContent = p.signupUrl || s('wiz.noSignup');
      steps.replaceChildren();
      for (const line of p.signupSteps || []) {
        const li = document.createElement('li');
        li.textContent = line;
        steps.append(li);
      }
      steps.hidden = !(p.signupSteps || []).length;
      urlRow.hidden = !p.signupUrl;
      copyBtn.hidden = !p.signupUrl;
    }

    keyInput.value = keyValue;
    paintKeyHint();
    next2.disabled = keyValue.length < 8;

    modelInput.value = modelValue;
    paintChips();
    endpointField.hidden = platformId !== 'custom';
    endpointInput.value = endpointValue;
    if (platformId === 'ark') {
      modelHint.textContent = s('wiz.arkHint');
    } else if (platformId === 'custom') {
      modelHint.textContent = s('wiz.customHint');
    } else {
      modelHint.textContent = s('wiz.modelHint');
    }

    pane1.hidden = step !== 1;
    pane2.hidden = step !== 2;
    pane3.hidden = step !== 3;
  }

  // —— 存下并试一下 ——
  function showResult(kind, text) {
    result.hidden = false;
    result.className = `el-wiz-result is-${kind}`;
    result.textContent = text;
  }

  async function submit() {
    if (busy) return;
    const p = platformOf(platformId || 'deepseek');
    const endpoint = endpointValue || p.endpoint;
    if (!platformId) {
      step = 1;
      paint();
      return;
    }
    if (keyValue.length < 8) {
      step = 2;
      paint();
      showResult('bad', s('wiz.keyTooShort'));
      keyInput.focus();
      return;
    }
    if (!modelValue) {
      showResult('bad', s('wiz.needModel'));
      modelInput.focus();
      return;
    }
    if (!/^https:\/\//i.test(endpoint)) {
      showResult('bad', s('wiz.needHttps'));
      return;
    }

    busy = true;
    saveBtn.disabled = true;
    saveBtn.textContent = s('wiz.testing');
    showResult('run', s('wiz.testingHint'));

    const next = {
      ...cfg,
      platform: platformId,
      apiKey: keyValue,
      model: modelValue,
      endpoint,
    };

    try {
      const saved = await saveModelConfig(next);
      if (state) await state.setConfig(saved);
      paintStatus();
      if (onChange) onChange();

      const reply = await ask({
        config: saved,
        messages: [{ role: 'user', content: '在吗？用一句话回我。' }],
        maxTokens: 32,
      });
      const said = String(reply || '').trim();
      showResult('ok', said ? `${s('wiz.testOk')}「${said.slice(0, 40)}」` : s('wiz.testOkEmpty'));
    } catch (err) {
      showResult('bad', explainTestError(err));
    } finally {
      busy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = s('wiz.saveTest');
    }
  }

  async function reset() {
    if (busy) return;
    busy = true;
    try {
      await clearModelConfig();
      if (state) await state.setConfig({ ...DEFAULT_CONFIG });
      keyValue = '';
      modelValue = '';
      endpointValue = '';
      platformId = '';
      step = 1;
      result.hidden = true;
      paintStatus();
      paint();
      if (onChange) onChange();
    } finally {
      busy = false;
    }
  }

  copyBtn.addEventListener('click', async () => {
    const p = platformOf(platformId || 'deepseek');
    const ok = await copyText(p.signupUrl || '');
    copyBtn.textContent = ok ? s('wiz.copied') : s('wiz.copyFail');
    setTimeout(() => {
      copyBtn.textContent = s('wiz.copyUrl');
    }, 1800);
  });

  // 回车等于「下一步」
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      next2.click();
    }
  });
  modelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  paint();
  return card;
}
