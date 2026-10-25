<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NEmpty } from 'naive-ui'
import { commands } from '../bindings.ts'
import type { ChapterHealth, Comic } from '../bindings.ts'
import { useStore } from '../store.ts'

const store = useStore()
const comics = ref<Comic[]>([])
const selectedComics = ref(new Set<number>())
const selectedPages = ref(new Set<string>())
const reports = ref<ChapterHealth[]>([])
const errors = ref<string[]>([])
const verifyRemote = ref(true)
const checking = ref(false)
const repairing = ref(false)
const stopRequested = ref(false)
const progress = ref('')
const repaired = ref(0)
const busy = computed(() => checking.value || repairing.value)
const key = (report: ChapterHealth, page: number) => `${report.comicId}:${report.chapterId}:${page}`
watch(
  () => store.currentTabName,
  async (tab) => {
    if (tab !== 'integrity' || busy.value) return
    try {
      comics.value = await commands.getDownloadedComics()
      selectedComics.value = new Set(comics.value.map((comic) => comic.id))
    } catch (cause) {
      errors.value = [cause instanceof Error ? cause.message : String(cause)]
    }
  },
  { immediate: true },
)
function selectComic(id: number, selected: boolean) {
  if (selected) selectedComics.value.add(id)
  else selectedComics.value.delete(id)
}
function selectPage(id: string, selected: boolean) {
  if (selected) selectedPages.value.add(id)
  else selectedPages.value.delete(id)
}
async function inspect() {
  checking.value = true
  stopRequested.value = false
  reports.value = []
  errors.value = []
  selectedPages.value.clear()
  repaired.value = 0
  const chapters = comics.value
    .filter((comic) => selectedComics.value.has(comic.id))
    .flatMap((comic) =>
      comic.chapterInfos.filter((chapter) => chapter.isDownloaded === true).map((chapter) => ({ comic, chapter })),
    )
  try {
    for (const [index, { comic, chapter }] of chapters.entries()) {
      if (stopRequested.value) break
      progress.value = `正在检查 ${index + 1} / ${chapters.length}：${chapter.chapterTitle}`
      try {
        const result = await commands.inspectChapter(comic, chapter.chapterId, verifyRemote.value)
        if (result.status === 'error')
          errors.value.push(`${comic.name} / ${chapter.chapterTitle}：${result.error.message}`)
        else {
          reports.value.push(result.data)
          for (const issue of result.data.issues)
            if (issue.repairable) selectedPages.value.add(key(result.data, issue.page))
        }
      } catch (cause) {
        errors.value.push(`${chapter.chapterTitle}：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    progress.value = `${stopRequested.value ? '检查已停止' : '检查完成'}：${reports.value.length} 个章节，${reports.value.reduce((count, report) => count + report.issues.length, 0)} 页异常`
  } finally {
    checking.value = false
  }
}
async function repair() {
  repairing.value = true
  stopRequested.value = false
  errors.value = []
  repaired.value = 0
  try {
    for (const report of reports.value) {
      const comic = comics.value.find((item) => item.id === report.comicId)
      for (const issue of [...report.issues]) {
        if (stopRequested.value) return
        if (!issue.repairable || !selectedPages.value.has(key(report, issue.page))) continue
        if (comic === undefined) {
          errors.value.push(`${report.chapterTitle} 第 ${issue.page} 页：本地库存中找不到这部漫画，请重新检查`)
          continue
        }
        progress.value = `正在修复：${report.chapterTitle} 第 ${issue.page} 页`
        try {
          const result = await commands.repairChapterPage(comic, report.chapterId, issue.page)
          if (result.status === 'error')
            errors.value.push(`${report.chapterTitle} 第 ${issue.page} 页：${result.error.message}`)
          else {
            report.issues = report.issues.filter((item) => item.page !== issue.page)
            selectedPages.value.delete(key(report, issue.page))
            repaired.value++
          }
        } catch (cause) {
          errors.value.push(cause instanceof Error ? cause.message : String(cause))
        }
      }
    }
  } finally {
    repairing.value = false
    progress.value = `${stopRequested.value ? '修复已停止' : '修复结束'}：${repaired.value} 页已恢复正常`
  }
}
onUnmounted(() => {
  stopRequested.value = true
})
</script>

<template>
  <div class="h-full min-h-0 flex flex-col p-2 gap-2 box-border">
    <h2 class="m-0 text-base font-semibold">库存体检</h2>
    <p class="m-0 text-sm">检查已下载章节的缺页、空文件和损坏图片。修复只处理所选异常页，保留正常图片。</p>
    <n-checkbox v-model:checked="verifyRemote" :disabled="busy">联网核对总页数（旧库存建议开启）</n-checkbox>
    <div class="flex flex-wrap gap-2">
      <n-button
        size="small"
        :disabled="busy || !comics.length"
        @click="selectedComics = new Set(comics.map((comic) => comic.id))">
        全选作品
      </n-button>
      <n-button size="small" :disabled="busy" @click="selectedComics.clear()">清空选择</n-button>
      <n-button type="primary" size="small" :disabled="busy || !selectedComics.size" @click="inspect">
        开始检查
      </n-button>
      <n-button v-if="busy" size="small" :disabled="stopRequested" @click="stopRequested = true">
        {{ stopRequested ? '当前操作完成后停止' : '停止后续操作' }}
      </n-button>
    </div>
    <p v-if="progress" class="m-0 text-sm" role="status">{{ progress }}</p>
    <div class="flex-1 min-h-0 overflow-auto flex flex-col gap-2">
      <n-empty v-if="!comics.length" description="暂无本地库存，下载章节后可以检查" />
      <n-checkbox
        v-for="comic in comics"
        :key="comic.id"
        :disabled="busy"
        :checked="selectedComics.has(comic.id)"
        @update:checked="selectComic(comic.id, $event)">
        {{ comic.name }}
      </n-checkbox>
      <n-alert v-for="error in errors" :key="error" type="error">{{ error }}</n-alert>
      <article
        v-for="report in reports"
        :key="`${report.comicId}:${report.chapterId}`"
        class="border border-gray-2 rounded p-3 flex flex-col gap-2">
        <strong>{{ report.comicName }} · {{ report.chapterTitle }}</strong>
        <span class="text-sm">
          已检查 {{ report.checkedPages }} 页 ·
          {{ report.issues.length ? `${report.issues.length} 页异常` : '未发现异常' }}
        </span>
        <n-alert v-if="report.warning" type="warning">{{ report.warning }}</n-alert>
        <n-checkbox
          v-for="issue in report.issues"
          :key="issue.page"
          :disabled="busy || !issue.repairable"
          :checked="selectedPages.has(key(report, issue.page))"
          @update:checked="selectPage(key(report, issue.page), $event)">
          第 {{ issue.page }} 页：{{ issue.reason }}{{ issue.repairable ? '' : '（需要手动处理）' }}
        </n-checkbox>
      </article>
    </div>
    <n-button type="primary" :disabled="busy || !selectedPages.size" :loading="repairing" @click="repair">
      修复所选 {{ selectedPages.size }} 页
    </n-button>
  </div>
</template>
