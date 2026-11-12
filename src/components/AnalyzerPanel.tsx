"use client";

// Design Ref: §1 ②~⑥ — 올리기 칸과 (이후 작업에서 붙을) 결과 칸을 묶는 화면 조립 부품
// 작업 4: "분석하기"를 누르면 서버 API(/api/analyze)로 파일을 보내 글자를 읽고 요약을 받는다.
// 권리 순위·배당 가능성 칸은 작업 6~9에서 붙인다.

import { useState } from "react";
import DividendResult from "@/components/DividendResult";
import NoticeBanner from "@/components/NoticeBanner";
import RightsTable from "@/components/RightsTable";
import UploadForm, { type UploadPayload } from "@/components/UploadForm";
import { parsePrice } from "@/lib/validateUpload";
import {
  RATE_LIMIT_MESSAGE,
  TIMEOUT_MESSAGE,
  UNAVAILABLE_MESSAGE,
  type AnalyzeResponse,
  type AnalyzeSuccessResponse,
} from "@/lib/types";

export default function AnalyzerPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeSuccessResponse | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // 사건별 예상 매각금액 입력칸 (사건번호 → 입력한 글)
  const [casePrices, setCasePrices] = useState<Record<string, string>>({});
  // 사건별 추가 당해세 채권 입력 (자료에 없는 재산세 등을 보고서에만 반영)
  type ExtraInput = { holder: string; taxKind: string; amount: string; lawDate: string };
  const [extras, setExtras] = useState<Record<string, ExtraInput[]>>({});

  async function handleSubmit({ files, price }: UploadPayload) {
    setBusy(true);
    setError(null);
    setResult(null);
    setCasePrices({});
    setExtras({});
    setDownloadError(null);

    const formData = new FormData();
    files.forEach((file) => formData.append("files", file));
    if (price !== null) formData.append("price", String(price));

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      let data: AnalyzeResponse | null = null;
      try {
        data = (await response.json()) as AnalyzeResponse;
      } catch {
        data = null; // 서버가 우리 형식으로 답하지 못한 경우
      }

      if (data && data.ok) {
        setResult(data);
      } else if (data && !data.ok) {
        setError(data.message);
      } else if (response.status === 429) {
        setError(RATE_LIMIT_MESSAGE);
      } else if (response.status === 504) {
        setError(TIMEOUT_MESSAGE);
      } else if (response.status === 413) {
        setError("파일이 너무 큽니다. 줄여서 다시 올려 주세요.");
      } else {
        setError(UNAVAILABLE_MESSAGE);
      }
    } catch {
      // 인터넷 연결 문제 등
      setError(UNAVAILABLE_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  /** 화면에 나온 결과를 한글(.hwpx) 보고서로 만들어 내려받는다 (caseKey가 있으면 그 사건만) */
  async function handleDownload(caseKey?: string) {
    if (!result) return;
    // 사건별 예상 매각금액 검사 (비워 두면 분석할 때 입력한 값을 쓴다)
    const prices: Record<string, number | null> = {};
    for (const [key, text] of Object.entries(casePrices)) {
      const parsed = parsePrice(text);
      if (!parsed.ok) {
        setDownloadError(`사건 ${key}: ${parsed.message}`);
        return;
      }
      prices[key] = parsed.value;
    }
    // 추가 당해세 채권 검사: 한 줄이라도 채웠다면 권리자·세목·금액이 모두 있어야 한다
    const extrasToSend: Record<string, { holder: string; taxKind: string; amount: number; lawDate: string | null }[]> = {};
    for (const [key, list] of Object.entries(extras)) {
      for (const e of list) {
        if (e.holder.trim() === "" && e.taxKind.trim() === "" && e.amount.trim() === "" && e.lawDate === "") continue; // 빈 줄은 무시
        const amount = parsePrice(e.amount);
        if (e.holder.trim() === "" || e.taxKind.trim() === "" || !amount.ok || amount.value === null) {
          setDownloadError(`사건 ${key}의 추가 채권: 권리자, 세목, 금액(0보다 큰 숫자)을 모두 입력해 주세요.`);
          return;
        }
        (extrasToSend[key] ??= []).push({ holder: e.holder.trim(), taxKind: e.taxKind.trim(), amount: amount.value, lawDate: e.lawDate || null });
      }
    }
    setDownloading(true);
    setDownloadError(null);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result, caseKey, prices, extras: extrasToSend }),
      });
      if (!response.ok) throw new Error("fail");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = caseKey ? `권리분석_보고서_사건${caseKey}.zip` : "권리분석_보고서.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("보고서를 만들 수 없습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setDownloading(false);
    }
  }

  /** 사건별 예상 매각금액 입력칸 */
  const priceInput = (key: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`price-${key}`} className="text-sm font-medium">
        이 사건의 예상 매각금액 (원, 보고서의 배분금액 계산에 사용)
      </label>
      <input
        id={`price-${key}`}
        type="text"
        inputMode="numeric"
        placeholder={result?.price != null ? `비워 두면 ${result.price.toLocaleString()}원` : "예: 300,000,000"}
        value={casePrices[key] ?? ""}
        onChange={(event) => setCasePrices((prev) => ({ ...prev, [key]: event.target.value }))}
        className="w-full max-w-xs rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
      />
      <p className="text-xs text-zinc-500">강제징수비는 사건마다 10,000,000원으로 계산합니다.</p>
    </div>
  );

  /** 사건별 추가 당해세 채권 입력칸 */
  const extraInputs = (key: string) => {
    const list = extras[key] ?? [];
    const update = (index: number, patch: Partial<ExtraInput>) =>
      setExtras((prev) => ({ ...prev, [key]: (prev[key] ?? []).map((row, i) => (i === index ? { ...row, ...patch } : row)) }));
    const field = "rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700";
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">추가 당해세 채권 (선택 — 자료에 없는 재산세 등, 보고서에만 반영)</p>
        {list.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <input aria-label="권리자" placeholder="권리자 (예: 대전시청)" value={row.holder} onChange={(e) => update(index, { holder: e.target.value })} className={`${field} w-44`} />
            <input aria-label="세목" placeholder="세목 (예: 재산세)" value={row.taxKind} onChange={(e) => update(index, { taxKind: e.target.value })} className={`${field} w-32`} />
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              법정기일
              <input type="date" aria-label="법정기일" value={row.lawDate} onChange={(e) => update(index, { lawDate: e.target.value })} className={`${field} text-foreground`} />
            </label>
            <input aria-label="금액" inputMode="numeric" placeholder="금액 (원)" value={row.amount} onChange={(e) => update(index, { amount: e.target.value })} className={`${field} w-36`} />
            <button
              type="button"
              onClick={() => setExtras((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((_, i) => i !== index) }))}
              className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700"
            >
              삭제
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            onClick={() => setExtras((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), { holder: "", taxKind: "", amount: "", lawDate: "" }] }))}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            + 당해세 채권 추가
          </button>
        </div>
        <p className="text-xs text-zinc-500">당해세는 3순위로 다른 조세·담보채권보다 먼저 배분하며, 법정기일은 보고서의 법정기일 칸(첫일·끝일)에만 적고 배분 순서에는 영향을 주지 않습니다. (모르면 비워 두세요)</p>
      </div>
    );
  };

  const downloadButton = (caseKey?: string, label = "보고서 내려받기 (한글 .hwpx)") => (
    <button
      type="button"
      onClick={() => handleDownload(caseKey)}
      disabled={downloading}
      className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
    >
      {downloading ? "보고서 만드는 중…" : `⬇ ${label}`}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <UploadForm busy={busy} onSubmit={handleSubmit} />

      {error && <NoticeBanner variant="error">{error}</NoticeBanner>}

      {busy && (
        <NoticeBanner variant="info">
          자료를 분석하고 있습니다. 잠시만 기다려 주세요. (최대 몇 분이 걸릴 수 있습니다)
        </NoticeBanner>
      )}

      {/* 사건이 여러 건이면 사건별 요약표 + 사건마다 접고 펼 수 있는 결과 */}
      {result && !busy && result.cases && (
        <>
          <p className="text-sm text-zinc-500">
            자료에서 사건 {result.cases.length}건을 찾아 사건별로 나누어 분석했습니다.
            {result.price !== null && " 입력한 예상 매각가는 모든 사건에 같이 적용했습니다."}
          </p>

          <div className="flex flex-col gap-2">
            <div>{downloadButton(undefined, `전체 ${result.cases.length}건 보고서 내려받기 (한글 .hwpx)`)}</div>
            <p className="text-xs text-zinc-500">
              사건마다 배분계산서와 배분계산내역표 2개 파일이 들어 있는 .zip 파일입니다.
              {result.price === null && " 예상 매각가를 입력하고 분석하면 배분금액까지 채워집니다."}
            </p>
            {downloadError && <NoticeBanner variant="error">{downloadError}</NoticeBanner>}
          </div>

          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900">
                <tr>
                  <th className="px-3 py-2">사건</th>
                  <th className="px-3 py-2">부동산</th>
                  <th className="px-3 py-2">권리 수</th>
                  <th className="px-3 py-2">배당 가능성</th>
                  <th className="px-3 py-2">검토 의견</th>
                </tr>
              </thead>
              <tbody>
                {result.cases.map((c) => (
                  <tr key={c.key} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="px-3 py-2 font-medium">{c.key}</td>
                    <td className="px-3 py-2">{c.label || "-"}</td>
                    <td className="px-3 py-2">{c.ranking ? c.ranking.rights.length : "-"}</td>
                    <td className="px-3 py-2">{c.judgement ? c.judgement.result : "분석 실패"}</td>
                    <td className="px-3 py-2">{c.judgement ? c.judgement.recommendation.decision : c.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.cases.map((c, index) => (
            <details
              key={c.key}
              open={index === 0}
              className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <summary className="cursor-pointer text-base font-semibold">
                사건 {c.key}
                {c.label ? ` — ${c.label}` : ""}
              </summary>
              <div className="mt-4 flex flex-col gap-4">
                <p className="text-xs text-zinc-500">
                  이 사건에 쓴 자료:{" "}
                  {c.documents
                    .map((doc) => `${doc.name}(${doc.pages !== null ? `${doc.pages}쪽, ` : ""}${doc.chars.toLocaleString()}자)`)
                    .join(", ")}
                </p>
                {c.ranking && (
                  <div className="flex flex-col gap-2 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
                    {priceInput(c.key)}
                    {extraInputs(c.key)}
                    <div>{downloadButton(c.key, `사건 ${c.key} 보고서 내려받기`)}</div>
                  </div>
                )}
                {c.error && <NoticeBanner variant="error">{c.error}</NoticeBanner>}
                {c.ranking && <RightsTable ranking={c.ranking} />}
                {c.ranking &&
                  c.judgement &&
                  (c.ranking.rights.length > 0 ||
                    c.ranking.cancelled.length > 0 ||
                    c.ranking.unregisteredTenants.length > 0) && (
                    <DividendResult judgement={c.judgement} ranking={c.ranking} />
                  )}
              </div>
            </details>
          ))}

          <NoticeBanner variant="warning">
            <strong>참고용, 담당자 최종 확인 필요</strong>
          </NoticeBanner>
        </>
      )}

      {result && !busy && !result.cases && (
        <>
          <div className="flex flex-col gap-2 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
            {priceInput("분석결과")}
            {extraInputs("분석결과")}
            <div>{downloadButton()}</div>
            {downloadError && <NoticeBanner variant="error">{downloadError}</NoticeBanner>}
          </div>
          <p className="text-sm text-zinc-500">
            읽은 자료:{" "}
            {result.documents
              .map(
                (doc) =>
                  `${doc.name}(${doc.pages !== null ? `${doc.pages}쪽, ` : ""}${doc.chars.toLocaleString()}자)`,
              )
              .join(", ")}
          </p>

          {/* ④ 권리 순위 표 */}
          <RightsTable ranking={result.ranking} />

          {/* ⑤ 배당 가능성 */}
          {/* 권리를 하나도 못 찾은 경우에는 ④의 오류 안내만 보여준다 (판정 카드·용어 풀이는 숨김) */}
          {(result.ranking.rights.length > 0 ||
            result.ranking.cancelled.length > 0 ||
            result.ranking.unregisteredTenants.length > 0) && (
            <DividendResult judgement={result.judgement} ranking={result.ranking} />
          )}

          {/* ⑥ 맺음말: 결과가 있을 때 항상 보인다 */}
          <NoticeBanner variant="warning">
            <strong>참고용, 담당자 최종 확인 필요</strong>
          </NoticeBanner>
        </>
      )}
    </div>
  );
}
