// Design Ref: §2 ② — 서버가 파일을 다시 검사하고 글자를 읽는다.
//   - .txt: UTF-8로 읽고, 글자가 깨지면 EUC-KR(옛 저장 방식)로 다시 읽는다.
//   - PDF: 쪽마다 "[p.N]" 표시를 붙여 글자를 꺼낸다. 글자가 없으면 스캔본으로 본다. (글자 인식 OCR은 하지 않음)
//   - 한글(.hwpx)·엑셀(.xlsx): extractOffice.ts에서 압축을 풀어 글자만 꺼낸다. (쪽 번호는 알 수 없어 "—")
//   - 하나라도 실패하면 전체를 멈추고, 실패한 파일 이름을 안내에 넣는다.
// 이 파일은 서버에서만 불러온다. (화면 코드에서 가져오지 않는다)

import { extractText, getDocumentProxy } from "unpdf";
import { readHwpx, readXlsx } from "@/lib/server/extractOffice";
import { validateFiles } from "@/lib/validateUpload";

export const MAX_TOTAL_CHARS = 100_000; // 글자 수 합계 10만 자 (DESIGN §2.4)
const MAX_PDF_PAGES = 100; // 쪽이 너무 많은 PDF는 처리하지 않는다 (처리 시간 보호)
const PDF_TIMEOUT_MS = 60_000; // PDF 한 개를 읽는 데 쓸 최대 시간

export type ExtractErrorCode = "invalid" | "scanned" | "unreadable" | "tooBig";

/** 화면에 그대로 보여줄 안내 문구(message)를 담은 오류 */
export class ExtractError extends Error {
  constructor(
    public code: ExtractErrorCode,
    message: string,
    public fileName?: string,
  ) {
    super(message);
    this.name = "ExtractError";
  }
}

export type InputFile = { name: string; data: Uint8Array };

export type ExtractedDocument = {
  name: string;
  kind: "txt" | "pdf" | "hwpx" | "xlsx";
  /** 읽어 낸 글자. PDF는 쪽마다 "[p.N]" 표시가 앞에 붙어 있다. */
  text: string;
  /** PDF 쪽 수 (.txt·.hwpx·.xlsx는 null — 쪽 번호를 알 수 없다) */
  pages: number | null;
};

const unreadable = (name: string) =>
  new ExtractError(
    "unreadable",
    `다음 파일을 읽을 수 없습니다: ${name}. 내용이 있는 파일을 다시 올려 주세요.`,
    name,
  );

const scanned = (name: string) =>
  new ExtractError(
    "scanned",
    `글자를 읽을 수 없는 파일입니다. 텍스트로 된 파일을 올려 주세요. (${name})`,
    name,
  );

/** .txt 파일의 글자를 읽는다. UTF-8 → 안 되면 EUC-KR 순서로 시도한다. */
export function decodeTxt(data: Uint8Array, name: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // UTF-8이 아니면 옛 한글 저장 방식(EUC-KR)으로 다시 읽는다
    text = new TextDecoder("euc-kr").decode(data);
    // 그래도 깨진 글자(�)가 섞여 있으면 읽을 수 없는 파일로 본다
    if (text.includes("�")) throw unreadable(name);
  }
  text = text.replace(/^﻿/, ""); // 맨 앞의 보이지 않는 표시(BOM) 제거
  if (text.trim() === "") throw unreadable(name); // 빈 파일
  return text;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** PDF 파일의 글자를 쪽별로 꺼낸다. */
export async function decodePdf(
  data: Uint8Array,
  name: string,
): Promise<{ text: string; pages: number }> {
  // PDF 파일은 "%PDF"로 시작한다. 아니면 깨졌거나 이름만 PDF인 파일이다.
  const header = new TextDecoder("latin1").decode(data.slice(0, 1024));
  if (!header.includes("%PDF")) throw unreadable(name);

  try {
    const pdf = await getDocumentProxy(data);
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new ExtractError(
        "tooBig",
        "파일이 너무 큽니다. 줄여서 다시 올려 주세요.",
        name,
      );
    }
    const { text } = await withTimeout(
      extractText(pdf, { mergePages: false }),
      PDF_TIMEOUT_MS,
    );
    const pageTexts = text as string[];

    // 글자가 하나도 없으면 스캔본(사진)으로 본다
    if (pageTexts.every((page) => page.trim() === "")) throw scanned(name);

    const joined = pageTexts
      .map((page, index) => ({ page: page.trim(), no: index + 1 }))
      .filter((item) => item.page !== "")
      .map((item) => `[p.${item.no}]\n${item.page}`)
      .join("\n\n");
    return { text: joined, pages: pageTexts.length };
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    // 암호가 걸렸거나 깨진 PDF, 시간 초과 등
    throw unreadable(name);
  }
}

/** 올린 파일 전부의 글자를 읽는다. 하나라도 실패하면 ExtractError를 던진다. */
export async function extractAll(
  files: InputFile[],
): Promise<ExtractedDocument[]> {
  // 서버에서도 개수·형식·크기를 다시 검사한다 (브라우저 검사를 믿지 않는다)
  const problem = validateFiles(
    files.map((file) => ({ name: file.name, size: file.data.byteLength })),
  );
  if (problem) throw new ExtractError("invalid", problem);

  const results: ExtractedDocument[] = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pdf")) {
      const { text, pages } = await decodePdf(file.data, file.name);
      results.push({ name: file.name, kind: "pdf", text, pages });
    } else if (lower.endsWith(".hwpx") || lower.endsWith(".xlsx")) {
      const kind = lower.endsWith(".hwpx") ? "hwpx" : "xlsx";
      try {
        const text = kind === "hwpx" ? readHwpx(file.data) : readXlsx(file.data);
        results.push({ name: file.name, kind, text, pages: null });
      } catch {
        // 암호·깨짐·형식 불일치(예: 옛 .hwp를 이름만 바꾼 파일)·글자 없음은 모두 "읽을 수 없는 파일"
        throw unreadable(file.name);
      }
    } else {
      const text = decodeTxt(file.data, file.name);
      results.push({ name: file.name, kind: "txt", text, pages: null });
    }
  }

  const totalChars = results.reduce((sum, doc) => sum + doc.text.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new ExtractError(
      "tooBig",
      "파일이 너무 큽니다. 줄여서 다시 올려 주세요.",
    );
  }
  return results;
}
