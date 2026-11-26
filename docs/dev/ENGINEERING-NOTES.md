# 架构导览与跨平台工程红线（ENGINEERING-NOTES）

> 本文面向维护者与本地协作 AI Agent，浓缩跨版本长期有效的模块边界、原生 Windows 适配原理与底层防踩坑契约（不随 `npm pack` 分发）。

---

## 1. 核心模块地图

| 路径 | 核心职责与副作用边界 |
|---|---|
| `bin/mcp-server` & `src/index.js` | 标准 MCP 入口：`--dump-schema [--compact]` 纯静态导出（零 I/O、零子进程）；默认连接 stdio。 |
| `lib/server.mjs` | 5 个中性工具引擎（4 个只读 + `sync_mirror`）、`search_gitea*`/`search_gitorca*` 兼容转发、`createServer()`/`dumpSchema()`、direct-run 守卫与四层输出护栏。 |
| `bin/gts` & `gts_cli.py` | 跨仓 `git grep` / SQLite FTS5 CLI；`gts_cli.py` 为 setuptools console-script 包装器，优先查 `share/gitea-search-mcp` 并回退旧 `share/dsh-gitea-search`。 |
| `lib/config.mjs` / `lib/config.py` | Node/Python 字节等价的配置解析器：显式 `--config` / `GITEA_SEARCH_CONFIG` 缺失必报错（禁静默回落），默认用户配置与镜像根支持新旧路径自动回退。 |
| `lib/indexer.py` | SQLite FTS5 + `jieba` 索引构建与检索（`PRAGMA user_version = 2`）、单仓 savepoint 原子写入、可信枚举下的消失仓清理（R2）与 `--doctor` 诊断。 |
| `lib/mirror-state.{mjs,py}` & `lib/next-actions.mjs` | 同步成功（`state/last_ok`）与失败尝试（`last_sync` / `state/last_status`）状态区分及 MCP 结构化错误归因。 |
| `scripts/sync.sh` | Gitea / Forgejo 裸镜像增量同步、远端 `ls-remote --symref` + 本地 OID 验证的默认分支 `HEAD` 收敛，以及带降级保护的索引触发。 |

---

## 2. Windows 原生适配与跨平台安全红线

1. **Windows 可执行分类与 PE 启动器**：
   - Windows `CreateProcessW` 不支持 shebang，且 Node `fs.accessSync(p, X_OK)` 在 Windows 上退化为文件存在性检查。`classifyWinExecutable()` 严格按扩展名分流：`.exe`/`.com` 走 `direct`（`shell: false`），`.cmd`/`.bat` 走 `shell`，无扩展名 `bin/gts` 在 Windows 上直接判为不可执行并给出 `pip install ".[fts]"` 指引。
   - `pyproject.toml` 将脚本数据放入 `share/gitea-search-mcp/`，严禁写回 `<prefix>/bin` 或 `Scripts\` 覆盖 `console_scripts` 生成的 `gts.exe`（否则引发启动器自递归 `RecursionError`）。
2. **`.cmd` / `.bat` 命令注入前置拒绝（BatBadBut 防护）**：
   - 原生 `.exe` 走 `shell: false` 是首选安全边界。
   - 仅当降级使用 `.cmd` / `.bat` 时经 `cmd /d /s /c`：在进入 shell 前必须先**拒绝 NUL、CR 与 LF**（防命令截断换行），并**拒绝 `% ! ^ & | < >`**（防环境变量展开与批处理 `%*` 二次解析），通过后再调用 `winQuoteArg`（内部双引号翻倍、紧贴收尾引号的反斜杠翻倍）并包外层引号。不得声称 `cmd /s` 或 `winQuoteArg` 单独能防御批处理注入。
3. **Git 路径按平台分流归一化（严禁在 POSIX 转换反斜杠）**：
   - Windows (NTFS) 上 `\` 是保留分隔符，`normalizeGitPath()` 与 `IS_WINDOWS` 分支将其转为 `/`；
   - POSIX (ext4/APFS) 上 `\` 是**合法单文件名字符**（如 `a\b.md`、`foo\.md`），必须保持原样！无条件转换会导致 `git show` 静默串读到 `a/b.md` 或导致 `classify_kind` 丢失 `.md` 扩展名（见 `test/posix-path.test.mjs`）。
   - 注意：路径归一化函数**不做** `..` 目录穿越过滤（安全边界由仓库名正则 `/^[A-Za-z0-9._-]+$/` 与 Git 树对象解析保障，文档不得虚报过滤 `..`）。
4. **跨平台锁对称与控制台 UTF-8 保护**：
   - `IndexLock` 在 Windows 使用 `msvcrt.locking`，`_acquire()` 与 `_release()` 前均须显式 `self.fd.seek(0)` 锁定首字节；
   - `bin/gts`、`lib/config.py` 与 `lib/indexer.py` 均通过 `reconfigure(encoding="utf-8", errors="backslashreplace")` 保护 Windows CP936/CP1252 下中文告警与输出不抛 `UnicodeEncodeError`；
   - PowerShell 脚本（`scripts/setup-windows.ps1`、`scripts/doctor-mcp.ps1`）须保持 UTF-8 BOM 以兼容 Windows PowerShell 5.1。

---

## 3. Git、同步与索引关键不变量（防回退清单）

1. **MCP → CLI 参数与查询数据硬隔离**：`lib/server.mjs` 构造 `gts` 参数时，值选项一律使用 `--name=value`，并在查询词前插入 `--`，防止模型输入 `--sync` / `--reindex` 被 `argparse` 当成控制开关执行。
2. **`git grep` 含冒号路径与退出码契约**：
   - 内容模式必须使用 `git grep -n -z`（`<ref>:<path>\0<lineno>\0<text>`），文件列表模式 `-l` 直接剥除 `<ref>:` 前缀，确保含 `:` 的 POSIX 文件路径不被截断错位（D6）；
   - 行尾清洗只剥除末尾单个 `\n` 与对应 `\r`，严禁用 `rstrip("\r\n")` 吞掉正文尾部的合法 CR；
   - 仅 `git grep` 的 `rc=1` 代表干净 0 命中；`rc>=2` 或 `refs`/`ls-tree`/`log` 非零退出必须作为 `GIT_SEARCH_FAILED` 报错，绝不能归并为 0 命中。
3. **`git ls-tree -r -z` 与单仓原子索引**：
   - 索引枚举必须用 `-z` 按 NUL/TAB 解析字节路径，防止含空白或 `U+2028`/`U+0085` 文件名拆行；
   - `index_repo` 用 SQLite savepoint 包裹单仓写入与 `head_commit` 门控；树或 blob 读取异常必须回滚该仓 savepoint，严禁留下半截索引或误删旧记录。
4. **消失仓全局清理（R2）的信任前提**：仅在未加 `-r` 过滤、全部配置的 owner 目录均可正常枚举、且未发生同步降级/单仓失败（无 `--no-global-prune`）时，才允许删除磁盘上已消失仓库的索引行。
5. **子进程 stderr 防死锁与 Bash 3.2 陷阱**：
   - `bin/gts:_stream` 用临时文件承接 `stderr`，避免父进程只读 `stdout` 时大量错误输出填满管道死锁；
   - `scripts/sync.sh` 需兼容 macOS Bash 3.2：紧邻中文字符的变量必须写 `${name}`，后台软超时需显式 `"$@" <&0 &` 保留调用方 stdin。
6. **`--doctor` 综合健康聚合（D7）**：`mirror_sync` 状态为 `failed` 或 `invalid` 时，`overall_status` 至少降为 `WARN`；状态为 `unrecorded`（手工裸镜像 / Zero-Gitea 演示）时保持 `OK`。
7. **`quickstart-local.sh` 配置零破坏**：拒绝覆盖已有不同内容的 `config.json`、软链接或非普通文件；E2E 测试须显式传入隔离的 `GITEA_SEARCH_CONFIG` 与 `HOME`。

## v2.0.3 工程约定（来自 2.0.2 独立审计）

1. **子进程生命周期**：所有 `gts` / `git` 调用经 `runLimited()`（并发闸）→ `run()` → `carry()`。POSIX 上以 `detached: true` 启动独立进程组，超时 / 取消 / 输出超限 / 宿主断开 / 服务退出都对**整组** `kill(-pid)`；`carry()` 永不在事件回调里抛出（解码错误变结构化结果），输出超过 `GITEA_MAX_CHILD_OUTPUT_BYTES` 即终止。
2. **测试用「朴素括号配平」切函数**：`test/windows-quote.test.mjs`、`test/next-actions.test.mjs` 从 `lib/server.mjs` 源码里按花括号切出 `run` / `carry` / `killTree`。因此这些函数的**签名与注释里不要出现 `{` `}`**（如默认参数 `opts = {}`），新增的自由变量要同步补进测试的 `new Function(...)` 形参。
3. **索引事务边界**：`index_repo` 以 SAVEPOINT 为单位提交单仓；`build_index` 隔离单仓 `IndexReadError` 并在最后聚合上报；`--full` 走 `.new` 旁路库 + `os.replace`，替换前先清理旧库的 `-wal/-shm`。`user_version` 在构建结束时盖章，`_require_current_index(persist=True)` 对「行均为 `owner/repo`」的未盖章库自愈。
4. **仓库过滤单一语义**：`indexer._match_repo_any`（Python）与 `bin/gts fnmatch_any` 必须保持一致；`search_fts` 先在 `doc_rowid` 里解出匹配的 repo 集合再 `IN (...)`，不要在 SQL 里重新实现匹配。
5. **`sync.sh` 约定**：全局锁 `state/sync.lock`（退出 75；无 `flock` 时降级 `perl`/`python3` `flock` 及带 `.reclaim`/`.takeover.<token>[.<gen>]` 代次回收的 `mkdir` 目录锁）；MCP 托管下 `GITEA_MANAGED_PGROUP=1` 使 `gts --sync` / `--sync-only` 留在服务端进程组内并带 `GITEA_SYNC_TIMEOUT`（并通过 `SYNC_STATUS_RECORD` 输出当轮结构化状态供 `sync_mirror` 判定 `SYNC_DEGRADED`）；远端空仓库（本地从未有对象）在 `converge_default_head` 里视为成功。`test/first-run.test.mjs` 通过替换 `subprocess.Popen` 捕获 `gts → sync.sh` 的 argv/env。
6. **本地门禁**：`python3 scripts/collect-test-counts.py`（含 E2E 与失败下限）+ `bash scripts/respawn-mcp.sh --selftest` + `python3 scripts/check-public-hygiene.py`（测试里的伪造密钥必须拆串书写，否则卫生扫描会命中）。
