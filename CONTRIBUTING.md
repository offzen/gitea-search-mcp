# Contributing to gitea-search-mcp

Thank you for your interest in contributing to `gitea-search-mcp` (formerly `dsh-gitea-search`)!

## Open Source Governance & Pipeline

This repository is maintained openly under the Apache-2.0 license.
We actively welcome community contributions, bug reports, and pull requests!

- **Public Repository & PR Mainline**: [https://github.com/offzen/gitea-search-mcp](https://github.com/offzen/gitea-search-mcp)
- **CI Automation**: Every Pull Request triggers automated GitHub Actions workflows running the 31-assertion E2E regression suite plus unit and packaging gates across supported Node.js and Python versions.
- **Release Discipline**: Pull requests are verified by the workflows in this repository. Merging a PR does **not** imply automatic synchronization or release to another forge; maintainers handle any downstream candidate or release step separately, without force-moving existing tags.

## How to Contribute

1. **Fork & Clone**: Fork the repository on GitHub and clone your fork locally.
2. **Local Environment**:
   - Node.js >= 20.11 (tested on Node 20.x, 22.x)
   - Python 3.10+ with sqlite3, jieba and PyYAML (`python3 -m pip install jieba PyYAML`)
   - Git 2.25+
3. **Run Tests Locally**:
   Before submitting changes, install Node dependencies and run the full test, packaging, and hygiene checks:
   ```bash
   npm ci
   PYTHONDONTWRITEBYTECODE=1 npm run test:all
   npm run test:pack
   npm run test:hygiene
   ```
   This runs Node tests, all explicit Python contract/regression suites, the 31-assertion E2E test, isolated `npm pack` verification, and public-tree hygiene checks. Missing `PyYAML` or `jieba` is a failure, not a skip. For maintainer release steps, see [docs/dev/RELEASE.md](docs/dev/RELEASE.md).
4. **Submit a Pull Request**:
   - Provide a clear summary of what was fixed or added.
   - Reference any related issues or discussions.
