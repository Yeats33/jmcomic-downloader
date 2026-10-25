import { describe, expect, test } from 'bun:test'
import { filterInventory } from '../src/inventory.ts'

const comics = [
  {
    id: 1,
    name: '旅行 10',
    author: ['作者甲'],
    tags: ['冒险'],
    chapterInfos: [{ isDownloaded: true }, { isDownloaded: false }],
  },
  { id: 2, name: '旅行 2', author: ['作者乙'], tags: ['日常'], chapterInfos: [{ isDownloaded: true }] },
  { id: 3, name: '山间故事', author: ['作者甲'], tags: ['日常', '冒险'], chapterInfos: [{ isDownloaded: true }] },
]
const defaults = { query: '', tag: null, status: 'all', sort: 'title' }

describe('inventory filtering', () => {
  test('combines author and tag words across the entire inventory', () => {
    expect(filterInventory(comics, { ...defaults, query: '作者甲 日常' }).map((comic) => comic.id)).toEqual([3])
  })
  test('combines tag and download completeness filters', () => {
    expect(filterInventory(comics, { ...defaults, tag: '冒险', status: 'partial' }).map((comic) => comic.id)).toEqual([
      1,
    ])
    expect(filterInventory(comics, { ...defaults, tag: '冒险', status: 'complete' }).map((comic) => comic.id)).toEqual([
      3,
    ])
  })
  test('sorts numbered titles naturally without mutating the source inventory', () => {
    expect(filterInventory(comics, { ...defaults, query: '旅行' }).map((comic) => comic.id)).toEqual([2, 1])
    expect(comics.map((comic) => comic.id)).toEqual([1, 2, 3])
  })
  test('returns an empty result when the query has no match', () => {
    expect(filterInventory(comics, { ...defaults, query: '不存在' })).toEqual([])
  })
})
