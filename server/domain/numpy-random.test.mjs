import test from 'node:test'
import assert from 'node:assert/strict'
import { numpyDefaultRng, seedSequenceState } from './numpy-random.mjs'

// Values printed by numpy 2.5.3 on 2026-11-06:
//   np.random.SeedSequence(seed).generate_state(4, np.uint64)
//   np.random.default_rng(seed).integers(0, high, size=count)
test('the seed sequence gives numpy\'s PCG64 state', () => {
  assert.deepEqual(seedSequenceState(7), [16920295385781661272n, 610735763742393210n, 7078124019849193311n, 12917519645081627820n])
})

test('integers(0, high) draws what numpy\'s default_rng draws, in its order', () => {
  assert.deepEqual(numpyDefaultRng(7).integers(90, 6), [85, 56, 61, 80, 52, 69])
  assert.deepEqual(numpyDefaultRng(1007).integers(90, 9), [4, 6, 64, 73, 58, 57, 7, 17, 38])
  assert.deepEqual(numpyDefaultRng(123456789012).integers(1000, 5), [952, 566, 675, 83, 175])
  assert.deepEqual(numpyDefaultRng(0).integers(3, 8), [2, 1, 1, 0, 0, 0, 0, 0])
  // A seed of more than 32 bits and a range near 2^32 (Lemire's rejection path).
  assert.deepEqual(numpyDefaultRng(2 ** 40 + 5).integers(4000000000, 4), [56636313, 18957837, 1799881717, 1490338329])
  // The prototype's held-out draws: 20,000 scenarios x 3 blocks.
  const many = numpyDefaultRng(1007).integers(90, 60000)
  assert.equal(many.reduce((sum, value) => sum + value, 0), 2672622)
  assert.deepEqual(many.slice(-3), [17, 27, 2])
})

test('the generator refuses seeds and ranges numpy would not take this way', () => {
  assert.throws(() => numpyDefaultRng(-1), /seed/)
  assert.throws(() => numpyDefaultRng(1).integers(0, 1), /high/)
  assert.deepEqual(numpyDefaultRng(1).integers(1, 3), [0, 0, 0])
})
