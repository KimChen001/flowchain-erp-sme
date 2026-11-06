import { parentPort, workerData } from 'node:worker_threads'
import { runHighsModel } from './replenishment-solver-highs.mjs'

// One replenishment MILP solve in its own thread (replenishment-solver.mjs).
try {
  parentPort.postMessage({ ok: true, result: await runHighsModel(workerData.model, workerData.options) })
} catch (error) {
  parentPort.postMessage({ ok: false, message: String(error?.message || error) })
}
