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
import { parseManifest, extractSnapshot, rebuildHeads, importSnapshot, applyLorePack } from '../../../core/store/import.js';
import { count as storeCount } from '../../../core/store/db.js';
import { buildManifest } from '../../../core/store/export.js';
import { scanLegacy, importLegacy, importAllLegacy, pickLegacyFolder, scanPermission, requestAllFiles } from '../../../core/legacy.js';
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

    // —— 从旧版搬过来（一键迁移）——
    // 老版艾莲的数据在它自己的 sandbox 里读不到，它唯一放出来的就是导出的 .ellenpack；
    // 这里把共享存储里的包全扫出来，点一下就合并进库，省掉「开选择器一个个挑」。
    const legacyCard = document.createElement('div');
    legacyCard.className = 'el-settings-card';
    const legacyHead = document.createElement('div');
    legacyHead.className = 'el-settings-head';
    legacyHead.textContent = s('settings.legacyTitle');
    const legacyHint = document.createElement('div');
    legacyHint.className = 'el-settings-hint';
    legacyHint.textContent = s('settings.legacyHint');
    const legacyRow = document.createElement('div');
    legacyRow.className = 'el-settings-row';
    const legacyScan = document.createElement('button');
    legacyScan.type = 'button';
    legacyScan.className = 'el-settings-btn';
    legacyScan.textContent = s('settings.legacyScan');
    legacyRow.append(legacyScan);
    // 诊断：只在排查「数据在库里但界面看不到」时才用。屏幕上看一眼就能定性，
    // 不用连 devtools（2026-11-13 真机换签名包后聊天页空白就是靠它定的性）。
    const diagBtn = document.createElement('button');
    diagBtn.type = 'button';
    diagBtn.className = 'el-settings-btn is-ghost';
    diagBtn.textContent = '诊断';
    legacyRow.append(diagBtn);
    const legacyList = document.createElement('div');
    legacyList.className = 'el-legacy-list';
    const legacyNote = document.createElement('div');
    legacyNote.className = 'el-settings-note';
    legacyCard.append(legacyHead, legacyHint, legacyRow, legacyList, legacyNote);
    el.append(legacyCard);

    function legacySay(text, isError) {
      legacyNote.className = isError ? 'el-settings-note is-error' : 'el-settings-note';
      legacyNote.textContent = text;
    }

    /** 诊断：把 profile / 当前线程 / 消息分布摊在屏幕上。 */
    async function showDiagnostics() {
      const box = document.createElement('pre');
      box.className = 'el-legacy-result-line';
      box.style.whiteSpace = 'pre-wrap';
      try {
        const db = await import('../../../core/store/db.js');
        const handle = await db.openDb();
        const all = (store) => new Promise((resolve) => {
          try {
            const t = handle.transaction(store, 'readonly');
            const r = t.objectStore(store).getAll();
            r.onsuccess = () => resolve(r.result || []);
            r.onerror = () => resolve([]);
          } catch (err) {
            resolve([]);
          }
        });
        const profiles = await all('data-profiles');
        const heads = await all('data-heads');
        const { ensureProfile, currentThreadId, getMeta } = await import('../../../core/store/records.js');
        const mine = await ensureProfile();
        const metaThread = await getMeta('current-thread');
        const tid = await currentThreadId();
        const byThread = new Map();
        const byProfile = new Map();
        for (const h of heads) {
          if (h.kind !== 'message') continue;
          const k = `${h.profileId || '?'} | ${h.threadId || '?'}`;
          byThread.set(k, (byThread.get(k) || 0) + 1);
          byProfile.set(h.profileId || '?', (byProfile.get(h.profileId || '?') || 0) + 1);
        }
        const lines = [
          `heads 总数：${heads.length}`,
          `profiles(${profiles.length})：${profiles.map((p) => p.id).join(', ')}`,
          `ensureProfile：${mine.id}`,
          `meta current-thread：${metaThread || '(空)'}`,
          `currentThreadId：${tid}`,
          `消息按 profile 分：${[...byProfile].map(([k, v]) => `${k}=${v}`).join(' / ') || '(无)'}`,
          `消息按 线程 分：`,
          ...[...byThread].map(([k, v]) => `  ${k} → ${v}`),
        ];
        box.textContent = lines.join('\n');
      } catch (err) {
        box.textContent = `诊断失败：${(err && err.message) || err}`;
      }
      legacyList.append(box);
    }

    diagBtn.addEventListener('click', () => {
      const old = legacyList.querySelector('pre');
      if (old) old.remove();
      showDiagnostics();
    });

    function sizeText(bytes) {
      const n = Number(bytes || 0);
      if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    }

    function dateText(at) {
      const d = new Date(Number(at || 0) || Date.now());
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    }

    // 探针：导入前后各数一次库里的记录数，界面上直接给「多少 → 多少」，
    // 不用去翻库也能判断这次到底进没进来。
    async function headsTotal() {
      try {
        return await storeCount('data-heads');
      } catch (err) {
        return -1;
      }
    }

    function showLegacyResult(name, before, after, r) {
      const old = legacyCard.querySelector('.el-legacy-result');
      if (old) old.remove();
      const box = document.createElement('div');
      box.className = 'el-legacy-result';
      const added = before >= 0 && after >= 0 ? after - before : Number(r.heads || 0);
      const head = document.createElement('p');
      head.className = 'el-legacy-result-head';
      head.textContent =
        added > 0
          ? `已导入 · ${name}`
          : `没有新增 · ${name}`;
      const line1 = document.createElement('p');
      line1.className = 'el-legacy-result-line';
      const kinds = Object.entries(r.kinds || {})
        .map(([k, v]) => `${KIND_TEXT[k] || k} ${v}`)
        .join('、');
      line1.textContent = added > 0
        ? `这次进来 ${added} 条${kinds ? `：${kinds}` : ''}`
        : '这份包里的记录库里都已经有了，按记录 id 去重后没有新增。';
      const line2 = document.createElement('p');
      line2.className = 'el-legacy-result-line is-strong';
      line2.textContent =
        before >= 0 && after >= 0
          ? `库里总记录 ${before} → ${after}`
          : `库里现在 ${after >= 0 ? after : '?'} 条`;
      box.append(head, line1, line2);
      legacyNote.after(box);
      return added;
    }

    const KIND_TEXT = {
      message: '消息',
      memory: '记忆',
      journal: '手记',
      attachment: '附件',
      call: '通话',
      thread: '会话',
      profile: '角色',
    };

    async function importLegacyFile(item, label) {
      legacySay(`${s('settings.legacyReading')}${item.name}…`);
      const before = await headsTotal();
      try {
        const r = await importLegacy(item.uri);
        if (state && state.reload) await state.reload();
        if (onChange) onChange();
        const after = await headsTotal();
        const added = showLegacyResult(item.name, before, after, r);
        const kinds = Object.entries(r.kinds || {}).map(([k, v]) => `${KIND_TEXT[k] || k} ${v}`).join('、');
        legacySay(
          added > 0
            ? `${s('settings.importDone')} ${r.heads} 条记录${kinds ? `（${kinds}）` : ''}。`
            : '这份包里的记录库里都已经有了，没有新增。',
        );
        if (label && added > 0) label.dataset.done = '1';
        return true;
      } catch (err) {
        const msg = (err && (err.code || err.message)) || String(err);
        legacySay(`${s('settings.legacyFailed')}${msg}`, true);
        return false;
      }
    }

    // 「选文件夹找…」和「打开全盘扫描权限」永远都在：扫到了也能用它们补扫别处
    function appendLegacyTools() {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'el-settings-btn is-ghost';
      pick.textContent = s('settings.legacyPickFolder');
      pick.addEventListener('click', async () => {
        pick.disabled = true;
        try {
          const chosen = await pickLegacyFolder();
          if (!chosen || chosen.cancelled) {
            legacySay(s('settings.legacyCancelled'));
            return;
          }
          const again = await scanLegacy(chosen.treeUri);
          renderLegacyItems(again);
        } catch (err) {
          const msg = (err && (err.code || err.message)) || String(err);
          legacySay(`${s('settings.legacyFailed')}${msg}`, true);
        } finally {
          pick.disabled = false;
        }
      });
      legacyList.append(pick);

      scanPermission()
        .then((perm) => {
          if (perm.allFiles) return;
          const grant = document.createElement('button');
          grant.type = 'button';
          grant.className = 'el-settings-btn is-ghost';
          grant.textContent = s('settings.legacyGrant');
          grant.addEventListener('click', async () => {
            grant.disabled = true;
            try {
              await requestAllFiles();
              legacySay(s('settings.legacyGrantHint'));
            } catch (err) {
              const msg = (err && (err.code || err.message)) || String(err);
              legacySay(`${s('settings.legacyFailed')}${msg}`, true);
            } finally {
              grant.disabled = false;
            }
          });
          legacyList.prepend(grant);
        })
        .catch(() => {});
    }

    function renderLegacyItems(res) {
      legacyList.textContent = '';
      const usable = res.items.filter((it) => it.size > 0);
      const empty = res.items.filter((it) => it.size <= 0);
      if (!usable.length) {
        legacySay(res.oldInstalled ? s('settings.legacyNeedExport') : s('settings.legacyNone'), true);
        appendLegacyTools();
        return;
      }
      legacySay(s('settings.legacyFound').replace('{n}', String(usable.length)));
      for (const it of usable) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'el-legacy-item';
        const main = document.createElement('span');
        main.className = 'el-legacy-name';
        main.textContent = it.name;
        const meta = document.createElement('span');
        meta.className = 'el-legacy-meta';
        meta.textContent = `${dateText(it.at)} · ${sizeText(it.size)}`;
        const go = document.createElement('span');
        go.className = 'el-legacy-go';
        go.textContent = s('settings.legacyImportOne');
        row.append(main, meta, go);
        const run = () => {
          if (row.dataset.busy) return;
          row.dataset.busy = '1';
          row.classList.add('is-busy');
          importLegacyFile(it, row).finally(() => {
            delete row.dataset.busy;
            row.classList.remove('is-busy');
          });
        };
        row.addEventListener('click', run);
        legacyList.append(row);
      }
      if (empty.length) {
        const warn = document.createElement('div');
        warn.className = 'el-legacy-empty';
        warn.textContent = `${empty.length} 份是空文件（0 B，旧版写盘没成功），搜不到内容。`;
        legacyList.append(warn);
      }
      if (usable.length > 1) {
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'el-settings-btn is-ghost';
        all.textContent = `${s('settings.legacyImportAll')}（${usable.length}）`;
        all.addEventListener('click', async () => {
          all.disabled = true;
          const r = await importAllLegacy(usable, (step) => {
            legacySay(`${step.index + 1}/${step.total} · ${step.item.name}`);
          });
          legacySay(
            `${s('settings.importDone')} ${r.imported} 份，共 ${r.heads} 条记录${r.failed ? `；${r.failed} 份没进来` : ''}。`,
          );
          if (state && state.reload) await state.reload();
          if (onChange) onChange();
        });
        legacyList.append(all);
      }
      appendLegacyTools();
    }

    legacyScan.addEventListener('click', async () => {
      legacyScan.disabled = true;
      legacySay(s('settings.legacyScanning'));
      try {
        const res = await scanLegacy();
        if (!res.supported) {
          legacySay(s('settings.legacyNotOnDevice'), true);
          return;
        }
        renderLegacyItems(res);
      } catch (err) {
        const msg = (err && (err.code || err.message)) || String(err);
        legacySay(`${s('settings.legacyFailed')}${msg}`, true);
      } finally {
        legacyScan.disabled = false;
      }
    });

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
          const { snapshot, content, loreHint } = extractSnapshot(parsed);
          const preview = rebuildHeads(snapshot.records);
          if (!preview.heads.length) {
            say(s('settings.importEmpty'));
            return;
          }
          const where = content && content.origin ? content.origin.platform : '';
          const ok = window.confirm(
            `资料包来自${where || '旧版'}，含 ${preview.heads.length} 条记录、${preview.revisions.length} 次改动。\n`
            + '导入会和这台手机的资料合并：两边新增都留下，共有记录去重，不会覆盖。'
            // 角色卡单独说一句：包里的卡会替掉本机选择，不提前讲清就是偷偷改人设
            + (loreHint ? `\n${loreHint.hint}。` : ''),
          );
          if (!ok) {
            say(s('settings.importCancelled'));
            return;
          }
          const r = await importSnapshot(snapshot, { merge: true });
          // 记录落盘之后再写卡：用户取消上面那一下时，人设一点都不能动
          if (loreHint && loreHint.cardId) applyLorePack(content);
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




