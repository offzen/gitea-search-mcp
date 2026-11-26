#!/usr/bin/env python3
"""Run Node, Python, and E2E test suites and enforce fail-closed count floors.

Guards against silent suite skips, missing test dependencies (e.g. PyYAML / jieba),
or zero-test false greens. Can run standalone in CI or optionally write a JSON
summary via --output.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

SCHEMA = 2
NODE_FIELDS = ("total", "pass", "fail", "cancelled", "skipped", "todo")
NODE_LABELS = {"total": "tests", "pass": "pass", "fail": "fail", "cancelled": "cancelled",
               "skipped": "skipped", "todo": "todo"}
TAP_SUMMARY = {field: re.compile(rf"^# {label} (\d+)\s*$", re.MULTILINE) for field, label in NODE_LABELS.items()}
SPEC_SUMMARY = {
    field: re.compile(rf"^[^A-Za-z0-9_]*{label} (\d+)\s*$", re.MULTILINE)
    for field, label in NODE_LABELS.items()
}
PYTHON_RAN = re.compile(r"^Ran (\d+) tests? in ", re.MULTILINE)
PYTHON_OK = re.compile(r"^OK\b", re.MULTILINE)
PYTHON_SKIPPED = re.compile(r"^OK \(skipped=(\d+)\)$", re.MULTILINE)
E2E_SUMMARY = re.compile(r"验收汇总:\s*(\d+)\s*绿")
E2E_FAIL_SUMMARY = re.compile(r"验收汇总:\s*\d+\s*绿[^/]*/\s*(\d+)\s*红")
E2E_PASS_LINE = re.compile(r"^\s*✓ \[PASS\]", re.MULTILINE)
E2E_FAIL_LINE = re.compile(r"^\s*\S+ \[FAIL\]", re.MULTILINE)

MIN_NODE_PASS = 100
MIN_E2E_PASS = 31

PYTHON_SUITES = (
    "test/collect-test-counts.test.py",
    "test/dependency-missing.test.py",
    "test/owner-qualified-repos.test.py",
    "test/fts-result-contract.test.py",
    "test/profile-yaml.test.py",
    "test/repo-zero-hit.test.py",
    "test/indexer-resilience.test.py",
    "test/documentation-contract.test.py",
)


def bash_exe() -> str:
    """Return the bash to run e2e with. On Windows prefer Git Bash: System32\\bash.exe is the WSL launcher."""
    if os.name != "nt":
        return "bash"
    cands = [shutil.which("bash") or ""]
    for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            cands += [os.path.join(base, "Git", "bin", "bash.exe"), os.path.join(base, "Programs", "Git", "bin", "bash.exe")]
    for c in cands:
        if c and os.path.isfile(c) and "system32" not in c.lower().replace("/", "\\"):
            return c
    return "bash"


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, encoding="utf-8", errors="replace", capture_output=True, check=False)


def strict_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def parse_node_summary(output: str, patterns: dict[str, re.Pattern[str]]) -> dict[str, int] | None:
    totals = patterns["total"].findall(output)
    if not totals:
        return None
    counts = {"total": int(totals[-1])}
    for field in NODE_FIELDS[1:]:
        found = patterns[field].findall(output)
        counts[field] = int(found[-1]) if found else 0
    return counts


def validate_node(counts: dict[str, int]) -> str | None:
    for field in NODE_FIELDS:
        if not strict_count(counts.get(field)):
            return f"node.{field}={counts.get(field)!r} is not a non-negative integer"
    if counts["total"] == 0:
        return "node reported 0 tests (unparseable output or an empty suite)"
    parts = sum(counts[field] for field in NODE_FIELDS[1:])
    if parts != counts["total"]:
        return (f"node counts do not add up: pass+fail+cancelled+skipped+todo={parts} "
                f"!= total={counts['total']}")
    return None


def node_counts() -> tuple[dict[str, int], str, bool]:
    result = run(["node", "--test", "--test-reporter=tap"])
    output = (result.stdout or "") + (result.stderr or "")
    reporter = "tap"
    counts = parse_node_summary(output, TAP_SUMMARY)
    if counts is None:
        result = run(["node", "--test"])
        output = (result.stdout or "") + (result.stderr or "")
        reporter = "default"
        counts = parse_node_summary(output, SPEC_SUMMARY)
    if counts is None:
        counts = {field: 0 for field in NODE_FIELDS}
    if result.returncode != 0:
        print("NODE_FAILED_SUMMARY:", file=sys.stderr)
        not_ok = [line for line in output.splitlines() if "not ok " in line or "error:" in line or "location:" in line]
        for line in (not_ok[:30] or output.splitlines()[-25:]):
            print("  " + line[:300], file=sys.stderr)
    return counts, reporter, result.returncode == 0 and counts["fail"] == 0


def python_suites() -> tuple[list[dict[str, object]], bool]:
    records: list[dict[str, object]] = []
    all_ok = True
    for suite in PYTHON_SUITES:
        result = run([sys.executable, suite])
        output = (result.stdout or "") + (result.stderr or "")
        ran_match = PYTHON_RAN.search(output)
        tests = int(ran_match.group(1)) if ran_match else 0
        skipped_match = PYTHON_SKIPPED.search(output)
        skipped = int(skipped_match.group(1)) if skipped_match else 0
        ok = result.returncode == 0 and PYTHON_OK.search(output) is not None and skipped == 0
        records.append({"suite": suite, "ran": tests >= 1, "ok": ok, "tests": tests})
        if not ok:
            print(f"PYTHON_SUITE_FAILED suite={suite} rc={result.returncode} skipped={skipped}", file=sys.stderr)
            for line in output.splitlines()[-12:]:
                print("  " + line[:300], file=sys.stderr)
            all_ok = False
    return records, all_ok


def e2e_count() -> tuple[dict[str, int], bool]:
    result = run([bash_exe(), "scripts/run-e2e-test.sh"])
    output = (result.stdout or "") + (result.stderr or "")
    passed = int(m.group(1)) if (m := E2E_SUMMARY.search(output)) else 0
    if not passed:
        passed = len(E2E_PASS_LINE.findall(output))
    failed = int(m.group(1)) if (m := E2E_FAIL_SUMMARY.search(output)) else len(E2E_FAIL_LINE.findall(output))
    if result.returncode != 0:
        print("E2E_FAILED_OUTPUT_TAIL:", file=sys.stderr)
        for line in output.splitlines()[-25:]:
            print("  " + line[:300], file=sys.stderr)
    return {"pass": passed, "fail": failed}, result.returncode == 0 and failed == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=False, default=None, type=pathlib.Path,
                        help="Optional path to write JSON test counts")
    parser.add_argument("--skip-e2e", action="store_true",
                        help="Skip E2E when exercised by a dedicated job")
    args = parser.parse_args()

    node, reporter, node_ok = node_counts()
    python, python_ok = python_suites()
    e2e, e2e_ok = ({"pass": 0, "fail": 0}, True) if args.skip_e2e else e2e_count()
    suites = sum(1 for record in python if record["ran"])

    problem = validate_node(node)
    if problem is None:
        for field in ("pass", "fail"):
            if not strict_count(e2e[field]):
                problem = f"e2e.{field}={e2e[field]!r} is not a non-negative integer"
    if problem is None and node["pass"] < MIN_NODE_PASS:
        problem = f"node.pass={node['pass']} below floor {MIN_NODE_PASS}"
    if problem is None and suites < len(PYTHON_SUITES):
        problem = f"python_suites={suites} below required {len(PYTHON_SUITES)}"
    if problem is None and not args.skip_e2e and e2e["pass"] < MIN_E2E_PASS:
        problem = f"e2e.pass={e2e['pass']} below floor {MIN_E2E_PASS}"
    if problem:
        print(f"TEST_COUNTS_BLOCKED: {problem}", file=sys.stderr)
        return 1

    counts = {
        "schema": SCHEMA,
        "reporter": reporter,
        "node": node,
        "python": python,
        "e2e": e2e,
        "node_total": node["total"],
        "node_pass": node["pass"],
        "node_fail": node["fail"],
        "node_cancelled": node["cancelled"],
        "node_skipped": node["skipped"],
        "node_todo": node["todo"],
        "python_suites": suites,
        "node_ok": node_ok,
        "python_ok": python_ok,
        "e2e_ok": e2e_ok,
    }
    if args.output is not None:
        try:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(counts, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"TEST_COUNTS_BLOCKED: cannot write {args.output}: {type(exc).__name__}", file=sys.stderr)
            return 2
        print(f"TEST_COUNTS_WRITTEN {args.output}")

    print(
        f"TEST_COUNTS node={node['pass']}/{node['total']} fail={node['fail']} skipped={node['skipped']} "
        f"reporter={reporter} python_suites={suites} e2e={e2e['pass']}"
    )

    if not (node_ok and python_ok and e2e_ok):
        print("TEST_COUNTS_BLOCKED: at least one suite failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
