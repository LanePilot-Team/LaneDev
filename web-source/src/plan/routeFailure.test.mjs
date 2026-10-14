import test from 'node:test'
import assert from 'node:assert/strict'
import { routeFailureText } from './routeFailure.ts'

test('車道方向限制使用明確的繁體中文錯誤', () => {
  assert.equal(routeFailureText('lane-direction', 2),
    '第 2 段找不到符合車道方向限制的路線')
})

test('一般不可達維持可採取行動的提示', () => {
  assert.equal(routeFailureText('unreachable', 1),
    '第 1 段在目前路網中不連通，請調整停靠點')
  assert.equal(routeFailureText('no-projection', 3),
    '第 3 段的座標不在可導航道路上，請重新選取')
})
