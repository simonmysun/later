# Later App 实现计划

个人阅读清单管理服务：记录 URL、添加时间、标签，支持多维 filter 与时间正序/倒序/随机排列。

## 目标与范围

- 后端 + 轻前端的个人工具（单用户）。
- 后端：Node.js + TypeScript，SQLite 用 **`node:sqlite` 内置模块**（`DatabaseSync`），尽量不引入其它框架。HTTP 用 **`node:http` 内置模块**。
- 前端：**单个静态 `index.html` + 原生 JS**，由后端直接提供，零构建步骤。
- summary（AI 总结）字段只保留存储 + 提供更新接口，由**外部服务**填充，本服务不抓网页、不调 LLM。外部服务通过 `GET /api/items?has_summary=false` 轮询取待处理项，处理完 `PATCH` 回 summary。

### 明确不做（out of scope）
- 不做多用户/登录系统（仅单一静态 token 保护写操作）。
- 不做网页抓取、不做 title 自动抓取、不做 LLM 调用。
- 不做 URL 去重（允许同一 URL 重复添加）。
- 随机模式不分页。

## 技术约束

- 运行时：**Node.js 24 LTS 或更新**（`node:sqlite` 在 22.13+ 无需 flag，24 LTS 内置且稳定度更高）。在 README/文档中固定该版本要求。
- `node:sqlite` 的 API 为**同步**（`db.prepare().run()/.get()/.all()`、`db.exec()`）。对单用户工具足够；不必引入 worker threads。
- TypeScript：用 Node 原生类型剥离运行（Node 23.6+ 可直接 `node file.ts`）或用 `tsc` 编译。实现时二选一，推荐直接运行 `.ts`（零构建）。
- `package.json` 设 `"type": "module"`，全程 ESM。
- 无第三方运行时依赖；devDependencies 仅 `typescript` 与 `@types/node`（若用 tsc/类型检查）。

## 数据模型（规范化三表）

所有表建议加 `STRICT`。时间戳统一用 **Unix epoch 毫秒整数**（`added_at` 等），便于范围过滤与排序。

### `items`
| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 自增 |
| `url` | TEXT NOT NULL | 原始 URL（不加唯一约束，允许重复；仅要求非空字符串，不强制 http/https） |
| `domain` | TEXT NOT NULL DEFAULT '' | 从 URL 解析出的 host（`new URL(url).hostname` 小写化，去 `www.` 视实现决定）；**解析失败时存空字符串 `''`**，用于筛选与索引 |
| `title` | TEXT | 手动填写，可空 |
| `note` | TEXT | 备注/描述，可空 |
| `summary` | TEXT | AI 总结，可空，由外部服务通过 PATCH 填。**写入时空/纯空白归一化为 `NULL`**，使 `has_summary` 判定一致 |
| `priority` | INTEGER NOT NULL DEFAULT 0 | 优先级/星标（0=普通，>0 越大越重要；或按需仅用 0/1 表示星标） |
| `is_read` | INTEGER NOT NULL DEFAULT 0 | 0/1 已读状态 |
| `added_at` | INTEGER NOT NULL | 添加时间（epoch ms） |
| `read_at` | INTEGER | 标记已读时的时间戳，可空 |
| `archived_at` | INTEGER | 归档（软删除）时间戳，可空。`NULL`=活跃；非空=已归档 |

### `tags`
| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 自增 |
| `name` | TEXT NOT NULL UNIQUE | 标签名（建议存归一化后的小写；显示名如需保留可另加列，第一阶段不做） |

### `item_tags`（关联表）
| 列 | 类型 | 说明 |
| --- | --- | --- |
| `item_id` | INTEGER NOT NULL | FK -> items.id，ON DELETE CASCADE |
| `tag_id` | INTEGER NOT NULL | FK -> tags.id |
| PRIMARY KEY | (`item_id`, `tag_id`) | 防止同条目重复贴同一标签 |

### 索引
- `items(added_at)` — 时间排序/范围过滤。
- `items(domain)` — 按域名筛选。
- `items(is_read)` — 已读状态筛选。
- `items(archived_at)` — 默认只列活跃项（`archived_at IS NULL`）。
- `item_tags(tag_id)` — 按标签反查条目。
- FTS 可选：第一阶段关键词搜索用 `LIKE '%kw%'` 覆盖 url/title/note/summary 即可；数据量大时再评估 FTS5。

连接后执行的 PRAGMA（`db.exec`，顺序敏感）：
- `PRAGMA journal_mode = WAL;` — 读写并发更好，外部 summary 服务与前端可同时访问同一 `.db`。
- `PRAGMA busy_timeout = 5000;` — 遇锁自动重试最多 5s，避免直接抛 `SQLITE_BUSY`。
- `PRAGMA synchronous = NORMAL;` — WAL 下的推荐值，兼顾安全与性能。
- `PRAGMA foreign_keys = ON;` — 启用外键级联（每个连接都要设）。

WAL 相关约束：
- WAL 会额外生成 `<db>-wal` 与 `<db>-shm` 边车文件；`.gitignore` 需一并忽略 `data/*.db-wal`、`data/*.db-shm`（或 `data/*` 除占位）。
- WAL 要求 db 文件在**本地文件系统**（勿放网络挂载/NFS）。
- 备份需一并复制 `.db` 及其 `-wal`/`-shm`，或先执行 checkpoint。

## API 设计

Base：JSON over HTTP。写操作（POST/PATCH/DELETE）需 `Authorization: Bearer <TOKEN>`，token 从环境变量 `LATER_TOKEN` 读取。读操作（GET）默认无需 token（个人工具，绑定 localhost）；实现时可用一个开关决定 GET 是否也校验。

服务监听地址与端口由环境变量控制：`HOST`（默认 `127.0.0.1`）、`PORT`（默认如 `8787`）。默认只绑 localhost。

### `POST /api/items` — 新增条目
请求体：
```json
{
  "url": "https://example.com/article",
  "title": "可选",
  "note": "可选",
  "tags": ["tag-a", "tag-b"],
  "priority": 0
}
```
请求体字段：`url`（必填）、`title`/`note`（可选文本）、`tags`（可选字符串数组，默认 `[]`）、`priority`（可选整数，默认 0）。`is_read`/`summary`/`archived` **不在创建时接受**（走 PATCH），传了则忽略。未知字段忽略。

行为：
- 校验 `url` 为非空字符串（否则 400）；不强制 http/https。
- 解析 `domain`：`try { new URL(url).hostname }`，失败则存 `''`。
- `added_at = Date.now()`；`is_read = 0`；`summary = NULL`；`archived_at = NULL`；`priority` 取请求值或默认 0。
- `tags`：对每个标签名归一化（trim + 小写 + 去空项），若 `tags` 表无则插入，再写 `item_tags`。整个新增放在一个事务里（`db.exec('BEGIN')` ... `COMMIT`，失败 `ROLLBACK`）。
- **不做去重**，同 URL 可重复插入。
- 返回创建的完整条目（含 id、tags 数组）。

### `GET /api/items` — 列表 + filter + 排序
查询参数：
- `tags`：逗号分隔标签名。
- `tag_mode`：`and` | `or`（默认 `or`）。`and` 要求同时具备全部标签；`or` 任一。
- `untagged`：`true` 时只返回无任何标签的条目（与 `tags` 互斥）。
- `domain`：精确匹配 host。
- `from` / `to`：`added_at` 范围（epoch ms，闭区间）。
- `read`：`true` | `false`，按已读状态过滤。
- `archived`：`false`（默认，`archived_at IS NULL`，活跃项）| `true`（`archived_at IS NOT NULL`，只看归档）| `all`（不按归档过滤）。**未传 = `false`**，即默认列表隐藏已归档项。
- `has_summary`：`true` -> `summary IS NOT NULL AND summary <> ''`；`false` -> `summary IS NULL OR summary = ''`（供外部服务取待处理项）。注意：外部 summary 服务轮询待处理项时通常只关心活跃项（默认 `archived=false` 已满足）。
- `q`：关键词，对 `url`/`title`/`note`/`summary` 做 `LIKE` 模糊匹配（大小写不敏感）。
- `sort`：`added_desc`（默认）| `added_asc` | `random`。非 random 排序统一带 `id` 二级键保证稳定分页：`added_desc` -> `ORDER BY added_at DESC, id DESC`；`added_asc` -> `ORDER BY added_at ASC, id ASC`。
- 分页（仅非 random）：`limit`（默认如 50）、`offset`（默认 0）。
- `random` 模式：`limit`（默认如 10），忽略 `offset`，用 `ORDER BY RANDOM() LIMIT ?`，不返回总数分页信息。

**Item 响应对象（统一 shape，所有返回条目的端点一致）：**
```json
{
  "id": 1,
  "url": "https://example.com/article",
  "domain": "example.com",
  "title": "可空 -> null",
  "note": "可空 -> null",
  "summary": "可空 -> null",
  "priority": 0,
  "is_read": false,
  "added_at": 1721790000000,
  "read_at": null,
  "archived_at": null,
  "tags": ["tag-a", "tag-b"]
}
```
字段约定：
- 时间字段（`added_at`/`read_at`/`archived_at`）一律返回 **epoch ms 整数**（与 `from`/`to` 输入同单位），可空者为 `null`。前端用 `new Date(ms)` 本地格式化。
- `is_read` 在 JSON 里返回 **布尔**（DB 存 0/1，序列化时转 `true`/`false`）。
- `archived_at` 非空即已归档；前端据此显示归档态，无需额外布尔字段。
- 可空文本字段（`title`/`note`/`summary`）无值时返回 `null`（不是 `""`）。
- `tags` 为字符串数组，可能为空数组 `[]`。

响应（非 random）：
```json
{
  "items": [ /* Item 响应对象数组 */ ],
  "total": 123,
  "limit": 50,
  "offset": 0
}
```
响应（random）：`{ "items": [ ... ] }`。

查询参数解析规则（统一，避免各处不一致）：
- 布尔参数（`read`/`untagged`/`has_summary`）：仅接受字面量 `"true"` / `"false"`；缺省 = 不加该过滤条件；其它值视为非法返回 400。
- `archived`：仅接受 `"false"`（默认，缺省亦为此）/ `"true"` / `"all"`；其它 400。
- `tag_mode`：仅 `"and"` / `"or"`（默认 `"or"`）；其它 400。
- `sort`：仅 `"added_desc"`（默认）/ `"added_asc"` / `"random"`；其它 400。
- `limit`/`offset`/`from`/`to`：须为非负整数字符串，解析失败 400。`limit` 上限设一个硬顶（如 200），超出则截断到上限（不报错）。`offset` 默认 0。random 模式 `limit` 默认 10、同样受硬顶约束。
- `tags`：逗号分隔，逐项 trim + 小写 + 去空项；全空则视为未传。

实现要点：
- 动态拼 `WHERE`：用参数化占位符（`?`）逐条件拼接，避免 SQL 注入。
- `tag_mode=and`：`JOIN item_tags` + `GROUP BY item_id HAVING COUNT(DISTINCT tag_id) = N`；`or`：`item_id IN (SELECT item_id FROM item_tags JOIN tags ...)`。
- `untagged`：`WHERE id NOT IN (SELECT item_id FROM item_tags)`。
- `domain` 精确匹配空字符串亦有效（可筛出未能解析域名的条目）。
- 每个 item 的 `tags` 数组：列表查出 id 后，用一次 `item_tags JOIN tags WHERE item_id IN (...)` 批量取，组装到内存，避免 N+1。
- `total`：同样 WHERE 条件下 `COUNT(*)`（random 模式不计算）。
- 分页 offset 语义：个人工具接受“翻页时若有新增条目 offset 会漂移”的弱一致性；不引入游标分页。

### `GET /api/items/:id` — 单条详情
返回完整条目 + tags。

### `PATCH /api/items/:id` — 更新条目（含 summary 由外部服务填）
请求体任意子集：`title`/`note`/`summary`/`priority`/`is_read`/`tags`/`archived`。
- 仅更新提供的字段。
- `is_read` 从 0 -> 1 时自动写 `read_at = Date.now()`；从 1 -> 0 时清空 `read_at`。
- `archived`：布尔。`true` -> 若当前未归档则写 `archived_at = Date.now()`；`false` -> 清空 `archived_at`（取消归档/恢复）。这是**归档与恢复**的统一入口。
- 提供 `tags` 时整体替换该条目的标签集合（先删 `item_tags`，再按新集合插入/复用 tag）。事务包裹。
- `summary` 写入时空/纯空白归一化为 `NULL`（与 `has_summary` 判定一致）。
- 默认允许对已归档条目继续 PATCH（例如先恢复、或外部服务补 summary）；不因归档态拒绝写。
- **外部 summary 服务**流程：`GET /api/items?has_summary=false` 取待处理 → 处理 → `PATCH /api/items/:id` 带 `{ "summary": "..." }` + Bearer token。注意：本服务不区分“未处理”与“处理失败”；若外部服务想避免对永久失败项无限重试，需自行写入占位 summary 或自维护失败清单（本服务不负责）。

### `DELETE /api/items/:id` — 删除条目
默认语义为**软删除（归档）**：等价于 `PATCH {archived:true}`，置 `archived_at = Date.now()`，条目仍在库中。
- 硬删除逃生口：`DELETE /api/items/:id?hard=true` 从库真删（级联删除 `item_tags`）。用于清理误加/垃圾项。
- 两种都需 Bearer token。

### `GET /api/tags` — 标签列表 + 计数
返回 `[{ "name": "tag-a", "count": 12 }, ...]`，用于前端筛选下拉与展示。`LEFT JOIN` 统计每个标签条目数，按 count 或 name 排序。
- 计数**默认只统计活跃项**（`archived_at IS NULL`），使筛选面板数字与默认列表一致。可选参数 `archived=all` 时统计全部（实现可选，非必需）。
- count 为 0 的标签是否返回由实现决定（建议保留，便于管理/清理空标签）。

### 错误约定
- 400：请求体/参数非法（如缺 url 或 url 为空、`tags` 与 `untagged` 同时给、`sort`/`tag_mode`/`archived` 取值非法）。注意：URL 解析失败**不**报 400（宽容策略，domain 存 `''`）。
- 401：写操作缺失/错误 token。
- 404：`:id` 不存在。
- 500：其它。统一返回 `{ "error": "message" }`。

## 前端（单个 index.html）

由后端在 `GET /`（及静态资源路由）返回。原生 JS，无框架、无构建。

功能区块：
1. **添加表单**：url（必填）、title、note、tags（逗号分隔或简易 tag 输入）、priority。提交调 `POST /api/items`，需带 token（见下）。
2. **筛选栏**：标签多选（从 `GET /api/tags` 拉取）、tag_mode 切换（and/or）、untagged 勾选、domain 输入、时间范围（from/to 日期选择器，转 epoch ms）、read 状态、archived（活跃/归档/全部，默认活跃）、has_summary（可选，方便查“已/未总结”）、关键词 `q`、sort 选择（时间正序/倒序/随机）、random 时的 N。
3. **列表展示**：每条显示 title（无则 url）、url 链接、domain、tags、added_at、优先级、是否已读、summary（若有）、是否已归档。行内操作：标记已读/未读、归档/恢复、编辑、删除（默认软删=归档；提供“彻底删除”入口调 `?hard=true`）。
4. **分页控件**：非 random 模式显示 total 与上一页/下一页（基于 limit/offset）。

Token 处理（个人工具，简化）：
- 前端把写操作用的 token 存在 `localStorage`，页面提供一个输入框设置；每次写请求带 `Authorization: Bearer`。
- 读操作默认不带 token（服务默认只绑 localhost）。

CORS：前端与 API 同源（都由本服务提供），无需 CORS。外部 summary 服务为服务端到服务端调用，浏览器 CORS 不适用；如日后有跨源浏览器客户端再按需加 CORS 头。

## 建议项目结构

在当前仓库新建独立子目录（实现时确定具体名，如 `later-app/`），与现有 markdown 工作流隔离：
```
later-app/
  package.json          // "type":"module"，scripts: start/dev
  tsconfig.json         // 若做类型检查/编译
  src/
    server.ts           // node:http 服务器、路由分发、token 中间逻辑
    db.ts               // DatabaseSync 初始化、PRAGMA、schema 迁移(CREATE TABLE IF NOT EXISTS)
    items.ts            // items 相关查询/写入（含动态 WHERE 构建、事务）
    tags.ts             // tags 查询/维护
    util.ts             // 解析 domain、参数校验、JSON 响应辅助
  scripts/
    import-md.ts        // 一次性 markdown 导入脚本（见“一次性导入脚本”节）
  public/
    index.html          // 前端单文件（含内联或同目录的 js/css）
  data/
    later.db         // SQLite 文件（gitignore；路径由 env DB_PATH 覆盖）
    later.db-wal     // WAL 边车文件（gitignore）
    later.db-shm     // WAL 共享内存文件（gitignore）
  .env.example          // LATER_TOKEN / HOST / PORT / DB_PATH 示例
  README.md             // Node 版本要求、启动方式、API 摘要、外部 summary 服务接入说明
```
把 `later-app/data/*.db`、`later-app/data/*.db-wal`、`later-app/data/*.db-shm` 加入仓库 `.gitignore`。

## 环境变量
- `LATER_TOKEN`：写操作 Bearer token（必填，启动时校验存在）。
- `HOST`：默认 `127.0.0.1`。
- `PORT`：默认 `8787`。
- `DB_PATH`：默认 `./data/later.db`。

## 一次性导入脚本（历史 markdown -> later）

背景：用户现把待读/待调查的 URL 散在仓库 markdown（如 `queued/to_investigate.md`、`queued/ideas/`、`queued/low_priority/`），用 `##`/`###` 标题分组、夹杂笔记与代码块。做一个**一次性**脚本把这些历史 URL 导入 app。

- 脚本名（建议）：`scripts/import-md.ts`，独立运行：`node scripts/import-md.ts <file-or-dir...>`。
- 通过调用 `POST /api/items`（带 `LATER_TOKEN`）写入；或直接复用 `db.ts`/`items.ts` 写库（二选一，推荐走 HTTP 以复用校验与归一化）。

解析规则（保守、可预测）：
- 逐行扫描每个 markdown。维护“当前标题”状态：遇到 `#{1,6} 标题文本` 行时更新当前标题为该行文本（去掉 `#` 与首尾空白）。
- URL 识别：匹配行内的 `https?://` 链接（正则提取，一行可有多个）。忽略 fenced code block（```...```）内的内容，避免把命令里的 URL（如 `http://127.0.0.1:8080/ls`）当条目——实现时跟踪代码块开合状态跳过。
- 每个提取到的 URL 作为一个 item：
  - `url` = 链接原文。
  - `tags` = 仅取**最近一个标题**归一化后的**单个** tag（trim + 小写；无标题则不打 tag）。
  - `note` = 该 URL 所在行去掉 URL 后的剩余文本 + 紧邻的上/下一行说明（实现可简化为“同行剩余文本 + 该 URL 后到下一个 URL/标题前的相邻非空行”）；无则留空。
  - `title` 留空（后续手动或外部补）。
  - `priority` = 0；`is_read` = false。
- 幂等性：脚本**不做去重**（与 app 一致，允许重复）；建议提供 `--dry-run` 打印将创建的条目而不写入，供先核对。
- 失败容忍：单条写入失败（如网络/400）记录并继续，最后汇总成功/失败计数。

不做：不解析代码块内 URL、不递归抓取、不还原标题层级（只用最近标题）。导入后由用户在 app 内手动整理标签/合并。

## 实现任务清单（有序）

1. 初始化子目录：`package.json`（`type: module`，`start`/`dev` scripts）、`tsconfig.json`、`.gitignore`（含 `data/*.db`、`data/*.db-wal`、`data/*.db-shm`）、`.env.example`。
2. `db.ts`：打开 `DatabaseSync(DB_PATH)`，按序设 `PRAGMA journal_mode=WAL / busy_timeout=5000 / synchronous=NORMAL / foreign_keys=ON`，用 `exec` 创建三表（`CREATE TABLE IF NOT EXISTS`，含 `STRICT`）与索引。
3. `util.ts`：`parseDomain(url)`、JSON 请求体读取、统一 JSON 响应、参数解析与校验、token 校验函数。
4. `items.ts`：
   - `createItem`（事务：插 item + upsert tags + item_tags）。
   - `listItems`（动态 WHERE：tags/tag_mode/untagged/domain/from/to/read/archived(默认活跃)/has_summary/q + sort（含 id 二级键）+ 分页/random；批量取 tags；算 total）。
   - `getItem` / `updateItem`（部分字段 + is_read/read_at 联动 + archived/archived_at 联动 + tags 整体替换，事务）。
   - `archiveItem`(id)/`unarchiveItem`(id) 或统一走 updateItem 的 `archived`；`hardDeleteItem`(id) 真删。
5. `tags.ts`：`listTagsWithCount`、`upsertTag`（供 items 复用）。
6. `server.ts`：`node:http` 创建服务器，手写路由分发（method + path 正则/分段匹配），写操作前置 token 校验，静态提供 `public/index.html` 与前端资源，`404`/错误统一处理，绑定 `HOST:PORT`，进程退出时 `db.close()`。
7. `public/index.html`：添加表单、筛选栏、列表、分页、token 输入，全部原生 `fetch` + DOM。
8. `README.md`：Node 版本要求、`node --version` 检查、启动命令、API 摘要、外部 summary 服务如何 PATCH、导入脚本用法。
9. `scripts/import-md.ts`（一次性导入）：按上节解析规则从 markdown 提取 URL/标题→tag/note，经 `POST /api/items` 写入；支持 `--dry-run`，跳过代码块，汇总成功/失败。

## 验证计划

- 手动/脚本（可用 `curl` 或 Node 内置 `node:test` + `fetch`）覆盖：
  1. `POST /api/items` 新增带 tags，返回含 id 与 domain；重复同 URL 能各自独立创建（验证不去重）。
  2. `GET /api/items` 各 filter：单标签、多标签 and/or、untagged、domain（含空 domain）、from/to、read=true/false、archived=false/true/all、has_summary=true/false、`q` 关键词，分别断言结果集。
  3. `sort=added_asc/desc` 顺序正确；同毫秒多条时按 id 二级键稳定（构造两条相同 added_at 断言顺序）；`sort=random&limit=N` 返回 ≤N 条且不含分页字段。
  4. 分页：`limit`/`offset` 与 `total` 一致性；相邻页无重复/遗漏。
  5. URL 解析：合法 URL 得到正确 domain；不可解析字符串（如 `"not a url"`）能创建且 domain 为 `''`。
  6. summary 归一化：`PATCH {summary:""}` 或纯空白后，`has_summary=false` 能查到该条。
  7. `PATCH` 设 `is_read=1` 后 `read_at` 非空、`=0` 后清空；`PATCH {summary}` 仅带 token 成功、无 token 401。
  8. `PATCH {tags}` 整体替换，`GET /api/tags` count 更新正确（默认只计活跃项）；`DELETE`（软删=归档）后该条从默认列表消失但 `archived=true` 可见、`archived=all` 计数含它。
  9. 归档/恢复：`PATCH {archived:true}` 置 `archived_at`、默认列表隐藏；`PATCH {archived:false}` 清空、恢复到默认列表。
  10. 硬删除：`DELETE ?hard=true` 后条目彻底消失、`item_tags` 级联清理、`archived=all` 也查不到。
  11. 写操作无/错 token 返回 401；GET 正常。
  12. 响应契约：Item 对象时间字段为 epoch ms 整数（或 `null`）、`is_read` 为布尔、空文本字段为 `null`、`tags` 为数组；所有返回条目的端点 shape 一致。
  13. 参数解析：非法 `sort`/`tag_mode`/`archived`/布尔值返回 400；`limit` 超硬顶被截断而非报错；`is_read`/`summary` 在 POST 中被忽略（仍为默认）。
  14. 启动后确认 `PRAGMA journal_mode` 返回 `wal`；生成 `-wal`/`-shm` 边车文件。
  15. 并发写冒烟：两个进程/请求近乎同时 `POST`/`PATCH`，均成功、无 `SQLITE_BUSY` 抛出（依赖 busy_timeout）。
  16. 导入脚本：对 `queued/to_investigate.md` 跑 `--dry-run`，核对 URL 数、tag（=最近标题）、note；确认代码块内 URL（如 `http://127.0.0.1:8080/ls`）被跳过；正式导入后在 app 中可按标题 tag 筛出。
- 冒烟：浏览器打开 `/`，走一遍添加 → 筛选 → 标记已读 → 归档/恢复 → 编辑 → 软删除 → 硬删除。

## 风险与注意

- `node:sqlite` 仍标注实验/RC 状态，API 在旧版本有差异 —— 固定 Node 24 LTS+，README 明确写清，避免部署机版本过旧导致 `node:sqlite` 缺失。
- 同步 SQLite 会阻塞事件循环：单用户工具可接受；若未来并发上升需迁移方案（worker threads 或换驱动）。
- 并发写：WAL + busy_timeout=5000 覆盖外部 summary 服务与前端同时写的常见场景；极端持续争用仍可能超时报错，实现时对写操作可加一次简单重试或向调用方返回可重试错误。
- 单进程内建议只开**一个** `DatabaseSync` 连接复用（同步 API，无需连接池）；外部 summary 服务是独立进程，通过各自连接访问同一 WAL 库。
- 动态 WHERE 拼接必须全程参数化，禁止字符串插值用户输入。
- 时间范围过滤依赖前端把日期正确转 epoch ms（注意时区）；README/前端注明。
- `data/*.db`（及 `-wal`/`-shm`）不入库；如需备份/迁移，复制时需连同 WAL 边车文件，或先做 checkpoint / 用 `sqlite.backup()`；后续可再加导出接口。

## 待实现时决定的小项（非阻塞）
- 子目录确切命名。
- `priority` 用连续整数还是仅 0/1 星标。
- domain 是否统一去 `www.` 前缀（去与不去要保持 filter 与存储一致）。
- 直接 `node file.ts` 运行 vs `tsc` 编译（推荐前者，零构建）。
- 标签名归一化规则细节（是否允许空格、大小写敏感展示名）。
