# 维护者发布指南（RELEASE）

本仓库采用**公开 GitHub Actions 原生三端门禁 + 官方 Sigstore 构建证明**完成验证与发版，无需手工维护仓内哈希清单或搬运跨仓私有收据。

## 1. 本地预检（开发与发版前）

在安装了 Node.js ≥ 20.11、Python ≥ 3.10、`jieba`、`PyYAML` 与 `build` 的干净环境中，一键运行全套门禁：

```bash
npm ci --ignore-scripts --no-audit --no-fund

# 1) 运行 Node + Python + 31 项 E2E，并强制核验测试计数底线与 0 静默跳过
PYTHONDONTWRITEBYTECODE=1 python3 scripts/collect-test-counts.py

# 2) 树外验证四格打包产物（Python wheel + sdist + npm pack .tgz）
python3 -m build --outdir /tmp/gts-dist && python3 scripts/test-python-package.py /tmp/gts-dist
npm run test:pack

# 3) 公开树脱敏与干净工作区检查（可通过 GITEA_HYGIENE_FORBIDDEN_REGEX 附加自定义词表）
npm run test:hygiene
```

*(私有 Gitea 开发分支将自动通过 `.gitea/workflows/ci.yml` 调用 `scripts/ci/linux-gate.sh` 在隔离沙箱内执行同一套完整检查。)*

## 2. 公开三步发版流

1. **版本定稿提交**：
   - 同步更新 `package.json`、`package-lock.json` 与 `pyproject.toml` 中的版本号（由 `test/release-scope.test.mjs` 强制对齐）；
   - 在 [`CHANGELOG.md`](../../CHANGELOG.md) 补充新版本变更章节，确认 `npm run test:hygiene` 通过。
2. **推送公开分支 / PR 并通过三端 CI**：
   - 推送 `release/vX.Y.Z` 分支或发起 PR 至 `offzen/gitea-search-mcp`；
   - 等待公开 GitHub Actions 三端门禁全部绿灯：
     - `.github/workflows/ci.yml`：Ubuntu（Python 3.11/3.12 × Node 20/22）、四格打包与卫生门禁（`package`）、macOS（`test-macos`）；
     - `.github/workflows/windows-ci.yml`：原生 Windows PE 启动器、PowerShell 5.1/7 安装器、运行时锁与防注入、Git Bash E2E、CRLF 检索（共 5 项 job）。
3. **打不可变 Tag 触发自动证明与发布**：
   - 合入 `main` 后，基于目标提交创建不可变 annotated tag 并推送：
     ```bash
     git tag -a vX.Y.Z -m "Release vX.Y.Z"
     git push origin main vX.Y.Z
     ```
   - `.github/workflows/release.yml` 会自动构建 `wheel`、`sdist` 与 `npm` 归档包，调用官方 `actions/attest-build-provenance@v2` 生成第三方可独立验签的 Sigstore 构建证明，并将制品与 `SHA256SUMS` 挂载至对应的 GitHub Release。已发布的公开 Tag 永久不可移动或删除。
