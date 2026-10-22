export type ReaderMode = 'local' | 'online'
export type ReaderLayout = 'single' | 'scroll'

export interface ReadingProgress {
  readonly comicId: number
  readonly comicName: string
  readonly chapterId: number
  readonly chapterTitle: string
  readonly page: number
  readonly pageCount: number
  readonly filename: string | null
  readonly mode: ReaderMode
  readonly layout: ReaderLayout
  readonly updatedAt: number
}

export const READING_HISTORY_KEY = 'jmcomic.reading-history.v1'
const HISTORY_LIMIT = 100

export function isReadingProgress(value: unknown): value is ReadingProgress {
  return (
    typeof value === 'object' &&
    value !== null &&
    'comicId' in value &&
    typeof value.comicId === 'number' &&
    Number.isSafeInteger(value.comicId) &&
    'comicName' in value &&
    typeof value.comicName === 'string' &&
    'chapterId' in value &&
    typeof value.chapterId === 'number' &&
    Number.isSafeInteger(value.chapterId) &&
    'chapterTitle' in value &&
    typeof value.chapterTitle === 'string' &&
    'page' in value &&
    typeof value.page === 'number' &&
    Number.isSafeInteger(value.page) &&
    value.page >= 1 &&
    'pageCount' in value &&
    typeof value.pageCount === 'number' &&
    Number.isSafeInteger(value.pageCount) &&
    value.pageCount >= value.page &&
    'filename' in value &&
    (value.filename === null || typeof value.filename === 'string') &&
    'mode' in value &&
    (value.mode === 'local' || value.mode === 'online') &&
    'layout' in value &&
    (value.layout === 'single' || value.layout === 'scroll') &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  )
}

export function loadReadingHistory(storage: Pick<Storage, 'getItem'>): ReadingProgress[] {
  const raw = storage.getItem(READING_HISTORY_KEY)
  if (raw === null) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || !parsed.every(isReadingProgress)) {
    throw new Error('阅读记录格式无效，原记录已保留')
  }
  return parsed.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, HISTORY_LIMIT)
}

export function rememberProgress(history: readonly ReadingProgress[], progress: ReadingProgress): ReadingProgress[] {
  return [
    progress,
    ...history.filter((entry) => entry.comicId !== progress.comicId || entry.mode !== progress.mode),
  ].slice(0, HISTORY_LIMIT)
}
