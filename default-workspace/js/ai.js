/* 浏览器直连 DeepSeek。
 *
 * 已实测 api.deepseek.com 会回显 CORS 头（access-control-allow-origin /
 * -methods / -headers），所以手机浏览器可以直接调用，不需要任何后端代理。
 *
 * 代价：API Key 保存在手机本地，谁拿到这台手机就能用你的额度。
 */
import { truncate, unique } from './util.js';

export const PROMPT_VERSION = 'v1';
export const RETRYABLE_CODES = ['timeout', 'network', 'rate_limit', 'server'];

export class AIError extends Error {
  constructor(message, code, details, retryable) {
    super(message);
    this.name = 'AIError';
    this.code = code || 'unknown';
    this.details = details || {};
    this.retryable = !!retryable;
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const ERROR_LABEL = {
  timeout: '调用超时',
  network: '网络中断',
  invalid_json: '返回内容不是合法 JSON',
  auth: 'API Key 无效',
  quota: '余额不足',
  rate_limit: '触发限流',
  server: '服务端错误',
  bad_request: '请求参数错误',
  bad_response: '响应结构异常',
  no_api_key: '未配置 API Key',
  ai_disabled: 'AI 功能已关闭',
  unknown: '未知错误'
};

/* ------------------------------------------------------------------ JSON 修复 */

export function extractJson(text) {
  const warnings = [];
  if (!text || !String(text).trim()) throw new Error('模型输出为空');

  let cleaned = String(text).replace(/```[a-zA-Z]*\s*/g, '').replace(/\s*```/g, '').trim();
  if (cleaned !== String(text).trim()) warnings.push('已移除 markdown 代码块标记');

  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  const balanced = balancedObject(cleaned);
  if (balanced) candidates.push(balanced);

  const seen = new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return { value: JSON.parse(candidate), warnings: warnings };
    } catch (error) { /* 继续尝试修复 */ }
    const repaired = repairJson(candidate);
    if (repaired !== candidate) {
      try {
        const value = JSON.parse(repaired);
        return { value: value, warnings: warnings.concat(['已自动修复模型输出的 JSON 格式问题']) };
      } catch (error) { /* 继续 */ }
    }
  }
  throw new Error('无法从模型输出中解析出合法 JSON');
}

function balancedObject(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function repairJson(text) {
  let fixed = String(text).trim();
  fixed = fixed.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  fixed = fixed.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  if (fixed.startsWith('{') && !fixed.endsWith('}')) fixed += '}';
  return fixed;
}

/* -------------------------------------------------------------------- 提示词 */

const SYSTEM_PROMPT = [
  '你是一名考研材料整理助手，服务于 408、政治、数学、英语四科的学习材料归档系统。',
  '',
  '你的任务：阅读用户提供的学习材料原文，输出结构化整理结果，并从给定的分类体系中推荐最合适的科目、章节和材料类型。',
  '',
  '严格要求：',
  '1. 只能使用下方"可选分类体系"中列出的 id，不得编造 id。',
  '2. 如果分类体系中没有合适的选项，把该项的 id 设为 null，并把建议的新名称填到 suggested_new 字段。',
  '3. 不得修改、删除或改写用户原文；整理的正文放在 organized_body 字段中，原文由系统单独保存。',
  '4. 无法判断时请降低 confidence（0~1）并在 warnings 中说明原因，不要强行猜测。',
  '5. 只输出一个 JSON 对象，不要输出任何解释性文字或 markdown 代码块。',
  '',
  '输出 JSON 结构（字段必须齐全）：',
  '{',
  '  "title": "为材料拟一个简短准确的中文标题",',
  '  "summary": "80 字以内的中文摘要",',
  '  "organized_body": "在保留原文全部事实的前提下整理成条理清晰的正文",',
  '  "key_points": ["要点1", "要点2"],',
  '  "formulas": ["涉及的公式或定理，没有则空数组"],',
  '  "questions": ["材料中的题目题干，没有则空数组"],',
  '  "subject": {"id": "subject id 或 null", "name": "科目名称"},',
  '  "chapter": {"id": "chapter id 或 null", "name": "章节名称", "path": "章节路径"},',
  '  "material_type": {"id": "类型 id 或 null", "name": "类型名称"},',
  '  "suggested_new": {"subject": null, "chapter": null, "material_type": null},',
  '  "tags": ["3 个以内的短标签"],',
  '  "importance": 0,',
  '  "confidence": 0.0,',
  '  "reason": "给出推荐理由，一句话",',
  '  "warnings": []',
  '}',
  '',
  'importance 取值 0~5，5 表示最需要重点复习。'
].join('\n');

export function buildTaxonomyBlock(taxonomy) {
  const lines = ['可选分类体系：', ''];
  lines.push('【科目 subjects】');
  (taxonomy.subjects || []).forEach(function (subject) {
    lines.push('- id=' + subject.id + ' | ' + subject.name);
  });
  lines.push('');
  lines.push('【章节 chapters】（格式：id | 科目 | 路径）');
  (taxonomy.subjects || []).forEach(function (subject) {
    // 兼容两种分类体系形态：科目内嵌 chapters，或顶层平铺 chapters 按 subject_id 归属
    let chapters = Array.isArray(subject.chapters) ? subject.chapters : [];
    if (!chapters.length) {
      chapters = (taxonomy.chapters || [])
        .filter(function (chapter) { return chapter.subject_id === subject.id; })
        .map(function (chapter) {
          return { id: chapter.id, name: chapter.name, path: chapter.path || chapter.name };
        });
    }
    if (!chapters.length) return;
    lines.push('科目 ' + subject.name + '：');
    chapters.forEach(function (chapter) {
      lines.push('  - id=' + chapter.id + ' | ' + (chapter.path || chapter.name));
    });
  });
  lines.push('');
  lines.push('【材料类型 material_types】（subject_id 为 null 表示所有科目通用）');
  (taxonomy.types || []).forEach(function (item) {
    lines.push('- id=' + item.id + ' | ' + item.name + ' | subject_id=' + (item.subject_id || 'null'));
  });
  lines.push('');
  const tagNames = (taxonomy.tags || []).map(function (tag) { return tag.name; });
  lines.push('【可用标签 tags】' + (tagNames.length ? tagNames.join('、') : '（暂无）'));
  return lines.join('\n');
}

export function buildMessages(input) {
  const parts = [
    buildTaxonomyBlock(input.taxonomy),
    '',
    '===== 待整理材料 =====',
    '标题：' + (input.title || '未命名材料')
  ];
  if (input.sourceDetail) parts.push('来源：' + input.sourceDetail);
  parts.push('');
  parts.push(truncate(input.body || '', input.maxInputChars || 12000));
  parts.push('===== 材料结束 =====');
  if (input.instruction) {
    parts.push('');
    parts.push('用户补充要求：' + input.instruction);
  }
  parts.push('');
  parts.push('请按要求只输出一个 JSON 对象。');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n') }
  ];
}

export function buildRepairMessages(previous) {
  return [
    { role: 'system', content: '你是一个 JSON 格式修复器。只输出合法 JSON 对象，不要任何解释。' },
    {
      role: 'user',
      content: '下面这段内容本应是合法 JSON，但解析失败。请修复它并只输出修复后的 JSON 对象，保持原有字段与含义不变：\n\n'
        + String(previous).slice(0, 6000)
    }
  ];
}

/* ------------------------------------------------------------------ 网络调用 */

function statusToCode(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

async function postOnce(options) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, options.timeoutMs);
  const started = Date.now();
  try {
    const response = await options.fetchImpl(options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + options.apiKey
      },
      body: JSON.stringify(options.payload),
      signal: controller.signal
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new AIError(
        'DeepSeek 接口返回 HTTP ' + response.status + (bodyText ? '：' + bodyText.slice(0, 300) : ''),
        statusToCode(response.status),
        { http_status: response.status, body: bodyText.slice(0, 300) },
        RETRYABLE_CODES.indexOf(statusToCode(response.status)) >= 0
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (error) {
      throw new AIError('DeepSeek 返回的不是合法 JSON 响应', 'bad_response', {}, true);
    }
    const choice = (parsed.choices || [])[0];
    const content = choice && choice.message ? choice.message.content : null;
    if (typeof content !== 'string') {
      throw new AIError('DeepSeek 响应中没有文本内容', 'bad_response', {}, false);
    }
    return {
      text: content,
      model: parsed.model || options.model,
      usage: parsed.usage || {},
      latencyMs: Date.now() - started
    };
  } catch (error) {
    if (error instanceof AIError) throw error;
    if (error && error.name === 'AbortError') {
      throw new AIError('调用 DeepSeek 超时（' + options.timeoutMs + ' 毫秒）', 'timeout',
        { timeout_ms: options.timeoutMs }, true);
    }
    throw new AIError('网络异常，无法连接 DeepSeek：' + (error && error.message ? error.message : error),
      'network', { reason: String(error) }, true);
  } finally {
    clearTimeout(timer);
  }
}

export async function callDeepSeek(options) {
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey) throw new AIError('尚未配置 DeepSeek API Key', 'no_api_key', {}, false);

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new AIError('当前环境不支持 fetch', 'unknown', {}, false);

  const base = String(options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const payload = {
    model: options.model || 'deepseek-chat',
    messages: options.messages,
    temperature: options.temperature === undefined ? 0.2 : options.temperature,
    max_tokens: options.maxTokens || 2400,
    stream: false,
    response_format: { type: 'json_object' }
  };

  const maxRetries = options.maxRetries === undefined ? 2 : options.maxRetries;
  let attempts = 0;
  let lastError = null;

  while (attempts <= maxRetries) {
    attempts += 1;
    try {
      const result = await postOnce({
        url: url,
        payload: payload,
        apiKey: apiKey,
        timeoutMs: options.timeoutMs || 45000,
        model: payload.model,
        fetchImpl: fetchImpl
      });
      result.attempts = attempts;
      return result;
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempts > maxRetries) break;
      const wait = Math.min(6000, 1000 * Math.pow(2, attempts - 1));
      await new Promise(function (resolve) { setTimeout(resolve, wait); });
    }
  }
  lastError.details = Object.assign({}, lastError.details, { attempts: attempts });
  throw lastError;
}

/* ------------------------------------------------------------------ 结果归一化 */

function asName(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return String(value.name || '').trim();
  return String(value).trim();
}

function asId(value) {
  return (value && typeof value === 'object' && value.id) ? String(value.id) : null;
}

function match(rows, value, filter) {
  const pool = filter ? rows.filter(filter) : rows;
  const id = asId(value);
  const name = asName(value);
  if (id) {
    for (let i = 0; i < pool.length; i += 1) if (pool[i].id === id) return { row: pool[i], missing: null };
  }
  if (name) {
    const lowered = name.toLowerCase();
    for (let i = 0; i < pool.length; i += 1) {
      if (String(pool[i].name).toLowerCase() === lowered) return { row: pool[i], missing: null };
    }
    for (let i = 0; i < pool.length; i += 1) {
      const rowName = String(pool[i].name).toLowerCase();
      if (rowName.indexOf(lowered) >= 0 || lowered.indexOf(rowName) >= 0) return { row: pool[i], missing: null };
    }
  }
  return { row: null, missing: name || null };
}

function stringList(value, limit) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map(function (item) { return String(item).trim(); }).filter(Boolean).slice(0, limit);
}

export function normalizeResult(raw, taxonomy) {
  if (!raw || typeof raw !== 'object') throw new Error('模型输出的 JSON 不是对象');
  const warnings = (raw.warnings || []).map(String).filter(Boolean);

  const subjectMatch = match(taxonomy.subjects || [], raw.subject);
  const subjectRow = subjectMatch.row;
  const chapterMatch = raw.chapter
    ? (subjectRow
      ? match(taxonomy.chapters || [], raw.chapter, function (row) { return row.subject_id === subjectRow.id; })
      : match(taxonomy.chapters || [], raw.chapter))
    : { row: null, missing: null };
  let chapterRow = chapterMatch.row;
  let chapterMissing = chapterMatch.missing;
  if (!chapterRow && raw.chapter) {
    const fallback = match(taxonomy.chapters || [], raw.chapter);
    chapterRow = fallback.row;
    chapterMissing = fallback.missing;
  }
  const typeMatch = match(taxonomy.types || [], raw.material_type || raw.type);

  const suggestedNew = (raw.suggested_new && typeof raw.suggested_new === 'object') ? raw.suggested_new : {};
  const suggested = {};
  [['subject', subjectMatch.missing], ['chapter', chapterMissing], ['material_type', typeMatch.missing]]
    .forEach(function (pair) {
      const value = suggestedNew[pair[0]] ? String(suggestedNew[pair[0]]).trim() : '';
      if (value) suggested[pair[0]] = value;
      else if (pair[1]) suggested[pair[0]] = pair[1];
    });

  if (!subjectRow) warnings.push('AI 未能匹配到已有科目，请人工选择或新建科目。');
  if (subjectRow && !chapterRow) warnings.push('AI 未能匹配到已有章节，请人工选择或新建章节。');

  const knownTags = {};
  (taxonomy.tags || []).forEach(function (tag) { knownTags[tag.name] = true; });
  const rawTags = Array.isArray(raw.tags) ? raw.tags
    : (typeof raw.tags === 'string' ? raw.tags.split(/[，,]/) : []);
  const tags = unique(rawTags.map(function (item) { return String(item).trim(); })).slice(0, 8);
  tags.forEach(function (name) { if (!knownTags[name]) suggested['tag:' + name] = name; });

  return {
    title: String(raw.title || '').trim(),
    summary: String(raw.summary || '').trim(),
    organized_body: String(raw.organized_body || raw.content || '').trim(),
    key_points: stringList(raw.key_points, 20),
    formulas: stringList(raw.formulas, 20),
    questions: stringList(raw.questions, 30),
    subject: subjectRow ? { id: subjectRow.id, name: subjectRow.name } : null,
    chapter: chapterRow ? {
      id: chapterRow.id,
      name: chapterRow.name,
      path: (taxonomy.chapters || []).length ? '' : chapterRow.name
    } : null,
    material_type: typeMatch.row ? { id: typeMatch.row.id, name: typeMatch.row.name } : null,
    suggested_new: suggested,
    tags: tags,
    importance: Math.max(0, Math.min(5, parseInt(raw.importance, 10) || 0)),
    confidence: Math.max(0, Math.min(1, parseFloat(raw.confidence) || 0)),
    reason: String(raw.reason || '').trim(),
    warnings: unique(warnings)
  };
}
