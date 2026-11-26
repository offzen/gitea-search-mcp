# 使用指南（USAGE）

> 新安装请先读 [`POST-INSTALL.md`](POST-INSTALL.md) 完成镜像、索引与 MCP 验收；能力边界见 [`BOUNDARIES.md`](BOUNDARIES.md)。

> 本文聚焦于**如何高效使用**：四个只读核心工具与一个同步工具的功能定位、入参规范、省上下文调用法则以及真实工作流场景。
> 生产部署与高可用运维参见 [OPERATIONS.md](OPERATIONS.md)；MCP 工具名前缀机制解析参见 [TOOL-NAMING.md](TOOL-NAMING.md)。

---

## 1. 核心实践三法则

1. **先定位，再精读**：先使用 `search_code` / `search_docs` 锁定目标所在的仓库、相对路径与大致行号，再使用 `read_file` 配合较小的 `limit` 读取目标代码片段。**严禁在未定位前直接尝试抓取全量文件**。
2. **多词与中文优先走倒排索引**：查找中文短语、故障排查记录或多词组合时，首选 `search_docs`，利用 SQLite FTS5 + jieba 分词做相关度召回。SQLite warm query 可达到毫秒级；MCP 端到端延迟还包含 Python/jieba 冷启动。
3. **分清检索范围**：`search_code` 覆盖镜像中的全部本地分支；FTS `search_docs` 只索引每仓默认分支。两者都只覆盖已经推送并完成镜像同步的内容。

> 💡 **能力公开边界与向后兼容说明**：  
> 本项目 `v2.x` 标准开源发布的公共契约包含 4 个只读中性核心工具（`search_code`、`search_docs`、`read_file`、`list_repositories`）和 1 个显式同步工具 `sync_mirror`。为保障 `v1.2.x` 老用户平滑升级，`tools/call` 同时兼容 `search_gitea*` 与 `search_gitorca*` 两族旧名（保留至 `v3.0.0` 前，调用时仅在 stderr 输出废弃告警）。若您所在的特定部署环境通过上层网关封装了混合召回（如各类 `*_hybrid` 向量融合工具），请以宿主实际注册的扩展工具清单为准。

---

## 2. 核心工具速查

以下小节使用 MCP server 的**裸工具名**。宿主可能加前缀、清洗或重命名；安装后必须查看当前宿主的实际工具注册表，不能只替换示例前缀来猜调用名。

### 2.1 `search_code` —— 跨仓代码检索

基于本地 bare 镜像执行极速 `git grep`，跨所有仓库检索代码内容、路径及提交信息，无需逐个 clone。（兼容旧名：`search_gitea` / `search_gitorca`）

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | **必填**。检索关键词或短语；当 `regex: true` 时按扩展正则表达式（egrep）解析 |
| `mode` | string | 检索模式：`content`（默认，搜文件内容）/ `path`（搜文件名与路径）/ `message`（搜 commit 提交日志；默认按字面量匹配，`fix(auth`、`[WIP` 等含括号的查询无需转义，`regex: true` 才按正则解释） |
| `repo` | string | 限定仓库范围：`owner/repo` 按完整身份子串匹配；不含 `/` 的裸名按**仓名子串**匹配各 owner 的仓（`app` 命中 `myapp`）；含 `*` `?` 时按整名通配；逗号分隔多个（如 `"acme/dsh-*"`）。`search_docs` 使用同一套规则 |
| `branch` | string | 限定分支（v2.0.3 起**精确匹配**，前缀/模糊请写 `main*`，逗号分隔多个）；省略时检索全部本地分支；`HEAD` 代表仅检索默认分支 |
| `files_only` | boolean | **省上下文利器**。为 `true` 时仅返回匹配的文件名列表，不返回匹配行文本 |
| `regex` | boolean | 是否开启正则表达式匹配（默认 `false`） |
| `case_sensitive`| boolean | 是否区分大小写（默认 `false`） |
| `max_results` | integer | 返回结果条数上限，**默认 5**（最大被系统硬夹至 200 条） |

> **严格只读契约（v2.0.3）**：`search_code` 自 `v2.0.3` 起不再接受 `sync` 参数，永远不写镜像；旧版调用方仍传 `sync: true` 时不会报错，也不会执行同步，而是在结果中附带 `⚠️ SYNC_MOVED:` 提示。需要刷新镜像时请显式调用 `sync_mirror`（见 §2.5）。
>
> **智能降级机制**：在 `content` 模式下，当多词短语字面量匹配返回 0 命中时，引擎会自动回退为“同一行内多词 AND”模式，输入 `"caddy 证书"` 时无需手动拆分关键词。

---

### 2.2 `search_docs` —— 文档与历史会话全文检索

基于每仓**默认分支**的 SQLite FTS5 索引与 jieba 中文分词，支持 BM25 相关度排序与高亮摘要提取。若目标可能只存在于非默认分支，改用 `search_code` 搜全部 heads，再以 `read_file(ref=...)` 精读。（兼容旧名：`search_gitea_docs` / `search_gitorca_docs`）

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | **必填**。自然语言关键词或短语（如 `"反向代理 502 证书配置"`） |
| `repo` | string | 限定仓库，规则与 `search_code` 完全一致（`owner/repo` 完整身份 / 裸名按仓名子串 / `*` `?` 整名通配 / 逗号分隔多个，如 `"session*"`） |
| `kind` | string | 资产类型软分区，支持逗号分隔：`doc` / `session` / `config` / `script`。**省略则全库检索** |
| `max_results` | integer | 返回匹配文档数上限，**默认 5** |

**四类内容分区（`kind`）典型用途**：
- `session`：检索导出的历次长会话记录，定位历史排障经验、技术决策背景与踩坑教训；
- `doc`：检索技术手册、设计文档、README 与 Runbook；
- `config`：检索 `*.yml`、`*.toml`、`*.conf`、`*.json` 等配置文件（被默认敏感路径护栏屏蔽的 `.env*`、凭据文件不会进入索引）；
- `script`：检索 `*.sh`、`*.bash`、`*.service`、`*.timer`、`*.socket`；当前默认分类器把 `*.py` 归入 `code`，不会被 `kind: script` 命中。

---

### 2.3 `read_file` —— 切片读取文件内容

精准读取指定仓库与分支下的文件正文，内置分段机制与超大截断保护。（兼容旧名：`read_gitea_file` / `read_gitorca_file`）

| 参数 | 类型 | 说明 |
|---|---|---|
| `repo` | string | **必填**。目标仓库名称，推荐 `owner/repo`（如 `"myorg/dsh-toolkit"`） |
| `path` | string | **必填**。仓内相对路径（如 `"deploy/docker-compose.yml"`） |
| `ref` | string | 分支名、Tag 或 Commit SHA；省略时取该仓默认分支。必须是普通修订名：不得以 `-` 开头，不含 `:`、空白或控制字符，否则返回 `INVALID_REF` |
| `offset` | integer | 起始行号（基于 0 开始，默认为 `0`） |
| `limit` | integer | 返回行数。**默认 400 行**；若需获取全文可显式传 `0`（受单次字节上限约束） |

> **文件大小与行号**：单个文件超过 `GITEA_MAX_BLOB_BYTES`（默认 32 MiB）返回 `FILE_TOO_LARGE`，不会读入内存；「共 N 行」不含结尾换行产生的空行；`offset` 超出末尾或文件为空时返回明确提示而不是空正文。
>
> **内置安全护栏**：单次读取受 `GITEA_MAX_READ_BYTES`（默认 60KB，兼容旧 `GITQ_MAX_READ_BYTES`）强约束，超出部分自动截断并附带状态标注。文件路径严格区分大小写，遇路径疑义可先通过 `search_code(mode: "path")` 探路。

---

### 2.4 `list_repositories` —— 镜像仓库资产盘点

（兼容旧名：`list_gitea_repos` / `list_gitorca_repos`）

| 参数 | 类型 | 说明 |
|---|---|---|
| `filter` | string | 仓库名称子串或通配符（如 `"acme/dsh-*"`）；省略则列出镜像库中所有仓库 |

适用于资产梳理、确认新建仓库是否已被同步，或在模糊记忆下进行仓库名称定位。

---

### 2.5 `sync_mirror` —— 显式增量同步镜像与索引（`v2.0.3` 新增）

调用底层 `gts --sync-only --json` 执行 `scripts/sync.sh` 增量镜像同步（`git remote update --prune`）并自动刷新 FTS5 索引。它是五个标准工具中**唯一会写镜像的工具**（MCP 注解 `readOnlyHint: false, destructiveHint: true, openWorldHint: true`），无兼容旧别名。

| 参数 | 类型 | 说明 |
|---|---|---|
| *(无参数)* | object (`{}`) | 不接受任何入参；同步目标与超时由服务端生效的 `GITEA_MIRROR_ROOT`、`GITEA_OWNERS`、`GITEA_SYNC_TIMEOUT` 及宿主 MCP `env` 中的 `GITEA_URL` / `GITEA_TOKEN` / `GITEA_REMOTE` 决定 |

> **使用约定与防降级提示**：仅在刚 `git push` 后必须立刻检索到新提交时显式调用一次，切勿放入循环。`config.json` 有意不读取 `gitea.url` / `gitea.token`；若希望 `sync_mirror` 完成全量 API 仓单枚举（避免触发 `⚠️ SYNC_DEGRADED` 回退到 `disk`/`cache`），请在宿主 MCP `env` 中传入 `GITEA_URL`（以及 `GITEA_TOKEN` 或配置 `<mirror_root>/.sync-token` / `GITEA_REMOTE`）。单次仅支持单个 owner；另一轮同步进行中会安全返回 `⚠️ SYNC_BUSY`。

---

### 2.6 结果头与错误提示速查

| 提示 | 含义 | 建议动作 |
|---|---|---|
| `全库命中 ≥ N 条` | 某仓命中触顶（每仓上限 `max(500, max_results×5)` 行），N 是下界 | 缩小 query 或用 `repo` 限定 |
| `PARTIAL_RESULT(GIT_SEARCH_FAILED)` | 部分仓搜索失败，但其余仓有命中；结果**不完整** | 不要据此断言其余仓零命中；按失败详情修复该仓后重试。零命中且有失败仍按 `GIT_SEARCH_FAILED` 报错 |
| `SYNC_BUSY` | 调用 `sync_mirror` 时另一轮同步正在进行，本次未同步 | 结果基于当前镜像（可能略旧）；稍后重试或查看 `state/last_status` |
| `SYNC_DEGRADED` | `sync_mirror` 更新了已知仓，但枚举降级为缓存/本地目录，未取得完整仓单 | 新创建的仓库可能暂未被发现；检查远端 API/SSH 连通性后再调用 `sync_mirror` |
| `SYNC_MOVED` | 旧调用方向只读 `search_code` 传入了已移除的 `sync: true` 参数 | 本次未同步，仅基于当前镜像检索；需要刷新镜像请改调 `sync_mirror` |
| `FILE_TOO_LARGE` | `read_file` 目标超过 `GITEA_MAX_BLOB_BYTES` | 用 `search_code` 定位片段；确需读取可调大该变量 |
| `OUTPUT_TOO_LARGE` | 子进程输出超过 `GITEA_MAX_CHILD_OUTPUT_BYTES`，已终止 | 缩小 query、限定 `repo`、降低 `max_results` |
| `INVALID_REF` | `read_file` 的 `ref` 含非法字符或以 `-` 开头 | 改用分支 / tag / commit 名 |
| `CANCELLED` | 客户端取消了请求，子进程组已终止 | 无需处理 |
| `INDEX_REBUILD_REQUIRED` | 索引是 `v1.2.2` 及更早的裸仓名格式 | 执行 `gts --reindex --full`（2.0.2 因中途失败遗留的索引会自动恢复，无需此步） |

---

## 3. 典型实战场景示范

### 场景 1：查找某个配置项在哪个仓库中定义（标准两步法）

> **用户提问**：“查一下哪个仓库的 docker-compose 里面使用了 cpm-panel 这个容器镜像？”

```jsonc
// 步骤 1：探路。设置 files_only: true 仅返回文件名，消耗极低 Token
{
  "name": "search_code",
  "arguments": {
    "query": "cpm-panel",
    "files_only": true
  }
}

// 返回示例：命中 repo="myorg/cpm-deploy", path="docker/compose.yml"

// 步骤 2：精读。针对性读取该文件前 50 行，避免全量输出
{
  "name": "read_file",
  "arguments": {
    "repo": "myorg/cpm-deploy",
    "path": "docker/compose.yml",
    "offset": 0,
    "limit": 50
  }
}
```

---

### 场景 2：跨会话复盘既往故障解决过程

> **用户提问**：“上周 Caddy 泛域名证书续期报 429 频率限制时，我们是怎么处理的？”

```jsonc
// 检索历史会话导出，快速召回当时的决策和临时绕过命令
{
  "name": "search_docs",
  "arguments": {
    "query": "Caddy 证书 429 续期",
    "kind": "session",
    "max_results": 3
  }
}
```

利用 FTS5 + jieba 分词直接命中相关排障会话的高亮片段，无需 Agent 盲目尝试搜索或让用户重复描述背景。

---

### 场景 3：全局重构或接口影响面摸排

> **用户提问**：“排查哪些仓库还在调用 `validateCustomForm` 这个旧方法？”

```jsonc
// 使用扩展正则并开启 files_only 进行全局影响面探测
{
  "name": "search_code",
  "arguments": {
    "query": "validateCustomForm\\(",
    "regex": true,
    "files_only": true
  }
}
```

**关键收益**：在多达数十个匹配点的情况下，`files_only: true` 仅返回仓与路径列表，有效防止几百行匹配代码瞬间灌爆上下文窗口。

---

### 场景 4：搜索结果为空时的排查阶梯

当检索没有返回预期结果时，请按如下顺序递进排查：

1. **确认代码是否已推送**：裸镜像仅抓取 Git 远端已 push 的分支，本地未提交或未推送的工作区不在索引中。
2. **按内容与分支分流**：中文/多词且目标在默认分支时，使用 `search_docs`；若可能位于非默认分支，使用 `search_code` 搜全部 heads，再按 `ref` 读取。
3. **缩小关键词长度**：长句可能因标点或连字差异导致无法匹配，建议精简至 2~3 个核心技术名词。
4. **验证仓库范围**：调用 `list_repositories` 确认目标仓库是否已被纳入同步清单。
5. **按需触发镜像同步**：若目标是刚刚推送的提交，先显式调用一次 `sync_mirror`，再检索。它会写入镜像并更新索引；不要在循环、并发 Agent 或每次查询前默认调用。`search_code` 自 2.0.3 起严格只读，不再接受 `sync` 参数（旧调用方传入时会被忽略并在结果里标注 `SYNC_MOVED`）。

---

## 4. 命令行 CLI 门面（`bin/gts`）

所有底层能力均提供原生 CLI 支持，开发者在脱机或无 Agent 环境下同样可享受极致的跨仓检索体验：

```bash
# 代码内容检索
bin/gts dockge

# 路径匹配检索
bin/gts -p "docker-compose.yml"

# 提交日志信息检索
bin/gts -m "fix(auth)" -r "backend-api"

# 仅输出命中文件列表
bin/gts -l "JWT_SECRET"

# FTS5 文档与会话全文检索
bin/gts -D "沙盒隔离机制"

# 指定内容分区过滤检索
bin/gts -D --kind doc,script "keepalived"

# 查看索引库四表统计与健康状态
bin/gts --fts-stats

# 触发增量扫描与索引构建
bin/gts --reindex
```

常用参数概览（完整列表以 `bin/gts --help` 为准）：

| 参数 | 作用 |
|---|---|
| `-p` / `-m` | 切到路径模式 / 提交信息模式（默认内容模式） |
| `-s` / `-w` / `-E` | 区分大小写 / 全词匹配 / 正则解释 pattern |
| `-l` / `-c` | 只列命中文件 / 每仓命中数排行 |
| `-r <repo>` / `-b <branch>` / `-A` | 限定仓（可重复、逗号分隔、支持 `*`）/ 限定分支 / 连 tags 一起搜 |
| `-D` / `--kind` | 文档与会话 FTS5 检索 / 分区过滤 `doc,session,config,script` |
| `--reindex [--full]` / `--fts-stats` / `--perf-stats` | 增量（或全量安全重建）建索引 / 索引统计 / 性能与 I/O 统计 |
| `--doctor` / `--dsh-home` | 索引与宿主会话健康诊断 / 指定宿主 `.dsh` 目录 |
| `--config` / `--mirror-root` / `--owners` / `--show-effective-config` | 显式配置覆盖与最终配置来源展示 |
| `--read <path>` | 直接读取 `-r` 指定仓内的文件 |
| `--sync` / `--sync-only` | 搜索前先增量同步镜像并更新索引 / 仅同步并刷新索引（`--sync-only --json` 供 `sync_mirror` 消费，含 `degraded`/`enum_source`；写操作） |
| `--repos` | 只列出镜像里的仓 |
| `-n <N>` / `-j <N>` / `--json` | 最多输出行数（默认 200）/ 并发仓数（默认 8）/ JSON 输出 |

---

## 5. Agent 省上下文实战核查清单

无论是由人类制定 Agent 提示词，还是编写自动化执行脚本，建议严格遵循以下准则：

- [ ] **严禁滥用 `max_results`**：保持默认值 `5`，先审阅 Top 5 结果；仅在明确需要遍历时才逐步放宽。
- [ ] **探路阶段必开 `files_only`**：摸底资产范围时只取路径名，不取正文。
- [ ] **切片读取按需索取**：调用 `read_file` 时显式指定 `limit: 30~50`，确认核心段落后再递增 `offset`。
- [ ] **中文检索首选 FTS5 引擎**：避免用 `search_code` 盲目轮询不同词形变体消耗会话轮次。
