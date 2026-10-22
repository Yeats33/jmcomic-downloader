import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setImmediate } from 'node:timers'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { createRenderer, nextTick, ref } from 'vue'
import { useOnlinePages } from '../src/reader/useOnlinePages.ts'

const previousWindow = globalThis.window
const renderer = createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert() {},
  remove() {},
  setText() {},
  setComment() {},
  setElementText() {},
  patchProp() {},
  parentNode: () => null,
  nextSibling: () => null,
})
let app
let reader
let prefetchPages
let requests
let closed
let liveUrls
let sessionNumber
const createUrl = URL.createObjectURL.bind(URL)
const revokeUrl = URL.revokeObjectURL.bind(URL)

// IPC completes synchronously; the next event-loop turn drains its promise chains.
const settleTransfers = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  globalThis.window = { crypto: globalThis.crypto }
  requests = []
  closed = []
  liveUrls = new Set()
  sessionNumber = 0
  URL.createObjectURL = (blob) => {
    const url = createUrl(blob)
    liveUrls.add(url)
    return url
  }
  URL.revokeObjectURL = (url) => {
    liveUrls.delete(url)
    revokeUrl(url)
  }
  mockIPC((command, args) => {
    if (command === 'start_online_reader') return `session-${++sessionNumber}`
    if (command === 'open_online_chapter') return { sessionId: args.sessionId, pageCount: 6 }
    if (command === 'close_online_reader') {
      closed.push(args.sessionId)
      return
    }
    if (command === 'stream_online_page') {
      requests.push({ session: args.sessionId, page: args.pageIndex })
      const deliver = window[`_${args.onChunk.id}`]
      deliver({ message: { event: 'Chunk', data: [args.pageIndex] }, index: 0 })
      deliver({ message: { event: 'Complete', data: { mime: 'image/png', blocks: 0 } }, index: 1 })
      deliver({ end: true, index: 2 })
      return
    }
    throw new Error(`Unexpected reader command: ${command}`)
  })
  prefetchPages = ref(1)
  app = renderer.createApp({
    setup() {
      reader = useOnlinePages(prefetchPages)
      return () => null
    },
  })
  app.mount({})
})

afterEach(() => {
  app.unmount()
  for (const url of liveUrls) revokeUrl(url)
  URL.createObjectURL = createUrl
  URL.revokeObjectURL = revokeUrl
  clearMocks()
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
})

describe('configurable online reader buffering', () => {
  test('resumes a saved page without first loading page one', async () => {
    prefetchPages.value = 0
    await reader.openChapter(101, 4)
    await settleTransfers()
    expect(reader.currentPage.value).toBe(4)
    expect(requests.map(({ page }) => page)).toEqual([3])
    expect(reader.pageUrls.get(3)).toBe(reader.imageUrl.value)
  })

  test('clamps a saved page after the chapter becomes shorter', async () => {
    prefetchPages.value = 0
    await reader.openChapter(101, 20)
    await settleTransfers()
    expect(reader.currentPage.value).toBe(6)
    expect(requests.map(({ page }) => page)).toEqual([5])
  })
  test('loads only the current page when buffering is disabled', async () => {
    prefetchPages.value = 0

    await reader.openChapter(101)
    await settleTransfers()

    expect(requests.map(({ page }) => page)).toEqual([0])
    expect(reader.imageUrl.value).not.toBe('')
  })

  test('buffers the selected number of following pages', async () => {
    prefetchPages.value = 3

    await reader.openChapter(101)
    await settleTransfers()

    expect(requests.map(({ page }) => page)).toEqual([0, 1, 2, 3])
    expect(liveUrls.size).toBe(4)
  })

  test('expands the buffer immediately without reloading the current page', async () => {
    await reader.openChapter(101)
    await settleTransfers()
    const currentUrl = reader.imageUrl.value

    prefetchPages.value = 4
    await nextTick()
    await settleTransfers()

    expect(requests.map(({ page }) => page)).toEqual([0, 1, 2, 3, 4])
    expect(reader.imageUrl.value).toBe(currentUrl)
  })

  test('releases excess cached pages when the buffer is reduced', async () => {
    prefetchPages.value = 4
    await reader.openChapter(101)
    await settleTransfers()

    prefetchPages.value = 0
    await nextTick()
    await settleTransfers()

    expect(liveUrls.size).toBe(1)
    expect(liveUrls.has(reader.imageUrl.value)).toBe(true)
  })

  test('reuses distant buffered pages and stops at the chapter boundary', async () => {
    prefetchPages.value = 50
    await reader.openChapter(101)
    await settleTransfers()

    await reader.showPage(5)
    await settleTransfers()

    expect(requests.map(({ page }) => page)).toEqual([0, 1, 2, 3, 4, 5])
    expect(liveUrls.size).toBe(3)
    expect(reader.imageUrl.value).not.toBe('')
  })

  test('clears the previous chapter and keeps the buffer setting for the next', async () => {
    prefetchPages.value = 2
    await reader.openChapter(101)
    await settleTransfers()
    const previousUrl = reader.imageUrl.value

    await reader.openChapter(103)
    await settleTransfers()

    expect(closed).toEqual(['session-1'])
    expect(liveUrls.has(previousUrl)).toBe(false)
    expect(requests.filter(({ session }) => session === 'session-2').map(({ page }) => page)).toEqual([0, 1, 2])
    expect(liveUrls.size).toBe(3)
  })
})
