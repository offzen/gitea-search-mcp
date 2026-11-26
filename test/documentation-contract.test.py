#!/usr/bin/env python3
"""Static contracts keeping repository documentation layout, links, and capability boundaries aligned with code."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent

FENCED_BLOCK_RE = re.compile(r"```[\s\S]*?```")
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")


def strip_fenced_code(text: str) -> str:
    return FENCED_BLOCK_RE.sub("", text)


def github_heading_slugs(text: str) -> set[str]:
    body = strip_fenced_code(text)
    slugs: set[str] = set()
    counts: dict[str, int] = {}
    for match in re.finditer(r"^(#{1,6})\s+(.+?)\s*$", body, re.MULTILINE):
        raw = match.group(2).strip()
        raw = re.sub(r"`([^`]*)`", r"\1", raw)
        raw = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", raw)
        raw = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", raw)
        chars: list[str] = []
        for ch in raw.lower():
            if ch in (" ", "-"):
                chars.append("-")
            elif ch.isalnum() or ch == "_":
                chars.append(ch)
        slug = "".join(chars)
        seen = counts.get(slug, 0)
        counts[slug] = seen + 1
        slugs.add(slug if seen == 0 else f"{slug}-{seen}")
    return slugs


class DocumentationContractTest(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_root_markdown_layout_stays_minimal_and_clean(self) -> None:
        root_mds = sorted(p.name for p in ROOT.glob("*.md"))
        self.assertEqual(
            root_mds,
            ["CHANGELOG.md", "CONTRIBUTING.md", "README.md", "UPGRADING.md"],
            f"Root directory should keep only the 4 standard open-source .md files; found: {root_mds}",
        )
        for retired in ("RELEASE-NOTES.md", "PROJECT-STATE.md", "MANUAL.md", "WINDOWS-PORT.md", "WIKI.md", "CODE-INDEX.md"):
            self.assertFalse((ROOT / retired).exists(), f"Retired root document must not return: {retired}")
        for expected in (
            "docs/GETTING-STARTED.md",
            "docs/USAGE.md",
            "docs/POST-INSTALL.md",
            "docs/OPERATIONS.md",
            "docs/BOUNDARIES.md",
            "docs/TOOL-NAMING.md",
            "docs/dev/RELEASE.md",
            "docs/dev/ENGINEERING-NOTES.md",
        ):
            self.assertTrue((ROOT / expected).is_file(), f"Missing expected doc: {expected}")

    def test_all_relative_markdown_links_and_anchors_resolve(self) -> None:
        doc_files = [
            ROOT / "README.md",
            ROOT / "CHANGELOG.md",
            ROOT / "UPGRADING.md",
            ROOT / "CONTRIBUTING.md",
            *sorted((ROOT / "docs").glob("*.md")),
            *sorted((ROOT / "docs" / "dev").glob("*.md")),
        ]
        slug_cache: dict[pathlib.Path, set[str]] = {
            doc.resolve(): github_heading_slugs(doc.read_text(encoding="utf-8"))
            for doc in doc_files
        }
        for doc in doc_files:
            body = strip_fenced_code(doc.read_text(encoding="utf-8"))
            for raw_target in MARKDOWN_LINK_RE.findall(body):
                target = raw_target.strip().split()[0]
                if target.startswith(("http://", "https://", "mailto:")):
                    continue
                rel_path, sep, fragment = target.partition("#")
                resolved = doc.resolve() if not rel_path else (doc.parent / rel_path).resolve()
                self.assertTrue(
                    resolved.exists(),
                    f"Broken relative link in {doc.relative_to(ROOT)}: {raw_target!r} -> {resolved}",
                )
                if sep and fragment and resolved.suffix.lower() == ".md":
                    slugs = slug_cache.setdefault(
                        resolved,
                        github_heading_slugs(resolved.read_text(encoding="utf-8")),
                    )
                    self.assertIn(
                        fragment.lower(),
                        slugs,
                        f"Broken heading anchor in {doc.relative_to(ROOT)}: {raw_target!r} (available: {sorted(slugs)})",
                    )

    def test_readme_badge_and_changelog_header_match_package_version(self) -> None:
        pkg = json.loads(self.read("package.json"))
        version = pkg["version"]
        readme = self.read("README.md")
        changelog = self.read("CHANGELOG.md")
        self.assertIn(f"Version-v{version}-blue", readme)
        self.assertRegex(changelog, rf"(?m)^## \[{re.escape(version)}\](?:\s|$)")

    def test_readme_and_changelog_stay_free_of_retired_governance_jargon(self) -> None:
        readme = self.read("README.md")
        for retired_phrase in ("exact-SHA 的 provenance", "私有 GitHub staging", "重新冻结 D/P", "版本号本身不证明工作树已通过发布门禁"):
            self.assertNotIn(retired_phrase, readme)
        changelog_top = self.read("CHANGELOG.md").split("## [1.2.2]", 1)[0]
        self.assertNotIn("not their live publication status", changelog_top)
        self.assertNotIn("provenance-only commit", changelog_top)

    def test_no_zero_python_fallback_and_neutral_tools_documented(self) -> None:
        readme = self.read("README.md")
        boundaries = self.read("docs/BOUNDARIES.md")
        naming = self.read("docs/TOOL-NAMING.md")
        forbidden = ("node" + "-fallback", "GITEA_FORCE_" + "NODE_FALLBACK", "needs" + "Fallback")
        for doc in (readme, boundaries, naming):
            for token in forbidden:
                self.assertNotIn(token, doc)
            for tool in ("search_code", "search_docs", "read_file", "list_repositories", "sync_mirror"):
                self.assertIn(tool, doc)
        self.assertIn("--dump-schema", readme)
        self.assertIn("UPGRADING.md", readme)

    def test_windows_and_user_boundary_claims_stay_truthful(self) -> None:
        operations = self.read("docs/OPERATIONS.md")
        eng_notes = self.read("docs/dev/ENGINEERING-NOTES.md")
        readme = self.read("README.md")
        usage = self.read("docs/USAGE.md")
        post_install = self.read("docs/POST-INSTALL.md")
        contributing = self.read("CONTRIBUTING.md")

        self.assertIn("拒绝 NUL、CR/LF", operations)
        self.assertIn("拒绝 NUL、CR 与 LF", eng_notes)
        self.assertNotIn("彻底防御搜索词中恶意注入", operations)
        self.assertIn("不会扫描或导入", readme)
        self.assertIn("不会递归探测或导入已有本地 Git 仓库", operations)
        self.assertIn("已有不同配置、软链接或非普通文件会被拒绝且保持不动", readme)
        self.assertIn("当前默认分类器把 `*.py` 归入 `code`", usage)
        self.assertIn("做一次真实端到端调用", post_install)
        self.assertIn("安装器有意不自动复制", post_install)
        self.assertIn("npm run test:all", contributing)
        self.assertIn("PyYAML", contributing)

    def test_package_python_suites_match_collect_test_counts_inventory(self) -> None:
        pkg = json.loads(self.read("package.json"))
        cmd = pkg["scripts"]["test:python"]
        pkg_suites = tuple(
            part.strip().removeprefix("python3 ").strip()
            for part in cmd.split("&&")
            if part.strip().startswith("python3 ")
        )
        spec = importlib.util.spec_from_file_location("collect_test_counts", ROOT / "scripts/collect-test-counts.py")
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertEqual(pkg_suites, tuple(mod.PYTHON_SUITES))


if __name__ == "__main__":
    unittest.main()
