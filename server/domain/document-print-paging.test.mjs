import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { documentPageRule } from '../../src/modules/business-documents/documentPaging.ts'

// A printed PO or customer invoice numbers its pages at their foot from the
// browser's page counters, "Page 2 of 3", in the language the document prints
// in, as the receive sheet does (design audit L11-17). Browsers without @page
// margin boxes print no number; none prints a fixed one.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const printBlock = (css) => {
  const start = css.indexOf('@media print {')
  let depth = 0
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth === 0) return css.slice(css.indexOf('{', start) + 1, index)
  }
  throw new Error('unclosed @media print block')
}

test('the document page rule numbers each page in the document language', () => {
  const english = documentPageRule('en-US')
  assert.match(english, /^@media print \{ @page \{ size: A4; margin: 12mm; @bottom-right \{ content: "Page " counter\(page\) " of " counter\(pages\);/)
  assert.match(documentPageRule('zh-CN'), /content: "第 " counter\(page\) " 页 \/ 共 " counter\(pages\) " 页";/)
  assert.doesNotMatch(english, /Page 1 of 1|第 1 页/)
  // The shell uses it with the document's own language, the one its sheet prints in.
  assert.match(read('src/modules/business-documents/DocumentShell.tsx'), /<style>\{`\$\{documentPageRule\(language\)\} \$\{SCREEN_SCALE_CSS\}`\}<\/style>/)
})

// Each document prints through the shell with its document language, and its
// lines table is the one the print rules page: header row on every page, no
// line split, no fixed height or clipping.
for (const [name, file, lines] of [
  ['purchase order', 'src/modules/business-documents/PurchaseOrderDocumentPage.tsx', 'po-document-lines'],
  ['customer invoice', 'src/modules/business-documents/CustomerInvoiceDocumentPage.tsx', 'invoice-document-lines'],
]) {
  test(`a printed ${name} pages its lines and numbers its pages`, () => {
    const page = read(file)
    assert.match(page, /<DocumentShell [^>]*language=\{language\} onLanguageChange=\{setLanguage\}/, name)
    assert.match(page, new RegExp(`<table className="business-document-lines" data-testid="${lines}">`), name)
    const css = printBlock(read('src/modules/business-documents/business-documents.css'))
    assert.match(css, /\.business-document-lines thead \{ display: table-header-group; \}/)
    assert.match(css, /\.business-document-lines tr, \.business-document-totals, \.business-document-signature \{ break-inside: avoid; \}/)
    assert.match(css, /\.business-document-sheet \{ width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; \}/)
    assert.doesNotMatch(css, /overflow: hidden/)
  })
}
