import test from 'node:test'
import assert from 'node:assert/strict'
import { parseKnowledgeFile } from './ai-knowledge-file-parser.mjs'

const encoded = value => Buffer.from(value).toString('base64')

test('knowledge file parser accepts UTF-8 text and derives a title', async () => {
  const result = await parseKnowledgeFile({ fileName: 'motor-guide.md', contentBase64: encoded('# Motor\nInspect the bearing every six months.') })
  assert.equal(result.title, 'motor-guide')
  assert.match(result.content, /six months/)
})

test('knowledge file parser validates signatures and normalizes extracted documents', async () => {
  await assert.rejects(parseKnowledgeFile({ fileName: 'invalid.pdf', contentBase64: encoded('invalid PDF document with enough text') }), { code: 'KNOWLEDGE_FILE_INVALID' })
  const pdf = await parseKnowledgeFile({ fileName: 'guide.pdf', title: 'Product guide', contentBase64: encoded('%PDF-placeholder') }, { parsePdf: async () => 'First line\r\nSecond product specification line.' })
  assert.equal(pdf.title, 'Product guide')
  assert.equal(pdf.content, 'First line\nSecond product specification line.')
  const docx = await parseKnowledgeFile({ fileName: 'handbook.docx', contentBase64: Buffer.from([0x50, 0x4b, ...Buffer.from('placeholder')]).toString('base64') }, { parseDocx: async () => 'Company handbook content for workspace members.' })
  assert.match(docx.content, /Company handbook/)
})

test('knowledge file parser rejects unsupported and unreadable documents', async () => {
  await assert.rejects(parseKnowledgeFile({ fileName: 'guide.exe', contentBase64: encoded('unsupported content') }), { code: 'KNOWLEDGE_FILE_TYPE_NOT_ALLOWED' })
  await assert.rejects(parseKnowledgeFile({ fileName: 'guide.txt', contentBase64: encoded('short') }), { code: 'KNOWLEDGE_FILE_EMPTY' })
  await assert.rejects(parseKnowledgeFile({ fileName: 'guide.docx', contentBase64: Buffer.from([0x50, 0x4b, ...Buffer.from('placeholder')]).toString('base64') }, { parseDocx: async () => { throw new Error('damaged') } }), { code: 'KNOWLEDGE_FILE_PARSE_FAILED' })
})
