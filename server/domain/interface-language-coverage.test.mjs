import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('every Chinese route and primary-navigation label has an English display mapping', () => {
  const registry = readFileSync(new URL('../../src/app/routeRegistry.tsx', import.meta.url), 'utf8')
  const manifest = readFileSync(new URL('../../src/app/routes/route-manifest.ts', import.meta.url), 'utf8')
  const dictionary = readFileSync(new URL('../../src/i18n/workspaceCopy.ts', import.meta.url), 'utf8')
  const labels = [...`${registry}\n${manifest}`.matchAll(/(?:label|moduleLabel|navigationLabel):\s*"([^"]*[\u3400-\u9fff][^"]*)"/g)].map(match => match[1])
  const missing = [...new Set(labels)].filter(label => !dictionary.includes(`'${label}':`)).sort()
  assert.deepEqual(missing, [], `Missing English route labels: ${missing.join(', ')}`)
})
