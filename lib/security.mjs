// SPDX-License-Identifier: Apache-2.0
/**
 * lib/security.mjs — Output secret redaction and sensitive-path denylist guard
 * for gitea-search-mcp (prevents accidental credential exposure on search/read).
 *
 * Enabled by default (fail-safe). Controls via environment variables:
 *   GITEA_REDACT_SECRETS=0|false|off        -> opt-out of output secret redaction
 *   GITEA_BLOCK_SENSITIVE_PATHS=0|false|off -> opt-out of sensitive-path blocking
 */
import path from 'node:path';

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', 'none']);

function isEnvEnabled(env, key, defaultValue = true) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
  return !DISABLED_VALUES.has(String(raw).trim().toLowerCase());
}

const SAFE_TEMPLATE_SUFFIX_RE = /\.(?:example|sample|template|tpl|dist|schema\.json)$/i;
const SENSITIVE_BASENAME_RE = new RegExp(
  [
    '^\\.env(?:\\..+)?$',
    '^id_(?:rsa|ed25519|ecdsa|dsa)$',
    '^\\.(?:netrc|npmrc|pypirc|git-credentials|sync-token|admin-token|credentials\\.ya?ml)$',
    '^admin-credentials\\.txt$',
    '^infisical\\.(?:json|token)$',
    '^auth\\.json$',
    '^credentials\\.json$',
    '^service[-_]?account.*\\.json$',
    '^\\.(?:pgpass|htpasswd|dockercfg)$',
    '^kubeconfig$',
    '.*\\.tfstate(?:\\.backup)?$',
  ].join('|'),
  'i',
);
// 路径感知条目：basename 太泛（credentials / config / config.json），必须连同父目录一起判断。
const SENSITIVE_PATH_RE = /(?:^|\/)(?:\.aws\/credentials|\.docker\/config\.json|\.kube\/config)$/i;
const SENSITIVE_EXT_RE = /\.(?:pem|key|p12|pfx|jks|kdbx|ppk|ovpn|token)$/i;
const ARCHIVE_EXT_RE = /\.(?:tar|tar\.gz|tgz|tar\.bz2|tar\.zst|zip)$/i;

/**
 * Determine whether a repository-relative path points to a sensitive credential
 * or archive file that should not be indexed or returned by default.
 */
function isSensitivePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const base = path.posix.basename(normalized);
  if (!base) return false;
  if (SENSITIVE_EXT_RE.test(base) || ARCHIVE_EXT_RE.test(base)) return true;
  if (SAFE_TEMPLATE_SUFFIX_RE.test(base)) return false;
  if (SENSITIVE_PATH_RE.test(normalized)) return true;
  return SENSITIVE_BASENAME_RE.test(base);
}

const PLACEHOLDER_RE = /^(?:REDACTED|SECRET_REDACTED|\[REDACTED[^\]]*\]|\[[A-Z0-9_:-]*REDACTED[^\]]*\]|<[^>]+>|\$\{?[\w.-]+\}?|\{\{[^}]+\}\}|your[_-]|changeme|placeholder|example|dummy|test[_-]?(?:key|token|secret|pass)|fake[_-]|null|none|true|false|x{6,}|\*{4,}|\.{3,})$/i;

function looksLikeFilesystemPath(trimmed, allowRootMount) {
  // Relative paths, home paths, and Windows drive paths cannot collide with standard base64 tokens.
  if (/^(?:\.\.?\/|~\/|[A-Za-z]:\\)/.test(trimmed)) return true;
  if (!trimmed.startsWith('/')) return false;
  if (/[+=]/.test(trimmed)) return false;
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length < 2) {
    // In assignments, accept a 2–16 character lowercase mount name, with optional
    // hyphens/underscores and a 1–8 letter lowercase extension.
    return allowRootMount && /^\/(?=[a-z_-]{2,16}(?:\.|$))[a-z]{2,}(?:[-_][a-z]+)*(?:\.[a-z]{1,8})?$/.test(trimmed);
  }
  if (/[A-Z]/.test(segments[0]) && /[a-z]/.test(segments[0]) && /[0-9]/.test(segments[0])) return false;
  if (segments.some((seg) => (
    seg.length >= 12
    && /[A-Z]/.test(seg)
    && /[a-z]/.test(seg)
    && /[0-9]/.test(seg)
    && !/^[A-Z][a-z]+[A-Za-z]*[0-9]{1,4}$/.test(seg)
  ))) {
    return false;
  }
  return true;
}

function looksLikePlaceholderOrPath(val, allowRootMount = false) {
  if (!val) return true;
  const trimmed = val.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_RE.test(trimmed)) return true;
  // Local filesystem paths (e.g. private_key=/etc/ssl/..., token=/run/secrets/...)
  if (looksLikeFilesystemPath(trimmed, allowRootMount)) return true;
  // Pure variable references or interpolation expressions
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return true;
  if (/^\[[A-Z0-9_:-]+\]$/.test(trimmed)) return true;
  return false;
}

const REDACT_RULES = [
  {
    id: 'private_key_block',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replace: () => '[SECRET_REDACTED:private_key]',
  },
  {
    id: 'private_key_header',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replace: () => '[SECRET_REDACTED:private_key_header]',
  },
  {
    id: 'github_token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replace: () => '[SECRET_REDACTED:github_token]',
  },
  {
    id: 'gitlab_token',
    re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => '[SECRET_REDACTED:gitlab_token]',
  },
  {
    id: 'sk_api_key',
    re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: () => '[SECRET_REDACTED:sk_api_key]',
  },
  {
    id: 'aws_access_key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => '[SECRET_REDACTED:aws_access_key]',
  },
  {
    id: 'google_api_key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => '[SECRET_REDACTED:google_api_key]',
  },
  {
    id: 'slack_token',
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    replace: () => '[SECRET_REDACTED:slack_token]',
  },
  {
    id: 'telegram_bot_token',
    re: /\b\d{8,11}:AA[0-9A-Za-z_-]{33}\b/g,
    replace: () => '[SECRET_REDACTED:telegram_bot_token]',
  },
  {
    id: 'jwt_token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => '[SECRET_REDACTED:jwt]',
  },
  {
    id: 'auth_header',
    re: /(Authorization\s*:\s*(?:Bearer|token|Basic)\s+)([^\s'"`<>\\]{8,})/gi,
    replace: (match, prefix, secret) => {
      if (looksLikePlaceholderOrPath(secret)) return null;
      return `${prefix}[SECRET_REDACTED:auth_header]`;
    },
  },
  {
    id: 'url_credentials',
    re: /((?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp|ftp):\/\/[^/\s:@]{1,64}:)([^/\s@]{6,})(@)/gi,
    replace: (match, prefix, secret, suffix) => {
      if (looksLikePlaceholderOrPath(secret)) return null;
      return `${prefix}[SECRET_REDACTED:url_password]${suffix}`;
    },
  },
  {
    id: 'kv_secret',
    // 键名允许任意 `FOO_BAR_` 前缀（MYSQL_ROOT_PASSWORD、SMTP_PASS、AWS_SECRET_ACCESS_KEY），
    // 允许 JSON/YAML 的带引号键（"password": "…"）；带引号的值允许空格与 , ; 等字符。
    re: /(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_-])*(api[_-]?key|secret[_-]?access[_-]?key|(?:access|auth|refresh|bearer)[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|passphrase|passwd|password|pass|pwd|token|secret)["']?\s*[=:]\s*)(?:(["'])([^"'\r\n]{6,})\3|([^\s"'`,;<>}{()[\]\\]{8,}))/gi,
    replace: (...args) => {
      const str = args[args.length - 1];
      const offset = args[args.length - 2];
      const [match, prefix, , quote, quotedVal, bareVal] = args;
      const secret = quote ? quotedVal : bareVal;
      if (looksLikePlaceholderOrPath(secret, true)) return null;
      if (!quote) {
        const next = str[offset + match.length];
        // 函数调用 / 下标取值（token = next_token()、secret_key = os.environ[...]）是代码，不是字面量凭据。
        if (next === '(' || next === '[') return null;
        // 成员访问链（config.api_key）与全小写下划线标识符（password_input）是变量引用，不是字面量。
        if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(secret) && !/\d/.test(secret)) return null;
        if (/^[a-z]+(?:_[a-z]+)+$/.test(secret)) return null;
        // 无前缀的歧义键（token/pass/pwd/secret）配“纯字母标识符”值：多半是变量名，不当作凭据；
        // 带前缀（SMTP_PASS、GITHUB_TOKEN）说明是配置项，照常脱敏。
        if (/^(?:token|pass|pwd|secret)["']?\s*[=:]\s*$/i.test(prefix) && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(secret) && !/\d/.test(secret)) return null;
      }
      return quote
        ? `${prefix}${quote}[SECRET_REDACTED:kv_secret]${quote}`
        : `${prefix}[SECRET_REDACTED:kv_secret]`;
    },
  },
];

/**
 * Redact high-confidence secrets from text before returning to an MCP client.
 * Returns { text, count, rules } without ever logging or exposing raw values.
 */
function redactSecrets(text, opts = {}) {
  const str = typeof text === 'string' ? text : String(text ?? '');
  const enabled = opts.enabled !== undefined
    ? Boolean(opts.enabled)
    : isEnvEnabled(opts.env || process.env, 'GITEA_REDACT_SECRETS', true);
  if (!enabled || !str) return { text: str, count: 0, rules: [] };

  let out = str;
  let count = 0;
  const hitRules = new Set();

  for (const rule of REDACT_RULES) {
    out = out.replace(rule.re, (...args) => {
      const replaced = rule.replace(...args);
      if (replaced === null || replaced === args[0]) return args[0];
      count += 1;
      hitRules.add(rule.id);
      return replaced;
    });
  }

  return { text: out, count, rules: [...hitRules] };
}

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_HEADER_RE = /^(?:Proc-Type|DEK-Info|Comment|Version|Hash|Charset)[ \t\r\f\v]*:/i;
const PEM_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PEM_ASSIGNMENT_RE = /^(?:(?:const|let|var)[ \t\r\f\v]+)?[\w.]+[ \t\r\f\v]*(?:\+?=|\()[ \t\r\f\v]*(['"`])([^\n]+?)\1[ \t\r\f\v]*\)?$/;

/**
 * Strip common source/YAML/comment line framing (single comment prefix, quotes/backticks,
 * escaped trailing \r\n, trailing , ; + \) so embedded multiline PEM blocks are recognized.
 * Deliberately ignores Markdown headings (## / ###) to keep N8 pruning fast on docs.
 */
function unwrapPemLine(line) {
  let s = String(line ?? '').trim();
  if (!s || /^#{2,}[ \t\r\f\v]/.test(s)) return s;
  s = s.replace(/^(?:(?:\/\/|\/\*|#|\*|--|;|>|-[ \t\r\f\v]+)[ \t\r\f\v]*)+/, '');
  if (/[,;+\\]$|\*\/$/.test(s)) s = s.replace(/(?:\*\/|[,;+\\])+$/, '').trimEnd();
  const quoted = s.match(/^(['"`])([^\n]*)\1$/) || PEM_ASSIGNMENT_RE.exec(s);
  if (quoted) {
    s = quoted[2].replace(/(?:\\r)?\\n$/, '');
  } else {
    s = s.replace(/^['"`]/, '').replace(/(?:\\r)?\\n['"`]?$/, '').replace(/['"`]$/, '');
  }
  return s.trim();
}

// Keep the continuation grammar in sync with lib/indexer.py. Short, unpadded
// chunks require earlier body/header context and stronger evidence than a word.
function looksLikeBase64Body(token, hasContext, bare = false) {
  if (/^=[A-Za-z0-9+/]{4}$/.test(token)) return true; // PGP checksum
  if (!PEM_BODY_RE.test(token)) return false;
  if (token.endsWith('=') && token.length >= 4) return true;
  if (bare && token.length >= 16) return true;
  if (token.length < 16 && (!hasContext || token.length < 4 || token.length % 4 !== 0)) return false;
  if (/^[0-9a-f]+$/.test(token) || /^[A-Z]?[a-z]+$/.test(token)) return false;
  if (token.includes('+')) return true;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const hasSlash = token.includes('/');
  if (hasUpper && hasLower && (hasDigit || hasSlash)) return true;
  if (hasUpper && /^[A-Z0-9]+$/.test(token)) return true;
  return (token.length < 16 || token.length >= 24) && hasUpper && hasLower;
}

function isPemContinuation(trimmed, unwrapped, hasContext) {
  return looksLikeBase64Body(trimmed, hasContext, true)
    || PEM_HEADER_RE.test(unwrapped)
    || (unwrapped !== trimmed && looksLikeBase64Body(unwrapped, hasContext));
}

/**
 * Identify 0-based line indices belonging to multiline PEM private-key blocks
 * across a full file, BEFORE any pagination or line-level snippet slicing.
 * Closed blocks cover [BEGIN .. END]; unclosed blocks cover BEGIN plus
 * subsequent PEM headers/base64 body lines until the first non-PEM line.
 */
function findPrivateKeyLineIndices(lines) {
  const indices = new Set();
  const ranges = [];
  if (!Array.isArray(lines) || !lines.length) return { indices, ranges };

  const n = lines.length;
  // 2.0.3 N1：先一次性收集全部 END 行下标，之后每个 BEGIN 只做指针前移，整体 O(n)。
  // （旧实现对每个无 END 的 BEGIN 都从头向后扫到文件末尾，N 个 BEGIN 行 ⇒ O(n²)，1.1MB 文件卡死 22 秒。）
  const endLines = [];
  for (let i = 0; i < n; i += 1) {
    if (PEM_END_RE.test(String(lines[i] ?? ''))) endLines.push(i);
  }
  let endPtr = 0;

  for (let i = 0; i < n; i += 1) {
    const line = String(lines[i] ?? '');
    if (!PEM_BEGIN_RE.test(line)) continue;
    if (PEM_END_RE.test(line)) {
      indices.add(i);
      ranges.push([i, i]);
      continue;
    }
    while (endPtr < endLines.length && endLines[endPtr] <= i) endPtr += 1;
    if (endPtr < endLines.length) {
      const end = endLines[endPtr];
      for (let k = i; k <= end; k += 1) indices.add(k);
      ranges.push([i, end]);
      i = end;
      continue;
    }
    // 之后再无 END：BEGIN 加紧随其后的 PEM 头/base64 正文行（含源码引号/注释包裹），遇到首个非 PEM 行为止。
    let last = i;
    let hasContext = false;
    indices.add(i);
    for (let j = i + 1; j < n; j += 1) {
      const trimmed = String(lines[j] ?? '').trim();
      if (trimmed && !isPemContinuation(trimmed, unwrapPemLine(trimmed), hasContext)) break;
      if (trimmed) hasContext = true;
      last = j;
      indices.add(j);
    }
    ranges.push([i, last]);
    i = last;
  }
  return { indices, ranges };
}

const PEM_HINT_RE = /PRIVATE KEY|^\s*-----|^\s*[A-Za-z0-9+/=]+\s*$|^\s*(?:Proc-Type|DEK-Info|Comment|Version|Hash|Charset)\s*:/i;
const PEM_UNWRAPPED_MARKER_RE = /PRIVATE KEY|^-----|^(?:Proc-Type|DEK-Info|Comment|Version|Hash|Charset)\s*:/i;
const INLINE_BASE64_CHUNK_RE = /[A-Za-z0-9+/]{16,}={0,2}/g;

/**
 * 命中行是否「可能属于」某个多行私钥块：覆盖裸 PEM 行、带源码/YAML 引号/注释/尾随标点包裹的行，
 * 以及行内赋值/拼接中的高熵 base64 片段（如 `pem += "MIIEvQ...\n";`）；
 * 同时排除普通代码标识符、十六进制 SHA 与路径，保持 N8 剪枝收益。
 */
function mightBePemBlockLine(text) {
  const s = String(text ?? '');
  if (PEM_HINT_RE.test(s)) return true;
  const trimmed = s.trim();
  if (!trimmed) return true;
  const unwrapped = unwrapPemLine(trimmed);
  if (isPemContinuation(trimmed, unwrapped, true) || PEM_UNWRAPPED_MARKER_RE.test(unwrapped)) return true;
  INLINE_BASE64_CHUNK_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_BASE64_CHUNK_RE.exec(s)) !== null) {
    const tok = m[0];
    if (/^[A-Za-z]+$/.test(tok)) continue;
    if (looksLikeBase64Body(tok, false)) return true;
  }
  return false;
}

function getSecurityPolicy(env = process.env) {
  return {
    redactSecrets: isEnvEnabled(env, 'GITEA_REDACT_SECRETS', true),
    blockSensitivePaths: isEnvEnabled(env, 'GITEA_BLOCK_SENSITIVE_PATHS', true),
  };
}

export {
  REDACT_RULES,
  findPrivateKeyLineIndices,
  mightBePemBlockLine,
  getSecurityPolicy,
  isEnvEnabled,
  isSensitivePath,
  redactSecrets,
};
