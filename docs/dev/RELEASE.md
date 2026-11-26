# 维护者发布指南（RELEASE）

本仓库采用**公开 GitHub Actions 原生三端门禁（`workflow_call` 编排）+ 官方 Sigstore 构建证明**完成验证与发版，无需手工维护仓内哈希清单、轮询脚本或搬运跨仓私有收据。

## 1. 本地与私有内循环预检（开发与发版前）

在安装了 Node.js ≥ 20.11、Python ≥ 3.10、`jieba`、`PyYAML` 与 `build` 的干净环境中，一键运行全套门禁：

```bash
npm ci --ignore-scripts --no-audit --no-fund

# 1) 运行 Node + Python + 31 项 E2E，并强制核验测试计数底线与 0 静默跳过
PYTHONDONTWRITEBYTECODE=1 python3 scripts/collect-test-counts.py
bash scripts/respawn-mcp.sh --selftest

# 2) 树外验证四格打包产物（Python wheel + sdist + npm pack .tgz）
python3 -m build --outdir /tmp/gts-dist && python3 scripts/test-python-package.py /tmp/gts-dist
npm run test:pack

# 3) 公开树脱敏与干净工作区检查（可通过 GITEA_HYGIENE_FORBIDDEN_REGEX 附加自定义词表）
npm run test:hygiene
```

*(私有 Gitea / Forgejo 开发分支将自动通过 `.gitea/workflows/ci.yml` 调用 `scripts/ci/linux-gate.sh` 在隔离沙箱内执行同一套完整检查。)*

> **v2.0.3 起的三端同 SHA 原子发布 DAG（`.github/workflows/release.yml`）**：
> - `.github/workflows/ci.yml` 与 `.github/workflows/windows-ci.yml` 仅对 `main` 的 `push` / `pull_request`、`workflow_call` 与 `workflow_dispatch` 触发，**不再对 `v*` tag 或 `release/**` 重复触发**；
> - 推送 `v*` tag 时，`release.yml` 作为唯一入口执行四阶段 DAG：
>   1. `preflight`：快速校对 tag 与 `package.json` / `package-lock.json` / `pyproject.toml` 版本一致并执行 `check-public-hygiene.py`（异常 15 秒内熔断）；
>   2. `ci`（`uses: ./.github/workflows/ci.yml`）与 `windows-ci`（`uses: ./.github/workflows/windows-ci.yml`）并行在**同一 tag SHA** 上运行 Ubuntu、macOS、Windows 全套门禁；
>   3. `release`（`needs: [preflight, ci, windows-ci]`）：三端全部绿灯后才构建并树外校验 `wheel` / `sdist` / `.tgz` + `SHA256SUMS`，签发 Sigstore 证明并上传 GitHub Release。

个人私有 GitHub 仓可以用同一工作流验证候选版本。候选 tag 仍须通过同一 SHA 的 `preflight`、三端 `workflow_call` CI、四格打包核验并生成 `SHA256SUMS`。工作流仅在私有仓跳过构建证明和 GitHub Release 上传，并在日志中标明候选版本验证完成。正式发版从公开发布仓执行，必须签发构建证明并上传制品。

## 2. 公开三步发版流

- **自动发布门禁强制验证（`release.yml`）**：tag 与版本元数据一致、`check-public-hygiene.py`、同一 tag SHA 的三平台 `workflow_call` CI 绿灯（Ubuntu + macOS + Windows）、`wheel`/`sdist`/`npm` 树外打包核验与 Sigstore 证明签发。
- **维护者人工把关步骤**：审阅 `CHANGELOG.md` 变更摘要、决定发版窗口、经 PR 绿灯合入 `main` 并推送不可变 annotated tag。

1. **版本定稿提交**：
   - 同步更新 `package.json`、`package-lock.json` 与 `pyproject.toml` 中的版本号（由 `test/release-scope.test.mjs` 强制对齐）；
   - 在 [`CHANGELOG.md`](../../CHANGELOG.md) 补充新版本变更章节，确认 `npm run test:hygiene` 通过。
2. **推送分支开 PR 到 `main` 并通过三端 CI**：
   - 将定稿分支（如 `release/vX.Y.Z`）推送至 `offzen/gitea-search-mcp` 并向 `main` 发起 PR（仅触发 1 轮 PR CI，追加提交自动取消旧 run）；
   - 等待公开 GitHub Actions 三端门禁全部绿灯（满足 `main-required-status-checks` Ruleset）：
     - `.github/workflows/ci.yml`：Ubuntu 对角线矩阵（`py3.11/node20`、`py3.12/node22`）、四格打包与卫生门禁（`package`）、macOS（`test-macos`）；
     - `.github/workflows/windows-ci.yml`：原生 Windows PE 启动器与 CRLF/路径形态（`W5+W9`）、PowerShell 5.1/7 安装器（`W6`）、运行时锁与防注入对角线矩阵（`W7/W8`）、Git Bash 全量 E2E（`W10`）。
3. **合入 `main` 并打不可变 Tag 触发原子发布**：
   - PR 绿灯后以快进 / Rebase 合入 `main` 并清理临时分支，基于 `main` HEAD 创建不可变 annotated tag 并推送：
     ```bash
     git tag -a vX.Y.Z -m "Release vX.Y.Z"
     git push origin vX.Y.Z
     ```
   - `.github/workflows/release.yml` 会在同一工作流内完成 `preflight → (ci + windows-ci) → release` 闭环，调用官方 `actions/attest-build-provenance@v2` 生成第三方可独立验签的 Sigstore 构建证明，并将制品与 `SHA256SUMS` 挂载至对应的 GitHub Release。已发布的公开 Tag 永久不可移动或删除。
