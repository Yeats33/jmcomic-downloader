<script setup lang="tsx">
import { ProgressData } from '../../../types.ts'
import { ref, watchEffect, computed, nextTick, useTemplateRef, defineComponent, PropType } from 'vue'
import { PartialSelectionOptions, SelectionArea, SelectionEvent } from '@viselect/vue'
import { commands } from '../../../bindings.ts'
import { DropdownOption, NAlert, NButton, NDropdown, NIcon, NProgress, ProgressProps, useDialog } from 'naive-ui'
import { useStore } from '../../../store.ts'
import {
  PhPause,
  PhChecks,
  PhTrash,
  PhCaretRight,
  PhCloudArrowDown,
  PhClock,
  PhWarningCircle,
} from '@phosphor-icons/vue'

const store = useStore()
const dialog = useDialog()
const priorityError = ref('')
const queuePosition = (id: number) => {
  const index = store.downloadOrder.indexOf(id)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}
async function prioritize(chapterId: number) {
  try {
    const result = await commands.prioritizeDownloadTask(chapterId)
    priorityError.value = result.status === 'error' ? result.error.message : ''
  } catch (cause) { priorityError.value = cause instanceof Error ? cause.message : String(cause) }
}

const selectionOptions: PartialSelectionOptions = {
  selectables: '.selectable',
  features: { deselectOnBlur: true },
  boundaries: '.uncompleted-progresses-selection-container',
}
const selectionAreaRef = useTemplateRef('selectionAreaRef')
const selectedIds = ref<Set<number>>(new Set())
const selectableRefs = useTemplateRef('selectableRefs')

const uncompletedProgresses = computed<[number, ProgressData][]>(() =>
  Array.from(store.progresses.entries())
    .filter(([, { state }]) => state !== 'Completed' && state !== 'Cancelled')
    .sort((a, b) => queuePosition(a[0]) - queuePosition(b[0]) || a[0] - b[0]),
)

watchEffect(() => {
  // 只保留未完成的章节id
  const uncompletedIds = new Set(uncompletedProgresses.value.map(([chapterId]) => chapterId))
  for (const id of selectedIds.value) {
    if (!uncompletedIds.has(id)) {
      selectedIds.value.delete(id)
    }
  }
})

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
  extractIds(added).forEach((id) => selectedIds.value.add(id))
  extractIds(removed).forEach((id) => selectedIds.value.delete(id))
}

function unselectAll({ event, selection }: SelectionEvent) {
  if (!event?.ctrlKey && !event?.metaKey) {
    selection.clearSelection()
    selectedIds.value.clear()
  }
}

async function pauseAllDownloads() {
  for (const [chapterId, { state }] of uncompletedProgresses.value) {
    if (state === 'Pending' || state === 'Downloading') {
      const result = await commands.pauseDownloadTask(chapterId)
      if (result.status === 'error') {
        console.error(result.error)
      }
    }
  }
}

function confirmDeleteSelected() {
  if (selectedIds.value.size === 0) {
    return
  }

  dialog.warning({
    title: '删除下载任务',
    content: `确定删除选中的 ${selectedIds.value.size} 个下载任务吗？这会清理对应的临时文件。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      for (const chapterId of selectedIds.value) {
        const result = await commands.deleteDownloadTask(chapterId)
        if (result.status === 'error') {
          console.error(result.error)
          continue
        }

        store.progresses.delete(chapterId)
        if (store.readerChapterId === chapterId) {
          store.readerComic = null
          store.readerChapterId = null
          store.readerChapterTitle = ''
        }
      }

      selectedIds.value.clear()
      selectionAreaRef.value?.selection?.clearSelection()
    },
  })
}

const dropdownX = ref<number>(0)
const dropdownY = ref<number>(0)
const dropdownShowing = ref<boolean>(false)
const dropdownOptions: DropdownOption[] = [
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
        if (selectionAreaRef.value === undefined || selectableRefs.value === null) {
          dropdownShowing.value = false
          return
        }
        const selection = selectionAreaRef.value?.selection
        if (selection === undefined) {
          dropdownShowing.value = false
          return
        }
        selection.select(selectableRefs.value.map((ref) => ref?.$el))
        dropdownShowing.value = false
      },
    },
  },
  {
    label: '继续',
    key: 'resume',
    icon: () => (
      <NIcon size="20">
        <PhCaretRight />
      </NIcon>
    ),
    props: {
      onClick: () => {
        selectedIds.value.forEach(async (chapterId) => {
          const result = await commands.resumeDownloadTask(chapterId)
          if (result.status === 'error') {
            console.error(result.error)
          }
        })
        dropdownShowing.value = false
      },
    },
  },
  {
    label: '暂停',
    key: 'pause',
    icon: () => (
      <NIcon size="20">
        <PhPause />
      </NIcon>
    ),
    props: {
      onClick: () => {
        selectedIds.value.forEach(async (chapterId) => {
          const progressData = store.progresses.get(chapterId)
          if (progressData === undefined) {
            return
          }
          const { state } = progressData
          if (state === 'Completed' || state === 'Failed') {
            return
          }

          const result = await commands.pauseDownloadTask(chapterId)
          if (result.status === 'error') {
            console.error(result.error)
          }
        })
        dropdownShowing.value = false
      },
    },
  },
  {
    label: '取消',
    key: 'cancel',
    icon: () => (
      <NIcon size="20">
        <PhTrash />
      </NIcon>
    ),
    props: {
      onClick: () => {
        selectedIds.value.forEach(async (chapterId) => {
          const progressData = store.progresses.get(chapterId)
          if (progressData === undefined) {
            return
          }
          const { state } = progressData
          if (state === 'Cancelled' || state === 'Completed' || state === 'Failed') {
            return
          }

          const result = await commands.cancelDownloadTask(chapterId)
          if (result.status === 'error') {
            console.error(result.error)
          }
        })
        dropdownShowing.value = false
      },
    },
  },
  {
    label: '删除',
    key: 'delete',
    icon: () => (
      <NIcon size="20">
        <PhTrash />
      </NIcon>
    ),
    props: {
      onClick: () => {
        dropdownShowing.value = false
        confirmDeleteSelected()
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

const UncompletedProgress = defineComponent({
  name: 'UncompletedProgress',
  props: {
    p: {
      type: Object as PropType<ProgressData>,
      required: true,
    },
  },
  setup(props) {
    async function onDoubleClick() {
      const chapterId = props.p.chapterInfo.chapterId
      if (props.p.state === 'Downloading' || props.p.state === 'Pending') {
        const result = await commands.pauseDownloadTask(chapterId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      } else if (props.p.state === 'Paused') {
        const result = await commands.resumeDownloadTask(chapterId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      } else {
        const progressData = store.progresses.get(chapterId)
        if (progressData === undefined) {
          return
        }
        const { comic } = progressData
        const result = await commands.createDownloadTask(comic, chapterId)
        if (result.status === 'error') {
          console.error(result.error)
        }
      }
    }

    function onContextMenu() {
      const chapterId = props.p.chapterInfo.chapterId
      if (selectedIds.value.has(chapterId)) {
        return
      }
      selectedIds.value.clear()
      selectedIds.value.add(chapterId)
    }

    const progressStatus = computed<ProgressProps['status']>(() => {
      if (props.p.state === 'Completed') {
        return 'success'
      } else if (props.p.state === 'Paused') {
        return 'warning'
      } else if (props.p.state === 'Failed') {
        return 'error'
      } else {
        return 'default'
      }
    })

    const colorClass = computed<string>(() => {
      if (props.p.state === 'Downloading') {
        return 'text-blue-500'
      } else if (props.p.state === 'Pending') {
        return 'text-gray-500'
      } else if (props.p.state === 'Paused') {
        return 'text-yellow-500'
      } else if (props.p.state === 'Failed') {
        return 'text-red-500'
      } else if (props.p.state === 'Completed') {
        return 'text-green-500'
      }

      return ''
    })

    const ProgressContent = () => {
      if (Number.isNaN(props.p.percentage)) {
        return <div class="ml-auto">{props.p.indicator}</div>
      }

      return (
        <NProgress
          class={colorClass.value}
          status={progressStatus.value}
          percentage={props.p.percentage}
          processing={props.p.state === 'Downloading'}>
          {props.p.indicator}
        </NProgress>
      )
    }

    return () => (
      <div
        data-download-id={props.p.chapterInfo.chapterId}
        class={[
          'selectable p-3 mb-2 rounded-lg',
          selectedIds.value.has(props.p.chapterInfo.chapterId) ? 'selected shadow-md' : 'hover:bg-gray-1',
        ]}
        onDblclick={onDoubleClick}
        onContextmenu={onContextMenu}>
        <div class="grid grid-cols-[1fr_1fr]">
          <div class="text-ellipsis whitespace-nowrap overflow-hidden" title={props.p.comic.name}>
            {props.p.comic.name}
          </div>
          <div class="text-ellipsis whitespace-nowrap overflow-hidden" title={props.p.chapterInfo.chapterTitle}>
            {props.p.chapterInfo.chapterTitle}
          </div>
        </div>
        <div class={`flex items-center mt-1 ${colorClass.value}`}>
          <NIcon class={[colorClass.value, 'mr-2']} size={20}>
            {props.p.state === 'Downloading' && <PhCloudArrowDown />}
            {props.p.state === 'Pending' && <PhClock />}
            {props.p.state === 'Paused' && <PhPause />}
            {props.p.state === 'Failed' && <PhWarningCircle />}
          </NIcon>
          <ProgressContent />
        </div>
        <NButton size="tiny" disabled={props.p.state === 'Downloading'}
          onClick={(event: MouseEvent) => { event.stopPropagation(); void prioritize(props.p.chapterInfo.chapterId) }}>
          优先下载
        </NButton>
      </div>
    )
  },
})
</script>

<template>
  <div class="uncompleted-progresses-selection-container h-full flex flex-col px-2" @contextmenu="showDropdown">
    <n-alert v-if="priorityError" type="error">{{ priorityError }}</n-alert>
    <p class="text-sm text-gray-6 m-0 mb-2">优先下载会调整排队顺序，正在下载的任务继续，暂停状态不变。</p>
    <div class="flex items-center gap-2 pb-2 select-none">
      <span class="text-sm text-gray-500">左键拖动进行框选，右键打开菜单，双击暂停/继续</span>
      <n-button class="ml-auto" size="small" @click="pauseAllDownloads">暂停全部</n-button>
      <n-button size="small" type="error" ghost :disabled="selectedIds.size === 0" @click="confirmDeleteSelected">
        删除选中
      </n-button>
    </div>
    <SelectionArea ref="selectionAreaRef" :options="selectionOptions" @move="updateSelectedIds" @start="unselectAll" />
    <div class="h-full select-none">
      <UncompletedProgress
        ref="selectableRefs"
        v-for="[chapterId, p] in uncompletedProgresses"
        :key="chapterId"
        :data-key="chapterId"
        :p="p" />
    </div>
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
.uncompleted-progresses-selection-container {
  @apply select-none overflow-auto;
}

.uncompleted-progresses-selection-container .selected {
  @apply bg-[rgb(204,232,255)];
}

:global(.selection-area) {
  @apply bg-[rgba(46,115,252,0.5)];
}
</style>
