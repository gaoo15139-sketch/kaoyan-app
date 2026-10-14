# 架构说明

## 1. 定位

一个**没有后端**的手机应用。所有能力都在浏览器里完成：

    手机浏览器
      ├── UI（app.js + ui.js）
      ├── 业务逻辑（repo.js）
      ├── 存储（store.js → IndexedDB）
      ├── AI（ai.js → 直连 api.deepseek.com）
      ├── 离线降级（rules.js）
      └── 文件解析（docx.js）
            ▲
            └── Service Worker 缓存应用外壳，断网可启动

没有任何服务端进程，数据不出手机（除了你主动发给 DeepSeek 的材料原文）。

---

## 2. 分层与依赖方向

    app.js  ──→ ui.js
       │
       ├──→ repo.js ──→ store.js（IndexedDB / 内存）
       │        ├──→ rules.js（离线引擎）
       │        ├──→ ai.js（DeepSeek 直连）
       │        └──→ util.js
       │
       └──→ docx.js（文件解析）

依赖是单向的，store.js 只暴露一个小接口，因此**业务逻辑可以脱离浏览器测试**。

### store.js 的双驱动设计

    createIdbDriver()    浏览器：IndexedDB
    createMemoryDriver() Node 测试：内存 Map

驱动接口：open / get / getAll / put / putMany / delete / clear / getByIndex / replaceAll / count。

repo.js 只依赖这个接口，所以在 Node 里能完整跑通分类、导入、审核、检索、备份恢复，
不需要 jsdom、不需要 fake-indexeddb、不需要任何依赖。这是 190 项逻辑测试能存在的原因。

---

## 3. 数据模型（IndexedDB）

    materials                  id, title, status, processing_status, importance,
                               source_id, origin, idempotency_key, created_at,
                               updated_at, deleted_at
    material_raw               id, material_id, revision, body, content_hash, ...
    ai_analyses                id, material_id, raw_hash, provider, status,
                               error_code, error_message, attempts, result_json
    proposals                  id, material_id, analysis_id, subject/chapter/type_id,
                               suggested_new_json, confidence, payload_json, status
    material_reviews           id, material_id, revision, body, kind
    material_classification    material_id(PK), subject_id, chapter_id, type_id,
                               importance, decided_by, confidence
    material_tags              id(material|tag), material_id, tag_id
    search_index               material_id(PK), title, body, extra
    分类体系                    subjects / chapters / material_types / tags / sources
    辅助                       audit_log / settings
    预留                       knowledge_nodes / material_knowledge_links（本期不写业务数据）

索引：materials 上按 updated_at / status / processing_status / idempotency_key(unique)；
其余按 material_id 建索引。

### 四层分离仍然成立

即使换了存储引擎，「AI 不能覆盖原文」依然由结构保证：

- material_raw 只写不改，每次补充内容新增一个 revision
- ai_analyses 无论成功失败都追加一条
- material_reviews 是用户确认稿，与原文并存
- material_classification 是当前生效的分类

repo.getBundle() 把这四层聚合成界面需要的形状。

### 检索

IndexedDB 没有 LIKE，因此维护一张 search_index 单行聚合表
（标题 + 全部原文版本 + 全部确认稿 + 标签 + 分类名），过滤时一次性载入内存做匹配。
个人规模（数千条）下这比引入 FTS 更简单可靠。

---

## 4. AI 直连

### 事实依据

最初设计里必须有后端代理，是担心浏览器跨域。实测 DeepSeek 接口支持 CORS：

    OPTIONS https://api.deepseek.com/chat/completions
    → 200
      access-control-allow-origin: <回显请求的 Origin>
      access-control-allow-methods: POST
      access-control-allow-headers: authorization,content-type
      access-control-allow-credentials: true

因此浏览器可以直接调用，无需任何代理。

### 请求管线

    raw 原文
      → buildMessages（注入用户自己的分类体系 + 截断后的正文）
      → callDeepSeek（AbortController 超时 + 指数退避重试）
      → extractJson（去代码块 / 括号平衡扫描 / 去尾逗号 / 中文引号 / 控制字符）
      → 失败则请求模型修复一次
      → normalizeResult（把模型输出映射回真实 id，未匹配则记入 suggested_new）
      → 写 ai_analyses（成功或失败都写）→ 写 proposals → 更新 processing_status

### 错误码

timeout / network / invalid_json / auth / quota / rate_limit / server /
bad_request / bad_response / no_api_key / ai_disabled / unknown

只有 timeout、network、rate_limit、server 会重试。

### 幂等

同一 原文哈希 + provider + prompt_version 已成功过时，默认复用上次结果，避免重复消耗额度。

### 安全含义

- API Key 存在手机本地（IndexedDB settings），会随备份文件一起导出，注意保管
- 材料原文会发送给 DeepSeek 用于分类，敏感内容请自行判断
- 谁拿到这台手机就能用你的额度

---

## 5. 离线策略

| 能力 | 离线时 |
|---|---|
| 打开应用 | 可以（Service Worker 缓存外壳） |
| 查看 / 检索 / 编辑 / 分类 / 归档 | 可以（数据在本机） |
| AI 整理 | 自动降级为离线规则引擎 |
| 人工审核 | 可以 |

Service Worker 只缓存同源外壳，跨域请求（也就是发给 DeepSeek 的）**绝不缓存**。

离线规则引擎（rules.js）完全由数据驱动：名称命中 +8、code +8、每个关键词 +4，
在最高分科目范围内匹配章节（+7/+4）与类型（+5/+3）；识别不出科目时不猜，
返回 null 并在 warnings 里说明，交回人工分类。界面始终标注「离线规则引擎」，
不会冒充真实模型。

---

## 6. 文件导入

- 文本类（.txt/.md/.csv/.json/.log/.tex）：用 File.text()
- **.docx**：自己解析 zip 容器（定位 EOCD → 中央目录 → 本地头），取 word/document.xml，
  用 DecompressionStream('deflate-raw') 解压，再转纯文本。
  这是 docx.js，约 100 行，无第三方依赖，由 tests/docx.test.mjs 用现造的 zip 覆盖
  压缩 / 未压缩 / 缺文件 / 空文档四类分支。
- .pdf：明确不支持并给出替代方案，不做假实现。

---

## 7. 测试策略

分两层，都不需要安装任何依赖：

### 逻辑层（node tests/run.mjs）

用内存驱动替换 IndexedDB，直接测业务逻辑。190 项，覆盖分类 CRUD、导入、
四层分离不变量、审核四种动作、检索各维度、导出、备份恢复、AI 错误矩阵、
docx 解析，以及模块图 / manifest / Service Worker 清单的静态完整性。

### 浏览器层（node tests/e2e.mjs）

用无头 Chrome + CDP 真实渲染和真实点击：

    Page.navigate → 等加载屏消失
    填写导入表单 → 点「保存并让 AI 整理」→ 断言头部计数变化
    切换材料库 → 断言列表、检索命中与空结果
    打开详情 → 断言原文 / AI / 确认稿三个区块
    切到审核 → 点「接受并归档」→ 断言离开待处理列表
    回到材料库 → 断言状态为已归档
    全程收集 Runtime.exceptionThrown 与 console.error，必须为零

它同时逐页截图到 shots/。这一层能抓到纯逻辑测试抓不到的问题（DOM 绑定、
事件、IndexedDB 在真实浏览器里的行为）。

---

## 8. 与旧版的关系

旧版是「电脑上的 Python + SQLite 后端 + 手机前端」，整个 server/、run.py、
build.py 与全部 Python 测试已删除。保留下来的是：

- 四层数据分离的设计与不变量
- 分类体系完全数据驱动、不写死科目章节
- AI 结果归一化与 suggested_new 的处理方式
- 离线规则引擎的数据驱动评分思路
- 审核工作台的四种动作语义

换掉的是存储引擎（SQLite → IndexedDB）、AI 调用位置（后端代理 → 浏览器直连）、
以及部署形态（本机服务 → 静态托管 + 添加到主屏幕）。
