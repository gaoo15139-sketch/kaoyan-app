/* 真机式端到端测试：用无头 Chrome 通过 CDP 真实操作界面。
 * 覆盖：导入 -> AI 整理 -> 审核 -> 归档 -> 检索 的完整链路，并逐页截图。
 *
 * 用法： node tests/e2e.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8099/';
const PORT = 9334;
const PROFILE = path.join(ROOT, '.test-tmp', 'chrome-profile');

const passed = [];
const failed = [];
function check(name, condition, detail) {
  if (condition) { passed.push(name); console.log('  [PASS] ' + name); }
  else { failed.push(name + (detail ? ' -> ' + detail : '')); console.log('  [FAIL] ' + name + (detail ? ' -> ' + detail : '')); }
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function waitForDevTools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await response.json();
      const page = list.find(function (item) { return item.type === 'page'; });
      if (page) return page;
    } catch (error) { /* 等待启动 */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function main() {
  // 每次运行都从干净的用户资料开始，否则上一轮写入的 IndexedDB 会让断言失效
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=390,844',
    'about:blank'
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  const pageErrors = [];
  let ws = null;

  try {
    const target = await waitForDevTools();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(function (resolve, reject) {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    let nextId = 0;
    const pending = new Map();
    ws.addEventListener('message', function (event) {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const handler = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(message.error.message));
        else handler.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push((message.params.args || []).map(function (a) { return a.value || a.description || ''; }).join(' '));
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails || {};
        pageErrors.push((details.exception && details.exception.description) || details.text || '未知异常');
      }
    });

    function send(method, params) {
      nextId += 1;
      const id = nextId;
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    }

    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression: expression, returnByValue: true, awaitPromise: true
      });
      if (result.exceptionDetails) {
        throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description)
          || result.exceptionDetails.text);
      }
      return result.result.value;
    }

    async function waitUntil(expression, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 15000);
      while (Date.now() < deadline) {
        try { if (await evaluate(expression)) return true; } catch (error) { /* 继续等 */ }
        await sleep(200);
      }
      return false;
    }

    async function shoot(name) {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(ROOT, 'shots', name + '.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    }

    function clickByText(text) {
      return evaluate('(function () {'
        + ' const buttons = Array.prototype.slice.call(document.querySelectorAll("button"));'
        + ' const target = buttons.filter(function (b) { return b.textContent.indexOf(' + JSON.stringify(text) + ') >= 0; })[0];'
        + ' if (!target) return false;'
        + ' target.click(); return true; })()');
    }

    const viewText = function () { return evaluate("document.getElementById('view').innerText"); };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');

    console.log('== 1. 首次加载 ==');
    await send('Page.navigate', { url: BASE });
    check('应用完成启动', await waitUntil(
      "document.readyState === 'complete' && !document.querySelector('.boot-screen')", 25000));
    check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.join(' | '));
    check('没有 console.error', consoleErrors.length === 0, consoleErrors.join(' | '));
    // 视觉测试必须关掉动画，否则截图可能落在入场动画的中间帧
    await evaluate("(function () {"
      + " const style = document.createElement('style');"
      + " style.textContent = '*,*::before,*::after{animation-duration:0.001ms !important;animation-delay:0ms !important;transition-duration:0.001ms !important;}';"
      + " document.head.appendChild(style);"
      + " return true; })()");

    check('底部导航有 5 个入口', await evaluate("document.querySelectorAll('.tab-btn').length") === 5);
    check('默认有 4 个科目可选',
      await evaluate("document.querySelectorAll('#view select')[0].options.length") === 5);

    console.log('== 2. 通过界面导入材料 ==');
    await evaluate('(function () {'
      + ' const view = document.getElementById("view");'
      + ' const texts = view.querySelectorAll("input[type=text]");'
      + ' texts[0].value = "E2E 二叉树遍历笔记";'
      + ' texts[1].value = "端到端测试来源";'
      + ' view.querySelector("textarea").value = "数据结构 二叉树\\n- 前序、中序、后序遍历\\n- 重点：线索二叉树";'
      + ' return true; })()');
    check('已填入表单', await evaluate("document.getElementById('view').querySelector('textarea').value.length") > 10);
    await shoot('01-import-filled');

    check('点击「保存并让 AI 整理」', await clickByText('保存并让 AI 整理'));
    check('材料计数变为 1', await waitUntil(
      "document.querySelector('#header-status .chip').textContent.indexOf('材料 1') >= 0", 20000),
      await evaluate("document.querySelector('#header-status .chip').textContent"));

    console.log('== 3. 材料库检索 ==');
    await evaluate("document.querySelectorAll('.tab-btn')[1].click()");
    await waitUntil("document.getElementById('view').innerText.indexOf('材料库') >= 0", 8000);
    const libraryText = await viewText();
    check('材料库列出刚导入的材料', libraryText.indexOf('E2E 二叉树遍历笔记') >= 0, libraryText.slice(0, 160));
    check('显示 AI 整理状态', libraryText.indexOf('已出建议') >= 0, libraryText.slice(0, 200));
    // 注意：AI 只是"建议"，未审核前分类元数据还没写回材料，因此卡片应显示未分类
    check('未审核前卡片显示未分类', libraryText.indexOf('未分类') >= 0, libraryText.slice(0, 200));
    check('筛选面板默认收起（不挤占列表）', libraryText.indexOf('全部科目') < 0, '下拉选项不应出现在收起状态的 innerText 里');
    check('按关键词检索命中', await evaluate('(async function () {'
      + ' const input = document.getElementById("view").querySelector("input[type=search]");'
      + ' input.value = "线索二叉树";'
      + ' input.dispatchEvent(new Event("input", { bubbles: true }));'
      + ' await new Promise(function (r) { setTimeout(r, 900); });'
      + ' return document.getElementById("view").innerText.indexOf("E2E 二叉树遍历笔记") >= 0; })()'));
    check('检索不相关词为空', await evaluate('(async function () {'
      + ' const input = document.getElementById("view").querySelector("input[type=search]");'
      + ' input.value = "不可能存在的字符串ZZZ";'
      + ' input.dispatchEvent(new Event("input", { bubbles: true }));'
      + ' await new Promise(function (r) { setTimeout(r, 900); });'
      + ' return document.getElementById("view").innerText.indexOf("没有符合条件") >= 0; })()'));
    await shoot('02-library');

    console.log('== 4. 打开材料详情 ==');
    await evaluate('(async function () {'
      + ' const input = document.getElementById("view").querySelector("input[type=search]");'
      + ' input.value = "";'
      + ' input.dispatchEvent(new Event("input", { bubbles: true }));'
      + ' await new Promise(function (r) { setTimeout(r, 900); }); })()');
    await evaluate("document.querySelector('.material-card').click()");
    check('详情弹窗打开', await waitUntil("!!document.querySelector('.modal')", 8000));
    const modalText = await evaluate("document.querySelector('.modal').innerText");
    check('详情含「审核与归档」', modalText.indexOf('审核与归档') >= 0);
    check('详情含 AI 摘要', modalText.indexOf('AI 处理结果') >= 0);
    check('详情含原文版本', modalText.indexOf('用户确认稿') >= 0);
    await shoot('03-detail');

    console.log('== 5. 审核工作台 ==');
    await evaluate("document.querySelector('.modal-header button').click()");
    await sleep(400);
    await evaluate("document.querySelectorAll('.tab-btn')[2].click()");
    await waitUntil("document.getElementById('view').innerText.indexOf('审核工作台') >= 0", 8000);
    const reviewText = await viewText();
    check('审核页列出待审核建议', reviewText.indexOf('待审核') >= 0, reviewText.slice(0, 160));
    check('显示 AI 推荐理由', reviewText.indexOf('推荐') >= 0 || reviewText.indexOf('离线规则引擎') >= 0);
    check('提供接受/拒绝按钮', reviewText.indexOf('接受并归档') >= 0 && reviewText.indexOf('拒绝') >= 0);
    await shoot('04-review');

    check('点击「接受并归档」', await clickByText('接受并归档'));
    await sleep(1800);
    const afterAccept = await viewText();
    check('接受后该建议离开待处理列表',
      afterAccept.indexOf('当前没有待审核的 AI 建议') >= 0 || afterAccept.indexOf('已接受') >= 0,
      afterAccept.slice(0, 160));

    console.log('== 6. 归档结果 ==');
    await evaluate("document.querySelectorAll('.tab-btn')[1].click()");
    await waitUntil("document.getElementById('view').innerText.indexOf('材料库') >= 0", 8000);
    const archivedText = await viewText();
    check('材料状态变为已归档', archivedText.indexOf('已归档') >= 0, archivedText.slice(0, 200));
    check('归档后卡片显示 AI 识别出的科目', archivedText.indexOf('408') >= 0, archivedText.slice(0, 200));
    await shoot('05-library-archived');

    console.log('== 7. 分类管理与设置 ==');
    await evaluate("document.querySelectorAll('.tab-btn')[3].click()");
    await sleep(600);
    const taxonomyText = await viewText();
    check('分类页显示 4 个默认科目', taxonomyText.indexOf('408') >= 0 && taxonomyText.indexOf('数学') >= 0);
    check('分类页显示章节与标签', taxonomyText.indexOf('章节') >= 0 && taxonomyText.indexOf('标签') >= 0);
    await shoot('06-taxonomy');

    await evaluate("document.querySelectorAll('.tab-btn')[4].click()");
    await sleep(900);
    const settingsText = await viewText();
    check('设置页显示离线规则引擎', settingsText.indexOf('离线规则引擎') >= 0);
    check('设置页显示材料总数', settingsText.indexOf('材料总数') >= 0);
    check('设置页提供备份导出', settingsText.indexOf('导出完整备份') >= 0);
    check('设置页提供持久化存储', settingsText.indexOf('申请持久化存储') >= 0);
    await shoot('07-settings');

    console.log('== 8. 离线与安装能力 ==');
    check('manifest 可访问', await evaluate("fetch('./manifest.webmanifest').then(function (r) { return r.ok; })"));
    check('Service Worker 已注册', await evaluate(
      "navigator.serviceWorker.getRegistrations().then(function (r) { return r.length > 0; })"));
    check('处于安全上下文', await evaluate('window.isSecureContext === true'));
    check('IndexedDB 可用', await evaluate("(async function () {"
      + " const d = await new Promise(function (res, rej) { const r = indexedDB.open('probe', 1); r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; });"
      + " return !!d; })()"));

    console.log('== 9. 全程无异常 ==');
    check('最终无页面异常', pageErrors.length === 0, pageErrors.join(' | '));
    check('最终无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    try { if (ws) ws.close(); } catch (error) { /* 忽略 */ }
    chrome.kill();
  }

  console.log('');
  console.log('='.repeat(62));
  console.log('浏览器端到端：通过 ' + passed.length + ' 项，失败 ' + failed.length + ' 项');
  failed.forEach(function (line) { console.log('  - ' + line); });
  console.log('='.repeat(62));
  return failed.length ? 1 : 0;
}

main().then(function (code) { process.exit(code); }).catch(function (error) {
  console.error('E2E 运行失败：' + error.message);
  process.exit(2);
});
