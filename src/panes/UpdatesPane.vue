<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NEmpty, NRadioButton, NRadioGroup } from 'naive-ui'
import { commands } from '../bindings.ts'
import type { Comic, ChapterInfo } from '../bindings.ts'
import { useStore } from '../store.ts'
import { updateChapters, useFollowing } from '../following.ts'

interface Preview {
  readonly comic: Comic
  readonly chapters: readonly ChapterInfo[]
}
const store = useStore()
const following = useFollowing()
const scope = ref<'inventory' | 'followed'>('inventory')
const inventory = ref<Comic[]>([])
const sources = computed(() => (scope.value === 'inventory' ? inventory.value : following.comics))
const selectedComics = ref(new Set<number>())
const selectedChapters = ref(new Set<number>())
const previews = ref<Preview[]>([])
const errors = ref<string[]>([])
const queued = ref(new Set<number>())
const checking = ref(false)
const downloading = ref(false)
const checked = ref(false)
const progress = ref('')
let generation = 0
const busy = computed(() => checking.value || downloading.value)
function toggleComic(id: number, value: boolean) {
  if (value) selectedComics.value.add(id)
  else selectedComics.value.delete(id)
}
function toggleChapter(id: number, value: boolean) {
  if (value) selectedChapters.value.add(id)
  else selectedChapters.value.delete(id)
}
function cancel() {
  generation++
  checking.value = false
  progress.value = '检查已停止，已取得的结果保留'
}
watch(
  [scope, () => following.comics, () => store.currentTabName],
  async () => {
    if (store.currentTabName !== 'updates' || busy.value) return
    try {
      inventory.value = await commands.getDownloadedComics()
    } catch (cause) {
      errors.value = [cause instanceof Error ? cause.message : String(cause)]
    }
    selectedComics.value = new Set(sources.value.map((comic) => comic.id))
  },
  { immediate: true },
)
watch(scope, () => {
  previews.value = []
  checked.value = false
  selectedChapters.value.clear()
  queued.value.clear()
})
async function checkUpdates() {
  const current = ++generation
  const targets = sources.value.filter((comic) => selectedComics.value.has(comic.id))
  checking.value = true
  checked.value = false
  previews.value = []
  errors.value = []
  queued.value.clear()
  selectedChapters.value.clear()
  for (const [index, target] of targets.entries()) {
    if (current !== generation) return
    progress.value = `正在检查 ${index + 1} / ${targets.length}：${target.name}`
    try {
      const result = await commands.getComic(target.id)
      if (current !== generation) return
      if (result.status === 'error') errors.value.push(`${target.name}：${result.error.message}`)
      else {
        const followed = scope.value === 'followed' ? following.comics.find((item) => item.id === target.id) : undefined
        const chapters = updateChapters(result.data, followed)
        if (chapters.length) {
          previews.value.push({ comic: result.data, chapters })
          for (const chapter of chapters) selectedChapters.value.add(chapter.chapterId)
        }
      }
    } catch (cause) {
      if (current === generation)
        errors.value.push(`${target.name}：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const delay = (store.config?.updateDownloadedComicsIntervalSec ?? 0) * 1000
    if (delay > 0 && index + 1 < targets.length) await new Promise((resolve) => setTimeout(resolve, delay))
  }
  if (current !== generation) return
  checking.value = false
  checked.value = true
  progress.value = `检查完成：${previews.value.reduce((count, preview) => count + preview.chapters.length, 0)} 个可更新章节`
}
async function downloadSelected() {
  downloading.value = true
  errors.value = []
  try {
    for (const preview of previews.value)
      for (const chapter of preview.chapters) {
        if (!selectedChapters.value.has(chapter.chapterId) || queued.value.has(chapter.chapterId)) continue
        const result = await commands.createDownloadTask(preview.comic, chapter.chapterId)
        if (result.status === 'error') errors.value.push(`${chapter.chapterTitle}：${result.error.message}`)
        else {
          queued.value.add(chapter.chapterId)
          selectedChapters.value.delete(chapter.chapterId)
        }
      }
  } catch (cause) {
    errors.value.push(cause instanceof Error ? cause.message : String(cause))
  } finally {
    downloading.value = false
  }
}
function acknowledge(preview: Preview) {
  following.markSeen(preview.comic)
  if (following.error) return
  for (const chapter of preview.chapters) selectedChapters.value.delete(chapter.chapterId)
  previews.value = previews.value.filter((item) => item.comic.id !== preview.comic.id)
}
onUnmounted(() => {
  generation++
})
</script>

<template>
  <div class="h-full min-h-0 flex flex-col p-2 gap-2 box-border">
    <h2 class="m-0 text-base font-semibold">更新预览</h2>
    <p class="m-0 text-sm">先检查章节，再选择下载。追更只列出加入追更后新增且未下载的章节。</p>
    <n-radio-group v-model:value="scope" size="small" :disabled="busy" aria-label="检查范围">
      <n-radio-button value="inventory">本地库存</n-radio-button>
      <n-radio-button value="followed">我的追更</n-radio-button>
    </n-radio-group>
    <div class="flex flex-wrap gap-2">
      <n-button
        size="small"
        :disabled="busy || sources.length === 0"
        @click="selectedComics = new Set(sources.map((comic) => comic.id))">
        全选作品
      </n-button>
      <n-button size="small" :disabled="busy" @click="selectedComics.clear()">清空选择</n-button>
      <n-button size="small" type="primary" :disabled="busy || !selectedComics.size" @click="checkUpdates">
        检查更新
      </n-button>
      <n-button v-if="checking" size="small" @click="cancel">停止检查</n-button>
    </div>
    <p v-if="progress" class="m-0 text-sm" role="status">{{ progress }}</p>
    <n-alert v-if="following.error" type="error">{{ following.error }}</n-alert>
    <div class="flex-1 min-h-0 overflow-auto flex flex-col gap-2">
      <n-empty
        v-if="sources.length === 0"
        :description="scope === 'followed' ? '暂无追更，在章节详情点击追更此漫画' : '暂无本地库存'" />
      <div v-for="comic in sources" :key="comic.id" class="flex items-center gap-2">
        <n-checkbox
          :disabled="busy"
          :checked="selectedComics.has(comic.id)"
          @update:checked="toggleComic(comic.id, $event)">
          {{ comic.name }}
        </n-checkbox>
        <n-button v-if="scope === 'followed'" size="tiny" :disabled="busy" @click="following.remove(comic.id)">
          取消追更
        </n-button>
      </div>
      <n-alert v-for="error in errors" :key="error" type="error">{{ error }}</n-alert>
      <n-empty v-if="checked && !previews.length && !errors.length" description="所选作品没有需要更新的章节" />
      <article
        v-for="preview in previews"
        :key="preview.comic.id"
        class="border border-gray-2 rounded p-3 flex flex-col gap-2">
        <strong>{{ preview.comic.name }}</strong>
        <n-checkbox
          v-for="chapter in preview.chapters"
          :key="chapter.chapterId"
          :disabled="busy || queued.has(chapter.chapterId)"
          :checked="selectedChapters.has(chapter.chapterId)"
          @update:checked="toggleChapter(chapter.chapterId, $event)">
          {{ chapter.chapterTitle }}{{ queued.has(chapter.chapterId) ? ' · 已加入队列' : '' }}
        </n-checkbox>
        <n-button v-if="scope === 'followed'" size="small" :disabled="busy" @click="acknowledge(preview)">
          这些更新已阅
        </n-button>
      </article>
    </div>
    <n-button
      type="primary"
      :disabled="busy || !selectedChapters.size"
      :loading="downloading"
      @click="downloadSelected">
      下载所选 {{ selectedChapters.size }} 个章节
    </n-button>
  </div>
</template>
