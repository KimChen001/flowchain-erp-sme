import { extname } from 'node:path'
import yauzl from 'yauzl'
import { KnowledgeError } from './ai-knowledge-service.mjs'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_PDF_PAGES = 100
const MAX_TEXT_CHARACTERS = 100_000
// A DOCX is a ZIP package. It may hold at most this many parts and unpack to
// at most eight times the upload limit (the data import allows XLSX the same).
const MAX_DOCX_ENTRIES = 1_000
const MAX_DOCX_UNPACKED_BYTES = 8 * MAX_FILE_BYTES
const types = Object.freeze({
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.pdf': 'pdf',
  '.docx': 'docx',
})

const fail = (code, message, status = 422) => { throw new KnowledgeError(code, message, status) }

function decodeBase64(value) {
  const encoded = String(value || '').trim()
  if (!encoded || encoded.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail('KNOWLEDGE_FILE_INVALID', 'The uploaded file is invalid.')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) fail('KNOWLEDGE_FILE_SIZE_INVALID', 'The file must be between 1 byte and 5 MB.', 413)
  return bytes
}

function normalizeText(value) {
  const text = String(value || '').replaceAll('\u0000', '').replace(/\r\n?/g, '\n').trim()
  if (text.length < 20) fail('KNOWLEDGE_FILE_EMPTY', 'The file did not contain enough readable text. Scanned PDFs require OCR before import.')
  if (text.length > MAX_TEXT_CHARACTERS) fail('KNOWLEDGE_CONTENT_TOO_LONG', 'Extracted text exceeds 100,000 characters. Split the document before importing.', 413)
  return text
}

async function defaultPdfParser(bytes) {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: bytes })
  try {
    const info = await parser.getInfo()
    if (Number(info.total) > MAX_PDF_PAGES) fail('KNOWLEDGE_PDF_PAGE_LIMIT', 'PDF files are limited to 100 pages. Split the document before importing.', 413)
    return (await parser.getText()).text
  } finally { await parser.destroy() }
}

// Inflates every part of a DOCX package once before it is parsed, counting the
// bytes actually unpacked rather than trusting the sizes the package declares
// (a part larger than its declared size fails), so a small upload cannot
// expand into a huge document in memory (design audit L10-04).
export function assertDocxUnpackedWithinLimit(bytes, { maximumBytes = MAX_DOCX_UNPACKED_BYTES, maximumEntries = MAX_DOCX_ENTRIES } = {}) {
  const tooLarge = () => new KnowledgeError('KNOWLEDGE_DOCX_TOO_LARGE', `The DOCX file unpacks to more than ${Math.round(maximumBytes / 1024 / 1024)} MB. Split the document or remove large images before importing.`, 413)
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error)
      let entries = 0, declared = 0, inflated = 0, settled = false
      const fail = (failure) => {
        if (settled) return
        settled = true
        try { zip.close() } catch { /* already closed */ }
        reject(failure)
      }
      zip.on('entry', (entry) => {
        entries += 1
        declared += Number(entry.uncompressedSize || 0)
        if (entries > maximumEntries || declared > maximumBytes) return fail(tooLarge())
        if (entry.fileName.endsWith('/')) return zip.readEntry()
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError)
          stream.on('data', (chunk) => {
            inflated += chunk.length
            if (inflated > maximumBytes) { stream.destroy(); fail(tooLarge()) }
          })
          stream.on('error', fail)
          stream.on('end', () => { if (!settled) zip.readEntry() })
        })
      })
      zip.on('end', () => { if (!settled) { settled = true; resolve({ entries, inflatedBytes: inflated }) } })
      zip.on('error', fail)
      zip.readEntry()
    })
  })
}

async function defaultDocxParser(bytes) {
  await assertDocxUnpackedWithinLimit(bytes)
  const mammoth = await import('mammoth')
  return (await mammoth.extractRawText({ buffer: bytes })).value
}

export async function parseKnowledgeFile(input = {}, { parsePdf = defaultPdfParser, parseDocx = defaultDocxParser } = {}) {
  const fileName = String(input.fileName || '').trim()
  const kind = types[extname(fileName).toLowerCase()]
  if (!fileName || !kind) fail('KNOWLEDGE_FILE_TYPE_NOT_ALLOWED', 'Import a TXT, Markdown, PDF, or DOCX file.')
  const bytes = decodeBase64(input.contentBase64)
  if (kind === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('KNOWLEDGE_FILE_INVALID', 'The file does not contain a valid PDF header.')
  if (kind === 'docx' && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) fail('KNOWLEDGE_FILE_INVALID', 'The file does not contain a valid DOCX package.')
  try {
    const extracted = kind === 'text' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : kind === 'pdf' ? await parsePdf(bytes) : await parseDocx(bytes)
    return { title: String(input.title || '').trim() || fileName.replace(/\.[^.]+$/, ''), content: normalizeText(extracted), fileName, kind }
  } catch (error) {
    if (error instanceof KnowledgeError) throw error
    fail('KNOWLEDGE_FILE_PARSE_FAILED', 'The file could not be read. Check that it is not damaged or password protected.')
  }
}

export const KNOWLEDGE_FILE_LIMITS = Object.freeze({ maximumBytes: MAX_FILE_BYTES, maximumPdfPages: MAX_PDF_PAGES, maximumTextCharacters: MAX_TEXT_CHARACTERS, maximumDocxUnpackedBytes: MAX_DOCX_UNPACKED_BYTES, maximumDocxEntries: MAX_DOCX_ENTRIES })
