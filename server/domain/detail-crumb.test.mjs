import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Walkthrough 2026-10-07: receipt, bill, sales order, shipment and invoice
// pages showed their UUID as the breadcrumb, and timelines showed USR-… ids.
test('the breadcrumb treats stored ids as ids and document numbers as names', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowchain-crumb-'))
  try {
    const outfile = path.join(dir, 'detailCrumb.mjs')
    await build({ entryPoints: ['src/components/navigation/detailCrumb.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { looksLikeStoredId } = await import(pathToFileURL(outfile).href)
    for (const id of ['3adaf3ca-8163-43ef-a5fc-b425b533b60f', 'USR-3350F6F7-8359-4E1B-A549-5D7EBC557B4A', 'WH-e48e0d48-4d00-4703-9da0-2e56c9820f8c', 'ITEM-2ed8132a-3bc8-4874-8632-137147bbdf3d']) {
      assert.equal(looksLikeStoredId(id), true, id)
    }
    for (const name of ['PO-42AA497A', 'PR-95637816', 'GRN-1791349130272', 'AV-5512', 'LOCAL-DEMO-GRN-001', 'VALVE-100', 'new', '']) {
      assert.equal(looksLikeStoredId(name), false, name)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
