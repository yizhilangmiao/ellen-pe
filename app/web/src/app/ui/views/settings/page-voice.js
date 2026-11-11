// 设置 · 声音（二级页）：她怎么念、key、复刻、开关，加语音输入的转写配置。
// 两块原来各占首页一大段，合到一页，首页只留一行摘要。
import { s } from '../../../strings.zh.js';
import './settings.css';
import {
  saveModelConfig,
  clearModelConfig,
  DEFAULT_CONFIG,
  PLATFORMS,
  platformOf,
  isUsable,
} from '../../../core/config.js';
import { call, requestId } from '../../../core/native/bridge.js';
import { PLATFORMS as ASR_PLATFORMS, loadConfig as loadAsrConfig, saveConfig as saveAsrConfig, clearConfig as clearAsrConfig, localState } from '../../../core/asr.js';
import { readPrefs as readVoicePrefs, writePrefs as writeVoicePrefs, speak as speakVoice, stop as stopVoice, state as voiceState, readKey as readVoiceKey, writeKey as writeVoiceKey, clearKey as clearVoiceKey } from '../../../core/speech.js';
import { cloneVoice, clonedVoiceId } from '../../../core/voice-clone.js';
import { parseManifest, extractSnapshot, rebuildHeads, importSnapshot } from '../../../core/store/import.js';
import { buildManifest } from '../../../core/store/export.js';
import { state as backupState, configure as configureBackup, chooseDirectory as chooseBackupDirectory, run as runBackup } from '../../../core/backup.js';
import { RHYTHMS, pushMaterial, setEnabled, readState, takePending } from '../../../core/proactive.js';
import { readPersona, writePersona, resetPersona, describePersona, TONES, LENGTHS } from '../../../core/persona.js';
import { RELATIONSHIPS, relationship, setRelationship } from '../../../core/companion.js';
import { readChatPrefs, writeChatPrefs, resetChatPrefs, HISTORY_OPTIONS } from '../../../core/chatprefs.js';
import { readJournalPrefs, writeJournalPrefs, maybeCompose as maybeWriteJournal } from '../../../core/journal.js';
import {
  state as updateState,
  check as checkUpdate,
  download as downloadUpdate,
  install as installUpdate,
  onUpdate as onUpdateState,
  progressText as updateProgressText,
  manifestUrl as updateManifestUrl,
  configure as configureUpdate,
  available as updatesAvailable,
  cancel as cancelUpdate,
} from '../../../core/updates.js';
import { push } from '../../router.js';

export function createVoicePage({ state, onChange } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('settings.pageVoice');
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('settings.pageVoiceHint');
      el.append(title, subtitle);

      const voiceCard = document.createElement('div');
      voiceCard.className = 'el-settings-card';

      const voiceHead = document.createElement('div');
      voiceHead.className = 'el-settings-card-head';
      const voiceTitle = document.createElement('div');
      voiceTitle.className = 'el-settings-card-title';
      voiceTitle.textContent = s('settings.voiceTitle');
      const voiceStatus = document.createElement('div');
      voiceStatus.className = 'el-settings-status';
      voiceHead.append(voiceTitle, voiceStatus);

      const voiceHint = document.createElement('div');
      voiceHint.className = 'el-settings-card-hint';
      voiceHint.textContent = s('settings.voiceHint');

      // —— 第一步：去领 key（给超链接；WebView 里点不动就把网址复制走）——
      const step1 = document.createElement('div');
      step1.className = 'el-wiz-step-block';
      const step1Label = document.createElement('div');
      step1Label.className = 'el-settings-label';
      step1Label.textContent = s('settings.voiceStep1');
      const VKEY_URL = 'https://platform.minimaxi.com/user-center/basic-information/interface-key';
      const link = document.createElement('a');
      link.className = 'el-wiz-link';
      link.href = VKEY_URL;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = s('settings.voiceSignupLink');
      const linkRow = document.createElement('div');
      linkRow.className = 'el-settings-row';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'el-settings-btn is-ghost';
      copyBtn.textContent = s('settings.voiceCopyUrl');
      linkRow.append(copyBtn);
      const step1Steps = document.createElement('ol');
      step1Steps.className = 'el-wiz-steps';
      for (const line of [s('settings.voiceStep1a'), s('settings.voiceStep1b'), s('settings.voiceStep1c')]) {
        const li = document.createElement('li');
        li.textContent = line;
        step1Steps.append(li);
      }
      step1.append(step1Label, link, linkRow, step1Steps);

      // —— 第二步：粘 key ——
      const step2 = document.createElement('div');
      step2.className = 'el-wiz-step-block';
      const step2Label = document.createElement('div');
      step2Label.className = 'el-settings-label';
      step2Label.textContent = s('settings.voiceStep2');
      const vkeyRowWrap = document.createElement('div');
      vkeyRowWrap.className = 'el-wiz-key-wrap';
      const vkeyInput = document.createElement('input');
      vkeyInput.className = 'el-settings-input';
      vkeyInput.type = 'password';
      vkeyInput.autocomplete = 'off';
      vkeyInput.spellcheck = false;
      vkeyInput.placeholder = s('settings.voiceKeyPlaceholder');
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'el-wiz-eye';
      eye.textContent = s('wiz.show');
      vkeyRowWrap.append(vkeyInput, eye);
      const vkeyRow = document.createElement('div');
      vkeyRow.className = 'el-settings-row';
      const vkeySave = document.createElement('button');
      vkeySave.type = 'button';
      vkeySave.className = 'el-settings-btn';
      vkeySave.textContent = s('settings.asrSave');
      const vkeyClear = document.createElement('button');
      vkeyClear.type = 'button';
      vkeyClear.className = 'el-settings-btn is-ghost';
      vkeyClear.textContent = s('settings.asrClear');
      vkeyRow.append(vkeySave, vkeyClear);
      step2.append(step2Label, vkeyRowWrap, vkeyRow);

      // —— 第三步：复刻她的声音（内置素材，不用你录）——
      const step3 = document.createElement('div');
      step3.className = 'el-wiz-step-block';
      const step3Label = document.createElement('div');
      step3Label.className = 'el-settings-label';
      step3Label.textContent = s('settings.voiceStep3');
      const cloneRow = document.createElement('div');
      cloneRow.className = 'el-settings-row';
      const cloneBtn = document.createElement('button');
      cloneBtn.type = 'button';
      cloneBtn.className = 'el-settings-btn';
      cloneBtn.textContent = s('settings.voiceCloneBtn');
      const sampleBtn = document.createElement('button');
      sampleBtn.type = 'button';
      sampleBtn.className = 'el-settings-btn is-ghost';
      sampleBtn.textContent = s('settings.voiceSample');
      cloneRow.append(cloneBtn, sampleBtn);
      const cloneNote = document.createElement('div');
      cloneNote.className = 'el-settings-note';
      cloneNote.textContent = s('settings.voiceCloneNote');
      step3.append(step3Label, cloneRow, cloneNote);

      // —— 两个开关：文字加语音朗读 / 随机语音条 ——
      function toggleRow(titleKey, descKey) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'el-settings-toggle-row';
        const copy = document.createElement('div');
        copy.className = 'el-settings-toggle-copy';
        const name = document.createElement('div');
        name.className = 'el-settings-toggle-title';
        name.textContent = s(titleKey);
        const desc = document.createElement('div');
        desc.className = 'el-settings-toggle-desc';
        desc.textContent = s(descKey);
        copy.append(name, desc);
        const sw = document.createElement('span');
        sw.className = 'el-settings-switch';
        row.append(copy, sw);
        return { row, sw };
      }

      const readT = toggleRow('settings.voiceReadTitle', 'settings.voiceReadDesc');
      const clipT = toggleRow('settings.voiceClipTitle', 'settings.voiceClipDesc');
      const toggleBlock = document.createElement('div');
      toggleBlock.className = 'el-settings-toggles';
      toggleBlock.append(readT.row, clipT.row);

      const voiceNote = document.createElement('div');
      voiceNote.className = 'el-settings-note';

      voiceCard.append(voiceHead, voiceHint, step1, step2, step3, toggleBlock, voiceNote);
      el.append(voiceCard);

      function paintVoice() {
        const prefs = readVoicePrefs();
        readT.row.classList.toggle('is-on', !!prefs.auto);
        readT.sw.classList.toggle('is-on', !!prefs.auto);
        clipT.row.classList.toggle('is-on', !!prefs.clip);
        clipT.sw.classList.toggle('is-on', !!prefs.clip);
        readVoiceKey()
          .then((key) => {
            if (!vkeyInput.value) vkeyInput.value = key || '';
          })
          .catch(() => {});
        const cloned = prefs.voiceId && prefs.voiceId !== 'female-shaonv';
        voiceStatus.textContent = s(cloned ? 'settings.voiceCloudCloned' : 'settings.voiceCloudBuiltin');
      }

      function note(text, bad) {
        voiceNote.className = bad ? 'el-settings-note is-error' : 'el-settings-note';
        voiceNote.textContent = text || '';
      }

      async function copyKeyUrl() {
        try {
          await navigator.clipboard.writeText(VKEY_URL);
          note(s('settings.voiceUrlCopied'));
        } catch (_) {
          note(s('settings.voiceUrlCopyFail'), true);
        }
      }

      eye.addEventListener('click', () => {
        const shown = vkeyInput.type === 'text';
        vkeyInput.type = shown ? 'password' : 'text';
        eye.textContent = shown ? s('wiz.show') : s('wiz.hide');
      });
      // WebView 默认不开外部跳转，点了大概率停在原地 —— 顺手把网址复制好
      link.addEventListener('click', () => {
        copyKeyUrl();
      });
      copyBtn.addEventListener('click', copyKeyUrl);

      vkeySave.addEventListener('click', async () => {
        const key = vkeyInput.value.trim();
        if (!key) {
          note(s('settings.voiceCloudNeedKey'), true);
          return;
        }
        try {
          await writeVoiceKey(key);
          writeVoicePrefs({ provider: 'minimax' });
          paintVoice();
          note(s('settings.asrSaved'));
        } catch (err) {
          note((err && err.message) || s('settings.voiceCloudNeedKey'), true);
        }
      });

      vkeyClear.addEventListener('click', async () => {
        await clearVoiceKey().catch(() => {});
        vkeyInput.value = '';
        note('');
      });

      cloneBtn.addEventListener('click', async () => {
        if (cloneBtn.dataset.busy === '1') return;
        const key = vkeyInput.value.trim() || (await readVoiceKey().catch(() => ''));
        if (!key) {
          note(s('settings.voiceCloneNeedKey'), true);
          return;
        }
        if (!vkeyInput.value.trim()) await writeVoiceKey(key).catch(() => {});
        cloneBtn.dataset.busy = '1';
        cloneBtn.disabled = true;
        const label = s('settings.voiceCloneBtn');
        cloneBtn.textContent = s('settings.voiceCloneBusy');
        note(s('settings.voiceCloneWorking'));
        try {
          const res = await cloneVoice({
            apiKey: key,
            onProgress: (_stage, text) => {
              cloneNote.textContent = text;
            },
          });
          const voiceId = (res && res.voiceId) || clonedVoiceId();
          if (voiceId) writeVoicePrefs({ provider: 'minimax', voiceId });
          cloneNote.textContent = s('settings.voiceCloneNote');
          note(res && res.reused ? s('settings.voiceCloneReused') : s('settings.voiceCloneDone'));
          paintVoice();
        } catch (err) {
          note(s('settings.voiceCloneFail') + String((err && err.message) || err), true);
        } finally {
          cloneBtn.dataset.busy = '';
          cloneBtn.disabled = false;
          cloneBtn.textContent = label;
        }
      });

      readT.row.addEventListener('click', () => {
        writeVoicePrefs({ auto: !readVoicePrefs().auto });
        paintVoice();
        note(readVoicePrefs().auto ? s('settings.voiceAutoOnHint') : s('settings.voiceAutoOffHint'));
      });

      clipT.row.addEventListener('click', () => {
        writeVoicePrefs({ clip: !readVoicePrefs().clip });
        paintVoice();
        note(readVoicePrefs().clip ? s('settings.voiceClipOnHint') : s('settings.voiceClipOffHint'));
      });

      sampleBtn.addEventListener('click', async () => {
        const res = await speakVoice(s('settings.voiceSampleText')).catch((err) => ({ error: String(err) }));
        if (res && res.error) note(s('settings.voiceFailed') + res.error, true);
        else note(s('settings.voicePlaying'));
      });

      paintVoice();
      voiceState()
        .then(() => paintVoice())
        .catch(() => paintVoice());

      // —— 语音输入（转写）——
      const asrCard = document.createElement('div');
      asrCard.className = 'el-settings-card';

      const asrHead = document.createElement('div');
      asrHead.className = 'el-settings-card-head';
      const asrTitle = document.createElement('div');
      asrTitle.className = 'el-settings-card-title';
      asrTitle.textContent = s('settings.asrTitle');
      const asrState = document.createElement('div');
      asrState.className = 'el-settings-status';
      asrHead.append(asrTitle, asrState);

      const asrHint = document.createElement('div');
      asrHint.className = 'el-settings-card-hint';
      asrHint.textContent = s('settings.asrHint');

      const asrPlatformSegs = document.createElement('div');
      asrPlatformSegs.className = 'el-settings-segments';
      const asrPlatformButtons = ASR_PLATFORMS.map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-settings-segment';
        b.dataset.platform = p.id;
        b.textContent = p.label;
        asrPlatformSegs.append(b);
        return b;
      });

      const asrKeyLabel = document.createElement('div');
      asrKeyLabel.className = 'el-settings-label';
      asrKeyLabel.textContent = s('settings.asrKeyLabel');
      const asrKeyInput = document.createElement('input');
      asrKeyInput.className = 'el-settings-input';
      asrKeyInput.type = 'password';
      asrKeyInput.autocomplete = 'off';
      asrKeyInput.spellcheck = false;
      asrKeyInput.placeholder = 'sk-…';

      const asrModelLabel = document.createElement('div');
      asrModelLabel.className = 'el-settings-label';
      asrModelLabel.textContent = s('settings.asrModelLabel');
      const asrModelInput = document.createElement('input');
      asrModelInput.className = 'el-settings-input';
      asrModelInput.type = 'text';
      asrModelInput.autocomplete = 'off';
      asrModelInput.spellcheck = false;
      asrModelInput.placeholder = 'FunAudioLLM/SenseVoiceSmall';

      // 选「离线识别」时这两块要收起来 —— 模型在 APK 里，没 key 也没 endpoint 可填
      const asrCloudFields = document.createElement('div');
      asrCloudFields.className = 'el-settings-cloud-field';
      asrCloudFields.append(asrKeyLabel, asrKeyInput, asrModelLabel, asrModelInput);

      const asrRow = document.createElement('div');
      asrRow.className = 'el-settings-row';
      const asrSaveBtn = document.createElement('button');
      asrSaveBtn.type = 'button';
      asrSaveBtn.className = 'el-settings-btn';
      asrSaveBtn.textContent = s('settings.asrSave');
      const asrClearBtn = document.createElement('button');
      asrClearBtn.type = 'button';
      asrClearBtn.className = 'el-settings-btn is-ghost';
      asrClearBtn.textContent = s('settings.asrClear');
      // 按住说话时，转写完直接发出去更顺手；不想要的人就让它先落进输入框
      const asrAutoBtn = document.createElement('button');
      asrAutoBtn.type = 'button';
      asrAutoBtn.className = 'el-settings-btn is-ghost';
      asrRow.append(asrSaveBtn, asrClearBtn, asrAutoBtn);

      const asrNote = document.createElement('div');
      asrNote.className = 'el-settings-note';

      asrCard.append(asrHead, asrHint, asrPlatformSegs, asrCloudFields, asrRow, asrNote);
      el.append(asrCard);

      let asrConfig = null;

      function paintAsr() {
        const cfg = asrConfig || { platform: 'local', apiKey: '', model: '' };
        const isLocal = cfg.platform === 'local';
        for (const b of asrPlatformButtons) {
          b.classList.toggle('is-active', b.dataset.platform === cfg.platform);
        }
        asrCloudFields.classList.toggle('is-hidden', isLocal);
        asrKeyInput.value = cfg.apiKey || '';
        asrModelInput.value = cfg.model || '';
        asrAutoBtn.textContent = cfg.autoSend ? s('settings.asrAutoOn') : s('settings.asrAutoOff');
        const hit = ASR_PLATFORMS.find((q) => q.id === cfg.platform);
        asrHint.textContent = hit ? hit.keyHint : s('settings.asrHint');
        if (isLocal) {
          asrState.textContent = '…';
          localState()
            .then((st) => {
              asrState.textContent = st && st.available
                ? s('settings.asrLocalReady')
                : (st && st.loading ? '…' : s('settings.asrLocalMissing'));
              asrNote.className = 'el-settings-note';
              asrNote.textContent = st && st.model ? `模型：${st.model}` : '';
            })
            .catch(() => {
              asrState.textContent = s('settings.asrLocalMissing');
            });
        } else {
          asrState.textContent = cfg.apiKey && cfg.model ? s('settings.voiceReady') : '';
        }
      }

      loadAsrConfig()
        .then((cfg) => {
          asrConfig = cfg;
          paintAsr();
        })
        .catch(() => paintAsr());

      for (const b of asrPlatformButtons) {
        b.addEventListener('click', () => {
          const hit = ASR_PLATFORMS.find((p) => p.id === b.dataset.platform) || ASR_PLATFORMS[0];
          asrConfig = { ...(asrConfig || {}), platform: hit.id, endpoint: hit.endpoint, model: hit.model || (asrConfig && asrConfig.model) || '' };
          paintAsr();
        });
      }

      asrSaveBtn.addEventListener('click', async () => {
        const key = asrKeyInput.value.trim();
        const model = asrModelInput.value.trim();
        if (asrConfig && asrConfig.platform === 'local') {
          try {
            asrConfig = await saveAsrConfig({
              platform: 'local',
              endpoint: '',
              model: (asrConfig && asrConfig.model) || 'streaming-zipformer-zh-14m-int8',
              apiKey: '',
              language: 'zh',
              autoSend: !!(asrConfig && asrConfig.autoSend),
            });
            paintAsr();
            asrNote.className = 'el-settings-note';
            asrNote.textContent = s('settings.asrSaved');
          } catch (err) {
            asrNote.className = 'el-settings-note is-error';
            asrNote.textContent = (err && err.message) || '存不下';
          }
          return;
        }
        if (!key || !model) {
          asrNote.className = 'el-settings-note is-error';
          asrNote.textContent = s('settings.asrNeedKey');
          return;
        }
        const hit = ASR_PLATFORMS.find((p) => p.id === (asrConfig && asrConfig.platform)) || ASR_PLATFORMS[0];
        try {
          asrConfig = await saveAsrConfig({
          platform: hit.id,
          endpoint: hit.endpoint,
          model,
          apiKey: key,
          language: 'zh',
          autoSend: !!(asrConfig && asrConfig.autoSend),
        });
          paintAsr();
          asrNote.className = 'el-settings-note';
          asrNote.textContent = s('settings.asrSaved');
        } catch (err) {
          asrNote.className = 'el-settings-note is-error';
          asrNote.textContent = (err && err.message) || '存不下';
        }
      });

      asrAutoBtn.addEventListener('click', async () => {
        const next = !(asrConfig && asrConfig.autoSend);
        try {
          asrConfig = await saveAsrConfig({ ...(asrConfig || {}), autoSend: next });
          paintAsr();
          asrNote.className = 'el-settings-note';
          asrNote.textContent = next ? s('settings.asrAutoOnHint') : s('settings.asrAutoOffHint');
        } catch (err) {
          asrNote.className = 'el-settings-note is-error';
          asrNote.textContent = (err && err.message) || '存不下';
        }
      });

      asrClearBtn.addEventListener('click', async () => {
        await clearAsrConfig().catch(() => {});
        asrConfig = null;
        paintAsr();
        asrNote.className = 'el-settings-note';
        asrNote.textContent = '';
      });

      // 横屏两栏：多列流只能挂在块容器上，标题留在外面通栏。
      const flow = document.createElement('div');
      flow.className = 'el-settings-flow';
      for (const node of [...el.children]) {
        if (node === title) continue;
        flow.append(node);
      }
      el.append(flow);

      return {};
    },
  };
}
