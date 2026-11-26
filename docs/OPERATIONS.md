# 部署与运维手册（OPERATIONS）

> 适用范围：`gitea-search-mcp`（原 `dsh-gitea-search`；本地 bare 裸镜像 + `git grep` 代码检索 + SQLite FTS5 全文检索 + 通用 MCP 服务）。  
> 快速入门见 [`README.md`](../README.md)；从 `v1.2.x` 升级见 [`UPGRADING.md`](../UPGRADING.md)；安装后闭环验收见 [`POST-INSTALL.md`](POST-INSTALL.md)；日常检索见 [`USAGE.md`](USAGE.md)；能力边界见 [`BOUNDARIES.md`](BOUNDARIES.md)。

---

## 1. 多场景部署与定时同步

### 1.1 场景 A：Zero-Gitea 本地演示（单机链路验证）

无需搭建 Gitea、Token 或 SSH 密钥。脚本参数是**专用输出目录**，不是待扫描的源码目录：

```bash
bash scripts/quickstart-local.sh /tmp/gitea-search-mcp-demo
bin/gts -D "Architecture"
```

该脚本会在输出目录创建合成的 `local/demo-project.git` bare 仓、构建 SQLite FTS5 索引、在当前 checkout 根目录新建 `config.json`（已有不同配置或软链接会被拒绝覆盖），并打印通用 `mcpServers` JSON 示例。它不会递归探测或导入已有本地 Git 仓库。若演示结束后不再使用该配置，删除脚本生成的项目根 `config.json` 即可。

---

### 1.2 场景 B：标准生产环境部署（连接 Gitea / Forgejo）

#### 步骤 1：一键安装依赖与环境预检

- **Linux (Debian / Ubuntu / RHEL / Alpine)**：
  ```bash
  export GITEA_OWNERS="my-org"
  bash scripts/setup.sh
  # 可选接入指定 DSH profile：
  bash scripts/setup.sh --install-dsh --profile desktop
  ```
- **macOS (12+，兼容系统 Bash 3.2 与 BSD 工具链)**：
  ```bash
  export GITEA_OWNERS="my-org"
  bash scripts/setup-macos.sh
  # 可选接入：--install-dsh --profile desktop|web|headless
  ```

两个 POSIX 安装器均拒绝缺失或占位 owner（如 `myorg`）；`--profile Auto` 仅在恰好发现唯一 profile 时生效，只有显式 `--profile all` 才会修改全部候选。

#### 步骤 2：只读凭据配置（最小特权原则）

连接私有 Gitea / Forgejo 实例时，请使用**只读 Access Token 或只读 Deploy Key**：
- 在 Gitea 用户设置 -> 应用（Applications）中生成 Token，仅勾选 `repo:read`（及可选 `organization:read`）；
- 严禁授予 `repo:write` 或 `admin` 权限。

#### 步骤 3：首次同步与周期性 Cron 刷新

确认 `GITEA_URL`、`GITEA_TOKEN`、`GITEA_MIRROR_ROOT` 与 `GITEA_OWNERS` 后，显式执行首次同步：

```bash
bash scripts/sync.sh -q
```

`sync.sh` 同步成功后会自动调用 `lib/indexer.py --build` 更新 FTS5 索引（输出写入 `$GITEA_MIRROR_ROOT/state/index-last.log`），无需重复手动建索引。`v2.0.3` 起 `sync.sh` 自带全局锁（`state/sync.lock`）：Cron 与 MCP `sync_mirror`（或 `gts --sync`）同时触发时，后到者以退出码 `75`（`SYNC_BUSY`）让路，无需再套外层 `flock`。生产环境推荐配置宿主机 Cron 定时增量刷新：

```cron
17 * * * * /opt/gitea-search-mcp/scripts/sync.sh -q >> /var/log/gitea-mirror.log 2>&1
```

> 退出码：`0` 全部成功；`1` 有仓同步失败或索引失败；`2` 参数/配置错误；`75` 另一轮同步进行中（正常让路，监控不应据此告警）。尚无任何提交的**全新空仓库**（本地镜像也从未有过对象）视为成功，首次提交后下一轮自动纳入检索；已有历史的镜像遇到远端被清空仍 fail closed 并保留原 `HEAD`（设 `GITQ_EMPTY_REMOTE=fail` 可恢复 2.0.2 的「空远端一律失败」）。

完成同步后，按 [`POST-INSTALL.md`](POST-INSTALL.md) 依次运行 `onboarding`、`doctor-mcp` 并重载宿主验证端到端检索。

---

### 1.3 原生 Windows 环境部署

Windows `CreateProcess` 只认 PE 二进制（`.exe` / `.com`），不支持 POSIX shebang 脚本，因此需要通过 `pip install` 或一键脚本生成原生 `Scripts\gts.exe` 启动器（底层原理见 [`dev/ENGINEERING-NOTES.md`](dev/ENGINEERING-NOTES.md)）。

#### 方式 A：PowerShell 一键安装（推荐，免管理员权限）

安装器要求 Python ≥ 3.10、Node ≥ 20.11 及 `npm.cmd`。默认执行 `pip install ".[fts]"` 安装 `jieba`，运行 `npm ci` 验证 MCP SDK 可导入后才按需注册 profile：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Owners my-org -MirrorRoot C:\gitea-mirror -WhatIf
# 复核计划后去掉 -WhatIf；接入 DSH 时加 -RegisterDsh -Profile desktop|web|headless
# 隔离测试可用 -DshHome C:\temp\isolated-dsh；仅跳过初次建库可用 -SkipIndex
```

#### 方式 B：标准 `pip` 或 `PyInstaller` 打包

```powershell
# 标准 pip 安装（生成 <Python>\Scripts\gts.exe；无管理员权限可加 --user）
python -m pip install ".[fts]"
gts --help

# 可选：PyInstaller 单目录打包（适合目标机不装完整 Python）
pip install pyinstaller
pyinstaller --onedir --name gts --hidden-import=indexer --paths=lib bin\gts
```

> ⚠️ **Windows 路径与变量注意项**：`GITEA_SEARCH_CLI`（兼容 `GTS_BIN`）必须是**单个可执行文件的完整路径**（如 `C:\path\to\Scripts\gts.exe`），严禁写成 `"python bin\gts"` 等带空格的参数组合（会导致 `ENOENT`）。`scripts/sync.sh` 为 Bash 脚本，Windows 下请通过 Git Bash 或既有 Git 镜像流程运行同步。

---

## 2. DSH Profile 接线规范（`cordis.patch.yml`）

通用 MCP 客户端（Claude Desktop / Cursor / Cline / Windsurf / Codex）请直接使用 [`README.md`](../README.md#主流-mcp-客户端接入) 中的标准 JSON。DeepSeek Harness (DSH) 使用 `cordis.patch.yml` 时须遵守三项硬性规范：
1. 顶层必须是 YAML 数组（`- insert:`）；
2. `config` 为扁平对象，严禁嵌套 `servers:`；
3. **必须显式声明 `transport: stdio`**（省略会导致静默不连接）。

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-gitea-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitea-search          # 实际调用名以宿主工具注册表为准
        transport: stdio                  # 必填项
        command: node
        args: ["/opt/gitea-search-mcp/bin/mcp-server"]
        cwd: /opt/gitea-search-mcp
        env:
          GITEA_MIRROR_ROOT: "/srv/gitea-mirror"
          GITEA_OWNERS: "my-org,core-team"
```

若已将 `mirror_root` 与 `owners` 写入 `~/.config/gitea-search-mcp/config.json`，纯检索场景下 `env` 块可以省略；若同时希望在宿主内通过 MCP `sync_mirror` 执行完整 API 仓库枚举（避免回退 `enum_source=disk`/`cache` 并触发 `SYNC_DEGRADED`），请在宿主 MCP `env` 中补充 `GITEA_URL`（及按需配置 `GITEA_REMOTE` / `GITQ_GIT_USER` / `GITEA_TOKEN`，或在 `<mirror_root>/.sync-token` 放置只读 Token）。

---

## 3. 配置参数全表参考

### 3.1 配置文件 `config.json`

`lib/server.mjs`、`bin/gts` 与 `lib/indexer.py` 共用同一解析优先级：  
**CLI 参数 > 环境变量 > 显式 `--config` / `GITEA_SEARCH_CONFIG` > `~/.config/gitea-search-mcp/config.json`（不存在时自动回退旧 `~/.config/dsh-gitea-search/config.json`） > 项目根 `config.json` > 平台默认镜像目录**。`owners` 无默认值，缺失或为 `myorg` 等占位值时 fail-closed。

```json
{
  "gitea": {
    "owners": ["my-org", "core-team"]
  },
  "storage": {
    "mirror_root": "/srv/gitea-mirror"
  }
}
```

运行时只从 JSON 消费 `storage.mirror_root` 与 `gitea.owners`（兼容顶层同名键），**有意不支持 `gitea.url` / `gitea.token`**（写入会在 `gts --show-effective-config` 报告忽略提示而不打印值）；`sync.sh` 与 `sync_mirror` 所需的远端地址与凭据一律通过环境变量（或 `<mirror_root>/.sync-token`）传入。

### 3.2 环境变量对照表

| 标准环境变量 | 兼容历史变量 | 默认值 | 作用说明 |
|---|---|---|---|
| `GITEA_SEARCH_CONFIG` | — | — | 显式指定共享 `config.json` 路径（缺失即报错，不静默回退） |
| `GITEA_MIRROR_ROOT` | `GITEA_MIRROR_PATH` / `GITQ_MIRROR_ROOT` | 平台用户数据目录 | 裸镜像与 SQLite 索引根目录 |
| `GITEA_OWNERS` | `GITEA_OWNER` / `GITQ_OWNER` | **必填（无默认值）** | 索引与同步的组织/用户名（逗号分隔多 owner） |
| `GITEA_SEARCH_CLI` | `GTS_BIN` / `GITQ_BIN` | 自动探测 | 显式指定 `gts` / `gts.exe` 路径（缺失即报错，不回退 PATH） |
| `GITEA_VENV_PATH` | `GITQ_VENV_PATH` | — | 指定含 `jieba` 的 Python 虚拟环境路径 |
| `GITEA_ALLOW_NO_JIEBA` | `GITQ_ALLOW_NO_JIEBA` | `0` | 设为 `1` 时显式允许无 `jieba` 环境仅建英文索引 |
| `GITEA_URL` | `GITEA_API_BASE` / `GITQ_API_BASE` | `https://git.example.com` | `sync.sh` 访问的 Gitea / Forgejo 实例地址 |
| `GITEA_TOKEN` | `GITEA_API_TOKEN` / `GITQ_API_TOKEN` | — | `sync.sh` 使用的只读 API Token |
| `GITEA_REMOTE` / `GITEA_SSH_HOST` | `GITQ_REMOTE` / `GITQ_SSH_HOST` | `gitea` / — | `sync.sh` SSH 克隆别名（`~/.ssh/config`）与可选 SSH 管理端枚举主机 |
| `GITQ_ENUM` / `GITQ_TRANSPORT` / `GITQ_JOBS` | — | `auto` / `auto` / `6` | `sync.sh` 仓库枚举（`auto`/`api`/`ssh`）、克隆通道（`auto`/`ssh`/`https`）与并发度 |
| `GITQ_EMPTY_REMOTE` | — | `ok` | `sync.sh` 对「全新空远端仓库」的处理：`ok` 视为成功；`fail` 恢复 2.0.2 的 fail-closed 行为（v2.0.3） |
| `GITEA_MAX_RESULTS` | `GITQ_MAX_RESULTS` | `200`（硬上限 `1000`） | 单次搜索返回条数硬夹上限（工具默认请求 `5`） |
| `GITEA_MAX_LINE_BYTES` | `GITQ_MAX_LINE_BYTES` | `2000` | 单行最大字节数（UTF-8 边界安全截断） |
| `GITEA_MAX_SEARCH_BYTES` | `GITQ_MAX_SEARCH_BYTES` | `131072`（128 KiB） | 单次搜索总输出字节预算上限 |
| `GITEA_MAX_READ_BYTES` | `GITQ_MAX_READ_BYTES` | `60000`（60 KB） | `read_file` 单次读取字节上限 |
| `GITEA_MAX_BLOB_BYTES` | — | `33554432`（32 MiB） | `read_file` 可读取的单个文件大小上限，超出返回 `FILE_TOO_LARGE`（v2.0.3） |
| `GITEA_MAX_CHILD_OUTPUT_BYTES` | — | `67108864`（64 MiB） | 单个子进程（`gts` / `git`）输出上限，超出即终止并返回 `OUTPUT_TOO_LARGE`（v2.0.3） |
| `GITEA_MAX_CONCURRENCY` | — | `4`（上限 `64`） | MCP 同时运行的 `gts` / `git` 子进程数，超出排队；取消的请求在排队期即退出（v2.0.3） |
| `GITEA_SYNC_TIMEOUT` | — | `900`（秒） | `sync_mirror` / `gts --sync` / `gts --sync-only` 中同步脚本的超时；超时后整个进程组被终止（v2.0.3） |
| `GITEA_READ_DEFAULT_LINES` | `GITQ_READ_DEFAULT_LINES` | `400` | `read_file` 默认返回行数 |
| `GITEA_REDACT_SECRETS` | — | 开启 | 设 `0`/`false`/`off` 关闭「输出前自动脱敏疑似密钥」（`search_code` / `search_docs` / `read_file` 的返回文本；`lib/security.mjs`） |
| `GITEA_BLOCK_SENSITIVE_PATHS` | — | 开启 | 设 `0`/`false`/`off` 关闭敏感路径护栏：默认不索引、不返回 `.env*`、`id_rsa`、`*.pem`/`*.key`、`credentials.json`、`auth.json`、`.aws/credentials`、`.docker/config.json`、`.dockercfg`、`.kube/config`、`kubeconfig`、`.pgpass`、`.htpasswd`、`*.tfstate[.backup]`、归档（`*.tar*`/`*.zip`）等；`*.example`/`*.sample`/`*.template` 模板文件不受影响 |
| `GITEA_EXCLUDE_REPOS` | — | — | 索引时排除的仓库（逗号分隔，`owner/repo`、裸名子串或 `*` 通配）；用于排除归档/噪声仓，仅影响 FTS 索引，`search_code` 仍可搜 |
| `GITEA_AUDIT_LOG` | — | 关闭（空 / `0`） | 可选审计埋点：设 `1`/`auto` 写入用户状态目录按月轮转 JSONL，或填显式 `.jsonl` 路径 |
| `GITEA_AUDIT_INCLUDE_QUERY` | — | `0`（脱敏） | 设为 `1` 时才在服务端审计日志（`audit-YYYY-MM.jsonl`）和 FTS 性能日志（`state/perf-metrics.jsonl`）中记录截断后的原始 `query`/过滤词；默认两处均不落盘原始查询（审计日志仅记长度与 SHA-256 前 8 位，性能日志仅记 `query_len` 与聚合维度） |
| `GITEA_AUDIT_CLIENT` / `GITEA_AUDIT_SESSION_ID` | — | 自动识别 | 可选覆写审计日志中的宿主客户端名称与进程会话关联 ID |

---

## 4. 输出有界化与跨平台安全护栏

1. **四层上下文防爆窗护栏（`lib/server.mjs`）**：
   - 条数硬夹（默认返回 Top 5，最大硬夹至 `GITEA_MAX_RESULTS`）；
   - 单行 UTF-8 字节安全截断（默认 2000B，退续位不产生 `U+FFFD` 乱码）；
   - 单次搜索总字节预算熔断（默认 128 KiB）；
   - `read_file` 窗口化切片读取（默认 400 行 / 60 KB 上限）。
2. **凭据泄露护栏（默认开启，`lib/security.mjs`）**：返回给 MCP 客户端的文本先做高置信度密钥脱敏（含跨分页/单行命中的多行私钥块上下文识别，命中处替换并在结果里标注 `已自动脱敏 N 处`；`search_code` 按 `git grep` 实际命中的固定 commit OID 核查整文件，旧 FTS 索引按已记录的 `blob_sha` 核查，无法核实时自动省略正文/摘要），敏感路径（见 `GITEA_BLOCK_SENSITIVE_PATHS`）既不进 FTS 索引也不在搜索/读取中返回；`search_code` / `read_file` / `list_repositories` / `search_docs` 声明 `readOnlyHint: true, destructiveHint: false, openWorldHint: false`（Codex 等宿主因此可免审批自动放行）；唯一会写镜像的 `sync_mirror` 声明 `readOnlyHint: false, destructiveHint: true, openWorldHint: true`（`remote update --prune` 会修剪上游已删除的本地 ref）。单行规则覆盖 `*_PASSWORD` / `*_SECRET` / `*_TOKEN` / `*_PASS` 形态的键、JSON 带引号键与 PGP 私钥块；赋值语境下会放行多段本地路径及短小写根挂载名/文件名（如 `private_key=/identity`、`/tls.key`），其余前导斜杠高熵或歧义字符串按保守策略脱敏。覆盖是“尽力而为”的高置信度规则，不是完备的 DLP。`GITEA_REDACT_SECRETS=0` / `GITEA_BLOCK_SENSITIVE_PATHS=0` 可分别关闭。
3. **资源与生命周期护栏（v2.0.3）**：
   - `read_file` 先取对象大小，超过 `GITEA_MAX_BLOB_BYTES` 直接 `FILE_TOO_LARGE`；任一子进程输出超过 `GITEA_MAX_CHILD_OUTPUT_BYTES` 即终止并返回 `OUTPUT_TOO_LARGE`，不再整块读入 Node 内存；
   - 工具调用并发受 `GITEA_MAX_CONCURRENCY` 限制（超出排队，排队中被取消的请求不会启动子进程）；
   - 尊重 MCP 请求取消：POSIX 上子进程运行在独立进程组，取消 / 超时 / 宿主断开 / 服务退出时整组终止（`gts` → `git grep` / `sync.sh` 不留孤儿）；
   - `ref` 白名单（拒绝以 `-` 开头及 `:`、空白、控制字符），防止被 `git` 当作选项解析。
4. **Windows 子进程与跨平台执行护栏**：
   - 原生 `.exe` / `.com` 始终以 `shell: false` 直执行，完全绕过 `cmd.exe`；
   - 仅 `.cmd` / `.bat` 降级入口经 `cmd /d /s /c`：进入 shell 前先**拒绝 NUL、CR/LF** 以及会触发二次解析的 `% ! ^ & | < >`，其余参数再按 Windows 引号规则逐一定界（`/s` 仅控制外层引号剥离，不单独构成注入防护）；
   - `PATH` 自动探测只接受绝对路径目录（拒绝空项、`.` 与相对目录），防止不可信工作目录同名程序植入；
   - 索引锁在 POSIX 采用 `fcntl.flock`，在 Windows 采用显式 `seek(0)` 对齐的 `msvcrt.locking` 字节区间排他锁。

---

## 5. FTS5 索引原理与故障排查

### 5.1 索引性能与一致性机制

- **高性能增量构建**：每个仓库复用单个常驻 `git cat-file --batch` 管道（`BlobReader`），通过 `head_commit` SHA 变更门控跳过未变动仓库（稳态增量扫描仅需秒级），并用独立 `doc_rowid` B-Tree 表将文档增删改定位压至 $O(\log N)$。升级后若新增了敏感路径排除规则，增量构建会通过 `index_meta.sensitive_filter_version` 自动清理旧库残留行，无需全量重建。
- **容错构建（v2.0.3）**：空仓库（零 ref）被跳过并清理其旧索引行；`HEAD` 悬空时回退到第一个本地分支；单仓读取失败只隔离该仓，其余照常索引，整轮结束后以 `INDEX_READ_FAILED: N 个仓索引失败…` 非零退出。`gts --reindex --full` 先写 `gitea-fts.sqlite.new` 再原子替换，失败或被中断时旧索引原样保留、搜索不中断。
- **四表 1:1 一致性自检**：健康索引满足 `file_blobs == docs_fts == docs_fts_docsize == doc_rowid`。随时可通过 `gts --fts-stats` 或 `gts --doctor --json` 检查；若异常或从 `≤ v1.2.2` 升级触发 `INDEX_REBUILD_REQUIRED`，执行 `gts --reindex --full` 即可全量重建。

### 5.2 常见故障速查表

| 故障现象 | 常见原因与排查处置 |
|---|---|
| **已推送远端的代码/文档搜不到** | 尚未同步本地镜像：执行 `bash scripts/sync.sh -q`（自动更新索引），并用 `gts --doctor --json` 检查 `mirror_sync` 状态。 |
| **中文关键词检索报错 `DEPENDENCY_MISSING` 或 0 命中** | Python 环境缺少 `jieba` 或尚未建库：执行 `python3 -m pip install '.[fts]'` 后运行 `gts --reindex`。 |
| **旧索引报错 `INDEX_REBUILD_REQUIRED`** | 本地索引仍为 `v1.2.2` 及更早的裸仓名格式（`user_version=0/1`）：运行 `gts --reindex --full` 重建 `owner/repo` 索引。`v2.0.2` 因构建中途失败而遗留的索引（行均为 `owner/repo`）会在下次增量构建时自动恢复，无需 `--full`。 |
| **`INDEX_UPDATE_FAILED` / `INDEX_READ_FAILED`** | 看 `$GITEA_MIRROR_ROOT/state/index-last.log` 末尾：会列出失败的仓与阶段；其余仓已正常索引，修复后下一轮增量自动补齐。 |
| **`sync.sh` 退出 `75` / 结果里出现 `SYNC_BUSY`** | 另一轮同步正在进行（锁 `state/sync.lock`），属正常让路；若长期如此，检查是否有挂死的同步进程（`state/sync.lock` 由该进程持有）。 |
| **`sync_mirror` 返回 `SYNC_DEGRADED`** | 已知仓已同步成功，但本轮 API/SSH 仓库枚举不可用而回退到缓存（`cache`）或本地目录（`disk`），新推送仓库可能未被发现；检查 `GITEA_URL` / `GITEA_TOKEN` 或 SSH 连通性后重试。 |
| **`FILE_TOO_LARGE` / `OUTPUT_TOO_LARGE`** | 资源护栏触发：用 `search_code` 定位片段；确需放宽再调大 `GITEA_MAX_BLOB_BYTES` / `GITEA_MAX_CHILD_OUTPUT_BYTES`。 |
| **`PARTIAL_RESULT(GIT_SEARCH_FAILED)`** | 个别镜像仓损坏或不可读：按失败详情中的仓名运行 `git --git-dir=<root>/<owner>/<repo>.git fsck` 或重新 `clone --mirror`。 |
| **Node 20.11~22.14 报缺 `sqlite3` / `zstd`** | 低版本 Node 回退依赖系统 CLI：安装系统 `sqlite3` 与 `zstd` 包，或升级至 Node 22.15+ LTS。 |
| **Windows 报 `找不到可执行的 gts CLI`** | 执行 `python -m pip install ".[fts]"` 生成 `Scripts\gts.exe`，或将 `$env:GITEA_SEARCH_CLI` 设为单个 `.exe` 完整路径。 |
| **修改配置或升级代码后宿主未生效** | MCP 为宿主常驻子进程：重载宿主（Linux 下亦可运行 `bash scripts/respawn-mcp.sh` 平滑重启子进程）。 |
| **DSH `session-query.sqlite-wal` 体积过大** | 运行 `node scripts/dsh-session-health.mjs --fix` 执行在线 `PRAGMA wal_checkpoint(TRUNCATE)`。 |

### 5.3 本地回归验证命令（源码仓库内执行）

```bash
npm test             # Node 跨平台单元与协议契约测试（node --test）
npm run test:python  # Python 核心回归与文档/配置契约测试
npm run test:e2e     # 31 项合成裸镜像与 MCP 全链路验收
npm run test:all     # 一键运行上述三层完整测试集
npm run test:pack    # 树外验证 npm pack 打包产物完整性与 stdio 探针
npm run test:hygiene # 公开树敏感凭据/内网坐标与干净工作区扫描
```

### 5.4 调用审计埋点、调试分析组件（`gts-audit`）与伴生可视化调试

默认完全关闭（零磁盘 I/O）。需要审计宿主调用频率、阶段分布与省时收益时，可组合使用双层能力：

1. **服务端 JSONL 审计埋点（可选开启，稳定契约 `schema: 1`）**：在宿主的 MCP `env` 中设置 `GITEA_AUDIT_LOG=1`（按月写入用户状态目录 `audit-YYYY-MM.jsonl`，或指定显式 `.jsonl` 文件路径）。默认仅记录工具名、耗时、命中数、输出字节、护栏截断标志与脱敏后的 `query_len` / `query_sha8`；仅在显式设 `GITEA_AUDIT_INCLUDE_QUERY=1` 时记录截断原始查询词。
   - **公开 JSONL 契约（`schema: 1`）**：每行一条 JSON 记录，固定包含 `schema`、`ts`、`proc_session_id`、`pid`、`ppid`、`client`、`tool`、`raw_tool`、`deprecated_alias`、`args_meta`、`elapsed_ms`、`resp_bytes`、`truncated`、`is_error`，以及可选字段 `client_version`、`internal_ms`、`hits`、`hit_repos`（命中仓库名，至多 10 个）、`redacted_hits`（本次输出被自动脱敏的处数）、`blocked_sensitive`（被敏感路径护栏屏蔽的命中数）；后三者仅在非空时出现，均不含任何密钥或文件内容。任何外部看板、脚本或伴生 UI 均可直接消费该 JSONL 流，无需导入服务端内部模块。
2. **离线调试分析 CLI（`scripts/audit-usage.mjs` / `gts-audit`）**：同时聚合服务端审计日志与本机宿主会话转录（T3/Antigravity、DSH v4、Codex），自动剥离 lazy MCP schema 读取开销，按「检索意图簇（Search Episode）」聚类去重并输出三档（保守 / 基线 / 乐观）净省时估算：

```bash
# 自动探测默认状态目录与本机宿主会话目录
node scripts/audit-usage.mjs

# 显式指定自定义宿主目录并导出 Markdown / JSON 报表
node scripts/audit-usage.mjs --dsh-home ~/.dsh --t3-dir ~/.t3/userdata/providers --since 7d --markdown
node scripts/audit-usage.mjs --audit-log ~/.local/state/gitea-search-mcp --json
```

3. **在线可视化检索调试（独立伴生客户端）**：`gitea-search-mcp` 坚持纯 stdio MCP Server 边界，不内置 Web 面板或 HTTP 端口；如需在浏览器中做实时 `tools/call` JSON-RPC 报文调试、耗时观察或与向量栈做多路排名对比，可使用独立的零依赖只读 MCP 客户端伴生工具（如 `dsh-archive-viewer`）通过标准 stdio 挂载本服务：

```bash
HOST=127.0.0.1 PORT=3082 \
  MCP_CMD=node \
  MCP_ARGS_JSON='["/path/to/gitea-search-mcp/bin/mcp-server"]' \
  MCP_PROFILE=gitea-search \
  dsh-archive-viewer
```

> 分工建议：**`gts-audit`** 负责离线历史维度的调用覆盖率、阶段分布与净省时估算；独立 Web Inspector 负责在线交互式的单次召回质量与原始 JSON-RPC 报文调试。
