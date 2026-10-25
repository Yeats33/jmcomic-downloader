<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import { commands, events } from '../../bindings.ts'
import type { DownloadTaskState } from '../../bindings.ts'
import { open } from '@tauri-apps/plugin-dialog'
import { PhFolderOpen, PhGearSix } from '@phosphor-icons/vue'
import { useStore } from '../../store.ts'
import SettingsDialog from '../../dialogs/SettingsDialog/SettingsDialog.vue'
import UncompletedProgresses from './components/UncompletedProgresses.vue'
import CompletedProgresses from './components/CompletedProgresses.vue'
import { ProgressData } from '../../types.ts'
import ExportProgresses from './components/ExportProgresses.vue'
import { NAlert, NButton, NIcon, NInput, NInputGroup, NInputGroupLabel, NTabPane, NTabs } from 'naive-ui'

const store = useStore()

const settingsDialogShowing = ref<boolean>(false)

const downloadSpeed = ref<string>('')
const restoring = ref(false)
const restoreError = ref('')
let stopStartupWatch: WatchStopHandle | undefined
let mounted = true

function indicator(state: DownloadTaskState, downloaded: number, total: number) {
  const labels: Record<DownloadTaskState, string> = {
    Pending: '排队中',
    Downloading: '下载中',
    Paused: '已暂停',
    Completed: '下载完成',
    Failed: '下载失败',
    Cancelled: '已取消',
  }
  return total === 0 ? labels[state] : `${labels[state]} ${downloaded}/${total}`
}

async function restoreQueue() {
  if (restoring.value) return
  restoring.value = true
  restoreError.value = ''
  try {
    const result = await commands.restoreDownloadQueue()
    if (result.status === 'error') restoreError.value = result.error.message
  } catch (error) {
    restoreError.value = error instanceof Error ? error.message : String(error)
  } finally {
    restoring.value = false
  }
}

let unListenDownloadEvent: (() => void) | undefined
onMounted(async () => {
  await events.downloadEvent
    .listen(async ({ payload: { event, data } }) => {
      if (event === 'QueueOrder') {
        store.downloadOrder = data.chapterIds
      } else if (event === 'Speed') {
        downloadSpeed.value = data.speed
      } else if (event === 'Sleeping') {
        const progressData = store.progresses.get(data.chapterId)
        if (progressData !== undefined) {
          progressData.indicator = `将在${data.remainingSec}秒后继续下载`
        }
      } else if (event === 'TaskCreate') {
        const { chapterInfo, downloadedImgCount, totalImgCount } = data

        store.progresses.set(chapterInfo.chapterId, {
          ...data,
          percentage: totalImgCount === 0 ? 0 : (downloadedImgCount / totalImgCount) * 100,
          indicator: indicator(data.state, downloadedImgCount, totalImgCount),
        })
      } else if (event === 'TaskUpdate') {
        const { chapterId, state, downloadedImgCount, totalImgCount } = data

        const progressData = store.progresses.get(chapterId)
        if (progressData === undefined) {
          return
        }

        progressData.state = state
        progressData.downloadedImgCount = downloadedImgCount
        progressData.totalImgCount = totalImgCount

        if (state === 'Completed') {
          progressData.chapterInfo.isDownloaded = true
          await syncPickedComic()
          await syncComicInSearch(progressData)
          await syncComicInFavorite(progressData)
          await syncComicInWeekly(progressData)
        }

        progressData.percentage = totalImgCount === 0 ? 0 : (downloadedImgCount / totalImgCount) * 100

        let indicator = ''
        if (state === 'Pending') {
          indicator = `排队中`
        } else if (state === 'Downloading') {
          indicator = `下载中`
        } else if (state === 'Paused') {
          indicator = `已暂停`
        } else if (state === 'Completed') {
          indicator = `下载完成`
        } else if (state === 'Failed') {
          indicator = `下载失败`
        }
        if (totalImgCount !== 0) {
          indicator += ` ${downloadedImgCount}/${totalImgCount}`
        }

        progressData.indicator = indicator
      } else if (event === 'TaskDelete') {
        store.progresses.delete(data.chapterId)
      }
    })
    .then((unListenFn) => {
      if (mounted) unListenDownloadEvent = unListenFn
      else unListenFn()
    })
  if (mounted)
    stopStartupWatch = watch(
      () => store.startupReady,
      (ready) => {
        if (ready) void restoreQueue()
      },
      { immediate: true },
    )
})

onUnmounted(() => {
  mounted = false
  stopStartupWatch?.()
  unListenDownloadEvent?.()
})

async function syncPickedComic() {
  if (store.pickedComic === undefined) {
    return
  }
  const result = await commands.getSyncedComic(store.pickedComic)
  if (result.status === 'error') {
    console.error(result.error)
    return
  }
  Object.assign(store.pickedComic, result.data)
}

async function syncComicInSearch(progressData: ProgressData) {
  if (store.searchResult === undefined) {
    return
  }
  const comic = store.searchResult.content.find((comic) => comic.id === progressData.comic.id)
  if (comic === undefined) {
    return
  }
  const result = await commands.getSyncedComicInSearch(comic)
  if (result.status === 'error') {
    console.error(result.error)
    return
  }
  Object.assign(comic, result.data)
}

async function syncComicInFavorite(progressData: ProgressData) {
  if (store.getFavoriteResult === undefined) {
    return
  }
  const comic = store.getFavoriteResult.list.find((comic) => comic.id === progressData.comic.id)
  if (comic === undefined) {
    return
  }
  const result = await commands.getSyncedComicInFavorite(comic)
  if (result.status === 'error') {
    console.error(result.error)
    return
  }
  Object.assign(comic, result.data)
}

async function syncComicInWeekly(progressData: ProgressData) {
  if (store.getWeeklyResult === undefined) {
    return
  }
  const comic = store.getWeeklyResult.list.find((comic) => comic.id === progressData.comic.id)
  if (comic === undefined) {
    return
  }
  const result = await commands.getSyncedComicInWeekly(comic)
  if (result.status === 'error') {
    console.error(result.error)
    return
  }
  Object.assign(comic, result.data)
}

async function showDownloadDirInFileManager() {
  if (store.config === undefined) {
    return
  }
  const result = await commands.showPathInFileManager(store.config.downloadDir)
  if (result.status === 'error') {
    console.error(result.error)
  }
}

async function selectDownloadDir() {
  if (store.config === undefined) {
    return
  }

  const selectedDirPath = await open({ directory: true })
  if (selectedDirPath === null) {
    return
  }

  store.config.downloadDir = selectedDirPath
}
</script>

<template>
  <div v-if="store.config !== undefined" class="flex flex-col flex-1 overflow-auto">
    <n-alert v-if="restoreError" type="error" class="m-2" title="恢复下载队列失败">
      {{ restoreError }}
      <n-button class="mt-2" size="small" :loading="restoring" @click="restoreQueue">重试恢复</n-button>
    </n-alert>
    <span v-if="restoring" class="px-2 pt-2 text-sm" role="status">正在恢复上次的下载任务…</span>
    <div class="flex gap-1 box-border px-2 pt-2.5">
      <n-input-group class="">
        <n-input-group-label size="small">下载目录</n-input-group-label>
        <n-input v-model:value="store.config.downloadDir" size="small" readonly @click="selectDownloadDir" />
        <n-button class="w-10" size="small" @click="showDownloadDirInFileManager">
          <template #icon>
            <n-icon size="20">
              <PhFolderOpen />
            </n-icon>
          </template>
        </n-button>
      </n-input-group>
      <n-button size="small" @click="settingsDialogShowing = true">
        <template #icon>
          <n-icon size="20">
            <PhGearSix />
          </n-icon>
        </template>
        配置
      </n-button>
    </div>
    <n-tabs class="h-full overflow-auto" v-model:value="store.progressesPaneTabName" type="line" size="small">
      <n-tab-pane class="h-full p-0! overflow-auto" name="uncompleted" tab="未完成">
        <UncompletedProgresses />
      </n-tab-pane>
      <n-tab-pane class="h-full p-0! overflow-auto" name="completed" tab="已完成">
        <CompletedProgresses />
      </n-tab-pane>
      <n-tab-pane class="h-full p-0! overflow-auto" name="export" tab="导出进度" display-directive="show">
        <ExportProgresses />
      </n-tab-pane>

      <template #suffix>
        <span class="whitespace-nowrap text-ellipsis overflow-hidden">{{ downloadSpeed }}</span>
      </template>
    </n-tabs>
    <SettingsDialog v-model:showing="settingsDialogShowing" />
  </div>
</template>
