// 设置页。第一版只做"能配好并开始聊天"这一条链路：
// 选平台 → 填 API Key + 模型名（地址跟着平台自动填，也能自己改）→ 存进系统密钥库 → 聊天页立刻可用。
// 其余条目（语音 / 角色卡 / 主动消息）先列出来但标为后续里程碑，不做假开关。
//
// 为什么要有"平台"这一步：旧包把火山方舟的地址写死在原生里，填别家的 key 必然 401。
// 新壳原生已放开成任意 https 的 OpenAI 兼容端点，所以这里给出预设，也留自定义。
import { s } from '../../../strings.zh.js';
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
import { createModelCard } from './model-card.js';
import './model-card.css';
import './settings.css';

export function createSettingsView({ state, onChange } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('settings.title');

      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('settings.subtitle');

      el.append(title, subtitle);

      const cfg = (state && state.getConfig()) || { ...DEFAULT_CONFIG };

      // —— 聊天与声音 ——
      const groupTitle = document.createElement('div');
      groupTitle.className = 'el-settings-group-title';
      groupTitle.textContent = s('settings.groupChatAndVoice');
      el.append(groupTitle);

      el.append(createModelCard({ state, onChange }));

      // —— 声音（她说话）——
      // 第一版只有系统 TTS：能出声、零配置。云端音色（旧包的 minimax speech-2.8）以后接。
      const groupVoice = document.createElement('div');
      groupVoice.className = 'el-settings-group-title';
      groupVoice.textContent = s('settings.groupVoice');
      el.append(groupVoice);

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

      const speedLabel = document.createElement('div');
      speedLabel.className = 'el-settings-label';
      speedLabel.textContent = s('settings.voiceSpeed');
      const speedSegs = document.createElement('div');
      speedSegs.className = 'el-settings-segments';
      const speedDefs = [
        ['0.85', s('settings.voiceSlow')],
        ['1', s('settings.voiceNormal')],
        ['1.2', s('settings.voiceFast')],
      ];
      const speedButtons = speedDefs.map(([rate, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-settings-segment';
        b.dataset.rate = rate;
        b.textContent = label;
        speedSegs.append(b);
        return b;
      });

      const voiceRow = document.createElement('div');
      voiceRow.className = 'el-settings-row';
      const autoBtn = document.createElement('button');
      autoBtn.type = 'button';
      autoBtn.className = 'el-settings-btn';
      const sampleBtn = document.createElement('button');
      sampleBtn.type = 'button';
      sampleBtn.className = 'el-settings-btn is-ghost';
      sampleBtn.textContent = s('settings.voiceSample');
      voiceRow.append(autoBtn, sampleBtn);

      const voiceNote = document.createElement('div');
      voiceNote.className = 'el-settings-note';

      // 朗读方式：系统 TTS（离线） vs minimax 云端音色（要 key）
      const providerLabel = document.createElement('div');
      providerLabel.className = 'el-settings-label';
      providerLabel.textContent = s('settings.voiceProvider');
      const voiceProviderSegs = document.createElement('div');
      voiceProviderSegs.className = 'el-settings-segments';
      const providerDefs = [
        ['system', s('settings.voiceProviderSystem')],
        ['minimax', s('settings.voiceProviderCloud')],
      ];
      const providerButtons = providerDefs.map(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-settings-segment';
        b.dataset.provider = id;
        b.textContent = label;
        voiceProviderSegs.append(b);
        return b;
      });

      const cloudField = document.createElement('div');
      cloudField.className = 'el-settings-cloud-field';

      const vkeyLabel = document.createElement('div');
      vkeyLabel.className = 'el-settings-label';
      vkeyLabel.textContent = s('settings.voiceCloudKey');
      const vkeyInput = document.createElement('input');
      vkeyInput.className = 'el-settings-input';
      vkeyInput.type = 'password';
      vkeyInput.autocomplete = 'off';
      vkeyInput.spellcheck = false;
      vkeyInput.placeholder = 'eyJ…（minimax 控制台的 API Key）';

      const voiceIdLabel = document.createElement('div');
      voiceIdLabel.className = 'el-settings-label';
      voiceIdLabel.textContent = s('settings.voiceCloudVoiceId');
      const voiceIdInput = document.createElement('input');
      voiceIdInput.className = 'el-settings-input';
      voiceIdInput.type = 'text';
      voiceIdInput.autocomplete = 'off';
      voiceIdInput.spellcheck = false;
      voiceIdInput.placeholder = 'female-shaonv';

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

      // 一键复刻：内置素材 + 用户自己的 key → minimax voice_clone → 自动填音色 id。
      // 复刻过一次就把 voice_id 存住，同一个 key 再点只复用，不重复扣费。
      const cloneRow = document.createElement('div');
      cloneRow.className = 'el-settings-row';
      const cloneBtn = document.createElement('button');
      cloneBtn.type = 'button';
      cloneBtn.className = 'el-settings-btn';
      cloneBtn.textContent = s('settings.voiceCloneBtn');
      cloneRow.append(cloneBtn);

      const cloneNote = document.createElement('div');
      cloneNote.className = 'el-settings-note';
      cloneNote.textContent = s('settings.voiceCloneNote');

      cloudField.append(vkeyLabel, vkeyInput, voiceIdLabel, voiceIdInput, vkeyRow, cloneRow, cloneNote);

      voiceCard.append(voiceHead, voiceHint, providerLabel, voiceProviderSegs, cloudField, speedLabel, speedSegs, voiceRow, voiceNote);
      el.append(voiceCard);

      let voicePrefs = readVoicePrefs();

      function paintVoice() {
        voicePrefs = readVoicePrefs();
        const isCloud = voicePrefs.provider === 'minimax';
        for (const b of providerButtons) {
          b.classList.toggle('is-active', b.dataset.provider === voicePrefs.provider);
        }
        cloudField.classList.toggle('is-hidden', !isCloud);
        voiceIdInput.value = voicePrefs.voiceId || 'female-shaonv';
        readVoiceKey()
          .then((key) => {
            if (!vkeyInput.value) vkeyInput.value = key || '';
          })
          .catch(() => {});
        voiceHint.textContent = isCloud ? s('settings.voiceCloudHint') : s('settings.voiceSystemHint');
        paintVoiceStatus(null);
        autoBtn.textContent = voicePrefs.auto ? s('settings.voiceAutoOn') : s('settings.voiceAutoOff');
        autoBtn.classList.toggle('is-on', voicePrefs.auto);
        for (const b of speedButtons) {
          const same = Math.abs(Number(b.dataset.rate) - Number(voicePrefs.rate)) < 0.01;
          b.classList.toggle('is-active', same);
        }
      }

      // 状态行按「正在用哪种朗读」说话：云端音色时不必再报系统引擎缺失（那台模拟器就没有 TTS，
      // 但云端照样能念，写「没有中文朗读引擎」会让人以为念不了）。
      let lastSystemVoiceState = null;
      function paintVoiceStatus(st) {
        if (st) lastSystemVoiceState = st;
        const prefs = readVoicePrefs();
        if (prefs.provider === 'minimax') {
          const cloned = voicePrefs.voiceId && voicePrefs.voiceId !== 'female-shaonv';
          voiceStatus.textContent = s(cloned ? 'settings.voiceCloudCloned' : 'settings.voiceCloudBuiltin');
          return;
        }
        const sys = lastSystemVoiceState;
        if (!sys) {
          voiceStatus.textContent = '';
          return;
        }
        voiceStatus.textContent = sys.available ? s('settings.voiceReady') : s('settings.voiceUnavailable');
      }

      for (const b of providerButtons) {
        b.addEventListener('click', () => {
          writeVoicePrefs({ provider: b.dataset.provider, voiceId: voiceIdInput.value.trim() || 'female-shaonv' });
          paintVoice();
          voiceNote.className = 'el-settings-note';
          voiceNote.textContent = b.dataset.provider === 'minimax' ? s('settings.voiceCloudHint') : s('settings.voiceSystemHint');
        });
      }

      vkeySave.addEventListener('click', async () => {
        const key = vkeyInput.value.trim();
        if (!key) {
          voiceNote.className = 'el-settings-note is-error';
          voiceNote.textContent = s('settings.voiceCloudNeedKey');
          return;
        }
        try {
          await writeVoiceKey(key);
          writeVoicePrefs({ provider: 'minimax', voiceId: voiceIdInput.value.trim() || 'female-shaonv' });
          paintVoice();
          voiceNote.className = 'el-settings-note';
          voiceNote.textContent = s('settings.asrSaved');
        } catch (err) {
          voiceNote.className = 'el-settings-note is-error';
          voiceNote.textContent = (err && err.message) || '存不下';
        }
      });

      vkeyClear.addEventListener('click', async () => {
        await clearVoiceKey().catch(() => {});
        vkeyInput.value = '';
        voiceNote.className = 'el-settings-note';
        voiceNote.textContent = '';
      });

      cloneBtn.addEventListener('click', async () => {
        if (cloneBtn.dataset.busy === '1') return;
        const key = vkeyInput.value.trim() || (await readVoiceKey().catch(() => ''));
        if (!key) {
          cloneNote.className = 'el-settings-note is-error';
          cloneNote.textContent = s('settings.voiceCloneNeedKey');
          return;
        }
        if (!vkeyInput.value.trim()) await writeVoiceKey(key).catch(() => {});
        cloneBtn.dataset.busy = '1';
        cloneBtn.disabled = true;
        const label = s('settings.voiceCloneBtn');
        cloneBtn.textContent = s('settings.voiceCloneBusy');
        cloneNote.className = 'el-settings-note';
        cloneNote.textContent = s('settings.voiceCloneWorking');
        try {
          const res = await cloneVoice({
            apiKey: key,
            onProgress: (_stage, text) => {
              cloneNote.textContent = text;
            },
          });
          const voiceId = (res && res.voiceId) || clonedVoiceId();
          if (voiceId) {
            voiceIdInput.value = voiceId;
            writeVoicePrefs({ provider: 'minimax', voiceId });
          }
          cloneNote.className = 'el-settings-note';
          cloneNote.textContent = res && res.reused ? s('settings.voiceCloneReused') : s('settings.voiceCloneDone');
          paintVoice();
        } catch (err) {
          cloneNote.className = 'el-settings-note is-error';
          cloneNote.textContent = s('settings.voiceCloneFail') + String((err && err.message) || err);
        } finally {
          cloneBtn.dataset.busy = '';
          cloneBtn.disabled = false;
          cloneBtn.textContent = label;
        }
      });

      autoBtn.addEventListener('click', () => {
        writeVoicePrefs({ auto: !readVoicePrefs().auto });
        paintVoice();
        voiceNote.className = 'el-settings-note';
        voiceNote.textContent = readVoicePrefs().auto ? s('settings.voiceAutoOnHint') : s('settings.voiceAutoOffHint');
      });

      for (const b of speedButtons) {
        b.addEventListener('click', async () => {
          writeVoicePrefs({ rate: Number(b.dataset.rate) });
          paintVoice();
          await stopVoice().catch(() => {});
          await speakVoice(s('settings.voiceSampleText')).catch(() => {});
        });
      }

      sampleBtn.addEventListener('click', async () => {
        const res = await speakVoice(s('settings.voiceSampleText')).catch((err) => ({ error: String(err) }));
        if (res && res.error) {
          voiceNote.className = 'el-settings-note is-error';
          voiceNote.textContent = `${s('settings.voiceFailed')}${res.error}`;
        } else {
          voiceNote.className = 'el-settings-note';
          voiceNote.textContent = s('settings.voicePlaying');
        }
      });

      paintVoice();
      voiceState()
        .then(paintVoiceStatus)
        .catch(() => paintVoiceStatus(null));
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
      // —— 数据与迁移 ——
      const groupData = document.createElement('div');
      groupData.className = 'el-settings-group-title';
      groupData.textContent = s('settings.groupData');
      el.append(groupData);

      const dataCard = document.createElement('div');
      dataCard.className = 'el-settings-card';
      const dataHead = document.createElement('div');
      dataHead.className = 'el-settings-card-head';
      const dataTitle = document.createElement('div');
      dataTitle.className = 'el-settings-card-title';
      dataTitle.textContent = s('settings.importTitle');
      dataHead.append(dataTitle);
      const dataHint = document.createElement('div');
      dataHint.className = 'el-settings-card-hint';
      dataHint.textContent = s('settings.importHint');
      const dataRow = document.createElement('div');
      dataRow.className = 'el-settings-row';
      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.className = 'el-settings-btn';
      importBtn.textContent = s('settings.importButton');
      const exportBtn = document.createElement('button');
      exportBtn.type = 'button';
      exportBtn.className = 'el-settings-btn is-ghost';
      exportBtn.textContent = s('settings.exportButton');
      dataRow.append(importBtn, exportBtn);
      const dataNote = document.createElement('div');
      dataNote.className = 'el-settings-note';
      dataCard.append(dataHead, dataHint, dataRow, dataNote);
      el.append(dataCard);

      function say(text, isError) {
        dataNote.className = isError ? 'el-settings-note is-error' : 'el-settings-note';
        dataNote.textContent = text;
      }

      importBtn.addEventListener('click', async () => {
        importBtn.disabled = true;
        say(s('settings.importBusy'));
        try {
          // EllenArchive.pickImport 会把清单（manifest）一起解出来，媒体字节不用读
          const picked = await call('EllenArchive', 'pickImport', { requestId: requestId('import') });
          if (!picked || picked.cancelled) {
            say(s('settings.importCancelled'));
            return;
          }
          const parsed = parseManifest(picked.manifestText);
          const { snapshot, content } = extractSnapshot(parsed);
          const preview = rebuildHeads(snapshot.records);
          if (!preview.heads.length) {
            say(s('settings.importEmpty'));
            return;
          }
          const where = content && content.origin ? content.origin.platform : '';
          const ok = window.confirm(
            `资料包来自${where || '旧版'}，含 ${preview.heads.length} 条记录、${preview.revisions.length} 次改动。\n`
            + '导入会覆盖这台手机现在的数据，确定继续？',
          );
          if (!ok) {
            say(s('settings.importCancelled'));
            return;
          }
          const r = await importSnapshot(snapshot, { merge: false });
          if (state && state.reload) await state.reload();
          if (onChange) onChange();
          say(`${s('settings.importDone')} ${r.heads} 条记录（${Object.entries(r.kinds).map(([k, v]) => `${k} ${v}`).join('、')}）。`);
        } catch (err) {
          const msg = (err && (err.message || err.code)) || String(err);
          say(`导入失败：${msg}`, true);
        } finally {
          importBtn.disabled = false;
        }
      });

      exportBtn.addEventListener('click', async () => {
        exportBtn.disabled = true;
        say(s('settings.exportBusy'));
        try {
          const built = await buildManifest();
          const created = await call('EllenArchive', 'createExport', { manifestText: built.manifestText });
          const saved = await call('EllenArchive', 'saveExport', { handle: created.handle });
          if (!saved || saved.cancelled) {
            say(s('settings.importCancelled'));
            return;
          }
          const mb = (saved.sizeBytes / 1048576).toFixed(2);
          say(`${s('settings.exportDone')} ${built.stats.records} 次改动 · ${mb} MB`);
        } catch (err) {
          const msg = (err && (err.message || err.code)) || String(err);
          say(`导出失败：${msg}`, true);
        } finally {
          exportBtn.disabled = false;
        }
      });

      // —— 自动备份 ——
      const groupBackup = document.createElement('div');
      groupBackup.className = 'el-settings-group-title';
      groupBackup.textContent = s('settings.groupBackup');
      el.append(groupBackup);

      const bkCard = document.createElement('div');
      bkCard.className = 'el-settings-card';
      const bkHead = document.createElement('div');
      bkHead.className = 'el-settings-card-head';
      const bkTitle = document.createElement('div');
      bkTitle.className = 'el-settings-card-title';
      bkTitle.textContent = s('settings.backupTitle');
      const bkStatus = document.createElement('div');
      bkStatus.className = 'el-settings-note';
      bkHead.append(bkTitle, bkStatus);
      const bkHint = document.createElement('div');
      bkHint.className = 'el-settings-card-hint';
      bkHint.textContent = s('settings.backupHint');

      const bkFolderLabel = document.createElement('span');
      bkFolderLabel.className = 'el-settings-label';
      bkFolderLabel.textContent = s('settings.backupFolder');
      const bkFolderRow = document.createElement('div');
      bkFolderRow.className = 'el-settings-row';
      const bkChoose = document.createElement('button');
      bkChoose.type = 'button';
      bkChoose.className = 'el-settings-btn';
      bkChoose.textContent = s('settings.backupChoose');
      const bkFolderName = document.createElement('span');
      bkFolderName.className = 'el-settings-note';
      bkFolderName.textContent = s('settings.backupNoFolder');
      bkFolderRow.append(bkChoose, bkFolderName);

      let bkState = null;
      const bkIntervalField = segmentField(s('settings.backupInterval'), [
        { value: 3, label: s('settings.backupDays3') },
        { value: 7, label: s('settings.backupDays7') },
        { value: 14, label: s('settings.backupDays14') },
      ], 7, (value) => applyBackup({ intervalDays: value }));
      const bkRetainField = segmentField(s('settings.backupRetain'), [
        { value: 2, label: s('settings.backupKeep2') },
        { value: 3, label: s('settings.backupKeep3') },
        { value: 5, label: s('settings.backupKeep5') },
      ], 3, (value) => applyBackup({ retainGroups: value }));

      const bkRow = document.createElement('div');
      bkRow.className = 'el-settings-row';
      const bkToggle = document.createElement('button');
      bkToggle.type = 'button';
      bkToggle.className = 'el-settings-btn';
      bkToggle.textContent = s('settings.backupTurnOn');
      const bkNow = document.createElement('button');
      bkNow.type = 'button';
      bkNow.className = 'el-settings-btn is-ghost';
      bkNow.textContent = s('settings.backupNow');
      bkRow.append(bkToggle, bkNow);
      const bkNote = document.createElement('div');
      bkNote.className = 'el-settings-note';

      bkCard.append(bkHead, bkHint, bkFolderLabel, bkFolderRow, bkIntervalField, bkRetainField, bkRow, bkNote);
      el.append(bkCard);

      function stampOf(ms) {
        if (!ms) return '';
        const d = new Date(ms);
        return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }

      function paintBackup() {
        if (!bkState) return;
        const on = !!bkState.enabled;
        bkStatus.textContent = !bkState.supported
          ? s('settings.backupUnsupported')
          : on ? s('settings.backupOn') : s('settings.backupOff');
        bkFolderName.textContent = bkState.directory
          ? (bkState.directoryName || s('settings.backupFolderChosen'))
          : s('settings.backupNoFolder');
        markSegments(bkIntervalField, bkState.intervalDays || 7);
        markSegments(bkRetainField, bkState.retainGroups || 3);
        bkToggle.textContent = on ? s('settings.backupTurnOff') : s('settings.backupTurnOn');
        const groups = (bkState.groups || []).length;
        if (!bkNote.dataset.keep) {
          const last = bkState.lastSuccessAt
            ? `${s('settings.backupLast')} ${stampOf(bkState.lastSuccessAt)} · ${(bkState.lastBytes / 1048576).toFixed(2)} MB`
            : s('settings.backupNever');
          bkNote.className = bkState.lastError ? 'el-settings-note is-error' : 'el-settings-note';
          bkNote.textContent = bkState.lastError || `${last} · ${s('settings.backupCount')} ${groups}`;
        }
      }

      async function refreshBackup() {
        try {
          bkState = await backupState();
        } catch (err) {
          bkNote.className = 'el-settings-note is-error';
          bkNote.textContent = `${s('settings.backupFail')}${(err && (err.message || err.code)) || err}`;
          return;
        }
        paintBackup();
      }

      async function applyBackup(patch) {
        try {
          bkState = await configureBackup(patch);
          paintBackup();
        } catch (err) {
          bkNote.className = 'el-settings-note is-error';
          bkNote.textContent = `${s('settings.backupFail')}${(err && (err.message || err.code)) || err}`;
        }
      }

      bkChoose.addEventListener('click', async () => {
        bkChoose.disabled = true;
        try {
          const picked = await chooseBackupDirectory();
          if (picked) {
            bkNote.className = 'el-settings-note';
            bkNote.textContent = `${s('settings.backupFolderPicked')} ${picked.directoryName || ''}`;
          }
        } catch (err) {
          bkNote.className = 'el-settings-note is-error';
          bkNote.textContent = `${s('settings.backupFail')}${(err && (err.message || err.code)) || err}`;
        } finally {
          bkChoose.disabled = false;
          await refreshBackup();
        }
      });

      bkToggle.addEventListener('click', async () => {
        if (!bkState) return;
        if (!bkState.directory) {
          bkNote.className = 'el-settings-note is-error';
          bkNote.textContent = s('settings.backupNeedFolder');
          return;
        }
        await applyBackup({ enabled: !bkState.enabled });
      });

      bkNow.addEventListener('click', async () => {
        if (!bkState || !bkState.directory) {
          bkNote.className = 'el-settings-note is-error';
          bkNote.textContent = s('settings.backupNeedFolder');
          return;
        }
        bkNow.disabled = true;
        bkNote.dataset.keep = '1';
        bkNote.className = 'el-settings-note';
        bkNote.textContent = s('settings.backupRunning');
        try {
          const res = await runBackup({ force: true });
          if (!res.ok) {
            bkNote.className = 'el-settings-note is-error';
            bkNote.textContent = `${s('settings.backupSkipped')} ${res.skipped || ''}`;
          } else {
            const pruned = (res.pruned || []).length;
            const mb = (((res.group && res.group.bytes) || 0) / 1048576).toFixed(2);
            bkNote.className = 'el-settings-note';
            bkNote.textContent = `${s('settings.backupDone')} ${(res.group && res.group.name) || ''} · ${mb} MB · ${res.ms} ms`
              + (pruned ? ` · ${s('settings.backupPruned')} ${pruned}` : '');
          }
        } catch (err) {
          bkNote.className = 'el-settings-note is-error';
          bkNote.textContent = `${s('settings.backupFail')}${(err && (err.message || err.code)) || err}`;
        } finally {
          delete bkNote.dataset.keep;
          bkNow.disabled = false;
          await refreshBackup();
        }
      });

      refreshBackup();

      // —— 主动消息 ——
      const groupPro = document.createElement('div');
      groupPro.className = 'el-settings-group-title';
      groupPro.textContent = s('settings.groupProactive');
      el.append(groupPro);

      const proCard = document.createElement('div');
      proCard.className = 'el-settings-card';

      const proHead = document.createElement('div');
      proHead.className = 'el-settings-card-head';
      const proTitle = document.createElement('div');
      proTitle.className = 'el-settings-card-title';
      proTitle.textContent = s('settings.proactiveTitle');
      const proState = document.createElement('div');
      proState.className = 'el-settings-note';
      proHead.append(proTitle, proState);

      const proHint = document.createElement('div');
      proHint.className = 'el-settings-card-hint';
      proHint.textContent = s('settings.proactiveHint');

      const proRhythmLabel = document.createElement('span');
      proRhythmLabel.className = 'el-settings-label';
      proRhythmLabel.textContent = s('settings.proactiveRhythm');

      const proSegments = document.createElement('div');
      proSegments.className = 'el-settings-segments';
      const proSegButtons = RHYTHMS.map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-settings-segment';
        b.dataset.rhythm = r.id;
        b.textContent = r.label;
        b.addEventListener('click', () => {
          currentRhythm = r.id;
          paintProactive();
          // 改了节奏就先重排 —— 否则要等当前那次闹钟响完才生效
          pushMaterial({ config: state?.getConfig(), messages: state?.getMessages(), rhythmId: currentRhythm })
            .then(() => setEnabled(true, { profileId: '' }))
            .catch((err) => console.warn('[settings] 重排失败', err));
        });
        return b;
      });
      proSegments.append(...proSegButtons);

      const proRow = document.createElement('div');
      proRow.className = 'el-settings-row';
      const proToggle = document.createElement('button');
      proToggle.type = 'button';
      proToggle.className = 'el-settings-btn';
      const proTest = document.createElement('button');
      proTest.type = 'button';
      proTest.className = 'el-settings-btn is-ghost';
      proTest.textContent = s('settings.proactiveTest');
      proRow.append(proToggle, proTest);

      const proSched = document.createElement('div');
      proSched.className = 'el-settings-note';

      const proNote = document.createElement('div');
      proNote.className = 'el-settings-note';

      proCard.append(proHead, proHint, proRhythmLabel, proSegments, proRow, proSched, proNote);
      el.append(proCard);

      let currentRhythm = 'normal';
      let proEnabled = false;
      let proBusy = false;

      function fmtAt(ms) {
        if (!ms) return '';
        const d = new Date(ms);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
      }

      function paintProactive() {
        for (const b of proSegButtons) {
          const on = b.dataset.rhythm === currentRhythm;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        proToggle.textContent = proEnabled ? s('settings.proactiveOff') : s('settings.proactiveOn');
        proToggle.disabled = proBusy;
        proTest.disabled = proBusy || !proEnabled;
        proState.textContent = proEnabled ? s('settings.proactiveOnTag') : s('settings.proactiveOffTag');
      }

      async function refreshProactive() {
        try {
          const st = await readState();
          proEnabled = !!st.enabled;
          // 排程行与结果行分开：刷新排程不能把刚跑出来的那句话擦掉
          if (st.nextAt) proSched.textContent = `${s('settings.proactiveNext')} ${fmtAt(st.nextAt)}`;
          else proSched.textContent = '';
          if (st.lastError) proNote.textContent = `${s('settings.proactiveLastFail')} ${st.lastError}`;
        } catch (err) {
          proSched.textContent = s('settings.proactiveUnavailable');
        }
        paintProactive();
      }

      proToggle.addEventListener('click', async () => {
        if (proBusy) return;
        proBusy = true;
        paintProactive();
        try {
          const want = !proEnabled;
          if (want) {
            const cfgNow = (state && state.getConfig()) || null;
            if (!isUsable(cfgNow)) {
              proNote.textContent = s('settings.proactiveNeedModel');
              proBusy = false;
              paintProactive();
              return;
            }
            await pushMaterial({
              config: cfgNow,
              messages: state?.getMessages(),
              rhythmId: currentRhythm,
            });
          }
          await setEnabled(want, { profileId: '' });
          // 通知权限：没有就当场要一次
          if (want) {
            try {
              await call('EllenAutonomy', 'requestBackgroundPermission', {});
            } catch (err) {
              console.warn('[settings] 通知权限', err);
            }
          }
        } catch (err) {
          proNote.textContent = `${s('settings.proactiveFail')} ${err?.message || err?.code || err}`;
        }
        proBusy = false;
        await refreshProactive();
      });

      proTest.addEventListener('click', async () => {
        if (proBusy) return;
        proBusy = true;
        proNote.textContent = s('settings.proactiveTesting');
        paintProactive();
        try {
          const res = await call('EllenAutonomy', 'runNow', { dryRun: false });
          proNote.textContent = res && res.ok
            ? `${s('settings.proactiveTested')} ${res.text}`
            : `${s('settings.proactiveFail')} ${res?.code || ''}`;
          // 立刻把这句话落成聊天记录，别等用户离开设置页再同步
          if (res && res.ok) {
            const pending = await takePending();
            if (pending && pending.text) {
              state?.addMessage({ role: 'assistant', text: pending.text });
              onChange?.('proactive');
            }
          }
        } catch (err) {
          proNote.textContent = `${s('settings.proactiveFail')} ${err?.message || err?.code || err}`;
        }
        proBusy = false;
        await refreshProactive();
      });

      refreshProactive();

      // —— 角色与陪伴 ——
      const group2 = document.createElement('div');
      group2.className = 'el-settings-group-title';
      group2.textContent = s('settings.groupCharacter');
      el.append(group2);

      // ===== 角色卡：她是谁、怎么叫你、一次说多少 =====
      const pCard = document.createElement('div');
      pCard.className = 'el-settings-card';
      const pHead = document.createElement('div');
      pHead.className = 'el-settings-card-head';
      const pTitle = document.createElement('div');
      pTitle.className = 'el-settings-card-title';
      pTitle.textContent = s('settings.characterCard');
      const pStatus = document.createElement('div');
      pStatus.className = 'el-settings-status';
      pHead.append(pTitle, pStatus);
      const pHint = document.createElement('div');
      pHint.className = 'el-settings-card-hint';
      pHint.textContent = s('settings.personaHint');

      const callField = document.createElement('div');
      callField.className = 'el-settings-field';
      const callLabel = document.createElement('span');
      callLabel.className = 'el-settings-label';
      callLabel.textContent = s('settings.personaCallMe');
      const callInput = document.createElement('input');
      callInput.className = 'el-settings-input';
      callInput.type = 'text';
      callInput.maxLength = 12;
      callInput.placeholder = s('settings.personaCallMePlaceholder');
      callField.append(callLabel, callInput);

      // 关系：和相处页共用一份数据（companion.js 的 meta），改哪边都同步
      const relField = document.createElement('div');
      relField.className = 'el-settings-field';
      const relLabel = document.createElement('span');
      relLabel.className = 'el-settings-label';
      relLabel.textContent = s('settings.personaRelation');
      const relSegs = document.createElement('div');
      relSegs.className = 'el-settings-segments';
      const relButtons = RELATIONSHIPS.map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-settings-segment';
        b.dataset.rel = r.id;
        b.textContent = r.label;
        relSegs.append(b);
        return b;
      });
      relField.append(relLabel, relSegs);

      const toneField = document.createElement('div');
      toneField.className = 'el-settings-field';
      const toneLabel = document.createElement('span');
      toneLabel.className = 'el-settings-label';
      toneLabel.textContent = s('settings.personaTone');
      const toneChips = document.createElement('div');
      toneChips.className = 'el-settings-chips';
      const toneButtons = TONES.map((id) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-settings-chip';
        b.dataset.tone = id;
        b.textContent = s(`settings.tone_${id}`);
        toneChips.append(b);
        return b;
      });
      toneField.append(toneLabel, toneChips);

      const lenField = document.createElement('div');
      lenField.className = 'el-settings-field';
      const lenLabel = document.createElement('span');
      lenLabel.className = 'el-settings-label';
      lenLabel.textContent = s('settings.personaLength');
      const lenSegs = document.createElement('div');
      lenSegs.className = 'el-settings-segments';
      const lenButtons = LENGTHS.map((id) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'el-settings-segment';
        b.dataset.len = id;
        b.textContent = s(`settings.length_${id}`);
        lenSegs.append(b);
        return b;
      });
      lenField.append(lenLabel, lenSegs);

      const noteField = document.createElement('div');
      noteField.className = 'el-settings-field';
      const noteLabel = document.createElement('span');
      noteLabel.className = 'el-settings-label';
      noteLabel.textContent = s('settings.personaNote');
      const noteInput = document.createElement('textarea');
      noteInput.className = 'el-settings-input el-settings-textarea';
      noteInput.rows = 3;
      noteInput.maxLength = 400;
      noteInput.placeholder = s('settings.personaNotePlaceholder');
      noteField.append(noteLabel, noteInput);

      const pRow = document.createElement('div');
      pRow.className = 'el-settings-row';
      const pSave = document.createElement('button');
      pSave.type = 'button';
      pSave.className = 'el-settings-btn';
      pSave.textContent = s('settings.personaSave');
      const pReset = document.createElement('button');
      pReset.type = 'button';
      pReset.className = 'el-settings-btn is-ghost';
      pReset.textContent = s('settings.personaReset');
      pRow.append(pSave, pReset);

      const pMsg = document.createElement('div');
      pMsg.className = 'el-settings-note';

      pCard.append(pHead, pHint, callField, relField, toneField, lenField, noteField, pRow, pMsg);
      el.append(pCard);

      let persona = readPersona();
      let relationId = 'lover';

      function paintPersona() {
        callInput.value = persona.callMe || '';
        // 用当前输入框的值算摘要，让「还没保存」也看得见
        pStatus.textContent = describePersona({ ...persona, callMe: callInput.value });
        for (const b of toneButtons) b.classList.toggle('is-active', b.dataset.tone === persona.tone);
        for (const b of lenButtons) b.classList.toggle('is-active', b.dataset.len === persona.length);
        for (const b of relButtons) b.classList.toggle('is-active', b.dataset.rel === relationId);
        noteInput.value = persona.note || '';
      }

      for (const b of toneButtons) {
        b.addEventListener('click', () => {
          persona = writePersona({ tone: b.dataset.tone });
          paintPersona();
        });
      }
      for (const b of lenButtons) {
        b.addEventListener('click', () => {
          persona = writePersona({ length: b.dataset.len });
          paintPersona();
        });
      }
      for (const b of relButtons) {
        b.addEventListener('click', async () => {
          relationId = b.dataset.rel;
          try {
            await setRelationship(relationId);
            pMsg.textContent = s('settings.personaSaved');
          } catch (err) {
            pMsg.textContent = `${s('settings.personaFail')} ${err?.message || err}`;
          }
          paintPersona();
        });
      }
      callInput.addEventListener('input', () => {
        // 输入即存：这一栏就一个词，没必要多按一次保存
        persona = writePersona({ callMe: callInput.value.slice(0, 12) });
        pStatus.textContent = describePersona(persona);
      });
      pSave.addEventListener('click', () => {
        persona = writePersona({
          callMe: callInput.value.slice(0, 12),
          note: noteInput.value.slice(0, 400),
        });
        paintPersona();
        pMsg.textContent = s('settings.personaSaved');
      });
      pReset.addEventListener('click', () => {
        persona = resetPersona();
        paintPersona();
        pMsg.textContent = s('settings.personaResetDone');
      });

      relationship()
        .then((r) => {
          relationId = (r && r.id) || 'lover';
          paintPersona();
        })
        .catch(() => paintPersona());
      paintPersona();

      // ===== 聊天偏好：一条消息发出去之后，请求怎么拼 =====
      const cCard = document.createElement('div');
      cCard.className = 'el-settings-card';
      const cHead = document.createElement('div');
      cHead.className = 'el-settings-card-head';
      const cTitle = document.createElement('div');
      cTitle.className = 'el-settings-card-title';
      cTitle.textContent = s('settings.chatPrefs');
      const cStatus = document.createElement('div');
      cStatus.className = 'el-settings-status';
      cHead.append(cTitle, cStatus);
      const cHint = document.createElement('div');
      cHint.className = 'el-settings-card-hint';
      cHint.textContent = s('settings.chatPrefsHint');

      let chatPrefs = readChatPrefs();

      function markSegments(field, value) {
        for (const b of field.querySelectorAll('.el-settings-segment')) {
          b.classList.toggle('is-active', b.dataset.value === String(value));
        }
      }

      function segmentField(labelText, items, current, onPick) {
        const field = document.createElement('div');
        field.className = 'el-settings-field';
        const label = document.createElement('span');
        label.className = 'el-settings-label';
        label.textContent = labelText;
        const segs = document.createElement('div');
        segs.className = 'el-settings-segments';
        const buttons = items.map((it) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'el-settings-segment';
          b.dataset.value = String(it.value);
          b.textContent = it.label;
          b.classList.toggle('is-active', String(it.value) === String(current));
          b.addEventListener('click', () => {
            for (const x of buttons) x.classList.toggle('is-active', x === b);
            onPick(it.value);
          });
          segs.append(b);
          return b;
        });
        field.append(label, segs);
        return field;
      }

      const recallField = segmentField(
        s('settings.chatRecall'),
        [
          { value: 'on', label: s('settings.on') },
          { value: 'off', label: s('settings.off') },
        ],
        chatPrefs.recall ? 'on' : 'off',
        (v) => {
          chatPrefs = writeChatPrefs({ recall: v === 'on' });
          paintChatPrefs();
        }
      );

      const rlimitField = segmentField(
        s('settings.chatRecallLimit'),
        [3, 6, 9, 12].map((n) => ({ value: n, label: `${n} 条` })),
        chatPrefs.recallLimit,
        (v) => {
          chatPrefs = writeChatPrefs({ recallLimit: Number(v) });
          paintChatPrefs();
        }
      );

      const histField = segmentField(
        s('settings.chatHistory'),
        HISTORY_OPTIONS.map((n) => ({ value: n, label: `${n} 条` })),
        chatPrefs.history,
        (v) => {
          chatPrefs = writeChatPrefs({ history: Number(v) });
          paintChatPrefs();
        }
      );

      const thinkField = segmentField(
        s('settings.chatThinking'),
        [
          { value: 'default', label: s('settings.chatThinkingDefault') },
          { value: 'disabled', label: s('settings.chatThinkingOff') },
        ],
        chatPrefs.thinking,
        (v) => {
          chatPrefs = writeChatPrefs({ thinking: v === 'disabled' ? 'disabled' : 'default' });
          paintChatPrefs();
        }
      );

      const cRow = document.createElement('div');
      cRow.className = 'el-settings-row';
      const cReset = document.createElement('button');
      cReset.type = 'button';
      cReset.className = 'el-settings-btn is-ghost';
      cReset.textContent = s('settings.chatReset');
      cRow.append(cReset);

      const cNote = document.createElement('div');
      cNote.className = 'el-settings-note';

      function paintChatPrefs() {
        cStatus.textContent = `${chatPrefs.history} 条上下文`;
        rlimitField.classList.toggle('is-muted', !chatPrefs.recall);
        cNote.textContent = chatPrefs.recall
          ? s('settings.chatRecallOnHint')
          : s('settings.chatRecallOffHint');
      }

      cReset.addEventListener('click', () => {
        chatPrefs = resetChatPrefs();
        // 分段按钮是挂载时一次性画的，重置后按新值重刷 active
        const mark = (field, value) => {
          for (const b of field.querySelectorAll('.el-settings-segment')) {
            b.classList.toggle('is-active', b.dataset.value === String(value));
          }
        };
        mark(recallField, 'on');
        mark(rlimitField, chatPrefs.recallLimit);
        mark(histField, chatPrefs.history);
        mark(thinkField, chatPrefs.thinking);
        paintChatPrefs();
        cNote.textContent = s('settings.chatResetDone');
      });

      cCard.append(cHead, cHint, recallField, rlimitField, histField, thinkField, cRow, cNote);
      el.append(cCard);
      paintChatPrefs();

      // ===== 手记整理：聊够了她自己写一篇 =====
      const jCard = document.createElement('div');
      jCard.className = 'el-settings-card';
      const jHead = document.createElement('div');
      jHead.className = 'el-settings-card-head';
      const jTitle = document.createElement('div');
      jTitle.className = 'el-settings-card-title';
      jTitle.textContent = s('settings.journalTitle');
      const jStatus = document.createElement('div');
      jStatus.className = 'el-settings-status';
      jHead.append(jTitle, jStatus);
      const jHint = document.createElement('div');
      jHint.className = 'el-settings-card-hint';
      jHint.textContent = s('settings.journalHint');

      let jPrefs = readJournalPrefs();

      const jMinField = segmentField(
        s('settings.journalMin'),
        [3, 5, 8].map((n) => ({ value: n, label: `${n} 条` })),
        jPrefs.minMessages,
        (v) => {
          jPrefs = writeJournalPrefs({ minMessages: Number(v) });
          paintJournal();
        }
      );

      const jGapField = segmentField(
        s('settings.journalGap'),
        [2, 4, 8].map((n) => ({ value: n, label: `${n} 小时` })),
        jPrefs.minGapHours,
        (v) => {
          jPrefs = writeJournalPrefs({ minGapHours: Number(v) });
          paintJournal();
        }
      );

      const jRow = document.createElement('div');
      jRow.className = 'el-settings-row';
      const jToggle = document.createElement('button');
      jToggle.type = 'button';
      jToggle.className = 'el-settings-btn';
      const jNow = document.createElement('button');
      jNow.type = 'button';
      jNow.className = 'el-settings-btn is-ghost';
      jNow.textContent = s('settings.journalNow');
      jRow.append(jToggle, jNow);

      const jNote = document.createElement('div');
      jNote.className = 'el-settings-note';

      function paintJournal() {
        jStatus.textContent = jPrefs.auto ? s('settings.journalAutoOn') : s('settings.journalAutoOff');
        jToggle.textContent = jPrefs.auto ? s('settings.on') : s('settings.off');
        jToggle.classList.toggle('is-ghost', !jPrefs.auto);
      }

      jToggle.addEventListener('click', () => {
        jPrefs = writeJournalPrefs({ auto: !jPrefs.auto });
        paintJournal();
        jNote.textContent = jPrefs.auto ? s('settings.journalOnHint') : s('settings.journalOffHint');
      });

      jNow.addEventListener('click', async () => {
        jNow.disabled = true;
        jNote.textContent = s('settings.journalWriting');
        try {
          const config = state && state.getConfig();
          if (!isUsable(config)) {
            jNote.textContent = s('settings.journalNoModel');
            return;
          }
          const res = await maybeWriteJournal({
            config,
            messages: (state && state.getMessages()) || [],
          });
          if (res && res.skipped) {
            const map = {
              tooFew: s('settings.journalSkipFew'),
              tooSoon: s('settings.journalSkipSoon'),
              off: s('settings.journalSkipOff'),
              running: s('settings.journalSkipRunning'),
            };
            jNote.textContent = map[res.skipped] || `${s('settings.journalFail')} ${res.skipped}`;
          } else if (res && res.headId) {
            jNote.textContent = `${s('settings.journalDone')} ${res.title || ''}`.trim();
          } else {
            jNote.textContent = s('settings.journalFail');
          }
        } catch (err) {
          jNote.textContent = `${s('settings.journalFail')} ${err?.message || err?.code || err}`;
        } finally {
          jNow.disabled = false;
        }
      });

      jCard.append(jHead, jHint, jMinField, jGapField, jRow, jNote);
      el.append(jCard);
      paintJournal();

      // —— 语音模型：本轮不做（老大 m04690 定的先跳语音生成），留一条说明不放假开关 ——
      const ttsCard = document.createElement('div');
      ttsCard.className = 'el-settings-card';
      const tHead = document.createElement('div');
      tHead.className = 'el-settings-card-head';
      const tTitle = document.createElement('div');
      tTitle.className = 'el-settings-card-title';
      tTitle.textContent = s('settings.voiceModel');
      const tStatus = document.createElement('div');
      tStatus.className = 'el-settings-note';
      tStatus.textContent = s('settings.deferred');
      tHead.append(tTitle, tStatus);
      const tHint = document.createElement('div');
      tHint.className = 'el-settings-card-hint';
      tHint.textContent = s('settings.voiceModelHint');
      ttsCard.append(tHead, tHint);
      el.append(ttsCard);

      // —— 反馈：老包的反馈走别人的 formsubmit 端点，新壳改成系统邮件 App（M7 · D12）——
      const fbCard = document.createElement('div');
      fbCard.className = 'el-settings-card';
      const fbHead = document.createElement('div');
      fbHead.className = 'el-settings-card-head';
      const fbTitle = document.createElement('div');
      fbTitle.className = 'el-settings-card-title';
      fbTitle.textContent = s('settings.feedbackTitle');
      const fbStatus = document.createElement('div');
      fbStatus.className = 'el-settings-note';
      fbStatus.textContent = s('settings.feedbackNote');
      fbHead.append(fbTitle, fbStatus);
      const fbHint = document.createElement('div');
      fbHint.className = 'el-settings-card-hint';
      fbHint.textContent = s('settings.feedbackHint');
      const fbRow = document.createElement('div');
      fbRow.className = 'el-settings-row';
      const fbBtn = document.createElement('button');
      fbBtn.type = 'button';
      fbBtn.className = 'el-settings-btn';
      fbBtn.textContent = s('settings.feedbackOpen');
      fbBtn.addEventListener('click', () => push('feedback'));
      fbRow.append(fbBtn);
      fbCard.append(fbHead, fbHint, fbRow);
      el.append(fbCard);

      // —— 关于与更新 ——
      // 旧包的更新链是「查 COS 上的 latest.json → 下载 → 校验 sha256 → 拉起系统安装」，
      // 但地址写死在别人的桶里。新壳把地址做成可配（调试包才显示输入框），默认空 = 不联网。
      const upCard = document.createElement('div');
      upCard.className = 'el-settings-card';
      const upHead = document.createElement('div');
      upHead.className = 'el-settings-card-head';
      const upTitle = document.createElement('div');
      upTitle.className = 'el-settings-card-title';
      upTitle.textContent = s('settings.updateTitle');
      const upStatus = document.createElement('div');
      upStatus.className = 'el-settings-status';
      upHead.append(upTitle, upStatus);
      const upHint = document.createElement('div');
      upHint.className = 'el-settings-card-hint';
      upHint.textContent = s('settings.updateHint');
      const upVer = document.createElement('div');
      upVer.className = 'el-settings-note';
      const upRow = document.createElement('div');
      upRow.className = 'el-settings-row';
      const upCheck = document.createElement('button');
      upCheck.type = 'button';
      upCheck.className = 'el-settings-btn';
      upCheck.textContent = s('settings.updateCheck');
      const upAction = document.createElement('button');
      upAction.type = 'button';
      upAction.className = 'el-settings-btn is-ghost';
      upAction.hidden = true;
      upRow.append(upCheck, upAction);
      const upNotes = document.createElement('div');
      upNotes.className = 'el-settings-note';
      const upUrlLabel = document.createElement('div');
      upUrlLabel.className = 'el-settings-field-label';
      upUrlLabel.textContent = s('settings.updateManifest');
      const upUrlInput = document.createElement('input');
      upUrlInput.type = 'url';
      upUrlInput.className = 'el-settings-input';
      upUrlInput.placeholder = 'https://…/latest.json';
      upUrlInput.value = updateManifestUrl();
      const upUrlRow = document.createElement('div');
      upUrlRow.className = 'el-settings-row';
      const upUrlSave = document.createElement('button');
      upUrlSave.type = 'button';
      upUrlSave.className = 'el-settings-btn is-ghost';
      upUrlSave.textContent = s('settings.updateSave');
      upUrlRow.append(upUrlSave);
      const upUrlBox = document.createElement('div');
      upUrlBox.className = 'el-settings-field is-hidden';
      upUrlBox.append(upUrlLabel, upUrlInput, upUrlRow);
      upCard.append(upHead, upHint, upVer, upRow, upNotes, upUrlBox);
      el.append(upCard);

      let upBusy = false;
      function paintUpdate(st) {
        const cur = (st && st.current) || {};
        const phase = (st && st.phase) || 'idle';
        upStatus.textContent = s(`settings.updatePhase_${phase}`) || '';
        upVer.textContent = cur.version ? `${s('settings.updateCurrent')}${cur.version}（${cur.versionCode}）` : '';
        const latest = st && st.latest;
        if (latest && (phase === 'available' || phase === 'downloading' || phase === 'ready' || phase === 'verifying')) {
          const bits = [];
          if (latest.version) bits.push(`${s('settings.updateLatest')}${latest.version}（${latest.versionCode}）`);
          if (latest.notes) bits.push(String(latest.notes));
          upNotes.textContent = bits.join(' · ');
        } else {
          upNotes.textContent = (st && st.message) || '';
        }
        const progress = updateProgressText(st);
        if (phase === 'downloading' && progress) {
          upNotes.textContent = `${s('settings.updateDownloading')}${progress}`;
        }
        if (phase === 'ready' || phase === 'installing' || phase === 'permission') {
          upAction.hidden = false;
          upAction.textContent = s('settings.updateInstall');
        } else if (latest && phase === 'available') {
          upAction.hidden = false;
          upAction.textContent = s('settings.updateDownload');
        } else if (phase === 'downloading' || phase === 'verifying') {
          upAction.hidden = false;
          upAction.textContent = s('settings.updateCancel');
        } else {
          upAction.hidden = true;
        }
        upCheck.disabled = upBusy || phase === 'downloading' || phase === 'verifying';
      }

      let offUpdate = null;
      onUpdateState((st) => paintUpdate(st)).then((off) => {
        offUpdate = off;
      });
      paintUpdate(null);
      updateState()
        .then((st) => {
          paintUpdate(st);
          return updatesAvailable();
        })
        .then(async (ok) => {
          if (!ok) {
            upStatus.textContent = s('settings.updateUnsupported');
            upCheck.disabled = true;
            return;
          }
          // 调试包才给「更新地址」输入框，正式包不该让用户碰这个
          try {
            const info = await call('EllenReleaseInfo', 'state', {});
            if (info && info.debuggable) upUrlBox.classList.remove('is-hidden');
          } catch (_) {
            // 读不到版本信息就不显示
          }
        })
        .catch(() => {});

      async function runUpdate(fn) {
        if (upBusy) return;
        upBusy = true;
        upCheck.disabled = true;
        try {
          const st = await fn();
          if (st) paintUpdate(st);
        } catch (err) {
          upNotes.textContent = `${s('settings.updateFail')}${String((err && err.message) || err)}`;
        } finally {
          upBusy = false;
          upCheck.disabled = false;
        }
      }

      upCheck.addEventListener('click', () => runUpdate(() => checkUpdate()));
      upAction.addEventListener('click', () =>
        runUpdate(async () => {
          const st = await updateState();
          const phase = (st && st.phase) || '';
          if (phase === 'ready' || phase === 'installing' || phase === 'permission') return installUpdate();
          if (phase === 'downloading' || phase === 'verifying') return cancelUpdate();
          return downloadUpdate();
        }),
      );
      upUrlSave.addEventListener('click', () =>
        runUpdate(async () => {
          const st = await configureUpdate(upUrlInput.value.trim());
          upNotes.textContent = s('settings.updateSaved');
          return st;
        }),
      );

      return {
        destroy() {
          if (offUpdate) offUpdate();
        },
      };
    },
  };
}
