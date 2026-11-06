# 独立单章节下载器

Node.js ESM，使用 Node 内置 `fetch` 和动态导入的 `sharp`；调用真实编解码前须由集成方自行安装 `sharp`。没有持久队列、暂停/续传、GUI、下载管理器或自动调用 JM API。

```js
import { createChapterDownloader } from './index.mjs';

// root 是预先创建的、绝对且规范化的固定输出根目录。
const downloader = createChapterDownloader({ root: '/trusted/private/downloads' });
const chapter = await jmClient.getChapter(chapterId, { signal });
// scrambleId 必须由调用方从可靠来源获取；现有 JS JmClient 没有此方法。
const result = await downloader.downloadChapter({
  chapterId, chapter, scrambleId, format: 'png', signal,
});
// 成功时 result = { chapterId, imageCount, directory }
```

章节数据只使用 `id`（若存在，须匹配）和非空 `images` 数组。ID 支持安全整数或 i64 范围的规范十进制字符串。只接受简单 ASCII `.webp` / `.gif` 文件名；任何非法/不支持的项目使整个章节失败，而不是静默跳过。请求域名固定为 Rust 客户端的图片 CDN。WebP 解码后按 Rust 相同的块数和余数规则还原，输出 `jpeg`（默认，扩展名 `jpg`）、`png` 或 `webp`；GIF 解码验证后原样保存。图片是顺序处理的，输出名称按章节列表顺序生成。

各章节目录为 `chapter-<数字ID>`，必须不存在；文件独占创建，从不覆盖、删除预存文件。只在全部图片成功后写入 `.complete.json`，返回成功也要求该写入成功。错误或取消时尽力删除本次创建且 inode 未变化的文件及空目录，不会递归删除未知文件。进程崩溃、断电或清理失败可能留下不含完成标记的不完整目录；须由可信操作员检查并手动清理，模块不会自动恢复或覆盖它。

**文件系统安全边界：** 根目录及其所有祖先必须已经存在、不得包含 symlink，且不得被不可信的并发进程写入、改名或替换；章节目录应只由运行该模块的可信进程访问。实现会检查路径组件和目录身份，拒绝现有目录、symlink 及链接跟随，并进行独占创建；但 Node.js 跨平台没有相应的 `openat`/`mkdirat` 目录句柄 API，检查和路径操作之间无法防御恶意进程并发替换目录的 TOCTOU 竞态。不要将此模块用于攻击者可修改输出树或祖先的环境。`fetch` 和 `codec` 是可信的依赖注入点，不是沙箱。

内置上限：输入 32 MiB/张（`maxBytes`）、输出 128 MiB/张（`maxOutputBytes`）、输入 512 MiB/章（`maxTotalInputBytes`）、输出 512 MiB/章（`maxTotalOutputBytes`，包括完成标记）、总解码像素 4000 万/张（`maxPixels`）、100 帧/张（`maxPages`）、500 张/章（`maxImages`）、每张下载和读完响应总共 30 秒（`imageDownloadTimeoutMs`，包括空响应后的重试）。在构造器的 `limits` 对象中可以将这些上限调低，不能调高；均须为正整数。输入总量按实际读取的响应体字节计数，输出总量包含 GIF、编码结果和完成标记。响应必须是有界读取的异步流。GIF 动画总帧像素也受限。

超时返回 `TimeoutError`，调用者取消返回 `AbortError`。超时涵盖获取响应和读取流，不涵盖编解码或磁盘操作；不配合取消的注入式 fetch 可能继续在后台运行，但不再写入其结果。正在执行的 codec（包括 native sharp）无法安全地中断，取消后仍会等待它 settle，再清理并返回；如果 codec 永不结束，调用也不会返回。模块本身不限制并发，宿主必须用单下载锁等机制约束并发，锁须持有至整个下载 Promise settle。

`createChapterDownloader({ root, fetch, codec, limits })` 可注入 fetch 和 codec 以离线测试。codec 需要 `decode(buffer, limits)`，返回 `{data: Buffer, width, height, channels, format: 'webp'|'gif', pages}`（data 为所有帧的原始交错像素、height 为堆叠帧高度），以及 `encode(image, format)` 返回 Buffer。注入 codec 必须在解码分配前自行执行像素和帧限制；模块也检查其返回数据。

离线测试：`node --test dsh-plugin/download/*.test.mjs`。所有测试使用 mock fetch；其中 `sharp.test.mjs` 使用真实 sharp 合成 WebP 和 GIF 并验证像素还原及 GIF 原样保存，需要先安装 sharp。无 sharp 时仍可单独运行 `node --test dsh-plugin/download/index.test.mjs dsh-plugin/download/security.test.mjs`，这两套测试使用 fake codec。
