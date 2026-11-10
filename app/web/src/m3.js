import { registerPlugin } from '@capacitor/core'

// M2 第二批探针：EllenModelHttp（流式 open/read/cancel）+ EllenModelCatalogHttp（一次性 GET）
// 结果写进 window.__m3，供 _tools\cdp_eval.js 直接断言。

const ModelHttp = registerPlugin('EllenModelHttp')
const CatalogHttp = registerPlugin('EllenModelCatalogHttp')

const ARK_CHAT = 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions'

const state = {
  badUrl: '',
  badKey: '',
  readUnknown: '',
  cancelUnknown: '',
  cancelCancel: false,
  openStatus: null,
  contentType: '',
  firstSequence: null,
  streamedChunks: 0,
  streamedBytes: 0,
  streamDone: false,
  streamErrorCode: '',
  catalogStatus: null,
  catalogBodyLen: 0,
  catalogBusy: '',
  catalogBadUrl: '',
  errors: [],
  done: false,
}

window.__m3 = state

const $ = (id) => document.getElementById(id)

function out(id, text, ok) {
  const el = $(id)
  if (!el) return
  el.textContent = text
  el.className = 'out ' + (ok ? 'ok' : 'bad')
}

const codeOf = (e) => {
  // Capacitor 把原生 code 放 e.code；兜底看 message
  const m = /^([A-Z][A-Z0-9_]{2,})$/.exec(String(e?.message || ''))
  return e?.code || (m ? m[1] : '')
}

async function grab(fn) {
  try {
    const r = await fn()
    return { ok: true, r }
  } catch (e) {
    return { ok: false, code: codeOf(e), message: String(e?.message || e) }
  }
}

async function probeTransportEdges() {
  // 1) 白名单外的 url → INVALID_MODEL_HTTP_REQUEST
  const a = await grab(() =>
    ModelHttp.open({
      requestId: `m3-badurl-${Date.now()}`,
      url: 'https://example.com/api/plan/v3/chat/completions',
      apiKey: 'probe-key',
      body: '{}',
    })
  )
  state.badUrl = a.code || a.message
  out('m3-badurl-out', `异常 url → ${state.badUrl}`, !a.ok && a.code === 'INVALID_MODEL_HTTP_REQUEST')

  // 2) apiKey 含空格/中文 → INVALID_MODEL_HTTP_REQUEST
  const b = await grab(() =>
    ModelHttp.open({ requestId: `m3-badkey-${Date.now()}`, url: ARK_CHAT, apiKey: '中文 key', body: '{}' })
  )
  state.badKey = b.code || b.message
  out('m3-badkey-out', `异常 apiKey → ${state.badKey}`, !b.ok && b.code === 'INVALID_MODEL_HTTP_REQUEST')

  // 3) read 未知 requestId → CANCELLED
  const c = await grab(() => ModelHttp.read({ requestId: 'm3-not-exist', sequence: 1 }))
  state.readUnknown = c.code || c.message
  out('m3-readunknown-out', `read 未知 id → ${state.readUnknown}`, !c.ok && c.code === 'CANCELLED')

  // 4) cancel 未知 requestId → resolve { cancelled:true }
  const d = await grab(() => ModelHttp.cancel({ requestId: 'm3-not-exist-2' }))
  state.cancelCancel = d.ok && d.r?.cancelled === true
  out('m3-cancel-out', `cancel 未知 id → ${JSON.stringify(d.r || d.message)}`, state.cancelCancel)

  // 5) sequence 不连续 → INVALID_MODEL_HTTP_REQUEST（先 open 一个真实请求占住，用错序号 read）
  const rid = `m3-seq-${Date.now()}`
  const opened = await grab(() =>
    ModelHttp.open({ requestId: rid, url: ARK_CHAT, apiKey: 'probe-invalid-key', body: '{"model":"probe","messages":[]}' })
  )
  if (opened.ok) {
    state.openStatus = opened.r?.status ?? null
    state.contentType = opened.r?.contentType ?? ''
    out(
      'm3-open-out',
      `open 完成：status=${state.openStatus}\ncontentType=${state.contentType}`,
      typeof state.openStatus === 'number'
    )
    const wrong = await grab(() => ModelHttp.read({ requestId: rid, sequence: 5 }))
    out('m3-seq-out', `错序号 read → ${wrong.code || wrong.message}`, !wrong.ok && wrong.code === 'INVALID_MODEL_HTTP_REQUEST')

    // 按 n+1 一路读到 done
    let seq = 0
    const deadline = Date.now() + 20000
    while (!state.streamDone && Date.now() < deadline) {
      const step = await grab(() => ModelHttp.read({ requestId: rid, sequence: seq + 1 }))
      if (!step.ok) {
        state.streamErrorCode = step.code || step.message
        break
      }
      if (state.firstSequence === null) state.firstSequence = step.r?.sequence ?? null
      seq = step.r?.sequence ?? seq + 1
      if (step.r?.done) {
        state.streamDone = true
        break
      }
      if (typeof step.r?.data === 'string') {
        state.streamedChunks += 1
        state.streamedBytes += atob(step.r.data).length
      }
      await new Promise((r) => setTimeout(r, 8))
    }
    await ModelHttp.cancel({ requestId: rid }).catch(() => {})
    out(
      'm3-stream-out',
      `首个 sequence=${state.firstSequence}\nchunks=${state.streamedChunks} bytes=${state.streamedBytes} done=${state.streamDone}\n` +
        `errorCode=${state.streamErrorCode || '(无)'}`,
      state.firstSequence === 1 && state.streamDone && !state.streamErrorCode
    )
  } else {
    state.errors.push(`open: ${opened.code || opened.message}`)
    out('m3-open-out', `open 失败：${opened.code || opened.message}`, false)
  }
}

async function probeCatalog() {
  // 参数无效（非 https）
  const bad = await grab(() =>
    CatalogHttp.request({ requestId: `m3-cat-bad-${Date.now()}`, apiKey: 'probe-key', url: 'http://example.com/api/v3/models' })
  )
  state.catalogBadUrl = bad.code || bad.message
  out('m3-cat-bad-out', `http url → ${state.catalogBadUrl}`, !bad.ok && bad.code === 'INVALID_MODEL_CATALOG_REQUEST')

  const rid = `m3-cat-${Date.now()}`
  const busy = await grab(() => CatalogHttp.request({ requestId: rid, apiKey: 'probe-invalid-key', url: 'https://ark.cn-beijing.volces.com/api/v3/models' }))
  if (busy.ok) {
    state.catalogStatus = busy.r?.status ?? null
    state.catalogBodyLen = typeof busy.r?.body === 'string' ? busy.r.body.length : -1
    out(
      'm3-cat-out',
      `status=${state.catalogStatus}\nbodyLen=${state.catalogBodyLen}\ncontentType=${busy.r?.contentType}`,
      typeof state.catalogStatus === 'number'
    )
  } else {
    state.errors.push(`catalog: ${busy.code || busy.message}`)
    out('m3-cat-out', `请求失败：${busy.code || busy.message}`, false)
  }

  // 两个并发 → 第二个 MODEL_HTTP_BUSY（第一个已在上一行完成，这里再开一个占位）
  const p1 = CatalogHttp.request({ requestId: `m3-cat-a-${Date.now()}`, apiKey: 'probe-invalid-key', url: 'https://ark.cn-beijing.volces.com/api/v3/models' }).catch((e) => e)
  const second = await grab(() => CatalogHttp.request({ requestId: `m3-cat-b-${Date.now()}`, apiKey: 'probe-invalid-key', url: 'https://ark.cn-beijing.volces.com/api/v3/models' }))
  state.catalogBusy = second.code || second.message
  out('m3-cat-busy-out', `并发第二个 → ${state.catalogBusy}`, !second.ok && second.code === 'MODEL_HTTP_BUSY')
  await p1
}

// 中途 abort：open 还没读完就 cancel，旧产物靠这个实现 AbortSignal
async function probeAbort() {
  const requestId = `m3-abort-${Date.now()}`
  const opening = ModelHttp.open({
    requestId,
    url: ARK_CHAT,
    apiKey: 'probe-invalid-key',
    body: '{"model":"probe","messages":[]}'
  }).then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, code: e?.code || '', message: e?.message || String(e) })
  )
  const cancelled = await grab(() => ModelHttp.cancel({ requestId }))
  const opened = await opening
  state.abortCancel = cancelled.ok && cancelled.r?.cancelled === true
  state.abortOpenCode = opened.ok ? '(resolved)' : opened.code
  out(
    'm3-abort-out',
    `cancel 立即返回 → ${JSON.stringify(cancelled.r || cancelled.message)}\nopen 结果 → ${state.abortOpenCode}`,
    state.abortCancel && state.abortOpenCode === 'CANCELLED'
  )
}

export async function runM3Probe() {
  await probeTransportEdges()
  await probeAbort()
  await probeCatalog()
  state.done = true
  console.log('[M3]', JSON.stringify(state))
  return state
}
