import test from 'node:test'
import assert from 'node:assert/strict'
import { singleBayUnusedSideOffsets } from './channelization.ts'

test('single forward bay closes the opposite side of its left-turn lane', () => {
  assert.deepEqual(singleBayUnusedSideOffsets('forward', 1.5), {
    movingStart: 1.5,
    unusedBoundary: -1.5,
  })
})

test('single backward bay mirrors the unused-side closure', () => {
  assert.deepEqual(singleBayUnusedSideOffsets('backward', 1.5), {
    movingStart: -1.5,
    unusedBoundary: 1.5,
  })
})
