// 信：让她写一封长信，流式吐字、按档位定字数、写完落一条 kind='letter' 记录。
//
// 三个必须守住的点：
//  1. **流式**：3000 字一次性等会让人以为卡死，界面上字数要一格一格往上跳（onDelta）。
//  2. **不达标重写一次**：模型经常写到 1200 字就开始祝福语收尾，第一次不达标就带着
//     「上一封只有 N 字，必须写满 M 字」再要一次；第二次还不达标就收下并标 short，
//     绝不无限重试（一次 3000 字的调用很贵，用户也不能等三轮）。
//  3. **落库要短**：整封信只在写完后 append 一次，不在流式过程中反复 revise（会把
//     revision 撑成几百条，导出包也跟着炸）。
import { appendRecord, reviseRecord } from './store/records.js';
import { listLatest } from './store/library.js';
import { STAGES, stageIndexOf, markLetterWritten, snapshot as bondSnapshot } from './bond.js';

/** 单块上限：native 一次最多给 0x4000 字节，给个防御性上限防死循环。 */
const MAX_CHUNKS = 8192;
/** 未读只数最近这些封（契约 §3）。 */
const SCAN_LIMIT = 100;
/** 收尾套话：出现就整句裁掉（这些字一个都不该出现在信里）。 */
const BANNED_TAIL = ['希望这封信', '祝好', '此致', '顺颂', '如上所述', '总之，', '作为AI', '作为 AI'];

/** 这一档的信要多少字（恋人 3000，其余 1500）。 */
export function targetChars(stageId) {
  return STAGES[stageIndexOf(stageId)].minChars;
}

/** 纯函数：字数够不够。`short` 的唯一判据（1400 < 1500 → true；1600 → false）。 */
export function isShort(chars, stageId) {
  return (Number(chars) || 0) < targetChars(stageId);
}

/** 字数上限：模型按 token 计，中文约 1.6~2 字/token，2.2 是留了余量的经验系数。 */
function maxTokensFor(target) {
  return Math.min(16000, Math.max(4096, Math.round(target * 2.2)));
}

/**
 * 数字数：去掉空白与标点（含中文标点、破折号、省略号）后数剩下的字符。
 * 为什么不直接 `text.length`：模型爱用「——」「……」占位置，按字符数会虚高。
 * @param {string} text
 * @returns {number}
 */
export function countHan(text) {
  const t = String(text == null ? '' : text);
  let n = 0;
  for (const ch of t) {
    if (/[\s\p{P}\p{S}]/u.test(ch)) continue;
    n += 1;
  }
  return n;
}

/** 把「套话开头」之前的内容裁出来；前面已经没东西了就返回空串。 */
function cutBefore(text, index) {
  const head = text.slice(0, index);
  const m = head.match(/[\s\S]*[。！？!?…\n]/);
  return m ? m[0].trim() : '';
}

/**
 * 洗一遍模型给的信：去代码围栏、去 markdown 标题、去首尾星号、裁掉收尾套话。
 * @param {string} text
 * @returns {string}
 */
export function tidy(text) {
  let t = String(text == null ? '' : text);

  // 代码围栏：模型偶尔把整封信包进 ``` 里
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`+/g, '');

  // 逐行处理：标题符号、列表符号、引用符号、首尾星号（**整封加粗**很常见）
  t = t
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s*/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\*{1,3}\s*/, '')
        .replace(/\s*\*{1,3}$/, '')
        .replace(/^_{1,3}\s*/, '')
        .replace(/\s*_{1,3}$/, '')
        .trimEnd(),
    )
    .join('\n');

  // 收尾套话：从最早出现的那句开始整段砍掉
  for (const word of BANNED_TAIL) {
    const idx = t.indexOf(word);
    if (idx < 0) continue;
    const cut = cutBefore(t, idx);
    // 前面只剩一两行时不要砍成空信（那等于这次生成白费，交给 short 判定与重写）
    if (countHan(cut) >= 60) t = cut;
    break;
  }

  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 切段。先按空行切，再把段内的单换行也当分段（模型经常一段一换行、不留空行）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitParagraphs(text) {
  return String(text == null ? '' : text)
    .split(/\n\s*\n/)
    .flatMap((block) => block.split(/\n/))
    .map((p) => p.replace(/^[\s*>#_]+/, '').replace(/[\s*_]+$/, '').trim())
    .filter((p) => p.length > 0);
}

/** 写信的落款/口吻/etc 从档位表里取，人设只负责「她是谁」。 */
function personaText(persona) {
  if (!persona) return '';
  if (typeof persona === 'string') return persona.trim();
  const name = String(persona.name || '艾莲');
  const callMe = String(persona.callMe || '').trim();
  const note = String(persona.note || '').trim();
  const lines = [`你是${name}，一个心里装着对方的女孩。`];
  if (callMe) lines.push(`信里叫他「${callMe}」。`);
  if (note) lines.push(`要记住这些设定：${note}`);
  return lines.join('\n');
}

function dateText(at) {
  const d = new Date(at);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function buildMessages({ persona, stageId, target, now }) {
  const info = STAGES[stageIndexOf(stageId)];
  const sys = [
    personaText(persona) || '你是艾莲，一个心里装着对方的女孩。',
    `现在你要给他写一封信。你们处在「${info.label}」这个阶段：${info.temper}`,
    `落款固定用：${info.sign}`,
    '写法要求：',
    '- 全篇中文，第二人称「你」，像真的写信，不像客服、不像总结、不像日记',
    '- 分成 4 到 8 段，段与段之间空一行；不要写标题、不要用 markdown、不要列清单、不要加序号',
    `- 目标 ${target} 字以上：宁可多写具体的事、具体的时刻、具体的感受，也不要凑字`,
    '- 结尾不要写「希望这封信」「祝好」「此致」「顺颂」「如上所述」「总之，」这类套话，也不要提自己是 AI',
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `今天是 ${dateText(now)}。写吧。` },
  ];
}

/**
 * 一次流式调用，返回清洗**前**的原文（清洗放外面，重写时要拿原文对比字数）。
 * 原生通道用动态 import：纯函数（tidy/countHan/splitParagraphs）不该因为这里要发请求
 * 就把 Capacitor 拽进依赖链，node 里也能单独验算。
 */
async function streamChat({ config, messages, maxTokens, signal, onDelta }) {
  const { call, requestId: newRequestId } = await import('./native/bridge.js');
  const rid = newRequestId('letter');
  const body = JSON.stringify({
    model: config.model,
    stream: true,
    max_tokens: maxTokens,
    // 后台长文统一关思考：开着会先想几十秒且不给正文，用户以为死了
    thinking: { type: 'disabled' },
    messages,
  });

  const head = await call('EllenModelHttp', 'open', {
    requestId: rid,
    url: config.endpoint,
    apiKey: config.apiKey,
    body,
  });

  const status = head && head.status;
  if (typeof status === 'number' && status >= 400) {
    let detail = '';
    try {
      const first = await call('EllenModelHttp', 'read', { requestId: rid, sequence: 1 });
      if (first && first.data) {
        const bin = atob(first.data);
        const bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        detail = new TextDecoder('utf-8').decode(bytes);
      }
    } catch {
      /* 读不到错误体不阻塞：正文错误码已经够用 */
    }
    throw Object.assign(new Error(`HTTP ${status}`), { code: `HTTP_${status}`, raw: detail.slice(0, 600) });
  }

  const decoder = new TextDecoder('utf-8');
  let carry = '';
  let text = '';
  let seq = 0;

  for (let i = 0; i < MAX_CHUNKS; i++) {
    if (signal && signal.aborted) {
      try {
        await call('EllenModelHttp', 'cancel', { requestId: rid });
      } catch {
        /* 取消失败也只能作罢，别把原始中断盖掉 */
      }
      throw Object.assign(new Error('已停止'), { code: 'CANCELLED' });
    }

    const chunk = await call('EllenModelHttp', 'read', { requestId: rid, sequence: seq + 1 });
    seq += 1;

    const b64 = chunk && chunk.data;
    if (b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      carry += decoder.decode(bytes, { stream: true });

      // 按 SSE 事件切：空行分隔，只认 data: 行
      let idx;
      while ((idx = carry.indexOf('\n\n')) >= 0) {
        const raw = carry.slice(0, idx);
        carry = carry.slice(idx + 2);
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj && obj.choices && obj.choices[0] && (obj.choices[0].delta || obj.choices[0].message);
            const piece = delta && delta.content;
            if (piece) {
              text += piece;
              if (typeof onDelta === 'function') onDelta({ text, chars: countHan(text), done: false });
            }
          } catch {
            // 非 JSON 的 data 行（服务端偶尔插 ping）跳过
          }
        }
      }
    }

    if (chunk && chunk.done) break;
  }

  return text;
}

/** 书信的套话开头：「见信好」「展信安」这类不该当标题。 */
const GENERIC_HEAD = /^(见信好|见字如面|展信悦|展信安|亲爱的|你好|你好呀|晚上好|早安|晚安|嘿|嗯)[。！？，,、…\s]*/;

function titleOf(text, at) {
  for (const p of splitParagraphs(text)) {
    const cleaned = String(p || '').replace(GENERIC_HEAD, '').trim();
    const head = cleaned.replace(/[。！？!?…].*$/, '').slice(0, 14).trim();
    if (countHan(head) >= 4) return head;
  }
  return `${dateText(at)} 的信`;
}

/** `bond` 参数可能是快照对象，也可能只给了档位字符串。 */
function stageFrom(bond) {
  if (!bond) return STAGES[0].id;
  if (typeof bond === 'string') return bond;
  return bond.stage || (bond.progress && bond.progress.stage) || STAGES[0].id;
}

/**
 * 这一档还能不能写（还没写过）。
 * @param {object} bondSnapshot `core/bond.js` 的 snapshot()
 * @returns {boolean}
 */
export function canWrite(bondSnapshot) {
  if (!bondSnapshot || typeof bondSnapshot !== 'object') return false;
  if (bondSnapshot.enabled === false) return false;
  const stage = stageFrom(bondSnapshot);
  if (bondSnapshot.letters && bondSnapshot.letters[stage]) return false;
  return true;
}

/**
 * 写一封信。流式；不够字数自动重写一次；仍不够也收下并标 short。
 * @param {object} p
 * @param {{endpoint:string,apiKey:string,model:string}} p.config 聊天配置
 * @param {object|string} [p.persona] persona.readPersona() 或一句话
 * @param {object|string} [p.bond] bond.snapshot()（或档位 id）
 * @param {(d:{text:string,chars:number,done?:boolean})=>void} [p.onDelta] 界面字数递增
 * @param {AbortSignal} [p.signal]
 * @param {boolean} [p.force] 这一档已写过时是否强行再写一封（默认 false，抛 ALREADY_WRITTEN）
 * @returns {Promise<{headId:string, stage:string, paragraphs:string[], text:string, chars:number, short:boolean, target:number, rewritten:boolean, at:number}>}
 */
export async function writeLetter({ config, persona = null, bond = null, onDelta = null, signal = null, force = false } = {}) {
  if (!config || !config.endpoint) {
    throw Object.assign(new Error('还没有配置服务地址'), { code: 'NO_CONFIG' });
  }
  const stageId = stageFrom(bond);
  // 同一档只写一封：按钮连点两下会开出两次 3000 字的流式请求，白烧钱也算不出第二封
  if (!force && bond && typeof bond === 'object' && bond.letters && bond.letters[stageId]) {
    throw Object.assign(new Error('这一档已经写过了'), { code: 'ALREADY_WRITTEN', stage: stageId });
  }
  const target = targetChars(stageId);
  const maxTokens = maxTokensFor(target);
  const now = Date.now();

  let messages = buildMessages({ persona, stageId, target, now });
  let raw = await streamChat({ config, messages, maxTokens, signal, onDelta });
  let text = tidy(raw);
  let chars = countHan(text);
  let rewritten = false;

  if (chars < target && !(signal && signal.aborted)) {
    rewritten = true;
    messages = [
      ...messages,
      { role: 'assistant', content: text.slice(0, 6000) },
      {
        role: 'user',
        content:
          `这一封只有 ${chars} 字，不够 ${target} 字。重写一封更长的：` +
          '把记忆里具体的事、具体的时刻摊开写，一段写一件事；不要重复上一封的开头，' +
          '不要用祝福语收尾，也不要解释你在重写。',
      },
    ];
    // 重写会把计数从头再跳一遍，先让界面把字数清零，否则会看到 1200 → 0 → 800 的怪跳
    if (typeof onDelta === 'function') onDelta({ text: '', chars: 0, done: false, reset: true });
    const second = await streamChat({ config, messages, maxTokens, signal, onDelta });

    const secondText = tidy(second);
    const secondChars = countHan(secondText);
    // 重写反而更短就当没重写（模型偶尔会跑偏），留长的那个
    if (secondChars > chars) {
      text = secondText;
      chars = secondChars;
    }
  }

  // 第二道：整篇重写还不够，就「接着写」。
  // 老大口径是「最少 1500 字」硬要求，而让模型一次写出 1500 字以上本身就靠运气
  // （实测 1461 字，差 39 字——整篇重写也未必补上）。续写比整篇重写更容易越过线，
  // 也不会把已经写好的段落丢掉。最多续两次，别无限烧 token。
  let continued = 0;
  while (chars < target && continued < 2 && !(signal && signal.aborted)) {
    continued += 1;
    const need = target - chars;
    const ask = Math.max(400, need + 150);
    const follow = [
      ...buildMessages({ persona, stageId, target: target + 100, now }),
      { role: 'assistant', content: text.slice(-4000) },
      {
        role: 'user',
        content:
          `接着往下写，再写 ${ask} 字左右。不要重复上面写过的内容，不要另起开头，` +
          '不要说「我接着写」，直接续正文；先不要收尾，最后再一起收。',
      },
    ];
    const more = tidy(await streamChat({
      config,
      messages: follow,
      maxTokens: maxTokensFor(ask),
      signal,
      onDelta,
    }));
    const moreChars = countHan(more);
    if (!moreChars) break;
    text = `${text}\n\n${more}`;
    chars += moreChars;
    // 续写是追加，界面上的字数只该往上走，不该清零
    if (typeof onDelta === 'function') onDelta({ text, chars, done: false });
  }

  const paragraphs = splitParagraphs(text);
  const short = chars < target;
  const at = Date.now();
  const value = {
    stage: stageId,
    at,
    createdAt: at,
    paragraphs,
    text,
    tone: STAGES[stageIndexOf(stageId)].label,
    sign: STAGES[stageIndexOf(stageId)].sign,
    chars,
    target,
    short,
    rewritten: rewritten || continued > 0,
    continued,
    read: false,
    title: titleOf(text, at),
  };

  const rec = await appendRecord({ kind: 'letter', value, threadId: null, at });

  try {
    await markLetterWritten(stageId, at);
  } catch (err) {
    // 记不上只会导致下次再自动写一封，不该把已经写好的信扔掉
    console.warn('[letter] 标记已写失败', err);
  }

  if (typeof onDelta === 'function') onDelta({ text, chars, done: true });

  return { headId: rec.headId, stage: stageId, paragraphs, text, chars, short, target, rewritten: rewritten || continued > 0, continued, at };
}

function toCard(row) {
  const v = (row && row.value) || {};
  return {
    id: row.headId,
    stage: v.stage || STAGES[0].id,
    at: Number(row.at || v.at || v.createdAt) || 0,
    chars: Number(v.chars) || 0,
    target: Number(v.target) || targetChars(v.stage),
    short: v.short === true,
    read: v.read === true,
    title: String(v.title || ''),
    sign: String(v.sign || ''),
    paragraphs: Array.isArray(v.paragraphs) && v.paragraphs.length ? v.paragraphs : splitParagraphs(v.text || ''),
    text: String(v.text || ''),
  };
}

/**
 * 信列表（新的在前）。
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array<{id,stage,at,chars,target,short,read,title,sign,paragraphs,text}>>}
 */
export async function listLetters({ limit = SCAN_LIMIT } = {}) {
  const rows = await listLatest('letter', { limit });
  return rows.map(toCard);
}

/**
 * 读一封（按 headId）。**不**顺手标已读：列表要能显示未读点，标记由界面显式调 markRead。
 * @param {string} id
 */
export async function readLetter(id) {
  if (!id) return null;
  const rows = await listLatest('letter', { limit: 0 });
  const hit = rows.find((r) => r.headId === id);
  return hit ? toCard(hit) : null;
}

/**
 * 标已读。记录只 append 不改，所以走 reviseRecord 追加一版 `read:true`。
 * @param {string} id
 * @returns {Promise<boolean>} 这次是否真的改了
 */
export async function markRead(id) {
  if (!id) return false;
  const rows = await listLatest('letter', { limit: 0 });
  const hit = rows.find((r) => r.headId === id);
  if (!hit) return false;
  const v = hit.value || {};
  if (v.read === true) return false;
  const at = Date.now();
  await reviseRecord(id, { ...v, read: true, readAt: at }, { at });
  return true;
}

/** 未读数：最近 100 封里 `read !== true` 的条数（契约 §3 的口径）。 */
export async function unreadCount() {
  const rows = await listLatest('letter', { limit: SCAN_LIMIT });
  let n = 0;
  for (const r of rows) {
    if (!(r.value && r.value.read === true)) n++;
  }
  return n;
}

/** 契约名：这一档是不是该写一封了（= 还能写）。 */
export async function letterDue() {
  return canWrite(await bondSnapshot());
}

/** 契约名：写信。参数名沿用契约（stage 与 bond 二选一）。 */
export async function composeLetter({ config, persona = null, bond = null, stage = null, onDelta = null, signal = null } = {}) {
  return writeLetter({ config, persona, bond: bond || stage, onDelta, signal });
}
