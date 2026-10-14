# 考研四科 AI 材料归档（纯移动端）

服务于 **408**、**政治**、**数学**、**英语** 四科的学习材料导入、AI 辅助分类与归档。

**这是一个完全独立于电脑的手机应用。** 没有后端、没有服务器进程：

- 数据存在**手机自己**的 IndexedDB 里
- AI 由手机浏览器**直连 DeepSeek**（CORS 已实测通过，见第 3 节）
- 没网或没配 API Key 时，自动降级为内置的离线规则引擎

电脑只在一个环节出现：把静态文件放上任意一个静态托管（一次性，之后完全不需要）。

---

## 1. 和其他方案的区别

| | 旧版本（已删除） | 本版本 |
|---|---|---|
| 运行位置 | 电脑上的 Python + SQLite | 手机浏览器 |
| 电脑是否要开机 | 必须，否则打不开、读不到数据 | **不需要** |
| 数据存储 | 电脑上的 kaoyan.db | 手机 IndexedDB |
| AI 调用 | 电脑代理转发 | 手机浏览器直连 DeepSeek |
| 离线可用 | 只有界面外壳 | 除 AI 推理外的全部功能 |
| 后端代码 | 约 5000 行 Python | **0 行** |

---

## 2. 快速开始

### 第一步：把应用放上静态托管（只需一次）

整个目录就是一堆静态文件，放到任何静态托管都可以。三种最省事的方式：

- **Netlify Drop**：打开 app.netlify.com/drop，把整个文件夹拖进去，立刻得到 HTTPS 地址
- **GitHub Pages**：文件推到仓库，Settings → Pages → 部署 main 分支
- **Cloudflare Pages / Vercel**：连接仓库，构建命令留空，输出目录填根目录

> 必须用 **HTTPS**（或 localhost）。浏览器只允许在安全上下文里注册 Service Worker，
> 也只有那时才能「添加到主屏幕」和离线打开。上面的托管都自带 HTTPS。

只想先在电脑上看看效果，可以起一个本地静态预览（不保存任何数据）：

    node tests/serve.mjs 8080
    # 打开 http://localhost:8080

### 第二步：在手机上打开并添加到主屏幕

- **Android（Chrome / Edge）**：打开地址 → 右上菜单 → 「安装应用」或「添加到主屏幕」
- **iOS（必须用 Safari）**：打开地址 → 分享按钮 → 「添加到主屏幕」

之后就像普通 App 一样从桌面图标启动，断网也能打开。

### 第三步：配置 DeepSeek（可选）

不配置也能用 —— 此时使用内置离线规则引擎，靠你自定义的科目/章节/类型名称与关键词打分。

要用真实模型：打开「设置」→ 填入 API Key → 保存 → 点「测试连接」。

> API Key 保存在这台手机本地，只用于直连 api.deepseek.com，不经过任何第三方服务器。
> 但反过来：**谁拿到你这台手机，就能用你的额度。**

---

## 3. 为什么不需要后端

原本必须有个后端代理，是因为担心浏览器跨域被拦截。实测 DeepSeek 接口是支持的：

    OPTIONS https://api.deepseek.com/chat/completions
      Origin: https://example.com
      Access-Control-Request-Method: POST
      Access-Control-Request-Headers: authorization,content-type

    响应 200：
      access-control-allow-origin: https://example.com
      access-control-allow-methods: POST
      access-control-allow-headers: authorization,content-type
      access-control-allow-credentials: true

服务端会回显 Origin，所以浏览器可以直连。这一点由 tests/ai.test.mjs 用假 fetch
覆盖了超时、重试、鉴权、限流、非法响应等分支。

---

## 4. 五个页面

- **导入**：手动输入 / 粘贴文本；文件导入（.txt / .md / .csv / .json / **.docx**），支持批量与部分失败提示
- **材料库**：全文检索 + 科目/章节/类型/标签/状态筛选 + 详情（原文、AI 结果、确认稿、元数据）
- **审核**：AI 建议队列，支持**接受 / 编辑 / 拒绝 / 暂存**，可当场新建科目/章节/类型；AI 失败的材料可重试或手动分类
- **分类**：科目、章节（树形）、材料类型、标签的增删改 —— 全部自定义，代码里没有写死任何分类
- **设置**：AI 配置与连通性测试、完整备份导出/恢复、导出为 JSON/CSV/Markdown、持久化存储申请、安装入口

---

## 5. 数据安全（请务必读）

数据只在这台手机上。这带来两个后果：

1. **清理浏览器数据 / 换手机 / 卸载浏览器，数据就没了。**
2. 手机存储紧张时，系统**可能自动清理**站点数据。

应用做了能做的缓解：

- 「设置 → 申请持久化存储」会向浏览器申请 persistent 权限，批准后系统不会自动清理
- 界面上常驻备份提醒

但**唯一的可靠保险是导出备份**：

    设置 → 数据与备份 → 导出完整备份

导出的 JSON 可以存到微信收藏、网盘或手机文件夹。换手机时用「从备份恢复」导回来即可。

---

## 6. 数据模型：四层分离

即使在手机上，原始材料也**永远不会被 AI 覆盖**：

    materials                 材料身份 + 用户可见元数据（稳定 ID）
      ├── material_raw            ① 原始材料 —— 只追加，按版本保存
      ├── ai_analyses             ② AI 处理结果 —— 只追加，失败也留痕
      │     └── proposals         AI 分类建议（人工审核对象）
      ├── material_reviews        ③ 用户确认稿 —— 独立版本，不覆盖原文
      └── material_classification ④ 分类元数据 —— 人工确认后生效

这套设计由 tests/repo.test.mjs 逐条断言（原文不被覆盖、AI 结果单独留痕、确认稿独立于原文）。

---

## 7. 测试

不需要安装任何依赖，全部用 Node 运行：

    node tests/run.mjs        # 逻辑层 190 项（不需要浏览器）

    # 真浏览器端到端（用无头 Chrome 真实操作界面）
    node tests/serve.mjs 8099
    node tests/e2e.mjs http://127.0.0.1:8099/     # 37 项

| 测试文件 | 内容 |
|---|---|
| tests/static.test.mjs | 模块图完整、index.html 引用、manifest、Service Worker 清单 |
| tests/ai.test.mjs | JSON 修复、结果归一化、错误映射与重试（假 fetch，不联网） |
| tests/docx.test.mjs | 现造一个 docx zip 再解析回来，含异常分支 |
| tests/repo.test.mjs | 分类 CRUD、导入、四层分离、审核流程、检索、导出、备份恢复 |
| tests/e2e.mjs | 无头 Chrome 真实点击：导入 → AI → 检索 → 审核 → 归档 → 逐页截图 |

---

## 8. 目录结构

    index.html               应用外壳
    styles.css               移动端样式（底部导航、安全区、全屏弹窗）
    manifest.webmanifest     PWA 清单
    sw.js                    Service Worker：缓存应用外壳，AI 请求绝不缓存
    js/
      util.js                ID、哈希、文本工具
      store.js               IndexedDB 封装（Node 里自动换成内存实现）
      rules.js               离线规则引擎（数据驱动，无写死分类）
      ai.js                  DeepSeek 直连 + JSON 修复 + 错误码
      repo.js                业务逻辑：分类、材料、原文、审核、检索、导出
      docx.js                自研 zip 解析 + DecompressionStream 提取 docx 文本
      ui.js                  DOM 工具、模态框、表单
      app.js                 五个页面
    icons/                   PWA / iOS 图标
    tests/                   Node 测试 + 无头浏览器端到端
    shots/                   e2e 截图产物（可删除）

---

## 9. 已知限制

- **本轮不产出 .apk / .ipa**：本环境没有 Android SDK 与 Xcode。Web 层已按 PWA 标准组织
  （manifest + 独立窗口 + 安全区 + 底部导航），日后可用 Capacitor 包装成安装包，业务代码无需改动。
- **AI 需要联网**：没网时自动使用离线规则引擎，分类质量弱于真实模型。
- **手机存储可能被系统回收**：见第 5 节，靠持久化申请 + 导出备份缓解。
- **PDF 仍不支持**：手机上打开 PDF 复制文字后粘贴，或先转成 .docx / .txt。
- **全文检索是内存扫描**：个人规模（数千条）足够；数据量很大时需要引入索引结构。
- **单机单设备**：没有账号与同步，多设备之间靠导出/导入备份文件传递。
