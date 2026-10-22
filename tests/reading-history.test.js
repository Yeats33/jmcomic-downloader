import { describe, expect, test } from 'bun:test'
import { loadReadingHistory, rememberProgress, READING_HISTORY_KEY } from '../src/reader/history.ts'

const progress = (overrides = {}) => ({
  comicId: 1,
  comicName: '漫画',
  chapterId: 10,
  chapterTitle: '第 1 话',
  page: 4,
  pageCount: 20,
  filename: '0004.jpg',
  mode: 'local',
  layout: 'scroll',
  updatedAt: 1,
  ...overrides,
})

describe('reading history', () => {
  test('recovers the chapter, page and layout from persistent storage after restart', () => {
    const saved = rememberProgress([], progress())
    const disk = new Map([[READING_HISTORY_KEY, JSON.stringify(saved)]])

    const restored = loadReadingHistory({ getItem: (key) => disk.get(key) ?? null })

    expect(restored).toEqual([progress()])
  })

  test('updates one comic without losing other comics or the other reading mode', () => {
    const before = [progress(), progress({ comicId: 2 }), progress({ mode: 'online', filename: null })]
    const after = rememberProgress(before, progress({ page: 9, chapterId: 11, updatedAt: 2 }))
    expect(after.map(({ comicId, mode, page }) => [comicId, mode, page])).toEqual([
      [1, 'local', 9],
      [2, 'local', 4],
      [1, 'online', 4],
    ])
  })

  test('rejects invalid page numbers without rewriting stored history', () => {
    const raw = JSON.stringify([progress({ page: -1 })])
    expect(() => loadReadingHistory({ getItem: () => raw })).toThrow()
  })

  test('bounds history without removing the newest reading position', () => {
    let saved = []
    for (let comicId = 1; comicId <= 101; comicId++) saved = rememberProgress(saved, progress({ comicId }))
    expect(saved.length).toBe(100)
    expect(saved[0].comicId).toBe(101)
    expect(saved.at(-1).comicId).toBe(2)
  })
})
