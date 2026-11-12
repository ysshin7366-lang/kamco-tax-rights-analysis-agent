// 한글 양식(.hwpx)의 빈칸에 글을 채워 넣는 도구 (서버 전용)
// 양식 폴더(양식/*.hwpx)의 표를 그대로 두고, 칸 주소(줄·칸 번호)로 찾아 글만 바꾼다.
// 줄이 모자라면 같은 모양의 줄을 복사해 늘리고, 남는 줄은 뺀다. (scripts/양식채우기.mjs와 같은 방식)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const FORM_DIR = join(/* turbopackIgnore: true */ process.cwd(), "양식");

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let uid = 9000;
const nextId = () => String(++uid);

export type Form = {
  name: string;
  files: Record<string, Uint8Array>;
  section: string;
  tbl: string;
  head: string;
  rows: string[];
  alignId: Record<string, string>;
  /** 글자 크기가 너무 작은(6pt 미만) 칸에 쓰면 글이 거의 안 보이므로, 그럴 때 대신 쓸 글자 모양 번호 */
  fallbackChar: string;
  /** 글자 모양 번호 → 크기(1/100pt) */
  charHeight: Record<string, number>;
};

export type Align = "LEFT" | "RIGHT" | "CENTER";
/** 칸에 넣을 글: 글자(여러 줄이면 배열) 또는 [글, 정렬] */
export type CellValue = string | string[] | [string | string[], Align];

/** 양식 열기: 표를 줄(tr) 단위로 쪼갠다. 파일 이름은 양식 폴더 안의 이름(확장자 제외) */
export function openForm(name: string): Form {
  const files = unzipSync(new Uint8Array(readFileSync(join(FORM_DIR, `${name}.hwpx`))));
  const section = strFromU8(files["Contents/section0.xml"]);
  const header = strFromU8(files["Contents/header.xml"]);
  const tbl = /<hp:tbl [\s\S]*<\/hp:tbl>/.exec(section)?.[0];
  const rows = tbl?.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g);
  if (!tbl || !rows) throw new Error(`양식(${name})에서 표를 찾지 못했습니다.`);
  const head = tbl.slice(0, tbl.indexOf("<hp:tr>"));
  const alignId: Record<string, string> = {};
  for (const m of header.matchAll(/<hh:paraPr id="(\d+)"[\s\S]*?<hh:align horizontal="(\w+)"/g)) alignId[m[2]] ??= m[1];
  const charHeight: Record<string, number> = {};
  for (const m of header.matchAll(/<hh:charPr id="(\d+)" height="(\d+)"/g)) charHeight[m[1]] = Number(m[2]);
  // 대신 쓸 글자 모양: 8~10pt 중 표에서 가장 많이 쓰이는 것
  const used = new Map<string, number>();
  for (const m of section.matchAll(/<hp:run charPrIDRef="(\d+)"/g)) {
    const h = charHeight[m[1]];
    if (h >= 800 && h <= 1000) used.set(m[1], (used.get(m[1]) ?? 0) + 1);
  }
  const fallbackChar = [...used.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? Object.keys(charHeight).find((id) => charHeight[id] === 900) ?? "0";
  return { name, files, section, tbl, head, rows, alignId, fallbackChar, charHeight };
}

const isAligned = (v: CellValue): v is [string | string[], Align] =>
  Array.isArray(v) && v.length === 2 && typeof v[1] === "string" && /^(LEFT|RIGHT|CENTER)$/.test(v[1]) && (typeof v[0] === "string" || Array.isArray(v[0]));

function setCell(form: Form, tr: string, col: number, value: CellValue): string {
  const [text, align] = isAligned(value) ? value : [value, undefined];
  const lines = Array.isArray(text) ? text : [text ?? ""];
  let found = false;
  const out = tr.replace(/<hp:tc [\s\S]*?<\/hp:tc>/g, (tc) => {
    if (!tc.includes(`<hp:cellAddr colAddr="${col}" `)) return tc;
    found = true;
    return tc.replace(/(<hp:subList [^>]*>)([\s\S]*?)(<\/hp:subList>)/, (_m, open: string, paras: string, close: string) => {
      const p0 = /<hp:p [^>]*>/.exec(paras)?.[0] ?? "";
      let charPr = /<hp:run charPrIDRef="(\d+)"/.exec(paras)?.[1] ?? "0";
      // 빈칸이던 칸의 글자 모양이 1pt처럼 너무 작으면 글이 점으로 보이므로 보통 크기로 바꾼다
      if ((form.charHeight[charPr] ?? 1000) < 600) charPr = form.fallbackChar;
      let pPr = /paraPrIDRef="(\d+)"/.exec(p0)?.[1] ?? "0";
      if (align) {
        if (!form.alignId[align]) throw new Error(`양식에 ${align} 정렬 문단 모양이 없습니다`);
        pPr = form.alignId[align];
      }
      const body = lines
        .map((t) => `<hp:p id="${nextId()}" paraPrIDRef="${pPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}"><hp:t>${esc(String(t))}</hp:t></hp:run></hp:p>`)
        .join("");
      return `${open}${body}${close}`;
    });
  });
  if (!found) throw new Error(`${form.name}: 칸 ${col}을(를) 찾지 못했습니다`);
  return out;
}

/** 한 줄의 여러 칸을 한꺼번에 채운다: spec = { 칸번호: 글 } */
export function fillRow(form: Form, tr: string, spec: Record<number, CellValue>): string {
  let out = tr;
  for (const [col, v] of Object.entries(spec)) out = setCell(form, out, Number(col), v);
  return out;
}

/** 줄 높이 바꾸기 (칸 합치기가 없는 칸만) */
export function setRowHeight(tr: string, h: number): string {
  return tr.replace(/<hp:tc [\s\S]*?<\/hp:tc>/g, (tc) => {
    if (!/rowSpan="1"/.test(tc)) return tc;
    return tc.replace(/(<hp:cellSz width="\d+" height=")\d+(")/, `$1${h}$2`);
  });
}

/** 줄 번호를 처음부터 다시 매기고 표 크기를 고쳐 .hwpx 파일 내용을 만든다 */
export function finishForm(form: Form, rows: string[], title: string): Uint8Array {
  const renum = rows.map((tr, i) => tr.replace(/rowAddr="\d+"/g, `rowAddr="${i}"`));
  let height = 0;
  for (const tr of renum) {
    let h = 0;
    for (const tc of tr.match(/<hp:tc [\s\S]*?<\/hp:tc>/g) ?? []) {
      const rs = Number(/rowSpan="(\d+)"/.exec(tc)?.[1] ?? 1);
      h = Math.max(h, Number(/<hp:cellSz width="\d+" height="(\d+)"/.exec(tc)?.[1] ?? 0) / rs);
    }
    height += h;
  }
  const head = form.head
    .replace(/rowCnt="\d+"/, `rowCnt="${renum.length}"`)
    .replace(/(<hp:sz width="\d+" widthRelTo="ABSOLUTE" height=")\d+(")/, `$1${Math.round(height)}$2`);
  const section = form.section.replace(form.tbl, () => `${head}${renum.join("")}</hp:tbl>`);
  const hpf = strFromU8(form.files["Contents/content.hpf"]).replace(/<opf:title>[\s\S]*?<\/opf:title>/, `<opf:title>${esc(title)}</opf:title>`);
  const out: Zippable = {};
  for (const [name, data] of Object.entries(form.files)) {
    if (name === "mimetype") out[name] = [data, { level: 0 }];
    else if (name === "Contents/section0.xml") out[name] = strToU8(section);
    else if (name === "Contents/content.hpf") out[name] = strToU8(hpf);
    else out[name] = data;
  }
  return zipSync(out);
}
