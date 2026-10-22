import { expect, test } from 'bun:test'
import { parseFollowing, updateChapters } from '../src/following.ts'
test('followed update preview only contains unseen chapters that are not downloaded', () => {
  const comic = { chapterInfos: [{ chapterId: 1 }, { chapterId: 2 }, { chapterId: 3, isDownloaded: true }] }
  const [followed] = parseFollowing(JSON.stringify([{ id: 10, name: 'Book', seenChapterIds: [1] }]))
  expect(updateChapters(comic, followed).map((chapter) => chapter.chapterId)).toEqual([2])
  expect(updateChapters(comic).map((chapter) => chapter.chapterId)).toEqual([1, 2])
})
