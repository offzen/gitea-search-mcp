#!/usr/bin/env python3
"""v2.0.3 regression tests for the FTS indexer: empty repos (F1), partial/atomic builds (F2) and
the unified repo filter (F5)."""
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

import indexer  # noqa: E402

GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
}


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, env=GIT_ENV, check=True, capture_output=True, text=True)


def make_bare(root: Path, owner: str, repo: str, marker: str) -> Path:
    work = root / f"work-{owner}-{repo}"
    work.mkdir(parents=True)
    run("git", "init", "-q", "-b", "main", cwd=work)
    (work / "README.md").write_text(f"# {repo}\n{marker}\n", encoding="utf-8")
    run("git", "add", "README.md", cwd=work)
    run("git", "commit", "-q", "-m", "init", cwd=work)
    (root / owner).mkdir(parents=True, exist_ok=True)
    bare = root / owner / f"{repo}.git"
    run("git", "clone", "-q", "--bare", str(work), str(bare))
    return bare


def make_empty(root: Path, owner: str, repo: str) -> Path:
    (root / owner).mkdir(parents=True, exist_ok=True)
    bare = root / owner / f"{repo}.git"
    run("git", "init", "-q", "--bare", "-b", "main", str(bare))
    return bare


class IndexerResilienceBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = {**os.environ, "GITQ_ALLOW_NO_JIEBA": "1"}

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, **kwargs):
        with mock.patch.object(indexer, "_get_jieba", return_value=None), \
             mock.patch.dict(os.environ, self.env, clear=True):
            return indexer.build_index(str(self.root), owners=["team"], verbose=False, **kwargs)

    def search(self, query, **kwargs):
        with mock.patch.object(indexer, "_get_jieba", return_value=None):
            return indexer.search_fts(str(self.root), query, **kwargs)

    def user_version(self):
        conn = sqlite3.connect(indexer.get_db_path(str(self.root)))
        try:
            return conn.execute("PRAGMA user_version").fetchone()[0]
        finally:
            conn.close()


class EmptyRepositoryTests(IndexerResilienceBase):
    def test_empty_repo_is_skipped_and_other_repos_are_indexed(self):
        # Alphabetically first, so the old code aborted before indexing anything.
        make_empty(self.root, "team", "aaa-empty")
        make_bare(self.root, "team", "zzz-real", "EmptyRepoSentinel")
        self.build()
        result = self.search("EmptyRepoSentinel")
        self.assertNotIn("error", result)
        self.assertEqual([r["repo"] for r in result["results"]], ["team/zzz-real"])
        self.assertEqual(self.user_version(), indexer.INDEX_IDENTITY_VERSION)

    def test_empty_repo_stale_rows_are_purged(self):
        bare = make_bare(self.root, "team", "demo", "WillBecomeEmpty")
        self.build()
        self.assertEqual(self.search("WillBecomeEmpty")["total"], 1)
        # Replace the mirror with a repository that has no refs at all.
        def _force_remove(func, path, _exc):  # Windows: git objects are read-only
            os.chmod(path, 0o700)
            func(path)
        shutil.rmtree(bare, onerror=_force_remove)
        make_empty(self.root, "team", "demo")
        self.build()
        self.assertEqual(self.search("WillBecomeEmpty")["total"], 0)

    def test_unreadable_refs_are_still_reported(self):
        make_bare(self.root, "team", "demo", "ReadFailure")
        with mock.patch.object(indexer, "get_head_ref_and_sha", return_value=("HEAD", None)), \
             mock.patch.object(indexer, "repo_has_any_refs", return_value=True):
            with self.assertRaisesRegex(indexer.IndexReadError, "no resolvable branch"):
                self.build()

    def test_dangling_head_falls_back_to_first_branch(self):
        bare = make_bare(self.root, "team", "demo", "DanglingHeadSentinel")
        run("git", "--git-dir", str(bare), "branch", "-m", "main", "trunk")
        run("git", "--git-dir", str(bare), "symbolic-ref", "HEAD", "refs/heads/missing")
        self.build()
        self.assertEqual(self.search("DanglingHeadSentinel")["total"], 1)


class PartialAndAtomicBuildTests(IndexerResilienceBase):
    def fail_repo(self, name):
        real = indexer.get_tree_entries

        def fake(gitdir, ref, valid_exts):
            if os.path.basename(gitdir) == f"{name}.git":
                raise indexer.IndexReadError(f"INDEX_READ_FAILED: synthetic {name}")
            return real(gitdir, ref, valid_exts)

        return mock.patch.object(indexer, "get_tree_entries", side_effect=fake)

    def test_single_repo_failure_is_isolated_and_does_not_brick_the_index(self):
        make_bare(self.root, "team", "good", "IsolationGood")
        make_bare(self.root, "team", "zbad", "IsolationBad")
        with self.fail_repo("zbad"):
            with self.assertRaisesRegex(indexer.IndexReadError, "1 个仓索引失败"):
                self.build()
        # The good repository is searchable, the identity is stamped.
        self.assertEqual(self.search("IsolationGood")["total"], 1)
        self.assertEqual(self.user_version(), indexer.INDEX_IDENTITY_VERSION)
        # The next incremental run (failure gone) recovers without --full.
        self.build()
        self.assertEqual(self.search("IsolationBad")["total"], 1)

    def test_index_left_unstamped_by_2_0_2_self_heals(self):
        make_bare(self.root, "team", "demo", "SelfHealSentinel")
        self.build()
        conn = sqlite3.connect(indexer.get_db_path(str(self.root)))
        with conn:
            conn.execute("PRAGMA user_version=0")  # what an interrupted 2.0.2 build left behind
        conn.close()
        self.assertNotIn("INDEX_REBUILD_REQUIRED", self.search("SelfHealSentinel").get("error", ""))
        self.build()
        self.assertEqual(self.user_version(), indexer.INDEX_IDENTITY_VERSION)

    def test_bare_name_legacy_index_still_requires_full_rebuild(self):
        conn = sqlite3.connect(indexer.get_db_path(str(self.root)))
        indexer.init_db(conn, identity_version=None)
        with conn:
            cur = conn.execute(
                "INSERT INTO docs_fts(repo, ref, path, title, body, kind, mtime, body_raw) "
                "VALUES ('demo', 'main', 'README.md', 't', 't', 'doc', 1, 't')")
            conn.execute("INSERT INTO doc_rowid VALUES ('demo', 'main', 'README.md', ?)", (cur.lastrowid,))
        conn.close()
        self.assertIn("INDEX_REBUILD_REQUIRED", self.search("t").get("error", ""))
        make_bare(self.root, "team", "demo", "x")
        with self.assertRaisesRegex(RuntimeError, "INDEX_REBUILD_REQUIRED"):
            self.build()

    def test_full_rebuild_failure_keeps_previous_index_and_leaves_no_temp_files(self):
        make_bare(self.root, "team", "good", "AtomicGood")
        make_bare(self.root, "team", "zbad", "AtomicBad")
        self.build()
        self.assertEqual(self.search("AtomicBad")["total"], 1)
        with self.fail_repo("zbad"):
            with self.assertRaises(indexer.IndexReadError):
                self.build(full=True)
        # Old index survives untouched (zbad's documents are still searchable) ...
        self.assertEqual(self.search("AtomicBad")["total"], 1)
        self.assertEqual(self.search("AtomicGood")["total"], 1)
        # ... and no half-built sibling is left behind.
        leftovers = [p.name for p in (self.root / "state").iterdir() if p.name.endswith((".new", ".new-wal", ".new-shm"))]
        self.assertEqual(leftovers, [])

    def test_full_rebuild_success_swaps_atomically(self):
        make_bare(self.root, "team", "demo", "SwapSentinel")
        self.build()
        self.build(full=True)
        self.assertEqual(self.search("SwapSentinel")["total"], 1)
        self.assertFalse(os.path.exists(indexer.get_db_path(str(self.root)) + ".new"))

    def test_incremental_upgrade_purges_sensitive_paths_without_rescanning_unchanged_head(self):
        bare = make_bare(self.root, "team", "demo", "KeepOrdinaryDocument")
        self.build()
        with sqlite3.connect(indexer.get_db_path(str(self.root))) as conn:
            conn.execute("DROP TABLE index_meta")
            for path in (".docker/config.json", ".aws/credentials", ".kube/config"):
                key = ("team/demo", "main", path)
                cur = conn.execute(
                    "INSERT INTO docs_fts(repo, ref, path, body, body_raw) VALUES (?, ?, ?, 'OldFixture', 'OldFixture')", key
                )
                conn.execute("INSERT INTO doc_rowid VALUES (?, ?, ?, ?)", (*key, cur.lastrowid))
                conn.execute("INSERT INTO file_blobs VALUES (?, ?, ?, ?, 0)", (*key, "1" * 40))
            head = conn.execute("SELECT head_commit FROM repo_heads").fetchone()[0]
        conn.close()
        self.assertEqual(indexer.get_head_ref_and_sha(str(bare))[1], head)
        with mock.patch.object(indexer, "get_tree_entries", side_effect=AssertionError("unchanged HEAD was rescanned")):
            self.env["GITEA_BLOCK_SENSITIVE_PATHS"] = "0"
            self.build()
            conn = sqlite3.connect(indexer.get_db_path(str(self.root)))
            try:
                self.assertEqual(conn.execute("SELECT count(*) FROM doc_rowid").fetchone()[0], 4)
                self.assertEqual(conn.execute("SELECT count(*) FROM index_meta").fetchone()[0], 0)
            finally:
                conn.close()
            self.env["GITEA_BLOCK_SENSITIVE_PATHS"] = "1"
            self.assertEqual(self.build(), (0, 3, 0))
        conn = sqlite3.connect(indexer.get_db_path(str(self.root)))
        try:
            for table in ("docs_fts", "doc_rowid", "file_blobs"):
                self.assertEqual(conn.execute(f"SELECT path FROM {table}").fetchall(), [("README.md",)])
            self.assertEqual(conn.execute("SELECT value FROM index_meta WHERE key='sensitive_filter_version'").fetchone(),
                             (str(indexer.SENSITIVE_FILTER_VERSION),))
        finally:
            conn.close()
        self.assertEqual(self.search("KeepOrdinaryDocument")["total"], 1)

    def test_replace_refs_are_ignored_across_indexing_and_legacy_snippet(self):
        bare = make_bare(self.root, "team", "snap", "OriginalIndexedDoc33")
        alt = make_bare(self.root, "team", "alt", "ReplacedIndexedDoc33")
        # Copy alt's objects into bare and point refs/replace at both commit and blob levels
        run("git", "--git-dir", str(bare), "fetch", "-q", str(alt), "refs/heads/main:refs/tmp/alt")
        orig_commit = subprocess.check_output(
            ["git", "--git-dir", str(bare), "rev-parse", "refs/heads/main"], text=True
        ).strip()
        alt_commit = subprocess.check_output(
            ["git", "--git-dir", str(bare), "rev-parse", "refs/tmp/alt"], text=True
        ).strip()
        orig_blob = subprocess.check_output(
            ["git", "--git-dir", str(bare), "rev-parse", "refs/heads/main:README.md"], text=True
        ).strip()
        alt_blob = subprocess.check_output(
            ["git", "--git-dir", str(bare), "rev-parse", "refs/tmp/alt:README.md"], text=True
        ).strip()
        run("git", "--git-dir", str(bare), "update-ref", f"refs/replace/{orig_commit}", alt_commit)
        run("git", "--git-dir", str(bare), "update-ref", f"refs/replace/{orig_blob}", alt_blob)
        run("git", "--git-dir", str(bare), "update-ref", "-d", "refs/tmp/alt")

        def _force_remove(func, path, _exc):
            os.chmod(path, 0o700)
            func(path)
        shutil.rmtree(alt, onerror=_force_remove)

        self.build()
        self.assertEqual(self.search("OriginalIndexedDoc33")["total"], 1)
        self.assertEqual(self.search("ReplacedIndexedDoc33")["total"], 0)

        # Simulate legacy index without body_raw column: snippet loader must match indexed unreplaced blob_sha
        with sqlite3.connect(indexer.get_db_path(str(self.root))) as conn:
            rows = conn.execute("SELECT repo, ref, path, title, body, kind, mtime FROM docs_fts").fetchall()
            conn.execute("DROP TABLE docs_fts")
            conn.execute(
                "CREATE VIRTUAL TABLE docs_fts USING fts5("
                "repo, ref, path, title, body, kind UNINDEXED, mtime UNINDEXED)"
            )
            for row in rows:
                cur = conn.execute(
                    "INSERT INTO docs_fts(repo, ref, path, title, body, kind, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    row,
                )
                conn.execute(
                    "UPDATE doc_rowid SET rowid=? WHERE repo=? AND ref=? AND path=?",
                    (cur.lastrowid, row[0], row[1], row[2]),
                )
        conn.close()
        legacy_res = self.search("OriginalIndexedDoc33")
        self.assertEqual(legacy_res["total"], 1)
        self.assertIn("OriginalIndexedDoc33", legacy_res["results"][0]["snippet"])
        self.assertNotIn("ReplacedIndexedDoc33", legacy_res["results"][0]["snippet"])


class RepoFilterConsistencyTests(IndexerResilienceBase):
    def setUp(self):
        super().setUp()
        make_bare(self.root, "team", "myapp", "FilterSentinel")
        make_bare(self.root, "team", "other-config", "FilterSentinel")
        self.build()

    def repos(self, pattern):
        return sorted(r["repo"] for r in self.search("FilterSentinel", repo=pattern)["results"])

    def test_bare_name_matches_basename_substring_like_gts_repos(self):
        self.assertEqual(self.repos("app"), ["team/myapp"])
        self.assertEqual(self.repos("yapp"), ["team/myapp"])

    def test_owner_qualified_matches_identity(self):
        self.assertEqual(self.repos("team/myapp"), ["team/myapp"])
        self.assertEqual(self.repos("team/app"), [])

    def test_globs_use_fnmatch_on_the_whole_name(self):
        self.assertEqual(self.repos("my*"), ["team/myapp"])
        self.assertEqual(self.repos("*-config"), ["team/other-config"])
        self.assertEqual(self.repos("*config*"), ["team/other-config"])

    def test_comma_separated_patterns_are_ored_and_unknown_is_empty(self):
        self.assertEqual(self.repos("myapp,other-config"), ["team/myapp", "team/other-config"])
        self.assertEqual(self.repos("nonexistent"), [])


if __name__ == "__main__":
    unittest.main()
