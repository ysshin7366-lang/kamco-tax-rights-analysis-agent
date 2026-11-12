// .hwp(한글 옛 형식) 파일을 읽어 글·표 구조를 꺼내는 도구 (hwpx 변환용)
// 외부 패키지를 설치하지 않고, 파일 구조(CFB)와 한글 기록(record)을 직접 읽는다.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/** CFB(복합 파일) 읽기: 이름 → 내용 */
export function readCfb(buf) {
  if (buf.readUInt32LE(0) !== 0xe011cfd0) throw new Error("한글(.hwp) 파일이 아닙니다.");
  const secSize = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  const firstDir = buf.readInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readInt32LE(60);
  const sector = (i) => buf.subarray((i + 1) * secSize, (i + 2) * secSize);
  // FAT
  const difat = [];
  for (let i = 0; i < 109; i++) { const v = buf.readInt32LE(76 + i * 4); if (v >= 0) difat.push(v); }
  let nextDifat = buf.readInt32LE(68);
  while (nextDifat >= 0) {
    const s = sector(nextDifat);
    for (let i = 0; i < secSize / 4 - 1; i++) { const v = s.readInt32LE(i * 4); if (v >= 0) difat.push(v); }
    nextDifat = s.readInt32LE(secSize - 4);
  }
  const fat = [];
  for (const d of difat) { const s = sector(d); for (let i = 0; i < secSize / 4; i++) fat.push(s.readInt32LE(i * 4)); }
  const chain = (start) => { const out = []; let c = start; while (c >= 0 && out.length < 1e6) { out.push(c); c = fat[c]; } return out; };
  const readChain = (start) => Buffer.concat(chain(start).map(sector));
  const dirBuf = readChain(firstDir);
  const entries = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const nameLen = dirBuf.readUInt16LE(o + 64);
    const name = dirBuf.subarray(o, o + Math.max(0, nameLen - 2)).toString("utf16le");
    entries.push({ name, type: dirBuf[o + 66], start: dirBuf.readInt32LE(o + 116), size: Number(dirBuf.readBigUInt64LE(o + 120)), left: dirBuf.readInt32LE(o + 68), right: dirBuf.readInt32LE(o + 72), child: dirBuf.readInt32LE(o + 76) });
  }
  const root = entries[0];
  const ministream = readChain(root.start);
  const miniFat = []; { const mf = readChain(firstMiniFat); for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readInt32LE(i * 4)); }
  const readMini = (start, size) => {
    const parts = []; let c = start;
    while (c >= 0 && parts.length < 1e6) { parts.push(ministream.subarray(c * miniSize, (c + 1) * miniSize)); c = miniFat[c]; }
    return Buffer.concat(parts).subarray(0, size);
  };
  const read = (e) => (e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start).subarray(0, e.size));
  // 폴더 구조를 따라 경로를 만든다
  const files = {};
  const walk = (idx, prefix) => {
    if (idx < 0 || idx >= entries.length) return;
    const e = entries[idx];
    walk(e.left, prefix);
    if (e.type === 2) files[prefix + e.name] = read(e);
    else if (e.type === 1) walk(e.child, `${prefix}${e.name}/`);
    walk(e.right, prefix);
  };
  walk(root.child, "");
  return files;
}

/** 기록(record) 목록: {tag, level, data} */
export function readRecords(data) {
  const recs = [];
  let p = 0;
  while (p + 4 <= data.length) {
    const h = data.readUInt32LE(p); p += 4;
    const tag = h & 0x3ff, level = (h >> 10) & 0x3ff;
    let size = h >>> 20;
    if (size === 0xfff) { size = data.readUInt32LE(p); p += 4; }
    recs.push({ tag, level, data: data.subarray(p, p + size) });
    p += size;
  }
  return recs;
}

export const TAG = { PARA_HEADER: 0x42, PARA_TEXT: 0x43, PARA_CHAR_SHAPE: 0x44, CTRL_HEADER: 0x47, LIST_HEADER: 0x48, PAGE_DEF: 0x49, TABLE: 0x4d };

/** 문단 글자 읽기: 제어문자는 버리고 글자만 */
export function paraText(d) {
  let s = "";
  for (let i = 0; i + 2 <= d.length; ) {
    const c = d.readUInt16LE(i);
    if (c < 32) {
      if (c === 9) s += " ";
      else if (c === 10) s += "\n"; // 줄바꿈
      // 확장·인라인 제어(1~9, 11~12, 14~23)는 글자 하나가 아니라 16바이트를 차지한다
      if ((c >= 1 && c <= 9) || (c >= 11 && c <= 12) || (c >= 14 && c <= 23)) i += 16; else i += 2;
    } else { s += c === 0xfffe || c === 0xffff ? "" : String.fromCharCode(c); i += 2; }
  }
  return s;
}

/** .hwp 파일을 {문단, 표} 순서 목록으로 바꾼다 */
export function parseHwp(path) {
  const buf = readFileSync(path);
  const files = readCfb(buf);
  const header = files["FileHeader"];
  const flags = header.readUInt32LE(36);
  const compressed = (flags & 1) !== 0;
  const encrypted = (flags & 2) !== 0;
  if (encrypted) throw new Error("암호가 걸린 파일은 변환할 수 없습니다.");
  const sections = Object.keys(files).filter((n) => /^BodyText\/Section\d+$/.test(n)).sort();
  const unpack = (d) => (compressed ? inflateRawSync(d) : d);
  const bins = {};
  for (const [n, d] of Object.entries(files)) {
    if (!n.startsWith("BinData/")) continue;
    try { bins[n.slice(8)] = unpack(d); } catch { bins[n.slice(8)] = d; }
  }
  const out = {
    sections: [], flags, version: header.readUInt32LE(32), preview: files["PrvText"]?.toString("utf16le") ?? "",
    docInfo: readRecords(unpack(files["DocInfo"])), bins,
  };
  for (const name of sections) {
    let d = files[name];
    if (compressed) d = inflateRawSync(d);
    const recs = readRecords(d);
    out.sections.push({ name, recs });
  }
  return out;
}
