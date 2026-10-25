import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { useStore } from '../src/store.ts'
import { READING_HISTORY_KEY } from '../src/reader/history.ts'
import { DISPLAY_KEY } from '../src/reader/preferences.ts'

const previousWindow = globalThis.window
const chapter = { chapterId: 20, chapterTitle: 'Chapter', order: 1 }
const comic = { id: 2, name: 'Second', chapterInfos: [chapter] }
const otherDisplay = { layout: 'scroll', fit: 'width', scale: 150 }
const progress = {
  comicId: 2,
  comicName: 'Second',
  chapterId: 20,
  chapterTitle: 'Chapter',
  page: 1,
  pageCount: 3,
  filename: '0001.jpg',
  mode: 'local',
  layout: 'single',
  updatedAt: 1,
}
let values

beforeEach(() => {
  values = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  }
  setActivePinia(createPinia())
})
afterEach(() => {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
})

test('unreadable reading history keeps display settings and the original record', () => {
  const brokenHistory = '[{"comicId":"broken"}]'
  values.set(READING_HISTORY_KEY, brokenHistory)
  values.set(DISPLAY_KEY, JSON.stringify({ defaults: null, comics: { 1: otherDisplay } }))
  const store = useStore()
  store.initializeReadingHistory()

  store.openLocalReader(comic, chapter)
  store.readerScale = 125
  store.recordReadingProgress(progress)

  const displays = JSON.parse(values.get(DISPLAY_KEY))
  expect(displays.comics['1']).toEqual(otherDisplay)
  expect(displays.comics['2'].scale).toBe(125)
  expect(values.get(READING_HISTORY_KEY)).toBe(brokenHistory)
  expect(store.readingHistory[0]).toEqual(progress)
  expect(store.readingHistoryError).toContain('阅读记录格式无效')
})

test('unreadable display settings survive later display changes', () => {
  const brokenDisplays = '{"defaults":{"layout":"diagonal"}}'
  values.set(DISPLAY_KEY, brokenDisplays)
  const store = useStore()
  store.initializeReadingHistory()

  store.openLocalReader(comic, chapter)
  store.readerScale = 125
  store.saveDefaultDisplay()
  store.recordReadingProgress(progress)

  expect(values.get(DISPLAY_KEY)).toBe(brokenDisplays)
  expect(JSON.parse(values.get(READING_HISTORY_KEY))).toEqual([progress])
  expect(store.readingHistoryError).toContain('阅读显示设置格式无效')
})
