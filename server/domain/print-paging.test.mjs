import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { printBands, printPageRule } from '../../src/modules/print-layout/printPaging.ts'

// Design audit L11-17: a receive sheet was cut off after about 12 lines when
// printed (the lines table was a fixed 330 px box that clipped the rest) and
// printed "Page 1 of 1" whatever its length. In print the table now grows,
// what is below it moves down, the browser pages the sheet, and the page
// numbers come from its page counters.

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

// The built-in receive sheet's layout (printLayoutPresets.ts), as placed.
const box = (id, type, y, height, x = 52) => ({ id, type, x, y, width: 300, height, visible: true, draggable: true, resizable: true, title: id })
const sheet = [
  box('company', 'field', 42, 30), box('title', 'text', 78, 44), box('documentNo', 'field', 140, 28), box('reviewedBy', 'field', 276, 28, 442),
  box('lines', 'table', 320, 330),
  box('remarks', 'field', 672, 28), box('signatures', 'signature', 742, 58), box('footer', 'footer', 1040, 24), box('pageNumber', 'pageNumber', 1040, 24, 620),
]

test('a sheet prints in three bands around its lines table', () => {
  const bands = printBands(sheet)
  assert.deepEqual(bands.map((band) => [band.id, band.offset, band.height, band.elements.map((element) => element.id)]), [
    ['above', 0, 320, ['company', 'title', 'documentNo', 'reviewedBy']],
    ['table', 320, 330, ['lines']],
    ['below', 650, 414, ['remarks', 'signatures', 'footer', 'pageNumber']],
  ])
  // An element that starts beside the table stays with it.
  const beside = printBands([...sheet, box('note', 'comment', 400, 300, 600)])
  assert.deepEqual(beside[1].elements.map((element) => element.id), ['lines', 'note'])
  assert.equal(beside[1].height, 380)
  // Every element is in exactly one band.
  assert.deepEqual(bands.flatMap((band) => band.elements.map((element) => element.id)).sort(), sheet.map((element) => element.id).sort())
  // Without a table the sheet is one band, as on screen.
  assert.deepEqual(printBands(sheet.filter((element) => element.type !== 'table')).map((band) => [band.id, band.offset, band.height]), [['above', 0, 1064]])
})

test('the page rule numbers every printed page from the browser counters', () => {
  const portrait = { orientation: 'portrait', margin: 52 }
  const english = printPageRule(portrait, true, 'en-US')
  assert.match(english, /@page \{ size: A4 portrait; margin: 10mm 0; \}/)
  assert.match(english, /@page :first \{ margin-top: 0; \}/)
  assert.match(english, /@bottom-right \{ content: "Page " counter\(page\) " of " counter\(pages\);/)
  assert.match(printPageRule(portrait, true, 'zh-CN'), /content: "第 " counter\(page\) " 页 \/ 共 " counter\(pages\) " 页";/)
  assert.match(printPageRule({ orientation: 'landscape', margin: 52 }, true, 'en-US'), /size: A4 landscape;/)
  // A sheet without a page number gets none.
  assert.doesNotMatch(printPageRule(portrait, false, 'en-US'), /counter\(|@bottom-right/)
  const editor = read('src/modules/print-layout/PrintLayoutEditor.tsx')
  assert.match(editor, /<style>\{printPageRule\(template\.page, template\.elements\.some\(\(element\) => element\.visible && element\.type === "pageNumber"\), language\)\}<\/style>/)
})

test('no fixed page number is printed', () => {
  const canvas = read('src/modules/print-layout/PrintCanvas.tsx')
  assert.doesNotMatch(canvas, /Page 1 of 1|第 1 页 \/ 共 1 页/)
  const css = printBlock(read('src/modules/print-layout/print-layout.css'))
  // The canvas element only marks where the numbers go; in print it is hidden.
  assert.match(css, /\.print-layout-element\[data-element-type="pageNumber"\] \{ display: none !important; \}/)
  assert.match(canvas, /data-element-type=\{element\.type\}/)
})

test('in print the sheet clips nothing and the lines table pages', () => {
  const css = read('src/modules/print-layout/print-layout.css')
  const print = printBlock(css)
  // The screen keeps the canvas as it was: the bands are no boxes there.
  assert.match(css.slice(0, css.indexOf('@media print {')), /\.print-canvas-band \{ display: contents; \}/)
  assert.match(print, /\.print-canvas-sheet \{ position: relative; height: auto !important; transform: none !important; box-shadow: none; overflow: visible; \}/)
  assert.match(print, /\.print-canvas-band \{ display: block; position: relative; height: var\(--print-band-height\); \}/)
  assert.match(print, /\.print-canvas-band-table \{ height: auto; min-height: var\(--print-band-height\); \}/)
  assert.match(print, /\.print-canvas-band > \.print-layout-element\[data-element-type="table"\] \{ position: relative; height: auto !important; min-height: var\(--print-height\); overflow: visible; \}/)
  assert.match(print, /\.print-data-table thead \{ display: table-header-group; \}/)
  assert.match(print, /\.print-data-table tr \{ break-inside: avoid; \}/)
  assert.match(print, /\.print-canvas-band-below \{ break-inside: avoid; \}/)
  // Nothing in print hides overflow or fixes the sheet's height.
  assert.doesNotMatch(print, /overflow: hidden/)
  assert.doesNotMatch(print, /\.print-canvas-sheet[^{]*\{[^}]*height: \d/)
  // The editor flows from the top of the page instead of overlaying one page.
  assert.match(print, /\.print-layout-editor \{ position: static; display: block; height: auto; background: white; \}/)
  assert.doesNotMatch(print, /inset: 0/)
})
