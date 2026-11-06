// HiGHS (highs-js 1.15.4, MIT: the HiGHS solver compiled to WebAssembly; no
// native add-on, no network) for the replenishment solver. Server side only:
// nothing under src/ imports it. Loaded on the first solve, so nothing else
// pays for it. runHighsModel runs in the thread that calls it; the solver
// calls it inside a worker thread (replenishment-solver-worker.mjs), so a long
// solve never holds up the server's other requests.

let loader = null
export async function loadHighs() {
  if (!loader) {
    loader = import('highs').then((module) => (module.default || module)()).catch((error) => {
      loader = null
      throw error
    })
  }
  return loader
}

// model: { numCols, numRows, colCost, colLower, colUpper, rowLower, rowUpper,
// matrix (CSR), integrality } of a minimisation; keep: how many leading
// columns to return. Returns the status by name, the leading columns, the
// objective, the MIP gap and dual bound, and the node count.
export async function runHighsModel(model, { gap = 0, timeLimitSeconds = 30, keep = model.numCols } = {}) {
  const highs = await loadHighs()
  return highs.withModel({ ...model, sense: highs.constants.objectiveSense.minimize }, (solver) => {
    solver.options.set({ output_flag: false, mip_rel_gap: gap, time_limit: timeLimitSeconds, random_seed: 0 })
    solver.run()
    const status = solver.getModelStatus()
    const codes = highs.constants.modelStatus
    const name = Object.keys(codes).find((key) => codes[key] === status) || String(status)
    const info = (key) => {
      try {
        const value = solver.info.get(key)
        return typeof value === 'bigint' ? Number(value) : value
      } catch {
        return null
      }
    }
    const hasSolution = info('primal_solution_status') === 2
    const solution = hasSolution ? solver.getSolution() : null
    return {
      name,
      optimal: status === codes.optimal,
      infeasible: status === codes.infeasible,
      objective: solution ? solver.getObjectiveValue() : null,
      columns: solution?.colValue ? Array.from(solution.colValue.slice(0, keep)) : null,
      mipGap: info('mip_gap'),
      dualBound: info('mip_dual_bound'),
      nodes: info('mip_node_count'),
    }
  })
}
