"""Read-only sync metadata; an attempt timestamp never proves success."""
from datetime import datetime
from pathlib import Path
import re


_TIMESTAMP_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$"
)


def _normalize_timestamp(raw):
    # Match Python 3.10 and Node parsing: normalize fractional seconds to six digits,
    # Z to +00:00, and a space separator to T before calendar validation.
    if not isinstance(raw, str):
        return None
    match = _TIMESTAMP_RE.fullmatch(raw)
    if not match:
        return None
    date_part, time_part, frac_part, tz_part = match.groups()
    frac = f".{frac_part[:6].ljust(6, '0')}" if frac_part is not None else ""
    tz = "+00:00" if tz_part == "Z" else (tz_part or "")
    normalized = f"{date_part}T{time_part}{frac}{tz}"
    try:
        datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return normalized


def _timestamp(root, name):
    try:
        raw = (Path(root) / name).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None, None
    except (OSError, UnicodeError):
        return None, name
    normalized = _normalize_timestamp(raw)
    if not normalized:
        return None, name
    return raw, None


def parse_sync_status(raw):
    fields = dict(re.findall(r"(?:^|\s)([a-z_]+)=([^\s]+)", raw))
    return {
        "degraded": fields.get("degraded") == "1",
        "enum_source": fields.get("enum_source"),
        "cache_stale": fields.get("cache_stale") == "1",
        **{key: int(fields[key]) if re.fullmatch(r"[0-9]+", fields.get(key, "")) else None
           for key in ("ok", "fail", "total")},
        **{key: fields.get(key) for key in ("sync_scope", "sync_status", "index_status")},
    }


def read_sync_state(root):
    attempt, attempt_error = _timestamp(root, "last_sync")
    success, success_error = _timestamp(root, "state/last_ok")
    errors = [e for e in (attempt_error, success_error) if e]
    status = "unknown"
    details = parse_sync_status("")
    try:
        details = parse_sync_status((Path(root) / "state/last_status").read_text(encoding="utf-8"))
        if details["fail"] is not None:
            sync_failed = details["sync_status"] not in (None, "ok")
            status = "failed" if details["fail"] or sync_failed or details["index_status"] == "failed" else "success"
        else:
            errors.append("state/last_status")
    except FileNotFoundError:
        pass
    except (OSError, UnicodeError):
        errors.append("state/last_status")
    if errors:
        status = "invalid"
    elif not attempt and not success and status == "unknown":
        status = "unrecorded"
    return {"status": status, "last_attempt": attempt, "last_success": success, "invalid_records": errors, **details}


def sync_summary(state):
    label = {
        "unrecorded": "无同步记录（镜像可能手工建立）",
        "invalid": "同步记录损坏或不可读",
        "failed": "最近同步失败",
        "success": "最近同步成功",
        "unknown": "同步结果未记录",
    }[state["status"]]
    return f"{label}；最近尝试: {state['last_attempt'] or '无记录'}；最近成功: {state['last_success'] or '无记录'}"
