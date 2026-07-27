import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs'

export function parseEnvFile(source = '') {
  return Object.fromEntries(String(source).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=')
    return index < 1 ? [] : [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]
  }).filter((entry) => entry.length === 2))
}

export function localCommandPlan(argv = []) {
  const scenario = argv.includes('--scenario')
  return {
    demo: scenario || argv.includes('--demo'),
    scenario,
    setupCommands: ['db:generate', 'db:migrate:deploy', 'pilot:setup'],
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const localEnvPath = resolve(root, '.env.local')
  if (existsSync(localEnvPath)) Object.assign(process.env, parseEnvFile(readFileSync(localEnvPath, 'utf8')))
  if (!process.env.DATABASE_URL) throw new Error('Missing .env.local. Copy .env.local.example and set a local DATABASE_URL.')
  Object.assign(process.env, { FLOWCHAIN_DEV_LOCAL: 'true' })
  assertLocalDevelopment(process.env, 'dev:local')
  const { Client } = await import('pg')
  const connection = new Client({ connectionString: process.env.DATABASE_URL })
  try { await connection.connect(); await connection.query('select 1') } finally { await connection.end().catch(() => {}) }

  const generatedDir = resolve(root, '.local')
  const generatedPath = resolve(generatedDir, 'generated.env')
  mkdirSync(generatedDir, { recursive: true })
  let generated = existsSync(generatedPath) ? parseEnvFile(readFileSync(generatedPath, 'utf8')) : {}
  if (!generated.FLOWCHAIN_LOCAL_SESSION_SECRET || !generated.FLOWCHAIN_SYNC_CURSOR_SECRET) {
    generated = {
      FLOWCHAIN_LOCAL_SESSION_SECRET: randomBytes(48).toString('base64url'),
      FLOWCHAIN_SYNC_CURSOR_SECRET: randomBytes(48).toString('base64url'),
    }
    writeFileSync(generatedPath, Object.entries(generated).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
  }
  Object.assign(process.env, generated)

  const npmInvocation = (args) => {
    if (process.env.npm_execpath) return { command: process.execPath, args: [process.env.npm_execpath, ...args] }
    if (process.platform === 'win32') {
      return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd', ...args] }
    }
    return { command: 'npm', args }
  }
  const run = (script, args = [], options = {}) => new Promise((resolvePromise, reject) => {
    const invocation = npmInvocation(['run', script, ...args])
    const child = spawn(invocation.command, invocation.args, { cwd: root, env: process.env, stdio: 'inherit', ...options })
    child.once('exit', (code) => code === 0 ? resolvePromise(child) : reject(new Error(`${script} exited with code ${code}`)))
    child.once('error', reject)
  })
  const plan = localCommandPlan(process.argv.slice(2))
  for (const command of plan.setupCommands) await run(command)
  if (plan.demo) await run('pilot:setup:demo')
  if (plan.scenario) await run('pilot:setup:scenario')

  const children = new Set()
  let shuttingDown = false
  const stop = (code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    for (const child of children) child.kill('SIGTERM')
    setTimeout(() => process.exit(code), 1500).unref()
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0))
  process.on('uncaughtException', (error) => { console.error(error); stop(1) })
  process.on('unhandledRejection', (error) => { console.error(error); stop(1) })

  const launch = (script, extra = []) => {
    const invocation = npmInvocation(['run', script, ...extra])
    const child = spawn(invocation.command, invocation.args, { cwd: root, env: process.env, stdio: 'inherit' })
    children.add(child)
    child.once('exit', (code) => { children.delete(child); if (!shuttingDown) stop(code || 1) })
    return child
  }
  const apiPort = Number(process.env.SCM_API_PORT || 8787)
  const frontendPort = Number(process.env.VITE_PORT || 5173)
  launch('dev:api')
  const health = `http://127.0.0.1:${apiPort}/api/health`
  let ready = false
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(health)).ok) { ready = true; break } } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  if (!ready) throw new Error(`API health check failed: ${health}`)
  launch('dev', ['--', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'])
  console.log(`Local API: ${health.replace('/api/health', '')}`)
  console.log(`Local frontend: http://127.0.0.1:${frontendPort}`)
  console.log('Local login: admin@flowchain.local or kim@example.com')
}
