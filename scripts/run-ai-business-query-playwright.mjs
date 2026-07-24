import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'node_modules', 'playwright', 'cli.js')
const child = spawn(process.execPath, [cli, 'test', 'tests/browser/ai-business-query-planning.spec.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_WORKERS: '1', FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'false' },
})
child.once('exit', (code) => { process.exitCode = code ?? 1 })
