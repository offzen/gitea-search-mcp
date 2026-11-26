# 能力范围与不支持事项

本文是用户侧功能边界速查；具体安装步骤见 [`POST-INSTALL.md`](POST-INSTALL.md)，从 `v1.2.x` 升级见 [`UPGRADING.md`](../UPGRADING.md)。

## 支持的范围

- `search_code`（兼容旧名 `search_gitea` / `search_gitorca`）检索已同步到本地 bare mirror 的仓库和本地 refs；尚未推送或尚未同步的内容不可见。
- `search_docs`（兼容旧名 `search_gitea_docs` / `search_gitorca_docs`）用 SQLite FTS5 检索当前已建索引的文档、会话、配置与脚本；默认仅覆盖每仓默认分支（`scope: default-branches`）。中文查询依赖 Python 3.10+ 与 `jieba`。
- `read_file`（兼容旧名 `read_gitea_file` / `read_gitorca_file`）按仓库（推荐 `owner/repo`）、ref 和仓内路径读取；建议先搜索定位，再小窗口读取。单文件超过 `GITEA_MAX_BLOB_BYTES`（默认 32 MiB）不可读（`FILE_TOO_LARGE`）；`ref` 必须是普通修订名。
- `list_repositories`（兼容旧名 `list_gitea_repos` / `list_gitorca_repos`）展示本地镜像仓，不会查询远端实时仓库清单。
- `sync_mirror`（`v2.0.3` 新增，无旧别名）显式触发本地镜像增量同步与 FTS 索引更新，是唯一会写镜像的工具；受全局同步锁保护并显式上报 `SYNC_BUSY` / `SYNC_DEGRADED`。
- `bin/mcp-server --dump-schema [--compact]` 纯静态导出 OpenAI/Function Calling 兼容 JSON Schema，不读配置/镜像、不 spawn 子进程。

## 不会自动发生的操作

- 安装器不会替你决定何时同步远端、何时重载宿主，也不会重启 DSH。
- `onboarding` 与 `doctor-mcp` 只做检查/打印建议（含只读 SQLite `PRAGMA user_version` 检查）；不修改 profile、建立索引或触发同步。
- `sync_mirror` 会触发镜像同步与索引更新，是唯一的写操作；不要在循环中使用。`search_code` 不再接受 `sync`。并发调用是安全的（`sync.sh` 全局锁，后到者沿用当前镜像并标注 `SYNC_BUSY`），但每次都会占用并发名额与同步时间。
- MCP stdio 探针检查的是单独启动的 server，不等于宿主配置已加载或 GUI 工具已注册。

## 明确不提供

- 不提供无 Python 降级模式（Zero-Python fallback）：Python 3.10+ 与 `jieba` 为明确必备依赖，缺失时 fail-closed 并返回明确安装指引。
- 不内置 GitHub / GitLab 多源镜像同步器：`scripts/sync.sh` 仅面向 Gitea / Forgejo API；其他 Git 源可通过手工 `git clone --mirror` 到 `<root>/<owner>/<repo>.git` 接入检索。
- 不支持搜索未推送到镜像的本地工作区源码；请先推送并完成镜像同步。
- 不承诺宿主侧工具名、前缀或 GUI 展示名固定；以当前宿主工具表为准。
- Windows 原生 PowerShell 不直接运行 `scripts/sync.sh`；需要 Git Bash 或另行配置的镜像获取流程。
- npm install 不提供 Python CLI；需使用 Python 包安装方式（`pip install '.[fts]'`）。
- 不提供跨所有 refs 的 FTS 文档索引；需要非默认分支时使用 `search_code` 并按 `ref` 读取。
- 空仓库（尚无任何提交）不会进入索引，也不会产生检索结果；首次提交并同步后自动纳入。
- `search_code` 在部分仓失败时返回带 `PARTIAL_RESULT` 标注的命中，**不保证覆盖全部仓库**；`全库命中 ≥ N` 表示下界。
