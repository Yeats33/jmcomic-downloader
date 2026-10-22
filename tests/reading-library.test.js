import { expect, test } from 'bun:test'
import { parseLibrary, toggleBookmark } from '../src/reader/library.ts'
const progress = { comicId: 1, comicName: 'Book', chapterId: 2, chapterTitle: 'Chapter', page: 3,
  pageCount: 10, filename: '0003.jpg', mode: 'local', layout: 'single', updatedAt: 1 }
test('multiple page bookmarks persist independently of the latest reading position', () => {
  const first = toggleBookmark(parseLibrary(null), progress)
  const second = toggleBookmark(first, { ...progress, page: 8, filename: '0008.jpg' })
  const restored = parseLibrary(JSON.stringify(second))
  expect(restored.bookmarks.map((item) => item.page)).toEqual([8, 3])
  expect(toggleBookmark(restored, progress).bookmarks.map((item) => item.page)).toEqual([8])
})
test('reading status is restored and invalid stored states are rejected', () => {
  expect(parseLibrary(JSON.stringify({ bookmarks: [], statuses: { 1: 'read' } })).statuses['1']).toBe('read')
  expect(() => parseLibrary(JSON.stringify({ bookmarks: [], statuses: { 1: 'finished-ish' } }))).toThrow()
})
