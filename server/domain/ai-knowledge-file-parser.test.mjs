import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32, deflateRawSync } from 'node:zlib'
import { KNOWLEDGE_FILE_LIMITS, assertDocxUnpackedWithinLimit, parseKnowledgeFile } from './ai-knowledge-file-parser.mjs'

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

// A ZIP package of the given parts, deflated; a part may declare a smaller
// size than it holds, as a crafted package can.
function zipPackage(parts) {
  const locals = [], centrals = []
  let offset = 0
  for (const { name, data, declaredSize = data.length } of parts) {
    const compressed = deflateRawSync(data), nameBytes = Buffer.from(name), crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(declaredSize, 22); local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, compressed); centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }
  const centralBytes = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

// Design audit L10-04: a DOCX is unpacked and counted before it is parsed.
// A small upload that unpacks past the limit is refused before mammoth reads
// it, whether its parts declare their real size or a smaller one.
test('knowledge file parser refuses a DOCX that unpacks past the limit before parsing it', async () => {
  const limit = KNOWLEDGE_FILE_LIMITS.maximumDocxUnpackedBytes
  const huge = Buffer.alloc(limit + 1024 * 1024, 0x20)
  const honest = zipPackage([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: huge }])
  const lying = zipPackage([{ name: 'word/document.xml', data: huge, declaredSize: 4096 }])
  assert.ok(honest.length < KNOWLEDGE_FILE_LIMITS.maximumBytes && lying.length < KNOWLEDGE_FILE_LIMITS.maximumBytes)
  await assert.rejects(assertDocxUnpackedWithinLimit(honest), { code: 'KNOWLEDGE_DOCX_TOO_LARGE', status: 413 })
  await assert.rejects(parseKnowledgeFile({ fileName: 'bomb.docx', contentBase64: honest.toString('base64') }), { code: 'KNOWLEDGE_DOCX_TOO_LARGE' })
  await assert.rejects(assertDocxUnpackedWithinLimit(lying))
  await assert.rejects(parseKnowledgeFile({ fileName: 'lying.docx', contentBase64: lying.toString('base64') }), { code: 'KNOWLEDGE_FILE_PARSE_FAILED' })
  const many = zipPackage(Array.from({ length: KNOWLEDGE_FILE_LIMITS.maximumDocxEntries + 1 }, (_, index) => ({ name: `word/part-${index}.xml`, data: Buffer.from('<p/>') })))
  await assert.rejects(assertDocxUnpackedWithinLimit(many), { code: 'KNOWLEDGE_DOCX_TOO_LARGE' })
  // A normal package passes the check.
  const document = Buffer.from('<w:document>Company handbook</w:document>')
  assert.deepEqual(await assertDocxUnpackedWithinLimit(zipPackage([{ name: 'word/document.xml', data: document }])), { entries: 1, inflatedBytes: document.length })
})
