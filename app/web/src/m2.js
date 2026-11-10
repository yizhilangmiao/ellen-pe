import { registerPlugin } from '@capacitor/core'

// M2 第一批探针：EllenReleaseInfo + EllenSecureConfig
// 结果写进 window.__m2，供 _tools\cdp_eval.js 直接断言。

const ReleaseInfo = registerPlugin('EllenReleaseInfo')
const SecureConfig = registerPlugin('EllenSecureConfig')

const state = {
  releaseOk: false,
  release: null,
  secureWriteOk: false,
  secureReadOk: false,
  secureRoundTripOk: false,
  secureKeyCount: 0,
  secureRemoveOk: false,
  secureEmptyAfterRemove: false,
  rejectInvalidConfig: '',
  rejectOversize: '',
  rejectInvalidScope: '',
  errors: [],
}

window.__m2 = state

const $ = (id) => document.getElementById(id)

function out(id, text, ok) {
  const el = $(id)
  if (!el) return
  el.textContent = text
  el.className = 'out ' + (ok ? 'ok' : 'bad')
}

async function probeRelease() {
  try {
    const r = await ReleaseInfo.state()
    state.release = r
    state.releaseOk =
      r?.available === true &&
      typeof r?.packageName === 'string' &&
      typeof r?.version === 'string' &&
      typeof r?.versionCode === 'number' &&
      typeof r?.debuggable === 'boolean' &&
      typeof r?.minimumAndroidAPI === 'number'
    out(
      'release-out',
      (state.releaseOk ? 'OK  ' : '异常 ') +
        `appName=${r.appName}\npackageName=${r.packageName}\nversion=${r.version} (${r.versionCode})\n` +
        `channel=${r.channel} debuggable=${r.debuggable}\nandroid=${r.androidVersion} minAPI=${r.minimumAndroidAPI}`,
      state.releaseOk
    )
  } catch (e) {
    state.errors.push(`release: ${e?.message || e}`)
    out('release-out', `失败：${e?.message || e}`, false)
  }
}

async function probeSecure() {
  const marker = `m2-${Date.now()}-中文-🔐`
  try {
    await SecureConfig.write({ scope: 'model', value: marker })
    state.secureWriteOk = true
  } catch (e) {
    state.errors.push(`write: ${e?.message || e}`)
  }

  try {
    const r = await SecureConfig.read({ scope: 'model' })
    state.secureReadOk = typeof r?.value === 'string'
    state.secureRoundTripOk = r?.value === marker
    state.secureKeyCount = Object.keys(r || {}).length
    out(
      'secure-out',
      (state.secureRoundTripOk ? 'OK  ' : '异常 ') +
        `写入后读回：${r?.value}\n与写入值一致：${state.secureRoundTripOk}\n返回键：${Object.keys(r || {}).join(',')}`,
      state.secureRoundTripOk
    )
  } catch (e) {
    state.errors.push(`read: ${e?.message || e}`)
    out('secure-out', `读失败：${e?.message || e}`, false)
  }

  // 空值：旧码写进去读不回（下限 30 字节），新码应能读回
  try {
    await SecureConfig.write({ scope: 'voice', value: '' })
    const r = await SecureConfig.read({ scope: 'voice' })
    state.secureEmptyAfterRemove = r?.value === ''
    out('secure-edge-out', `空字符串往返：${r?.value === '' ? 'OK' : '异常 ' + JSON.stringify(r)}`, r?.value === '')
    await SecureConfig.remove({ scope: 'voice' })
  } catch (e) {
    state.errors.push(`empty: ${e?.message || e}`)
    out('secure-edge-out', `空值探测失败：${e?.message || e}`, false)
  }

  // 三条 reject 分支
  const grab = async (label, fn) => {
    try {
      await fn()
      return `${label}=RESOLVED(不该)`
    } catch (e) {
      return e?.message || String(e)
    }
  }
  state.rejectInvalidConfig = await grab('invalid', () => SecureConfig.write({ scope: 'model', value: null }))
  state.rejectOversize = await grab('oversize', () =>
    SecureConfig.write({ scope: 'model', value: 'x'.repeat(16001) })
  )
  state.rejectInvalidScope = await grab('scope', () => SecureConfig.read({ scope: 'nope' }))

  try {
    await SecureConfig.remove({ scope: 'model' })
    const r = await SecureConfig.read({ scope: 'model' })
    state.secureRemoveOk = true
    state.secureEmptyAfterRemove = r?.value === undefined
    out(
      'secure-remove-out',
      `删除后读回键：${Object.keys(r || {}).length === 0 ? '(空对象) OK' : JSON.stringify(r)}\n` +
        `reject 分支：\n  配置无效 → ${state.rejectInvalidConfig}\n  配置过长 → ${state.rejectOversize}\n  无效 scope → ${state.rejectInvalidScope}`,
      state.secureEmptyAfterRemove && state.rejectInvalidConfig.includes('配置无效')
    )
  } catch (e) {
    state.errors.push(`remove: ${e?.message || e}`)
    out('secure-remove-out', `删除失败：${e?.message || e}`, false)
  }
}

export async function runM2Probe() {
  await probeRelease()
  await probeSecure()
  state.done = true
  console.log('[M2]', JSON.stringify(state))
  return state
}
