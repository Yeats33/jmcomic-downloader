<script setup lang="tsx">
import { Comic, commands } from '../../bindings.ts'
import { computed, nextTick, ref, watch, watchEffect, useTemplateRef } from 'vue'
import DownloadedComicCard from './components/DownloadedComicCard.vue'
import { open } from '@tauri-apps/plugin-dialog'
import { PhFolderOpen } from '@phosphor-icons/vue'
import { useStore } from '../../store.ts'
import {
  DropdownOption,
  NButton,
  NDropdown,
  NIcon,
  NInput,
  NInputGroup,
  NInputGroupLabel,
  NPagination,
  NSelect,
  NEmpty,
  useDialog,
} from 'naive-ui'
import { PartialSelectionOptions, SelectionArea, SelectionEvent } from '@viselect/vue'
import { PhChecks, PhCheck, PhX, PhTrash } from '@phosphor-icons/vue'
import UpdateDownloadedComicsButton from './components/UpdateDownloadedComicsButton.vue'
import { filterInventory } from '../../inventory.ts'
import type { InventoryStatus, InventorySort } from '../../inventory.ts'

const store = useStore()
const dialog = useDialog()

const selectionOptions: PartialSelectionOptions = {
  selectables: '.selectable',
  features: { deselectOnBlur: true },
  boundaries: '.downloaded-pane-selection-container',
}
const selectedIds = ref<Set<number>>(new Set())
const checkedIds = ref<Set<number>>(new Set())
const { dropdownX, dropdownY, dropdownShowing, dropdownOptions, showDropdown } = useDropdown()
const selectionAreaRef = useTemplateRef('selectionAreaRef')

const PAGE_SIZE = 20
const query = ref('')
const tag = ref<string | null>(null)
const inventoryStatus = ref<InventoryStatus>('all')
const sort = ref<InventorySort>('title')
const tagOptions = computed(() =>
  [...new Set(store.downloadedComics.flatMap((comic) => comic.tags))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .map((value) => ({ label: value, value })),
)
const statusOptions = [
  { label: '全部库存', value: 'all' },
  { label: '全部章节已下载', value: 'complete' },
  { label: '部分章节已下载', value: 'partial' },
]
const sortOptions = [
  { label: '标题正序', value: 'title' },
  { label: '标题倒序', value: 'title-desc' },
  { label: '作者', value: 'author' },
  { label: '章节数量', value: 'chapters' },
]
const filteredComics = computed(() =>
  filterInventory(store.downloadedComics, {
    query: query.value,
    tag: tag.value,
    status: inventoryStatus.value,
    sort: sort.value,
  }),
)
// 当前页码
const currentPage = ref<number>(1)
// 总页数
const pageCount = computed<number>(() => {
  if (filteredComics.value.length === 0) {
    return 1
  }
  return Math.ceil(filteredComics.value.length / PAGE_SIZE)
})
// 当前页的漫画
const currentPageComics = computed<Comic[]>(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  const end = start + PAGE_SIZE
  return filteredComics.value.slice(start, end)
})
// 确保当前页码不超过总页数
watchEffect(() => {
  if (currentPage.value > pageCount.value) {
    currentPage.value = pageCount.value
  }
})

watch([query, tag, inventoryStatus, sort], () => {
  currentPage.value = 1
})
watch([currentPage, query, tag, inventoryStatus, sort], () => {
  selectedIds.value.clear()
  checkedIds.value.clear()
  selectionAreaRef.value?.selection?.clearSelection()
  selectionAreaRef.value?.$el.scrollTo({ top: 0, behavior: 'instant' })
})

// 监听标签页变化，更新下载的漫画列表
watch(
  () => store.currentTabName,
  async () => {
    if (store.currentTabName !== 'downloaded') {
      return
    }

    await reloadDownloadedComics()
  },
  { immediate: true },
)

async function reloadDownloadedComics() {
  store.downloadedComics = await commands.getDownloadedComics()
}

async function selectExportDir() {
  if (store.config === undefined) {
    return
  }

  const selectedDirPath = await open({ directory: true })
  if (selectedDirPath === null) {
    return
  }

  store.config.exportDir = selectedDirPath
}

async function showExportDirInFileManager() {
  if (store.config === undefined) {
    return
  }
  const result = await commands.showPathInFileManager(store.config.exportDir)
  if (result.status === 'error') {
    console.error(result.error)
  }
}

function extractIds(elements: Element[]): number[] {
  return elements
    .map((element) => element.getAttribute('data-key'))
    .filter(Boolean)
    .map(Number)
}

function updateSelectedIds({
  store: {
    changed: { added, removed },
  },
}: SelectionEvent) {
  extractIds(added).forEach((id) => {
    selectedIds.value.add(id)
  })
  extractIds(removed).forEach((id) => {
    selectedIds.value.delete(id)
  })
}

function unselectAll({ event, selection }: SelectionEvent) {
  if (!event?.ctrlKey && !event?.metaKey) {
    selection.clearSelection()
    selectedIds.value.clear()
  }
}

function checkboxChecked(comic: Comic): boolean {
  return checkedIds.value.has(comic.id)
}

function handleCheckboxClick(comic: Comic) {
  if (checkedIds.value.has(comic.id)) {
    checkedIds.value.delete(comic.id)
  } else {
    checkedIds.value.add(comic.id)
  }
}

function handleContextMenu(comic: Comic) {
  if (selectedIds.value.has(comic.id)) {
    return
  }

  selectedIds.value.clear()
  selectedIds.value.add(comic.id)
}

async function exportCbz() {
  if (checkedIds.value.size === 0) {
    return
  }

  store.progressesPaneTabName = 'export'
  const comics = currentPageComics.value.filter((comic) => checkedIds.value.has(comic.id))
  for (const comic of comics) {
    const result = await commands.exportCbz(comic)
    if (result.status === 'error') {
      console.error(result.error)
      return
    }
  }
}

async function exportPdf() {
  if (checkedIds.value.size === 0) {
    return
  }

  store.progressesPaneTabName = 'export'
  const comics = currentPageComics.value.filter((comic) => checkedIds.value.has(comic.id))
  for (const comic of comics) {
    const result = await commands.exportPdf(comic)
    if (result.status === 'error') {
      console.error(result.error)
      return
    }
  }
}

async function exportSinglePdf() {
  if (checkedIds.value.size === 0) {
    return
  }

  store.progressesPaneTabName = 'export'
  const comics = currentPageComics.value.filter((comic) => checkedIds.value.has(comic.id))
  for (const comic of comics) {
    const result = await commands.exportSinglePdf(comic)
    if (result.status === 'error') {
      console.error(result.error)
      return
    }
  }
}

function clearDeletedComicState(comic: Comic) {
  if (store.pickedComic?.id === comic.id) {
    store.pickedComic = undefined
    if (store.currentTabName === 'chapter') {
      store.currentTabName = 'downloaded'
    }
  }

  if (store.readerComic?.id === comic.id) {
    store.readerComic = null
    store.readerChapterId = null
    store.readerChapterTitle = ''
  }
}

function confirmDeleteComics(ids: ReadonlySet<number>) {
  if (ids.size === 0) {
    return
  }

  const comicsToDelete = currentPageComics.value.filter((comic) => ids.has(comic.id))
  if (comicsToDelete.length === 0) {
    return
  }

  dialog.warning({
    title: '删除本地库存',
    content: `确定删除这 ${comicsToDelete.length} 部漫画吗？这会删除本地下载目录。\n${comicsToDelete.map((comic) => comic.name).join('、')}`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      for (const comic of comicsToDelete) {
        const result = await commands.deleteDownloadedComic(comic)
        if (result.status === 'error') {
          console.error(result.error)
          continue
        }
        clearDeletedComicState(comic)
        checkedIds.value.delete(comic.id)
      }

      selectedIds.value.clear()
      selectionAreaRef.value?.selection?.clearSelection()
      await reloadDownloadedComics()
    },
  })
}

function useDropdown() {
  const dropdownX = ref<number>(0)
  const dropdownY = ref<number>(0)
  const dropdownShowing = ref<boolean>(false)
  const dropdownOptions: DropdownOption[] = [
    {
      label: '勾选',
      key: 'check',
      icon: () => (
        <NIcon size="20">
          <PhCheck />
        </NIcon>
      ),
      props: {
        onClick: () => {
          selectedIds.value.forEach((id) => {
            checkedIds.value.add(id)
          })
          dropdownShowing.value = false
        },
      },
    },
    {
      label: '取消勾选',
      key: 'uncheck',
      icon: () => (
        <NIcon size="20">
          <PhX />
        </NIcon>
      ),
      props: {
        onClick: () => {
          selectedIds.value.forEach((id) => {
            checkedIds.value.delete(id)
          })
          dropdownShowing.value = false
        },
      },
    },
    {
      label: '全选',
      key: 'select-all',
      icon: () => (
        <NIcon size="20">
          <PhChecks />
        </NIcon>
      ),
      props: {
        onClick: () => {
          currentPageComics.value.forEach((comic) => {
            selectedIds.value.add(comic.id)
          })
          dropdownShowing.value = false
        },
      },
    },
    {
      label: '删除选中项',
      key: 'delete-selected',
      icon: () => (
        <NIcon size="20">
          <PhTrash />
        </NIcon>
      ),
      props: {
        onClick: () => {
          dropdownShowing.value = false
          confirmDeleteComics(selectedIds.value)
        },
      },
    },
  ]

  async function showDropdown(e: MouseEvent) {
    dropdownShowing.value = false
    await nextTick()
    dropdownShowing.value = true
    dropdownX.value = e.clientX
    dropdownY.value = e.clientY
  }

  return {
    dropdownX,
    dropdownY,
    dropdownShowing,
    dropdownOptions,
    showDropdown,
  }
}
</script>

<template>
  <div v-if="store.config !== undefined" class="h-full min-h-0 flex flex-col">
    <div class="flex gap-1 box-border px-2 pt-2">
      <n-input-group>
        <n-input-group-label size="small">导出目录</n-input-group-label>
        <n-input v-model:value="store.config.exportDir" size="small" readonly @click="selectExportDir" />
        <n-button class="w-10" size="small" @click="showExportDirInFileManager">
          <template #icon>
            <n-icon size="20">
              <PhFolderOpen />
            </n-icon>
          </template>
        </n-button>
      </n-input-group>
      <update-downloaded-comics-button />
    </div>
    <div class="grid grid-cols-2 gap-2 p-2">
      <label class="col-span-2 text-sm">
        搜索库存
        <n-input
          v-model:value="query"
          size="small"
          clearable
          placeholder="标题、作者、标签或漫画 ID"
          :input-props="{ 'aria-label': '搜索库存' }" />
      </label>
      <label class="text-sm">
        标签
        <n-select
          v-model:value="tag"
          size="small"
          clearable
          filterable
          :options="tagOptions"
          placeholder="全部标签"
          aria-label="库存标签" />
      </label>
      <label class="text-sm">
        下载状态
        <n-select v-model:value="inventoryStatus" size="small" :options="statusOptions" aria-label="库存下载状态" />
      </label>
      <label class="text-sm">
        排序
        <n-select v-model:value="sort" size="small" :options="sortOptions" aria-label="库存排序" />
      </label>
      <span class="text-sm self-end pb-1" role="status">
        {{ filteredComics.length }} / {{ store.downloadedComics.length }} 部
      </span>
    </div>
    <div class="flex gap-2 items-center px-2 select-none">
      <div class="animate-pulse text-sm text-red flex flex-col">
        <div>左键拖动进行框选，右键打开菜单</div>
        <div>右边的按钮作用于勾选项</div>
      </div>
    </div>
    <div class="flex flex-wrap gap-2 items-center px-2 pb-2 select-none">
      <n-button
        class="ml-auto"
        type="error"
        ghost
        size="small"
        :disabled="checkedIds.size === 0"
        @click="confirmDeleteComics(checkedIds)">
        删除库存
      </n-button>
      <n-button type="primary" size="small" @click="exportCbz">导出cbz</n-button>
      <n-button type="primary" size="small" @click="exportPdf">导出pdf</n-button>
      <n-button type="primary" size="small" @click="exportSinglePdf">导出pdf(单文件)</n-button>
    </div>
    <SelectionArea ref="selectionAreaRef" :options="selectionOptions" @move="updateSelectedIds" @start="unselectAll" />
    <div
      class="flex-1 min-h-0 flex flex-col overflow-auto box-border px-2 downloaded-pane-selection-container mb-2"
      @contextmenu="showDropdown">
      <n-empty
        v-if="filteredComics.length === 0"
        class="my-8"
        :description="
          store.downloadedComics.length === 0
            ? '暂无本地库存，下载后会显示在这里'
            : '没有匹配的漫画，请调整搜索或筛选条件'
        " />
      <DownloadedComicCard
        v-for="comic in currentPageComics"
        :key="comic.id"
        :data-key="comic.id"
        :class="['selectable mb-2', selectedIds.has(comic.id) ? 'selected shadow-md' : 'hover:bg-gray-1']"
        :comic="comic"
        :checkbox-checked="checkboxChecked"
        :handle-checkbox-click="handleCheckboxClick"
        :handle-context-menu="handleContextMenu" />
    </div>

    <n-pagination
      class="box-border p-2 pt-0 mt-auto"
      :page-count="pageCount"
      :page="currentPage"
      @update:page="currentPage = $event" />

    <n-dropdown
      placement="bottom-start"
      trigger="manual"
      :x="dropdownX"
      :y="dropdownY"
      :options="dropdownOptions"
      :show="dropdownShowing"
      :on-clickoutside="() => (dropdownShowing = false)" />
  </div>
</template>

<style scoped>
.downloaded-pane-selection-container {
  @apply select-none overflow-auto;
}

.downloaded-pane-selection-container .selected {
  @apply bg-[rgb(204,232,255)];
}
</style>
