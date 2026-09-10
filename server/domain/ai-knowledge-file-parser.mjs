import { extname } from 'node:path'
import { KnowledgeError } from './ai-knowledge-service.mjs'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_PDF_PAGES = 100
const MAX_TEXT_CHARACTERS = 100_000
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

async function defaultDocxParser(bytes) {
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

export const KNOWLEDGE_FILE_LIMITS = Object.freeze({ maximumBytes: MAX_FILE_BYTES, maximumPdfPages: MAX_PDF_PAGES, maximumTextCharacters: MAX_TEXT_CHARACTERS })
