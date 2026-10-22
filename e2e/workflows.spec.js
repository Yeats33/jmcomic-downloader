import { test, expect } from '@playwright/test'

const runtimeErrors = new WeakMap()

test.beforeEach(async ({ page }) => {
  const errors = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://**/*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#dce9ef"/></svg>',
    }),
  )
  await page.goto('/tests/workflows.html')
  await expect(page.getByRole('button', { name: '下载勾选章节', exact: true })).toBeVisible()
})
test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([])
})
const tab = (page, name) => page.locator('.n-tabs-tab').filter({ hasText: new RegExp(`^${name}$`) })
const localReader = (page) => page.getByRole('dialog', { name: '本地阅读', exact: true })
const onlineReader = (page) => page.getByRole('dialog', { name: '在线阅读', exact: true })
async function openLocal(page) {
  await tab(page, '章节详情').click()
  await page.getByRole('button', { name: '阅读', exact: true }).first().click()
  await expect(localReader(page).getByRole('img', { name: /第 \d+ 页$/ })).toHaveAttribute('alt', /第 1 页$/)
}
async function openOnline(page) {
  await tab(page, '章节详情').click()
  await page.locator('.n-radio-button').filter({ hasText: '在线阅读' }).click()
  await page.getByRole('button', { name: '第1话 · 阅读测试', exact: true }).click()
  await expect(onlineReader(page).getByRole('img', { name: /第 \d+ 页$/ })).toHaveAttribute('alt', /第 1 页$/)
}
async function jump(reader, page) {
  await reader.getByRole('textbox', { name: '跳转页码' }).fill(String(page))
  await reader.getByRole('button', { name: '跳转', exact: true }).click()
  await expect(reader.getByRole('img', { name: /第 \d+ 页$/ })).toHaveAttribute('alt', new RegExp(`第 ${page} 页$`))
}

test('context deletion only deletes the highlighted comic and preserves other checkboxes', async ({ page }) => {
  await tab(page, '本地库存').click()
  await page.getByRole('textbox', { name: '搜索库存' }).fill('Fixture')
  await page.locator('[data-key="90001"] .n-checkbox').click()
  await page.locator('[data-key="90002"]').click({ button: 'right' })
  await page.getByText('删除选中项', { exact: true }).click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toContainText('1 部漫画')
  await expect(dialog).toContainText('Fixture B')
  await expect(dialog).not.toContainText('Fixture A')
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.locator('[data-key="90002"]')).toHaveCount(0)
  await expect(page.locator('[data-key="90001"] .n-checkbox')).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => window.workflowQa.deleted)).toEqual([90002])
})

test('empty search replaces previous results and removes pagination', async ({ page }) => {
  await tab(page, '搜索').click()
  const input = page.locator('.n-tab-pane:visible input').first()
  await input.fill('known')
  await input.press('Enter')
  await expect(page.getByText('Old search result', { exact: true })).toBeVisible()
  await input.fill('empty')
  await input.press('Enter')
  await expect(page.getByText('什么都没有搜到，请尝试其他关键词')).toBeVisible()
  await expect(page.getByText('Old search result', { exact: true })).toHaveCount(0)
  await expect(page.locator('.n-tab-pane:visible .n-pagination')).toHaveCount(0)
})

test('late local response cannot replace a newly opened chapter', async ({ page }) => {
  await page.evaluate(() => {
    window.workflowQa.deferLocal = true
  })
  await page.getByRole('button', { name: '阅读', exact: true }).nth(0).click()
  await expect(localReader(page)).toContainText('第1话')
  await localReader(page).getByRole('button', { name: '关闭本地阅读' }).click()
  await page.getByRole('button', { name: '阅读', exact: true }).nth(1).click()
  await page.evaluate(() => window.workflowQa.pendingLocal.get(102)())
  await expect(localReader(page).getByRole('img', { name: /第 \d+ 页$/ })).toHaveAttribute('src', /102/)
  await page.evaluate(() => window.workflowQa.pendingLocal.get(101)())
  await expect(localReader(page).getByRole('img', { name: /第 \d+ 页$/ })).toHaveAttribute('src', /102/)
  await expect(localReader(page)).toContainText('第2话')
})

test('local page and layout survive closing and restarting the frontend', async ({ page }) => {
  await openLocal(page)
  await jump(localReader(page), 4)
  await localReader(page).getByText('连续滚动', { exact: true }).click()
  await localReader(page).getByRole('button', { name: '关闭本地阅读' }).click()
  await page.reload()
  await tab(page, '阅读记录').click()
  await expect(page.getByText('本地阅读 · 第 4 / 6 页', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续阅读', exact: true }).click()
  await expect(localReader(page)).toContainText('第 4 / 6 页')
  await expect(localReader(page).getByRole('radio', { name: '连续滚动' })).toBeChecked()
})

test('online continue reading starts at the saved page', async ({ page }) => {
  await openOnline(page)
  await jump(onlineReader(page), 4)
  await onlineReader(page).getByRole('button', { name: '关闭在线阅读' }).click()
  await page.reload()
  await tab(page, '阅读记录').click()
  await page.getByRole('button', { name: '继续阅读', exact: true }).click()
  await expect(onlineReader(page).getByRole('img', { name: /第 \d+ 页$/ })).toHaveAttribute('alt', /第 4 页$/)
  const requested = await page.evaluate(() =>
    window.workflowQa.requests
      .filter((request) => request.command === 'stream_online_page')
      .map((request) => request.page),
  )
  expect(requested[0]).toBe(3)
})

test('local reader changes chapters without closing and stops automatic reading at the final chapter', async ({ page }) => {
  await openLocal(page)
  const reader = localReader(page)
  await reader.getByRole('button', { name: '下一章', exact: true }).click()
  await expect(reader.getByRole('img', { name: /第 1 页$/ })).toHaveAttribute('src', /102/)
  await reader.getByRole('checkbox', { name: '自动下一章' }).check()
  await jump(reader, 6)
  await reader.getByRole('button', { name: '接着读下一章', exact: true }).click()
  await expect(reader.getByRole('img', { name: /第 1 页$/ })).toHaveAttribute('src', /103/)
  await jump(reader, 6)
  await expect(reader.getByRole('button', { name: '下一章', exact: true })).toBeDisabled()
  await expect(reader.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
})

test('display preferences survive chapter changes and restart for the same comic', async ({ page }) => {
  await openLocal(page)
  const reader = localReader(page)
  await reader.getByText('适宽', { exact: true }).click()
  await reader.getByRole('button', { name: '放大', exact: true }).click()
  await reader.getByRole('button', { name: '下一章', exact: true }).click()
  await expect(reader.getByRole('radio', { name: '适宽', exact: true })).toBeChecked()
  await expect(reader.getByRole('button', { name: '重置缩放' })).toHaveText('125%')
  await reader.getByRole('img', { name: /第 1 页$/ }).evaluate((image) => image.decode())
  await page.reload()
  await tab(page, '阅读记录').click()
  await page.getByRole('button', { name: '继续阅读', exact: true }).click()
  await expect(localReader(page).getByRole('radio', { name: '适宽', exact: true })).toBeChecked()
  await expect(localReader(page).getByRole('button', { name: '重置缩放' })).toHaveText('125%')
})

test('online page failure is visible and retry reloads the image', async ({ page }) => {
  await page.evaluate(() => {
    const qa = window.workflowQa
    qa.failPage = 0
    qa.store.openOnlineReader(qa.comic, qa.comic.chapterInfos[0])
  })
  await expect(onlineReader(page).getByText('测试页面加载失败', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.workflowQa.failPage = null
  })
  await onlineReader(page).getByRole('button', { name: '重试', exact: true }).click()
  await expect(onlineReader(page).getByRole('img', { name: /第 1 页$/ })).toBeVisible()
})

test('Escape closes the chapter selector before closing the online reader', async ({ page }) => {
  await openOnline(page)
  await onlineReader(page).locator('.n-select').click()
  await expect(page.locator('.n-base-select-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-base-select-menu')).toBeHidden()
  await expect(onlineReader(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(onlineReader(page)).toHaveCount(0)
})

for (const mode of ['local', 'online'])
  test(`${mode} corrupt image preserves the last readable bookmark`, async ({ page }) => {
    await page.evaluate((mode) => {
      if (mode === 'local') window.workflowQa.failedLocalPage = 2
      else window.workflowQa.corruptPage = 1
    }, mode)
    if (mode === 'local') await openLocal(page)
    else await openOnline(page)
    const reader = mode === 'local' ? localReader(page) : onlineReader(page)
    await reader.getByRole('img', { name: /第 1 页$/ }).evaluate((image) => image.decode())
    await reader.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(reader.getByText('图片显示失败，请重试', { exact: true })).toBeVisible()
    await reader.getByRole('button', { name: mode === 'local' ? '关闭本地阅读' : '关闭在线阅读' }).click()
    await tab(page, '阅读记录').click()
    await expect(
      page.getByText(`${mode === 'local' ? '本地阅读' : '在线阅读'} · 第 1 / 6 页`, { exact: true }),
    ).toBeVisible()
  })

for (const mode of ['local', 'online'])
  test(`${mode} continuous scrolling updates the current page`, async ({ page }) => {
    if (mode === 'local') await openLocal(page)
    else await openOnline(page)
    const reader = mode === 'local' ? localReader(page) : onlineReader(page)
    await reader.getByText('连续滚动', { exact: true }).click()
    await reader.locator('.reader-viewport').evaluate((root) => {
      const target = root.querySelector('[data-reader-page="4"]')
      root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top
    })
    await expect(reader.getByRole('textbox', { name: '跳转页码' })).toHaveValue('4')
    await expect(reader.locator('[data-reader-page="4"] img')).toBeVisible()
    if (mode === 'online') expect(await page.evaluate(() => window.workflowQa.urls.size)).toBeLessThanOrEqual(3)
  })

test('continuous reading reserves space for images that have not loaded', async ({ page }) => {
  const pending = []
  await page.route('**/tests/delayed-image/**', (route) => {
    pending.push(route)
  })
  await page.evaluate(() => {
    window.workflowQa.deferImages = true
  })
  try {
    await openLocal(page)
    await localReader(page).getByText('连续滚动', { exact: true }).click()
    const bounds = await localReader(page).locator('[data-reader-page="6"]').boundingBox()
    expect(bounds?.height).toBeGreaterThan(0)
  } finally {
    for (const route of pending) await route.abort()
  }
})

test('inventory filters all pages and clears selection before operating on filtered results', async ({ page }) => {
  await tab(page, '本地库存').click()
  await page.locator('[data-key="90003"] .n-checkbox').click()
  await page.getByRole('textbox', { name: '搜索库存' }).fill('库存 25')
  await expect(page.locator('.downloaded-pane-selection-container [data-key]')).toHaveCount(1)
  await expect(page.getByText('库存 25', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '删除库存', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: '搜索库存' }).fill('不存在')
  await expect(page.getByText('没有匹配的漫画，请调整搜索或筛选条件')).toBeVisible()
})

test('restored paused queue is displayed and can resume then pause across reload', async ({ page }) => {
  await page.evaluate(() => window.workflowQa.seedPausedQueue())
  await page.reload()
  await expect(page.getByText('已暂停 2/6', { exact: true })).toBeVisible()
  await page.getByText('已暂停 2/6', { exact: true }).dblclick()
  await expect(page.getByText('下载中 2/6', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '暂停全部', exact: true }).click()
  await expect(page.getByText('已暂停 2/6', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('已暂停 2/6', { exact: true })).toBeVisible()
})
