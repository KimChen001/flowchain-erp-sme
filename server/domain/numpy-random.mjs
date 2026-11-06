// numpy's default random generator, np.random.default_rng(seed), for the one
// draw the replenishment solver needs: integers(0, high, size). Ported so the
// solver draws exactly the demand scenarios of the Python prototype it
// reproduces (research note v5, appendix A: saa.py), which lets one study run
// the same instances in Python and in FlowChain. Pure; no state outside the
// generator object.
//
//   SeedSequence  numpy/random/bit_generator.pyx (hashmix, mix, pool of 4
//                 32-bit words, generate_state)
//   PCG64         numpy/random/src/pcg64 (XSL-RR 128/64; next_uint32 returns
//                 the low half of a 64-bit draw, then the high half)
//   integers      random_bounded_uint64_fill with Lemire's rejection method on
//                 32-bit draws (ranges below 2^32), as Generator.integers does

const INIT_A = 0x43b0d7e5
const MULT_A = 0x931e8875
const INIT_B = 0x8b51f9dd
const MULT_B = 0x58f38ded
const MIX_MULT_L = 0xca01f9dd
const MIX_MULT_R = 0x4973f715
const POOL_SIZE = 4

const u32 = (value) => value >>> 0
const mul32 = (a, b) => u32(Math.imul(a, b))

function seedWords(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('The seed must be a non-negative whole number.')
  const words = []
  let rest = BigInt(seed)
  do {
    words.push(Number(rest & 0xffffffffn))
    rest >>= 32n
  } while (rest > 0n)
  return words
}

// SeedSequence(seed).generate_state(4, np.uint64)
export function seedSequenceState(seed, words64 = 4) {
  const entropy = seedWords(seed)
  const hash = { value: INIT_A }
  const hashmix = (value) => {
    let out = u32(value ^ hash.value)
    hash.value = mul32(hash.value, MULT_A)
    out = mul32(out, hash.value)
    return u32(out ^ (out >>> 16))
  }
  const mix = (x, y) => {
    const out = u32(Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y))
    return u32(out ^ (out >>> 16))
  }
  const pool = Array.from({ length: POOL_SIZE }, (_, index) => hashmix(index < entropy.length ? entropy[index] : 0))
  for (let source = 0; source < POOL_SIZE; source += 1) {
    for (let target = 0; target < POOL_SIZE; target += 1) {
      if (source !== target) pool[target] = mix(pool[target], hashmix(pool[source]))
    }
  }
  for (let source = POOL_SIZE; source < entropy.length; source += 1) {
    for (let target = 0; target < POOL_SIZE; target += 1) pool[target] = mix(pool[target], hashmix(entropy[source]))
  }
  let constant = INIT_B
  const state32 = []
  for (let index = 0; index < words64 * 2; index += 1) {
    let value = u32(pool[index % POOL_SIZE] ^ constant)
    constant = mul32(constant, MULT_B)
    value = mul32(value, constant)
    state32.push(u32(value ^ (value >>> 16)))
  }
  return Array.from({ length: words64 }, (_, index) => BigInt(state32[2 * index]) | (BigInt(state32[2 * index + 1]) << 32n))
}

const MASK64 = (1n << 64n) - 1n
const MASK128 = (1n << 128n) - 1n
const PCG_MULTIPLIER = (2549297995355413924n << 64n) + 4865540595714422341n

// np.random.default_rng(seed): integers(high, count) draws count whole
// numbers in [0, high), in numpy's order.
export function numpyDefaultRng(seed) {
  const [s0, s1, i0, i1] = seedSequenceState(seed)
  const increment = ((((i0 << 64n) | i1) << 1n) | 1n) & MASK128
  let state = 0n
  const step = () => { state = (state * PCG_MULTIPLIER + increment) & MASK128 }
  step()
  state = (state + ((s0 << 64n) | s1)) & MASK128
  step()
  let buffered = null
  const next64 = () => {
    step()
    const folded = ((state >> 64n) ^ state) & MASK64
    const rotation = state >> 122n
    return ((folded >> rotation) | (folded << ((64n - rotation) & 63n))) & MASK64
  }
  const next32 = () => {
    if (buffered !== null) {
      const value = buffered
      buffered = null
      return value
    }
    const value = next64()
    buffered = Number(value >> 32n)
    return Number(value & 0xffffffffn)
  }
  return {
    integers(high, count) {
      if (!Number.isInteger(high) || high < 1 || high > 0xffffffff) throw new Error('high must be a whole number from 1 to 2^32 - 1.')
      const out = new Array(count)
      const range = high - 1
      if (range === 0) return out.fill(0)
      const exclusive = BigInt(high)
      const threshold = BigInt((0xffffffff - range) % high)
      for (let index = 0; index < count; index += 1) {
        let product = BigInt(next32()) * exclusive
        let leftover = product & 0xffffffffn
        if (leftover < exclusive) {
          while (leftover < threshold) {
            product = BigInt(next32()) * exclusive
            leftover = product & 0xffffffffn
          }
        }
        out[index] = Number(product >> 32n)
      }
      return out
    },
  }
}
