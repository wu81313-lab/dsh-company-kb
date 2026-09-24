# dsh-company-kb

给 DeepSeek Harness 用的**本地文件夹知识库**插件：把公司资料目录建成一个中文可用的检索索引，
写方案 / 投标 / 核政策时按需调用；**只在用户明确点名时检索**，**只在用户手动触发时同步**。

- 索引对象：本地任意目录（在面板「设置」页填 `roots`），**只读，插件永不写入**
- 检索方式：中文分词 BM25 + 中文二字组合 + trigram 子串 → RRF 融合（全离线，零外部服务）
- 同步方式：**纯手动**（面板按钮 / 明确要求 / 命令行），没有任何定时器
- 交付形态：5 个模型工具 + Web 面板（侧边栏底部面板入口 / 会话开关 / 设置页）+ `company-kb` 技能

## 安装

环境要求：DSH 0.1.5 及以上，Node.js `^22.19.0 || >=24.0.0`；OCR 与旧版 Office 抽取需要 Windows（可选，缺了不影响其它格式）。

```bash
# 方式一：从 GitHub 安装（pnpm 原生支持 git 源）
dsh plugin --profile <你的 profile> add github:wu81313-lab/dsh-company-kb

# 方式二：克隆到 profile 的 plugins/ 目录后按本地目录安装
cd <DSH_HOME>/profiles/<你的 profile>
git clone https://github.com/wu81313-lab/dsh-company-kb.git plugins/dsh-company-kb
dsh plugin --profile <你的 profile> add ./plugins/dsh-company-kb

# 确认 package.json 的 dsh.profile.bundles 含本行，并校验组合树
dsh --profile <你的 profile> --dump-config | findstr company-kb

# 重启 profile（宿主侧改动需要重启），然后刷新页面（客户端 bundle 需要刷新）
```

安装后打开「设置 → 插件 → 本地知识库」填好资料目录，再点面板「立即同步」建库。

卸载：`dsh plugin --profile <你的 profile> remove dsh-company-kb`，再从 `dsh.profile.bundles` 移除该行；
数据目录 `~/.dsh/local-kb` 可整体删除，**知识库原文件夹自始至终零改动**。

## 快速上手

1. 先在「设置 → 插件 → 本地知识库」填好资料目录（`roots`），然后首次建库（二选一）：
   - 打开左栏「本地知识库」→ 点「立即同步」（首次约 1–5 分钟，含扫描件 OCR）
   - 或在终端：`node lib/cli.mjs index`
2. 在对话里**点名使用**：
   - `用知识库查一下 XX 政策的条款要求`
   - `按 模板/技术方案书模板.docx 写一份 XX 项目方案`
   - 或点输入框右侧的「知识库 已关」开关
3. 资料更新后**手动同步**：面板「立即同步」，或说"同步一下知识库"，或 `node lib/cli.mjs index`。

不点名、不打开开关，检索工具会直接返回一段说明而**不会去查资料**。

## 目录结构

```
lib/
  index.js         Cordis 插件入口：装配内核、注册工具、注入状态提示段、挂载 Web API
  core.js          内核：设置 + 索引库 + OCR 桥 + 同步引擎的组合，供工具/面板/CLI 共用
  store.js         SQLite(node:sqlite) + 双 FTS5 索引 + RRF 融合检索
  segment.js       中文分词、二字组合、FTS 查询构造与转义
  bigram.js        中文相邻二字组合（解决分词器把"袋线瓶线"切碎的问题）
  chunk.js         分块：标题面包屑、页码、重叠、超长段落切分
  scan.js          同步引擎：遍历 diff → 抽取 → 写库；手动触发，无定时器
  gate.js          显式调用门禁（触发词 / 路径点名 / 会话开关 / 同步意图）
  prompt.js        状态提示段（未启用 / 已启用 / 尚未建库 / 索引已过期）
  tools.js         kb_search / kb_read / kb_list / kb_status / kb_session
  web.js           宿主 HTTP API（同源，供面板调用）
  ocr.js           OCR / Word 助手桥（临时文件传参，不用管道）
  ocr-helper.ps1   Windows PowerShell 5.1 + WinRT：PDF 渲染、图片 OCR、Word COM
  settings.js      运行时设置（settings.json，热生效）
  client.js        客户端 bundle（手写 __ModuleLoader__ + React.createElement）
  cli.mjs          命令行：status / probe / index / search / read / list
  selftest.mjs     验收自测：抽取覆盖率 + 15 条金标查询
  extract/         zip / docx / xlsx / pptx / text / media（零第三方依赖）
test/              node --test 单测（门禁、分词、分块、索引、HTTP、手动同步语义、面板渲染）
skills/company-kb/ 技能：检索流程与引用规则
```

数据目录（可整体删除）：`%USERPROFILE%\.dsh\local-kb\` → `index.sqlite`、`settings.json`

## 工具

| 工具 | 作用 |
| --- | --- |
| `kb_search` | 混合检索，返回文件相对路径、标题层级、页码、`docId` 与高亮片段 |
| `kb_read` | 读某个文件的抽取正文（分页）；二进制文件只返回完整路径。传 `open:true` 则用本机默认程序打开原文件 |
| `kb_list` | 浏览目录（名称/大小/字数/状态），不确定资料在哪时用 |
| `kb_status` | 状态、失败清单、体检结果、面板接口状态；`action=now/rebuild` 手动同步，`progress` 看进度 |
| `kb_session` | 本会话开关（`on/off/status`），只有在用户明确要求时才该调用 |

## Web 面板

挂在 DSH 自己的 Web 服务下（同源路由 `/company-kb-api/*`，仅回环可访问，不开新端口）：

- **侧边栏底部「本地知识库」**（在「设置」按钮上方，独占一行）：索引概况（文件数/字符/检索片段/上次同步/失败/待同步变化）、立即同步、重建索引、中止、进度条、搜索（含原文预览与失败清单）、同步记录
  - 面板分「搜索」「同步记录」两个页签；`/company-kb-api/tree` 与 `kb_list` 工具仍可用于浏览目录，只是不再占用面板页签。
  - 该入口挂在 `sidebar.footer.action`，与「设置」按钮同一列：插件把该列改成 `flex-direction:column`，因此三个入口各占一行、不会重叠。
- **原文预览处的两个按钮**：
  - 「用本机程序打开」= 交给系统默认程序，等价于双击：`.docx/.doc` → WPS/Word，`.xlsx` → WPS/Excel，`.pptx` → PowerPoint，`.pdf` → PDF 阅读器；`.dwg` 等图纸同理。打开后你可以直接在里面查看甚至编辑（原文件本身仍是你的，插件不参与写入）。
  - 「在文件夹中显示」= 在资源管理器中定位该文件。
  - 图片与 PDF 还会**在面板内直接渲染**（`/raw` 直出原文件），文档类则显示抽取出的正文。
- **输入框右侧「知识库」开关**：切换本会话是否允许检索（等价于点名）
- **设置 → 插件 → 本地知识库**：根目录、同步方式、显式调用、路径点名、trigram、旧版 Office 处理、触发词（全部热生效，不用重启）

面板不可用时（例如客户端 bundle 没加载）**工具与索引照常工作**。

## 配置

行配置在 `cordis.patch.yml`（启动默认值），运行时覆盖在 `~/.dsh/local-kb/settings.json`（面板写入，热生效）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `roots` | `[]` | 索引根目录，数组，可多个；为空时同步会提示"尚未配置索引根目录" |
| `autoSync` | `'off'` | `'off'` 纯手动；`'watch'` 文件变化即增量同步（事件驱动，仍无定时器） |
| `stalenessHint` | `true` | 打开面板/查状态时做一次 stat 体检，只报"有多少文件变了"，不动库 |
| `explicitOnly` | `true` | 未点名不许检索 |
| `pathTriggers` | `true` | 消息里出现库内文件名/目录名也算点名 |
| `triggers` | 知识库 / 资料库 / 公司资料 / 公司知识库 / `/kb` … | 点名触发词，可改 |
| `include` / `excludeDirs` / `excludeGlobs` | 常见文本与 Office 格式 | 决定抽取范围（不匹配的文件只登记元数据） |
| `maxFileBytes` | 256MB | 本地解析保险丝；PDF/图片走 OCR 不受它限制 |
| `legacyDoc` | `'word-com'` | 旧版 `.doc/.xls` 用本机 Word 取正文；设 `'skip'` 则只按文件名检索 |
| `trigram` | `true` | 子串索引（更全，占用更大） |
| `chunkChars` / `chunkOverlap` | 900 / 150 | 分块大小与重叠 |
| `topK` / `maxChunksPerDoc` | 8 / 3 | 返回条数与单文件最大块数 |
| `ocrWidth` / `maxOcrPagesPerFile` | 1600 / 60 | OCR 渲染宽度与单文件页数上限 |
| `exposeWeb` / `webPath` | `true` / `/company-kb-api` | 面板 API 开关与路径 |

## 手动同步模型（本插件与"自动同步"的边界）

- 索引**只在**三种显式触发下变化：面板按钮 / 用户明确要求（`kb_status action=now`，同样过门禁）/ CLI。
- 启动**不扫描**：只打开数据库、校验 schema，并做一次"体检"（stat 比对，只报告差异）。
- 检索结果与状态卡会提示"索引之后有 N 个文件变化"，提醒你手动同步，但**绝不偷偷重建**。
- 每次同步按文件单事务提交：中止、断电、DSH 重启都不会留下半写的块，下次同步自然续做。
- 同步摘要（新增/更新/删除/跳过/失败/耗时）写入 `sync_log`，面板「同步记录」可查；
  每条记录下面还会**逐文件列出这次到底同步了哪些内容**（新增 / 更新 / 删除 / 失败四组，
  带相对路径；新增与更新的文件可一键在资源管理器中定位）。老记录没有明细，就只显示摘要。

## 为什么这样检索

| 技术选择 | 原因（均为实测） |
| --- | --- |
| 预分词后写入 FTS | SQLite `unicode61` 不切中文：原文直索 `MATCH '追溯'` 命中 0 条，分词后可命中并 BM25 排序 |
| 加中文二字组合 | `Intl.Segmenter` 把"袋线瓶线"切成 袋\|线\|瓶\|线，单字被丢弃后检索失败；补二字组合后 2 字查询走正常词元 |
| trigram 子串路 | 覆盖分词切不准的场合；2 字查询 trigram MATCH 无效，因此 1 字查询才退化为 LIKE |
| RRF 融合 | BM25 是负分、子串路是名次，量纲不同不能直接相加；RRF 只看名次 |
| 每文件最多 3 块 | 避免一份文件刷满结果，保证结果覆盖多个来源 |
| 全离线 | 公司资料不出本机：不调用任何外部 API、不装服务、不开端口 |

## 抽取能力

| 格式 | 方式 |
| --- | --- |
| `.docx` `.xlsx` `.pptx` | 自解析 ZIP + XML（表格按行、表名/幻灯片作标题），零第三方依赖 |
| `.md` `.txt` `.csv` `.json` `.log` … | 直读，带 UTF-8/UTF-16/GB18030/Big5 编码探测 |
| `.pdf` | `Windows.Data.Pdf` 渲染到内存 → Windows 内置中文 OCR（`zh-cn`），逐页标记 |
| `.png` `.jpg` … | 直接 Windows OCR |
| 纯图片 docx | 正文为空时抽出内嵌图片单独 OCR（架构图、截图型文档） |
| `.doc` `.xls` | 本机 Word COM（晚绑定、禁用宏、只读、**一份文件一批 + 超时隔离**） |
| `.dwg` `.apk` `.zip` … | 只登记元数据，结果里给出完整路径供其它工具打开 |

OCR / Word 都不可用时不会报错中断：相应文件标为 `needs_ocr` / `needs_conversion` 并在状态里列出。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 面板显示"面板连接失败" | 先跑 `kb_status` 看"面板接口"一行：`已注册` = 接口正常（多半是没刷新页面）；`未注册：运行时没有 webServer 服务` = 宿主启动顺序问题（本插件会轮询等服务出现，最多 30 秒，若仍失败说明该 profile 没有 webServer 行）；`注册失败: xxx` = 按错误信息定位 |
| 面板接口路径被占用 | 改 `webPath`（默认 `/company-kb-api`）后重启；重复注册会由 webServer 抛 duplicate 错误并记录在本插件的状态里 |
| 检索说"尚未建库" | 还没手动同步过：点面板「立即同步」或 `node lib/cli.mjs index` |
| 搜不到刚放进去的资料 | 这是手动同步模型：先同步（结果里会提示"索引之后有 N 个文件变化"） |
| 某个文件没有正文 | `kb_status` 看失败清单：`needs_ocr`（扫描件/纯图片）、`needs_conversion`（旧版 Office）、`metadata`（二进制或超限） |
| 点「在文件夹中显示 / 用本机程序打开」没反应 | 三个已知坑：Node 给 `/select,路径` 自动加引号后 explorer 解析不了、`detached` 进程不弹窗、`windowsHide` 会把 explorer 自己创建的窗口藏起来。本插件改为手动拼 `/select,"完整路径"` + `windowsVerbatimArguments` + 不 detach + 不隐藏；可用 `node test/reveal-probe.mjs "<文件路径>" reveal` 复现验证 |
| 排查时想确认窗口到底有没有弹出 | 用 PowerShell 枚举可见窗口对比前后即可；**不要**用 `$js \| node` 把含中文路径的脚本从 stdin 喂进去——管道按本地代码页转码，中文路径会变乱码，容易误判"无效" |
| Word 提取偶发卡死 | 已按"一份文件一批 + 75s 超时"隔离；仍频繁出现可设 `legacyDoc: 'skip'`，或在设置页关掉 |
| 索引体积过大 | 设置页关掉 trigram 后重建；或删除 `~/.dsh/local-kb` 重新建库 |

## 验收

```bash
node --test test/*.test.mjs          # 51 项单测：门禁/分词/分块/索引/HTTP/面板渲染/打开原文件/回环校验
node lib/selftest.mjs --rebuild      # 全量重建 + 抽取覆盖率 + 15 条金标查询
node lib/cli.mjs status              # 状态与失败清单
node lib/cli.mjs search "关键词"
```

单测里 `手动同步语义` 一项是这套设计的核心保证：新增文件后**直接检索必须搜不到**，手动同步后才搜得到，删除后同步即消失。

## 安全边界

- 插件对知识库目录**只读**：只调用读操作，从不写入、移动或删除其中任何文件。
- 唯一的写入目标是 `~/.dsh/local-kb/`（索引库与设置）与系统临时目录（OCR 中间文件，用完即删）。
- Web API 挂在 DSH 自身站点下（默认 `127.0.0.1:8080`），能力仅"读索引 + 触发同步 + 读写插件设置
  + 打开/直出**已在索引中且位于配置根目录之内**的文件"；接口只接受回环 Host（挡 DNS rebinding）。
  若把 DSH 暴露到公网，该接口与 DSH 本身同权，请用反向代理加登录保护。
- `/open`、`/reveal`、`/raw` 都先经 `resolveOriginal()` 校验：文件必须在索引里、路径必须落在
  `roots` 之内、且磁盘上确实存在，否则一律 403/404；**打开动作是"只读打开"**（把文件交给关联程序），
  插件不写入原文件。
- Word 提取以 `AutomationSecurity = 3`（强制禁用宏）只读打开文档。

## License

MIT © wu81313-lab

