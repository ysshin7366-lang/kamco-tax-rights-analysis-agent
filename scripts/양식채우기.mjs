// 한글 양식(.hwpx)의 빈칸에 글을 채워 넣는 도구 (배분계산서·배분계산내역표용)
// 양식 파일(scripts/hwpx-form/*.hwpx)의 표를 그대로 두고, 칸 주소(줄·칸 번호)로 찾아 글만 바꾼다.
// 줄이 모자라면 같은 모양의 줄을 복사해 늘리고, 남는 줄은 뺀다.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORM_DIR = join(ROOT, "scripts", "hwpx-form");
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let uid = 5000;
const nextId = () => String(++uid);

/** 양식 열기: 표를 줄(tr) 단위로 쪼갠다 */
export function openForm(name) {
  const files = unzipSync(new Uint8Array(readFileSync(join(FORM_DIR, `${name}.hwpx`))));
  const section = strFromU8(files["Contents/section0.xml"]);
  const header = strFromU8(files["Contents/header.xml"]);
  const tbl = /<hp:tbl [\s\S]*<\/hp:tbl>/.exec(section)[0];
  const firstTr = tbl.indexOf("<hp:tr>");
  const head = tbl.slice(0, firstTr);
  const rows = tbl.match(/<hp:tr>[\s\S]*?<\/hp:tr>/g);
  // 문단 정렬 번호 찾기 (머리 정보에서 정렬별 번호)
  const alignId = {};
  for (const m of header.matchAll(/<hh:paraPr id="(\d+)"[\s\S]*?<hh:align horizontal="(\w+)"/g)) alignId[m[2]] ??= m[1];
  return { files, section, tbl, head, rows, alignId, name };
}

const tcsOf = (tr) => tr.match(/<hp:tc [\s\S]*?<\/hp:tc>/g);

/** 한 칸의 글 바꾸기. lines: 글(여러 줄이면 배열), align: LEFT|RIGHT|CENTER */
function setCell(form, tr, col, lines, align) {
  const arr = Array.isArray(lines) ? lines : [lines ?? ""];
  let found = false;
  const out = tr.replace(/<hp:tc [\s\S]*?<\/hp:tc>/g, (tc) => {
    if (!tc.includes(`<hp:cellAddr colAddr="${col}" `)) return tc;
    found = true;
    return tc.replace(/(<hp:subList [^>]*>)([\s\S]*?)(<\/hp:subList>)/, (_, open, paras, close) => {
      const p0 = /<hp:p [^>]*>/.exec(paras)[0];
      const charPr = /<hp:run charPrIDRef="(\d+)"/.exec(paras)[1];
      let pPr = /paraPrIDRef="(\d+)"/.exec(p0)[1];
      if (align) {
        if (!form.alignId[align]) throw new Error(`양식에 ${align} 정렬 문단 모양이 없습니다`);
        pPr = form.alignId[align];
      }
      const body = arr
        .map((t) => `<hp:p id="${nextId()}" paraPrIDRef="${pPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}"><hp:t>${esc(t)}</hp:t></hp:run></hp:p>`)
        .join("");
      return `${open}${body}${close}`;
    });
  });
  if (!found) throw new Error(`${form.name}: 칸 ${col}을(를) 찾지 못했습니다`);
  return out;
}

/** 여러 칸을 한꺼번에: spec = { 칸번호: 글 | [글, 정렬] } */
export function fillRow(form, tr, spec) {
  let out = tr;
  for (const [col, v] of Object.entries(spec)) {
    const [text, align] = Array.isArray(v) && v.length === 2 && typeof v[1] === "string" && /^(LEFT|RIGHT|CENTER)$/.test(v[1]) ? v : [v, undefined];
    out = setCell(form, out, Number(col), text, align);
  }
  return out;
}

/** 줄 높이 바꾸기 (그 줄에서 합치지 않은 칸만) */
export function setRowHeight(tr, h) {
  return tr.replace(/<hp:tc [\s\S]*?<\/hp:tc>/g, (tc) => {
    if (!/rowSpan="1"/.test(tc)) return tc;
    return tc.replace(/(<hp:cellSz width="\d+" height=")\d+(")/, `$1${h}$2`);
  });
}

/** 줄 번호를 처음부터 다시 매기고 표 크기를 고쳐서 section0.xml과 꾸러미를 만든다 */
export function finishForm(form, rows, title) {
  const renum = rows.map((tr, i) => tr.replace(/rowAddr="\d+"/g, `rowAddr="${i}"`));
  let height = 0;
  for (const tr of renum) {
    let h = 0;
    for (const tc of tcsOf(tr)) {
      const rs = Number(/rowSpan="(\d+)"/.exec(tc)[1]);
      h = Math.max(h, Number(/<hp:cellSz width="\d+" height="(\d+)"/.exec(tc)[1]) / rs);
    }
    height += h;
  }
  const head = form.head.replace(/rowCnt="\d+"/, `rowCnt="${renum.length}"`).replace(/(<hp:sz width="\d+" widthRelTo="ABSOLUTE" height=")\d+(")/, `$1${Math.round(height)}$2`);
  const newTbl = `${head}${renum.join("")}</hp:tbl>`;
  const section = form.section.replace(form.tbl, () => newTbl);
  const hpf = strFromU8(form.files["Contents/content.hpf"]).replace(/<opf:title>[\s\S]*?<\/opf:title>/, `<opf:title>${esc(title)}</opf:title>`);
  const out = {};
  for (const [name, data] of Object.entries(form.files)) {
    if (name === "mimetype") out[name] = [data, { level: 0 }];
    else if (name === "Contents/section0.xml") out[name] = strToU8(section);
    else if (name === "Contents/content.hpf") out[name] = strToU8(hpf);
    else out[name] = data;
  }
  return { bytes: zipSync(out), height: Math.round(height) };
}
