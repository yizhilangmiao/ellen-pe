// M2 第三批探针：EllenScreenShell（系统栏外观）+ EllenDocuments（文件选择）
// 只断言「契约可观测的部分」：resolve / reject 码与消息。真正选文件要人手点系统选择器，
// 这里用 cancel 把它强制收掉，验证 pending 状态机是否按旧包语义走。
import { Capacitor, registerPlugin } from '@capacitor/core'

const ScreenShell = registerPlugin('EllenScreenShell')
const Documents = registerPlugin('EllenDocuments')

const state = (window.__m4 = {
  appearanceOk: false,
  appearanceBadTheme: '',
  pickNoRequestId: '',
  pickBusy: '',
  pickCancelled: '',
  pickCancelOk: false,
  errors: [],
  done: false
})

function out(id, text, ok) {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = text
  el.className = ok === true ? 'out ok' : ok === false ? 'out bad' : 'out'
}

async function grab(fn) {
  try {
    const r = await fn()
    return { ok: true, r }
  } catch (e) {
    return { ok: false, code: e?.code || '', message: e?.message || String(e) }
  }
}

async function probeScreenShell() {
  if (!Capacitor.isPluginAvailable('EllenScreenShell')) {
    state.errors.push('EllenScreenShell 未注册')
    out('m4-appearance-out', '插件未注册', false)
    return
  }
  const bad = await grab(() => ScreenShell.setAppearance({ theme: 'sepia' }))
  state.appearanceBadTheme = bad.ok ? '(resolved)' : (bad.message || bad.code)
  out(
    'm4-appearance-out',
    `非法主题 → ${state.appearanceBadTheme}\n` + '合法主题 dark / light 各调一次',
    !bad.ok && state.appearanceBadTheme.includes('Unsupported')
  )

  const dark = await grab(() => ScreenShell.setAppearance({ theme: 'dark' }))
  const light = await grab(() => ScreenShell.setAppearance({ theme: 'light' }))
  state.appearanceOk = dark.ok && light.ok
  out(
    'm4-appearance-out',
    `非法主题 → ${state.appearanceBadTheme}\n` +
      `dark → ${dark.ok ? 'OK' : dark.code || dark.message}\n` +
      `light → ${light.ok ? 'OK' : light.code || light.message}`,
    !bad.ok && state.appearanceOk
  )
}

async function probeDocuments() {
  if (!Capacitor.isPluginAvailable('EllenDocuments')) {
    state.errors.push('EllenDocuments 未注册')
    out('m4-documents-out', '插件未注册', false)
    return
  }
  const noId = await grab(() => Documents.pickText({}))
  state.pickNoRequestId = noId.ok ? '(resolved)' : noId.code || noId.message
  out('m4-documents-out', `缺 requestId → ${state.pickNoRequestId}`, !noId.ok && noId.code === 'INVALID_REQUEST')

  // 真的拉起系统选择器，然后第二个请求撞 BUSY，最后 cancel 收掉
  const first = Documents.pickText({ requestId: 'm4-pick-a' }).then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, code: e?.code || '', message: e?.message || String(e) })
  )
  await new Promise((r) => setTimeout(r, 1200)) // 等选择器真的弹起来
  const busy = await grab(() => Documents.pickText({ requestId: 'm4-pick-b' }))
  state.pickBusy = busy.ok ? '(resolved)' : busy.code || busy.message
  const cancel = await grab(() => Documents.cancel({ requestId: 'm4-pick-a' }))
  const firstResult = await first
  state.pickCancelOk = cancel.ok
  state.pickCancelled = firstResult.ok ? '(resolved)' : firstResult.code || firstResult.message

  const allOk =
    state.pickNoRequestId === 'INVALID_REQUEST' &&
    state.pickBusy === 'DOCUMENTS_BUSY' &&
    state.pickCancelled === 'CANCELLED' &&
    state.pickCancelOk
  out(
    'm4-documents-out',
    `缺 requestId → ${state.pickNoRequestId}\n` +
      `并发第二个 → ${state.pickBusy}\n` +
      `cancel 收掉第一个 → ${state.pickCancelled}（cancel 自身 ${cancel.ok ? 'OK' : cancel.code}）`,
    allOk
  )
}

export async function runM4Probe() {
  await probeScreenShell()
  await probeDocuments()
  state.done = true
  console.log('[M4]', JSON.stringify(state))
  return state
}
