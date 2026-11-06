# 独立 Host 集成测试

从仓库根目录运行：

```sh
node --test dsh-plugin/integration/host.test.js dsh-plugin/integration/reader.test.js dsh-plugin/integration/cover.test.js
```

需要 Node.js 22 或更新版本、`dsh-plugin` 本身已可解析其依赖，以及本机已有 DSH 安装。测试默认从 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json` 所在安装解析 DSH 包；如安装在其他位置，可指定该安装的 `package.json` **绝对路径**：

```sh
DSH_PACKAGE_JSON=/absolute/path/to/dsh/package.json node --test dsh-plugin/integration/host.test.js dsh-plugin/integration/reader.test.js dsh-plugin/integration/cover.test.js
```

这是有意的环境依赖测试，不会安装依赖。测试使用该 DSH 安装的真实 Cordis、Typert Registry、Gateway、Remote Access、System Prompt 和 Tools，与项目的 `index.js`、`typert.js` 在内存中组装。通过真实 Gateway `invoke` 验证严格字段与类型校验、业务参数校验及禁用下载；用加密 mock fetch 响应验证匿名搜索及元数据。配置临时下载根目录后，使用 mock 章节、模板和图片经真实 Gateway 下载，以真实 Sharp 转码验证 JPEG、完成标记、拒绝覆盖及中途失败后的部分文件清理。手动 Gateway 调用无需审批；工具直接执行时显式模拟 exec.agent、callId、signal 及 Cordis 审批服务，验证缺失 agent/审批服务、拒绝/取消/不可用及取消信号不会发起网络请求，只有逐次 allowed-once 才能下载，并验证 Gateway 和工具共用下载锁。测试退出时删除自己创建的临时目录。全部请求被 mock，不启动 Web server，不读取或修改实际用户 profile。

阅读测试通过真实 Gateway `readPage` 检查严格字段类型、页码、越界与请求信号取消，使用加密 API fixture 和固定 CDN 图像 mock。测试独立构造带余数的逆向打乱 WebP，用真实 Sharp 还原 PNG 后逐字节核对像素，并验证取消后仍可读取；未设置下载目录也能阅读。所有未列入 fixture 的网络请求都直接失败。可单独运行 `node --test dsh-plugin/tests/reader-client.test.js`，它以隔离 VM 和最小 hook 渲染器执行真实客户端组件事件、effect 和清理，验证返回、快速翻页与旧响应、对象 URL 释放、错误重试、章节切换和重置，以及 Gateway 适配器。封面测试通过真实 Gateway `cover` 验证字段、固定 CDN、禁止重定向、取消与插件卸载，使用受控 PNG 及真实 Sharp 验证缩放和 JPEG 重编码；不允许任何未预期网络请求。客户端测试还使用自制 window、ownerDocument、元素父链和 ref/contains 模型，检查阅读器内外方向键范围、监听卸载、输入框和弹窗豁免及快速翻页，验证搜索分页、动态总数缩减及有限纠偏、请求取消/过期和封面 URL 的清理。该渲染器和事件模拟器不是 React 或 DOM，不覆盖 StrictMode、完整 React 协调、真实焦点/事件传播、浏览器行为或真实网络传输。

限制：测试直接调用 Gateway 和已注册工具的 `execute`，不覆盖 HTTP/WebSocket、浏览器、DSH loader/profile、真实 JM 网络、登录、完整工具 executor 的调度/参数校验或权限策略。下载测试需要项目已安装且能加载本机架构对应的 Sharp；它只覆盖小型静态 WebP 到 JPEG，并不代替下载模块的完整安全与图像测试。运行结果与本机 DSH 版本及已有插件依赖有关；其通过不代表其他 DSH 版本兼容。测试修改进程内 `globalThis.fetch` 并在结束时恢复，应独立进程执行，避免与其他全局 fetch 测试并发。
