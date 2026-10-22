import type { ReaderLayout } from './history.ts'

export type ReaderFit = 'screen' | 'width' | 'height'
export interface ReaderDisplay {
  readonly layout: ReaderLayout
  readonly fit: ReaderFit
  readonly scale: number
}
export interface ReaderDisplays {
  readonly defaults: ReaderDisplay | null
  readonly comics: Readonly<Record<string, ReaderDisplay>>
}
export const DISPLAY_KEY = 'jmcomic.reader-display.v1'
export const EMPTY_DISPLAYS: ReaderDisplays = { defaults: null, comics: {} }

class DisplayDataError extends Error {
  constructor() { super('阅读显示设置格式无效，原设置已保留') }
}
function parseDisplay(value: unknown): ReaderDisplay {
  if (typeof value !== 'object' || value === null || !('layout' in value) ||
    (value.layout !== 'single' && value.layout !== 'scroll') || !('fit' in value) ||
    (value.fit !== 'screen' && value.fit !== 'width' && value.fit !== 'height') ||
    !('scale' in value) || typeof value.scale !== 'number' || !Number.isFinite(value.scale) ||
    value.scale < 25 || value.scale > 300) throw new DisplayDataError()
  return { layout: value.layout, fit: value.fit, scale: value.scale }
}
export function loadDisplays(storage: Pick<Storage, 'getItem'>): ReaderDisplays {
  const raw = storage.getItem(DISPLAY_KEY)
  if (raw === null) return EMPTY_DISPLAYS
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || !('defaults' in value) ||
    !('comics' in value) || typeof value.comics !== 'object' || value.comics === null || Array.isArray(value.comics)) {
    throw new DisplayDataError()
  }
  return {
    defaults: value.defaults === null ? null : parseDisplay(value.defaults),
    comics: Object.fromEntries(Object.entries(value.comics).map(([id, display]) => {
      if (!/^\d+$/.test(id)) throw new DisplayDataError()
      return [id, parseDisplay(display)]
    })),
  }
}
export function displayFor(displays: ReaderDisplays, comicId: number, fallbackLayout: ReaderLayout): ReaderDisplay {
  return displays.comics[String(comicId)] ?? displays.defaults ?? { layout: fallbackLayout, fit: 'screen', scale: 100 }
}
export function pageWidth(fit: ReaderFit, scale: number, ratio: number, width: number, height: number) {
  const factor = scale / 100
  switch (fit) {
    case 'width': return width * factor
    case 'height': return height * ratio * factor
    case 'screen': return Math.min(width, height * ratio) * factor
  }
}
