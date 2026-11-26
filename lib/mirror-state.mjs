import fs from 'node:fs';
import path from 'node:path';

export function normalizeTimestamp(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))?$/.exec(raw);
  if (!match) return null;
  const [, ys, ms, ds, hs, mins, secs, frac, tz, zhs = '0', zms = '0'] = match;
  const [y, m, d, h, min, sec, zh, zm] = [ys, ms, ds, hs, mins, secs, zhs, zms].map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days || h > 23 || min > 59 || sec > 59 || zh > 23 || zm > 59) return null;
  const normFrac = frac !== undefined ? `.${frac.slice(0, 6).padEnd(6, '0')}` : '';
  const normTz = tz === 'Z' ? '+00:00' : (tz || '');
  const normalized = `${ys}-${ms}-${ds}T${hs}:${mins}:${secs}${normFrac}${normTz}`;
  return Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function timestamp(root, name) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, name), 'utf8').trim(); }
  catch (e) { return [null, e.code === 'ENOENT' ? null : name]; }
  if (!normalizeTimestamp(raw)) return [null, name];
  return [raw, null];
}

export function readSyncState(root) {
  const [attempt, aerr] = timestamp(root, 'last_sync');
  const [success, serr] = timestamp(root, 'state/last_ok');
  const errors = [aerr, serr].filter(Boolean);
  let status = 'unknown';
  let fields = {};
  try {
    const raw = fs.readFileSync(path.join(root, 'state/last_status'), 'utf8');
    fields = Object.fromEntries([...raw.matchAll(/(?:^|\s)([a-z_]+)=([^\s]+)/g)].map(([, key, value]) => [key, value]));
    if (/^[0-9]+$/.test(fields.fail ?? '')) {
      const syncFailed = Boolean(fields.sync_status && fields.sync_status !== 'ok');
      status = Number(fields.fail) || syncFailed || fields.index_status === 'failed' ? 'failed' : 'success';
    }
    else errors.push('state/last_status');
  } catch (e) { if (e.code !== 'ENOENT') errors.push('state/last_status'); }
  if (errors.length) status = 'invalid';
  else if (!attempt && !success && status === 'unknown') status = 'unrecorded';
  const count = (key) => /^[0-9]+$/.test(fields[key] ?? '') ? Number(fields[key]) : null;
  return {
    status, last_attempt: attempt, last_success: success, invalid_records: errors,
    degraded: fields.degraded === '1',
    enum_source: fields.enum_source ?? null,
    cache_stale: fields.cache_stale === '1',
    ok: count('ok'),
    fail: count('fail'),
    total: count('total'),
    sync_scope: fields.sync_scope ?? null,
    sync_status: fields.sync_status ?? null,
    index_status: fields.index_status ?? null,
  };
}

export function syncSummary(state) {
  const label = { unrecorded: '无同步记录（镜像可能手工建立）', invalid: '同步记录损坏或不可读', failed: '最近同步失败', success: '最近同步成功', unknown: '同步结果未记录' }[state.status];
  return `${label}；最近尝试: ${state.last_attempt || '无记录'}；最近成功: ${state.last_success || '无记录'}`;
}
