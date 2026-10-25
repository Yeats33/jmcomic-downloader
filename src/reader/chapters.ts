import type { ChapterInfo } from '../bindings.ts'

export function orderedChapters(chapters: readonly ChapterInfo[]): ChapterInfo[] {
  return [...chapters].sort((left, right) => left.order - right.order || left.chapterId - right.chapterId)
}

export function adjacentChapter(chapters: readonly ChapterInfo[], chapterId: number | null, offset: -1 | 1) {
  const index = chapters.findIndex((chapter) => chapter.chapterId === chapterId)
  return index < 0 ? undefined : chapters[index + offset]
}
