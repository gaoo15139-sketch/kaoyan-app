/* .docx 提取测试：在内存里现造一个最小 docx（zip + deflateRaw），再解析回来。 */
import { test } from './harness.mjs';
import zlib from 'node:zlib';
import { extractDocx, documentXmlToText } from '../js/docx.js';

function utf8(text) { return new TextEncoder().encode(text); }

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  entries.forEach(function (entry) {
    const nameBytes = utf8(entry.name);
    const data = utf8(entry.content);
    const compressed = entry.store ? data : new Uint8Array(zlib.deflateRawSync(data));
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const method = entry.store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, Buffer.from(nameBytes), Buffer.from(compressed));

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, Buffer.from(nameBytes)]));

    offset += local.length + nameBytes.length + compressed.length;
  });

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const all = Buffer.concat(chunks.concat([centralBuffer, eocd]));
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const DOCUMENT_XML = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + '<w:p><w:r><w:t>数据结构 树与二叉树</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>重点：线索二叉树 &amp; 遍历</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>第一行</w:t></w:r><w:r><w:br/><w:t>第二行</w:t></w:r></w:p>'
  + '</w:body></w:document>';

test('1. 纯函数：XML 转文本', async function (t) {
  const text = documentXmlToText(DOCUMENT_XML);
  t.check('保留段落文字', text.indexOf('数据结构 树与二叉树') >= 0, text);
  t.check('解码 HTML 实体', text.indexOf('重点：线索二叉树 & 遍历') >= 0, text);
  t.check('段落之间换行', text.split('\n').length >= 3, JSON.stringify(text));
  t.check('br 转成换行', text.indexOf('第一行\n第二行') >= 0, JSON.stringify(text));
});

test('2. 解析真实 zip 容器（deflate 压缩）', async function (t) {
  const buffer = buildZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'word/document.xml', content: DOCUMENT_XML }
  ]);
  const text = await extractDocx(buffer);
  t.check('从压缩条目中提取到文字', text.indexOf('数据结构 树与二叉树') >= 0, text);
  t.check('从内容类型条目之外只取 document.xml', text.indexOf('Types') < 0);
});

test('3. 解析未压缩条目（stored）', async function (t) {
  const buffer = buildZip([{ name: 'word/document.xml', content: DOCUMENT_XML, store: true }]);
  const text = await extractDocx(buffer);
  t.check('stored 方式也能解析', text.indexOf('线索二叉树') >= 0, text);
});

test('4. 异常处理', async function (t) {
  const bad = await t.throws(function () { return extractDocx(new ArrayBuffer(64)); }, '非 zip 文件抛错');
  t.check('错误信息可读', /不是有效的 zip/.test(bad.message), bad.message);

  const missing = buildZip([{ name: 'word/styles.xml', content: '<x/>' }]);
  const noDoc = await t.throws(function () { return extractDocx(missing); }, '缺少 document.xml 抛错');
  t.check('提示缺少 document.xml', /缺少 word\/document.xml/.test(noDoc.message), noDoc.message);

  const empty = buildZip([{ name: 'word/document.xml', content: '<w:document/>' }]);
  const noText = await t.throws(function () { return extractDocx(empty); }, '没有文字时抛错');
  t.check('提示没有可提取文字', /没有可提取的文字/.test(noText.message), noText.message);
});
