import { expect, test } from 'bun:test'
import { displayFor, loadDisplays, pageWidth } from '../src/reader/preferences.ts'

test('per-comic display wins over defaults and survives serialization', () => {
  const defaults = { layout: 'single', fit: 'height', scale: 75 }
  const specific = { layout: 'scroll', fit: 'width', scale: 150 }
  const restored = loadDisplays({ getItem: () => JSON.stringify({ defaults, comics: { 42: specific } }) })
  expect(displayFor(restored, 42, 'single')).toEqual(specific)
  expect(displayFor(restored, 43, 'scroll')).toEqual(defaults)
})
test('legacy display settings keep saved layout and invalid zoom is rejected', () => {
  expect(displayFor(loadDisplays({ getItem: () => null }), 1, 'scroll').layout).toBe('scroll')
  expect(() =>
    loadDisplays({
      getItem: () => JSON.stringify({ defaults: { layout: 'single', fit: 'width', scale: -1 }, comics: {} }),
    }),
  ).toThrow()
})
test('fit modes use the viewport dimensions and zoom independently', () => {
  expect(pageWidth('width', 100, 0.5, 1000, 600)).toBe(1000)
  expect(pageWidth('height', 100, 0.5, 1000, 600)).toBe(300)
  expect(pageWidth('screen', 150, 2, 1000, 600)).toBe(1500)
})
