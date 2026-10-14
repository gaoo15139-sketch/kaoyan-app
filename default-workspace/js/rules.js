/* 离线规则引擎：未配置 API Key 或网络不可用时仍能给出分类建议。
 * 完全由用户自定义的分类体系数据驱动，代码里没有任何写死的科目或章节。
 */
import { parseKeywords, truncate, unique } from './util.js';

const SPLIT = /[\s，,。；;、！!？?：:（）()【】「」<>《》/|+\-—_=*&^%$#@~]+/;
const IMPORTANCE_MARKERS = [
  [/必考|重中之重|核心考点|高频考点|重点掌握/, 5],
  [/重点|常考|易错|典型例题|必须记住/, 4],
  [/了解|熟悉一下|选学|拓展/, 2]
];
const QUESTION_MARKER = /^[（(]?[0-9]{1,2}[）).、]|下列|以下哪|求|证明/;
const FORMULA_MARKER = /[=＝]|定理|公式|推论/;

export function tokens(text) {
  return SPLIT.split(String(text || '')).filter(Boolean);
}

function score(text, row, nameWeight, keywordWeight) {
  let total = 0;
  const hits = [];
  const name = String(row.name || '').trim();
  if (name && text.includes(name.toLowerCase())) {
    total += nameWeight;
    hits.push(name);
  }
  parseKeywords(row.keywords).forEach(function (keyword) {
    const k = String(keyword).trim().toLowerCase();
    if (k && text.includes(k)) {
      total += keywordWeight;
      hits.push(keyword);
    }
  });
  const code = String(row.code || '').trim();
  if (code.length >= 2 && text.includes(code.toLowerCase())) {
    total += nameWeight;
    hits.push(code);
  }
  return { total: total, hits: hits };
}

export function chapterPathText(chapters, chapterId, separator) {
  const map = {};
  chapters.forEach(function (item) { map[item.id] = item; });
  const names = [];
  let current = map[chapterId];
  let guard = 0;
  while (current && guard < 32) {
    names.unshift(current.name);
    current = current.parent_id ? map[current.parent_id] : null;
    guard += 1;
  }
  return names.join(separator || ' / ');
}

export function analyzeLocally(input) {
  const chapters = input.chapters || [];
  const text = truncate(input.body || '', input.maxInputChars || 12000, '');
  const window = (String(input.title || '') + ' ' + text).toLowerCase();
  const warnings = [];

  let best = null;
  (input.subjects || []).forEach(function (subject) {
    const result = score(window, subject, 8, 4);
    if (!best || result.total > best.total) best = { subject: subject, total: result.total, hits: result.hits };
  });

  let subject = null;
  let chapter = null;
  let materialType = null;
  let confidence = 0;

  if (best && best.total > 0) {
    subject = { id: best.subject.id, name: best.subject.name };
    let top = best.total;

    let bestChapter = null;
    chapters.filter(function (item) { return item.subject_id === best.subject.id; }).forEach(function (item) {
      const result = score(window, item, 7, 4);
      if (result.total > 0 && (!bestChapter || result.total > bestChapter.total)) {
        bestChapter = { row: item, total: result.total };
      }
    });
    if (bestChapter) {
      chapter = {
        id: bestChapter.row.id,
        name: bestChapter.row.name,
        path: chapterPathText(chapters, bestChapter.row.id)
      };
      top = Math.max(top, bestChapter.total);
    }

    let bestType = null;
    (input.types || []).filter(function (item) {
      return item.subject_id === null || item.subject_id === undefined || item.subject_id === best.subject.id;
    }).forEach(function (item) {
      const result = score(window, item, 5, 3);
      if (result.total > 0 && (!bestType || result.total > bestType.total)) {
        bestType = { row: item, total: result.total };
      }
    });
    if (bestType) {
      materialType = { id: bestType.row.id, name: bestType.row.name };
      top = Math.max(top, bestType.total);
    }

    confidence = Math.round(Math.min(0.85, 0.25 + top / 40) * 100) / 100;
  } else {
    warnings.push('离线规则引擎未能从原文中识别出科目，请手动选择分类。');
  }

  const tagNames = (input.tags || []).filter(function (tag) {
    return tag.name && text.includes(tag.name);
  }).slice(0, 3).map(function (tag) { return tag.name; });

  let importance = 1;
  for (let i = 0; i < IMPORTANCE_MARKERS.length; i += 1) {
    if (IMPORTANCE_MARKERS[i][0].test(text)) { importance = IMPORTANCE_MARKERS[i][1]; break; }
  }
  if (!text.trim()) {
    warnings.push('材料内容为空，无法进行有效分析。');
    importance = 0;
  }

  const lines = String(input.body || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
  let keyPoints = [];
  lines.forEach(function (line) {
    const stripped = line.replace(/^[-*0-9.、)\s]+/, '').trim();
    if (stripped.length >= 4 && stripped.length <= 80 && stripped !== line && keyPoints.length < 8) {
      keyPoints.push(stripped);
    }
  });
  if (!keyPoints.length) keyPoints = lines.slice(0, 3).map(function (line) { return truncate(line, 60, ''); });

  return {
    title: String(input.title || '').trim() || '未命名材料',
    summary: truncate(lines.join(' ').slice(0, 200), 200, ''),
    organized_body: text,
    key_points: keyPoints,
    formulas: lines.filter(function (line) { return FORMULA_MARKER.test(line); }).slice(0, 6),
    questions: lines.filter(function (line) { return QUESTION_MARKER.test(line); }).slice(0, 8),
    subject: subject,
    chapter: chapter,
    material_type: materialType,
    suggested_new: {},
    tags: unique(tagNames),
    importance: importance,
    confidence: confidence,
    reason: '离线规则引擎根据名称与关键词匹配得到：' + (best && best.hits.length ? best.hits.slice(0, 5).join('、') : '无匹配'),
    warnings: warnings,
    _provider: 'mock'
  };
}
