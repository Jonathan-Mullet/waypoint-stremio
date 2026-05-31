// Format seconds as "1h 23m" or "4m 05s"
function fmtResumeTime(secs) {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

// Shallow redaction of sensitive top-level keys. Does not recurse into nested objects.
const SENSITIVE_RE = /token|secret|password|key/i;
function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, SENSITIVE_RE.test(k) ? '[redacted]' : v])
  );
}

// Structured logger. All data objects are sanitized before output.
function log(level, msg, data) {
  const entry = { level, msg, ts: new Date().toISOString() };
  if (data) entry.data = sanitize(data);
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
}

module.exports = { fmtResumeTime, sanitize, log };
