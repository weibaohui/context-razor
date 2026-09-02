// Client-plane contract tests: loaded under plain Node with the primitives
// require shimmed away (same approach as skills-management ui.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../client/index.js')
const { NS, ZH, EN, overThreshold, sortEntries } = plugin.__internals

test('client module declares slots + locale injects', () => {
  assert.equal(plugin.name, '@weibaohui/context-razor')
  assert.deepEqual(plugin.inject.sort(), ['locale', 'slots'])
})

test('locale dictionaries are zh/en with identical key sets', () => {
  const zhKeys = Object.keys(ZH).sort()
  const enKeys = Object.keys(EN).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length >= 30)
})

test('overThreshold marks only entries above a positive threshold', () => {
  assert.equal(overThreshold({ tokens: 501 }, 500), true)
  assert.equal(overThreshold({ tokens: 500 }, 500), false)
  assert.equal(overThreshold({ tokens: 9999 }, 0), false)
  assert.equal(overThreshold({}, 500), false)
})

test('sortEntries orders by tokens desc with ties by seq, order mode untouched', () => {
  const rows = [
    { seq: 1, tokens: 3 },
    { seq: 2, tokens: 9 },
    { seq: 3, tokens: 3 },
    { seq: 4 },
  ]
  assert.deepEqual(sortEntries(rows, 'tokens').map(r => r.seq), [2, 1, 3, 4])
  assert.deepEqual(sortEntries(rows, 'order').map(r => r.seq), [1, 2, 3, 4])
  // 不改变原数组
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4])
})

test('tierOf maps token counts onto the rainbow tiers', () => {
  const { tierOf } = plugin.__internals
  assert.equal(tierOf({ tokens: 29 }), 0)    // 绿
  assert.equal(tierOf({ tokens: 85 }), 0)
  assert.equal(tierOf({ tokens: 201 }), 1)   // 黄绿
  assert.equal(tierOf({ tokens: 800 }), 2)   // 黄
  assert.equal(tierOf({ tokens: 1200 }), 3)  // 橙
  assert.equal(tierOf({ tokens: 2222 }), 4)  // 红
  assert.equal(tierOf({ tokens: 8568 }), 5)  // 品红
  assert.equal(tierOf({}), 0)
})
