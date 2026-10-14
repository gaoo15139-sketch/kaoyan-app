/* 通用工具：ID、时间、哈希、文本处理。无任何依赖。 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastMs = 0;
let counter = 0;

function encode(value, length) {
  const chars = [];
  let v = value;
  for (let i = 0; i < length; i += 1) {
    chars.push(ALPHABET[v & 31]);
    v = Math.floor(v / 32);
  }
  return chars.reverse().join('');
}

function randomBig() {
  const bytes = new Uint8Array(10);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

/* ULID 风格：10 位毫秒时间 + 16 位随机，字典序即时间序，同毫秒内单调递增 */
export function newId(prefix) {
  const ms = Date.now();
  if (ms <= lastMs) {
    counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  } else {
    lastMs = ms;
    counter = Number(randomBig() % 1000000000n);
  }
  const stamp = encode(ms, 10);
  const tail = encode(counter, 6) + encode(Number(randomBig() % 32768n), 4) + encode(Number(randomBig() % 32768n), 4);
  return (prefix || '') + stamp + tail;
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatTime(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').replace('Z', '').slice(0, 16);
}

/* 内容指纹：FNV-1a 变体 ×4 拼成 128 位。
   仅用于"内容是否相同"的判重，不用于安全用途，因此同步实现即可。 */
export function hashText(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const seeds = [0x811c9dc5, 0x01000193, 0x7fffffff, 0xdeadbeef];
  const parts = [];
  for (let s = 0; s < seeds.length; s += 1) {
    let h = seeds[s] >>> 0;
    for (let i = 0; i < bytes.length; i += 1) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    parts.push(h.toString(16).padStart(8, '0'));
  }
  return parts.join('');
}

export function normalizeWhitespace(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function deriveTitle(text, fallback) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/^#+\s*/, '').trim();
    if (stripped) return stripped.length > 40 ? stripped.slice(0, 40) + '...' : stripped;
  }
  return fallback || '未命名材料';
}

export function truncate(text, limit, suffix) {
  const value = String(text === undefined || text === null ? '' : text);
  if (!limit || value.length <= limit) return value;
  return value.slice(0, limit) + (suffix === undefined ? '\n...[内容已截断]' : suffix);
}

export function unique(items) {
  const seen = new Set();
  const out = [];
  (items || []).forEach(function (item) {
    const value = typeof item === 'string' ? item.trim() : item;
    if (value === '' || value === null || value === undefined) return;
    const key = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

export function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function asInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

export function asFloat(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

export function plainSnippet(text, needle, radius) {
  const r = radius || 60;
  const flat = String(text || '').replace(/\n+/g, ' ').trim();
  if (!flat) return '';
  if (needle) {
    const index = flat.toLowerCase().indexOf(String(needle).toLowerCase());
    if (index >= 0) {
      const start = Math.max(0, index - r);
      const end = Math.min(flat.length, index + String(needle).length + r);
      return (start > 0 ? '...' : '') + flat.slice(start, end) + (end < flat.length ? '...' : '');
    }
  }
  return flat.slice(0, r * 2) + (flat.length > r * 2 ? '...' : '');
}

export function parseKeywords(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch (error) { /* 不是 JSON，按逗号分隔处理 */ }
  return String(value).split(/[，,]/).map(function (item) { return item.trim(); }).filter(Boolean);
}

export function splitTokens(text) {
  if (!text) return [];
  return String(text).replace(/[，]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
}

export function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

export function downloadBlob(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}
