/* 业务逻辑层：分类体系、材料、原文、AI 结果、审核流程、检索、导出。
 * 从原来的 Python 后端移植过来，语义保持一致，只是存储换成 IndexedDB。
 */
import {
  newId, nowIso, hashText, deriveTitle, normalizeWhitespace, truncate, unique,
  clamp, asInt, asFloat, parseKeywords, splitTokens, plainSnippet, csvCell
} from './util.js';
import { analyzeLocally, chapterPathText } from './rules.js';
import * as AI from './ai.js';

export const APP_VERSION = '0.2.0';
export const PROMPT_VERSION = AI.PROMPT_VERSION;

export const DEFAULT_SETTINGS = {
  'ai.provider': 'auto',
  'ai.base_url': 'https://api.deepseek.com',
  'ai.model': 'deepseek-chat',
  'ai.api_key': '',
  'ai.timeout_seconds': '45',
  'ai.max_retries': '2',
  'ai.max_input_chars': '12000',
  'ai.temperature': '0.2'
};

export const VALID_STATUS = ['inbox', 'reviewing', 'archived', 'rejected'];
export const VALID_PROCESSING = ['raw', 'pending', 'analyzed', 'failed', 'reviewed'];

const SEED_SUBJECTS = [
  { name: '408 计算机学科专业基础综合', code: '408', color: '#2563eb',
    keywords: ['408', '数据结构', '计算机组成原理', '操作系统', '计算机网络', '计网', '计组', '机组', '考研计算机'],
    chapters: [
      ['数据结构', ['线性表', '栈与队列', '树与二叉树', '图', '查找', '排序']],
      ['计算机组成原理', ['数据的表示和运算', '存储系统', '指令系统', '中央处理器', '总线', '输入输出系统']],
      ['操作系统', ['进程与线程', '内存管理', '文件管理', '输入输出管理']],
      ['计算机网络', ['体系结构', '物理层', '数据链路层', '网络层', '传输层', '应用层']]
    ] },
  { name: '政治', code: 'POLITICS', color: '#dc2626',
    keywords: ['政治', '马原', '毛中特', '史纲', '思修', '法治', '时政', '马克思主义', '中国特色社会主义'],
    chapters: [
      ['马克思主义基本原理', ['辩证唯物主义', '认识论', '唯物史观', '政治经济学', '科学社会主义']],
      ['毛泽东思想和中国特色社会主义理论体系概论', ['毛泽东思想', '邓小平理论', '新时代中国特色社会主义思想']],
      ['中国近现代史纲要', ['近代史', '新民主主义革命', '社会主义建设']],
      ['思想道德与法治', ['人生观价值观', '道德', '法治']],
      ['形势与政策以及当代世界经济与政治', ['年度时政', '国际热点']]
    ] },
  { name: '数学', code: 'MATH', color: '#059669',
    keywords: ['数学', '高数', '高等数学', '线性代数', '线代', '概率论', '数理统计', '微积分', '数一', '数二', '数三'],
    chapters: [
      ['高等数学', ['函数极限与连续', '一元微积分', '多元微积分', '空间解析几何', '级数', '常微分方程']],
      ['线性代数', ['行列式', '矩阵', '向量', '线性方程组', '特征值与特征向量', '二次型']],
      ['概率论与数理统计', ['随机事件与概率', '随机变量及其分布', '数字特征', '大数定律与中心极限定理', '数理统计']]
    ] },
  { name: '英语', code: 'ENGLISH', color: '#7c3aed',
    keywords: ['英语', '完形填空', '阅读理解', '新题型', '翻译', '写作', '单词', '词汇', '长难句', '作文'],
    chapters: [
      ['完形填空', []],
      ['阅读理解', ['Text 1', 'Text 2', 'Text 3', 'Text 4']],
      ['新题型', []],
      ['翻译', []],
      ['写作', ['小作文', '大作文']],
      ['词汇与长难句', ['核心词汇', '长难句分析']]
    ] }
];

const SEED_TYPES = [
  ['知识点笔记', ['笔记', '知识点', '总结', '梳理']],
  ['真题', ['真题', '历年']],
  ['模拟题', ['模拟', '押题', '预测卷']],
  ['错题整理', ['错题', '易错', '做错']],
  ['公式定理', ['公式', '定理', '法则']],
  ['单词词汇', ['单词', '词汇', '背诵']],
  ['长难句', ['长难句', '句式']],
  ['作文模板', ['模板', '范文', '作文']],
  ['时政要闻', ['时政', '新闻', '会议']],
  ['视频课程笔记', ['课程', '视频', '网课']],
  ['其他', []]
];

const SEED_TAGS = ['重点', '易错', '待复习', '已掌握', '高频考点', '需背诵'];

export class Repository {
  constructor(driver) {
    this.db = driver;
    this._all = null;
    this._tax = null;
    this._settings = null;
  }

  _invalidate() { this._all = null; }
  _invalidateTaxonomy() { this._tax = null; this._all = null; }

  displayError(error) {
    if (error && error.name === 'ConstraintError') return '存在重复的名称或键，请换一个再试';
    return (error && error.message) ? error.message : String(error);
  }

  /* ------------------------------------------------------------------ 初始化 */

  async init() {
    const count = await this.db.count('subjects');
    if (count === 0) await this._seed();
  }

  async _seed() {
    const ts = nowIso();
    let order = 0;
    for (const subject of SEED_SUBJECTS) {
      const subjectId = newId('sub_');
      await this.db.put('subjects', {
        id: subjectId, name: subject.name, code: subject.code, color: subject.color,
        description: '', keywords: JSON.stringify(subject.keywords), sort_order: order,
        is_archived: 0, created_at: ts, updated_at: ts
      });
      order += 1;
      let chapterOrder = 0;
      for (const entry of subject.chapters) {
        const parentId = newId('chp_');
        await this.db.put('chapters', {
          id: parentId, subject_id: subjectId, parent_id: null, name: entry[0], code: '',
          description: '', keywords: '[]', sort_order: chapterOrder, is_archived: 0,
          created_at: ts, updated_at: ts
        });
        chapterOrder += 1;
        let childOrder = 0;
        for (const childName of entry[1]) {
          await this.db.put('chapters', {
            id: newId('chp_'), subject_id: subjectId, parent_id: parentId, name: childName, code: '',
            description: '', keywords: '[]', sort_order: childOrder, is_archived: 0,
            created_at: ts, updated_at: ts
          });
          childOrder += 1;
        }
      }
    }
    let typeOrder = 0;
    for (const entry of SEED_TYPES) {
      await this.db.put('material_types', {
        id: newId('typ_'), subject_id: null, name: entry[0], code: '', description: '',
        keywords: JSON.stringify(entry[1]), sort_order: typeOrder, is_archived: 0,
        created_at: ts, updated_at: ts
      });
      typeOrder += 1;
    }
    for (const name of SEED_TAGS) {
      await this.db.put('tags', { id: newId('tag_'), name: name, color: '', created_at: ts });
    }
    this._invalidateTaxonomy();
  }

  /* -------------------------------------------------------------------- 设置 */

  async getSettings() {
    if (this._settings) return this._settings;
    const rows = await this.db.getAll('settings');
    const stored = {};
    rows.forEach(function (row) { stored[row.key] = row.value; });
    this._settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    return this._settings;
  }

  async saveSettings(patch) {
    const ts = nowIso();
    for (const key of Object.keys(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      await this.db.put('settings', { key: key, value: String(patch[key]), updated_at: ts });
    }
    this._settings = null;
    return this.getSettings();
  }

  async resolveProvider() {
    const settings = await this.getSettings();
    const provider = String(settings['ai.provider'] || 'auto').toLowerCase();
    if (provider === 'deepseek' || provider === 'mock' || provider === 'off') return provider;
    return String(settings['ai.api_key'] || '').trim() ? 'deepseek' : 'mock';
  }

  /* ---------------------------------------------------------------- 分类体系 */

  async _taxonomy() {
    if (this._tax) return this._tax;
    const [subjects, chapters, types, tags, sources] = await Promise.all([
      this.db.getAll('subjects'), this.db.getAll('chapters'),
      this.db.getAll('material_types'), this.db.getAll('tags'), this.db.getAll('sources')
    ]);
    const sort = function (a, b) {
      return (a.sort_order - b.sort_order) || String(a.name).localeCompare(String(b.name), 'zh');
    };
    this._tax = {
      subjects: subjects.filter(function (s) { return !s.is_archived; }).sort(sort),
      allSubjects: subjects.sort(sort),
      chapters: chapters.filter(function (c) { return !c.is_archived; }).sort(sort),
      allChapters: chapters,
      types: types.filter(function (t) { return !t.is_archived; }).sort(sort),
      allTypes: types,
      tags: tags.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); }),
      sources: sources.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); })
    };
    return this._tax;
  }

  async listSubjects(includeArchived) {
    const tax = await this._taxonomy();
    return includeArchived ? tax.allSubjects.slice() : tax.subjects.slice();
  }

  async createSubject(data) {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('科目名称不能为空');
    const tax = await this._taxonomy();
    if (tax.allSubjects.some(function (s) { return s.name === name; })) throw new Error('科目名称已存在：' + name);
    const ts = nowIso();
    const row = {
      id: newId('sub_'), name: name, code: String(data.code || ''), color: String(data.color || ''),
      description: String(data.description || ''),
      keywords: JSON.stringify(unique(parseKeywords(data.keywords))),
      sort_order: tax.allSubjects.length, is_archived: 0, created_at: ts, updated_at: ts
    };
    await this.db.put('subjects', row);
    this._invalidateTaxonomy();
    return row;
  }

  async updateSubject(id, patch) {
    const row = await this.db.get('subjects', id);
    if (!row) throw new Error('科目不存在');
    const next = Object.assign({}, row);
    if (patch.name !== undefined) next.name = String(patch.name).trim();
    if (patch.code !== undefined) next.code = String(patch.code || '');
    if (patch.color !== undefined) next.color = String(patch.color || '');
    if (patch.keywords !== undefined) next.keywords = JSON.stringify(unique(parseKeywords(patch.keywords)));
    if (patch.is_archived !== undefined) next.is_archived = patch.is_archived ? 1 : 0;
    next.updated_at = nowIso();
    await this.db.put('subjects', next);
    this._invalidateTaxonomy();
    return next;
  }

  async deleteSubject(id) {
    const tax = await this._taxonomy();
    const used = (await this.db.getAll('material_classification')).filter(function (c) { return c.subject_id === id; });
    if (used.length) throw new Error('该科目下还有 ' + used.length + ' 条材料，请先调整这些材料');
    for (const type of tax.allTypes.filter(function (t) { return t.subject_id === id; })) await this.db.delete('material_types', type.id);
    for (const chapter of tax.allChapters.filter(function (c) { return c.subject_id === id; })) await this.db.delete('chapters', chapter.id);
    await this.db.delete('subjects', id);
    this._invalidateTaxonomy();
  }

  async listChapters(subjectId, includeArchived) {
    const tax = await this._taxonomy();
    let list = includeArchived ? tax.allChapters : tax.chapters;
    if (subjectId) list = list.filter(function (c) { return c.subject_id === subjectId; });
    return list.slice();
  }

  async chapterPath(chapterId) {
    const tax = await this._taxonomy();
    return chapterPathText(tax.allChapters, chapterId).split(' / ').filter(Boolean);
  }

  async createChapter(data) {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('章节名称不能为空');
    let subjectId = data.subject_id || null;
    const parentId = data.parent_id || null;
    const tax = await this._taxonomy();
    if (parentId) {
      const parent = tax.allChapters.find(function (c) { return c.id === parentId; });
      if (!parent) throw new Error('上级章节不存在');
      if (!subjectId) subjectId = parent.subject_id;
    }
    if (!subjectId) throw new Error('章节必须属于某个科目');
    const ts = nowIso();
    const row = {
      id: newId('chp_'), subject_id: subjectId, parent_id: parentId, name: name,
      code: '', description: '', keywords: '[]',
      sort_order: tax.allChapters.filter(function (c) { return c.parent_id === parentId; }).length,
      is_archived: 0, created_at: ts, updated_at: ts
    };
    await this.db.put('chapters', row);
    this._invalidateTaxonomy();
    return row;
  }

  async updateChapter(id, patch) {
    const row = await this.db.get('chapters', id);
    if (!row) throw new Error('章节不存在');
    const next = Object.assign({}, row);
    if (patch.name !== undefined) next.name = String(patch.name).trim();
    if (patch.keywords !== undefined) next.keywords = JSON.stringify(unique(parseKeywords(patch.keywords)));
    if (patch.is_archived !== undefined) next.is_archived = patch.is_archived ? 1 : 0;
    next.updated_at = nowIso();
    await this.db.put('chapters', next);
    this._invalidateTaxonomy();
    return next;
  }

  async deleteChapter(id) {
    const used = (await this.db.getAll('material_classification')).filter(function (c) { return c.chapter_id === id; });
    if (used.length) throw new Error('该章节下还有 ' + used.length + ' 条材料，请先调整这些材料');
    const tax = await this._taxonomy();
    for (const child of tax.allChapters.filter(function (c) { return c.parent_id === id; })) {
      await this.db.delete('chapters', child.id);
    }
    await this.db.delete('chapters', id);
    this._invalidateTaxonomy();
  }

  async listTypes(subjectId, includeArchived) {
    const tax = await this._taxonomy();
    let list = includeArchived ? tax.allTypes : tax.types;
    if (subjectId) {
      list = list.filter(function (t) { return !t.subject_id || t.subject_id === subjectId; });
    }
    return list.slice();
  }

  async createType(data) {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('类型名称不能为空');
    const ts = nowIso();
    const tax = await this._taxonomy();
    const subjectId = data.subject_id || null;
    if (tax.allTypes.some(function (t) { return t.name === name && (t.subject_id || null) === subjectId; })) {
      throw new Error('该范围内已存在同名材料类型：' + name);
    }
    const row = {
      id: newId('typ_'), subject_id: subjectId, name: name, code: '', description: '',
      keywords: JSON.stringify(unique(parseKeywords(data.keywords))),
      sort_order: tax.allTypes.length, is_archived: 0, created_at: ts, updated_at: ts
    };
    await this.db.put('material_types', row);
    this._invalidateTaxonomy();
    return row;
  }

  async updateType(id, patch) {
    const row = await this.db.get('material_types', id);
    if (!row) throw new Error('材料类型不存在');
    const next = Object.assign({}, row);
    if (patch.name !== undefined) next.name = String(patch.name).trim();
    if (patch.keywords !== undefined) next.keywords = JSON.stringify(unique(parseKeywords(patch.keywords)));
    if (patch.is_archived !== undefined) next.is_archived = patch.is_archived ? 1 : 0;
    next.updated_at = nowIso();
    await this.db.put('material_types', next);
    this._invalidateTaxonomy();
    return next;
  }

  async deleteType(id) {
    const used = (await this.db.getAll('material_classification')).filter(function (c) { return c.type_id === id; });
    if (used.length) throw new Error('该类型下还有 ' + used.length + ' 条材料，请先调整这些材料');
    await this.db.delete('material_types', id);
    this._invalidateTaxonomy();
  }

  async listTags() {
    const tax = await this._taxonomy();
    const links = await this.db.getAll('material_tags');
    const counts = {};
    links.forEach(function (link) { counts[link.tag_id] = (counts[link.tag_id] || 0) + 1; });
    return tax.tags.map(function (tag) {
      return Object.assign({}, tag, { usage_count: counts[tag.id] || 0 });
    });
  }

  async getOrCreateTag(name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('标签名不能为空');
    const tax = await this._taxonomy();
    const found = tax.tags.find(function (t) { return t.name === clean; });
    if (found) return found;
    const row = { id: newId('tag_'), name: clean, color: '', created_at: nowIso() };
    await this.db.put('tags', row);
    this._invalidateTaxonomy();
    return row;
  }

  async deleteTag(id) {
    const links = await this.db.getAll('material_tags');
    for (const link of links.filter(function (l) { return l.tag_id === id; })) await this.db.delete('material_tags', link.id);
    await this.db.delete('tags', id);
    this._invalidateTaxonomy();
  }

  async listSources() {
    const tax = await this._taxonomy();
    const materials = await this.db.getAll('materials');
    const counts = {};
    materials.forEach(function (m) {
      if (m.deleted_at) return;
      if (m.source_id) counts[m.source_id] = (counts[m.source_id] || 0) + 1;
    });
    return tax.sources.map(function (s) { return Object.assign({}, s, { usage_count: counts[s.id] || 0 }); });
  }

  async getOrCreateSource(name, kind, detail) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('来源名不能为空');
    const tax = await this._taxonomy();
    const found = tax.sources.find(function (s) { return s.name === clean; });
    if (found) return found;
    const ts = nowIso();
    const row = {
      id: newId('src_'), name: clean, kind: kind || 'other',
      detail: detail || '', created_at: ts, updated_at: ts
    };
    await this.db.put('sources', row);
    this._invalidateTaxonomy();
    return row;
  }

  async deleteSource(id) {
    const materials = await this.db.getAll('materials');
    for (const material of materials.filter(function (m) { return m.source_id === id; })) {
      material.source_id = null;
      await this.db.put('materials', material);
    }
    await this.db.delete('sources', id);
    this._invalidateTaxonomy();
    this._invalidate();
  }

  async chapterTree(subjectId) {
    const list = await this.listChapters(subjectId);
    const byId = {};
    list.forEach(function (row) { byId[row.id] = Object.assign({}, row, { children: [] }); });
    const roots = [];
    Object.keys(byId).forEach(function (key) {
      const node = byId[key];
      if (node.parent_id && byId[node.parent_id]) byId[node.parent_id].children.push(node);
      else roots.push(node);
    });
    const sortNodes = function (nodes) {
      nodes.sort(function (a, b) { return (a.sort_order - b.sort_order) || String(a.name).localeCompare(String(b.name), 'zh'); });
      nodes.forEach(function (node) { sortNodes(node.children); });
    };
    sortNodes(roots);
    return roots;
  }

  async snapshot() {
    const tax = await this._taxonomy();
    const all = await this._loadAll();
    const visible = all.materials.filter(function (m) { return !m.deleted_at; });
    const counts = { materials: visible.length, archived: 0, inbox: 0, reviewing: 0, failed: 0, pendingProposals: 0 };
    visible.forEach(function (m) {
      if (m.status === 'archived') counts.archived += 1;
      if (m.status === 'inbox') counts.inbox += 1;
      if (m.status === 'reviewing') counts.reviewing += 1;
      if (m.processing_status === 'failed') counts.failed += 1;
    });
    counts.pendingProposals = (await this.db.getAll('proposals')).filter(function (p) {
      return p.status === 'proposed' || p.status === 'staged';
    }).length;
    return {
      subjects: tax.subjects,
      chapters: tax.chapters,
      chapter_tree: await this.chapterTree(),
      types: tax.types,
      tags: await this.listTags(),
      sources: await this.listSources(),
      counts: counts
    };
  }

  /* ------------------------------------------------------------------ 材料 */

  async _loadAll() {
    if (this._all) return this._all;
    const [materials, classifications, tags, links, searchIndex] = await Promise.all([
      this.db.getAll('materials'), this.db.getAll('material_classification'),
      this.db.getAll('tags'), this.db.getAll('material_tags'), this.db.getAll('search_index')
    ]);
    const classMap = {};
    classifications.forEach(function (c) { classMap[c.material_id] = c; });
    const tagMap = {};
    tags.forEach(function (t) { tagMap[t.id] = t; });
    const tagsByMaterial = {};
    links.forEach(function (link) {
      (tagsByMaterial[link.material_id] = tagsByMaterial[link.material_id] || []).push(link.tag_id);
    });
    const indexMap = {};
    searchIndex.forEach(function (row) { indexMap[row.material_id] = row; });
    this._all = { materials: materials, classMap: classMap, tagMap: tagMap, tagsByMaterial: tagsByMaterial, indexMap: indexMap };
    return this._all;
  }

  async getMaterialRow(id, includeDeleted) {
    const row = await this.db.get('materials', id);
    if (!row || (row.deleted_at && !includeDeleted)) throw new Error('材料不存在');
    return row;
  }

  async getTagsFor(materialId) {
    const all = await this._loadAll();
    return (all.tagsByMaterial[materialId] || [])
      .map(function (tagId) { return all.tagMap[tagId]; })
      .filter(Boolean)
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); });
  }

  async logAudit(entityType, entityId, action, before, after) {
    await this.db.put('audit_log', {
      entity_type: entityType, entity_id: entityId, action: action,
      before_json: before ? JSON.stringify(before) : null,
      after_json: after ? JSON.stringify(after) : null,
      created_at: nowIso()
    });
  }

  async refreshSearchIndex(materialId) {
    const material = await this.db.get('materials', materialId);
    if (!material) return;
    const tax = await this._taxonomy();
    const [rawRows, reviewRows, classification, tags] = await Promise.all([
      this.db.getByIndex('material_raw', 'material_id', materialId),
      this.db.getByIndex('material_reviews', 'material_id', materialId),
      this.db.get('material_classification', materialId),
      this.getTagsFor(materialId)
    ]);
    const bodies = rawRows.map(function (row) { return row.body || ''; })
      .concat(reviewRows.map(function (row) { return row.body || ''; }));
    const extra = [material.source_detail || '', material.note || ''];
    tags.forEach(function (tag) { extra.push(tag.name); });
    if (classification) {
      const subject = tax.allSubjects.find(function (s) { return s.id === classification.subject_id; });
      const chapter = tax.allChapters.find(function (c) { return c.id === classification.chapter_id; });
      const type = tax.allTypes.find(function (t) { return t.id === classification.type_id; });
      if (subject) extra.push(subject.name);
      if (chapter) extra.push(chapter.name);
      if (type) extra.push(type.name);
      chapterPathText(tax.allChapters, classification.chapter_id).split(' / ').forEach(function (part) {
        if (part) extra.push(part);
      });
    }
    await this.db.put('search_index', {
      material_id: materialId,
      title: String(material.title || ''),
      body: bodies.join('\n\n'),
      extra: extra.filter(Boolean).join(' '),
      updated_at: nowIso()
    });
    this._invalidate();
  }

  async _nextRawRevision(materialId) {
    const rows = await this.db.getByIndex('material_raw', 'material_id', materialId);
    let max = 0;
    rows.forEach(function (row) { if (row.revision > max) max = row.revision; });
    return max + 1;
  }

  async createMaterial(payload) {
    const body = String(payload.text === undefined || payload.text === null ? (payload.body || '') : payload.text);
    const title = String(payload.title || '').trim() || deriveTitle(body, '未命名材料');
    const idempotencyKey = payload.idempotency_key ? String(payload.idempotency_key) : null;

    if (idempotencyKey) {
      const existing = (await this.db.getByIndex('materials', 'idempotency_key', idempotencyKey))
        .filter(function (m) { return !m.deleted_at; })[0];
      if (existing) {
        return { material_id: existing.id, bundle: await this.getBundle(existing.id), duplicate_submission: true, duplicates: [] };
      }
    }

    const contentHash = hashText(body);
    const duplicates = (await this.db.getByIndex('material_raw', 'content_hash', contentHash))
      .filter(function (row) { return true; });
    const duplicateList = [];
    for (const row of duplicates) {
      const material = await this.db.get('materials', row.material_id);
      if (material && !material.deleted_at) {
        duplicateList.push({ id: material.id, title: material.title, created_at: row.created_at });
      }
    }
    if (duplicateList.length && payload.reject_duplicate) {
      const error = new Error('已存在内容完全相同的材料：' + duplicateList[0].title);
      error.code = 'duplicate_content';
      error.details = { duplicates: duplicateList };
      throw error;
    }

    const now = nowIso();
    const materialId = newId('mat_');
    const rawId = newId('raw_');
    let sourceId = payload.source_id || null;
    if (!sourceId && payload.source_name) {
      sourceId = (await this.getOrCreateSource(String(payload.source_name))).id;
    }

    await this.db.put('materials', {
      id: materialId, title: title,
      status: VALID_STATUS.indexOf(payload.status) >= 0 ? payload.status : 'inbox',
      processing_status: 'raw',
      importance: clamp(asInt(payload.importance, 0), 0, 5),
      source_id: sourceId, source_detail: String(payload.source_detail || ''),
      note: String(payload.note || ''), origin: String(payload.origin || 'manual'),
      idempotency_key: idempotencyKey,
      created_at: now, updated_at: now, deleted_at: null
    });

    await this.db.put('material_raw', {
      id: rawId, material_id: materialId, revision: 1, content_type: 'text/plain',
      title: title, body: body, content_hash: contentHash,
      char_count: body.length, origin: String(payload.origin || 'manual'),
      file_name: payload.file_name || null, created_at: now
    });

    await this.setClassification(materialId, {
      subject_id: payload.subject_id || null,
      chapter_id: payload.chapter_id || null,
      type_id: payload.type_id || null,
      importance: asInt(payload.importance, 0),
      decided_by: String(payload.decided_by || 'user')
    }, true);

    if (payload.tags && payload.tags.length) await this.setTags(materialId, payload.tags);

    await this.refreshSearchIndex(materialId);
    await this.logAudit('material', materialId, 'create', null, { title: title });
    return {
      material_id: materialId, raw_id: rawId, duplicate_submission: false,
      duplicates: duplicateList, bundle: await this.getBundle(materialId)
    };
  }

  async appendRaw(materialId, payload) {
    await this.getMaterialRow(materialId);
    const text = String(payload.text || '');
    if (!text.trim()) throw new Error('追加的原始材料内容不能为空');
    const now = nowIso();
    await this.db.put('material_raw', {
      id: newId('raw_'), material_id: materialId, revision: await this._nextRawRevision(materialId),
      content_type: 'text/plain', title: payload.title || null, body: text,
      content_hash: hashText(text), char_count: text.length,
      origin: String(payload.origin || 'manual'), file_name: null, created_at: now
    });
    const material = await this.db.get('materials', materialId);
    material.processing_status = 'raw';
    material.updated_at = now;
    await this.db.put('materials', material);
    await this.refreshSearchIndex(materialId);
    return this.getBundle(materialId);
  }

  async setClassification(materialId, payload, silent) {
    const tax = await this._taxonomy();
    let subjectId = payload.subject_id || null;
    const chapterId = payload.chapter_id || null;
    const typeId = payload.type_id || null;
    if (chapterId && !subjectId) {
      const chapter = tax.allChapters.find(function (c) { return c.id === chapterId; });
      if (chapter) subjectId = chapter.subject_id;
    }
    const importance = clamp(asInt(payload.importance, 0), 0, 5);
    const now = nowIso();
    await this.db.put('material_classification', {
      material_id: materialId, subject_id: subjectId, chapter_id: chapterId, type_id: typeId,
      importance: importance, decided_by: String(payload.decided_by || 'user'),
      confidence: payload.confidence === undefined ? null : payload.confidence,
      updated_at: now
    });
    const material = await this.db.get('materials', materialId);
    if (material) {
      material.importance = importance;
      if (!silent) material.updated_at = now;
      await this.db.put('materials', material);
    }
    if (!silent) await this.refreshSearchIndex(materialId);
    this._invalidate();
    return this.db.get('material_classification', materialId);
  }

  async setTags(materialId, names) {
    await this.getMaterialRow(materialId);
    const raw = Array.isArray(names) ? names
      : String(names || '').split(/[，,]/).map(function (item) { return item.trim(); });
    const cleaned = unique(raw.filter(Boolean));
    const existing = await this.db.getByIndex('material_tags', 'material_id', materialId);
    for (const link of existing) await this.db.delete('material_tags', link.id);
    for (const name of cleaned) {
      const tag = await this.getOrCreateTag(name);
      await this.db.put('material_tags', {
        id: materialId + '|' + tag.id, material_id: materialId, tag_id: tag.id, created_at: nowIso()
      });
    }
    await this.refreshSearchIndex(materialId);
    return this.getTagsFor(materialId);
  }

  async addReview(materialId, payload) {
    await this.getMaterialRow(materialId);
    const body = String(payload.body === undefined || payload.body === null ? '' : payload.body);
    const kind = String(payload.kind || 'confirmed');
    const existing = await this.db.getByIndex('material_reviews', 'material_id', materialId);
    let revision = 0;
    existing.forEach(function (row) { if (row.revision > revision) revision = row.revision; });
    const now = nowIso();
    const row = {
      id: newId('rev_'), material_id: materialId, analysis_id: payload.analysis_id || null,
      revision: revision + 1, title: payload.title || null, summary: payload.summary || null,
      body: body, kind: kind, note: payload.note || null, created_at: now
    };
    await this.db.put('material_reviews', row);
    if (kind === 'confirmed') {
      const material = await this.db.get('materials', materialId);
      material.processing_status = 'reviewed';
      material.updated_at = now;
      await this.db.put('materials', material);
    }
    await this.refreshSearchIndex(materialId);
    return row;
  }

  async updateMaterial(materialId, patch) {
    const material = await this.getMaterialRow(materialId);
    const next = Object.assign({}, material);
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw new Error('标题不能为空');
      next.title = title;
    }
    if (patch.status !== undefined) {
      if (VALID_STATUS.indexOf(patch.status) < 0) throw new Error('材料状态不合法');
      next.status = patch.status;
    }
    if (patch.note !== undefined) next.note = String(patch.note || '');
    if (patch.source_detail !== undefined) next.source_detail = String(patch.source_detail || '');
    if (patch.source_name) next.source_id = (await this.getOrCreateSource(String(patch.source_name))).id;
    next.updated_at = nowIso();
    await this.db.put('materials', next);

    if (patch.subject_id !== undefined || patch.chapter_id !== undefined
      || patch.type_id !== undefined || patch.importance !== undefined) {
      const current = (await this.db.get('material_classification', materialId)) || {};
      await this.setClassification(materialId, {
        subject_id: patch.subject_id !== undefined ? patch.subject_id : current.subject_id,
        chapter_id: patch.chapter_id !== undefined ? patch.chapter_id : current.chapter_id,
        type_id: patch.type_id !== undefined ? patch.type_id : current.type_id,
        importance: patch.importance !== undefined ? patch.importance : current.importance,
        decided_by: 'user'
      }, true);
    }
    if (patch.tags !== undefined) await this.setTags(materialId, patch.tags);
    await this.refreshSearchIndex(materialId);
    return this.getBundle(materialId);
  }

  async deleteMaterial(materialId, hard) {
    await this.getMaterialRow(materialId, true);
    if (hard) {
      const [rawRows, analyses, proposals, reviews, links] = await Promise.all([
        this.db.getByIndex('material_raw', 'material_id', materialId),
        this.db.getByIndex('ai_analyses', 'material_id', materialId),
        this.db.getByIndex('proposals', 'material_id', materialId),
        this.db.getByIndex('material_reviews', 'material_id', materialId),
        this.db.getByIndex('material_tags', 'material_id', materialId)
      ]);
      for (const row of rawRows) await this.db.delete('material_raw', row.id);
      for (const row of analyses) await this.db.delete('ai_analyses', row.id);
      for (const row of proposals) await this.db.delete('proposals', row.id);
      for (const row of reviews) await this.db.delete('material_reviews', row.id);
      for (const row of links) await this.db.delete('material_tags', row.id);
      await this.db.delete('material_classification', materialId);
      await this.db.delete('search_index', materialId);
      await this.db.delete('materials', materialId);
      this._invalidate();
      return { deleted: true };
    }
    const material = await this.db.get('materials', materialId);
    material.deleted_at = nowIso();
    material.updated_at = material.deleted_at;
    await this.db.put('materials', material);
    this._invalidate();
    return { deleted: true };
  }

  async restoreMaterial(materialId) {
    const material = await this.db.get('materials', materialId);
    if (!material) throw new Error('材料不存在');
    material.deleted_at = null;
    material.updated_at = nowIso();
    await this.db.put('materials', material);
    this._invalidate();
    return this.getBundle(materialId);
  }

  _descendantChapters(tax, chapterId) {
    const children = {};
    tax.allChapters.forEach(function (chapter) {
      const key = chapter.parent_id || '';
      (children[key] = children[key] || []).push(chapter.id);
    });
    const out = [];
    const stack = [chapterId];
    let guard = 0;
    while (stack.length && guard < 10000) {
      const current = stack.pop();
      out.push(current);
      (children[current] || []).forEach(function (child) { stack.push(child); });
      guard += 1;
    }
    return out;
  }

  async listMaterials(filters) {
    const f = filters || {};
    const all = await this._loadAll();
    const tax = await this._taxonomy();
    const page = Math.max(1, asInt(f.page, 1));
    const limit = clamp(asInt(f.limit, 20), 1, 200);
    const tokens = splitTokens(f.q);

    let rows = all.materials.filter(function (m) { return f.include_deleted || !m.deleted_at; });
    if (f.only_deleted) rows = rows.filter(function (m) { return !!m.deleted_at; });
    if (f.status) rows = rows.filter(function (m) { return m.status === f.status; });
    if (f.processing_status) {
      const wanted = String(f.processing_status).split(',');
      rows = rows.filter(function (m) { return wanted.indexOf(m.processing_status) >= 0; });
    }
    if (f.subject_id) {
      rows = rows.filter(function (m) {
        const c = all.classMap[m.id];
        return c && c.subject_id === f.subject_id;
      });
    }
    if (f.chapter_id) {
      const ids = this._descendantChapters(tax, f.chapter_id);
      rows = rows.filter(function (m) {
        const c = all.classMap[m.id];
        return c && ids.indexOf(c.chapter_id) >= 0;
      });
    }
    if (f.type_id) {
      rows = rows.filter(function (m) {
        const c = all.classMap[m.id];
        return c && c.type_id === f.type_id;
      });
    }
    if (f.source_id) rows = rows.filter(function (m) { return m.source_id === f.source_id; });
    if (f.uncategorized) {
      rows = rows.filter(function (m) {
        const c = all.classMap[m.id];
        return !c || !c.subject_id;
      });
    }
    if (f.importance_min !== undefined && f.importance_min !== null && f.importance_min !== '') {
      const min = asInt(f.importance_min, 0);
      rows = rows.filter(function (m) {
        const c = all.classMap[m.id];
        return ((c && c.importance) || m.importance || 0) >= min;
      });
    }
    if (f.tag_ids) {
      const wanted = Array.isArray(f.tag_ids) ? f.tag_ids : String(f.tag_ids).split(',');
      rows = rows.filter(function (m) {
        const owned = all.tagsByMaterial[m.id] || [];
        return wanted.some(function (tagId) { return owned.indexOf(tagId) >= 0; });
      });
    }
    if (tokens.length) {
      rows = rows.filter(function (m) {
        const index = all.indexMap[m.id] || { title: m.title, body: '', extra: '' };
        const haystack = (String(index.title) + ' ' + String(index.body) + ' ' + String(index.extra)).toLowerCase();
        return tokens.every(function (token) { return haystack.indexOf(token.toLowerCase()) >= 0; });
      });
    }

    const importanceOf = function (m) {
      const c = all.classMap[m.id];
      return (c && c.importance) || m.importance || 0;
    };
    const sortKey = f.sort || 'updated_desc';
    rows.sort(function (a, b) {
      if (sortKey === 'created_desc') return String(b.created_at).localeCompare(String(a.created_at));
      if (sortKey === 'created_asc') return String(a.created_at).localeCompare(String(b.created_at));
      if (sortKey === 'importance_desc') {
        const diff = importanceOf(b) - importanceOf(a);
        return diff !== 0 ? diff : String(b.updated_at).localeCompare(String(a.updated_at));
      }
      if (sortKey === 'title_asc') return String(a.title).localeCompare(String(b.title), 'zh');
      return String(b.updated_at).localeCompare(String(a.updated_at));
    });

    const total = rows.length;
    const start = (page - 1) * limit;
    const items = rows.slice(start, start + limit).map(function (m) {
      const classification = all.classMap[m.id] || {};
      const subject = tax.allSubjects.find(function (s) { return s.id === classification.subject_id; });
      const chapter = tax.allChapters.find(function (c) { return c.id === classification.chapter_id; });
      const type = tax.allTypes.find(function (t) { return t.id === classification.type_id; });
      const source = tax.sources.find(function (s) { return s.id === m.source_id; });
      const item = Object.assign({}, m, {
        subject_id: classification.subject_id || null,
        chapter_id: classification.chapter_id || null,
        type_id: classification.type_id || null,
        decided_by: classification.decided_by || null,
        subject_name: subject ? subject.name : '',
        subject_color: subject ? subject.color : '',
        chapter_name: chapter ? chapter.name : '',
        type_name: type ? type.name : '',
        source_name: source ? source.name : '',
        tags: (all.tagsByMaterial[m.id] || []).map(function (tagId) { return all.tagMap[tagId]; }).filter(Boolean)
      });
      if (tokens.length) {
        const index = all.indexMap[m.id] || { body: '', extra: '' };
        item.snippet = plainSnippet(String(index.body) + ' ' + String(index.extra), tokens[0]);
      }
      return item;
    });

    return {
      items: items, page: page, limit: limit, total: total,
      pages: Math.max(1, Math.ceil(total / limit)),
      has_more: page * limit < total
    };
  }

  async getBundle(materialId) {
    const material = await this.getMaterialRow(materialId, true);
    const tax = await this._taxonomy();
    const [classification, rawRows, analyses, proposals, reviews, tags] = await Promise.all([
      this.db.get('material_classification', materialId),
      this.db.getByIndex('material_raw', 'material_id', materialId),
      this.db.getByIndex('ai_analyses', 'material_id', materialId),
      this.db.getByIndex('proposals', 'material_id', materialId),
      this.db.getByIndex('material_reviews', 'material_id', materialId),
      this.getTagsFor(materialId)
    ]);
    rawRows.sort(function (a, b) { return a.revision - b.revision; });
    analyses.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
    proposals.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
    reviews.sort(function (a, b) { return b.revision - a.revision; });
    analyses.forEach(function (row) { row.result = row.result_json ? JSON.parse(row.result_json) : null; });
    proposals.forEach(function (row) {
      row.suggested_new = row.suggested_new_json ? JSON.parse(row.suggested_new_json) : {};
      row.tags = row.tags_json ? JSON.parse(row.tags_json) : [];
      row.payload = row.payload_json ? JSON.parse(row.payload_json) : null;
    });
    const subject = classification ? tax.allSubjects.find(function (s) { return s.id === classification.subject_id; }) : null;
    const chapter = classification ? tax.allChapters.find(function (c) { return c.id === classification.chapter_id; }) : null;
    const type = classification ? tax.allTypes.find(function (t) { return t.id === classification.type_id; }) : null;
    const source = material.source_id ? tax.sources.find(function (s) { return s.id === material.source_id; }) : null;
    return {
      material: material, classification: classification || null,
      subject: subject || null, chapter: chapter || null,
      chapter_path: classification ? chapterPathText(tax.allChapters, classification.chapter_id).split(' / ').filter(Boolean) : [],
      type: type || null, source: source || null, tags: tags,
      raw: rawRows, analyses: analyses, proposals: proposals, reviews: reviews,
      latest_analysis: analyses[0] || null,
      latest_proposal: proposals[0] || null,
      latest_confirmed_review: reviews.find(function (r) { return r.kind === 'confirmed'; }) || null
    };
  }

  /* --------------------------------------------------------------------- AI */

  async analyzeMaterial(materialId, options) {
    const opts = options || {};
    const material = await this.getMaterialRow(materialId);
    const rawRows = await this.db.getByIndex('material_raw', 'material_id', materialId);
    rawRows.sort(function (a, b) { return b.revision - a.revision; });
    const raw = rawRows[0];
    if (!raw) throw new Error('该材料没有原始内容，无法进行分析');

    const settings = await this.getSettings();
    const provider = opts.provider && opts.provider !== 'auto' ? opts.provider : await this.resolveProvider();
    if (provider === 'off') throw new AI.AIError('AI 功能已关闭，可在设置页开启', 'ai_disabled', {}, false);

    if (!opts.force && provider === 'deepseek') {
      const analyses = await this.db.getByIndex('ai_analyses', 'material_id', materialId);
      const reused = analyses.filter(function (row) {
        return row.raw_hash === raw.content_hash && row.provider === 'deepseek'
          && row.prompt_version === PROMPT_VERSION && row.status === 'success';
      }).sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); })[0];
      if (reused) {
        const proposals = await this.db.getByIndex('proposals', 'material_id', materialId);
        return {
          ok: true, reused: true, material_id: materialId,
          analysis: reused,
          proposal: proposals.find(function (p) { return p.analysis_id === reused.id; }) || null,
          message: '该原文已分析过，直接复用上次的 AI 结果。'
        };
      }
    }

    material.processing_status = 'pending';
    material.updated_at = nowIso();
    await this.db.put('materials', material);
    this._invalidate();

    const taxonomy = await this._taxonomy();
    const taxonomyForPrompt = await this._taxonomyForPrompt();
    const started = Date.now();
    let responseText = '';
    let model = provider === 'mock' ? 'local-rules' : String(settings['ai.model'] || 'deepseek-chat');
    let attempts = 1;
    let parsed = null;
    let warnings = [];

    try {
      if (provider === 'mock') {
        parsed = analyzeLocally({
          title: material.title, body: raw.body,
          subjects: taxonomy.allSubjects, chapters: taxonomy.allChapters,
          types: taxonomy.allTypes, tags: taxonomy.tags,
          maxInputChars: asInt(settings['ai.max_input_chars'], 12000)
        });
        responseText = JSON.stringify(parsed);
        warnings = parsed.warnings || [];
      } else {
        const messages = AI.buildMessages({
          title: material.title, body: raw.body, taxonomy: taxonomyForPrompt,
          sourceDetail: material.source_detail,
          instruction: opts.instruction,
          maxInputChars: asInt(settings['ai.max_input_chars'], 12000)
        });
        const response = await AI.callDeepSeek({
          baseUrl: settings['ai.base_url'], apiKey: settings['ai.api_key'], model: model,
          messages: messages,
          timeoutMs: asInt(settings['ai.timeout_seconds'], 45) * 1000,
          temperature: asFloat(settings['ai.temperature'], 0.2),
          maxRetries: asInt(settings['ai.max_retries'], 2)
        });
        responseText = response.text;
        model = response.model || model;
        attempts = response.attempts || 1;
        try {
          const extracted = AI.extractJson(responseText);
          parsed = extracted.value;
          warnings = extracted.warnings;
        } catch (firstError) {
          const repaired = await AI.callDeepSeek({
            baseUrl: settings['ai.base_url'], apiKey: settings['ai.api_key'], model: model,
            messages: AI.buildRepairMessages(responseText),
            timeoutMs: asInt(settings['ai.timeout_seconds'], 45) * 1000,
            temperature: 0, maxRetries: 1
          });
          const extracted = AI.extractJson(repaired.text);
          parsed = extracted.value;
          warnings = extracted.warnings.concat(['首次输出 JSON 无效，已自动请求修复成功']);
          attempts += repaired.attempts || 1;
        }
      }
    } catch (error) {
      const analysis = await this._insertAnalysis({
        materialId: materialId, raw: raw, provider: provider, model: model,
        status: 'failed', result: null, responseText: responseText,
        latencyMs: Date.now() - started, attempts: attempts,
        errorCode: error.code || 'unknown', errorMessage: error.message
      });
      const failed = await this.db.get('materials', materialId);
      failed.processing_status = 'failed';
      failed.updated_at = nowIso();
      await this.db.put('materials', failed);
      this._invalidate();
      return {
        ok: false, material_id: materialId,
        error: { code: analysis.error_code, message: analysis.error_message },
        retryable: !!error.retryable, analysis: analysis,
        message: 'AI 调用失败，已保留原文。你可以手动分类并保存，稍后再重试。'
      };
    }

    const normalized = AI.normalizeResult(parsed, {
      subjects: taxonomy.allSubjects, chapters: taxonomy.allChapters,
      types: taxonomy.allTypes, tags: taxonomy.tags
    });
    normalized.warnings = unique(normalized.warnings.concat(warnings));

    const analysis = await this._insertAnalysis({
      materialId: materialId, raw: raw, provider: provider, model: model,
      status: 'success', result: normalized, responseText: responseText,
      latencyMs: Date.now() - started, attempts: attempts, warnings: normalized.warnings
    });
    const proposal = await this._createProposal(materialId, analysis.id, normalized);

    const current = await this.db.get('materials', materialId);
    current.processing_status = 'analyzed';
    if (current.status === 'inbox') current.status = 'reviewing';
    current.updated_at = nowIso();
    await this.db.put('materials', current);
    this._invalidate();

    return {
      ok: true, reused: false, material_id: materialId, provider: provider,
      analysis: analysis, proposal: proposal, normalized: normalized,
      bundle: await this.getBundle(materialId)
    };
  }

  async _taxonomyForPrompt() {
    const tax = await this._taxonomy();
    return {
      subjects: tax.subjects.map(function (subject) {
        const chapters = tax.chapters.filter(function (c) { return c.subject_id === subject.id; })
          .map(function (c) {
            return { id: c.id, name: c.name, path: chapterPathText(tax.allChapters, c.id) };
          });
        return { id: subject.id, name: subject.name, code: subject.code, chapters: chapters };
      }),
      types: tax.types.map(function (t) { return { id: t.id, name: t.name, subject_id: t.subject_id || null }; }),
      tags: tax.tags.map(function (t) { return { name: t.name }; })
    };
  }

  async _insertAnalysis(input) {
    const row = {
      id: newId('ana_'), material_id: input.materialId, raw_id: input.raw ? input.raw.id : null,
      raw_hash: input.raw ? input.raw.content_hash : null,
      provider: input.provider, model: input.model, prompt_version: PROMPT_VERSION,
      status: input.status, error_code: input.errorCode || null, error_message: input.errorMessage || null,
      latency_ms: input.latencyMs || 0, attempts: input.attempts || 1,
      response_text: truncate(input.responseText || '', 20000),
      result_json: input.result ? JSON.stringify(input.result) : null,
      warnings_json: JSON.stringify(input.warnings || []),
      created_at: nowIso()
    };
    await this.db.put('ai_analyses', row);
    row.result = input.result || null;
    return row;
  }

  async _createProposal(materialId, analysisId, normalized) {
    const subject = normalized.subject || {};
    const chapter = normalized.chapter || {};
    const type = normalized.material_type || {};
    const row = {
      id: newId('prp_'), material_id: materialId, analysis_id: analysisId,
      subject_id: subject.id || null, chapter_id: chapter.id || null, type_id: type.id || null,
      subject_name: subject.name || null, chapter_name: chapter.name || null, type_name: type.name || null,
      suggested_new_json: JSON.stringify(normalized.suggested_new || {}),
      importance: normalized.importance, confidence: normalized.confidence,
      tags_json: JSON.stringify(normalized.tags || []), reason: normalized.reason || '',
      payload_json: JSON.stringify(normalized),
      status: 'proposed', review_note: null, reviewed_at: null, created_at: nowIso()
    };
    await this.db.put('proposals', row);
    this._invalidate();
    return row;
  }

  async testConnection(options) {
    const opts = options || {};
    const settings = await this.getSettings();
    const provider = opts.provider && opts.provider !== 'auto' ? opts.provider : await this.resolveProvider();
    if (provider === 'mock') {
      const tax = await this._taxonomy();
      return {
        ok: true, provider: 'mock',
        message: '当前使用离线规则引擎，无需联网即可完成整理与分类建议。',
        sample: analyzeLocally({
          title: '测试', body: '数据结构 二叉树 遍历 重点 排序',
          subjects: tax.allSubjects, chapters: tax.allChapters, types: tax.allTypes, tags: tax.tags
        })
      };
    }
    if (provider === 'off') return { ok: false, provider: 'off', message: 'AI 功能已关闭。' };
    const started = Date.now();
    try {
      const response = await AI.callDeepSeek({
        baseUrl: opts.base_url || settings['ai.base_url'],
        apiKey: opts.api_key || settings['ai.api_key'],
        model: opts.model || settings['ai.model'],
        messages: [
          { role: 'system', content: '你是一个 JSON 输出助手，只输出 JSON。' },
          { role: 'user', content: '请只输出 JSON：{"ok": true, "msg": "ping"}' }
        ],
        timeoutMs: Math.min(30000, asInt(settings['ai.timeout_seconds'], 45) * 1000),
        temperature: 0, maxRetries: 0, maxTokens: 64
      });
      return {
        ok: true, provider: 'deepseek', model: response.model,
        latency_ms: Date.now() - started,
        message: 'DeepSeek 连接正常。', raw: truncate(response.text, 200)
      };
    } catch (error) {
      return {
        ok: false, provider: 'deepseek',
        error: { code: error.code, message: error.message },
        retryable: !!error.retryable,
        message: 'DeepSeek 连接失败：' + error.message
      };
    }
  }

  async listProposals(status, limit, materialId) {
    const tax = await this._taxonomy();
    const all = await this._loadAll();
    let rows = await this.db.getAll('proposals');
    if (status) {
      const wanted = String(status).split(',');
      rows = rows.filter(function (p) { return wanted.indexOf(p.status) >= 0; });
    }
    if (materialId) rows = rows.filter(function (p) { return p.material_id === materialId; });
    rows.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
    rows = rows.slice(0, limit || 100);
    return rows.map(function (row) {
      const material = all.materials.find(function (m) { return m.id === row.material_id; });
      const subject = tax.allSubjects.find(function (s) { return s.id === row.subject_id; });
      const chapter = tax.allChapters.find(function (c) { return c.id === row.chapter_id; });
      const type = tax.allTypes.find(function (t) { return t.id === row.type_id; });
      return Object.assign({}, row, {
        suggested_new: row.suggested_new_json ? JSON.parse(row.suggested_new_json) : {},
        tags: row.tags_json ? JSON.parse(row.tags_json) : [],
        payload: row.payload_json ? JSON.parse(row.payload_json) : null,
        material_title: material ? material.title : '(已删除)',
        material_status: material ? material.status : '',
        resolved_subject_name: subject ? subject.name : '',
        resolved_chapter_name: chapter ? chapter.name : '',
        resolved_type_name: type ? type.name : ''
      });
    });
  }

  async getProposal(id) {
    const row = await this.db.get('proposals', id);
    if (!row) throw new Error('AI 建议不存在');
    row.suggested_new = row.suggested_new_json ? JSON.parse(row.suggested_new_json) : {};
    row.tags = row.tags_json ? JSON.parse(row.tags_json) : [];
    row.payload = row.payload_json ? JSON.parse(row.payload_json) : null;
    return row;
  }

  async _resolveChoice(payload, proposal, field, kind) {
    const newKey = 'new_' + field;
    if (payload[newKey]) {
      const name = String(payload[newKey]).trim();
      if (kind === 'subject') return (await this.createSubject({ name: name })).id;
      if (kind === 'chapter') {
        return (await this.createChapter({
          name: name,
          subject_id: payload.subject_id || proposal.subject_id || null
        })).id;
      }
      return (await this.createType({
        name: name,
        subject_id: payload.subject_id || proposal.subject_id || null
      })).id;
    }
    if (field in payload) return payload[field] || null;
    return proposal[field] || null;
  }

  async _classificationFrom(payload, proposal) {
    const subjectId = await this._resolveChoice(payload, proposal, 'subject_id', 'subject');
    const chapterId = await this._resolveChoice(payload, proposal, 'chapter_id', 'chapter');
    const typeId = await this._resolveChoice(payload, proposal, 'type_id', 'type');
    return {
      subject_id: subjectId, chapter_id: chapterId, type_id: typeId,
      importance: asInt(payload.importance === undefined ? proposal.importance : payload.importance, 0),
      tags: payload.tags === undefined ? (proposal.tags || []) : payload.tags
    };
  }

  async _saveReview(materialId, proposal, payload) {
    let body = payload.review_body;
    if (body === undefined && payload.use_ai_body) {
      const normalized = (proposal.payload_json ? JSON.parse(proposal.payload_json) : {}) || {};
      body = normalized.organized_body || '';
    }
    if (body === undefined || body === null) return null;
    const normalized = (proposal.payload_json ? JSON.parse(proposal.payload_json) : {}) || {};
    return this.addReview(materialId, {
      body: String(body),
      title: payload.review_title || normalized.title,
      summary: payload.review_summary || normalized.summary,
      kind: payload.review_kind || 'confirmed',
      note: payload.review_note || null,
      analysis_id: proposal.analysis_id
    });
  }

  async _finishProposal(id, status, note) {
    const row = await this.db.get('proposals', id);
    row.status = status;
    row.review_note = note || null;
    row.reviewed_at = nowIso();
    await this.db.put('proposals', row);
    this._invalidate();
    return row;
  }

  async acceptProposal(id, payload) {
    const p = payload || {};
    const proposal = await this.getProposal(id);
    const chosen = await this._classificationFrom(p, proposal);
    if (!chosen.subject_id) throw new Error('接受建议前必须确定科目（可选择已有科目或新建科目）');
    const classification = await this.setClassification(proposal.material_id, {
      subject_id: chosen.subject_id, chapter_id: chosen.chapter_id, type_id: chosen.type_id,
      importance: chosen.importance, decided_by: 'ai_accepted', confidence: proposal.confidence
    });
    if (chosen.tags && chosen.tags.length) await this.setTags(proposal.material_id, chosen.tags);
    const review = await this._saveReview(proposal.material_id, proposal, p);
    if (p.archive !== false) await this.updateMaterial(proposal.material_id, { status: 'archived' });
    await this._finishProposal(id, 'accepted', p.review_note);
    return { ok: true, proposal: await this.getProposal(id), classification: classification, review: review, bundle: await this.getBundle(proposal.material_id) };
  }

  async editProposal(id, payload) {
    const p = payload || {};
    const proposal = await this.getProposal(id);
    const chosen = await this._classificationFrom(p, proposal);
    if (!chosen.subject_id) throw new Error('保存修改前必须确定科目（可选择已有科目或新建科目）');
    const classification = await this.setClassification(proposal.material_id, {
      subject_id: chosen.subject_id, chapter_id: chosen.chapter_id, type_id: chosen.type_id,
      importance: chosen.importance, decided_by: 'ai_edited', confidence: proposal.confidence
    });
    if (chosen.tags && chosen.tags.length) await this.setTags(proposal.material_id, chosen.tags);
    const review = await this._saveReview(proposal.material_id, proposal, p);
    if (p.archive) await this.updateMaterial(proposal.material_id, { status: 'archived' });
    await this._finishProposal(id, 'edited', p.review_note);
    return { ok: true, proposal: await this.getProposal(id), classification: classification, review: review, bundle: await this.getBundle(proposal.material_id) };
  }

  async rejectProposal(id, payload) {
    const proposal = await this.getProposal(id);
    await this._finishProposal(id, 'rejected', (payload || {}).review_note);
    return { ok: true, proposal: await this.getProposal(id), bundle: await this.getBundle(proposal.material_id) };
  }

  async stageProposal(id, payload) {
    const proposal = await this.getProposal(id);
    await this._finishProposal(id, 'staged', (payload || {}).review_note);
    await this.updateMaterial(proposal.material_id, { status: 'reviewing' });
    return { ok: true, proposal: await this.getProposal(id), bundle: await this.getBundle(proposal.material_id) };
  }

  async manualClassify(materialId, payload) {
    const p = payload || {};
    await this.getMaterialRow(materialId);
    if (p.new_subject_name) p.subject_id = (await this.createSubject({ name: String(p.new_subject_name).trim() })).id;
    if (p.new_chapter_name) {
      p.chapter_id = (await this.createChapter({
        name: String(p.new_chapter_name).trim(), subject_id: p.subject_id || null
      })).id;
    }
    if (p.new_type_name) {
      p.type_id = (await this.createType({
        name: String(p.new_type_name).trim(), subject_id: p.subject_id || null
      })).id;
    }
    if (!p.subject_id) throw new Error('手动分类至少需要选择或新建一个科目');
    const classification = await this.setClassification(materialId, {
      subject_id: p.subject_id, chapter_id: p.chapter_id || null, type_id: p.type_id || null,
      importance: asInt(p.importance, 0), decided_by: String(p.decided_by || 'manual_fallback')
    });
    if (p.tags && p.tags.length) await this.setTags(materialId, p.tags);
    const review = p.review_body ? await this.addReview(materialId, {
      body: String(p.review_body), title: p.review_title, summary: p.review_summary, kind: 'confirmed'
    }) : null;
    if (p.archive !== false) await this.updateMaterial(materialId, { status: 'archived' });
    return { ok: true, classification: classification, review: review, bundle: await this.getBundle(materialId) };
  }

  /* ------------------------------------------------------------------ 导出 */

  async exportMaterials(format, filters) {
    const f = Object.assign({}, filters || {}, { page: 1, limit: 200, include_deleted: true });
    const collected = [];
    let page = 1;
    for (;;) {
      f.page = page;
      const result = await this.listMaterials(f);
      collected.push.apply(collected, result.items);
      if (!result.has_more || page > 50) break;
      page += 1;
    }
    const bundles = [];
    for (const item of collected) bundles.push(await this.getBundle(item.id));

    if (format === 'csv') {
      const fields = ['id', 'title', 'status', 'processing_status', 'importance', 'subject', 'chapter_path',
        'type', 'tags', 'source', 'created_at', 'updated_at', 'char_count', 'ai_summary', 'raw_excerpt'];
      const lines = [fields.join(',')];
      bundles.forEach(function (bundle) {
        const raw = bundle.raw[bundle.raw.length - 1] || {};
        const result = (bundle.latest_analysis && bundle.latest_analysis.result) || {};
        lines.push(fields.map(function (field) {
          const map = {
            id: bundle.material.id, title: bundle.material.title, status: bundle.material.status,
            processing_status: bundle.material.processing_status, importance: bundle.material.importance,
            subject: bundle.subject ? bundle.subject.name : '',
            chapter_path: (bundle.chapter_path || []).join(' / '),
            type: bundle.type ? bundle.type.name : '',
            tags: bundle.tags.map(function (t) { return t.name; }).join(','),
            source: bundle.source ? bundle.source.name : (bundle.material.source_detail || ''),
            created_at: bundle.material.created_at, updated_at: bundle.material.updated_at,
            char_count: raw.char_count || '', ai_summary: result.summary || '',
            raw_excerpt: plainSnippet(raw.body || '', '', 80)
          };
          return csvCell(map[field]);
        }).join(','));
      });
      return { content: '\ufeff' + lines.join('\r\n'), filename: 'materials.csv', mime: 'text/csv;charset=utf-8' };
    }

    if (format === 'markdown') {
      const chunks = ['# 考研材料导出', '', '共 ' + bundles.length + ' 条材料。', ''];
      bundles.forEach(function (bundle) {
        const result = (bundle.latest_analysis && bundle.latest_analysis.result) || {};
        const confirmed = bundle.latest_confirmed_review;
        chunks.push('## ' + (bundle.material.title || '未命名材料'));
        chunks.push('');
        chunks.push('- 材料 ID: ' + bundle.material.id);
        chunks.push('- 科目: ' + (bundle.subject ? bundle.subject.name : '未分类'));
        chunks.push('- 章节: ' + ((bundle.chapter_path || []).join(' / ') || '未分类'));
        chunks.push('- 类型: ' + (bundle.type ? bundle.type.name : '未分类'));
        chunks.push('- 标签: ' + (bundle.tags.map(function (t) { return t.name; }).join(', ') || '无'));
        chunks.push('- 重要程度: ' + bundle.material.importance);
        chunks.push('- 状态: ' + bundle.material.status + ' / ' + bundle.material.processing_status);
        chunks.push('');
        if (result.summary) { chunks.push('### AI 摘要'); chunks.push(''); chunks.push(result.summary); chunks.push(''); }
        if (confirmed) { chunks.push('### 用户确认稿（第 ' + confirmed.revision + ' 版）'); chunks.push(''); chunks.push(confirmed.body); chunks.push(''); }
        bundle.raw.forEach(function (raw) {
          chunks.push('### 原始材料（第 ' + raw.revision + ' 版，' + raw.created_at + '）');
          chunks.push('');
          chunks.push(raw.body);
          chunks.push('');
        });
      });
      return { content: chunks.join('\n'), filename: 'materials.md', mime: 'text/markdown;charset=utf-8' };
    }

    const payload = {
      exported_at: nowIso(),
      count: bundles.length,
      materials: bundles.map(function (bundle) {
        return {
          material: bundle.material, classification: bundle.classification,
          subject: bundle.subject, chapter: bundle.chapter, chapter_path: bundle.chapter_path,
          type: bundle.type, source: bundle.source, tags: bundle.tags,
          raw: bundle.raw, analyses: bundle.analyses, proposals: bundle.proposals, reviews: bundle.reviews
        };
      })
    };
    return { content: JSON.stringify(payload, null, 2), filename: 'materials.json', mime: 'application/json;charset=utf-8' };
  }

  async dumpAll() {
    const dump = {};
    const names = ['subjects', 'chapters', 'material_types', 'tags', 'sources', 'materials',
      'material_raw', 'ai_analyses', 'proposals', 'material_classification', 'material_tags',
      'material_reviews', 'search_index', 'audit_log', 'settings'];
    for (const name of names) dump[name] = await this.db.getAll(name);
    return {
      format: 'kaoyan-mobile-backup',
      version: 1,
      app_version: APP_VERSION,
      created_at: nowIso(),
      counts: Object.keys(dump).reduce(function (acc, key) { acc[key] = dump[key].length; return acc; }, {}),
      tables: dump
    };
  }

  async restoreAll(dump) {
    if (!dump || dump.format !== 'kaoyan-mobile-backup') throw new Error('这不是本应用导出的备份文件');
    await this.db.replaceAll(dump.tables || {});
    this._settings = null;
    this._invalidateTaxonomy();
    return dump.counts || {};
  }

  async storageStats() {
    const out = {};
    for (const name of ['materials', 'material_raw', 'ai_analyses', 'proposals', 'material_reviews']) {
      out[name] = await this.db.count(name);
    }
    return out;
  }
}
