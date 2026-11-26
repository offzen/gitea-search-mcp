// SPDX-License-Identifier: Apache-2.0
/**
 * lib/audit.mjs — Opt-in, privacy-first JSONL audit logger for gitea-search-mcp.
 *
 * Disabled by default (zero I/O overhead). Enable via:
 *   GITEA_AUDIT_LOG=1             -> auto monthly file under XDG state dir / LocalAppData
 *   GITEA_AUDIT_LOG=/path/to.jsonl -> explicit JSONL file path
 *   GITEA_AUDIT_INCLUDE_QUERY=1   -> opt-in raw query/filter/path logging (redacted by default)
 *   GITEA_AUDIT_CLIENT=<name>     -> optional host client label override
 *   GITEA_AUDIT_SESSION_ID=<id>   -> optional session correlation ID override
 *
 * Never writes to stdout (MCP stdio JSON-RPC safety) and never throws on I/O errors.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUDIT_SCHEMA_VERSION = 1;
const DISABLED_VALUES = new Set(['', '0', 'false', 'off', 'no', 'none']);
const AUTO_VALUES = new Set(['1', 'true', 'on', 'yes', 'auto']);

function expandHome(p, homeDir = os.homedir()) {
  if (!p) return p;
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir, p.slice(2));
  return p;
}

function defaultStateDir(env = process.env, platform = process.platform, homeDir = os.homedir()) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    return path.join(base, 'gitea-search-mcp');
  }
  const base = env.XDG_STATE_HOME || path.join(homeDir, '.local', 'state');
  return path.join(expandHome(base, homeDir), 'gitea-search-mcp');
}

function resolveAuditLogPath(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const homeDir = opts.homeDir || env.HOME || env.USERPROFILE || os.homedir();
  const now = opts.now instanceof Date ? opts.now : new Date();
  const raw = String(env.GITEA_AUDIT_LOG ?? '').trim();
  const lower = raw.toLowerCase();
  if (DISABLED_VALUES.has(lower)) return null;
  if (AUTO_VALUES.has(lower)) {
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return path.join(defaultStateDir(env, platform, homeDir), `audit-${ym}.jsonl`);
  }
  return path.resolve(expandHome(raw, homeDir));
}

function detectParentProcessName(ppid = process.ppid, platform = process.platform) {
  if (platform !== 'linux' || !ppid) return '';
  try {
    return fs.readFileSync(`/proc/${ppid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

function hashSnippet(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

function summarizeArgs(tool, args = {}, includeQuery = false) {
  const a = args && typeof args === 'object' ? args : {};
  const meta = {};

  if (typeof a.query === 'string') {
    meta.query_len = a.query.length;
    meta.query_sha8 = hashSnippet(a.query);
    if (includeQuery) meta.query = a.query.slice(0, 200);
  }
  if (typeof a.filter === 'string') {
    meta.filter_len = a.filter.length;
    meta.filter_sha8 = hashSnippet(a.filter);
    if (includeQuery) meta.filter = a.filter.slice(0, 120);
  }
  if (typeof a.path === 'string') {
    meta.path_len = a.path.length;
    meta.path_sha8 = hashSnippet(a.path);
    if (includeQuery) meta.path = a.path.slice(0, 200);
  }
  if (typeof a.repo === 'string' && a.repo) meta.repo = a.repo.slice(0, 120);
  if (typeof a.branch === 'string' && a.branch) meta.branch = a.branch.slice(0, 80);
  if (typeof a.ref === 'string' && a.ref) meta.ref = a.ref.slice(0, 80);
  if (tool === 'search_code') {
    meta.mode = a.mode || 'content';
    if (a.files_only) meta.files_only = true;
    if (a.regex) meta.regex = true;
    if (a.case_sensitive) meta.case_sensitive = true;
    if (a.sync === true) meta.sync_ignored = true;
    if (a.max_results !== undefined) meta.max_results = Number(a.max_results);
  } else if (tool === 'sync_mirror') {
    meta.sync = true;
  } else if (tool === 'search_docs') {
    if (a.kind) meta.kind = String(a.kind);
    if (a.max_results !== undefined) meta.max_results = Number(a.max_results);
  } else if (tool === 'read_file') {
    if (a.offset !== undefined) meta.offset = Number(a.offset);
    if (a.limit !== undefined) meta.limit = Number(a.limit);
  }
  return meta;
}

function createAuditLogger(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const homeDir = opts.homeDir || env.HOME || env.USERPROFILE || os.homedir();
  const logError = typeof opts.logError === 'function' ? opts.logError : () => {};
  const includeQuery = AUTO_VALUES.has(String(env.GITEA_AUDIT_INCLUDE_QUERY ?? '').trim().toLowerCase());
  const startedAtMs = Date.now();
  const rand = crypto.randomBytes(2).toString('hex');
  const procSessionId = String(env.GITEA_AUDIT_SESSION_ID || '').trim()
    || `${process.pid}-${startedAtMs}-${rand}`;
  const envClient = String(env.GITEA_AUDIT_CLIENT || '').trim();
  let cachedParentName = null;
  let warnedFailure = false;

  function resolveClient(clientInfo) {
    if (envClient) return { client: envClient, clientVersion: clientInfo?.version || '' };
    if (clientInfo && typeof clientInfo.name === 'string' && clientInfo.name.trim()) {
      return {
        client: clientInfo.name.trim(),
        clientVersion: typeof clientInfo.version === 'string' ? clientInfo.version.trim() : '',
      };
    }
    if (cachedParentName === null) {
      cachedParentName = detectParentProcessName(process.ppid, platform);
    }
    return { client: cachedParentName || 'unknown', clientVersion: '' };
  }

  function isEnabled(now = new Date()) {
    return resolveAuditLogPath({ env, platform, homeDir, now }) !== null;
  }

  function record(entry) {
    const now = entry?.now instanceof Date ? entry.now : new Date();
    const elapsedMs = Number.isFinite(entry?.elapsedMs) ? Math.max(0, Math.round(entry.elapsedMs)) : 0;
    let startedAt;
    if (entry?.startedAt instanceof Date) {
      startedAt = entry.startedAt;
    } else if (typeof entry?.startedAt === 'number' && Number.isFinite(entry.startedAt)) {
      startedAt = new Date(entry.startedAt);
    } else if (typeof entry?.startedAt === 'string' && Number.isFinite(Date.parse(entry.startedAt))) {
      startedAt = new Date(Date.parse(entry.startedAt));
    } else {
      startedAt = new Date(now.getTime() - elapsedMs);
    }
    const targetPath = resolveAuditLogPath({ env, platform, homeDir, now });
    if (!targetPath) return null;

    const { client, clientVersion } = resolveClient(entry.clientInfo);
    const payload = {
      schema: AUDIT_SCHEMA_VERSION,
      ts: now.toISOString(),
      started_ts: startedAt.toISOString(),
      proc_session_id: procSessionId,
      pid: process.pid,
      ppid: process.ppid,
      client,
      ...(clientVersion ? { client_version: clientVersion } : {}),
      tool: entry.tool || 'unknown',
      raw_tool: entry.rawTool || entry.tool || 'unknown',
      deprecated_alias: Boolean(entry.deprecatedAlias),
      args_meta: summarizeArgs(entry.tool, entry.args, includeQuery),
      elapsed_ms: elapsedMs,
      ...(Number.isFinite(entry.internalMs) ? { internal_ms: Number(entry.internalMs.toFixed(2)) } : {}),
      ...(typeof entry.hits === 'number' && Number.isFinite(entry.hits) ? { hits: entry.hits } : {}),
      ...(Array.isArray(entry.hitRepos) && entry.hitRepos.length > 0 ? { hit_repos: entry.hitRepos.slice(0, 10) } : {}),
      ...(typeof entry.redactedHits === 'number' && entry.redactedHits > 0 ? { redacted_hits: entry.redactedHits } : {}),
      ...(typeof entry.blockedSensitive === 'number' && entry.blockedSensitive > 0 ? { blocked_sensitive: entry.blockedSensitive } : {}),
      resp_bytes: Number.isFinite(entry.respBytes) ? Math.max(0, Math.round(entry.respBytes)) : 0,
      truncated: Boolean(entry.truncated),
      is_error: Boolean(entry.isError),
    };

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.appendFileSync(targetPath, JSON.stringify(payload) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      if (!warnedFailure) {
        warnedFailure = true;
        logError(`audit log write failed (${targetPath}): ${err?.message || err}`);
      }
      return null;
    }
    return payload;
  }

  return {
    procSessionId,
    isEnabled,
    record,
    resolvePath: (now = new Date()) => resolveAuditLogPath({ env, platform, homeDir, now }),
  };
}

export {
  AUDIT_SCHEMA_VERSION,
  createAuditLogger,
  defaultStateDir,
  resolveAuditLogPath,
  summarizeArgs,
};
