// Runs scan passes on a worker thread so the first full read of large transcripts never freezes the
// tray. The main process sends { type: 'scan' } and gets back { type: 'snapshot', ... }.
import { parentPort, workerData } from 'node:worker_threads'
import { openStore } from '../core/store.js'
import { scanOnce } from '../core/scan.js'

const { paths } = workerData
let store = null

parentPort.on('message', (message) => {
  if (message?.type === 'stop') {
    if (store) store.close()
    parentPort.close()
    return
  }
  if (message?.type !== 'scan') return
  const started = Date.now()
  try {
    if (!store) store = openStore(paths.dataDir)
    const r = scanOnce({ paths, store })
    parentPort.postMessage({ type: 'snapshot', snapshot: r.snapshot, filesRead: r.filesRead, problems: r.problems, ms: Date.now() - started })
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e.message, ms: Date.now() - started })
  }
})
