const callbacks = new Map()
const listeners = new Map()
let callbackId = 1
let sessionId = 0
let activeSession = null
const image = (label) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#dce9ef"/><text x="50" y="150" font-size="36" fill="#1c3b4a">${label}</text><rect x="50" y="250" width="500" height="500" fill="#8aafbc"/></svg>`)}`
const chapters = [101, 102, 103].map((chapterId, index) => ({
  chapterId,
  chapterTitle: `第${index + 1}话 · 阅读测试`,
  order: index + 1,
  isDownloaded: true,
  isPdfExported: false,
  isCbzExported: false,
  chapterDownloadDir: `/fixture/comic/${chapterId}`,
}))
const comic = {
  id: 90001,
  name: 'Fixture A',
  chapterInfos: chapters,
  author: ['作者甲'],
  tags: ['冒险'],
  works: [],
  actors: [],
  related_list: [],
  addtime: '',
  description: '',
  total_views: '',
  likes: '',
  series_id: '',
  comment_total: '',
  liked: false,
  is_favorite: false,
  is_aids: false,
  comicDownloadDir: '/fixture/comic',
  isDownloaded: true,
}
const comics = Array.from({ length: 25 }, (_, index) => ({
  ...comic,
  id: 90001 + index,
  name: index === 0 ? 'Fixture A' : index === 1 ? 'Fixture B' : `库存 ${index + 1}`,
  author: [index % 2 ? '作者乙' : '作者甲'],
  tags: [index % 2 ? '日常' : '冒险'],
  chapterInfos: chapters.map((chapter, order) => ({ ...chapter, isDownloaded: index % 2 === 0 || order === 0 })),
}))
const qa = (window.workflowQa = {
  comic,
  comics,
  deleted: [],
  requests: [],
  localRequests: [],
  pendingLocal: new Map(),
  deferLocal: false,
  failPage: null,
  queue: JSON.parse(localStorage.getItem('fixture-queue') ?? '[]'),
  urls: new Set(),
  restoreCalls: 0,
  updatedComics: new Map(),
  createdDownloads: [],
})
const createUrl = URL.createObjectURL.bind(URL)
const revokeUrl = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => {
  const url = createUrl(blob)
  qa.urls.add(url)
  return url
}
URL.revokeObjectURL = (url) => {
  qa.urls.delete(url)
  revokeUrl(url)
}
const config = {
  username: '',
  password: '',
  downloadDir: '/fixture/download',
  exportDir: '/fixture/export',
  downloadFormat: 'Jpeg',
  dirFmt: '{comic_title}/{chapter_title}',
  proxyMode: 'System',
  proxyHost: '',
  proxyPort: 0,
  enableFileLogger: false,
  chapterConcurrency: 3,
  imgConcurrency: 20,
  onlineReaderPrefetchPages: 1,
  apiDomainMode: 'Domain2',
  customApiDomain: '',
  shouldDownloadCover: false,
  enableMergePdf: true,
  createPdfConcurrency: 2,
  exportSkipMode: 'None',
}
function emitDownload(payload) {
  for (const id of listeners.get('download-event') ?? []) callbacks.get(id)?.({ event: 'download-event', id, payload })
}
function queueTask(state) {
  return { state, comic, chapterInfo: chapters[0], downloadedImgCount: 2, totalImgCount: 6 }
}
qa.seedPausedQueue = () => {
  qa.queue = [queueTask('Paused')]
  localStorage.setItem('fixture-queue', JSON.stringify(qa.queue))
}
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  transformCallback(callback) {
    const id = callbackId++
    callbacks.set(id, callback)
    return id
  },
  convertFileSrc(path) {
    if (qa.deferImages) return `/tests/delayed-image/${path.split('/').at(-1)}`
    if (qa.failedLocalPage && path.endsWith(`/${String(qa.failedLocalPage).padStart(4, '0')}.jpg`))
      return 'data:image/png;base64,AA=='
    return image(path)
  },
  async invoke(command, args = {}) {
    if (command === 'get_config') return config
    if (command === 'save_config') return null
    if (command === 'get_comic') return qa.updatedComics.get(args.aid) ?? comic
    if (command === 'create_download_task') { qa.createdDownloads.push(args.chapterId); return null }
    if (command === 'get_downloaded_comics') return comics.filter((item) => !qa.deleted.includes(item.id))
    if (command === 'delete_downloaded_comic') {
      qa.deleted.push(args.comic.id)
      return null
    }
    if (command === 'restore_download_queue') {
      qa.restoreCalls++
      for (const data of qa.queue) emitDownload({ event: 'TaskCreate', data })
      emitDownload({ event: 'QueueOrder', data: { chapterIds: qa.queue.map((task) => task.chapterInfo.chapterId) } })
      return null
    }
    if (command === 'prioritize_download_task') {
      qa.queue.sort((left, right) => Number(right.chapterInfo.chapterId === args.chapterId) - Number(left.chapterInfo.chapterId === args.chapterId))
      localStorage.setItem('fixture-queue', JSON.stringify(qa.queue))
      emitDownload({ event: 'QueueOrder', data: { chapterIds: qa.queue.map((task) => task.chapterInfo.chapterId) } })
      return null
    }
    if (command === 'resume_download_task' || command === 'pause_download_task') {
      const task = qa.queue.find((entry) => entry.chapterInfo.chapterId === args.chapterId)
      if (task) {
        task.state = command === 'pause_download_task' ? 'Paused' : 'Downloading'
        localStorage.setItem('fixture-queue', JSON.stringify(qa.queue))
        emitDownload({
          event: 'TaskUpdate',
          data: {
            chapterId: args.chapterId,
            state: task.state,
            downloadedImgCount: task.downloadedImgCount,
            totalImgCount: task.totalImgCount,
          },
        })
      }
      return null
    }
    if (command === 'search') {
      qa.requests.push({ command, ...args })
      return {
        SearchResult: {
          searchQuery: args.keyword,
          total: args.keyword === 'empty' ? 0 : 1,
          content:
            args.keyword === 'empty'
              ? []
              : [
                  {
                    id: 90001,
                    name: 'Old search result',
                    author: 'Fixture',
                    category: { id: 'test', title: '测试' },
                    categorySub: { id: 'test', title: '测试' },
                    isDownloaded: true,
                    comicDownloadDir: '/fixture/comic',
                  },
                ],
        },
      }
    }
    if (command === 'get_chapter_downloaded_imgs') {
      qa.localRequests.push(args.chapterId)
      const data = {
        downloadDir: `/fixture/${args.chapterId}`,
        downloadedImgs: Array.from({ length: 6 }, (_, index) => `${String(index + 1).padStart(4, '0')}.jpg`),
        totalImgCount: 6,
        isDownloading: false,
      }
      if (qa.deferLocal) return new Promise((resolve) => qa.pendingLocal.set(args.chapterId, () => resolve(data)))
      return data
    }
    if (command === 'get_weekly_info')
      return { categories: [{ id: 'test', title: '测试', time: '测试周期' }], type: [{ id: 'test', title: '测试' }] }
    if (command === 'get_weekly') return { total: 0, list: [] }
    if (command === 'get_logs_dir_size') return 0
    if (command === 'plugin:app|version') return '0.18.0'
    if (command === 'plugin:event|listen') {
      listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler])
      return callbackId++
    }
    if (command === 'plugin:event|unlisten') return null
    if (command === 'start_online_reader') { activeSession = `session-${++sessionId}`; return activeSession }
    if (command === 'close_online_reader') { if (args.sessionId === activeSession) activeSession = null; return null }
    if (command === 'open_online_chapter') {
      if (args.sessionId !== activeSession) throw { message: '在线阅读已关闭' }
      return { sessionId: args.sessionId, pageCount: 6 }
    }
    if (command === 'stream_online_page') {
      if (args.sessionId !== activeSession) throw { message: '在线阅读已关闭' }
      qa.requests.push({ command, page: args.pageIndex })
      if (qa.failPage === args.pageIndex) throw { err_title: '网络错误', message: '测试页面加载失败' }
      const canvas = document.createElement('canvas')
      canvas.width = 600
      canvas.height = 900
      const context = canvas.getContext('2d')
      context.fillStyle = '#dce9ef'
      context.fillRect(0, 0, 600, 900)
      context.fillStyle = '#1c3b4a'
      context.font = '36px system-ui'
      context.fillText(`Online page ${args.pageIndex + 1}`, 50, 150)
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (char) => char.charCodeAt(0))
      const deliver = callbacks.get(args.onChunk.id)
      deliver({
        message: { event: 'Chunk', data: qa.corruptPage === args.pageIndex ? [0] : Array.from(bytes) },
        index: 0,
      })
      deliver({ message: { event: 'Complete', data: { mime: 'image/png', blocks: 0 } }, index: 1 })
      deliver({ end: true, index: 2 })
      return null
    }
    throw new Error(`Unexpected fixture command: ${command}`)
  },
}
async function mount() {
  await import('/src/main.ts')
  const { useStore } = await import('/src/store.ts')
  qa.store = useStore()
  qa.store.pickedComic = comic
  qa.store.currentTabName = 'chapter'
}
void mount().catch((error) => {
  document.body.textContent = String(error)
  console.error(error)
})
