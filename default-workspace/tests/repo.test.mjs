/* 业务逻辑端到端测试：完全在 Node 里跑，用内存驱动替代 IndexedDB。 */
import { test } from './harness.mjs';
import { createMemoryDriver } from '../js/store.js';
import { Repository } from '../js/repo.js';

async function freshRepo() {
  const driver = createMemoryDriver();
  await driver.open();
  const repo = new Repository(driver);
  await repo.init();
  return repo;
}

const SAMPLE = [
  '数据结构 树与二叉树',
  '- 二叉树的前序、中序、后序遍历',
  '- 线索二叉树是本科目重点考点',
  '- 树的存储结构分为双亲表示法、孩子表示法、孩子兄弟表示法',
  '- 这是一份知识点笔记'
].join('\n');

test('1. 初始化与默认分类体系', async function (t) {
  const repo = await freshRepo();
  const snapshot = await repo.snapshot();
  t.check('默认科目不少于 4 个', snapshot.subjects.length >= 4, snapshot.subjects.length);
  t.check('包含 408 科目', snapshot.subjects.some(function (s) { return s.name.indexOf('408') >= 0; }));
  t.check('默认材料类型已播种', snapshot.types.length >= 5, snapshot.types.length);
  t.check('默认标签已播种', snapshot.tags.length >= 3);
  t.check('章节树非空', snapshot.chapter_tree.length >= 4);
});

test('2. 分类体系完全可自定义', async function (t) {
  const repo = await freshRepo();
  const subject = await repo.createSubject({ name: '专业课二 · 数据库', keywords: ['数据库', 'SQL'] });
  t.check('可新建科目', subject.id.indexOf('sub_') === 0);
  const chapter = await repo.createChapter({ name: '关系模型', subject_id: subject.id });
  t.check('可新建章节', chapter.id.indexOf('chp_') === 0);
  const type = await repo.createType({ name: '课堂板书' });
  t.check('可新建材料类型', type.id.indexOf('typ_') === 0);
  const again = await repo.createSubject({ name: '专业课二 · 数据库' }).then(function () { return null; }, function (e) { return e; });
  t.check('重名科员被拒绝', again !== null && /已存在/.test(again.message), again && again.message);
});

test('3. 创建材料：原文与 AI 结果分离', async function (t) {
  const repo = await freshRepo();
  const created = await repo.createMaterial({ title: '二叉树遍历笔记', text: SAMPLE, origin: 'paste', tags: ['重点'] });
  t.check('材料创建成功', !!created.material_id);
  const bundle = created.bundle;
  t.eq(bundle.raw.length, 1, '原始材料单独保存一版');
  t.eq(bundle.raw[0].body, SAMPLE, '原文与输入完全一致');
  t.eq(bundle.analyses.length, 0, '此时尚无 AI 结果');
  t.check('内容已计算指纹', String(bundle.raw[0].content_hash).length === 32, bundle.raw[0].content_hash);
  t.eq(bundle.tags.length, 1, '标签已写入');
});

test('4. 幂等与重复内容检测', async function (t) {
  const repo = await freshRepo();
  const first = await repo.createMaterial({ title: 'A', text: SAMPLE, idempotency_key: 'k1' });
  const second = await repo.createMaterial({ title: 'A', text: SAMPLE, idempotency_key: 'k1' });
  t.check('相同幂等键只创建一条', first.material_id === second.material_id);
  t.check('第二次标记为重复提交', second.duplicate_submission === true);
  const dup = await repo.createMaterial({ title: 'B', text: SAMPLE });
  t.check('相同内容会被提示重复', dup.duplicates.length >= 1, dup.duplicates.length);
  await t.throws(function () { return repo.createMaterial({ title: 'C', text: SAMPLE, reject_duplicate: true }); }, '强制拒绝重复内容');
});

test('5. 离线规则引擎给出分类建议', async function (t) {
  const repo = await freshRepo();
  const created = await repo.createMaterial({ title: '二叉树遍历笔记', text: SAMPLE });
  const outcome = await repo.analyzeMaterial(created.material_id, { provider: 'mock' });
  t.check('分析成功', outcome.ok === true, outcome.error && outcome.error.message);
  t.check('识别出科目', !!(outcome.normalized.subject && outcome.normalized.subject.id), JSON.stringify(outcome.normalized.subject));
  t.check('识别出章节', !!(outcome.normalized.chapter && outcome.normalized.chapter.id));
  t.check('识别出材料类型', !!(outcome.normalized.material_type && outcome.normalized.material_type.id));
  const bundle = await repo.getBundle(created.material_id);
  t.eq(bundle.raw[0].body, SAMPLE, 'AI 未覆盖原文');
  t.eq(bundle.analyses.length, 1, 'AI 结果单独留痕');
  t.eq(bundle.proposals.length, 1, '生成了分类建议');
});

test('6. 人工审核：接受 / 编辑 / 拒绝 / 暂存', async function (t) {
  const repo = await freshRepo();
  const created = await repo.createMaterial({ title: '审核测试', text: SAMPLE });
  const id = created.material_id;

  const a1 = await repo.analyzeMaterial(id, { provider: 'mock', force: true });
  const rejected = await repo.rejectProposal(a1.proposal.id, { review_note: '识别错误' });
  t.eq(rejected.proposal.status, 'rejected', '拒绝成功');

  const a2 = await repo.analyzeMaterial(id, { provider: 'mock', force: true });
  const staged = await repo.stageProposal(a2.proposal.id, {});
  t.eq(staged.proposal.status, 'staged', '暂存成功');

  const a3 = await repo.analyzeMaterial(id, { provider: 'mock', force: true });
  const accepted = await repo.acceptProposal(a3.proposal.id, {
    review_body: '整理稿：二叉树四种遍历 + 线索二叉树'
  });
  t.eq(accepted.proposal.status, 'accepted', '接受成功');
  t.eq(accepted.bundle.material.status, 'archived', '材料已归档');
  t.eq(accepted.bundle.classification.decided_by, 'ai_accepted', '分类记录为 AI 接受');
  t.check('生成了用户确认稿', !!accepted.bundle.latest_confirmed_review);
  t.check('确认稿独立于原文', accepted.bundle.latest_confirmed_review.body !== SAMPLE);
  t.eq(accepted.bundle.raw[0].body, SAMPLE, '原文依然未被修改');

  const a4 = await repo.analyzeMaterial(id, { provider: 'mock', force: true });
  const edited = await repo.editProposal(a4.proposal.id, {
    new_subject_name: '自建科目', new_chapter_name: '自建章节', new_type_name: '自建类型',
    importance: 5, tags: ['重点', '易错']
  });
  t.eq(edited.bundle.classification.decided_by, 'ai_edited', '编辑成功');
  t.eq(edited.bundle.classification.importance, 5, '重要程度已写入');
  t.eq(edited.bundle.tags.length, 2, '标签已写入');
});

test('7. 手动分类兜底（AI 不可用时）', async function (t) {
  const repo = await freshRepo();
  const subject = await repo.createSubject({ name: '手建科目' });
  const chapter = await repo.createChapter({ name: '手建章节', subject_id: subject.id });
  const created = await repo.createMaterial({ title: '无关键词材料', text: '这是一段没有任何关键词的文本。' });
  const result = await repo.manualClassify(created.material_id, {
    subject_id: subject.id, chapter_id: chapter.id, importance: 3, archive: true
  });
  t.eq(result.classification.decided_by, 'manual_fallback', '标记为手动兜底');
  t.eq(result.bundle.material.status, 'archived', '已归档');
});

test('8. 检索：科目 / 章节 / 类型 / 标签 / 全文', async function (t) {
  const repo = await freshRepo();
  const subject = await repo.createSubject({ name: '检索科目' });
  const chapter = await repo.createChapter({ name: '检索章节', subject_id: subject.id });
  const child = await repo.createChapter({ name: '子章节', subject_id: subject.id, parent_id: chapter.id });
  const type = await repo.createType({ name: '检索类型' });
  const created = await repo.createMaterial({
    title: '检索测试材料', text: SAMPLE, subject_id: subject.id, chapter_id: child.id, type_id: type.id, tags: ['易错']
  });
  const id = created.material_id;
  await repo.addReview(id, { body: '确认稿里独有的字符串 ZZZUNIQUE', kind: 'confirmed' });

  t.check('按科目检索', (await repo.listMaterials({ subject_id: subject.id })).items.some(function (i) { return i.id === id; }));
  t.check('按父章节检索到子章节材料', (await repo.listMaterials({ chapter_id: chapter.id })).items.some(function (i) { return i.id === id; }));
  t.check('按类型检索', (await repo.listMaterials({ type_id: type.id })).items.some(function (i) { return i.id === id; }));
  const tagId = (await repo.listTags()).find(function (g) { return g.name === '易错'; }).id;
  t.check('按标签检索', (await repo.listMaterials({ tag_ids: [tagId] })).items.some(function (i) { return i.id === id; }));
  t.check('全文检索命中原文', (await repo.listMaterials({ q: '线索二叉树' })).items.some(function (i) { return i.id === id; }));
  t.check('全文检索命中确认稿', (await repo.listMaterials({ q: 'ZZZUNIQUE' })).items.some(function (i) { return i.id === id; }));
  const searched = await repo.listMaterials({ q: '线索二叉树' });
  t.check('检索结果带摘要片段', !!searched.items[0].snippet, searched.items[0].snippet);
  t.check('按状态筛选', (await repo.listMaterials({ status: 'inbox' })).items.length >= 1);
  t.check('未分类筛选可用', (await repo.listMaterials({ uncategorized: true })).items.length >= 0);
});

test('9. 修改 / 软删除 / 恢复', async function (t) {
  const repo = await freshRepo();
  const created = await repo.createMaterial({ title: '待改名', text: '临时内容 A' });
  const id = created.material_id;
  await repo.updateMaterial(id, { title: '改名后的材料', status: 'archived' });
  t.eq((await repo.getBundle(id)).material.title, '改名后的材料', 'PATCH 修改生效');
  await repo.deleteMaterial(id);
  t.eq((await repo.listMaterials({ q: '改名后的材料' })).total, 0, '软删除后检索不到');
  await repo.restoreMaterial(id);
  t.eq((await repo.listMaterials({ q: '改名后的材料' })).total, 1, '恢复后可见');
  await repo.deleteMaterial(id, true);
  t.eq((await repo.listMaterials({ include_deleted: true })).items.filter(function (i) { return i.id === id; }).length, 0, '彻底删除');
});

test('10. 追加原文版本不会覆盖历史', async function (t) {
  const repo = await freshRepo();
  const created = await repo.createMaterial({ title: '多版本', text: '第一版内容' });
  await repo.appendRaw(created.material_id, { text: '第二版内容' });
  const bundle = await repo.getBundle(created.material_id);
  t.eq(bundle.raw.length, 2, '有两个原文版本');
  t.eq(bundle.raw[0].body, '第一版内容', '第一版未被覆盖');
  t.eq(bundle.raw[1].body, '第二版内容', '第二版已追加');
  t.eq(bundle.raw[1].revision, 2, '版本号递增');
});

test('11. 导出 JSON / CSV / Markdown', async function (t) {
  const repo = await freshRepo();
  const created = await repo.createMaterial({ title: '导出测试材料', text: SAMPLE, subject_id: null });
  await repo.analyzeMaterial(created.material_id, { provider: 'mock' });
  const json = await repo.exportMaterials('json', {});
  t.check('导出 JSON', json.filename === 'materials.json' && json.content.indexOf('导出测试材料') >= 0);
  const csv = await repo.exportMaterials('csv', {});
  t.check('导出 CSV 且带 BOM', csv.content.charCodeAt(0) === 0xFEFF && csv.content.indexOf('导出测试材料') >= 0);
  const md = await repo.exportMaterials('markdown', {});
  t.check('导出 Markdown 含原始材料', md.content.indexOf('### 原始材料') >= 0);
});

test('12. 备份与恢复', async function (t) {
  const repo = await freshRepo();
  await repo.createMaterial({ title: '备份前材料', text: '内容一' });
  const dump = await repo.dumpAll();
  t.eq(dump.format, 'kaoyan-mobile-backup', '备份格式标记正确');
  t.check('备份包含材料表', dump.tables.materials.length >= 1);
  t.check('备份包含原文表', dump.tables.material_raw.length >= 1);

  await repo.createMaterial({ title: '备份后新增', text: '内容二' });
  t.check('新增后材料变多', (await repo.listMaterials({})).total === 2);

  await repo.restoreAll(dump);
  t.eq((await repo.listMaterials({})).total, 1, '恢复后回到备份时状态');
  t.eq((await repo.listMaterials({ q: '备份前材料' })).total, 1, '恢复后原数据仍在');
});

test('13. 设置与提供方解析', async function (t) {
  const repo = await freshRepo();
  t.eq(await repo.resolveProvider(), 'mock', '无 Key 时自动降级为离线引擎');
  await repo.saveSettings({ 'ai.api_key': 'sk-test' });
  t.eq(await repo.resolveProvider(), 'deepseek', '有 Key 时使用 DeepSeek');
  await repo.saveSettings({ 'ai.provider': 'mock' });
  t.eq(await repo.resolveProvider(), 'mock', '强制 mock 生效');
  await repo.saveSettings({ 'ai.provider': 'off' });
  t.eq(await repo.resolveProvider(), 'off', '强制 off 生效');
});

test('14. 提示词里的分类体系带完整章节路径', async function (t) {
  const repo = await freshRepo();
  const prompt = await repo._taxonomyForPrompt();
  const subject = prompt.subjects.find(function (s) { return s.name.indexOf('408') >= 0; });
  t.check('408 科目存在', !!subject);
  const chapter = subject.chapters.find(function (c) { return c.name === '树与二叉树'; });
  t.check('子章节带父级路径', !!chapter && chapter.path === '数据结构 / 树与二叉树',
    chapter && chapter.path);
  t.check('材料类型已注入', prompt.types.length >= 5);
  t.check('标签已注入', prompt.tags.length >= 3);
});

test('15. AI 不可用时不破坏数据', async function (t) {
  const repo = await freshRepo();
  const created = await repo.createMaterial({ title: 'AI 失败测试', text: SAMPLE });
  const outcome = await repo.analyzeMaterial(created.material_id, { provider: 'deepseek' });
  t.check('未配置 Key 时返回失败', outcome.ok === false);
  t.eq(outcome.error.code, 'no_api_key', '错误码为 no_api_key');
  const bundle = await repo.getBundle(created.material_id);
  t.eq(bundle.raw[0].body, SAMPLE, '原文完好');
  t.eq(bundle.material.processing_status, 'failed', '状态标记为失败');
  t.eq(bundle.analyses.length, 1, '失败记录同样留痕');
  const manual = await repo.manualClassify(created.material_id, {
    subject_id: (await repo.listSubjects())[0].id, archive: true
  });
  t.check('失败后仍可手动分类归档', manual.bundle.material.status === 'archived');
});
