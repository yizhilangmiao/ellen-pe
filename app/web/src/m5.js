import { registerPlugin } from '@capacitor/core'

const Archive = registerPlugin('EllenArchive')

const sha256Hex = async (bytes) => {
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const toBase64 = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

const makeEntry = async (id, mime, bytes) => ({
  id,
  mimeType: mime,
  sizeBytes: bytes.length,
  sha256: await sha256Hex(bytes),
})

const buildManifest = (files) =>
  JSON.stringify({ format: 'ellen-companion-archive', version: 1, package: { app: 'cn.ellen.companion2', at: Date.now() }, files })

export async function runM5Probe() {
  const state = (window.__m5 = { errors: [], done: false })
  const mark = (el, ok, text) => {
    if (el) {
      el.textContent = `${ok ? 'out ok' : 'out bad'} ${text}`
      el.style.color = ok ? '#1b7f4b' : '#b42318'
    }
  }
  const guard = async (key, fn) => {
    try {
      return await fn()
    } catch (e) {
      state[key] = `EXC ${e?.code || ''} ${e?.message || e}`
      state.errors.push(`${key}: ${e?.message || e}`)
      return null
    }
  }

  // ---- 1) 坏 manifest ----
  await guard('badManifest', async () => {
    try {
      await Archive.createExport({ manifestText: 'not json' })
      state.badManifest = 'UNEXPECTED_OK'
    } catch (e) {
      state.badManifest = e.code || e.message
    }
    mark(document.getElementById('m5-bad-out'), state.badManifest === 'INVALID_ARCHIVE', state.badManifest)
  })

  // ---- 2) 正常导出 + 分块写入 ----
  const fileA = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff)
  const fileB = new Uint8Array(37).map((_, i) => (i * 13) & 0xff)
  const entryA = await makeEntry('media-0', 'image/png', fileA)
  const entryB = await makeEntry('media-1', 'audio/mpeg', fileB)

  await guard('createOk', async () => {
    const r = await Archive.createExport({
      name: '探针资料.ellenpack',
      manifestText: buildManifest([entryA, entryB]),
    })
    state.createHandle = r.handle
    state.createOk = typeof r.handle === 'string' && r.handle.startsWith('archive:')
    mark(document.getElementById('m5-create-out'), state.createOk, `${r.handle} name=${r.name}`)
  })

  await guard('writeBad', async () => {
    try {
      await Archive.writeExport({
        handle: state.createHandle,
        id: entryA.id,
        offset: 5,
        base64: toBase64(fileA.slice(0, 100)),
      })
      state.writeBad = 'UNEXPECTED_OK'
    } catch (e) {
      state.writeBad = e.code || e.message
    }
    mark(document.getElementById('m5-writebad-out'), state.writeBad === 'INVALID_ARCHIVE_CHUNK', state.writeBad)
  })

  await guard('writeOk', async () => {
    let sent = 0
    let lastOffset = -1
    while (sent < fileA.length) {
      const chunk = fileA.slice(sent, sent + 4096)
      const r = await Archive.writeExport({
        handle: state.createHandle,
        id: entryA.id,
        offset: sent,
        base64: toBase64(chunk),
      })
      sent += chunk.length
      lastOffset = r.offset
    }
    state.offsetAfterA = lastOffset
    const r2 = await Archive.writeExport({
      handle: state.createHandle,
      id: entryB.id,
      offset: 0,
      base64: toBase64(fileB),
    })
    state.offsetAfterB = r2.offset
    state.writeOk = lastOffset === 0 && r2.offset === 0
    mark(document.getElementById('m5-write-out'), state.writeOk, `A归零=${lastOffset} B归零=${r2.offset}`)
  })

  await guard('incomplete', async () => {
    // 先关掉上面那个已写完的会话（否则 ARCHIVE_BUSY），再验证「没写完不许保存」
    await Archive.discard({ handle: state.createHandle }).catch(() => {})
    const half = await makeEntry('media-half', 'image/jpeg', fileA)
    const r = await Archive.createExport({ name: '半截.ellenpack', manifestText: buildManifest([half]) })
    try {
      await Archive.saveExport({ handle: r.handle })
      state.incomplete = 'UNEXPECTED_OK'
    } catch (e) {
      state.incomplete = e.code || e.message
    }
    await Archive.discard({ handle: r.handle }).catch(() => {})
    mark(document.getElementById('m5-incomplete-out'), state.incomplete === 'ARCHIVE_INCOMPLETE', state.incomplete)
  })

  await guard('readImport', async () => {
    try {
      await Archive.readImport({ handle: 'archive:bogus', id: 'media-0', offset: 0, length: 16 })
      state.readImport = 'UNEXPECTED_OK'
    } catch (e) {
      state.readImport = e.code || e.message
    }
    mark(document.getElementById('m5-read-out'), state.readImport === 'ARCHIVE_HANDLE_INVALID', state.readImport)
  })

  await guard('backup', async () => {
    try {
      await Archive.backupCall({ method: 'describe' })
      state.backup = 'UNEXPECTED_OK'
    } catch (e) {
      state.backup = e.code || e.message
    }
    mark(document.getElementById('m5-backup-out'), state.backup === 'BACKUP_UNAVAILABLE', state.backup)
  })

  await guard('discardOk', async () => {
    const r = await Archive.discard({ handle: state.createHandle })
    const b = await Archive.background({})
    state.discarded = r.discarded
    state.pickerIdle = b.picker === false
    state.discardOk = r.discarded === true && b.picker === false
    mark(document.getElementById('m5-discard-out'), state.discardOk, `discarded=${r.discarded} picker=${b.picker}`)
  })

  state.done = true
}
