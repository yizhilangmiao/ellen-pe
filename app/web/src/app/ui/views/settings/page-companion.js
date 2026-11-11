// 设置 · 陪伴（二级页）：主动消息、角色卡、聊天偏好、手记整理。
// 都是「调她的性格和手感」，放一页比散在首页好找。
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

export function createCompanionPage({ state, onChange } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = s('settings.pageCompanion');
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = s('settings.pageCompanionHint');
      el.append(title, subtitle);

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
