import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Comic } from './bindings.ts'

export interface FollowedComic {
  readonly id: number
  readonly name: string
  readonly seenChapterIds: readonly number[]
}
const FOLLOWING_KEY = 'jmcomic.following.v1'
class FollowingDataError extends Error {
  constructor() {
    super('追更列表格式无效，原数据已保留')
  }
}
export function parseFollowing(raw: string | null): FollowedComic[] {
  if (raw === null) return []
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new FollowingDataError()
  return value.map((item: unknown) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('id' in item) ||
      typeof item.id !== 'number' ||
      !Number.isSafeInteger(item.id) ||
      !('name' in item) ||
      typeof item.name !== 'string' ||
      !('seenChapterIds' in item) ||
      !Array.isArray(item.seenChapterIds) ||
      !item.seenChapterIds.every((id: unknown) => typeof id === 'number' && Number.isSafeInteger(id))
    )
      throw new FollowingDataError()
    return { id: item.id, name: item.name, seenChapterIds: item.seenChapterIds }
  })
}
export function updateChapters(comic: Comic, followed?: FollowedComic) {
  return comic.chapterInfos.filter(
    (chapter) =>
      chapter.isDownloaded !== true && (followed === undefined || !followed.seenChapterIds.includes(chapter.chapterId)),
  )
}
export const useFollowing = defineStore('following', () => {
  const comics = ref<FollowedComic[]>([])
  const error = ref('')
  let loaded = false
  try {
    comics.value = parseFollowing(window.localStorage.getItem(FOLLOWING_KEY))
    loaded = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
  function save(next: FollowedComic[]) {
    if (!loaded) return
    try {
      window.localStorage.setItem(FOLLOWING_KEY, JSON.stringify(next))
      comics.value = next
      error.value = ''
    } catch (cause) {
      error.value = `追更列表保存失败：${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  function toggle(comic: Comic) {
    if (comics.value.some((item) => item.id === comic.id)) save(comics.value.filter((item) => item.id !== comic.id))
    else
      save([
        ...comics.value,
        { id: comic.id, name: comic.name, seenChapterIds: comic.chapterInfos.map((chapter) => chapter.chapterId) },
      ])
  }
  function markSeen(comic: Comic) {
    save(
      comics.value.map((item) =>
        item.id === comic.id
          ? { id: comic.id, name: comic.name, seenChapterIds: comic.chapterInfos.map((chapter) => chapter.chapterId) }
          : item,
      ),
    )
  }
  function remove(id: number) {
    save(comics.value.filter((item) => item.id !== id))
  }
  return { comics, error, toggle, markSeen, remove }
})
