/* 考研四科 AI 材料归档 —— 纯移动端应用。
 * 数据全部保存在本机 IndexedDB；AI 由浏览器直连 DeepSeek；离线时自动降级为本地规则引擎。
 */
import { newId, nowIso, downloadBlob, formatTime, unique } from './util.js';
import { openDatabase } from './store.js';
import { Repository, APP_VERSION } from './repo.js';
import { extractDocx } from './docx.js';
import * as UI from './ui.js';

const el = UI.el;
const chip = UI.chip;

const TEXT_EXT = ['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.tex'];

const STATUS_LABEL = { inbox: '收件箱', reviewing: '待审核', archived: '已归档', rejected: '已拒绝' };
const STATUS_CLASS = { inbox: 'gray', reviewing: 'warn', archived: 'ok', rejected: 'danger' };
const PROCESSING_LABEL = { raw: '未整理', pending: '整理中', analyzed: '已出建议', failed: 'AI 失败', reviewed: '已确认' };
const PROPOSAL_LABEL = { proposed: '待审核', accepted: '已接受', edited: '已修改', rejected: '已拒绝', staged: '已暂存' };
const PROVIDER_LABEL = { deepseek: 'DeepSeek 在线模型', mock: '离线规则引擎', off: '已关闭' };

const state = {
  repo: null,
  tab: 'import',
  snapshot: null,
  settings: null,
  provider: 'mock',
  filters: { q: '', subject_id: '', chapter_id: '', type_id: '', tag_ids: '', importance_min: '', status: '', sort: 'updated_desc', page: 1, limit: 20 },
  library: { items: [], total: 0, page: 1, pages: 1 },
  proposals: [],
  proposalFilter: 'proposed,staged',
  selectedProposalId: null,
  pendingMaterials: [],
  importQueue: [],
  lastBatch: null,
  installPrompt: null
};

/* ------------------------------------------------------------------ 小工具 */

async function guard(fn, successMessage) {
  try {
    const result = await fn();
    if (successMessage) UI.toast(successMessage, 'ok');
    return result;
  } catch (error) {
    UI.toast(error && error.message ? error.message : String(error), 'error');
    return null;
  }
}

function importanceOptions(selected) {
  const labels = ['0 未标记', '1 一般', '2 稍低', '3 中等', '4 重要', '5 非常重要'];
  return labels.map(function (label, index) {
    return el('option', { value: String(index), selected: Number(selected) === index }, label);
  });
}

function createClassifier(initial) {
  const init = initial || {};
  const subjectSelect = el('select', {}, [el('option', { value: '' }, '— 未选择 —')].concat(
    state.snapshot.subjects.map(function (subject) {
      return el('option', { value: subject.id, selected: subject.id === init.subject_id }, subject.name);
    })
  ));
  const chapterSelect = el('select', {}, []);
  const typeSelect = el('select', {}, []);
  const importanceSelect = el('select', {}, importanceOptions(init.importance));
  const tagsInput = el('input', { type: 'text', placeholder: '逗号分隔，如：重点,易错' });
  tagsInput.value = (init.tags || []).join(',');

  if (init.subject_id) subjectSelect.value = init.subject_id;

  function refreshChapters() {
    const current = init.chapter_id || chapterSelect.value || '';
    UI.clear(chapterSelect);
    chapterSelect.appendChild(el('option', { value: '' }, '— 未选择 —'));
    state.snapshot.chapters.forEach(function (chapter) {
      if (chapter.subject_id && subjectSelect.value && chapter.subject_id !== subjectSelect.value) return;
      if (chapter.is_archived) return;
      const path = chapterPath(chapter.id);
      chapterSelect.appendChild(el('option', { value: chapter.id, selected: chapter.id === current },
        path.length ? path.join(' / ') : chapter.name));
    });
  }

  function refreshTypes() {
    UI.clear(typeSelect);
    typeSelect.appendChild(el('option', { value: '' }, '— 未选择 —'));
    state.snapshot.types.forEach(function (type) {
      if (type.subject_id && subjectSelect.value && type.subject_id !== subjectSelect.value) return;
      typeSelect.appendChild(el('option', { value: type.id, selected: type.id === (init.type_id || '') },
        type.name + (type.subject_id ? '' : '（通用）')));
    });
  }

  subjectSelect.addEventListener('change', function () { refreshChapters(); refreshTypes(); });
  refreshChapters();
  refreshTypes();

  return {
    node: el('div', {}, [
      UI.field('科目', subjectSelect),
      UI.field('章节', chapterSelect),
      UI.field('材料类型', typeSelect),
      el('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-end' } }, [
        el('div', { style: { flex: '1 1 140px' } }, UI.field('重要程度', importanceSelect)),
        el('div', { style: { flex: '2 1 200px' } }, UI.field('标签', tagsInput))
      ])
    ]),
    read: function () {
      return {
        subject_id: subjectSelect.value || null,
        chapter_id: chapterSelect.value || null,
        type_id: typeSelect.value || null,
        importance: Number(importanceSelect.value || 0),
        tags: tagsInput.value.split(',').map(function (item) { return item.trim(); }).filter(Boolean)
      };
    }
  };
}

function chapterPath(chapterId) {
  const map = {};
  state.snapshot.chapters.forEach(function (chapter) { map[chapter.id] = chapter; });
  const names = [];
  let current = map[chapterId];
  let guardCount = 0;
  while (current && guardCount < 32) {
    names.unshift(current.name);
    current = current.parent_id ? map[current.parent_id] : null;
    guardCount += 1;
  }
  return names;
}

/* ---------------------------------------------------------------- 启动框架 */

const TABS = [
  { key: 'import', label: '导入', icon: '＋' },
  { key: 'library', label: '材料库', icon: '▤' },
  { key: 'review', label: '审核', icon: '✓' },
  { key: 'taxonomy', label: '分类', icon: '❖' },
  { key: 'settings', label: '设置', icon: '⚙' }
];

async function refresh() {
  state.snapshot = await state.repo.snapshot();
  state.settings = await state.repo.getSettings();
  state.provider = await state.repo.resolveProvider();
}

function render() {
  renderTabs();
  renderHeader();
  const view = UI.$('view');
  UI.clear(view);
  if (state.tab === 'import') view.appendChild(pageImport());
  else if (state.tab === 'library') view.appendChild(pageLibrary());
  else if (state.tab === 'review') view.appendChild(pageReview());
  else if (state.tab === 'taxonomy') view.appendChild(pageTaxonomy());
  else view.appendChild(pageSettings());
  wrapTables(view);
}

function wrapTables(root) {
  Array.prototype.forEach.call(root.querySelectorAll('table.data'), function (table) {
    const parent = table.parentNode;
    if (!parent || (parent.classList && parent.classList.contains('table-scroll'))) return;
    const wrapper = el('div', { class: 'table-scroll' }, []);
    parent.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

function renderTabs() {
  const tabs = UI.$('tabs');
  UI.clear(tabs);
  const counts = (state.snapshot && state.snapshot.counts) || {};
  TABS.forEach(function (tab) {
    const badges = [];
    if (tab.key === 'review' && counts.pendingProposals) badges.push(chip(String(counts.pendingProposals), 'warn'));
    if (tab.key === 'library' && counts.materials) {
      badges.push(el('span', { class: 'tab-badge' }, String(counts.materials)));
    }
    tabs.appendChild(el('button', {
      class: 'tab-btn' + (state.tab === tab.key ? ' active' : ''),
      onclick: function () { switchTab(tab.key); }
    }, [
      el('span', { class: 'tab-icon' }, tab.icon),
      el('span', { class: 'tab-label' }, [tab.label].concat(badges))
    ]));
  });
}

function renderHeader() {
  const box = UI.$('header-status');
  UI.clear(box);
  const counts = (state.snapshot && state.snapshot.counts) || {};
  UI.append(box, [
    chip('材料 ' + (counts.materials || 0), 'gray'),
    counts.pendingProposals ? chip('待审核 ' + counts.pendingProposals, 'warn') : null,
    chip(PROVIDER_LABEL[state.provider] || state.provider, state.provider === 'mock' ? 'warn' : '')
  ]);
}

async function switchTab(key) {
  state.tab = key;
  if (key === 'review') await loadReview();
  else if (key === 'library') await loadLibrary();
  else render();
}

/* ------------------------------------------------------------------ 导入页 */

async function readImportFile(file) {
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.docx')) {
    const text = await extractDocx(await file.arrayBuffer());
    return { text: text, warning: '已从 .docx 提取纯文本' };
  }
  if (name.endsWith('.pdf')) {
    throw new Error('暂不支持 PDF：请在手机上打开 PDF 复制文字后粘贴，或先转成 .docx / .txt');
  }
  if (TEXT_EXT.some(function (ext) { return name.endsWith(ext); })) {
    return { text: await file.text(), warning: '' };
  }
  throw new Error('暂不支持的文件类型：' + file.name);
}

function pageImport() {
  const container = el('div', {}, []);
  const classifier = createClassifier({});
  const titleInput = el('input', { type: 'text', placeholder: '留空则自动取正文第一行' });
  const sourceInput = el('input', { type: 'text', placeholder: '如：王道数据结构 / 肖秀荣1000题' });
  const textArea = el('textarea', { rows: 10, placeholder: '在此粘贴或输入学习材料原文…' });

  const saveBtn = el('button', { class: 'primary' }, '保存材料');
  const saveAiBtn = el('button', { class: 'ok' }, '保存并让 AI 整理');

  async function createOne(analyze) {
    const text = textArea.value;
    if (!text.trim()) { UI.toast('请先输入材料内容', 'error'); return; }
    saveBtn.disabled = true;
    saveAiBtn.disabled = true;
    try {
      const choice = classifier.read();
      const created = await state.repo.createMaterial({
        title: titleInput.value, text: text, origin: 'paste',
        source_name: sourceInput.value || null,
        subject_id: choice.subject_id, chapter_id: choice.chapter_id, type_id: choice.type_id,
        importance: choice.importance, tags: choice.tags
      });
      if (created.duplicate_submission) UI.toast('检测到重复提交，已复用已有材料。', 'warn');
      else if (created.duplicates.length) UI.toast('提示：已存在 ' + created.duplicates.length + ' 条相同内容的材料。', 'warn');
      else UI.toast('材料已保存。', 'ok');
      textArea.value = '';
      titleInput.value = '';
      if (analyze) await runAnalyze(created.material_id);
      await refresh();
      render();
    } catch (error) {
      UI.toast(error.message || String(error), 'error');
    } finally {
      saveBtn.disabled = false;
      saveAiBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', function () { createOne(false); });
  saveAiBtn.addEventListener('click', function () { createOne(true); });

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['① 手动输入 / 粘贴文本', el('span', { class: 'sub' }, '原文与 AI 结果分开保存')]),
    UI.field('标题', titleInput),
    UI.field('来源', sourceInput),
    classifier.node,
    UI.field('材料正文', textArea),
    el('div', { class: 'row' }, [saveBtn, saveAiBtn]),
    el('div', { class: 'small muted mt' }, '「保存并让 AI 整理」会在保存后调用 AI 生成分类建议；失败也不影响原文保存。')
  ]));

  /* ---- 文件导入 ---- */
  const fileInput = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
  const queueBox = el('div', { class: 'material-list' }, []);
  const batchClassifier = createClassifier({});
  const autoAnalyzeBox = el('input', { type: 'checkbox' });
  const batchBtn = el('button', { class: 'primary' }, '开始批量导入');

  function renderQueue() {
    UI.clear(queueBox);
    if (!state.importQueue.length) {
      queueBox.appendChild(UI.emptyState('尚未选择文件', '支持 .txt / .md / .csv / .json / .docx，可多选'));
      return;
    }
    state.importQueue.forEach(function (file, index) {
      queueBox.appendChild(el('div', { class: 'material-card', style: { cursor: 'default' } }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'title' }, file.name),
          chip((file.size / 1024).toFixed(1) + ' KB', 'gray'),
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'danger small',
            onclick: function () { state.importQueue.splice(index, 1); renderQueue(); }
          }, '移除')
        ])
      ]));
    });
  }

  function addFiles(files) {
    let added = 0;
    files.forEach(function (file) {
      if (String(file.name).toLowerCase().endsWith('.pdf')) {
        UI.toast('暂不支持 PDF：' + file.name, 'warn');
        return;
      }
      state.importQueue.push(file);
      added += 1;
    });
    if (added) { renderQueue(); UI.toast('已加入 ' + added + ' 个文件。', 'ok'); }
  }

  fileInput.addEventListener('change', function () {
    addFiles(Array.prototype.slice.call(fileInput.files || []));
    fileInput.value = '';
  });

  const dropZone = el('div', { class: 'drop-zone' }, '点击选择文件（.txt / .md / .csv / .json / .docx）');
  dropZone.addEventListener('click', function () { fileInput.click(); });

  batchBtn.addEventListener('click', async function () {
    if (!state.importQueue.length) { UI.toast('请先选择文件', 'error'); return; }
    batchBtn.disabled = true;
    batchBtn.textContent = '正在导入…';
    const choice = batchClassifier.read();
    const results = [];
    for (let index = 0; index < state.importQueue.length; index += 1) {
      const file = state.importQueue[index];
      try {
        const extracted = await readImportFile(file);
        const created = await state.repo.createMaterial({
          title: String(file.name).replace(/\.[^.]+$/, ''),
          text: extracted.text, origin: 'import', file_name: file.name,
          subject_id: choice.subject_id, chapter_id: choice.chapter_id, type_id: choice.type_id,
          importance: choice.importance, tags: choice.tags,
          decided_by: choice.subject_id ? 'import_default' : 'user'
        });
        const record = {
          index: index, ok: true, title: created.bundle.material.title,
          warnings: extracted.warning ? [extracted.warning] : [],
          duplicates: created.duplicates, skipped: created.duplicate_submission
        };
        if (autoAnalyzeBox.checked && !created.duplicate_submission) {
          const outcome = await state.repo.analyzeMaterial(created.material_id);
          record.ai = { ok: outcome.ok, error: outcome.error };
        }
        results.push(record);
      } catch (error) {
        results.push({ index: index, ok: false, title: file.name, error: { message: error.message || String(error) } });
      }
    }
    const succeeded = results.filter(function (r) { return r.ok && !r.skipped; }).length;
    const failed = results.filter(function (r) { return !r.ok; }).length;
    const skipped = results.filter(function (r) { return r.skipped; }).length;
    state.lastBatch = {
      status: failed === 0 ? 'completed' : (succeeded === 0 && skipped === 0 ? 'failed' : 'partial'),
      results: results, summary: { total: results.length, succeeded: succeeded, failed: failed, skipped: skipped }
    };
    state.importQueue = [];
    renderQueue();
    batchBtn.disabled = false;
    batchBtn.textContent = '开始批量导入';
    await refresh();
    render();
    UI.toast(state.lastBatch.status === 'completed'
      ? '全部 ' + succeeded + ' 条导入成功。'
      : '部分成功：成功 ' + succeeded + ' 条，失败 ' + failed + ' 条。',
      state.lastBatch.status === 'completed' ? 'ok' : (state.lastBatch.status === 'failed' ? 'error' : 'warn'));
  });

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['② 文件导入', el('span', { class: 'sub' }, '支持批量，部分失败会逐条列出')]),
    dropZone, fileInput,
    el('div', { class: 'mt' }, [queueBox]),
    el('div', { class: 'mt' }, [batchClassifier.node]),
    el('label', { class: 'row tight' }, [autoAnalyzeBox, el('span', {}, '导入后自动调用 AI 整理')]),
    el('div', { class: 'row mt' }, [batchBtn])
  ]));

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['③ 导入结果']),
    renderBatchResult(state.lastBatch)
  ]));

  renderQueue();
  return container;
}

function renderBatchResult(batch) {
  if (!batch) return UI.emptyState('本次还没有执行过批量导入', '选择文件后点击「开始批量导入」');
  const wrapper = el('div', {}, []);
  wrapper.appendChild(el('div', { class: 'row mb' }, [
    chip('总计 ' + batch.summary.total, 'gray'),
    chip('成功 ' + batch.summary.succeeded, 'ok'),
    chip('失败 ' + batch.summary.failed, batch.summary.failed ? 'danger' : 'gray'),
    chip('跳过 ' + batch.summary.skipped, 'gray')
  ]));
  wrapper.appendChild(el('table', { class: 'data' }, [
    el('thead', {}, el('tr', {}, [el('th', {}, '#'), el('th', {}, '状态'), el('th', {}, '说明')])),
    el('tbody', {}, batch.results.map(function (item) {
      const status = item.ok ? (item.skipped ? '跳过' : '成功') : '失败';
      const detail = item.ok
        ? [(item.warnings || []).join('；'), item.ai ? (item.ai.ok ? 'AI 已生成建议' : 'AI 失败：' + (item.ai.error || {}).message) : '']
          .filter(Boolean).join(' / ') || item.title
        : (item.error || {}).message;
      return el('tr', {}, [
        el('td', {}, String(item.index + 1)),
        el('td', {}, chip(status, item.ok ? (item.skipped ? 'gray' : 'ok') : 'danger')),
        el('td', {}, detail)
      ]);
    }))
  ]));
  return wrapper;
}

async function runAnalyze(materialId, force) {
  const node = UI.toast('正在调用 AI 整理…', '', 2000);
  const outcome = await state.repo.analyzeMaterial(materialId, { force: !!force });
  if (node.parentNode) node.parentNode.removeChild(node);
  if (outcome.ok) {
    UI.toast(outcome.reused ? '已复用之前的 AI 结果。' : 'AI 已生成分类建议，请到「审核」页确认。', 'ok');
  } else {
    UI.toast('AI 整理失败：' + ((outcome.error || {}).message || '') , 'error', 8000);
  }
  return outcome;
}

/* ------------------------------------------------------------------ 材料库 */

async function loadLibrary() {
  try {
    const result = await state.repo.listMaterials(state.filters);
    state.library = result;
    state.filters.page = result.page;
  } catch (error) {
    UI.toast(error.message || String(error), 'error');
  }
  render();
}

function materialCard(item) {
  const meta = [];
  meta.push(chip(item.subject_name || '未分类', item.subject_name ? '' : 'gray'));
  if (item.chapter_id) meta.push(chip(chapterPath(item.chapter_id).join(' / '), 'gray'));
  if (item.type_name) meta.push(chip(item.type_name, 'tag'));
  (item.tags || []).forEach(function (tag) { meta.push(chip(tag.name, 'tag')); });
  meta.push(chip(PROCESSING_LABEL[item.processing_status] || item.processing_status,
    item.processing_status === 'failed' ? 'danger' : (item.processing_status === 'reviewed' ? 'ok' : 'gray')));
  meta.push(chip(STATUS_LABEL[item.status] || item.status, STATUS_CLASS[item.status] || 'gray'));

  const card = el('div', { class: 'material-card', onclick: function () { openMaterialDetail(item.id); } }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'title' }, item.title || '(无标题)'),
      el('span', { class: 'spacer' }),
      UI.stars(item.importance)
    ]),
    el('div', { class: 'meta' }, meta),
    item.snippet ? el('div', { class: 'snippet' }, item.snippet) : null,
    el('div', { class: 'small', style: { marginTop: '8px', color: 'var(--text-faint)' } }, formatTime(item.updated_at))
  ]);
  if (item.subject_color) card.style.setProperty('--subject-color', item.subject_color);
  return card;
}

function pageLibrary() {
  const container = el('div', {}, []);
  const f = state.filters;

  const searchInput = el('input', { type: 'search', placeholder: '搜索标题、原文、整理稿、标签…', value: f.q });
  let timer = null;
  searchInput.addEventListener('input', function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      f.q = searchInput.value; f.page = 1; loadLibrary();
    }, 300);
  });

  const subjectSelect = el('select', {}, [el('option', { value: '' }, '全部科目')].concat(
    state.snapshot.subjects.map(function (s) { return el('option', { value: s.id, selected: s.id === f.subject_id }, s.name); })
  ));
  subjectSelect.addEventListener('change', function () {
    f.subject_id = subjectSelect.value; f.chapter_id = ''; f.page = 1; loadLibrary();
  });

  const chapterSelect = el('select', {}, [el('option', { value: '' }, '全部章节')].concat(
    state.snapshot.chapters.filter(function (c) { return !f.subject_id || c.subject_id === f.subject_id; })
      .map(function (c) {
        const path = chapterPath(c.id);
        return el('option', { value: c.id, selected: c.id === f.chapter_id }, path.length ? path.join(' / ') : c.name);
      })
  ));
  chapterSelect.addEventListener('change', function () { f.chapter_id = chapterSelect.value; f.page = 1; loadLibrary(); });

  const typeSelect = el('select', {}, [el('option', { value: '' }, '全部类型')].concat(
    state.snapshot.types.map(function (t) { return el('option', { value: t.id, selected: t.id === f.type_id }, t.name); })
  ));
  typeSelect.addEventListener('change', function () { f.type_id = typeSelect.value; f.page = 1; loadLibrary(); });

  const tagSelect = el('select', {}, [el('option', { value: '' }, '全部标签')].concat(
    state.snapshot.tags.map(function (t) { return el('option', { value: t.id, selected: t.id === f.tag_ids }, t.name); })
  ));
  tagSelect.addEventListener('change', function () { f.tag_ids = tagSelect.value; f.page = 1; loadLibrary(); });

  const statusSelect = el('select', {}, [el('option', { value: '', selected: !f.status }, '全部状态')].concat(
    Object.keys(STATUS_LABEL).map(function (key) {
      return el('option', { value: key, selected: f.status === key }, STATUS_LABEL[key]);
    })
  ));
  statusSelect.addEventListener('change', function () { f.status = statusSelect.value; f.page = 1; loadLibrary(); });

  const sortSelect = el('select', {}, [
    ['updated_desc', '最近更新'], ['created_desc', '最近创建'],
    ['importance_desc', '重要程度'], ['title_asc', '标题']
  ].map(function (pair) { return el('option', { value: pair[0], selected: f.sort === pair[0] }, pair[1]); }));
  sortSelect.addEventListener('change', function () { f.sort = sortSelect.value; loadLibrary(); });

  const resetBtn = el('button', {
    class: 'small ghost',
    style: { width: '100%' },
    onclick: function () {
      state.filters = { q: '', subject_id: '', chapter_id: '', type_id: '', tag_ids: '', importance_min: '', status: '', sort: 'updated_desc', page: 1, limit: 20 };
      loadLibrary();
    }
  }, '清除全部筛选');

  const activeFilters = ['subject_id', 'chapter_id', 'type_id', 'tag_ids', 'status']
    .filter(function (key) { return !!f[key]; }).length;

  container.appendChild(el('section', { class: 'panel' }, [
    el('div', { class: 'search-field' }, [el('span', { class: 'search-icon' }), searchInput]),
    el('details', { class: 'filter-box', open: activeFilters > 0 }, [
      el('summary', {}, [
        el('span', {}, '筛选'),
        activeFilters
          ? chip(String(activeFilters), '')
          : el('span', { class: 'sub' }, '科目 / 章节 / 类型 / 标签 / 状态')
      ]),
      el('div', { class: 'filter-grid' }, [
        subjectSelect, chapterSelect, typeSelect, tagSelect, statusSelect, sortSelect,
        el('div', { class: 'full' }, [resetBtn])
      ])
    ])
  ]));

  const listBox = el('div', { class: 'material-list' }, []);
  if (!state.library.items.length) {
    listBox.appendChild(UI.emptyState('没有符合条件的材料', '去「导入」页新增，或调整筛选条件'));
  } else {
    state.library.items.forEach(function (item) { listBox.appendChild(materialCard(item)); });
  }

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, [
      '材料库', el('span', { class: 'sub' }, '共 ' + state.library.total + ' 条')
    ]),
    listBox,
    state.library.pages > 1 ? el('div', { class: 'row mt' }, [
      el('button', {
        class: 'small', disabled: state.library.page <= 1,
        onclick: function () { state.filters.page = state.library.page - 1; loadLibrary(); }
      }, '上一页'),
      el('span', { class: 'muted small' }, state.library.page + ' / ' + state.library.pages),
      el('button', {
        class: 'small', disabled: state.library.page >= state.library.pages,
        onclick: function () { state.filters.page = state.library.page + 1; loadLibrary(); }
      }, '下一页')
    ]) : null
  ]));

  return container;
}

/* -------------------------------------------------------------- 材料详情 */

async function openMaterialDetail(materialId) {
  let bundle;
  try {
    bundle = await state.repo.getBundle(materialId);
  } catch (error) {
    UI.toast(error.message || String(error), 'error');
    return;
  }
  const tab = { current: 'review' };
  const bodyBox = el('div', {}, []);
  const headerBox = el('div', {}, []);
  const titleInput = el('input', { type: 'text', value: bundle.material.title });

  function renderHeader() {
    UI.clear(headerBox);
    const material = bundle.material;
    UI.append(headerBox, [
      el('div', {}, [titleInput]),
      el('div', { class: 'row tight mt' }, [
        chip(bundle.subject ? bundle.subject.name : '未分类科目', bundle.subject ? '' : 'gray'),
        chip(bundle.chapter_path.length ? bundle.chapter_path.join(' / ') : '未分类章节', 'gray'),
        chip(bundle.type ? bundle.type.name : '未分类类型', 'tag'),
        chip(PROCESSING_LABEL[material.processing_status] || material.processing_status,
          material.processing_status === 'failed' ? 'danger' : 'gray'),
        chip(STATUS_LABEL[material.status] || material.status, STATUS_CLASS[material.status] || 'gray'),
        UI.stars(material.importance)
      ])
    ]);
  }

  async function reload() {
    bundle = await state.repo.getBundle(materialId);
    renderHeader();
    renderTabs();
    await refresh();
  }

  function renderTabs() {
    UI.clear(bodyBox);
    bodyBox.appendChild(el('div', { class: 'subtabs' }, [
      ['review', '审核与归档'], ['raw', '原始材料'], ['ai', 'AI 结果'], ['reviews', '确认稿'], ['meta', '元数据']
    ].map(function (pair) {
      return el('button', {
        class: 'subtab' + (tab.current === pair[0] ? ' active' : ''),
        onclick: function () { tab.current = pair[0]; renderTabs(); }
      }, pair[1]);
    })));

    if (tab.current === 'review') bodyBox.appendChild(paneReview());
    else if (tab.current === 'raw') bodyBox.appendChild(paneRaw());
    else if (tab.current === 'ai') bodyBox.appendChild(paneAi());
    else if (tab.current === 'reviews') bodyBox.appendChild(paneReviews());
    else bodyBox.appendChild(paneMeta());
  }

  function paneReview() {
    const material = bundle.material;
    const classifier = createClassifier({
      subject_id: bundle.classification ? bundle.classification.subject_id : '',
      chapter_id: bundle.classification ? bundle.classification.chapter_id : '',
      type_id: bundle.classification ? bundle.classification.type_id : '',
      importance: material.importance,
      tags: bundle.tags.map(function (t) { return t.name; })
    });
    const statusSelect = el('select', {}, Object.keys(STATUS_LABEL).map(function (key) {
      return el('option', { value: key, selected: material.status === key }, STATUS_LABEL[key]);
    }));
    const sourceInput = el('input', { type: 'text', value: (bundle.source && bundle.source.name) || material.source_detail || '' });
    const noteInput = el('textarea', { rows: 2, value: material.note || '' });
    const reviewArea = el('textarea', { rows: 8, placeholder: '在这里写下你确认后的整理稿（不会覆盖原文）' });
    reviewArea.value = bundle.latest_confirmed_review ? bundle.latest_confirmed_review.body : '';
    const latest = bundle.latest_analysis;
    const aiResult = latest && latest.result ? latest.result : null;

    return el('div', {}, [
      el('section', { class: 'panel' }, [
        el('h2', { class: 'panel-title' }, '分类与元数据'),
        classifier.node,
        UI.field('材料状态', statusSelect),
        UI.field('来源名称', sourceInput),
        UI.field('备注', noteInput),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'primary',
            onclick: async function () {
              const choice = classifier.read();
              const ok = await guard(function () {
                return state.repo.updateMaterial(materialId, {
                  title: titleInput.value, status: statusSelect.value,
                  source_name: sourceInput.value || null, note: noteInput.value,
                  subject_id: choice.subject_id, chapter_id: choice.chapter_id, type_id: choice.type_id,
                  importance: choice.importance, tags: choice.tags
                });
              }, '已保存。');
              if (ok) await reload();
            }
          }, '保存'),
          el('button', {
            onclick: async function () { await runAnalyze(materialId, true); await reload(); }
          }, '重新 AI 整理')
        ])
      ]),
      el('section', { class: 'panel' }, [
        el('h2', { class: 'panel-title' }, [
          'AI 处理结果',
          aiResult ? el('button', {
            class: 'small ghost',
            onclick: function () { reviewArea.value = aiResult.organized_body || ''; UI.toast('已填入整理稿', 'ok'); }
          }, '填入整理稿') : null
        ]),
        aiResult ? el('div', {}, [
          el('div', { class: 'row tight mb' }, [
            chip('置信度 ' + Math.round((aiResult.confidence || 0) * 100) + '%', 'gray'),
            chip(latest.provider === 'mock' ? '离线规则引擎' : 'DeepSeek', latest.provider === 'mock' ? 'warn' : ''),
            chip((latest.latency_ms || 0) + ' ms', 'gray')
          ]),
          UI.field('摘要', el('div', { class: 'content-box' }, aiResult.summary || '(无)')),
          UI.field('整理正文', el('div', { class: 'content-box tall' }, aiResult.organized_body || '(无)')),
          aiResult.key_points && aiResult.key_points.length
            ? UI.field('提取要点', el('div', { class: 'content-box' }, aiResult.key_points.join('\n'))) : null,
          aiResult.reason ? el('div', { class: 'small muted' }, '推荐理由：' + aiResult.reason) : null,
          (aiResult.warnings || []).map(function (text) {
            return el('div', { class: 'small', style: { color: 'var(--warn)' } }, '⚠ ' + text);
          })
        ]) : (material.processing_status === 'failed'
          ? UI.emptyState('上一次 AI 整理失败', '可在上方手动分类并保存，原文已完整保留')
          : UI.emptyState('还没有 AI 处理结果', '点击「重新 AI 整理」生成分类建议'))
      ]),
      el('section', { class: 'panel' }, [
        el('h2', { class: 'panel-title' }, [
          '用户确认稿', el('span', { class: 'sub' }, bundle.reviews.length ? '已有 ' + bundle.reviews.length + ' 个版本' : '尚未保存')
        ]),
        UI.field('确认后的正文', reviewArea),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'ok',
            onclick: async function () {
              const ok = await guard(async function () {
                await state.repo.addReview(materialId, {
                  body: reviewArea.value, kind: 'confirmed', title: titleInput.value,
                  summary: aiResult ? aiResult.summary : null, analysis_id: latest ? latest.id : null
                });
                await state.repo.updateMaterial(materialId, { status: 'archived' });
              }, '整理稿已保存，材料已归档。');
              if (ok) await reload();
            }
          }, '保存并归档'),
          el('button', {
            onclick: async function () {
              const ok = await guard(function () {
                return state.repo.addReview(materialId, { body: reviewArea.value, kind: 'staged', title: titleInput.value });
              }, '已暂存整理稿。');
              if (ok) await reload();
            }
          }, '仅暂存'),
          el('button', {
            class: 'danger',
            onclick: async function () {
              const yes = await UI.confirmDialog('删除这条材料？可以在「设置」里通过备份恢复。', '删除');
              if (!yes) return;
              const ok = await guard(function () { return state.repo.deleteMaterial(materialId); }, '材料已删除。');
              if (ok) { controller.close(); await refresh(); loadLibrary(); }
            }
          }, '删除')
        ])
      ])
    ]);
  }

  function paneRaw() {
    return el('div', {}, bundle.raw.slice().reverse().map(function (raw) {
      return el('section', { class: 'panel' }, [
        el('div', { class: 'row tight mb' }, [
          chip('第 ' + raw.revision + ' 版', 'gray'),
          chip(raw.origin || 'manual', 'gray'),
          chip(raw.char_count + ' 字', 'gray')
        ]),
        el('div', { class: 'small muted mb' }, formatTime(raw.created_at)),
        el('div', { class: 'content-box tall' }, raw.body)
      ]);
    }).concat([
      el('section', { class: 'panel' }, [
        el('div', { class: 'small muted mb' }, '如需补充内容，请新增版本；历史原文不会被修改。'),
        el('button', {
          onclick: async function () {
            const values = await UI.openForm('追加原文版本', [
              { name: 'text', label: '新增原文内容', type: 'textarea', rows: 8, required: true }
            ], { submitLabel: '追加' });
            if (!values) return;
            const ok = await guard(function () {
              return state.repo.appendRaw(materialId, { text: values.text, origin: 'manual' });
            }, '已追加新的原文版本。');
            if (ok) await reload();
          }
        }, '追加原文版本')
      ])
    ]));
  }

  function paneAi() {
    if (!bundle.analyses.length) return UI.emptyState('还没有任何 AI 调用记录', '在材料详情里点击「调用 AI 整理」即可生成');
    return el('div', {}, bundle.analyses.map(function (analysis) {
      const result = analysis.result || {};
      return el('section', { class: 'panel' }, [
        el('div', { class: 'row tight mb' }, [
          chip(analysis.status === 'success' ? '成功' : '失败', analysis.status === 'success' ? 'ok' : 'danger'),
          chip(analysis.provider === 'mock' ? '离线规则引擎' : 'DeepSeek', analysis.provider === 'mock' ? 'warn' : ''),
          chip((analysis.latency_ms || 0) + ' ms', 'gray'),
          chip('尝试 ' + (analysis.attempts || 1) + ' 次', 'gray')
        ]),
        el('div', { class: 'small muted mb' }, formatTime(analysis.created_at)),
        analysis.status === 'success' ? el('div', {}, [
          UI.field('标题建议', el('div', { class: 'content-box' }, result.title || '')),
          UI.field('摘要', el('div', { class: 'content-box' }, result.summary || '')),
          UI.field('整理正文', el('div', { class: 'content-box tall' }, result.organized_body || ''))
        ]) : el('div', {}, [
          UI.field('错误', el('div', { class: 'content-box' }, analysis.error_message || '')),
          el('div', { class: 'small muted' }, '原文未受影响，可稍后重试或手动分类。')
        ])
      ]);
    }));
  }

  function paneReviews() {
    if (!bundle.reviews.length) return UI.emptyState('还没有保存过用户确认稿', '审核后点击「保存并归档」即可生成');
    return el('div', {}, bundle.reviews.map(function (review) {
      return el('section', { class: 'panel' }, [
        el('div', { class: 'row tight mb' }, [
          chip('第 ' + review.revision + ' 版', 'gray'),
          chip(review.kind === 'confirmed' ? '已确认' : '暂存', review.kind === 'confirmed' ? 'ok' : 'warn')
        ]),
        el('div', { class: 'small muted mb' }, formatTime(review.created_at)),
        el('div', { class: 'content-box tall' }, review.body)
      ]);
    }));
  }

  function paneMeta() {
    const material = bundle.material;
    const rows = [
      ['稳定 ID', material.id],
      ['材料状态', STATUS_LABEL[material.status] || material.status],
      ['处理状态', PROCESSING_LABEL[material.processing_status] || material.processing_status],
      ['来源', (bundle.source && bundle.source.name) || material.source_detail || '—'],
      ['录入方式', material.origin],
      ['原文版本数', String(bundle.raw.length)],
      ['AI 调用次数', String(bundle.analyses.length)],
      ['确认稿版本数', String(bundle.reviews.length)],
      ['创建时间', formatTime(material.created_at)],
      ['更新时间', formatTime(material.updated_at)]
    ];
    return el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title' }, '材料元数据'),
      el('table', { class: 'data' }, el('tbody', {}, rows.map(function (pair) {
        return el('tr', {}, [el('td', {}, pair[0]), el('td', {}, pair[1])]);
      })))
    ]);
  }

  const controller = UI.showModal({
    title: '材料详情',
    footer: false,
    body: [headerBox, bodyBox]
  });
  renderHeader();
  renderTabs();
}

/* ------------------------------------------------------------ 审核工作台 */

async function loadReview() {
  try {
    state.proposals = await state.repo.listProposals(state.proposalFilter, 100, null);
    const pending = await state.repo.listMaterials({ processing_status: 'raw,failed', limit: 50 });
    state.pendingMaterials = pending.items;
    if (state.proposals.length && !state.proposals.some(function (p) { return p.id === state.selectedProposalId; })) {
      state.selectedProposalId = state.proposals[0].id;
    }
  } catch (error) {
    UI.toast(error.message || String(error), 'error');
  }
  render();
}

function pageReview() {
  const container = el('div', {}, []);
  const filterSelect = el('select', {}, [
    ['proposed,staged', '待处理'], ['proposed', '仅待审核'], ['staged', '仅已暂存'],
    ['accepted,edited,rejected', '已处理'], ['', '全部']
  ].map(function (pair) {
    return el('option', { value: pair[0], selected: state.proposalFilter === pair[0] }, pair[1]);
  }));
  filterSelect.addEventListener('change', function () {
    state.proposalFilter = filterSelect.value;
    loadReview();
  });

  const listBox = el('div', { class: 'material-list' }, []);
  if (!state.proposals.length) {
    listBox.appendChild(UI.emptyState('当前没有待审核的 AI 建议', '导入材料后点击「保存并让 AI 整理」即可生成'));
  } else {
    state.proposals.forEach(function (proposal) {
      const active = proposal.id === state.selectedProposalId;
      listBox.appendChild(el('div', {
        class: 'material-card',
        style: active ? { borderColor: 'var(--accent)', background: 'var(--panel-2)' } : null,
        onclick: function () { state.selectedProposalId = proposal.id; render(); }
      }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'title' }, proposal.material_title || '(无标题)'),
          el('span', { class: 'spacer' }),
          chip(PROPOSAL_LABEL[proposal.status] || proposal.status, proposal.status === 'proposed' ? 'warn' : 'gray')
        ]),
        el('div', { class: 'meta' }, [
          chip(proposal.resolved_subject_name || proposal.subject_name || '科目未匹配',
            proposal.resolved_subject_name ? '' : 'warn'),
          chip(proposal.resolved_type_name || proposal.type_name || '类型未匹配', 'tag'),
          chip('置信度 ' + Math.round((proposal.confidence || 0) * 100) + '%', 'gray')
        ])
      ]));
    });
  }

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['审核工作台', el('span', { class: 'sub' }, 'AI 只提建议，最终由你决定')]),
    filterSelect,
    el('div', { class: 'mt' }, [listBox])
  ]));

  const selected = state.proposals.find(function (p) { return p.id === state.selectedProposalId; });
  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, '审核面板'),
    selected ? proposalPanel(selected) : UI.emptyState('从上方选择一条 AI 建议开始审核', '可以修改分类、编辑整理稿，再决定接受或拒绝')
  ]));

  const pendingPanel = el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['待整理材料', el('span', { class: 'sub' }, 'AI 失败或尚未整理')]),
    state.pendingMaterials.length
      ? el('div', { class: 'material-list' }, state.pendingMaterials.map(function (item) {
        return el('div', { class: 'material-card', style: { cursor: 'default' } }, [
          el('div', { class: 'title' }, item.title),
          el('div', { class: 'meta' }, [
            chip(PROCESSING_LABEL[item.processing_status] || item.processing_status,
              item.processing_status === 'failed' ? 'danger' : 'gray'),
            chip(formatTime(item.updated_at), 'gray')
          ]),
          el('div', { class: 'row tight mt' }, [
            el('button', {
              class: 'small',
              onclick: async function () { await runAnalyze(item.id, true); await loadReview(); }
            }, 'AI 整理'),
            el('button', {
              class: 'small', onclick: function () { manualClassifyDialog(item.id, loadReview); }
            }, '手动分类'),
            el('button', { class: 'small ghost', onclick: function () { openMaterialDetail(item.id); } }, '查看')
          ])
        ]);
      }))
      : UI.emptyState('没有待整理材料', '所有材料都已有 AI 结果或已人工分类')
  ]);
  container.appendChild(pendingPanel);

  return container;
}

function proposalPanel(proposal) {
  const payload = proposal.payload || {};
  const classifier = createClassifier({
    subject_id: proposal.subject_id || '',
    chapter_id: proposal.chapter_id || '',
    type_id: proposal.type_id || '',
    importance: proposal.importance || 0,
    tags: proposal.tags || []
  });
  const reviewArea = el('textarea', { rows: 7, placeholder: '可编辑确认后的整理稿（留空则不生成确认稿）' });
  reviewArea.value = payload.organized_body || '';
  const rawPreview = el('div', { class: 'content-box' }, '加载中…');

  state.repo.getBundle(proposal.material_id).then(function (bundle) {
    const raw = bundle.raw[bundle.raw.length - 1];
    rawPreview.textContent = raw ? raw.body : '(无原始内容)';
  });

  function act(action, extra, successMessage) {
    return async function () {
      const choice = classifier.read();
      const body = Object.assign({
        subject_id: choice.subject_id, chapter_id: choice.chapter_id, type_id: choice.type_id,
        importance: choice.importance, tags: choice.tags,
        review_body: reviewArea.value.trim() ? reviewArea.value : null
      }, extra || {});
      const ok = await guard(function () {
        if (action === 'accept') return state.repo.acceptProposal(proposal.id, body);
        if (action === 'edit') return state.repo.editProposal(proposal.id, body);
        if (action === 'stage') return state.repo.stageProposal(proposal.id, body);
        return state.repo.rejectProposal(proposal.id, body);
      }, successMessage);
      if (ok) { await refresh(); await loadReview(); }
    };
  }

  const suggested = proposal.suggested_new || {};
  const suggestions = Object.keys(suggested).map(function (key) {
    return el('div', { class: 'small', style: { color: 'var(--warn)' } }, 'AI 建议新增 ' + key + '：' + suggested[key]);
  });

  return el('div', {}, [
    el('div', { class: 'row tight mb' }, [
      chip('置信度 ' + Math.round((proposal.confidence || 0) * 100) + '%', 'gray'),
      chip(PROPOSAL_LABEL[proposal.status] || proposal.status, 'gray')
    ]),
    el('div', { class: 'small muted mb' }, proposal.reason || '（AI 未给出理由）'),
    suggestions,
    el('div', { class: 'row tight mb' }, [
      chip('科目：' + (proposal.resolved_subject_name || proposal.subject_name || '未匹配'),
        proposal.resolved_subject_name ? '' : 'warn'),
      chip('章节：' + (proposal.resolved_chapter_name || proposal.chapter_name || '未匹配'), 'gray'),
      chip('类型：' + (proposal.resolved_type_name || proposal.type_name || '未匹配'), 'tag')
    ]),
    payload.summary ? UI.field('AI 摘要', el('div', { class: 'content-box' }, payload.summary)) : null,
    UI.field('人工确认（可修改、可新建）', classifier.node),
    el('div', { class: 'row tight mb' }, [
      el('button', {
        class: 'small ghost',
        onclick: function () { reviewArea.value = payload.organized_body || ''; UI.toast('已填入 AI 整理正文', 'ok'); }
      }, '填入 AI 正文'),
      el('button', { class: 'small ghost', onclick: function () { createTaxonomyDialog('subject'); } }, '新建科目'),
      el('button', { class: 'small ghost', onclick: function () { createTaxonomyDialog('chapter'); } }, '新建章节'),
      el('button', { class: 'small ghost', onclick: function () { createTaxonomyDialog('type'); } }, '新建类型')
    ]),
    UI.field('确认后的整理稿', reviewArea),
    el('div', { class: 'row' }, [
      el('button', { class: 'ok', onclick: act('accept', { archive: true, review_kind: 'confirmed' }, '已接受建议并归档。') }, '接受并归档'),
      el('button', { class: 'primary', onclick: act('edit', { review_kind: 'confirmed' }, '已保存修改。') }, '保存修改'),
      el('button', { class: 'warn', onclick: act('stage', { review_kind: 'staged' }, '已暂存。') }, '暂存'),
      el('button', { class: 'danger', onclick: act('reject', {}, '已拒绝该建议，原文保持不变。') }, '拒绝')
    ]),
    UI.field('原始材料（只读）', rawPreview)
  ]);
}

async function createTaxonomyDialog(kind) {
  if (kind === 'subject') {
    const values = await UI.openForm('新建科目', [{ name: 'name', label: '科目名称', type: 'text', required: true }]);
    if (!values) return;
    await guard(async function () { await state.repo.createSubject({ name: values.name }); await refresh(); }, '科目已创建');
  } else if (kind === 'chapter') {
    const values = await UI.openForm('新建章节', [
      { name: 'subject_id', label: '所属科目', type: 'select', required: true,
        options: state.snapshot.subjects.map(function (s) { return { value: s.id, label: s.name }; }) },
      { name: 'name', label: '章节名称', type: 'text', required: true }
    ]);
    if (!values) return;
    await guard(async function () {
      await state.repo.createChapter({ name: values.name, subject_id: values.subject_id });
      await refresh();
    }, '章节已创建');
  } else {
    const values = await UI.openForm('新建材料类型', [{ name: 'name', label: '类型名称', type: 'text', required: true }]);
    if (!values) return;
    await guard(async function () { await state.repo.createType({ name: values.name }); await refresh(); }, '类型已创建');
  }
  render();
}

async function manualClassifyDialog(materialId, onDone) {
  const values = await UI.openForm('手动分类', [
    { name: 'subject_id', label: '科目', type: 'select', required: true,
      options: state.snapshot.subjects.map(function (s) { return { value: s.id, label: s.name }; }) },
    { name: 'chapter_id', label: '章节', type: 'select',
      options: [{ value: '', label: '— 不指定 —' }].concat(state.snapshot.chapters.map(function (c) {
        const path = chapterPath(c.id);
        return { value: c.id, label: path.length ? path.join(' / ') : c.name };
      })) },
    { name: 'type_id', label: '材料类型', type: 'select',
      options: [{ value: '', label: '— 不指定 —' }].concat(state.snapshot.types.map(function (t) {
        return { value: t.id, label: t.name };
      })) },
    { name: 'importance', label: '重要程度（0-5）', type: 'number', value: 3 },
    { name: 'review_body', label: '整理稿（可选）', type: 'textarea', rows: 4 }
  ], { submitLabel: '保存并归档' });
  if (!values) return;
  const ok = await guard(function () {
    return state.repo.manualClassify(materialId, {
      subject_id: values.subject_id, chapter_id: values.chapter_id || null,
      type_id: values.type_id || null, importance: values.importance,
      review_body: values.review_body || null, archive: true, decided_by: 'manual_fallback'
    });
  }, '已手动分类并归档。');
  if (ok) { await refresh(); if (onDone) await onDone(); }
}

/* ---------------------------------------------------------------- 分类管理 */

function pageTaxonomy() {
  const container = el('div', {}, []);
  const snapshot = state.snapshot;

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, [
      '科目', el('span', { class: 'sub' }, '完全自定义，代码里没有写死任何科目')
    ]),
    el('div', { class: 'material-list' }, snapshot.subjects.map(function (subject) {
      return el('div', { class: 'material-card', style: { cursor: 'default' } }, [
        el('div', { class: 'row' }, [
          el('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: subject.color || 'var(--accent)' } }),
          el('div', { class: 'title' }, subject.name),
          el('span', { class: 'spacer' }),
          chip(subject.code || '—', 'gray')
        ]),
        el('div', { class: 'row tight mt' }, [
          el('button', {
            class: 'small',
            onclick: async function () {
              const values = await UI.openForm('编辑科目', [
                { name: 'name', label: '名称', type: 'text', value: subject.name, required: true },
                { name: 'code', label: '代码', type: 'text', value: subject.code || '' },
                { name: 'keywords', label: '关键词（逗号分隔）', type: 'text',
                  value: (JSON.parse(subject.keywords || '[]') || []).join(',') }
              ]);
              if (!values) return;
              await guard(async function () { await state.repo.updateSubject(subject.id, values); await refresh(); }, '已更新');
              render();
            }
          }, '编辑'),
          el('button', {
            class: 'small danger',
            onclick: async function () {
              const yes = await UI.confirmDialog('删除科目「' + subject.name + '」？其下章节与类型会一并删除。', '删除');
              if (!yes) return;
              await guard(async function () { await state.repo.deleteSubject(subject.id); await refresh(); }, '已删除');
              render();
            }
          }, '删除')
        ])
      ]);
    })),
    el('button', {
      class: 'primary mt',
      onclick: async function () {
        const values = await UI.openForm('新建科目', [
          { name: 'name', label: '名称', type: 'text', required: true },
          { name: 'code', label: '代码', type: 'text' },
          { name: 'keywords', label: '关键词（逗号分隔）', type: 'text' }
        ]);
        if (!values) return;
        await guard(async function () { await state.repo.createSubject(values); await refresh(); }, '科目已创建');
        render();
      }
    }, '新建科目')
  ]));

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['章节', el('span', { class: 'sub' }, '共 ' + snapshot.chapters.length + ' 个')]),
    el('div', { class: 'table-scroll' }, el('table', { class: 'data' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, '章节路径'), el('th', {}, '操作')])),
      el('tbody', {}, snapshot.chapters.map(function (chapter) {
        return el('tr', {}, [
          el('td', {}, chapterPath(chapter.id).join(' / ')),
          el('td', {}, el('div', { class: 'row tight' }, [
            el('button', {
              class: 'small',
              onclick: async function () {
                const values = await UI.openForm('重命名章节', [
                  { name: 'name', label: '名称', type: 'text', value: chapter.name, required: true }
                ]);
                if (!values) return;
                await guard(async function () { await state.repo.updateChapter(chapter.id, values); await refresh(); }, '已更新');
                render();
              }
            }, '改名'),
            el('button', {
              class: 'small danger',
              onclick: async function () {
                const yes = await UI.confirmDialog('删除章节「' + chapter.name + '」？', '删除');
                if (!yes) return;
                await guard(async function () { await state.repo.deleteChapter(chapter.id); await refresh(); }, '已删除');
                render();
              }
            }, '删除')
          ]))
        ]);
      }))
    ])),
    el('button', {
      class: 'primary mt',
      onclick: async function () {
        const values = await UI.openForm('新建章节', [
          { name: 'subject_id', label: '所属科目', type: 'select', required: true,
            options: snapshot.subjects.map(function (s) { return { value: s.id, label: s.name }; }) },
          { name: 'parent_id', label: '上级章节', type: 'select',
            options: [{ value: '', label: '— 顶层章节 —' }].concat(snapshot.chapters.map(function (c) {
              return { value: c.id, label: chapterPath(c.id).join(' / ') };
            })) },
          { name: 'name', label: '名称', type: 'text', required: true }
        ]);
        if (!values) return;
        await guard(async function () {
          await state.repo.createChapter({ name: values.name, subject_id: values.subject_id, parent_id: values.parent_id || null });
          await refresh();
        }, '章节已创建');
        render();
      }
    }, '新建章节')
  ]));

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['材料类型']),
    el('div', { class: 'pill-list' }, snapshot.types.map(function (type) {
      return el('span', { class: 'chip tag' }, [
        type.name,
        el('button', {
          class: 'ghost small', style: { padding: '0 4px', marginLeft: '4px', minHeight: 'auto' },
          onclick: async function () {
            const yes = await UI.confirmDialog('删除材料类型「' + type.name + '」？', '删除');
            if (!yes) return;
            await guard(async function () { await state.repo.deleteType(type.id); await refresh(); }, '已删除');
            render();
          }
        }, '✕')
      ]);
    })),
    el('button', {
      class: 'primary mt',
      onclick: async function () {
        const values = await UI.openForm('新建材料类型', [
          { name: 'name', label: '名称', type: 'text', required: true },
          { name: 'keywords', label: '关键词（逗号分隔）', type: 'text' }
        ]);
        if (!values) return;
        await guard(async function () { await state.repo.createType(values); await refresh(); }, '已创建');
        render();
      }
    }, '新建类型')
  ]));

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['标签']),
    el('div', { class: 'pill-list' }, snapshot.tags.map(function (tag) {
      return el('span', { class: 'chip tag' }, [
        tag.name + (tag.usage_count ? '（' + tag.usage_count + '）' : ''),
        el('button', {
          class: 'ghost small', style: { padding: '0 4px', marginLeft: '4px', minHeight: 'auto' },
          onclick: async function () {
            const yes = await UI.confirmDialog('删除标签「' + tag.name + '」？', '删除');
            if (!yes) return;
            await guard(async function () { await state.repo.deleteTag(tag.id); await refresh(); }, '已删除');
            render();
          }
        }, '✕')
      ]);
    })),
    el('button', {
      class: 'primary mt',
      onclick: async function () {
        const values = await UI.openForm('新建标签', [{ name: 'name', label: '标签名', type: 'text', required: true }]);
        if (!values) return;
        await guard(async function () { await state.repo.getOrCreateTag(values.name); await refresh(); }, '已创建');
        render();
      }
    }, '新建标签')
  ]));

  return container;
}

/* ---------------------------------------------------------------- 设置页 */

function pageSettings() {
  const container = el('div', {}, []);
  const settings = state.settings || {};

  const providerSelect = el('select', {}, [
    ['auto', '自动（有 Key 用 DeepSeek，否则用离线引擎）'],
    ['deepseek', '强制使用 DeepSeek'],
    ['mock', '强制使用离线规则引擎'],
    ['off', '关闭 AI 功能']
  ].map(function (pair) {
    return el('option', { value: pair[0], selected: settings['ai.provider'] === pair[0] }, pair[1]);
  }));
  const baseUrlInput = el('input', { type: 'text', value: settings['ai.base_url'] || '' });
  const modelInput = el('input', { type: 'text', value: settings['ai.model'] || '' });
  const keyInput = el('input', { type: 'password', placeholder: settings['ai.api_key'] ? '已保存（留空则不修改）' : '尚未配置' });
  const timeoutInput = el('input', { type: 'number', value: settings['ai.timeout_seconds'] || '45' });
  const retriesInput = el('input', { type: 'number', value: settings['ai.max_retries'] || '2' });

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, [
      'AI 设置',
      chip(PROVIDER_LABEL[state.provider] || state.provider, state.provider === 'mock' ? 'warn' : 'ok')
    ]),
    el('div', { class: 'notice info small mb' },
      'API Key 保存在这台手机本地，只用于浏览器直连 DeepSeek，不经过任何第三方服务器。'),
    UI.field('提供方', providerSelect),
    UI.field('接口地址', baseUrlInput),
    UI.field('模型', modelInput),
    UI.field('API Key', keyInput),
    el('div', { class: 'row', style: { gap: '10px' } }, [
      el('div', { style: { flex: '1 1 120px' } }, UI.field('超时（秒）', timeoutInput)),
      el('div', { style: { flex: '1 1 120px' } }, UI.field('重试次数', retriesInput))
    ]),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary',
        onclick: async function () {
          const patch = {
            'ai.provider': providerSelect.value, 'ai.base_url': baseUrlInput.value,
            'ai.model': modelInput.value, 'ai.timeout_seconds': timeoutInput.value,
            'ai.max_retries': retriesInput.value
          };
          if (keyInput.value) patch['ai.api_key'] = keyInput.value;
          await guard(async function () { await state.repo.saveSettings(patch); await refresh(); }, '设置已保存。');
          render();
        }
      }, '保存设置'),
      el('button', {
        onclick: async function () {
          const node = UI.toast('正在测试连接…', '', 3000);
          const result = await state.repo.testConnection({
            provider: providerSelect.value,
            api_key: keyInput.value || undefined,
            base_url: baseUrlInput.value || undefined,
            model: modelInput.value || undefined
          });
          if (node.parentNode) node.parentNode.removeChild(node);
          UI.toast(result.message || (result.ok ? '连接正常' : '连接失败'), result.ok ? 'ok' : 'error', 7000);
        }
      }, '测试连接')
    ]),
    el('details', { class: 'advanced' }, [
      el('summary', {}, '高级：清除本地 API Key'),
      el('button', {
        class: 'danger small mt',
        onclick: async function () {
          await guard(async function () { await state.repo.saveSettings({ 'ai.api_key': '' }); await refresh(); }, '已清除 API Key');
          render();
        }
      }, '清除 Key')
    ])
  ]));

  /* ---- 数据与备份 ---- */
  const statsBox = el('div', { class: 'stat-grid' }, [
    el('div', { class: 'stat' }, [el('div', { class: 'value' }, String((state.snapshot.counts || {}).materials || 0)), el('div', { class: 'label' }, '材料总数')]),
    el('div', { class: 'stat' }, [el('div', { class: 'value' }, String((state.snapshot.counts || {}).pendingProposals || 0)), el('div', { class: 'label' }, '待审核建议')])
  ]);

  const importInput = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  importInput.addEventListener('change', async function () {
    const file = (importInput.files || [])[0];
    importInput.value = '';
    if (!file) return;
    const yes = await UI.confirmDialog('导入备份会**完全覆盖**手机上的现有数据。建议先导出一份当前备份。确定继续？', '覆盖导入');
    if (!yes) return;
    await guard(async function () {
      const text = await file.text();
      const dump = JSON.parse(text);
      const counts = await state.repo.restoreAll(dump);
      await refresh();
      render();
      UI.toast('恢复完成，共导入 ' + (counts.materials || 0) + ' 条材料。', 'ok', 6000);
    });
  });

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, ['数据与备份', el('span', { class: 'sub' }, '数据只存在这台手机上')]),
    statsBox,
    el('div', { class: 'notice small mt' },
      '浏览器的存储空间可能被系统清理（清理浏览器数据、长期不用、空间不足）。'
      + '请养成定期导出备份的习惯，备份文件可以存到微信收藏、网盘或相册文件夹。'),
    el('div', { class: 'row mt' }, [
      el('button', {
        class: 'primary',
        onclick: async function () {
          await guard(async function () {
            const dump = await state.repo.dumpAll();
            const stamp = nowIso().replace(/[:.]/g, '-').slice(0, 19);
            downloadBlob('kaoyan-backup-' + stamp + '.json', JSON.stringify(dump, null, 2), 'application/json');
          }, '备份文件已导出。');
        }
      }, '导出完整备份'),
      el('button', { onclick: function () { importInput.click(); } }, '从备份恢复'),
      importInput
    ]),
    el('details', { class: 'advanced' }, [
      el('summary', {}, '导出为可读格式（JSON / CSV / Markdown）'),
      el('div', { class: 'row mt' }, [
        el('button', {
          class: 'small',
          onclick: function () {
            guard(async function () {
              const out = await state.repo.exportMaterials('json', {});
              downloadBlob(out.filename, out.content, out.mime);
            }, '已导出 JSON');
          }
        }, 'JSON'),
        el('button', {
          class: 'small',
          onclick: function () {
            guard(async function () {
              const out = await state.repo.exportMaterials('csv', {});
              downloadBlob(out.filename, out.content, out.mime);
            }, '已导出 CSV');
          }
        }, 'CSV'),
        el('button', {
          class: 'small',
          onclick: function () {
            guard(async function () {
              const out = await state.repo.exportMaterials('markdown', {});
              downloadBlob(out.filename, out.content, out.mime);
            }, '已导出 Markdown');
          }
        }, 'Markdown')
      ])
    ])
  ]));

  /* ---- 存储与安装 ---- */
  const storageBox = el('div', {}, [el('div', { class: 'small muted' }, '正在读取存储信息…')]);

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, '存储与安装'),
    storageBox,
    el('div', { class: 'row mt' }, [
      el('button', {
        onclick: async function () {
          const result = await requestPersistentStorage();
          UI.toast(result.message, result.ok ? 'ok' : 'warn', 6000);
          render();
        }
      }, '申请持久化存储'),
      state.installPrompt ? el('button', {
        class: 'primary',
        onclick: async function () {
          const prompt = state.installPrompt;
          state.installPrompt = null;
          prompt.prompt();
          await prompt.userChoice;
          render();
        }
      }, '安装到主屏幕') : null
    ]),
    el('div', { class: 'small muted mt' }, installHint())
  ]));

  renderStorageInfo(storageBox);

  container.appendChild(el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title' }, '关于'),
    el('div', { class: 'small muted' }, [
      el('div', {}, '版本 ' + APP_VERSION),
      el('div', {}, '纯前端应用：数据保存在本机 IndexedDB，AI 由浏览器直连 DeepSeek。'),
      el('div', {}, '未配置 API Key 时使用内置离线规则引擎，完全离线可用。'),
      el('div', {}, '当前阶段不包含知识图谱、间隔重复与变式题生成。')
    ])
  ]));

  return container;
}

async function renderStorageInfo(box) {
  UI.clear(box);
  const lines = [];
  const stats = await state.repo.storageStats();
  lines.push(el('div', { class: 'small' }, '原文版本 ' + stats.material_raw + ' 条 · AI 记录 ' + stats.ai_analyses + ' 条 · 确认稿 ' + stats.material_reviews + ' 条'));

  if (navigator.storage && navigator.storage.persisted) {
    const persisted = await navigator.storage.persisted();
    lines.push(el('div', { class: 'small mt' }, persisted
      ? '持久化存储：已开启（系统不会自动清理本站数据）'
      : '持久化存储：未开启（建议点击下方按钮申请）'));
  }
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const used = (estimate.usage || 0) / 1024 / 1024;
    const quota = (estimate.quota || 0) / 1024 / 1024;
    lines.push(el('div', { class: 'small muted' }, '已用约 ' + used.toFixed(2) + ' MB，可用约 ' + quota.toFixed(0) + ' MB'));
  }
  UI.append(box, lines);
}

async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) {
    return { ok: false, message: '当前浏览器不支持申请持久化存储，请更频繁地导出备份。' };
  }
  const granted = await navigator.storage.persist();
  return granted
    ? { ok: true, message: '已获得持久化存储权限，系统不会自动清理你的数据。' }
    : { ok: false, message: '浏览器未授予持久化权限（可能因为使用频率不够）。请定期导出备份。' };
}

function installHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return '已作为独立应用运行。';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS：用 Safari 打开本页 → 分享按钮 → 「添加到主屏幕」。';
  if (/Android/i.test(ua)) return 'Android：用 Chrome 打开本页 → 右上菜单 → 「安装应用」或「添加到主屏幕」。';
  return '可在手机浏览器中「添加到主屏幕」，以独立应用方式使用。';
}

/* ------------------------------------------------------------------ 启动 */

function safeStorageFlag() {
  try { return localStorage.getItem('kaoyan.installed') || ''; } catch (error) { return ''; }
}

async function boot() {
  const view = UI.$('view');
  UI.clear(view);
  view.appendChild(el('div', { class: 'boot-screen' }, [
    el('span', { class: 'spinner' }),
    el('div', {}, '正在准备本地数据库…')
  ]));

  try {
    const driver = await openDatabase('kaoyan-archive');
    state.repo = new Repository(driver);
    await state.repo.init();
    await refresh();
  } catch (error) {
    UI.clear(view);
    view.appendChild(el('div', { class: 'notice' }, [
      el('div', {}, '初始化失败：' + (error.message || String(error))),
      el('div', { class: 'small muted mt' }, '如果使用了无痕/隐私模式，IndexedDB 可能不可用。请改用普通模式打开。')
    ]));
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const requested = params.get('tab');
  if (requested && TABS.some(function (tab) { return tab.key === requested; })) state.tab = requested;

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    state.installPrompt = event;
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(function () { return null; });
  }

  if (state.tab === 'review') await loadReview();
  else if (state.tab === 'library') await loadLibrary();
  else render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
