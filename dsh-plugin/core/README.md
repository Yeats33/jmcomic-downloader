# JM 匿名 API 核心

Node.js 18+，ESM；仅依赖 `node:crypto` 和标准 `fetch`、`AbortController`。不依赖 Tauri、插件运行时或其他包。

```js
import { JmClient, JmError } from './jm-client.js';

const jm = new JmClient({ domain: 'www.cdnzack.cc', timeoutMs: 15000 });
const result = await jm.search('关键词', { page: 1, sort: 'latest' });
// result: { type: 'search', data: 原始搜索数据 }
// 数字搜索被 API 重定向时: { type: 'comic', data: 漫画数据 }
const comic = await jm.getComic('123456');
const chapter = await jm.getChapter('123456');
const scrambleId = await jm.getScrambleId('123456');
```

- `domain` 可以是主机名或 `https://` / `http://` origin（含端口），默认 `www.cdnzack.cc`；不接受路径、凭据、查询或片段。`http` 仅在明确指定时使用。实际线路可能失效或因地区不可访问，需自行配置；不自动切换、重试或跟随 HTTP 重定向。
- 构造函数还接受 `fetch` 注入（默认 `globalThis.fetch`），用于测试或自定义传输；成功响应必须提供标准的 `body.getReader()` 流，以便流式限制响应体（解压后）最多 8 MiB，不支持仅提供 `text()` 的模拟响应。`timeoutMs` 默认 15000，覆盖单次请求及读取响应体。搜索重定向需两次请求，各自计时。
- 所有方法的 options 可指定 `signal: AbortSignal`；中止、超时均中止底层请求。`id` 为正安全整数或正十进制字符串（后者避免整数精度损失）。
- `search(keyword, {page, sort, signal})` 的 page 默认为 1；sort 支持 `latest`、`view`、`picture`、`like`，或对应 API 值 `mr`、`mv`、`mp`、`tf`。
- 数据为解密后的 **API 原始字段**（保留 snake_case、字符串数字、额外字段）；漫画的 `series` 给出章节列表；章节的 `images` 是服务器返回的文件名，不是可直接使用的下载 URL。不包含桌面端下载状态、路径等本地字段。
- `getScrambleId(chapterId, {signal})` 查询章节模板并返回正安全整数；仅接受唯一的 `var scramble_id = 正十进制整数;` 声明。缺失、重复、格式非法或超出安全整数范围均抛 `INVALID_RESPONSE`，不会回退到 Rust 的默认值。该提取基于文本匹配，不执行或完整解析 JavaScript。此方法不实现图片下载或解扰。
- 抛出的 `JmError` 包含 `code`：`HTTP_ERROR`（含 `status`）、`API_ERROR`（含 `apiCode`）、`INVALID_RESPONSE`、`DECRYPT_ERROR`、`RESPONSE_TOO_LARGE`、`NETWORK_ERROR`、`TIMEOUT`、`ABORTED`。参数错误为 `TypeError`。
- 这是匿名只读客户端，不实现登录、收藏、代理配置、图片下载、解扰、持久化、自动故障切换或其他未声明功能。JM API 非公开且可能更改；未经线上可用性保证。

仓库根目录运行离线测试：

```sh
node --test dsh-plugin/tests/jm-client.test.js
```
