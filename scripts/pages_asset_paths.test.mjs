import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const mapCorePath = fileURLToPath(new URL('../src/app/mapCore.ts', import.meta.url))

test('road marking SVGs use the GitHub Pages-aware asset helper', async () => {
  const source = await readFile(mapCorePath, 'utf8')

  for (const name of ['motorcycle.svg', 'bicycle.svg']) {
    assert.match(
      source,
      new RegExp(`loadSvg\\(asset\\('/assets/road-markings/${name}'\\)\\)`),
      `${name} must include the GitHub Pages base path`,
    )
  }
})
