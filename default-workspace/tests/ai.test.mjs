/* AI 层测试：JSON 修复、结果归一化、错误映射与重试（用假 fetch，不联网）。 */
import { test } from './harness.mjs';
import { extractJson, normalizeResult, callDeepSeek, buildMessages } from '../js/ai.js';

function jsonResponse(body, status) {
  return Promise.resolve({
    ok: (status || 200) < 400,
    status: status || 200,
    text: function () { return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)); }
  });
}

function chatPayload(content) {
  return { model: 'deepseek-chat', choices: [{ message: { content: content } }], usage: {} };
}

const TAXONOMY = {
  subjects: [
    { id: 'sub_1', name: '408 计算机学科专业基础综合', keywords: '[]' },
    { id: 'sub_2', name: '政治', keywords: '[]' }
  ],
  chapters: [
    { id: 'chp_1', subject_id: 'sub_1', parent_id: null, name: '数据结构', path: '数据结构' },
    { id: 'chp_2', subject_id: 'sub_1', parent_id: 'chp_1', name: '树与二叉树', path: '数据结构 / 树与二叉树' },
    { id: 'chp_3', subject_id: 'sub_2', parent_id: null, name: '马克思主义基本原理', path: '马克思主义基本原理' }
  ],
  types: [{ id: 'typ_1', subject_id: null, name: '知识点笔记', keywords: '[]' }],
  tags: [{ id: 'tag_1', name: '重点' }]
};

test('1. 从模型输出中稳健提取 JSON', async function (t) {
  const fenced = extractJson('下面是结果：\n' + String.fromCharCode(96, 96, 96) + 'json\n{"a": 1, "b": [2]}\n' + String.fromCharCode(96, 96, 96));
  t.eq(fenced.value.a, 1, '能从 markdown 代码块中提取');
  t.check('给出了修复提示', fenced.warnings.length >= 1);

  const trailing = extractJson('{"a": 1, "b": 2,}');
  t.eq(trailing.value.b, 2, '能修复尾随逗号');

  const wrapped = extractJson('随便说点什么 {"title": "X"} 后面还有废话');
  t.eq(wrapped.value.title, 'X', '能从前后缀文本中提取对象');

  const smart = extractJson('{\u201ca\u201d: 1}');
  t.eq(smart.value.a, 1, '能修复中文引号');

  const error = await t.throws(function () { return extractJson('完全不是 JSON'); }, '无法解析时抛错');
  t.check('错误信息可读', /无法从模型输出中解析/.test(error.message), error.message);
});

test('2. 归一化：把模型输出映射回真实分类 id', async function (t) {
  const normalized = normalizeResult({
    title: '二叉树笔记', summary: '摘要', organized_body: '正文',
    subject: { id: null, name: '408 计算机学科专业基础综合' },
    chapter: { id: null, name: '树与二叉树' },
    material_type: { id: null, name: '知识点笔记' },
    tags: ['重点', '自造标签'],
    importance: 4, confidence: 0.9, reason: '因为包含二叉树', warnings: []
  }, TAXONOMY);
  t.eq(normalized.subject.id, 'sub_1', '按名称匹配到科目 id');
  t.eq(normalized.chapter.id, 'chp_2', '按名称匹配到章节 id');
  t.eq(normalized.material_type.id, 'typ_1', '按名称匹配到类型 id');
  t.eq(normalized.importance, 4, '重要程度保留');
  t.check('未知标签进入 suggested_new', normalized.suggested_new['tag:自造标签'] === '自造标签',
    JSON.stringify(normalized.suggested_new));
});

test('3. 归一化：分类体系中不存在时不强行归类', async function (t) {
  const normalized = normalizeResult({
    subject: { id: null, name: '从未存在过的科目' },
    chapter: { id: null, name: '从未存在过的章节' },
    material_type: { id: null, name: '从未存在过的类型' },
    suggested_new: { subject: '从未存在过的科目' },
    importance: 2, confidence: 0.2
  }, TAXONOMY);
  t.eq(normalized.subject, null, '科目保持为空');
  t.eq(normalized.chapter, null, '章节保持为空');
  t.eq(normalized.material_type, null, '类型保持为空');
  t.eq(normalized.suggested_new.subject, '从未存在过的科目', '建议新增被记录');
  t.check('给出告警', normalized.warnings.some(function (w) { return w.indexOf('未能匹配到已有科目') >= 0; }),
    JSON.stringify(normalized.warnings));
});

test('4. 提示词注入的是用户自己的分类体系', async function (t) {
  const messages = buildMessages({ title: 'T', body: 'B', taxonomy: TAXONOMY, maxInputChars: 100 });
  const text = messages.map(function (m) { return m.content; }).join('\n');
  t.check('包含科目 id 与名称', text.indexOf('sub_1') >= 0 && text.indexOf('408 计算机学科专业基础综合') >= 0);
  t.check('包含章节路径', text.indexOf('chp_2') >= 0 && text.indexOf('数据结构 / 树与二叉树') >= 0);
  t.check('包含材料类型', text.indexOf('typ_1') >= 0);
  t.check('包含可用标签', text.indexOf('重点') >= 0);
  t.check('要求只输出 JSON', text.indexOf('只输出一个 JSON 对象') >= 0);
});

test('5. 网络与错误映射', async function (t) {
  const base = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], maxRetries: 0, timeoutMs: 2000 };

  const noKey = await t.throws(function () {
    return callDeepSeek(Object.assign({}, base, { apiKey: '', fetchImpl: function () { throw new Error('不应被调用'); } }));
  }, '未配置 Key 时立即失败');
  t.eq(noKey.code, 'no_api_key', '错误码为 no_api_key');
  t.eq(noKey.retryable, false, '此类错误不重试');

  const ok = await callDeepSeek(Object.assign({}, base, {
    apiKey: 'sk-x', fetchImpl: function () { return jsonResponse(chatPayload('{"ok":true}')); }
  }));
  t.eq(ok.text, '{"ok":true}', '成功时返回文本');
  t.eq(ok.attempts, 1, '成功时只尝试一次');

  const auth = await t.throws(function () {
    return callDeepSeek(Object.assign({}, base, {
      apiKey: 'sk-x', fetchImpl: function () { return jsonResponse('Authentication Fails', 401); }
    }));
  }, '401 抛出异常');
  t.eq(auth.code, 'auth', '401 映射为 auth');
  t.eq(auth.retryable, false, '401 不重试');

  const quota = await t.throws(function () {
    return callDeepSeek(Object.assign({}, base, {
      apiKey: 'sk-x', fetchImpl: function () { return jsonResponse('insufficient balance', 402); }
    }));
  }, '402 抛出异常');
  t.eq(quota.code, 'quota', '402 映射为 quota');

  let calls = 0;
  const limited = await t.throws(function () {
    return callDeepSeek(Object.assign({}, base, {
      maxRetries: 2, apiKey: 'sk-x',
      fetchImpl: function () { calls += 1; return jsonResponse('rate limited', 429); }
    }));
  }, '429 重试后仍失败');
  t.eq(limited.code, 'rate_limit', '429 映射为 rate_limit');
  t.eq(limited.retryable, true, '429 可重试');
  t.eq(calls, 3, '重试 2 次共请求 3 次');

  const network = await t.throws(function () {
    return callDeepSeek(Object.assign({}, base, {
      apiKey: 'sk-x', fetchImpl: function () { return Promise.reject(new TypeError('Failed to fetch')); }
    }));
  }, '网络异常抛出');
  t.eq(network.code, 'network', 'TypeError 映射为 network');
  t.check(/无法连接 DeepSeek/.test(network.message), network.message);

  const badBody = await t.throws(function () {
    return callDeepSeek(Object.assign({}, base, {
      apiKey: 'sk-x', fetchImpl: function () { return jsonResponse('not json', 200); }
    }));
  }, '响应不是 JSON 时抛出');
  t.eq(badBody.code, 'bad_response', '非法响应映射为 bad_response');

  const emptyChoices = await t.throws(function () {
    return callDeepSeek(Object.assign({}, base, {
      apiKey: 'sk-x', fetchImpl: function () { return jsonResponse({ model: 'x', choices: [] }); }
    }));
  }, '没有 choices 时抛出');
  t.eq(emptyChoices.code, 'bad_response', '缺少内容映射为 bad_response');
});

test('6. 超时会被中止并映射为 timeout', async function (t) {
  const hanging = function (url, options) {
    return new Promise(function (resolve, reject) {
      options.signal.addEventListener('abort', function () {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  const error = await t.throws(function () {
    return callDeepSeek({
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'x' }], maxRetries: 0, timeoutMs: 60, fetchImpl: hanging
    });
  }, '超时抛出异常');
  t.eq(error.code, 'timeout', 'AbortError 映射为 timeout');
  t.eq(error.retryable, true, '超时可重试');
});

test('7. 请求体符合 DeepSeek 规范', async function (t) {
  let captured = null;
  await callDeepSeek({
    baseUrl: 'https://api.deepseek.com/', apiKey: 'sk-secret', model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'x' }], temperature: 0.3, maxTokens: 128,
    maxRetries: 0, timeoutMs: 2000,
    fetchImpl: function (url, options) {
      captured = { url: url, options: options };
      return jsonResponse(chatPayload('{}'));
    }
  });
  t.eq(captured.url, 'https://api.deepseek.com/chat/completions', '接口地址正确');
  const body = JSON.parse(captured.options.body);
  t.eq(body.model, 'deepseek-chat', '模型正确');
  t.eq(body.response_format.type, 'json_object', '要求 JSON 输出');
  t.eq(body.temperature, 0.3, '温度透传');
  t.eq(body.max_tokens, 128, 'max_tokens 透传');
  t.eq(captured.options.headers.Authorization, 'Bearer sk-secret', '带 Bearer 鉴权');
});
