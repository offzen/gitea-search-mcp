#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# gitea 全量镜像同步 (sync.sh)
#
# 目的：把私有 Gitea（git.example.com，全部仓在 myorg/ 名下）完整镜像到本机，
#       给 gitq / gitea-search MCP 一个「本地、可枚举、全分支」的检索面。
#       —— Gitea 服务端没开 repo indexer（app.ini 无 REPO_INDEXER_ENABLED），
#          所以网页/API 搜不到内容；镜像 + git grep 是唯一能搜全分支的路子。
#
# 用法：
#   sync.sh                 # 增量同步全部仓（新仓 clone --mirror，已有仓 remote update --prune）
#   sync.sh -q              # 安静模式（只报错和汇总），给 cron 用
#   sync.sh -j 12           # 并发度（默认 6）
#   sync.sh -r incidents    # 只同步指定仓（可重复给）
#   sync.sh --list          # 只列出源上的仓名，不下载
#
# 并发与退出码（v2.0.3）：
#   全局锁 $ROOT/state/sync.lock（flock；无 flock 时 mkdir 锁）——另一轮同步进行中则退出 75（SYNC_BUSY），
#   cron 不再需要外层 flock；0=全部成功；1=有仓失败/索引失败；2=参数/配置错误；75=同步忙。
#   远端空仓库（本地镜像也从未有过任何对象）视为成功，首次提交后下一轮自动纳入检索；
#   已有历史的镜像遇到远端被清空仍 fail closed。GITQ_EMPTY_REMOTE=fail 恢复「空远端一律失败」。
#   索引输出写入 $ROOT/state/index-last.log。
#
# 环境变量覆盖：GITEA_MIRROR_ROOT (或 GITQ_MIRROR_ROOT) / GITEA_OWNERS (或 GITQ_OWNER) /
#              GITQ_REMOTE / GITQ_JOBS / GITQ_ENUM(auto|api|ssh) /
#              GITQ_TRANSPORT(auto|ssh|https) / GITEA_TOKEN (或 GITQ_API_TOKEN) /
#              GITEA_URL (或 GITQ_API_BASE) / GITQ_SSH_HOST …
# 通用性：token 与 ssh 只需其一——枚举 auto 会 api→ssh 两路试；克隆 auto 先 ssh、
#         ssh 失败且有 token 时该仓改走 https（详见下方 GITQ_TRANSPORT 注释）。
#
# 状态文件：
#   $ROOT/state/last_status   每轮都写：time/host/ok/fail/total/dur/degraded/enum_source/cache_stale
#   $ROOT/state/last_ok       只在本轮全成功时刷新 ⇒ 巡检按它断言新鲜度（maxAgeHours）
#   $ROOT/last_sync           每轮刷新（保留兼容）
#   $ROOT/state/repos.cache   最近一次成功枚举的仓名（api/ssh 任一成功即刷新），
#                             供下次不可达时救急；超 $GITQ_CACHE_MAXAGE_H 标 cache_stale=1
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT=${GITEA_MIRROR_ROOT:-${GITEA_MIRROR_PATH:-${GITQ_MIRROR_ROOT:-/srv/gitea-mirror}}}
RAW_OWNER=${GITEA_OWNERS:-${GITEA_OWNER:-${GITQ_OWNER:-myorg}}}
OWNER=$RAW_OWNER
REMOTE=${GITEA_REMOTE:-${GITQ_REMOTE:-gitea}}          # ~/.ssh/config 里的 ssh 别名
JOBS=${GITQ_JOBS:-6}
# 枚举源：
#   GITQ_ENUM=auto    → 先 api（有 token 就试，兼容 User 与 Org 端点）再 ssh（若配置了 GITQ_SSH_HOST）；任一成功即用
#   GITQ_ENUM=api     → 只走 Gitea HTTP API（需 GITEA_TOKEN / GITQ_API_TOKEN）
#   GITQ_ENUM=ssh     → 只走 ssh 管理端目录枚举（需配置 GITQ_SSH_HOST）
#   两路都失败 → 用缓存（state/repos.cache，若在 GITQ_CACHE_MAXAGE_H 内）→ 再退本地镜像目录
ENUM=${GITQ_ENUM:-auto}
API_BASE=${GITEA_URL:-${GITEA_API_BASE:-${GITQ_API_BASE:-https://git.example.com}}}
API_BASE=${API_BASE%/}
API_TOKEN=${GITEA_TOKEN:-${GITEA_API_TOKEN:-${GITQ_API_TOKEN:-}}}
if [ -z "$API_TOKEN" ]; then
  for _tf in "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.sync-token" "/srv/gitea-tool/.sync-token" "$ROOT/.sync-token"; do
    if [ -s "$_tf" ]; then
      API_TOKEN=$(tr -d '\r\n ' < "$_tf" 2>/dev/null || true)
      break
    fi
  done
fi
SSH_ADMIN_HOST=${GITEA_SSH_HOST:-${GITQ_SSH_HOST:-}}
SSH_REPO_ROOT=${GITEA_SSH_REPO_ROOT:-${GITQ_SSH_REPO_ROOT:-/srv/git/repositories}}
SSH_GITEA_CONTAINER=${GITEA_SSH_CONTAINER:-${GITQ_SSH_CONTAINER:-}}
# 克隆/更新通道（token OR ssh 通用性）：
#   GITQ_TRANSPORT=auto  → 默认：有 ssh 别名用 ssh；仅当本轮 ssh 克隆失败且有 token 时，该仓改走 https
#   GITQ_TRANSPORT=ssh   → 强制 ssh（$REMOTE:$OWNER/x.git）
#   GITQ_TRANSPORT=https → 强制 https（用 $API_TOKEN 作密码：https://<user>:<token>@host/...）
#   —— token 与 ssh 只需其一即可完成镜像（https 只要 token，ssh 只要私钥）。
TRANSPORT=${GITQ_TRANSPORT:-auto}
GIT_USER=${GITQ_GIT_USER:-git}           # https 通道的 Gitea 用户名（一般就是 git）

# 解析 HTTP(S) URL 为规范化 origin（小写 scheme://host[:port]，去掉默认端口与 userinfo）和路径前缀。
# 兼容 Bash 3.2：不使用 ${var,,}。
_parse_http_url_origin() {
  local raw="$1" rest scheme auth hostport host port path_part
  case "$raw" in
    [Hh][Tt][Tt][Pp]://*)
      scheme="http"
      rest="${raw#*://}"
      ;;
    [Hh][Tt][Tt][Pp][Ss]://*)
      scheme="https"
      rest="${raw#*://}"
      ;;
    *) return 1 ;;
  esac
  auth="${rest%%/*}"
  auth="${auth%%\?*}"
  auth="${auth%%#*}"
  hostport="${auth##*@}"
  hostport=$(printf '%s' "$hostport" | tr 'A-Z' 'a-z')
  [ -n "$hostport" ] || return 1
  if [ "$scheme" = "https" ]; then
    hostport="${hostport%:443}"
  elif [ "$scheme" = "http" ]; then
    hostport="${hostport%:80}"
  fi
  case "$rest" in
    */*)
      path_part="/${rest#*/}"
      path_part="${path_part%%\?*}"
      path_part="${path_part%%#*}"
      ;;
    *) path_part="" ;;
  esac
  printf '%s://%s\t%s\n' "$scheme" "$hostport" "$path_part"
}

EXPECTED_AUTH_ORIGIN=""
EXPECTED_AUTH_PATH_PREFIX=""
if _parsed_api=$(_parse_http_url_origin "$API_BASE"); then
  EXPECTED_AUTH_ORIGIN="${_parsed_api%%	*}"
  EXPECTED_AUTH_PATH_PREFIX="${_parsed_api#*	}"
  while [ "${EXPECTED_AUTH_PATH_PREFIX%/}" != "$EXPECTED_AUTH_PATH_PREFIX" ]; do
    EXPECTED_AUTH_PATH_PREFIX="${EXPECTED_AUTH_PATH_PREFIX%/}"
  done
fi
if [ -n "$EXPECTED_AUTH_ORIGIN" ]; then
  CACHE_SCOPE_API="${EXPECTED_AUTH_ORIGIN}${EXPECTED_AUTH_PATH_PREFIX}"
else
  CACHE_SCOPE_API="$API_BASE"
fi
_cache_slug=$(printf '%s' "${CACHE_SCOPE_API#*://}_${OWNER}" | tr -cs 'A-Za-z0-9._-' '_' | sed 's/^_//;s/_$//')
if [ -n "$EXPECTED_AUTH_PATH_PREFIX" ] && command -v cksum >/dev/null 2>&1; then
  _cache_hash=$(printf '%s' "${CACHE_SCOPE_API}|${OWNER}" | cksum | awk '{print $1}')
  _cache_slug="${_cache_slug}_${_cache_hash}"
fi
[ -n "$_cache_slug" ] || _cache_slug="default"
CACHE_FILE=${GITQ_REPOS_CACHE:-$ROOT/state/repos.${_cache_slug}.cache}
CACHE_MAXAGE_H=${GITQ_CACHE_MAXAGE_H:-24}   # 缓存仓名列表最长可用小时数（超期只用于救急）
LOG=$ROOT/sync.log
HOST=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)
export GIT_TERMINAL_PROMPT=0
# 固定 ssh 连接超时，避免远端半死不活时拖慢整轮同步。
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"

QUIET=0; LIST_ONLY=0; ONLY=(); DEGRADED=0
repos=()
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--quiet) QUIET=1; shift ;;
    -j|--jobs)  JOBS=${2:?-j 需要一个数字}; shift 2 ;;
    -r|--repo)  ONLY+=("${2:?-r 需要一个仓名}"); shift 2 ;;
    --list|--list-only) LIST_ONLY=1; shift ;;
    -h|--help)  sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（-h 看用法）" >&2; exit 2 ;;
  esac
done

case "$RAW_OWNER" in
  *,*)
    echo "CONFIG_ERROR: sync.sh currently supports exactly one owner; sync each owner separately." >&2
    exit 2
    ;;
esac

# 兼容 bash 3.2（macOS 自带）：无 mapfile
_fill_repos() { repos=(); while IFS= read -r _lr; do [ -n "$_lr" ] && repos+=("$_lr"); done; }
# 审计 #6：统一超时包装 —— GNU timeout 默认会另建进程组（导致 MCP 取消时 kill(-gts_pid) 漏杀 git），
# 因此在首次调用 `_run_timeout` 时按需探测 GNU timeout `--foreground`（避免 --list-only API 枚举误触外部 timeout）；
# 支持时传入 `--foreground -k 5` 让 git 留在宿主进程组；不支持或无 GNU timeout（如 macOS）时使用同进程组软超时封装。
# 注意：watcher 子 shell 必须重定向 >/dev/null 2>&1 </dev/null 并在 trap 中终止内部 sleep，
# 否则在命令替换中 sleep 会继承 stdout 管道写端导致死等。
_shell_timeout() {
  local secs="$1"; shift
  "$@" <&0 &
  local pid=$!
  (
    trap 'kill -TERM "$spid" 2>/dev/null || true; exit 0' TERM INT
    sleep "$secs" >/dev/null 2>&1 &
    spid=$!
    if wait "$spid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2 >/dev/null 2>&1 || true
      kill -9 "$pid" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 </dev/null &
  local watcher=$!
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill -TERM "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return $rc
}
export -f _shell_timeout
if ! command -v timeout >/dev/null 2>&1; then
  timeout() {
    local secs="$1"; shift
    "$@" <&0 &
    local pid=$!
    (
      trap 'kill -TERM "$spid" 2>/dev/null || true; exit 0' TERM INT
      sleep "$secs" >/dev/null 2>&1 &
      spid=$!
      if wait "$spid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        sleep 2 >/dev/null 2>&1 || true
        kill -9 "$pid" 2>/dev/null || true
      fi
    ) >/dev/null 2>&1 </dev/null &
    local watcher=$!
    local rc=0
    wait "$pid" 2>/dev/null || rc=$?
    kill -TERM "$watcher" 2>/dev/null || true
    wait "$watcher" 2>/dev/null || true
    return $rc
  }
  export -f timeout
fi
_run_timeout() {
  local secs="$1"; shift
  if [ -z "${_TIMEOUT_MODE:-}" ]; then
    if command -v timeout >/dev/null 2>&1 && command timeout --foreground 1 true >/dev/null 2>&1; then
      _TIMEOUT_MODE="gnu_fg"
    else
      _TIMEOUT_MODE="shell"
    fi
  fi
  if [ "$_TIMEOUT_MODE" = "gnu_fg" ]; then
    command timeout --foreground -k 5 "$secs" "$@"
  else
    _shell_timeout "$secs" "$@"
  fi
}
export -f _run_timeout
say() { [ "$QUIET" = 1 ] || echo "$@"; }
log() { echo "$(date '+%F %T') [$HOST] $*" >> "$LOG"; }

# ── 1) 枚举仓名 ──────────────────────────────────────────────────────────────
# 权威来源两个，任一可用即可（token 与 ssh 通用性）：
#   api → Gitea HTTP API（支持 /api/v1/users/$OWNER/repos 与 /api/v1/orgs/$OWNER/repos）
#   ssh → 可选 ssh 管理端枚举仓库目录（需显式配置 GITQ_SSH_HOST）
# 缓存 = 最近一次成功枚举（任一来源），供本次不可达时救急（可能过期，见 cache_stale）。
ENUM_SOURCE=""        # 本轮实际用的来源：api / ssh / cache / disk / (empty=未枚举)
CACHE_STALE=0         # 1 = 用的是过期缓存救急
_fetch_gitea_endpoint_repos() {
  local ep="$1" page=1 n=0 out name has_wiki emitted=0 tmp prev_sig="" page_sig="" tmp_dir
  if [ -d "$ROOT" ] && [ -w "$ROOT" ]; then
    tmp_dir="$ROOT"
  else
    tmp_dir="${TMPDIR:-/tmp}"
  fi
  tmp=$(mktemp "$tmp_dir/.enum.api.XXXXXX") || return 1
  while :; do
    if [ -n "$API_TOKEN" ]; then
      # Use a here-string (not `printf ... | curl`) so `set -o pipefail` never fails with SIGPIPE (141)
      # when curl exits before draining stdin, while still keeping API_TOKEN out of process argv.
      out=$(curl -fsS --connect-timeout 8 --max-time 30 -H @- \
          "$API_BASE/api/v1/$ep?limit=50&page=$page" \
          <<< "Authorization: token $API_TOKEN" 2>/dev/null) || {
        rm -f "$tmp"
        return 1
      }
    else
      out=$(curl -fsS --connect-timeout 8 --max-time 30 \
          "$API_BASE/api/v1/$ep?limit=50&page=$page" 2>/dev/null) || {
        rm -f "$tmp"
        return 1
      }
    fi
    n=$(printf '%s' "$out" | jq 'if type=="array" then length else 0 end' 2>/dev/null || echo 0)
    [ "${n:-0}" -eq 0 ] && break
    # 服务端若忽略 page 参数会一直返回同一页：与上一页内容相同即视为翻完。
    page_sig=$(printf '%s' "$out" | jq -r '[.[].name] | join(",")' 2>/dev/null || echo "")
    [ -n "$prev_sig" ] && [ "$page_sig" = "$prev_sig" ] && break
    prev_sig=$page_sig
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      printf '%s\n' "$name" >> "$tmp"
      emitted=$((emitted + 1))
      has_wiki=$(printf '%s' "$out" | jq -r --arg n "$name" '.[] | select(.name==$n) | .has_wiki // false' | head -1)
      [ "$has_wiki" = "true" ] && printf '%s.wiki\n' "$name" >> "$tmp"
    done < <(printf '%s' "$out" | jq -r '.[].name')
    # 2.0.3：不再假设「本页不足 50 条即末页」（服务端 MAX_RESPONSE_ITEMS 可被调小，旧逻辑会静默截断枚举）；
    # 一直翻到空页为止，并设 200 页（1 万仓）硬上限防止服务端忽略 page 参数时死循环。
    page=$((page + 1))
    [ "$page" -gt 200 ] && break
  done
  if [ "$emitted" -gt 0 ]; then
    cat "$tmp"
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}
list_from_gitea_api() {
  # 标准 Gitea 兼容：OWNER 既可能是 User（/users/$OWNER/repos），也可能是 Organization（/orgs/$OWNER/repos）。
  # .wiki 仓 API 不单独列出，按 repo 的 has_wiki 字段自动推导补齐。
  [ -n "$API_TOKEN" ] || [ "$ENUM" = "api" ] || return 1
  local got=""
  if ! got=$(_fetch_gitea_endpoint_repos "users/$OWNER/repos" 2>/dev/null); then
    got=""
  fi
  if [ -z "$got" ]; then
    if ! got=$(_fetch_gitea_endpoint_repos "orgs/$OWNER/repos" 2>/dev/null); then
      got=""
    fi
  fi
  [ -n "$got" ] || return 1
  printf '%s\n' "$got" | awk '!seen[$0]++'
}
list_from_gitea_ssh() {
  [ -n "$SSH_ADMIN_HOST" ] || return 1
  local remote_cmd
  if [ -n "$SSH_GITEA_CONTAINER" ]; then
    remote_cmd="docker exec $SSH_GITEA_CONTAINER sh -c 'ls -d $SSH_REPO_ROOT/$OWNER/*.git'"
  else
    remote_cmd="ls -d $SSH_REPO_ROOT/$OWNER/*.git"
  fi
  _run_timeout 30 ssh -o ConnectTimeout=8 -o BatchMode=yes "$SSH_ADMIN_HOST" "$remote_cmd" 2>/dev/null \
    | sed -e 's#.*/##' -e 's#\.git$##' | grep -v '^[[:space:]]*$'
}
list_from_cache() {
  [ -f "$CACHE_FILE" ] || return 1
  local header
  header=$(head -n 1 "$CACHE_FILE" 2>/dev/null || true)
  # 审计 #12：仅接受显式声明且与当前 owner + forge origin 一致的缓存；
  # 旧版无归属头或其它 owner/forge 的缓存一律拒绝，由调用方退回当前 owner 的磁盘清单。
  case "$header" in
    "# gitea repos cache; owner=${OWNER}; api=${CACHE_SCOPE_API};"*) ;;
    *) return 1 ;;
  esac
  grep -v '^#' "$CACHE_FILE" 2>/dev/null | grep -v '^[[:space:]]*$'
}
list_from_disk() {
  ls -d "$ROOT/$OWNER"/*.git 2>/dev/null | sed -e 's#.*/##' -e 's#\.git$##'
}
# 尝试一个枚举来源；成功（≥1 行）则把仓名填进全局数组 repos、记 ENUM_SOURCE、刷新缓存并返回 0。
try_enum() {
  local fn=$1 label=$2 got
  got=$("$fn" 2>/dev/null)
  [ -n "$got" ] || return 1
  _fill_repos <<< "$got"
  [ ${#repos[@]} -gt 0 ] || return 1
  ENUM_SOURCE=$label
  if [ "$label" = api ] || [ "$label" = ssh ]; then
    local cache_dir tmp_cache
    cache_dir=$(dirname "$CACHE_FILE")
    mkdir -p "$cache_dir" 2>/dev/null || true
    tmp_cache=$(mktemp "$cache_dir/.repos.cache.XXXXXX" 2>/dev/null || true)
    if [ -n "$tmp_cache" ]; then
      if { echo "# gitea repos cache; owner=${OWNER}; api=${CACHE_SCOPE_API}; source=$label; at=$(date '+%F %T')"; printf '%s\n' "$got"; } \
        > "$tmp_cache" 2>/dev/null; then
        mv -f "$tmp_cache" "$CACHE_FILE" 2>/dev/null || rm -f "$tmp_cache"
      else
        rm -f "$tmp_cache"
      fi
    fi
    CACHE_STALE=0
  fi
  return 0
}
# 按 GITQ_ENUM 决定尝试顺序，成功则把仓名写入全局数组 repos。
resolve_repos() {
  local order=()
  case "$ENUM" in
    api) order=(api) ;;
    ssh) order=(ssh) ;;
    *)   order=(api ssh) ;;   # auto：先 api（有 token 才试）再 ssh
  esac
  for src in "${order[@]}"; do
    case "$src" in
      api) try_enum list_from_gitea_api api && return 0 ;;
      ssh) try_enum list_from_gitea_ssh ssh && return 0 ;;
    esac
  done
  # 两路都不可达 → 先试缓存（救急），再退本地磁盘
  if try_enum list_from_cache cache; then
    local age_h c_mtime
    c_mtime=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || stat -f %m "$CACHE_FILE" 2>/dev/null || echo 0)
    age_h=$(awk -v m="$c_mtime" -v now="$(date +%s)" 'BEGIN{printf "%d",(now-m)/3600}' 2>/dev/null)
    age_h=${age_h:-0}
    if [ "$age_h" -gt "$CACHE_MAXAGE_H" ]; then
      CACHE_STALE=1
      say "!! 枚举源不可达，用的是 ${age_h}h 前的缓存（超 ${CACHE_MAXAGE_H}h，可能漏新仓）"
    else
      say "!! 枚举源不可达，用的是 ${age_h}h 前的缓存（可能漏新仓）"
    fi
    log "WARN 枚举降级：用缓存(age=${age_h}h stale=$CACHE_STALE)"
    DEGRADED=1
    return 0
  fi
  if [ "$ENUM" = auto ]; then
    say "!! 无法枚举 Gitea 仓库（api/ssh 均不可达），退回本地镜像目录（新仓不会被发现）"
  else
    say "!! 无法枚举 Gitea 仓库（GITQ_ENUM=$ENUM 不可达），退回本地镜像目录（新仓不会被发现）"
  fi
  log "WARN 枚举失败，退回本地镜像目录"
  DEGRADED=1
  ENUM_SOURCE=disk
  _fill_repos <<< "$(list_from_disk)"
  [ ${#repos[@]} -gt 0 ]
}

# 审计 #10：非 --list 模式下在枚举之前就建立镜像根与 owner/state 目录并验证可写，
# 避免纯 API 首次同步时因为 $ROOT 尚未创建导致枚举阶段 mktemp 失败而误报「没有可同步的仓」。
if [ "$LIST_ONLY" != 1 ]; then
  if ! mkdir -p "$ROOT/$OWNER" "$ROOT/state" 2>/dev/null || [ ! -w "$ROOT" ] || [ ! -w "$ROOT/$OWNER" ]; then
    echo "MIRROR_ROOT_NOT_WRITABLE: 无法创建或写入镜像目录 ${ROOT}/${OWNER}" >&2
    exit 1
  fi
fi

if [ ${#ONLY[@]} -gt 0 ]; then
  repos=("${ONLY[@]}")
  ENUM_SOURCE=only
elif [ "$LIST_ONLY" = 1 ]; then
  resolve_repos || _fill_repos <<< "$(list_from_disk)"
  printf '%s\n' "${repos[@]+"${repos[@]}"}"
  exit 0
else
  if ! resolve_repos; then
    _fill_repos <<< "$(list_from_disk)"
  fi
fi
[ ${#repos[@]} -eq 0 ] && { echo "没有可同步的仓" >&2; exit 1; }

# ── 全局同步锁（2.0.3）──────────────────────────────────────────────────────
# cron 与 MCP `sync:true`（gts --sync）、或多个 agent 同时触发时，两轮同步会在同一批仓库上并发
# `git remote update`，并让后到的索引构建撞 IndexLock 而被记成「假失败」。抢不到锁即退出 75（SYNC_BUSY），
# 由调用方决定沿用当前镜像继续检索。
# 锁优先级：1) flock(1)；2) python3 fcntl.flock（同 fd 9 语义，进程退出自动释放）；
#          3) 加固后的 mkdir 目录锁（初始化窗口视作忙、校验归属后再回收/退出清理）。
SYNC_LOCK_DIR_HELD=""
SYNC_RECLAIM_DIR_HELD=""
SYNC_TAKEOVER_DIR_HELD=""
SYNC_LOCK_OWNER="$$:$(date +%s 2>/dev/null || echo 0):$RANDOM:$RANDOM"
_release_sync_takeover_dir() {
  if [ -n "$SYNC_TAKEOVER_DIR_HELD" ]; then
    local _cur_takeover
    _cur_takeover=$(cat "$SYNC_TAKEOVER_DIR_HELD/owner" 2>/dev/null || true)
    if [ "$_cur_takeover" = "$SYNC_LOCK_OWNER" ]; then
      rm -rf "$SYNC_TAKEOVER_DIR_HELD"
    fi
    SYNC_TAKEOVER_DIR_HELD=""
  fi
}
_release_sync_lock_dir() {
  if [ -n "${SYNC_RECLAIM_DIR_HELD:-}" ]; then
    local _cur_reclaim
    _cur_reclaim=$(cat "$SYNC_RECLAIM_DIR_HELD/owner" 2>/dev/null || true)
    if [ "$_cur_reclaim" = "$SYNC_LOCK_OWNER" ]; then
      rm -rf "$SYNC_RECLAIM_DIR_HELD"
    fi
    SYNC_RECLAIM_DIR_HELD=""
  fi
  if [ -n "${SYNC_LOCK_DIR_HELD:-}" ]; then
    local _cur_owner
    _cur_owner=$(cat "$SYNC_LOCK_DIR_HELD/owner" 2>/dev/null || true)
    if [ "$_cur_owner" = "$SYNC_LOCK_OWNER" ]; then
      rm -rf "$SYNC_LOCK_DIR_HELD"
    fi
    SYNC_LOCK_DIR_HELD=""
  fi
  _release_sync_takeover_dir
}
trap '_release_sync_lock_dir' EXIT
mkdir -p "$ROOT/state" 2>/dev/null || true
_lock_acquired=0
if command -v flock >/dev/null 2>&1; then
  exec 9>"$ROOT/state/sync.lock" || { echo "SYNC_LOCK_FAILED: 无法创建同步锁 $ROOT/state/sync.lock" >&2; exit 1; }
  if ! flock -n 9; then
    echo "SYNC_BUSY: 另一轮同步正在进行（锁 ${ROOT}/state/sync.lock），本次不重复执行" >&2
    exit 75
  fi
  _lock_acquired=1
elif command -v perl >/dev/null 2>&1; then
  exec 9>"$ROOT/state/sync.lock" || { echo "SYNC_LOCK_FAILED: 无法创建同步锁 $ROOT/state/sync.lock" >&2; exit 1; }
  _perl_lock_res=$(perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX|LOCK_NB) or do { print "FLOCK_BUSY\n"; exit 75 }; print "FLOCK_OK\n"' 2>/dev/null)
  _perl_lock_rc=$?
  if [ "$_perl_lock_res" = "FLOCK_BUSY" ] || [ "$_perl_lock_rc" -eq 75 ]; then
    echo "SYNC_BUSY: 另一轮同步正在进行（锁 ${ROOT}/state/sync.lock），本次不重复执行" >&2
    exit 75
  elif [ "$_perl_lock_res" = "FLOCK_OK" ]; then
    _lock_acquired=1
  fi
fi
if [ "$_lock_acquired" -ne 1 ] && command -v python3 >/dev/null 2>&1; then
  exec 9>"$ROOT/state/sync.lock" || { echo "SYNC_LOCK_FAILED: 无法创建同步锁 $ROOT/state/sync.lock" >&2; exit 1; }
  _py_lock_res=$(python3 -c '
import fcntl, sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("FLOCK_OK")
except BlockingIOError:
    print("FLOCK_BUSY")
    sys.exit(75)
' 2>/dev/null)
  _py_lock_rc=$?
  if [ "$_py_lock_res" = "FLOCK_BUSY" ] || [ "$_py_lock_rc" -eq 75 ]; then
    echo "SYNC_BUSY: 另一轮同步正在进行（锁 ${ROOT}/state/sync.lock），本次不重复执行" >&2
    exit 75
  elif [ "$_py_lock_res" = "FLOCK_OK" ]; then
    _lock_acquired=1
  fi
fi
if [ "$_lock_acquired" -ne 1 ]; then
  _lock_dir="$ROOT/state/sync.lock.d"
  _reclaim_dir="${_lock_dir}.reclaim"
  _lock_grace_s=15
  _lock_is_live_or_init() {
    local _d="$1" _p _m _now
    [ -d "$_d" ] || return 1
    _p=$(cat "$_d/pid" 2>/dev/null || true)
    case "$_p" in
      ''|*[!0-9]*|0) ;;
      *)
        if kill -0 "$_p" 2>/dev/null; then
          return 0
        fi
        ;;
    esac
    if [ -z "$_p" ]; then
      _m=$(stat -c %Y "$_d" 2>/dev/null || stat -f %m "$_d" 2>/dev/null || echo 0)
      _now=$(date +%s 2>/dev/null || echo 0)
      if [ "${_m:-0}" -gt 0 ] && [ $(( _now - _m )) -lt "$_lock_grace_s" ]; then
        return 0
      fi
    fi
    return 1
  }
  _parse_takeover_gen() {
    local _suf="$1"
    case "$_suf" in
      ''|*[!0-9]*) return 1 ;;
    esac
    _suf="${_suf#"${_suf%%[!0]*}"}"
    printf '%s\n' "${_suf:-0}"
  }
  _cleanup_orphan_takeover_dirs() {
    local _skip_base="${1:-}" _cand
    for _cand in "${_reclaim_dir}.takeover."*; do
      [ -d "$_cand" ] || continue
      [ "$_cand" = "$SYNC_TAKEOVER_DIR_HELD" ] && continue
      if [ -n "$_skip_base" ]; then
        case "$_cand" in
          "$_skip_base"|"$_skip_base".*) continue ;;
        esac
      fi
      if ! _lock_is_live_or_init "$_cand"; then
        rm -rf "$_cand"
      fi
    done
  }
  _reclaim_instance_token() {
    local _owner _identity
    [ -d "$_reclaim_dir" ] || return 1
    _owner=$(cat "$_reclaim_dir/owner" 2>/dev/null || true)
    if [ -n "$_owner" ]; then
      printf '%s\n' "${_owner//[^a-zA-Z0-9_.-]/_}"
    else
      _identity=$(stat -c '%i-%Y' "$_reclaim_dir" 2>/dev/null || stat -f '%i-%m' "$_reclaim_dir" 2>/dev/null) || return 1
      printf 'noowner-%s\n' "$_identity"
    fi
  }
  if mkdir "$_lock_dir" 2>/dev/null; then
    if [ -n "${GITQ_TEST_LOCK_PAUSE_FILE:-}" ]; then
      # 测试用受控屏障（仅当显式设置且目录锁路径生效时触发）
      _wait_i=0
      while [ -f "$GITQ_TEST_LOCK_PAUSE_FILE" ] && [ "$_wait_i" -lt 100 ]; do
        sleep 0.05
        _wait_i=$((_wait_i + 1))
      done
    fi
    if ! printf '%s\n' "$$" > "$_lock_dir/.pid.$$" ||
       ! mv -f "$_lock_dir/.pid.$$" "$_lock_dir/pid" ||
       ! printf '%s\n' "$SYNC_LOCK_OWNER" > "$_lock_dir/.owner.$$" ||
       ! mv -f "$_lock_dir/.owner.$$" "$_lock_dir/owner"; then
      rm -rf "$_lock_dir"
      echo "SYNC_BUSY: 无法初始化同步锁" >&2
      exit 75
    fi
    SYNC_LOCK_DIR_HELD="$_lock_dir"
    if [ ! -d "$_reclaim_dir" ]; then
      _cleanup_orphan_takeover_dirs
    fi
  else
    if _lock_is_live_or_init "$_lock_dir"; then
      echo "SYNC_BUSY: 另一轮同步正在进行或初始化锁（${_lock_dir}），本次不重复执行" >&2
      exit 75
    fi
    if [ -n "${GITQ_TEST_RECLAIM_PAUSE_FILE:-}" ]; then
      # 测试用受控屏障：让多个竞争者在都观察到同一陈旧锁后同步起跑
      [ -n "${GITQ_TEST_RECLAIM_READY_DIR:-}" ] && : > "${GITQ_TEST_RECLAIM_READY_DIR}/ready.$$"
      _wait_i=0
      while [ -f "$GITQ_TEST_RECLAIM_PAUSE_FILE" ] && [ "$_wait_i" -lt 200 ]; do
        sleep 0.05
        _wait_i=$((_wait_i + 1))
      done
    fi
    # 审计 #13：用独立的 .reclaim 原子目录锁串行化陈旧锁回收，并在拿到回收权后重新核对持有者，
    # 防止两个同时观察到死锁的同步者先后按固定路径 mv 移走对方刚建立的新锁。
    _takeover_base=""
    _takeover_gen=0
    if ! mkdir "$_reclaim_dir" 2>/dev/null; then
      _reclaim_token=$(_reclaim_instance_token) || _reclaim_token=""
      if [ -z "$_reclaim_token" ] || _lock_is_live_or_init "$_reclaim_dir"; then
        echo "SYNC_BUSY: 另一轮同步正在回收同步锁，本次不重复执行" >&2
        exit 75
      fi
      if [ -n "${GITQ_TEST_RECLAIM_STALE_PAUSE_FILE:-}" ]; then
        [ -n "${GITQ_TEST_RECLAIM_STALE_READY_DIR:-}" ] && : > "${GITQ_TEST_RECLAIM_STALE_READY_DIR}/ready.$$"
        _wait_i=0
        while [ -f "$GITQ_TEST_RECLAIM_STALE_PAUSE_FILE" ] && [ "$_wait_i" -lt 200 ]; do
          sleep 0.05
          _wait_i=$((_wait_i + 1))
        done
      fi
      _takeover_base="${_reclaim_dir}.takeover.${_reclaim_token}"
      _takeover_gen=0
      _takeover_has_existing=0
      for _cand in "$_takeover_base" "$_takeover_base".*; do
        [ -d "$_cand" ] || continue
        if [ "$_cand" = "$_takeover_base" ]; then
          _cand_gen=0
        else
          _cand_suf="${_cand#"$_takeover_base".}"
          _cand_gen=$(_parse_takeover_gen "$_cand_suf") || continue
        fi
        if _lock_is_live_or_init "$_cand"; then
          echo "SYNC_BUSY: 另一轮同步正在接管回收锁（${_cand}），本次不重复执行" >&2
          exit 75
        fi
        _takeover_has_existing=1
        if [ "$_cand_gen" -ge "$_takeover_gen" ]; then
          _takeover_gen=$((_cand_gen + 1))
        fi
      done
      if [ "$_takeover_has_existing" -eq 0 ]; then
        _takeover_dir="$_takeover_base"
      else
        _takeover_dir="${_takeover_base}.${_takeover_gen}"
      fi
      if [ -n "${GITQ_TEST_TAKEOVER_STALE_PAUSE_FILE:-}" ]; then
        [ -n "${GITQ_TEST_TAKEOVER_STALE_READY_DIR:-}" ] && : > "${GITQ_TEST_TAKEOVER_STALE_READY_DIR}/ready.$$"
        _wait_i=0
        while [ -f "$GITQ_TEST_TAKEOVER_STALE_PAUSE_FILE" ] && [ "$_wait_i" -lt 200 ]; do
          sleep 0.05
          _wait_i=$((_wait_i + 1))
        done
      fi
      if ! mkdir "$_takeover_dir" 2>/dev/null; then
        echo "SYNC_BUSY: 无法独占回收锁实例（${_takeover_dir}）" >&2
        exit 75
      fi
      if ! printf '%s\n' "$$" > "$_takeover_dir/.pid.$$" ||
         ! mv -f "$_takeover_dir/.pid.$$" "$_takeover_dir/pid" ||
         ! printf '%s\n' "$SYNC_LOCK_OWNER" > "$_takeover_dir/.owner.$$" ||
         ! mv -f "$_takeover_dir/.owner.$$" "$_takeover_dir/owner"; then
        rm -rf "$_takeover_dir"
        echo "SYNC_BUSY: 无法初始化回收接管锁" >&2
        exit 75
      fi
      SYNC_TAKEOVER_DIR_HELD="$_takeover_dir"
      for _cand in "$_takeover_base" "$_takeover_base".*; do
        [ -d "$_cand" ] || continue
        [ "$_cand" = "$_takeover_dir" ] && continue
        if [ "$_cand" = "$_takeover_base" ]; then
          _cand_gen=0
        else
          _cand_suf="${_cand#"$_takeover_base".}"
          _cand_gen=$(_parse_takeover_gen "$_cand_suf") || continue
        fi
        if [ "$_cand_gen" -gt "$_takeover_gen" ] || _lock_is_live_or_init "$_cand"; then
          echo "SYNC_BUSY: 回收锁接管权已被其它同步者取得，本次不重复执行" >&2
          exit 75
        fi
      done
      if _lock_is_live_or_init "$_reclaim_dir" || [ "$(_reclaim_instance_token)" != "$_reclaim_token" ]; then
        echo "SYNC_BUSY: 回收锁实例已变化，本次不重复执行" >&2
        exit 75
      fi
      _stale_reclaim="${_reclaim_dir}.stale.$$"
      if ! mv "$_reclaim_dir" "$_stale_reclaim" 2>/dev/null; then
        echo "SYNC_BUSY: 另一轮同步正在回收同步锁，本次不重复执行" >&2
        exit 75
      fi
      rm -rf "$_stale_reclaim"
      mkdir "$_reclaim_dir" 2>/dev/null || { echo "SYNC_BUSY: 无法获取回收锁" >&2; exit 75; }
    fi
    if ! printf '%s\n' "$SYNC_LOCK_OWNER" > "$_reclaim_dir/.owner.$$" ||
       ! mv -f "$_reclaim_dir/.owner.$$" "$_reclaim_dir/owner" ||
       ! printf '%s\n' "$$" > "$_reclaim_dir/.pid.$$" ||
       ! mv -f "$_reclaim_dir/.pid.$$" "$_reclaim_dir/pid"; then
      rm -rf "$_reclaim_dir"
      SYNC_RECLAIM_DIR_HELD=""
      echo "SYNC_BUSY: 无法初始化回收锁" >&2
      exit 75
    fi
    SYNC_RECLAIM_DIR_HELD="$_reclaim_dir"
    if [ -n "$_takeover_base" ]; then
      for _cand in "$_takeover_base" "$_takeover_base".*; do
        [ -d "$_cand" ] || continue
        [ "$_cand" = "$SYNC_TAKEOVER_DIR_HELD" ] && continue
        if [ "$_cand" = "$_takeover_base" ]; then
          _cand_gen=0
        else
          _cand_suf="${_cand#"$_takeover_base".}"
          _cand_gen=$(_parse_takeover_gen "$_cand_suf") || continue
        fi
        if [ "$_cand_gen" -lt "$_takeover_gen" ] && ! _lock_is_live_or_init "$_cand"; then
          rm -rf "$_cand"
        fi
      done
    fi
    _cleanup_orphan_takeover_dirs "$_takeover_base"
    _release_sync_takeover_dir
    if _lock_is_live_or_init "$_lock_dir"; then
      rm -rf "$_reclaim_dir"
      SYNC_RECLAIM_DIR_HELD=""
      echo "SYNC_BUSY: 同步锁已被其它同步者接管，本次不重复执行" >&2
      exit 75
    fi
    if [ -d "$_lock_dir" ]; then
      _stale_dir="${_lock_dir}.stale.$$"
      if ! mv "$_lock_dir" "$_stale_dir" 2>/dev/null; then
        rm -rf "$_reclaim_dir"
        SYNC_RECLAIM_DIR_HELD=""
        echo "SYNC_BUSY: 无法回收同步锁（其它同步者已接管）" >&2
        exit 75
      fi
      rm -rf "$_stale_dir"
    fi
    if ! mkdir "$_lock_dir" 2>/dev/null; then
      rm -rf "$_reclaim_dir"
      SYNC_RECLAIM_DIR_HELD=""
      echo "SYNC_BUSY: 无法获取同步锁" >&2
      exit 75
    fi
    if ! printf '%s\n' "$$" > "$_lock_dir/.pid.$$" ||
       ! mv -f "$_lock_dir/.pid.$$" "$_lock_dir/pid" ||
       ! printf '%s\n' "$SYNC_LOCK_OWNER" > "$_lock_dir/.owner.$$" ||
       ! mv -f "$_lock_dir/.owner.$$" "$_lock_dir/owner"; then
      rm -rf "$_lock_dir" "$_reclaim_dir"
      SYNC_RECLAIM_DIR_HELD=""
      echo "SYNC_BUSY: 无法初始化同步锁" >&2
      exit 75
    fi
    SYNC_LOCK_DIR_HELD="$_lock_dir"
    rm -rf "$_reclaim_dir"
    SYNC_RECLAIM_DIR_HELD=""
  fi
fi

_git_remote_url() {
  local d=$1 remote_name=$2 url=""
  url=$(git --git-dir="$d" remote get-url -- "$remote_name" 2>/dev/null || true)
  if [ -z "$url" ] && [ -f "$d/config" ]; then
    url=$(awk -v r="$remote_name" '
      /^\[/ { in_sec = ($0 == "[remote \"" r "\"]") }
      in_sec && /^[[:space:]]*url[[:space:]]*=/ {
        sub(/^[[:space:]]*url[[:space:]]*=[[:space:]]*/, "")
        sub(/[[:space:]]*$/, "")
        print; exit
      }
    ' "$d/config" 2>/dev/null || true)
  fi
  [ -n "$url" ] || return 1
  printf '%s\n' "$url"
}

# 审计 #4：仅当镜像 remote URL 是 HTTP(S) 且其规范化 origin（及可选路径前缀）严格匹配 API_BASE 时，
# 才允许为 git 挂载 HTTPS Token 凭据 helper；指向其它主机或非 HTTP(S) 协议的 remote 绝不递交凭据。
_remote_url_matches_api_origin() {
  local d=$1 remote_name=$2 url parsed u_origin u_path
  [ -n "${EXPECTED_AUTH_ORIGIN:-}" ] || return 1
  url=$(_git_remote_url "$d" "$remote_name") || return 1
  parsed=$(_parse_http_url_origin "$url") || return 1
  u_origin="${parsed%%	*}"
  u_path="${parsed#*	}"
  [ "$u_origin" = "$EXPECTED_AUTH_ORIGIN" ] || return 1
  if [ -n "${EXPECTED_AUTH_PATH_PREFIX:-}" ]; then
    case "$u_path" in
      "$EXPECTED_AUTH_PATH_PREFIX"|"$EXPECTED_AUTH_PATH_PREFIX"/*) ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

_run_git_for_mirror() {
  local d=$1 remote_name=$2
  shift 2
  if [ -n "${API_TOKEN:-}" ] && [ -n "$remote_name" ] && _remote_url_matches_api_origin "$d" "$remote_name"; then
    run_git_with_https_auth "$@"
  else
    "$@"
  fi
}

# ── 2) 单仓同步 ──────────────────────────────────────────────────────────────
# fetch/clone 成功后，以远端明确声明且已抓取到本地的默认分支收敛 bare mirror HEAD。
# 只输出固定错误码，避免把可能含凭据的 remote URL / Git stderr 带进日志。
converge_default_head() {
  local d=$1 remotes remote_name="" remote_count=0 name
  local remote_head tab line field value target="" remote_oid="" local_oid
  local sym_count=0 oid_count=0 invalid=0 oid_len remote_oid_lc local_oid_lc all_refs local_objects

  remotes=$(git --git-dir="$d" remote 2>/dev/null) || {
    echo "HEAD_UNVERIFIED_REMOTE_LIST"
    return 1
  }
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    remote_count=$((remote_count + 1))
    remote_name=$name
  done <<< "$remotes"
  [ "$remote_count" -eq 1 ] || {
    echo "HEAD_UNVERIFIED_REMOTE_COUNT"
    return 1
  }

  remote_head=$(GIT_TERMINAL_PROMPT=0 _run_git_for_mirror "$d" "$remote_name" _run_timeout 300 \
      git --git-dir="$d" ls-remote --symref -- "$remote_name" HEAD 2>/dev/null) || {
    echo "HEAD_UNVERIFIED_REMOTE_UNREACHABLE"
    return 1
  }

  tab=$(printf '\t')
  while IFS= read -r line; do
    case "$line" in
      *"$tab"*) ;;
      *) continue ;;
    esac
    field=${line%%"$tab"*}
    value=${line#*"$tab"}
    [ "$value" = HEAD ] || continue
    case "$field" in
      "ref: refs/heads/"*)
        sym_count=$((sym_count + 1))
        target=${field#ref: }
        ;;
      *)
        case "$field" in
          *[!0123456789abcdefABCDEF]*) invalid=1 ;;
          *)
            oid_len=${#field}
            if [ "$oid_len" -eq 40 ] || [ "$oid_len" -eq 64 ]; then
              oid_count=$((oid_count + 1))
              remote_oid=$field
            else
              invalid=1
            fi
            ;;
        esac
        ;;
    esac
  done <<< "$remote_head"

  # 2.0.3：远端是「尚无提交的空仓库」（没有任何 ref；HEAD 要么不输出，要么只有未出生的符号引用）时，
  # 没有默认分支可收敛，视为成功。旧逻辑把它记成 FAIL head，导致每轮同步都失败、state/last_ok 永不刷新。
  if [ "$invalid" -eq 0 ] && [ "$oid_count" -eq 0 ] && [ "$sym_count" -le 1 ]; then
    all_refs=$(GIT_TERMINAL_PROMPT=0 _run_git_for_mirror "$d" "$remote_name" _run_timeout 300 \
        git --git-dir="$d" ls-remote -- "$remote_name" 2>/dev/null) || {
      echo "HEAD_UNVERIFIED_REMOTE_UNREACHABLE"
      return 1
    }
    if [ -z "$all_refs" ] && [ "${GITQ_EMPTY_REMOTE:-ok}" != fail ]; then
      # 仅当本地镜像从未有过任何对象（全新空仓库）才放行；若镜像里已有历史、而远端突然变空
      # （被清空 / 指错实例），仍然 fail closed 并保留原 HEAD（见 test/sync-default-head.test.mjs C4）。
      # GITQ_EMPTY_REMOTE=fail 可恢复 2.0.2 的「空远端一律失败」行为。
      local_objects=$(git --git-dir="$d" count-objects -v 2>/dev/null | awk '/^(count|in-pack):/ { s += $2 } END { print s + 0 }')
      [ "${local_objects:-1}" = 0 ] && return 0
    fi
  fi

  if [ "$invalid" -ne 0 ] || [ "$sym_count" -ne 1 ] || [ "$oid_count" -ne 1 ] || [ -z "$target" ]; then
    echo "HEAD_UNVERIFIED_REMOTE_HEAD"
    return 1
  fi
  git check-ref-format "$target" >/dev/null 2>&1 || {
    echo "HEAD_UNVERIFIED_REMOTE_HEAD"
    return 1
  }

  local_oid=$(git --git-dir="$d" show-ref --verify --hash "$target" 2>/dev/null) || {
    echo "HEAD_UNVERIFIED_LOCAL_REF"
    return 1
  }
  remote_oid_lc=$(printf '%s' "$remote_oid" | tr 'ABCDEF' 'abcdef')
  local_oid_lc=$(printf '%s' "$local_oid" | tr 'ABCDEF' 'abcdef')
  [ "$local_oid_lc" = "$remote_oid_lc" ] || {
    echo "HEAD_UNVERIFIED_LOCAL_REF"
    return 1
  }

  git --git-dir="$d" symbolic-ref HEAD "$target" >/dev/null 2>&1 || {
    echo "HEAD_UNVERIFIED_UPDATE"
    return 1
  }
}

run_git_with_https_auth() {
  # 审计 #20：Git 2.25-2.30 不支持 GIT_CONFIG_COUNT；使用全版本兼容的 `git -c credential.useHttpPath=true`
  # 显式向 git（及其 git-remote-https 子进程）注入路径上下文，确保子路径部署的私有 forge 认证与路径校验均有效。
  if [ -n "${EXPECTED_AUTH_PATH_PREFIX:-}" ]; then
    local _args=() _injected=0 _arg
    for _arg in "$@"; do
      _args+=("$_arg")
      if [ "$_injected" -eq 0 ] && [ "$_arg" = "git" ]; then
        _args+=(-c credential.useHttpPath=true)
        _injected=1
      fi
    done
    GIT_ASKPASS="$GITQ_ASKPASS" GIT_ASKPASS_REQUIRE=force \
      GITQ_ASKPASS_USER="$GIT_USER" GITQ_ASKPASS_TOKEN="$API_TOKEN" \
      GITQ_ASKPASS_ORIGIN="$EXPECTED_AUTH_ORIGIN" \
      GITQ_ASKPASS_PATH_PREFIX="$EXPECTED_AUTH_PATH_PREFIX" \
      "${_args[@]}"
  else
    GIT_ASKPASS="$GITQ_ASKPASS" GIT_ASKPASS_REQUIRE=force \
      GITQ_ASKPASS_USER="$GIT_USER" GITQ_ASKPASS_TOKEN="$API_TOKEN" \
      GITQ_ASKPASS_ORIGIN="$EXPECTED_AUTH_ORIGIN" \
      GITQ_ASKPASS_PATH_PREFIX="" \
      "$@"
  fi
}

sync_one() {
  local r=$1
  # 注意：不要写 `local r=$1 d=$ROOT/$OWNER/$r.git` —— local/declare 会先把整行
  # 参数展开再赋值，$r 取到的是外层（未定义）的值，目录名会变成裸 ".git"（踩过）。
  local d="$ROOT/$OWNER/$r.git"
  local out rc=0 low lc cand action head_error
  local remote_name="" remote_count=0 rname remotes_out="" local_refs_snap="" local_objects=0 pre_refs="" pre_rc=0 post_refs=""
  [ -z "$r" ] && { echo "FAIL 空仓名"; return 1; }
  if [ ! -d "$d" ]; then
    # 2026-10-14：历史镜像目录可能是大小写变体（API 给规范名，磁盘是早期按别的方式建的，
    # 如 ha-s3-env vs HA-s3-ENV）。大小写不敏感找现有目录并**原地更新**，避免每轮克隆出重复目录。
    lc=$(printf '%s' "$r" | tr 'A-Z' 'a-z')
    for cand in "$ROOT/$OWNER"/*.git; do
      [ -e "$cand" ] || continue
      low=$(basename "$cand" .git | tr 'A-Z' 'a-z')
      if [ "$low" = "$lc" ]; then d="$cand"; break; fi
    done
  fi
  if [ -d "$d" ]; then
    action=fetch
    # 2.0.3 N8：fd 9（flock 同步锁）会被 git 子进程继承；自动 gc 若以守护进程脱离，会在 sync.sh 退出后继续占锁，
    # 让后续同步误报 SYNC_BUSY。把镜像库设为前台 gc（仍受下面 300s 超时约束）。写入仓库本地配置，与 Git 版本无关。
    git --git-dir="$d" config gc.autoDetach false >/dev/null 2>&1 || true
    if ! remotes_out=$(git --git-dir="$d" remote 2>/dev/null); then
      echo "FAIL head $r :: HEAD_UNVERIFIED_REMOTE_LIST"
      return 1
    fi
    while IFS= read -r rname; do
      [ -n "$rname" ] || continue
      remote_count=$((remote_count + 1))
      remote_name=$rname
    done <<< "$remotes_out"
    # 审计 #19：非单 remote 镜像在任何远端写操作（remote update --prune）之前就 fail closed，
    # 避免把本地 refs 移动或修剪掉后再报错 HEAD_UNVERIFIED_REMOTE_COUNT。
    if [ "$remote_count" -ne 1 ]; then
      echo "FAIL head $r :: HEAD_UNVERIFIED_REMOTE_COUNT"
      return 1
    fi

    # 审计 #2：对已有历史仓，在破坏性 `remote update --prune` 之前先记录本地 ref 快照并核实远端是否已变空；
    # 若远端确已变空，直接 fail closed 而不执行 prune，避免把旧分支 ref 修剪掉导致历史检索和读取不可用。
    local_refs_snap=$(git --git-dir="$d" for-each-ref --format='update %(refname) %(objectname)' 2>/dev/null || true)
    local_objects=$(git --git-dir="$d" count-objects -v 2>/dev/null | awk '/^(count|in-pack):/ { s += $2 } END { print s + 0 }')
    if [ -n "$remote_name" ] && { [ -n "$local_refs_snap" ] || [ "${local_objects:-0}" != "0" ]; }; then
      pre_rc=0
      pre_refs=$(GIT_TERMINAL_PROMPT=0 _run_git_for_mirror "$d" "$remote_name" _run_timeout 300 \
        git --git-dir="$d" ls-remote -- "$remote_name" 2>/dev/null) || pre_rc=$?
      if [ "$pre_rc" -eq 0 ] && [ -z "$pre_refs" ]; then
        echo "FAIL head $r :: HEAD_UNVERIFIED_REMOTE_HEAD"
        return 1
      fi
    fi

    if [ -n "$API_TOKEN" ] && [ -n "$remote_name" ]; then
      if _remote_url_matches_api_origin "$d" "$remote_name"; then
        out=$(run_git_with_https_auth _run_timeout 300 git --git-dir="$d" remote update --prune 2>&1) || rc=1
      else
        if _git_remote_url "$d" "$remote_name" 2>/dev/null | grep -qiE '^https?://'; then
          log "WARN remote-origin-mismatch ${r}（已跳过 HTTPS 凭据绑定）"
        fi
        out=$(_run_timeout 300 git --git-dir="$d" remote update --prune 2>&1) || rc=1
      fi
    else
      out=$(_run_timeout 300 git --git-dir="$d" remote update --prune 2>&1) || rc=1
    fi
    [ $rc = 1 ] && echo "FAIL fetch $r :: $(echo "${out//"$API_TOKEN"/[REDACTED]}" | tail -2 | tr '\n' ' ')"
  else
    action=clone
    # 通道（token OR ssh 通用性）：ssh 优先；ssh 失败且有 token 时，该仓改走 http(s)。
    local scheme="${API_BASE%%://*}"
    [ "$scheme" = "$API_BASE" ] && scheme="https"
    local hostpart="${API_BASE#*://}"
    src_ssh="$REMOTE:$OWNER/$r.git"
    if [ -n "$API_TOKEN" ]; then
      src_https="$scheme://$GIT_USER@$hostpart/$OWNER/$r.git"
    else
      src_https="$scheme://$hostpart/$OWNER/$r.git"
    fi
    if [ "$TRANSPORT" = https ] && [ -n "$API_TOKEN" ]; then
      out=$(run_git_with_https_auth _run_timeout 300 git clone --mirror -q "$src_https" "$d" 2>&1) || rc=1
    elif [ "$TRANSPORT" = https ]; then
      out=$(_run_timeout 300 git clone --mirror -q "$src_https" "$d" 2>&1) || rc=1
    elif [ "$TRANSPORT" = auto ] && [ -n "$API_TOKEN" ]; then
      # 先试 ssh（网内快）；失败再试 https（token 兜底）
      out=$(_run_timeout 300 git clone --mirror -q "$src_ssh" "$d" 2>&1) || rc=1
      if [ $rc = 1 ] && [ ! -d "$d" ]; then
        log "INFO clone $r 经 ssh 失败，改走 https(token)"
        # 审计 #11：必须先清零 rc，按最后一次实际尝试（HTTPS 回退）决定成败，成功后继续 HEAD 校验。
        rc=0
        out=$(run_git_with_https_auth _run_timeout 300 git clone --mirror -q "$src_https" "$d" 2>&1) || rc=1
      fi
    else
      out=$(_run_timeout 300 git clone --mirror -q "$src_ssh" "$d" 2>&1) || rc=1
    fi
    [ $rc = 1 ] && echo "FAIL clone $r :: $(echo "${out//"$API_TOKEN"/[REDACTED]}" | tail -2 | tr '\n' ' ')"
  fi
  if [ "$rc" -eq 0 ] && [ "$action" = clone ] && [ -d "$d" ]; then
    git --git-dir="$d" config gc.autoDetach false >/dev/null 2>&1 || true
  fi
  if [ "$rc" -eq 0 ]; then
    if head_error=$(converge_default_head "$d"); then
      echo "ok   $action $r"
    else
      # 审计 #2（竞态兜底）：若远端在预检后、fetch 瞬间被清空导致本地 ref 被修剪，立刻从快照恢复旧 ref。
      if [ "$action" = fetch ] && [ -n "$local_refs_snap" ]; then
        post_refs=$(git --git-dir="$d" for-each-ref --format='%(refname)' 2>/dev/null || true)
        if [ -z "$post_refs" ]; then
          printf '%s\n' "$local_refs_snap" | git --git-dir="$d" update-ref --stdin 2>/dev/null || true
        fi
      fi
      echo "FAIL head $r :: $head_error"
      rc=1
    fi
  fi
  return $rc
}
export -f _parse_http_url_origin _git_remote_url _remote_url_matches_api_origin _run_git_for_mirror
export -f converge_default_head run_git_with_https_auth sync_one
export ROOT OWNER REMOTE TRANSPORT API_TOKEN GIT_USER API_BASE GITQ_EMPTY_REMOTE
export EXPECTED_AUTH_ORIGIN EXPECTED_AUTH_PATH_PREFIX
# 传给子 shell 的 log（sync_one 里 https 回退会用）—— 它自己会 append 到 $LOG
log() { echo "$(date '+%F %T') [$HOST] $*" >> "${GITQ_LOG:-$ROOT/sync.log}"; }
export -f log
export HOST GITQ_LOG

GITQ_ASKPASS=$(mktemp "$ROOT/.git-askpass.XXXXXX") || {
  echo "CREDENTIAL_HELPER_FAILED: 无法创建 Git askpass" >&2
  exit 1
}
chmod 700 "$GITQ_ASKPASS" || {
  rm -f "$GITQ_ASKPASS"
  echo "CREDENTIAL_HELPER_FAILED: 无法保护 Git askpass" >&2
  exit 1
}
cat > "$GITQ_ASKPASS" <<'ASKPASS_EOF' || {
#!/bin/sh
# 审计 #4：仅向严格匹配 GITQ_ASKPASS_ORIGIN（及可选路径前缀）的 Git Username/Password 提示提供凭据；
# 未知提示、跨主机、跨协议（http vs https）或越界路径一律静默拒绝（无输出且退出 1）。
prompt="$1"
kind=""
case "$prompt" in
  "Username for '"*"'"*) kind="user" ;;
  "Password for '"*"'"*) kind="pass" ;;
  *) exit 1 ;;
esac
rest="${prompt#*\'}"
url="${rest%%\'*}"
[ -n "$url" ] && [ -n "${GITQ_ASKPASS_ORIGIN:-}" ] || exit 1
case "$url" in
  [Hh][Tt][Tt][Pp]://*) scheme="http"; body="${url#*://}" ;;
  [Hh][Tt][Tt][Pp][Ss]://*) scheme="https"; body="${url#*://}" ;;
  *) exit 1 ;;
esac
auth="${body%%/*}"
auth="${auth%%\?*}"
auth="${auth%%#*}"
hostport=$(printf '%s' "${auth##*@}" | tr 'A-Z' 'a-z')
[ -n "$hostport" ] || exit 1
if [ "$scheme" = "https" ]; then
  hostport="${hostport%:443}"
elif [ "$scheme" = "http" ]; then
  hostport="${hostport%:80}"
fi
origin="${scheme}://${hostport}"
[ "$origin" = "$GITQ_ASKPASS_ORIGIN" ] || exit 1
if [ -n "${GITQ_ASKPASS_PATH_PREFIX:-}" ]; then
  case "$body" in
    */*)
      upath="/${body#*/}"
      upath="${upath%%\?*}"
      upath="${upath%%#*}"
      case "$upath" in
        "$GITQ_ASKPASS_PATH_PREFIX"|"$GITQ_ASKPASS_PATH_PREFIX"/*) ;;
        *) exit 1 ;;
      esac
      ;;
    *) exit 1 ;;
  esac
fi
if [ "$kind" = "user" ]; then
  printf '%s\n' "$GITQ_ASKPASS_USER"
else
  printf '%s\n' "$GITQ_ASKPASS_TOKEN"
fi
ASKPASS_EOF
  rm -f "$GITQ_ASKPASS"
  echo "CREDENTIAL_HELPER_FAILED: 无法写入 Git askpass" >&2
  exit 1
}
export GITQ_ASKPASS
trap 'rm -f "$GITQ_ASKPASS"; _release_sync_lock_dir' EXIT

case "$JOBS" in
  ''|*[!0-9]*|0)
    echo "CONFIG_ERROR: GITQ_JOBS/-j 必须是正整数" >&2
    exit 2
    ;;
esac

say "== 同步 $REMOTE:$OWNER —— ${#repos[@]} 个仓，并发 ${JOBS}，目标 $ROOT/$OWNER =="
start=$(date +%s)
fail=0
sync_status=ok
# 2026-10-08：临时文件改 mktemp + trap —— 原先固定写 $ROOT/.sync.out，
# cron 一旦重叠（无锁时真发生过）两轮会互相覆盖这个文件，ok/fail 计数与日志都会串。
OUT=$(mktemp "$ROOT/.sync.out.XXXXXX") || {
  echo "SYNC_EXECUTOR_FAILED: 无法创建同步临时文件" >&2
  exit 1
}
[ -n "$OUT" ] && [ -f "$OUT" ] || {
  echo "SYNC_EXECUTOR_FAILED: 同步临时文件无效" >&2
  exit 1
}
trap 'rm -f "$OUT" "$GITQ_ASKPASS"; _release_sync_lock_dir' EXIT
xargs_rc=0
# 审计 #6：不关闭锁描述符 fd 9，避免工作进程仍在写镜像时外层锁被提前释放；
# 搭配 `_run_timeout`（GNU timeout --foreground）确保取消时 sync.sh 与所有 git 工作进程同组退出并原子释放锁。
printf '%s\n' "${repos[@]+"${repos[@]}"}" | xargs -P "$JOBS" -I{} bash -c 'sync_one "$@"' _ {} > "$OUT" 2>&1 || xargs_rc=$?
fail=$(grep -c '^FAIL[[:space:]]' "$OUT" 2>/dev/null || true)
ok=$(grep -c '^ok[[:space:]]' "$OUT" 2>/dev/null || true)
accounted=$((ok + fail))
if [ "$accounted" -ne "${#repos[@]}" ]; then
  sync_status=unaccounted
  unaccounted=$(( ${#repos[@]} - ok ))
  [ "$unaccounted" -gt 0 ] || unaccounted=1
  [ "$fail" -ge "$unaccounted" ] || fail=$unaccounted
  echo "SYNC_ACCOUNTING_FAILED: expected=${#repos[@]} ok=$ok accounted=$accounted" >&2
elif [ "$xargs_rc" -ne 0 ] && [ "$xargs_rc" -ne 123 ]; then
  sync_status=executor_failed
  echo "SYNC_EXECUTOR_FAILED: xargs rc=$xargs_rc" >&2
fi

# 防御：正常绝不会出现 $ROOT/$OWNER/.git（那是仓名解析成空的症状），出现就报警
if [ -d "$ROOT/$OWNER/.git" ]; then
  echo "!! 异常：$ROOT/$OWNER/.git 存在（仓名为空的痕迹），请检查后再重跑" >&2
  log "ERROR 出现 $ROOT/$OWNER/.git，仓名解析异常"
fi

if [ "$QUIET" = 1 ]; then
  [ "$fail" -gt 0 ] && grep '^FAIL' "$OUT" >&2
else
  cat "$OUT"
fi

# 增量刷新 SQLite FTS5 索引（文档与导出会话全文检索）。索引结果属于整轮成功契约，
# 必须先于 last_status/last_ok 确定，不能把「fetch 成功、索引失败」记成完整成功。
index_status=skipped
index_rc=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
INDEXER="$SCRIPT_DIR/../lib/indexer.py"
if [ -f "$INDEXER" ]; then
  index_status=ok
  INDEX_ARGS=(--build)
  # 只有权威完整枚举且每仓 fetch/HEAD 验证全成功，才允许索引器做全局 stale-repo prune。
  # -r 局部同步、cache/disk 降级或部分仓失败都必须显式 fail closed。
  if [ ${#ONLY[@]} -gt 0 ] || [ "$DEGRADED" -ne 0 ] || [ "$fail" -gt 0 ] || [ "$sync_status" != ok ]; then
    INDEX_ARGS+=(--no-global-prune)
  fi
  # 审计 #2：对本轮 fetch/clone/HEAD 校验失败的仓，显式通知索引器跳过，防止覆盖或清除其旧文档。
  failed_repos=$(awk -v o="$OWNER" '/^FAIL[[:space:]]+(fetch|clone|head)[[:space:]]+/ { r=$3; if (!seen[r]++) { out = (out ? out "," : "") o "/" r } } END { print out }' "$OUT" 2>/dev/null || true)
  if [ -n "$failed_repos" ]; then
    INDEX_ARGS+=(--skip-repos "$failed_repos")
  fi
  # 2.0.3：索引输出落盘到 state/index-last.log（原先整体丢进 /dev/null，失败时无从诊断）。
  mkdir -p "$ROOT/state" 2>/dev/null || true
  INDEX_LOG="$ROOT/state/index-last.log"
  python3 "$INDEXER" "${INDEX_ARGS[@]}" >"$INDEX_LOG" 2>&1 9>&-
  index_rc=$?
  if [ "$index_rc" -ne 0 ]; then
    index_status=failed
    index_error="INDEX_UPDATE_FAILED: 索引更新失败 rc=$index_rc"
    echo "$index_error" >&2
    tail -n 3 "$INDEX_LOG" 2>/dev/null | sed 's/^/  index-log: /' >&2
    log "$index_error"
  fi
else
  log "WARN 未找到索引核心 ${INDEXER}，本轮跳过增量索引"
fi

dur=$(( $(date +%s) - start ))
sync_scope=full
[ ${#ONLY[@]} -gt 0 ] && sync_scope=partial
date '+%F %T' > "$ROOT/last_sync"
# 机器可读状态（供巡检/排障）：last_status 每轮都写；state/last_ok 仅在全量同步（sync_scope=full）
# 且已知仓同步与索引均成功时刷新（局部 -r 同步不刷新），枚举覆盖范围由 last_status 单独记录。
# 巡检按它断言新鲜度 ⇒「同步静默停摆/一直失败」能被及时发现。
mkdir -p "$ROOT/state"
mtime=$(stat -c %Y "$ROOT/state/last_ok" 2>/dev/null || stat -f %m "$ROOT/state/last_ok" 2>/dev/null || echo 0)
if [ "$mtime" -gt 0 ]; then
  last_ok_age_h=$(awk -v m="$mtime" -v now="$(date +%s)" 'BEGIN{printf "%.1f",(now-m)/3600}' 2>/dev/null)
else
  last_ok_age_h="none"   # 本机还没有过成功的 last_ok（首轮），别把 systime() 当年龄
fi
[ -z "$last_ok_age_h" ] && last_ok_age_h="unknown"
status_record=$(printf 'time=%s host=%s ok=%d fail=%d total=%d dur=%ds degraded=%d enum_source=%s cache_stale=%d transport=%s sync_scope=%s sync_status=%s last_ok_age_h=%s index_status=%s index_rc=%d' \
    "$(date '+%F %T')" "$HOST" "$ok" "$fail" "${#repos[@]}" "$dur" "$DEGRADED" \
    "${ENUM_SOURCE:-none}" "$CACHE_STALE" "$TRANSPORT" "$sync_scope" "$sync_status" "$last_ok_age_h" "$index_status" "$index_rc")
printf '%s\n' "$status_record" > "$ROOT/state/last_status"
if [ "${GITQ_SYNC_STATUS_STDOUT:-0}" = 1 ]; then
  printf 'SYNC_STATUS_RECORD %s\n' "$status_record"
fi
[ "$sync_scope" = full ] && [ "$fail" -eq 0 ] && [ "$sync_status" = ok ] && [ "$index_status" != failed ] && date '+%F %T' > "$ROOT/state/last_ok"
summary="完成：成功 ${ok}，失败 ${fail}，用时 ${dur}s（${#repos[@]} 个仓，枚举源=${ENUM_SOURCE:-none}）"
if [ "$DEGRADED" = 1 ]; then
  case "${ENUM_SOURCE:-}" in
    cache) [ "$CACHE_STALE" = 1 ] && summary="${summary}【枚举降级：用过期缓存，新仓可能未被发现】" \
                                || summary="${summary}【枚举降级：用缓存，新仓可能未被发现】" ;;
    disk)  summary="${summary}【枚举降级：按本地目录同步，新仓不会被发现】" ;;
    *)     summary="${summary}【枚举降级】" ;;
  esac
fi
say "$summary"
log "$summary"
# 只在「整轮全失败」或「枚举降级」时进 journal —— 避免任何一个仓抖动都刷警（告警疲劳）
if [ "$fail" -gt 0 ] && [ "$fail" -eq "${#repos[@]}" ]; then
  logger -t gitea-mirror "镜像同步整轮失败（$fail/${#repos[@]}）—— 远端可能不可达，详见 /var/log/gitea-mirror.log" 2>/dev/null || true
fi
if [ "$DEGRADED" = 1 ]; then
  logger -t gitea-mirror "枚举降级：Gitea 仓枚举失败，本轮按本地目录同步，新仓可能未被发现" 2>/dev/null || true
fi

if [ "$fail" -gt 0 ] || [ "$sync_status" != ok ] || [ "$index_status" = failed ]; then
  exit 1
fi
exit 0
