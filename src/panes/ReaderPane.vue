<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  PhArrowSquareOut,
  PhCaretLeft,
  PhCaretRight,
  PhMagnifyingGlassMinus,
  PhMagnifyingGlassPlus,
  PhX,
} from '@phosphor-icons/vue'
import { commands } from '../bindings.ts'
import { useStore } from '../store.ts'

const store = useStore()

const POLL_INTERVAL_MS = 2000

const downloadedImgs = ref<string[]>([])
const downloadDir = ref('')
const totalImgCount = ref(0)
const isDownloading = ref(false)
const currentPage = ref(1)
const scale = ref(100)
const isLoading = ref(false)
const errorMessage = ref('')
let pollTimer: number | null = null

const readerComic = computed(() => store.readerComic)
const chapterId = computed(() => store.readerChapterId)
const totalPages = computed(() => Math.max(downloadedImgs.value.length, 1))
const canGoPrev = computed(() => currentPage.value > 1)
const canGoNext = computed(() => currentPage.value < downloadedImgs.value.length)

const progressLabel = computed(() => {
  if (totalImgCount.value === 0) {
    return `${downloadedImgs.value.length}`
  }
  return `${downloadedImgs.value.length}/${totalImgCount.value}`
})

const currentImgSrc = computed(() => {
  if (!downloadDir.value || downloadedImgs.value.length === 0) {
    return ''
  }

  const filename = downloadedImgs.value[currentPage.value - 1]
  if (filename === undefined) {
    return ''
  }

  return convertFileSrc(`${downloadDir.value}/${filename}`)
})

async function fetchChapterImgs() {
  if (readerComic.value === null || chapterId.value === null) {
    return
  }

  isLoading.value = true
  errorMessage.value = ''
  try {
    const result = await commands.getChapterDownloadedImgs(readerComic.value, chapterId.value)
    if (result.status === 'error') {
      errorMessage.value = result.error.err_message
      return
    }

    downloadDir.value = result.data.downloadDir
    totalImgCount.value = result.data.totalImgCount
    isDownloading.value = result.data.isDownloading
    downloadedImgs.value = result.data.downloadedImgs

    if (currentPage.value > downloadedImgs.value.length) {
      currentPage.value = Math.max(downloadedImgs.value.length, 1)
    }

    if (!result.data.isDownloading) {
      stopPolling()
    }
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    isLoading.value = false
  }
}

function startPolling() {
  stopPolling()
  pollTimer = window.setInterval(fetchChapterImgs, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function prevPage() {
  if (canGoPrev.value) {
    currentPage.value--
  }
}

function nextPage() {
  if (canGoNext.value) {
    currentPage.value++
  }
}

function zoomIn() {
  scale.value = Math.min(scale.value + 25, 300)
}

function zoomOut() {
  scale.value = Math.max(scale.value - 25, 25)
}

function resetZoom() {
  scale.value = 100
}

function closeReader() {
  stopPolling()
  store.readerComic = null
  store.readerChapterId = null
  store.readerChapterTitle = ''
}

async function openInFileManager() {
  if (!downloadDir.value) {
    return
  }

  const result = await commands.showPathInFileManager(downloadDir.value)
  if (result.status === 'error') {
    errorMessage.value = result.error.err_message
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (chapterId.value === null) {
    return
  }

  if (event.key === 'ArrowLeft') {
    prevPage()
  } else if (event.key === 'ArrowRight') {
    nextPage()
  } else if (event.key === 'Escape') {
    closeReader()
  } else if (event.key === '+' || event.key === '=') {
    zoomIn()
  } else if (event.key === '-') {
    zoomOut()
  }
}

watch(chapterId, (newId) => {
  if (newId === null) {
    return
  }

  downloadedImgs.value = []
  downloadDir.value = ''
  totalImgCount.value = 0
  currentPage.value = 1
  scale.value = 100
  void fetchChapterImgs()
  startPolling()
})

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  if (chapterId.value !== null) {
    void fetchChapterImgs()
    startPolling()
  }
})

onUnmounted(() => {
  stopPolling()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div v-if="chapterId !== null" class="fixed inset-0 z-50 bg-black flex flex-col">
    <div class="flex items-center px-4 py-3 bg-gray-9 text-white gap-4 border-b border-gray-7">
      <span class="font-bold truncate">{{ store.readerChapterTitle }}</span>
      <span class="text-gray-3 whitespace-nowrap">第 {{ currentPage }} / {{ totalPages }} 页</span>
      <span class="text-gray-3 whitespace-nowrap">已下载 {{ progressLabel }}</span>
      <span v-if="isDownloading" class="text-yellow-3 animate-pulse whitespace-nowrap font-medium">下载中</span>

      <div class="ml-auto flex gap-2">
        <n-button
          size="small"
          quaternary
          class="text-white!"
          :disabled="!downloadDir"
          title="在文件管理器中打开"
          @click="openInFileManager">
          <template #icon>
            <n-icon>
              <PhArrowSquareOut />
            </n-icon>
          </template>
        </n-button>
        <n-button size="small" quaternary class="text-white!" title="关闭" @click="closeReader">
          <template #icon>
            <n-icon>
              <PhX />
            </n-icon>
          </template>
        </n-button>
      </div>
    </div>

    <div class="flex-1 overflow-auto flex items-center justify-center p-4 bg-black" @click="nextPage">
      <img
        v-if="currentImgSrc"
        :src="currentImgSrc"
        :style="{ transform: `scale(${scale / 100})`, transformOrigin: 'center center' }"
        class="max-w-full max-h-full object-contain transition-transform duration-200"
        alt="" />
      <div v-else class="text-center bg-gray-9/90 px-6 py-5 rounded-lg border border-gray-7 min-w-70">
        <n-spin v-if="isLoading" size="large" />
        <div v-if="errorMessage" class="mt-4 text-red-3 break-all">{{ errorMessage }}</div>
        <div v-else class="mt-4 text-gray-1">等待图片下载...</div>
      </div>
    </div>

    <div class="flex items-center justify-center gap-4 px-4 py-3 bg-gray-9 text-white border-t border-gray-7">
      <n-button size="small" class="text-white!" :disabled="!canGoPrev" @click.stop="prevPage">
        <template #icon>
          <n-icon>
            <PhCaretLeft />
          </n-icon>
        </template>
        上一页
      </n-button>

      <div class="flex items-center gap-1">
        <n-button size="tiny" quaternary class="text-white!" @click.stop="zoomOut">
          <template #icon>
            <n-icon>
              <PhMagnifyingGlassMinus />
            </n-icon>
          </template>
        </n-button>
        <span class="w-12 text-center text-sm cursor-pointer text-gray-1" @click.stop="resetZoom">{{ scale }}%</span>
        <n-button size="tiny" quaternary class="text-white!" @click.stop="zoomIn">
          <template #icon>
            <n-icon>
              <PhMagnifyingGlassPlus />
            </n-icon>
          </template>
        </n-button>
      </div>

      <n-button size="small" class="text-white!" :disabled="!canGoNext" @click.stop="nextPage">
        下一页
        <template #icon>
          <n-icon>
            <PhCaretRight />
          </n-icon>
        </template>
      </n-button>
    </div>
  </div>
</template>
