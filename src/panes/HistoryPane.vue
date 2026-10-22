<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NEmpty, NRadioGroup, NRadioButton, useMessage } from 'naive-ui'
import { bookmarkKey, useReadingLibrary } from '../reader/library.ts'
import ReadingStatusControl from '../reader/ReadingStatusControl.vue'
import { commands } from '../bindings.ts'
import type { Comic } from '../bindings.ts'
import { useStore } from '../store.ts'
import type { ReadingProgress } from '../reader/history.ts'

const store = useStore()
const message = useMessage()
const opening = ref<string | null>(null)
const library = useReadingLibrary()
const view = ref<'history' | 'bookmarks'>('history')
const entries = computed(() => view.value === 'history' ? store.readingHistory : library.bookmarks)

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
        store.openLocalReader(comic, chapter, progress)
        break
      case 'online':
        store.openOnlineReader(comic, chapter, progress)
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
    <n-radio-group v-model:value="view" size="small" aria-label="记录分类">
      <n-radio-button value="history">最近阅读</n-radio-button>
      <n-radio-button value="bookmarks">页面书签</n-radio-button>
    </n-radio-group>
    <p class="text-sm m-0">自动记住最近 100 条阅读进度，关闭或重启后可继续阅读。</p>
    <n-alert v-if="store.readingHistoryError" type="error" :show-icon="false">{{ store.readingHistoryError }}</n-alert>
    <n-alert v-if="library.error" type="error">{{ library.error }}</n-alert>
    <n-empty v-if="entries.length === 0" class="my-8" :description="view === 'history' ? '暂无阅读记录，打开一个章节开始阅读' : '暂无书签，在阅读器中点击收藏本页'" />
    <div v-else class="min-h-0 overflow-auto flex flex-col gap-2">
      <article
        v-for="entry in entries"
        :key="bookmarkKey(entry)"
        class="border border-solid border-gray-2 rounded-md p-3 flex flex-wrap items-center gap-2">
        <div class="flex-1 min-w-0">
          <div class="font-semibold truncate" :title="entry.comicName">{{ entry.comicName }}</div>
          <div class="text-sm truncate" :title="entry.chapterTitle">{{ entry.chapterTitle }}</div>
          <div class="text-sm">
            {{ entry.mode === 'local' ? '本地阅读' : '在线阅读' }} · 第 {{ entry.page }} / {{ entry.pageCount }} 页
          </div>
        </div>
        <ReadingStatusControl :comic-id="entry.comicId" />
        <n-button v-if="view === 'bookmarks'" size="small" @click="library.toggle(entry)">移除书签</n-button>
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
