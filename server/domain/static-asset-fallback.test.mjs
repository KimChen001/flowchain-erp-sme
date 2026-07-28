import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createScmServer } from '../bootstrap/scm-server.mjs'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function request(port, method, pathname) {
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('SPA routes fall back to index while missing static assets return real 404 responses', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/flowchain_static_asset_test'
  const server = createScmServer()
  try {
    const port = await listen(server)
    for (const method of ['GET', 'HEAD']) {
      const app = await request(port, method, '/app/inventory')
      assert.equal(app.status, 200)
      assert.match(app.headers['content-type'], /^text\/html/)
      assert.equal(app.headers['cache-control'], 'no-cache')
      if (method === 'GET') assert.match(app.body, /<!doctype html>/i)
      else assert.equal(app.body, '')

      for (const asset of ['/assets/non-existent-chunk.js', '/assets/non-existent-style.css']) {
        const missing = await request(port, method, asset)
        assert.equal(missing.status, 404)
        assert.doesNotMatch(missing.headers['content-type'] || '', /^text\/html/)
        assert.doesNotMatch(missing.body, /<!doctype html>/i)
        if (method === 'HEAD') assert.equal(missing.body, '')
      }
    }
  } finally {
    await close(server)
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
  }
})
