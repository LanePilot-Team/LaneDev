import assert from 'node:assert/strict'
import test from 'node:test'
import { nextRoutePanelCollapsed, routePanelToggleLabel } from './routePanelState.ts'

test('expanded route panel toggles to collapsed with an expand label', () => {
  assert.equal(nextRoutePanelCollapsed(false), true)
  assert.equal(routePanelToggleLabel(true), '展開路線卡片')
})

test('collapsed route panel toggles to expanded with a collapse label', () => {
  assert.equal(nextRoutePanelCollapsed(true), false)
  assert.equal(routePanelToggleLabel(false), '縮小路線卡片')
})
