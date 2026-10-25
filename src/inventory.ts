import type { Comic } from './bindings.ts'

export type InventoryStatus = 'all' | 'complete' | 'partial'
export type InventorySort = 'title' | 'title-desc' | 'author' | 'chapters'

export interface InventoryFilter {
  readonly query: string
  readonly tag: string | null
  readonly status: InventoryStatus
  readonly sort: InventorySort
}

export function filterInventory(comics: readonly Comic[], filter: InventoryFilter): Comic[] {
  const words = filter.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const result = comics.filter((comic) => {
    const text = [comic.name, ...comic.author, ...comic.tags, String(comic.id)].join(' ').toLocaleLowerCase()
    const complete =
      comic.chapterInfos.length > 0 && comic.chapterInfos.every((chapter) => chapter.isDownloaded === true)
    return (
      words.every((word) => text.includes(word)) &&
      (filter.tag === null || comic.tags.includes(filter.tag)) &&
      (filter.status === 'all' || (filter.status === 'complete' ? complete : !complete))
    )
  })
  return result.sort((left, right) => {
    const byTitle = left.name.localeCompare(right.name, 'zh-CN', { numeric: true }) || left.id - right.id
    switch (filter.sort) {
      case 'title':
        return byTitle
      case 'title-desc':
        return -byTitle
      case 'author':
        return left.author.join('、').localeCompare(right.author.join('、'), 'zh-CN') || byTitle
      case 'chapters':
        return right.chapterInfos.length - left.chapterInfos.length || byTitle
    }
  })
}
