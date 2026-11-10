import './probe.css'
import { Capacitor, registerPlugin } from '@capacitor/core'

// M1 验收探针：三件事都必须绿，才能算「工程骨架通了」。
// 结果写到 window.__m1，供 _tools\cdp_eval.js 直接断言。

const Echo = registerPlugin('Echo')

const state = {
  pluginPresent: false,
  echoOk: false,
  echoRoundTripMs: -1,
  rejectOk: false,
  rejectCode: '',
  eventOk: false,
  platform: '',
  webview: '',
  errors: [],
}

window.__m1 = state

const $ = (id) => document.getElementById(id)

function setOut(id, text, cls) {
  const el = $(id)
  el.textContent = text
  el.className = 'out' + (cls ? ' ' + cls : '')
}

async function runEcho() {
  const text = `ping-${Date.now()}`
  const t0 = performance.now()
  try {
    const r = await Echo.echo({ text })
    const ms = Math.round(performance.now() - t0)
    state.pluginPresent = true
    state.echoOk = r?.echoed === true && r?.text === text
    state.echoRoundTripMs = ms
    setOut(
      'echo-out',
      state.echoOk
        ? `OK  往返 ${ms}ms\n原样返回：${r.text}\n长度 ${r.length}，原生时间戳 ${r.nativeAt}`
        : `异常：返回值不符 ${JSON.stringify(r)}`,
      state.echoOk ? 'ok' : 'bad'
    )
  } catch (e) {
    state.errors.push(`echo: ${e?.message || e}`)
    setOut('echo-out', `失败：${e?.message || e}`, 'bad')
  }

  // reject 分支：不传 text 应当拿到 INVALID_ECHO
  try {
    await Echo.echo({})
    state.rejectOk = false
    state.errors.push('reject: 缺参数竟然 resolve 了')
  } catch (e) {
    const msg = String(e?.message || e)
    state.rejectCode = e?.code || msg
    state.rejectOk = msg.includes('INVALID_ECHO') || msg.includes('text 必填')
  }
}

function runEvent() {
  return new Promise((resolve) => {
    const requestId = `fire-${Date.now()}`
    const timer = setTimeout(() => {
      state.errors.push('event: 2s 内没收到 echoEvent')
      setOut('event-out', '失败：2 秒内没收到原生事件', 'bad')
      resolve()
    }, 2000)

    Echo.addListener('echoEvent', (payload) => {
      clearTimeout(timer)
      state.eventOk = payload?.requestId === requestId
      setOut(
        'event-out',
        state.eventOk
          ? `OK  收到 echoEvent\nrequestId=${payload.requestId}\ntick=${payload.tick}`
          : `异常：payload 不符 ${JSON.stringify(payload)}`,
        state.eventOk ? 'ok' : 'bad'
      )
      resolve()
    })

    Echo.fire({ requestId }).catch((e) => {
      clearTimeout(timer)
      state.errors.push(`fire: ${e?.message || e}`)
      setOut('event-out', `失败：${e?.message || e}`, 'bad')
      resolve()
    })
  })
}

function readEnv() {
  state.platform = Capacitor.getPlatform()
  const ua = navigator.userAgent
  const m = ua.match(/Chrome\/[\d.]+/)
  state.webview = m ? m[0] : ua
  setOut(
    'env-out',
    `platform = ${state.platform}\nwebview = ${state.webview}\norigin = ${location.origin}\nCapacitor = ${Capacitor.isNativePlatform() ? 'native' : 'web'}\nisPluginAvailable = ${Capacitor.isPluginAvailable('Echo')}`
  )
}

;(async () => {
  readEnv()
  await runEcho()
  await runEvent()
  state.done = true
  console.log('[M1]', JSON.stringify(state))
  // M2 第一批：版本信息 + 加密配置
  const { runM2Probe } = await import('./m2.js')
  await runM2Probe()
  // M2 第二批：模型 HTTP 流式 + 模型列表
  const { runM3Probe } = await import('./m3.js')
  await runM3Probe()
  // M2 第三批：系统栏外观 + 文件选择
  const { runM4Probe } = await import('./m4.js')
  await runM4Probe()
  // M2 第四批：资料包导出/导入
  const { runM5Probe } = await import('./m5.js')
  await runM5Probe()
})()
