// Design Ref: §2 ② — 한글(.hwpx)과 엑셀(.xlsx) 파일의 글자를 읽는다.
// 두 형식 모두 "압축 파일 안에 XML 글자 파일이 들어 있는" 구조라서, 압축을 풀고 글자만 꺼낸다.
//  - .hwpx : Contents/section0.xml … 안의 <hp:t> 글자. 문단·표 칸 구분을 줄바꿈과 " | "로 남긴다.
//  - .xlsx : 시트별로 "[시트: 이름]" 표시 + 한 줄에 한 행(칸은 " | "로 구분). 날짜 칸은 YYYY-MM-DD로 바꾼다.
// 옛 한글 파일(.hwp), 암호가 걸린 파일, 압축을 비정상적으로 크게 부풀린 파일은 읽지 않는다.
// 이 파일은 서버에서만 쓰며, 일부러 경로 별칭·다른 내부 파일을 가져오지 않아 단독으로 시험할 수 있다.

import { strFromU8, unzipSync } from "fflate";

/** 읽기 실패의 종류: unreadable=읽을 수 없음(깨짐·암호·형식 불일치·과도한 압축), empty=글자가 하나도 없음 */
export class OfficeReadError extends Error {
  constructor(public reason: "unreadable" | "empty") {
    super(reason);
    this.name = "OfficeReadError";
  }
}

const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // 압축을 푼 파일 하나의 상한 (압축 폭탄 방어)
const MAX_TOTAL_UNZIPPED = 60 * 1024 * 1024; // 압축을 푼 합계 상한

// ───────── 공통 ─────────

function unzip(data: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  let total = 0;
  try {
    return unzipSync(data, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        if (file.originalSize > MAX_ENTRY_BYTES) throw new OfficeReadError("unreadable");
        total += file.originalSize;
        if (total > MAX_TOTAL_UNZIPPED) throw new OfficeReadError("unreadable");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof OfficeReadError) throw error;
    throw new OfficeReadError("unreadable"); // 압축 파일이 아니거나 깨짐
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : null;
}

function tidy(lines: string[]): string {
  return lines
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+$/g, "")
        .replace(/\s*\|\s*$/, "")
        .trim(),
    )
    .filter((line) => line !== "")
    .join("\n");
}

// ───────── .hwpx ─────────

export function readHwpx(data: Uint8Array): string {
  const files = unzip(
    data,
    (name) =>
      /^Contents\/section\d+\.xml$/.test(name) || name === "META-INF/manifest.xml",
  );

  // 암호가 걸린 문서는 읽지 않는다
  const manifest = files["META-INF/manifest.xml"];
  if (manifest && /encryption-data|Encrypted/i.test(strFromU8(manifest))) {
    throw new OfficeReadError("unreadable");
  }

  const sections = Object.keys(files)
    .filter((name) => name.startsWith("Contents/section"))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  if (sections.length === 0) throw new OfficeReadError("unreadable"); // 한글 문서 구조가 아님

  const lines: string[] = [];
  const token =
    /<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|<hp:tc(?:\s[^>]*)?>|<\/hp:p>|<\/hp:tc>|<\/hp:tr>/g;

  for (const name of sections) {
    const xml = strFromU8(files[name]);
    let line = "";
    let cellDepth = 0; // 표의 칸 안에 있는지 (칸 안의 문단 끝은 줄바꿈이 아니라 공백)
    for (const match of xml.matchAll(token)) {
      const tag = match[0];
      if (match[1] !== undefined) {
        // 글자 안에 끼어 있는 표시(탭·서식)는 지우고 탭은 공백으로
        line += decodeXml(
          match[1].replace(/<hp:tab\b[^>]*\/?>/g, " ").replace(/<[^>]+>/g, ""),
        );
      } else if (tag.startsWith("<hp:tc")) {
        cellDepth++;
      } else if (tag === "</hp:tc>") {
        cellDepth = Math.max(0, cellDepth - 1);
        line += " | "; // 표의 칸 구분
      } else if (tag === "</hp:p>" && cellDepth > 0) {
        line += " "; // 칸 안의 문단 끝
      } else {
        // 문단 끝, 표의 행 끝
        lines.push(line);
        line = "";
      }
    }
    if (line.trim() !== "") lines.push(line);
  }

  const text = tidy(lines);
  if (text === "") throw new OfficeReadError("empty");
  return text;
}

// ───────── .xlsx ─────────

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dmy]/i.test(stripped) && !/^[#0,.\s%$]*$/.test(stripped);
}

/** 엑셀 날짜 번호(1900년 기준 일수)를 YYYY-MM-DD로 바꾼다 */
export function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  return date.toISOString().slice(0, 10);
}

function readSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) => {
    const body = si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ""); // 한자 읽기 표시 등 제외
    return decodeXml(
      [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""),
    );
  });
}

/** 칸 서식 번호 → 날짜 서식인지 */
function readDateStyles(xml: string): boolean[] {
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = attr(m[0], "numFmtId");
    const code = attr(m[0], "formatCode");
    if (id !== null && code !== null) custom.set(Number(id), code);
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  return [...block.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id) as string));
  });
}

function numberText(raw: string): string {
  const value = Number(raw);
  return Number.isFinite(value) ? String(value) : raw;
}

export function readXlsx(data: Uint8Array): string {
  const files = unzip(
    data,
    (name) =>
      name === "xl/workbook.xml" ||
      name === "xl/_rels/workbook.xml.rels" ||
      name === "xl/sharedStrings.xml" ||
      name === "xl/styles.xml" ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(name) ||
      name === "xl/encryptioninfo" || name === "EncryptionInfo",
  );

  if (files["EncryptionInfo"] || files["xl/encryptioninfo"]) {
    throw new OfficeReadError("unreadable");
  }
  if (!files["xl/workbook.xml"]) throw new OfficeReadError("unreadable"); // 엑셀 문서 구조가 아님

  const workbook = strFromU8(files["xl/workbook.xml"]);
  const rels = files["xl/_rels/workbook.xml.rels"]
    ? strFromU8(files["xl/_rels/workbook.xml.rels"])
    : "";
  const targetById = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) {
      targetById.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
  }

  const shared = files["xl/sharedStrings.xml"]
    ? readSharedStrings(strFromU8(files["xl/sharedStrings.xml"]))
    : [];
  const dateStyles = files["xl/styles.xml"] ? readDateStyles(strFromU8(files["xl/styles.xml"])) : [];

  const out: string[] = [];
  for (const sheetTag of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(sheetTag[0], "name") ?? "시트";
    const rid = attr(sheetTag[0], "r:id");
    const path = rid ? targetById.get(rid) : undefined;
    const sheetFile = path ? files[path] : undefined;
    if (!sheetFile) continue;

    const rows: string[] = [];
    const xml = strFromU8(sheetFile);
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = cell[1];
        const body = cell[2] ?? "";
        const type = attr(tag, "t");
        const style = Number(attr(tag, "s") ?? 0);
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];

        let text = "";
        if (type === "s" && v !== undefined) {
          text = shared[Number(v)] ?? "";
        } else if (type === "inlineStr") {
          text = decodeXml(
            [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""),
          );
        } else if (type === "str" && v !== undefined) {
          text = decodeXml(v);
        } else if (type === "b" && v !== undefined) {
          text = v === "1" ? "TRUE" : "FALSE";
        } else if (type === "e") {
          text = "";
        } else if (v !== undefined && v !== "") {
          const serial = Number(v);
          text = dateStyles[style] ? (excelSerialToDate(serial) ?? numberText(v)) : numberText(v);
        }
        text = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
        if (text !== "") cells.push(text);
      }
      if (cells.length > 0) rows.push(cells.join(" | "));
    }
    if (rows.length > 0) out.push(`[시트: ${name}]`, ...rows);
  }

  const text = tidy(out);
  if (text === "") throw new OfficeReadError("empty");
  return text;
}
