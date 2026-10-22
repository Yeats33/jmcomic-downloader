import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setImmediate } from 'node:timers'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { createRenderer, ref } from 'vue'
import { useLocalPages } from '../src/reader/useLocalPages.ts'

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
const settle = () => new Promise((resolve) => setImmediate(resolve))
const sourceFor = (chapterId, overrides = {}) => ({
  comic: { id: 1 },
  chapterId,
  startPage: 1,
  startFilename: null,
  ...overrides,
})
const reply = (id, filenames = ['0001.jpg', '0002.jpg', '0003.jpg']) => ({
  downloadDir: `/fixture/${id}`,
  downloadedImgs: filenames,
  totalImgCount: filenames.length,
  isDownloading: false,
})
let source
let reader
let app
let requests

beforeEach(() => {
  globalThis.window = { crypto: globalThis.crypto }
  requests = []
  mockIPC((command, args) => {
    if (command !== 'get_chapter_downloaded_imgs') throw new Error(`Unexpected command: ${command}`)
    return new Promise((resolve, reject) => requests.push({ args, resolve, reject }))
  })
  window.__TAURI_INTERNALS__.convertFileSrc = (path) => path
  source = ref(null)
  app = renderer.createApp({
    setup() {
      reader = useLocalPages(source)
      return () => null
    },
  })
  app.mount({})
})
afterEach(() => {
  app.unmount()
  clearMocks()
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
})

describe('local reader requests', () => {
  test('ignores chapter A when its response arrives after reopening chapter B', async () => {
    source.value = sourceFor(101)
    source.value = null
    source.value = sourceFor(102)

    requests[1].resolve(reply(102))
    await settle()
    requests[0].resolve(reply(101))
    await settle()

    expect(reader.directory.value).toBe('/fixture/102')
    expect(reader.pages.value[0].url).toBe('/fixture/102/0001.jpg')
  })

  test('ignores an old failure while the new chapter is still loading', async () => {
    source.value = sourceFor(101)
    source.value = sourceFor(102)

    requests[0].reject(new Error('Old chapter error'))
    await settle()

    expect(reader.error.value).toBe('')
    expect(reader.loading.value).toBe(true)
    requests[1].resolve(reply(102))
    await settle()
    expect(reader.loading.value).toBe(false)
  })

  test('restores the same image when newly downloaded earlier pages change its index', async () => {
    source.value = sourceFor(101, { startPage: 2, startFilename: '0003.jpg' })
    requests[0].resolve(reply(101))
    await settle()

    expect(reader.currentPage.value).toBe(3)
  })

  test('clamps a saved page when the available chapter is shorter', async () => {
    source.value = sourceFor(101, { startPage: 20 })
    requests[0].resolve(reply(101))
    await settle()

    expect(reader.currentPage.value).toBe(3)
    reader.showPage(0)
    expect(reader.currentPage.value).toBe(3)
  })

  test('keeps the current filename when polling inserts earlier images', async () => {
    source.value = sourceFor(101)
    requests[0].resolve(reply(101, ['0002.jpg', '0003.jpg']))
    await settle()
    reader.showPage(2)

    const refreshed = reader.refresh()
    requests[1].resolve(reply(101))
    await refreshed

    expect(reader.currentPage.value).toBe(3)
    expect(reader.filenames.value[reader.currentPage.value - 1]).toBe('0003.jpg')
  })
})
