<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton, NEmpty, useMessage } from 'naive-ui'
import { commands } from '../bindings.ts'
import type { Comic } from '../bindings.ts'
import { useStore } from '../store.ts'
import type { ReadingProgress } from '../reader/history.ts'

const store = useStore()
const message = useMessage()
const opening = ref<string | null>(null)

async function resume(progress: ReadingProgress) {
  if (opening.value !== null) return
  opening.value = `${progress.mode}:${progress.comicId}`
  try {
    let comic: Comic | undefined
    switch (progress.mode) {
      case 'local':
        comic = (await commands.getDownloadedComics()).find((item) => item.id === progress.comicId)
        if (comic === undefined) {
          message.error('找不到这部漫画的本地文件，请检查下载目录或重新下载')
          return
        }
        break
      case 'online': {
        const result = await commands.getComic(progress.comicId)
        if (result.status === 'error') {
          message.error(result.error.message)
          return
        }
        comic = result.data
        break
      }
    }
    const chapter = comic.chapterInfos.find((item) => item.chapterId === progress.chapterId)
    if (chapter === undefined) {
      message.error('原章节已不存在，请从章节详情重新选择')
      return
    }
    store.pickedComic = comic
    switch (progress.mode) {
      case 'local':
        store.openLocalReader(comic, chapter)
        break
      case 'online':
        store.openOnlineReader(comic, chapter)
        break
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    opening.value = null
  }
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-col p-2 box-border gap-2">
    <h2 class="text-base font-semibold m-0">阅读记录</h2>
    <p class="text-sm m-0">自动记住最近 100 条阅读进度，关闭或重启后可继续阅读。</p>
    <n-alert v-if="store.readingHistoryError" type="error" :show-icon="false">{{ store.readingHistoryError }}</n-alert>
    <n-empty v-if="store.readingHistory.length === 0" class="my-8" description="暂无阅读记录，打开一个章节开始阅读" />
    <div v-else class="min-h-0 overflow-auto flex flex-col gap-2">
      <article
        v-for="entry in store.readingHistory"
        :key="`${entry.mode}:${entry.comicId}`"
        class="border border-solid border-gray-2 rounded-md p-3 flex flex-wrap items-center gap-2">
        <div class="flex-1 min-w-0">
          <div class="font-semibold truncate" :title="entry.comicName">{{ entry.comicName }}</div>
          <div class="text-sm truncate" :title="entry.chapterTitle">{{ entry.chapterTitle }}</div>
          <div class="text-sm">
            {{ entry.mode === 'local' ? '本地阅读' : '在线阅读' }} · 第 {{ entry.page }} / {{ entry.pageCount }} 页
          </div>
        </div>
        <n-button
          size="small"
          type="primary"
          :loading="opening === `${entry.mode}:${entry.comicId}`"
          :disabled="opening !== null"
          @click="resume(entry)">
          继续阅读
        </n-button>
      </article>
    </div>
  </div>
</template>
