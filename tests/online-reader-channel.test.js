import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Channel } from '@tauri-apps/api/core'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'

const previousWindow = globalThis.window

beforeEach(() => {
  globalThis.window = { crypto: globalThis.crypto }
  mockIPC(async () => {})
})

afterEach(() => {
  clearMocks()
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
})

describe('online reader channel compatibility with the Tauri backend', () => {
  test('delivers image chunks and completion using the stable backend envelope', () => {
    const channel = new Channel()
    const received = []
    channel.onmessage = (event) => received.push(event)
    const deliver = window[`_${channel.id}`]
    const events = [
      { event: 'Chunk', data: [137, 80, 78, 71] },
      { event: 'Complete', data: { mime: 'image/png', blocks: 0 } },
    ]

    events.forEach((message, index) => deliver({ message, index }))
    deliver({ end: true, index: events.length })

    expect(received).toEqual(events)
    expect(Object.hasOwn(window, `_${channel.id}`)).toBe(false)
  })

  test('orders delayed image chunks before completion and releases the callback', () => {
    const channel = new Channel()
    const received = []
    channel.onmessage = (event) => received.push(event)
    const deliver = window[`_${channel.id}`]
    const events = [
      ...Array.from({ length: 12 }, (_, index) => ({ event: 'Chunk', data: [index] })),
      { event: 'Complete', data: { mime: 'image/jpeg', blocks: 10 } },
    ]

    deliver({ end: true, index: events.length })
    for (let index = events.length - 1; index >= 0; index--) {
      deliver({ message: events[index], index })
    }

    expect(received).toEqual(events)
    expect(Object.hasOwn(window, `_${channel.id}`)).toBe(false)
  })
})
