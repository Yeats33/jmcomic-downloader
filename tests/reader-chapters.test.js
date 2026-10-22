import { expect, test } from 'bun:test'
import { adjacentChapter, orderedChapters } from '../src/reader/chapters.ts'

test('chapter navigation follows chapter order and stops at boundaries', () => {
  const source = [
    { chapterId: 30, order: 3 },
    { chapterId: 10, order: 1 },
    { chapterId: 20, order: 2 },
  ]
  const chapters = orderedChapters(source)
  expect(adjacentChapter(chapters, 10, 1)?.chapterId).toBe(20)
  expect(adjacentChapter(chapters, 10, -1)).toBeUndefined()
  expect(adjacentChapter(chapters, 30, 1)).toBeUndefined()
  expect(adjacentChapter(chapters, 99, 1)).toBeUndefined()
  expect(source[0].chapterId).toBe(30)
})
