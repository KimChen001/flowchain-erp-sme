import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { contrastRatio, readableOn } from '../../src/components/ui/contrast.ts'
import { A } from '../../src/components/ui/tokens.ts'

// The accessibility basics a sweep of every page checked (11/09): text reads at
// 4.5:1, chips keep their hue at a readable shade, dialogs are real dialogs,
// fields are named by their labels and show focus.

const backgrounds = [A.white, A.gray6, A.gray5, A.bg, '#f0f6ff']

test('secondary and tertiary text read at 4.5:1 on every light background', () => {
  for (const [name, color] of [['sub', A.sub], ['gray1', A.gray1], ['gray2', A.gray2]]) {
    for (const background of name === 'gray1' ? [A.white, A.gray6] : backgrounds) {
      assert.ok(contrastRatio(color, background) >= 4.5, `${name} ${color} on ${background}: ${contrastRatio(color, background).toFixed(2)}`)
    }
  }
})

test('a status chip keeps its colour but darkens it until it reads on its tint', () => {
  for (const [color, tint] of [[A.orange, '#fff4e8'], [A.green, '#f0faf4'], [A.red, '#fff1f0'], [A.teal, '#f0f9ff'], [A.purple, '#f5f3ff']]) {
    const shown = readableOn(color, tint)
    assert.ok(contrastRatio(shown, tint) >= 4.5, `${color} on ${tint} → ${shown}`)
    // Already readable colours are left alone.
    assert.equal(readableOn(shown, tint), shown)
  }
  assert.equal(readableOn(A.blue, '#f0f6ff'), A.blue)
  // Colours that are not hex are passed through untouched.
  assert.equal(readableOn('rgb(1, 2, 3)', '#ffffff'), 'rgb(1, 2, 3)')
})

test('the shared modal, fields and inputs carry the semantics the sweep found missing', async () => {
  const ui = await readFile(new URL('../../src/components/ui/index.tsx', import.meta.url), 'utf8')
  assert.match(ui, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/)
  assert.match(ui, /useDialogFocus\(open, dialog, onClose\)/)
  assert.match(ui, /<label htmlFor=\{child \? controlId : undefined\}/)
  // The shared input style no longer removes the outline, so fields show focus.
  const inputStyle = ui.slice(ui.indexOf('export const inputStyle'), ui.indexOf('};', ui.indexOf('export const inputStyle')))
  assert.doesNotMatch(inputStyle, /outline/)
  const theme = await readFile(new URL('../../src/styles/theme.css', import.meta.url), 'utf8')
  assert.match(theme, /input:focus-visible, select:focus-visible, textarea:focus-visible \{/)
  const focus = await readFile(new URL('../../src/components/ui/useDialogFocus.ts', import.meta.url), 'utf8')
  for (const behaviour of [/event\.key === "Escape"/, /event\.key !== "Tab"/, /opener\.focus/]) assert.match(focus, behaviour)
})
