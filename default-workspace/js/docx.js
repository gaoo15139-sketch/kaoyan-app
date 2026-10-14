/* 从 .docx 提取纯文本：自己解析 ZIP 容器，用浏览器内置的 DecompressionStream 解压。
 * 不依赖任何第三方库。.docx 本质上就是一个装着 XML 的 zip。
 */

function findEndOfCentralDirectory(view) {
  for (let offset = view.byteLength - 22; offset >= 0 && offset >= view.byteLength - 66000; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('该文件不是有效的 zip / docx');
}

function readEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  const eocd = findEndOfCentralDirectory(view);
  const total = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < total; i += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      name: name,
      method: method,
      compressed: bytes.subarray(dataStart, dataStart + compressedSize)
    });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(bytes) {
  if (bytes.length === 0) return new Uint8Array(0);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 .docx，请改用 .txt 文件或直接粘贴文本');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (match, code) { return String.fromCharCode(Number(code)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (match, code) { return String.fromCharCode(parseInt(code, 16)); })
    .replace(/&amp;/g, '&');
}

export function documentXmlToText(xml) {
  let text = String(xml);
  text = text.replace(/<w:tab\s*\/>/g, '\t');
  text = text.replace(/<w:br\s*\/>/g, '\n');
  text = text.replace(/<w:cr\s*\/>/g, '\n');
  text = text.replace(/<\/w:p>/g, '\n');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function extractDocx(buffer) {
  const entries = readEntries(buffer);
  const entry = entries.find(function (item) { return item.name === 'word/document.xml'; });
  if (!entry) throw new Error('该 .docx 文件缺少 word/document.xml，可能不是有效的 Word 文档');
  const raw = entry.method === 0 ? entry.compressed : await inflateRaw(entry.compressed);
  const xml = new TextDecoder('utf-8').decode(raw);
  const text = documentXmlToText(xml);
  if (!text.trim()) throw new Error('该 .docx 文件没有可提取的文字');
  return text;
}

export const DOCX_EXTENSIONS = ['.docx'];
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.tex'];
