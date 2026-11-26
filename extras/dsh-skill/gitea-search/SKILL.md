---
name: gitea-search
description: Search mirrored Git/Gitea repositories through the installed MCP server.
---

# Gitea Search

1. Inspect the host's actual tool registry first. MCP `tools/list` returns bare server names, while a host may prefix, sanitize, or rename them.
2. Use the code search tool for source, paths, commit messages, and non-default branches.
3. Use the document search tool for Markdown, sessions, configuration, and scripts. Its FTS index covers each repository's **default branch** only.
4. Start with a narrow query and repository filter, then read the selected file by repository, path, and ref.
5. If document search returns no match, shorten the query or use code search across heads; read a non-default ref explicitly when needed.
6. Do not unpack complete session archives merely because a focused query returned no result.
7. Read result banners: `PARTIAL_RESULT` means some repositories failed (do not conclude "no hits elsewhere"); `≥ N` is a lower bound; `SYNC_BUSY` means another sync is running and results may be slightly stale; `SYNC_DEGRADED` means `sync_mirror` synced known mirrors using cache/disk enumeration (check `GITEA_URL`/credentials for newly pushed repos); `SYNC_MOVED` means `search_code` is strictly read-only and ignored `sync:true` (call `sync_mirror` explicitly when needed); `FILE_TOO_LARGE` / `OUTPUT_TOO_LARGE` mean narrow the query instead of retrying.
8. `branch` matches exactly (`main` does not match `maintenance`; use `main*` for a prefix). `repo` accepts `owner/repo`, a name substring, or `*` globs, and means the same for both search tools.

This skill is optional. Install it explicitly; installers must not overwrite an existing skill or write memory as a side effect.
