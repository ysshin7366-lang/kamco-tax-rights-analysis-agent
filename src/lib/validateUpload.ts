// Design Ref: §2.4 숫자 제한, §1 예외 안내 — 파일 개수·형식·크기와 예상 매각가 입력을 검사한다.
// 화면(브라우저)과 서버가 같은 규칙을 쓰도록 공용 폴더(lib)에 둔다. 비밀 값은 다루지 않는다.

export const MAX_FILES = 15; // 등기부 10건 + 엑셀 등 여러 자료를 한 번에 올릴 수 있도록 넉넉히 둔다
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 합계 4MB
export const ALLOWED_EXTENSIONS = [".txt", ".pdf", ".hwpx", ".xlsx"] as const;

// 화면에 보여줄 안내 문구 (PRD §5 예외 표와 같은 문구)
export const MESSAGES = {
  tooManyFiles: `파일은 최대 ${MAX_FILES}개까지 올릴 수 있습니다.`,
  badFormat:
    "지원하지 않는 파일 형식입니다. 텍스트(.txt), 글자가 들어 있는 PDF, 한글(.hwpx), 엑셀(.xlsx) 파일을 올려 주세요.",
  tooBig: "파일이 너무 큽니다. 줄여서 다시 올려 주세요.",
  emptyFile: "파일을 읽을 수 없습니다. 내용이 있는 파일을 다시 올려 주세요.",
  badPrice: "예상 매각가는 0보다 큰 숫자(원 단위)로 입력해 주세요.",
} as const;

type FileLike = { name: string; size: number };

/** 선택한 파일들을 검사한다. 문제가 없으면 null, 있으면 안내 문구를 돌려준다. */
export function validateFiles(files: FileLike[]): string | null {
  if (files.length > MAX_FILES) return MESSAGES.tooManyFiles;

  for (const file of files) {
    const name = file.name.toLowerCase();
    if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      return MESSAGES.badFormat;
    }
    if (file.size === 0) return MESSAGES.emptyFile;
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_BYTES) return MESSAGES.tooBig;

  return null;
}

/**
 * 예상 매각가 입력값을 검사한다. (비어 있으면 입력하지 않은 것으로 보고 통과)
 * 쉼표(300,000,000)는 허용하고, 원 단위 양의 정수만 받는다.
 */
export function parsePrice(
  input: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = input.trim().replace(/,/g, "");
  if (text === "") return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false, message: MESSAGES.badPrice };

  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, message: MESSAGES.badPrice };
  }
  return { ok: true, value };
}

/** 파일 크기를 사람이 읽기 쉬운 글자로 바꾼다. (예: 1.2MB) */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
