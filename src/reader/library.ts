import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { isReadingProgress } from './history.ts'
import type { ReadingProgress } from './history.ts'

export type ReadingStatus = 'unread' | 'reading' | 'read'
export const READING_STATUS_OPTIONS = [
  { label: '未读', value: 'unread' },
  { label: '在读', value: 'reading' },
  { label: '已读', value: 'read' },
]
interface ReadingLibrary {
  readonly bookmarks: readonly ReadingProgress[]
  readonly statuses: Readonly<Record<string, ReadingStatus>>
}
export const LIBRARY_KEY = 'jmcomic.reading-library.v1'
export function bookmarkKey(entry: ReadingProgress) {
  return `${entry.mode}:${entry.comicId}:${entry.chapterId}:${entry.filename ?? entry.page}`
}
class LibraryDataError extends Error {
  constructor() {
    super('书签与阅读状态格式无效，原数据已保留')
  }
}
export function parseLibrary(raw: string | null): ReadingLibrary {
  if (raw === null) return { bookmarks: [], statuses: {} }
  const value: unknown = JSON.parse(raw)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('bookmarks' in value) ||
    !Array.isArray(value.bookmarks) ||
    !value.bookmarks.every(isReadingProgress) ||
    !('statuses' in value) ||
    typeof value.statuses !== 'object' ||
    value.statuses === null ||
    Array.isArray(value.statuses)
  )
    throw new LibraryDataError()
  const statuses: Record<string, ReadingStatus> = {}
  for (const [id, status] of Object.entries(value.statuses)) {
    if (!/^\d+$/.test(id) || (status !== 'unread' && status !== 'reading' && status !== 'read'))
      throw new LibraryDataError()
    statuses[id] = status
  }
  return { bookmarks: value.bookmarks, statuses }
}
export function toggleBookmark(library: ReadingLibrary, progress: ReadingProgress): ReadingLibrary {
  const key = bookmarkKey(progress)
  const exists = library.bookmarks.some((item) => bookmarkKey(item) === key)
  return {
    ...library,
    bookmarks: exists
      ? library.bookmarks.filter((item) => bookmarkKey(item) !== key)
      : [progress, ...library.bookmarks],
  }
}
export const useReadingLibrary = defineStore('reading-library', () => {
  const data = ref<ReadingLibrary>({ bookmarks: [], statuses: {} })
  const error = ref('')
  let loaded = false
  try {
    data.value = parseLibrary(window.localStorage.getItem(LIBRARY_KEY))
    loaded = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
  function save(next: ReadingLibrary) {
    if (!loaded) return
    try {
      window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(next))
      data.value = next
      error.value = ''
    } catch (cause) {
      error.value = `书签保存失败：${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  const bookmarks = computed(() => data.value.bookmarks)
  const statusFor = (comicId: number): ReadingStatus => data.value.statuses[String(comicId)] ?? 'unread'
  function setStatus(comicId: number, status: ReadingStatus) {
    save({ ...data.value, statuses: { ...data.value.statuses, [comicId]: status } })
  }
  function toggle(progress: ReadingProgress) {
    save(toggleBookmark(data.value, progress))
  }
  return { bookmarks, error, statusFor, setStatus, toggle }
})
