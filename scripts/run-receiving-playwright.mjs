import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const cli = join(resolve(import.meta.dirname, '..'), 'node_modules', 'playwright', 'cli.js')
const child = spawn(process.execPath, [cli, 'test', 'tests/browser/receiving-posting-workbench.spec.ts', 'tests/browser/procurement-pr-to-po.spec.ts', 'tests/browser/procurement-desktop-receiving.spec.ts', 'tests/browser/procurement-po-workflow-conflict.spec.ts'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_RECEIVING_DB: 'true', PLAYWRIGHT_WORKERS: '1' },
})
child.once('exit', (code) => process.exit(code ?? 1))
