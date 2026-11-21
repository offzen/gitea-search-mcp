# gitea-search-mcp

[![License](https://img.shields.io/badge/License-Apache--2.0-C21325)](LICENSE)
[![CI](https://github.com/offzen/gitea-search-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/offzen/gitea-search-mcp/actions/workflows/ci.yml)
[![Windows CI](https://github.com/offzen/gitea-search-mcp/actions/workflows/windows-ci.yml/badge.svg)](https://github.com/offzen/gitea-search-mcp/actions/workflows/windows-ci.yml)
[![Version](https://img.shields.io/badge/Version-v2.0.1-blue)](CHANGELOG.md)
[![Archive](https://img.shields.io/badge/Archive-v0.1.1%20(Pure%20Node)-orange)](https://github.com/offzen/gitea-search-mcp/tree/legacy-0.1.x)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows%20(Native)-brightgreen)](docs/OPERATIONS.md#1-多场景部署与定时同步)
[![Node](https://img.shields.io/badge/Node-%3E%3D20.11-success)](package.json)

面向任意 MCP 宿主的 **Gitea / Forgejo / 本地 Git 裸镜像混合检索服务**（支持 Claude Desktop、Cursor、Cline、Windsurf、Codex、DSH 等）。基于本地 `<mirror_root>/<owner>/<repo>.git` 裸镜像提供毫秒级定位与按需切片读取，免逐仓 clone、防大文件撑爆上下文。

> 从 `v1.2.x`（`dsh-gitea-search`）升级请看 **[UPGRADING.md](UPGRADING.md)**（完整保留旧工具名别名与配置回退）。npm / PyPI 无官方包，请从本仓库源码或 Release 签名制品安装。

## 核心能力

- **双层混合检索**：`git grep` 检索全仓全部分支代码、路径与提交；`SQLite FTS5 + jieba` 检索默认分支中英文文档、会话与配置。
- **上下文防爆窗护栏**：默认返回 Top 5 命中，单行 `≤ 2000B`、单次 `≤ 128 KiB` 安全截断，`read_file` 默认 400 行 / `60 KB` 分片读取。
- **任意 Git 源接入**：除 Gitea/Forgejo 定时同步外，任意 `git clone --mirror` 到 `<mirror_root>/<owner>/<repo>.git` 的仓库均可直接建库检索。
- **静态 Schema 导出**：`node bin/mcp-server --dump-schema [--compact]` 离线导出 Function Calling JSON Schema（不读镜像、不启子进程）。

## 快速安装

**环境要求**：Node.js `≥ 20.11`、Python `≥ 3.10`（含 SQLite FTS5 与 `jieba`，必备依赖）、Git `≥ 2.25`；原生支持 Linux / macOS / Windows。

```bash
# Linux / macOS
git clone https://github.com/offzen/gitea-search-mcp.git && cd gitea-search-mcp
npm ci --no-audit --no-fund && python3 -m pip install '.[fts]'
# 可选一键脚本：GITEA_OWNERS=my-org bash scripts/setup.sh       # macOS 用 scripts/setup-macos.sh

# Windows（PowerShell，无需管理员权限与 WSL）
git clone https://github.com/offzen/gitea-search-mcp.git; cd gitea-search-mcp
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Owners my-org -WhatIf

# Zero-Gitea 本地快速体验（无需远端 Gitea，参数为专用演示输出目录）
bash scripts/quickstart-local.sh /tmp/gitea-search-mcp-demo
```

> `quickstart-local.sh` 仅在指定输出目录生成合成演示仓，**不会扫描或导入**已有本地仓库；生成 `config.json` 时，**已有不同配置、软链接或非普通文件会被拒绝且保持不动**。安装后闭环核验见 **[docs/POST-INSTALL.md](docs/POST-INSTALL.md)**。

## 主流 MCP 客户端接入

**Claude Desktop / Cursor / Cline / Windsurf / Codex（标准 MCP JSON）**

```json
{
  "mcpServers": {
    "gitea-search": {
      "command": "node",
      "args": ["/path/to/gitea-search-mcp/bin/mcp-server"],
      "env": {
        "GITEA_MIRROR_ROOT": "/srv/gitea-mirror",
        "GITEA_OWNERS": "my-org,my-team"
      }
    }
  }
}
```

**DeepSeek Harness (DSH `cordis.patch.yml`)**

```yaml
- insert:
    - id: mcp-gitea-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitea-search
        transport: stdio                # 必填：缺失会静默不连接
        command: node
        args: ["/opt/gitea-search-mcp/bin/mcp-server"]
        cwd: /opt/gitea-search-mcp
        env:
          GITEA_MIRROR_ROOT: "/srv/gitea-mirror"
          GITEA_OWNERS: "my-org,my-team"
```

也可将 `mirror_root` 与 `owners` 写入 `~/.config/gitea-search-mcp/config.json` 共享使用；宿主侧工具前缀规则见 **[docs/TOOL-NAMING.md](docs/TOOL-NAMING.md)**。

## MCP 工具一览

`tools/list` 仅暴露 4 个中性标准名，`tools/call` 同时透明兼容两族历史别名（保留至 `v3.0.0` 前）：

| 标准工具名 | 兼容旧名（`tools/call`） | 用途 |
|---|---|---|
| `search_code` | `search_gitea` / `search_gitorca` | 跨全仓全部分支检索代码内容、文件路径、提交信息 |
| `search_docs` | `search_gitea_docs` / `search_gitorca_docs` | 默认分支 SQLite FTS5 + `jieba` 文档、会话、配置、脚本检索 |
| `read_file` | `read_gitea_file` / `read_gitorca_file` | 按 `owner/repo`、路径和可选 `ref` 按需切片精读 |
| `list_repositories` | `list_gitea_repos` / `list_gitorca_repos` | 列出本地已镜像仓库（`owner/repo`） |

## 文档导航

| 文档 | 内容 |
|---|---|
| **[docs/POST-INSTALL.md](docs/POST-INSTALL.md)** | 安装后闭环验收：配置核验、首次同步、MCP 探针与宿主调用确认 |
| **[docs/USAGE.md](docs/USAGE.md)** | 四工具与 `gts` CLI 参数速查及“先定位、再精读”范例 |
| **[docs/OPERATIONS.md](docs/OPERATIONS.md)** | Linux / macOS / Windows 部署、定时同步、环境变量全表与排障 |
| **[UPGRADING.md](UPGRADING.md)** | `v1.2.x` 老用户平滑升级、索引兼容与回滚指南 |
| **[docs/BOUNDARIES.md](docs/BOUNDARIES.md)** / **[docs/TOOL-NAMING.md](docs/TOOL-NAMING.md)** | 能力边界说明 / 三层工具命名与兼容别名模型 |
| **[CHANGELOG.md](CHANGELOG.md)** / **[CONTRIBUTING.md](CONTRIBUTING.md)** | 版本变更记录 / 本地测试与贡献指南 |
| **[docs/dev/RELEASE.md](docs/dev/RELEASE.md)** / **[docs/dev/ENGINEERING-NOTES.md](docs/dev/ENGINEERING-NOTES.md)** | 维护者三步发版流 / 跨平台底层架构红线 |

## 许可证

SPDX-License-Identifier: Apache-2.0（详见 [LICENSE](LICENSE)）。
