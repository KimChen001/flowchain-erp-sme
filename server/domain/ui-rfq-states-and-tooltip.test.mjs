import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { STATUS_CHART_COLORS, STATUS_TONE_SHADES, statusToneOf } from '../../src/components/ui/statusTones.ts'

// Procurement look pass (2026-11-22), on top of #443: the RFQ participants'
// states as the status chips of every list, and the supplier performance
// definition kept inside a phone screen. Look only.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test("an RFQ participant's states are status chips in the shared tones", () => {
  // The codes are in the one shared table, by the palette's rules.
  assert.equal(statusToneOf('response_recorded'), 'success')
  assert.equal(statusToneOf('invited_internal'), 'info')
  assert.equal(statusToneOf('no_response'), 'warning')
  assert.equal(statusToneOf('declined'), 'danger')
  assert.equal(statusToneOf('planned'), 'neutral')
  assert.equal(statusToneOf('withdrawn'), 'neutral')
  assert.equal(statusToneOf('closed'), 'neutral')
  // One label, one colour: the Chinese labels the table already knew agree.
  assert.equal(statusToneOf('已拒绝'), statusToneOf('declined'))
  assert.equal(statusToneOf('已撤回'), statusToneOf('withdrawn'))
  // Each new code charts in its tone's family.
  for (const code of ['response_recorded', 'invited_internal', 'no_response', 'declined', 'planned']) {
    assert.ok(STATUS_TONE_SHADES[statusToneOf(code)].includes(STATUS_CHART_COLORS[code]), code)
  }

  const page = read('src/modules/procurement/CanonicalRfqDetailPage.tsx')
  // Both states are chips; a response state that says the same is shown once.
  assert.ok(page.includes('<ParticipantStates supplierId={supplier.supplierId} participation={statusLabel(supplier.status, PARTICIPATION_STATUS_LABELS, language)} participationCode={supplier.status} response={statusLabel(supplier.responseState, RESPONSE_STATE_LABELS, language)} responseCode={supplier.responseState} />'))
  assert.ok(page.includes('<StatusChip label={participation} tone={statusToneOf(participationCode)} />'))
  assert.ok(page.includes('{response !== participation && <StatusChip label={response} tone={statusToneOf(responseCode)} />}'))
  // The plain grey and bold lines are gone, and the page keeps no tone table.
  assert.ok(!page.includes('<div className="mt-1 font-medium">{statusLabel(supplier.responseState'))
  assert.doesNotMatch(page, /TONES\b|participantTone/)
  // The comparison page's suppliers without a response show the same chip.
  const comparison = read('src/modules/procurement/CanonicalRfqComparisonPage.tsx')
  assert.ok(comparison.includes('<div className="mt-2"><StatusChip label={localLabel(PARTICIPATION_STATUS_LABELS, participant.status || "", language, participant.statusRaw || tr("状态不可识别", "Unrecognized status"))} tone={statusToneOf(participant.status)} /></div>'))
  // Every state has its English and Chinese label.
  for (const pair of [
    'planned: ["计划参与", "Planned"]',
    'invited_internal: ["已内部邀请", "Invited internally"]',
    'response_recorded: ["已记录响应", "Response recorded"]',
    'no_response: ["暂无响应", "No response"]',
    'declined: ["已拒绝", "Declined"]',
    'withdrawn: ["已撤回", "Withdrawn"]',
    'closed: ["已关闭", "Closed"]',
  ]) assert.ok(page.includes(pair), pair)
})

test('the supplier performance definition stays inside the screen on a phone', () => {
  const panel = read('src/modules/srm/supplierPerformance.tsx')
  // Desktop is unchanged: it still opens 28rem wide below the icon.
  assert.ok(panel.includes('<span ref={panel} role="tooltip" data-testid="supplier-performance-definition" className="absolute left-0 top-7 z-20 w-[min(28rem,80vw)] '))
  // It sits inside the section heading, so its text is set back to normal
  // weight; only its own title stays bold (the 11/22 shots showed it all semibold).
  assert.ok(panel.includes('text-left text-[11px] font-normal leading-5 shadow-lg"'))
  assert.ok(panel.includes('<span className="mb-1 block font-semibold">{tr("definitionTitle")}</span>'))
  // Once open, it moves left by however much runs past the right edge, 8 px in.
  assert.ok(panel.includes('const panel = useRef<HTMLSpanElement>(null);'))
  assert.ok(panel.includes('useLayoutEffect(() => {'))
  assert.ok(panel.includes('const overflow = node.getBoundingClientRect().right - (window.innerWidth - 8);'))
  assert.ok(panel.includes('if (overflow > 0) node.style.transform = `translateX(-${Math.ceil(overflow)}px)`;'))
  assert.ok(panel.includes('}, [open]);'))
})
