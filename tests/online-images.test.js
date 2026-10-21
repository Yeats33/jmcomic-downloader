import { describe, expect, test } from 'bun:test'
import { imageStrips } from '../src/reader/onlineImages.ts'

describe('online page reconstruction', () => {
  test('restores reversed strips when image height has a remainder', () => {
    const rows = Array.from({ length: 10 }, (_, index) => index)
    const restored = new Array(10)
    for (const strip of imageStrips(10, 3)) {
      restored.splice(strip.targetY, strip.height, ...rows.slice(strip.sourceY, strip.sourceY + strip.height))
    }
    expect(restored).toEqual([6, 7, 8, 9, 3, 4, 5, 0, 1, 2])
    expect(new Set(restored).size).toBe(10)
  })
  test('rejects invalid block counts before drawing', () => {
    expect(() => imageStrips(10, 0)).toThrow()
    expect(() => imageStrips(10, 11)).toThrow()
    expect(() => imageStrips(10, 1.5)).toThrow()
  })
})
