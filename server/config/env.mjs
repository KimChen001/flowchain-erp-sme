import { readFile } from 'node:fs/promises'
import path from 'node:path'

export async function loadEnv(root) {
  const names = ['.env.local', '.env']
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    try {
      const raw = await readFile(path.join(root, name), 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim().replace(/^\uFEFF/, '')
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (!process.env[key]) process.env[key] = value
      }
    } catch {
      // Local env files are optional.
    }
    if (index === 1 && process.env.FLOWCHAIN_DEV_LOCAL === 'true') names.push('.local/ai-provider.env', '.local/openai.env')
  }
}
