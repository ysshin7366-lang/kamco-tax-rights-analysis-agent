// 자료 안에 사건번호(사례번호)가 여러 개 들어 있으면 사건별로 나눈다.
// - PDF: 쪽마다 "사건번호 001" 같은 표시를 찾아 그 쪽을 해당 사건에 넣는다. (표시가 없는 쪽은 앞 사건에 이어 붙인다)
// - 텍스트·한글(.txt/.hwpx): "사건번호 …" 표시가 나오는 자리에서 잘라 나눈다.
// - 엑셀: 머리글에 사건번호(사례번호) 칸이 있으면 첫 칸 값이 같은 줄끼리 묶고, 머리글은 모든 사건에 붙인다.
// 사건번호가 2개 미만이면 나누지 않고(null) 기존처럼 한 건으로 분석한다. AI를 부르지 않는 고정 규칙이다.

import { ExtractError, type ExtractedDocument } from "@/lib/server/extractText";

export const MAX_CASES = 15;

export type CaseBundle = { key: string; label: string; owner: string; documents: ExtractedDocument[] };

/** 글에서 "소유자 홍길동" 같은 표시를 찾아 소유자 이름을 돌려준다 (없으면 빈 글자) */
const ownerOf = (text: string): string => /소유자\s*[:：]?\s*([^\s|]{2,10})/.exec(text.replace(/\s+/g, " "))?.[1] ?? "";

const KEY_RE = /(?:사건\s*번호|사례\s*번호)\s*[:：]?\s*([0-9A-Za-z][0-9A-Za-z-]*)/;
const KEY_RE_G = new RegExp(KEY_RE.source, "g");
const HEADER_KEY_RE = /(?:사건|사례)\s*번호|^번호$|^no\.?$/i;
const ROW_KEY_RE = /^[0-9A-Za-z][0-9A-Za-z-]{0,11}$/;

/** 001 과 1 을 같은 번호로 보기 위한 비교용 값 */
const norm = (key: string) => key.toLowerCase().replace(/^0+(?=\d)/, "");

type Piece = { key: string; text: string };

/** 글 전체에서 사건번호 표시 자리를 찾아 조각으로 나눈다 (PDF 쪽 표시 "[p.N]"은 그대로 유지) */
function splitPlain(text: string): { preamble: string; pieces: Piece[] } {
  const hits = [...text.matchAll(KEY_RE_G)];
  if (hits.length === 0) return { preamble: text, pieces: [] };
  const pieces: Piece[] = [];
  hits.forEach((hit, i) => {
    const start = hit.index ?? 0;
    const end = i + 1 < hits.length ? (hits[i + 1].index ?? text.length) : text.length;
    pieces.push({ key: hit[1], text: text.slice(start, end) });
  });
  return { preamble: text.slice(0, hits[0].index ?? 0), pieces };
}

/** PDF: 쪽 단위로 나눈다. 사건번호가 없는 쪽은 바로 앞 사건에 붙이고, 첫 사건 이전 쪽은 공통(preamble)으로 둔다 */
function splitPdf(text: string): { preamble: string; pieces: Piece[]; pageCount: Map<string, number> } {
  const blocks = text.split(/(?=\[p\.\d+\]\n)/).filter((b) => b.trim() !== "");
  const pieces: Piece[] = [];
  const pageCount = new Map<string, number>();
  let preamble = "";
  for (const block of blocks) {
    const key = KEY_RE.exec(block)?.[1];
    if (key) {
      pieces.push({ key, text: block });
    } else if (pieces.length > 0) {
      pieces[pieces.length - 1].text += `\n\n${block}`;
    } else {
      preamble += `${block}\n\n`;
    }
  }
  for (const p of pieces) pageCount.set(p.key, (p.text.match(/\[p\.\d+\]/g) ?? []).length);
  return { preamble: preamble.trim(), pieces, pageCount };
}

type SheetPart = { header: string[]; rows: Map<string, string[]> };

/** 엑셀 글(readXlsx 결과)에서 사건 줄을 묶는다. 머리글에 사건번호 칸이 있거나 이미 아는 번호일 때만 사건 줄로 본다 */
function splitXlsx(text: string, known: Set<string>): SheetPart | null {
  const lines = text.split("\n");
  const header: string[] = [];
  const rows = new Map<string, string[]>();
  let headerHasKey = false;
  for (const line of lines) {
    if (line.startsWith("[시트:")) {
      header.push(line);
      headerHasKey = false;
      continue;
    }
    const first = line.split(" | ")[0].trim();
    if (HEADER_KEY_RE.test(first)) {
      headerHasKey = true;
      header.push(line);
      continue;
    }
    if (ROW_KEY_RE.test(first) && (headerHasKey || known.has(norm(first)))) {
      const list = rows.get(first) ?? [];
      list.push(line);
      rows.set(first, list);
    } else {
      header.push(line); // 머리글·설명 줄은 모든 사건에 붙인다
    }
  }
  return rows.size > 0 ? { header, rows } : null;
}

const labelOf = (text: string): string => {
  const flat = text.replace(/\s+/g, " ");
  const m = /부동산\s*표시\s*[:：]?\s*(.+?)\s*(?:소유자|자료 구분|$)/.exec(flat);
  return m ? m[1].trim().slice(0, 60) : "";
};

/** 사건별로 나눈다. 나눌 수 없으면(사건번호가 2개 미만) null */
export function splitCases(documents: ExtractedDocument[]): CaseBundle[] | null {
  const order: string[] = []; // 비교용 번호(norm) 순서
  const display = new Map<string, string>(); // norm → 자료에 적힌 번호
  const labels = new Map<string, string>();
  const per = new Map<string, ExtractedDocument[]>();
  const shared: ExtractedDocument[] = [];

  const add = (key: string) => {
    const n = norm(key);
    if (!display.has(n)) {
      display.set(n, key);
      order.push(n);
      per.set(n, []);
    }
    return n;
  };

  // 1) 엑셀이 아닌 자료에서 사건번호를 찾는다
  const xlsxDocs: ExtractedDocument[] = [];
  for (const doc of documents) {
    if (doc.kind === "xlsx") {
      xlsxDocs.push(doc);
      continue;
    }
    if (doc.kind === "pdf") {
      const { preamble, pieces, pageCount } = splitPdf(doc.text);
      if (pieces.length === 0) {
        shared.push(doc);
        continue;
      }
      if (preamble) shared.push({ ...doc, name: `${doc.name} (공통)`, text: preamble, pages: null });
      for (const p of pieces) {
        const n = add(p.key);
        if (!labels.get(n)) labels.set(n, labelOf(p.text));
        const pages = pageCount.get(p.key) ?? null;
        per.get(n)?.push({ ...doc, name: `${doc.name} (사건 ${p.key})`, text: p.text, pages });
      }
    } else {
      const { preamble, pieces } = splitPlain(doc.text);
      if (pieces.length === 0) {
        shared.push(doc);
        continue;
      }
      if (preamble.trim()) shared.push({ ...doc, name: `${doc.name} (공통)`, text: preamble, pages: null });
      for (const p of pieces) {
        const n = add(p.key);
        if (!labels.get(n)) labels.set(n, labelOf(p.text));
        per.get(n)?.push({ ...doc, name: `${doc.name} (사건 ${p.key})`, text: p.text, pages: null });
      }
    }
  }

  // 2) 엑셀: 이미 아는 번호 또는 머리글의 사건번호 칸 기준으로 줄을 나눈다
  const known = new Set(order);
  for (const doc of xlsxDocs) {
    const part = splitXlsx(doc.text, known);
    if (!part) {
      shared.push(doc);
      continue;
    }
    for (const [key, rows] of part.rows) {
      const n = add(key);
      const cells = rows[0].split(" | ");
      if (!labels.get(n) && cells[1]) labels.set(n, cells[1].slice(0, 60));
      per.get(n)?.push({ ...doc, name: `${doc.name} (사건 ${key})`, text: [...part.header, ...rows].join("\n"), pages: null });
    }
  }

  if (order.length < 2) return null;
  if (order.length > MAX_CASES) {
    throw new ExtractError("invalid", `한 번에 분석할 수 있는 사건은 최대 ${MAX_CASES}건입니다. (자료에서 ${order.length}건을 찾았습니다)`);
  }

  const sorted = [...order].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  return sorted.map((n) => {
    const docs = [...(per.get(n) ?? []), ...shared];
    return {
      key: display.get(n) ?? n,
      label: labels.get(n) ?? "",
      owner: docs.map((d) => ownerOf(d.text)).find((o) => o !== "") ?? "",
      documents: docs,
    };
  });
}
