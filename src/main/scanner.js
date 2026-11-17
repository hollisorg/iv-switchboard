// Drives scan passes on the worker: one every minute, plus "Scan now". Never two at once; a request
// that arrives during a pass runs once that pass ends. Problems go to switchboard.log with the file
// and byte offset only.
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

export function startScanner({ paths, onSnapshot, onError = () => {}, intervalMs = 60000 }) {
  const worker = new Worker(path.join(__dirname, 'scan-worker.js'), { workerData: { paths } })
  const logFile = path.join(paths.dataDir, 'switchboard.log')
  let busy = false
  let again = false
  let stopped = false

  const log = (line) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // the log is a convenience; never let it stop a scan
    }
  }

  const scanNow = () => {
    if (stopped) return
    if (busy) {
      again = true
      return
    }
    busy = true
    worker.postMessage({ type: 'scan' })
  }

  worker.on('message', (m) => {
    busy = false
    if (m.type === 'snapshot') {
      for (const p of m.problems) log(`${p.source} ${p.file}${p.offset === null ? '' : ` at byte ${p.offset}`}: ${p.message}`)
      if (m.filesRead) log(`scan read ${m.filesRead} file(s) in ${m.ms} ms`)
      onSnapshot(m.snapshot)
    } else if (m.type === 'error') {
      log(`scan failed: ${m.message}`)
      onError(m.message)
    }
    if (again) {
      again = false
      scanNow()
    }
  })
  worker.on('error', (e) => {
    busy = false
    log(`scan worker stopped: ${e.message}`)
    onError(e.message)
  })

  const timer = setInterval(scanNow, intervalMs)
  scanNow()

  return {
    scanNow,
    stop() {
      stopped = true
      clearInterval(timer)
      worker.postMessage({ type: 'stop' })
    }
  }
}
