// 设置 · 数据（二级页）：自动备份 + 导入/导出资料包。
// 备份里的分段控件用 settings-kit.js 的 segmentField。
import { s } from '../../../strings.zh.js';
import { markSegments, segmentField } from './settings-kit.js';
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

export function createBackupPage({ state, onChange } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('settings.pageBackup');
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('settings.pageBackupHint');
      el.append(title, subtitle);

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
            + '导入会和这台手机的资料合并：两边新增都留下，共有记录去重，不会覆盖。',
          );
          if (!ok) {
            say(s('settings.importCancelled'));
            return;
          }
          const r = await importSnapshot(snapshot, { merge: true });
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
