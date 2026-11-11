// 设置 · 关于与更新（二级页）：版本与更新链、反馈入口、还没做的语音模型说明。
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

export function createAboutPage({ state, onChange } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('settings.pageAbout');
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('settings.pageAboutHint');
      el.append(title, subtitle);

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


      // 横屏两栏：多列流只能挂在块容器上，标题留在外面通栏。
      const flow = document.createElement('div');
      flow.className = 'el-settings-flow';
      for (const node of [...el.children]) {
        if (node === title) continue;
        flow.append(node);
      }
      el.append(flow);

      return {
        destroy() {
          if (offUpdate) offUpdate();
        },
      };
    },
  };
}
