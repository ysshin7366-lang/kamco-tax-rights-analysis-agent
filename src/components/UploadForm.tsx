"use client";

// Design Ref: §1 ② 자료 올리기 — 파일 선택(최대 3개), 예상 매각가 입력(선택), 분석하기 버튼
// Plan SC: 여러 파일 업로드와 매각가 입력칸이 보인다 (PLAN 작업 2)

import { useRef, useState } from "react";
import NoticeBanner from "@/components/NoticeBanner";
import {
  ALLOWED_EXTENSIONS,
  formatSize,
  MAX_FILES,
  parsePrice,
  validateFiles,
} from "@/lib/validateUpload";

export type UploadPayload = {
  files: File[];
  price: number | null; // 입력하지 않았으면 null
};

type UploadFormProps = {
  /** 분석 중이면 true — 버튼을 잠근다 (작업 4~5에서 연결) */
  busy?: boolean;
  /** 검사를 통과한 뒤 "분석하기"를 누르면 호출된다 */
  onSubmit: (payload: UploadPayload) => void;
};

export default function UploadForm({ busy = false, onSubmit }: UploadFormProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [priceText, setPriceText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFilesChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    if (picked.length === 0) return;

    const problem = validateFiles(picked);
    if (problem) {
      // 문제가 있으면 선택을 받아들이지 않고, 이전 선택을 그대로 둔다
      setError(problem);
      event.target.value = "";
      return;
    }
    setError(null);
    setFiles(picked);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (files.length === 0) {
      setError("분석할 파일을 먼저 선택해 주세요.");
      return;
    }
    const fileProblem = validateFiles(files);
    if (fileProblem) {
      setError(fileProblem);
      return;
    }
    const price = parsePrice(priceText);
    if (!price.ok) {
      setError(price.message);
      return;
    }

    setError(null);
    onSubmit({ files, price: price.value });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
    >
      <h2 className="text-lg font-semibold">자료 올리기</h2>

      <div className="flex flex-col gap-2">
        <label htmlFor="files" className="text-sm font-medium">
          자료 파일 (최대 {MAX_FILES}개, 합계 4MB: 텍스트 .txt, 글자가 들어 있는 PDF, 한글 .hwpx, 엑셀 .xlsx)
        </label>
        <input
          ref={inputRef}
          id="files"
          type="file"
          multiple
          accept={ALLOWED_EXTENSIONS.join(",")}
          onChange={handleFilesChange}
          disabled={busy}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-sky-700 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-sky-800"
        />
        {files.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
            {files.map((file) => (
              <li key={file.name}>
                📄 {file.name} ({formatSize(file.size)})
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="price" className="text-sm font-medium">
          예상 매각가 (선택, 원 단위)
        </label>
        <input
          id="price"
          type="text"
          inputMode="numeric"
          placeholder="예: 300,000,000"
          value={priceText}
          onChange={(event) => setPriceText(event.target.value)}
          disabled={busy}
          className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
        />
        <p className="text-xs text-zinc-500">
          자료에 예상 매각가(최저 입찰가·감정가)가 없을 때 입력하면 금액 기준으로
          판단할 수 있습니다.
        </p>
      </div>

      {error && <NoticeBanner variant="error">{error}</NoticeBanner>}

      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-sky-700 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
      >
        {busy ? "분석 중…" : "분석하기"}
      </button>
    </form>
  );
}
