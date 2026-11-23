# 新用户零门槛入门手册（Getting Started · v2.0.2）

欢迎使用 **`gitea-search-mcp`**！本手册专为**第一次接触本项目的新用户**编写，不假设你熟悉裸镜像（bare mirror）或内部架构，带你用 **3～10 分钟**在自己的电脑和 AI 客户端里跑通第一次跨仓库搜索。

> **老用户提示**：如果你正在使用 `v1.2.x`（`dsh-gitea-search`），无需重走新装流程，请直接阅读 [`UPGRADING.md`](../UPGRADING.md) 平滑升级。

---

## 0. 先花 30 秒搞懂一件事：它搜的是什么目录？

很多新用户踩的第一个坑，是把普通项目文件夹（如 `~/projects`）直接填进配置，结果搜出 `0` 个仓库。

`gitea-search-mcp` 为了做到**不占双倍工作区磁盘、不干扰你正在修改的本地代码、同时秒搜所有分支与中英文文档**，统一读取 **`<GITEA_MIRROR_ROOT>/<owner>/<repo>.git` 两级 Git 裸镜像目录**：

```text
/srv/gitea-mirror/                 <-- GITEA_MIRROR_ROOT（镜像根目录）
├── my-team/                       <-- GITEA_OWNERS（组织名或用户名，可多个）
│   ├── backend-api.git/           <-- git clone --mirror 生成的裸仓库（以 .git 结尾）
│   └── ops-runbooks.git/
└── state/
    └── gitea-fts.sqlite           <-- 自动生成的 SQLite FTS5 + jieba 中文全文索引
```

只要目录符合这个形状——**不管仓库来自 Gitea、Forgejo、GitHub、GitLab，还是你本机自建的 Git 仓库**——都能直接建库检索。

---

## 1. 环境准备与下载安装（约 2 分钟）

### 1.1 检查三项基础依赖

在终端（Windows 请打开 **PowerShell**，无需管理员权限、无需 WSL）确认已安装：

| 依赖 | 最低版本 | 用途说明 |
|---|---|---|
| **Node.js** | `≥ 20.11`（推荐 22 LTS） | 运行 MCP stdio 服务端（`@modelcontextprotocol/sdk`） |
| **Python** | `≥ 3.10`（含 SQLite FTS5） | **必备依赖**（无纯 Node 降级模式），运行 `gts` 检索引擎与 `jieba` 中文分词 |
| **Git** | `≥ 2.25` | 执行跨仓库 `git grep` 与 `git cat-file` 读取 |

> 💡 **注意**：npm / PyPI 上没有同名官方发布包，请始终从本仓库源码或 GitHub Release 签名制品安装。

### 1.2 下载源码并安装依赖

#### Linux / macOS

```bash
git clone --branch v2.0.2 https://github.com/offzen/gitea-search-mcp.git
cd gitea-search-mcp

# 1) 安装 Node 侧 MCP SDK
npm ci --omit=dev --no-audit --no-fund

# 2) 安装 Python 侧 gts 启动器与 jieba 中文分词
python3 -m pip install '.[fts]'
```

> **遇到 `error: externally-managed-environment`（Ubuntu 24.04+ / Debian 12+ / macOS Homebrew 常见）？**  
> 这是系统 Python 的 PEP 668 保护机制，使用项目内虚拟环境即可一键解决：
> ```bash
> python3 -m venv .venv
> .venv/bin/pip install '.[fts]'
> ```
> 采用虚拟环境时，后续在客户端配置里加一行 `"GITEA_SEARCH_CLI": "/绝对路径/gitea-search-mcp/.venv/bin/gts"`（或 `"GITEA_VENV_PATH": "/绝对路径/gitea-search-mcp/.venv"`）即可。macOS 用户也可直接运行 `GITEA_OWNERS=你的组织名 bash scripts/setup-macos.sh` 自动完成虚拟环境配置。

#### Windows（原生 PowerShell）

```powershell
git clone --branch v2.0.2 https://github.com/offzen/gitea-search-mcp.git
cd gitea-search-mcp

# 先安装 MCP SDK 与生成原生 Scripts\gts.exe（-SkipIndex 表示稍后再建索引）
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Owners demo -MirrorRoot C:\gitea-mirror -SkipIndex
```

记录终端打印出的 `gts.exe: C:\...\Scripts\gts.exe` 完整路径，稍后填进客户端配置更稳妥。

---

## 2. 三选一：准备你的第一个可搜索仓库

请根据手头条件**任选下面一条路线**跑通，无需三条都做：

- **路线 A（3 分钟零门槛体验）**：手头没有 Gitea，只想立刻验证整套搜索和 MCP 能不能工作 → **推荐新手首选**
- **路线 B（5 分钟接现有 Git 仓）**：想搜索 GitHub / GitLab / 本机已有的几个 Git 仓库（不搭 Gitea）
- **路线 C（10 分钟接私有 Gitea / Forgejo）**：团队已有 Gitea / Forgejo，想把整个组织/用户名下仓库全量同步到本地

---

### 路线 A：3 分钟零依赖本地体验（无需 Gitea 与凭据）

#### Linux / macOS

`quickstart-local.sh` 会在你指定的空目录里自动生成一个演示裸仓库（`local/demo-project.git`）、建立中文/英文 FTS5 索引，并输出可直接粘贴的 MCP 配置（**它不会扫描或导入你电脑上已有的代码仓库，也不会覆盖已有不同配置或软链接**）：

```bash
# 1. 生成合成演示镜像与索引
bash scripts/quickstart-local.sh /tmp/gitea-search-mcp-demo

# 2. 命令行试试全文检索
./bin/gts -D "Architecture"

# 3. 跑一次独立 MCP stdio 握手与搜索自检（看到 7 绿 / 0 红即完全正常）
bash scripts/doctor-mcp.sh --verify --query Architecture
```

> ⚠️ **体验完切正式库前的小提醒**：`quickstart-local.sh` 会在项目根目录生成一份指向 `/tmp/gitea-search-mcp-demo` 的 `config.json`。等你后续切换正式仓库时，删掉项目根目录下的这一个 `config.json`（或在客户端里显式配置 `GITEA_MIRROR_ROOT` 与 `GITEA_OWNERS` 环境变量，环境变量优先级更高）即可。

#### Windows（PowerShell）

```powershell
# 1. 把当前仓库自身克隆为一个演示裸仓（免联网、含真实中英文文档，耗时 1 秒）
New-Item -ItemType Directory -Force C:\gitea-mirror\demo | Out-Null
git clone --bare . C:\gitea-mirror\demo\sample-repo.git

# 2. 构建 SQLite FTS5 全文索引
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Owners demo -MirrorRoot C:\gitea-mirror

# 3. 跑一次独立 MCP stdio 探针自检
$env:GITEA_MIRROR_ROOT = "C:\gitea-mirror"
$env:GITEA_OWNERS = "demo"
powershell -ExecutionPolicy Bypass -File scripts\doctor-mcp.ps1 -Verify
```

---

### 路线 B：5 分钟接入任意 GitHub / GitLab / 本地仓库（免搭 Gitea）

只需按 `<GITEA_MIRROR_ROOT>/<owner>/<repo>.git` 结构执行 `git clone --mirror`，再跑一次 `--reindex`：

```bash
# 1. 创建镜像目录（这里以 owner="my-work" 为例，请勿使用 myorg / your-org 等示例占位词）
mkdir -p ~/git-mirror/my-work

# 2. 镜像任意远端仓库或本机已有仓库（可添加多个 *.git）
git clone --mirror https://github.com/offzen/gitea-search-mcp.git ~/git-mirror/my-work/gitea-search-mcp.git
# 也可镜像本机目录：git clone --mirror ~/code/my-app ~/git-mirror/my-work/my-app.git

# 3. 建立 FTS5 全文索引并自检
export GITEA_MIRROR_ROOT="$HOME/git-mirror"
export GITEA_OWNERS="my-work"
./bin/gts --reindex
bash scripts/doctor-mcp.sh --verify
```

后续远端有新代码时，随时在对应 `.git` 目录运行 `git -C ~/git-mirror/my-work/my-app.git remote update --prune && ./bin/gts --reindex` 即可秒级增量刷新。

---

### 路线 C：10 分钟接入私有 Gitea / Forgejo（生产推荐）

1. **生成只读 Token**：登录你的 Gitea / Forgejo → **设置 (Settings) → 应用 (Applications)** → 生成新令牌，权限**只勾选 `repo:read`**（如有组织私有仓可加勾选 `organization:read`，切勿给写权限）。
2. **执行首次全量镜像同步 + 自动建索引**（Linux / macOS，Windows 请在 **Git Bash** 中运行同步脚本）：
   ```bash
   export GITEA_URL="https://git.example.com"       # 替换为你的 Gitea / Forgejo 根地址
   export GITEA_TOKEN="你的只读Token"
   export GITEA_MIRROR_ROOT="/srv/gitea-mirror"     # 替换为你的本地镜像存储目录
   export GITEA_OWNERS="acme-team"                  # 替换为真实组织名或用户名（勿填 myorg/your-org）
   export GITQ_TRANSPORT="https"                    # 用 Token 走 HTTPS 克隆；若已配好 SSH 免密可不设

   bash scripts/sync.sh
   ```
   > 💡 `sync.sh` 同步成功后会自动构建/增量更新 SQLite FTS5 索引，无需再手动执行 `--reindex`。单次运行 `sync.sh` 只同步 1 个 owner；若有多个组织，分别设 `GITEA_OWNERS=org-a`、`GITEA_OWNERS=org-b` 各跑一次 `sync.sh`，之后在客户端里填 `GITEA_OWNERS="org-a,org-b"` 即可同时跨组织检索！
3. **运行只读验收助手确认全绿**：
   ```bash
   bash scripts/onboarding.sh --verify
   bash scripts/doctor-mcp.sh --verify
   ```

---

## 3. 把服务接进你的 AI 客户端（约 2 分钟）

### 3.1 推荐技巧：写一份共享配置，所有客户端免重复填路径

你可以先把镜像路径和 owner 写进用户目录 `~/.config/gitea-search-mcp/config.json`（Windows 为 `%USERPROFILE%\.config\gitea-search-mcp\config.json`）：

```json
{
  "gitea": {
    "owners": ["acme-team"]
  },
  "storage": {
    "mirror_root": "/srv/gitea-mirror"
  }
}
```

写好后，无论在命令行跑 `gts` 还是在多个 AI 客户端里配置 MCP，都能自动共用这份配置。

### 3.2 各主流客户端配置文件位置与模板

请将下方路径替换为你本机的**绝对路径**（切勿使用相对路径）：

| 客户端 | 配置文件常见位置 |
|---|---|
| **Claude Desktop** | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%\Claude\claude_desktop_config.json` |
| **Cursor** | 全局 `~/.cursor/mcp.json` 或项目级 `.cursor/mcp.json` |
| **Claude Code CLI** | 终端直接运行：`claude mcp add gitea-search -e GITEA_MIRROR_ROOT=/srv/gitea-mirror -e GITEA_OWNERS=acme-team -- node /绝对路径/gitea-search-mcp/bin/mcp-server` |
| **Cline / Windsurf / Codex** | 在各自设置面板打开 MCP Servers JSON 配置文件 |
| **DeepSeek Harness (DSH)** | `~/.dsh/profiles/<desktop\|web\|headless>/cordis.patch.yml`（见下方专用 YAML） |

#### 通用 JSON 模板（Claude Desktop / Cursor / Cline / Windsurf）

```json
{
  "mcpServers": {
    "gitea-search": {
      "command": "node",
      "args": ["/绝对路径/gitea-search-mcp/bin/mcp-server"],
      "env": {
        "GITEA_MIRROR_ROOT": "/srv/gitea-mirror",
        "GITEA_OWNERS": "acme-team"
      }
    }
  }
}
```

> **Windows 特别提醒**：在 JSON 里路径请使用双反斜杠或正斜杠，并建议显式加上 `GITEA_SEARCH_CLI` 指向第一步生成的 `gts.exe`（必须是单个 `.exe` 完整路径，**不能**写成 `"python bin\\gts"`）：
> ```json
> "env": {
>   "GITEA_MIRROR_ROOT": "C:/gitea-mirror",
>   "GITEA_OWNERS": "demo",
>   "GITEA_SEARCH_CLI": "C:/Users/你的用户名/AppData/Local/Programs/Python/Python312/Scripts/gts.exe"
> }
> ```

#### DeepSeek Harness (DSH) 专用模板（`cordis.patch.yml`）

```yaml
- insert:
    - id: mcp-gitea-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitea-search
        transport: stdio                # 必填：漏写会导致静默不连接
        command: node
        args: ['/绝对路径/gitea-search-mcp/bin/mcp-server']
        cwd: '/绝对路径/gitea-search-mcp'
        env:
          GITEA_MIRROR_ROOT: '/srv/gitea-mirror'
          GITEA_OWNERS: 'acme-team'
```

### 3.3 重启 / 重载你的客户端

保存配置后，**重启或重载对应的 AI 客户端 / Profile**（安装和自检脚本不会替你重启宿主）。打开新会话，确认客户端的 MCP 工具列表里已出现以下 **4 个工具**（部分客户端会自动加上类似 `mcp__gitea-search__` 的前缀，属正常现象，详见 [`TOOL-NAMING.md`](TOOL-NAMING.md)）。

---

## 4. 第一次对话怎么问？（3 句开箱验证 + 选型口诀）

在新建的 AI 会话里，依次发下面 3 句话测试实战效果：

1. **第 1 句（盘点有哪些仓库）**：
   > “请调用 `list_repositories` 看看本地镜像里目前有哪些仓库？”
2. **第 2 句（查中英文设计文档 / 排障方案）**：
   > “请用 `search_docs` 搜索关于 `Architecture`（或换成你业务里的中文关键词，比如 `反向代理 证书`）的文档说明。”
3. **第 3 句（跨分支搜代码 + 按需小窗口精读，不撑爆上下文）**：
   > “请先用 `search_code`（开启 `files_only=true`）找一下哪个文件提到了 `resolveConfig`，再用 `read_file` 只读它的前 60 行。”

### 4 个工具一句话选型口诀

| 标准工具名 | 什么时候用它？ | 关键特点 |
|---|---|---|
| **`list_repositories`** | 不确定仓库全名、想看镜像了哪些仓 | 秒列本地 `owner/repo` 清单 |
| **`search_docs`** | 查**中文问题、技术文档、配置说明、导出会话** | 走 SQLite FTS5 + `jieba` 分词，相关性高（仅覆盖每仓**默认分支**） |
| **`search_code`** | 查**精确函数/变量名、文件路径（`mode="path"`）、提交记录（`mode="message"`）或非默认分支** | 走极速 `git grep`，覆盖**全部本地分支** |
| **`read_file`** | 搜索定位到具体仓库和路径后，读取正文 | 默认每次只读 400 行 / `60 KB` 安全切片，不爆上下文 |

---

## 5. 新手高频卡点“一秒自救表”

| 你看到的现象 / 报错 | 原因 | 一行解决动作 |
|---|---|---|
| `CONFIG_ERROR: ... owners` | 未设置 `GITEA_OWNERS`，或直接照抄了 `myorg` / `your-org` / `example-org` / `your-owner` 占位词 | 改成真实组织/用户名（本地演示可填 `demo` 或 `local`），与镜像下的子目录名保持一致 |
| `list_repositories` 返回 `0` 个仓 | 把普通代码工作区填成了 `GITEA_MIRROR_ROOT`，缺少 `<owner>/<repo>.git` 两级裸仓库目录 | 检查 `<GITEA_MIRROR_ROOT>/<owner>/` 下是否是 `*.git` 裸仓库（见第 0 节目录树） |
| `DEPENDENCY_MISSING` 或中文搜不到 | Python 环境没装 `jieba`，或放进镜像后还没建索引 | 执行 `python3 -m pip install '.[fts]'`（或配好 `.venv`）后再跑一次 `gts --reindex` |
| Windows 报找不到可执行 `gts` CLI | Windows 不支持直接 spawn 无后缀脚本，或把 `GITEA_SEARCH_CLI` 写成了 `"python bin\gts"` | 确保 `GITEA_SEARCH_CLI` 指向 `pip install ".[fts]"` 生成的单个 `Scripts\gts.exe` 完整路径 |
| `doctor-mcp` 探针全绿，但客户端里没工具 | 客户端未重载配置，或 JSON 里填了相对路径/`~` 未展开 | 把 `args` 和 `env` 中的路径全部改成绝对路径，完全重启一次客户端 |
| 刚 `git push` 的新改动搜不到 | 本地裸镜像不会在每次查询时自动联网拉取远端 | 手动执行一次 `bash scripts/sync.sh -q`（或配置定时 Cron，见 [`OPERATIONS.md`](OPERATIONS.md)） |

---

## 6. 下一步进阶阅读

当你已经跑通第一次搜索，可以按需查阅以下专题文档：

- **核对完整生产上线清单**：[`POST-INSTALL.md`](POST-INSTALL.md)
- **解锁高级过滤参数（`kind` 分区、正则探路、CLI 快捷键）**：[`USAGE.md`](USAGE.md)
- **配置 Cron 定时自动同步、Windows 深入部署与环境变量全表**：[`OPERATIONS.md`](OPERATIONS.md)
- **了解能力边界与宿主工具名前缀规则**：[`BOUNDARIES.md`](BOUNDARIES.md) · [`TOOL-NAMING.md`](TOOL-NAMING.md)
