// Design Ref: §1 ⑤ 배당 가능성 — 큰 배지, 판단 방식, 계산 과정, 근거, 쉬운 풀이
// Plan SC: 근거·계산 과정·전문용어 풀이·"참고용" 문구를 함께 보여준다 (PLAN 작업 9)

import NoticeBanner from "@/components/NoticeBanner";
import { explainJudgement } from "@/lib/explain";
import { findTerms } from "@/lib/glossary";
import type {
  DividendJudgement,
  EvidenceItem,
  JudgementResult,
  RankingResult,
  SourceRef,
} from "@/lib/types";

const RESULT_STYLE: Record<JudgementResult, string> = {
  높음: "bg-emerald-600 text-white",
  보통: "bg-amber-500 text-white",
  낮음: "bg-red-600 text-white",
  "판정 보류": "bg-violet-600 text-white",
  "판정 안 함": "bg-zinc-500 text-white",
};

const ROLE_LABEL: Record<EvidenceItem["role"], string> = {
  선순위: "선순위 권리",
  "기준 권리": "기준 권리",
  "보류 원인": "보류 원인",
  "예상 매각가": "예상 매각가",
};

function formatSource(source: Pick<SourceRef, "document" | "page">): string {
  return source.page === null
    ? `${source.document} · 쪽 —`
    : `${source.document} · ${source.page}쪽`;
}

export default function DividendResult({
  judgement,
  ranking,
}: {
  judgement: DividendJudgement;
  ranking: RankingResult;
}) {
  const explanation = explainJudgement(judgement, ranking);

  // 이 결과에 나온 글에서 전문용어를 찾아 풀이 목록을 만든다
  const texts = [
    judgement.result,
    judgement.method ?? "",
    ...explanation,
    ...judgement.methodReasons,
    ...judgement.priceNotes,
    ...judgement.calculation,
    ...judgement.holdReasons,
    ...judgement.recommendation.reasons,
    ...judgement.evidence.map((item) => `${ROLE_LABEL[item.role]} ${item.label}`),
    ...ranking.rights.map((right) => right.type),
    ...ranking.unappliedRules,
  ];
  // 판정하지 않은 경우(예: 말소된 항목만 있음)에는 용어 풀이를 붙이지 않는다
  const terms = judgement.result === "판정 안 함" ? [] : findTerms(texts);

  const hasResult =
    judgement.result === "높음" || judgement.result === "보통" || judgement.result === "낮음";

  return (
    <section aria-labelledby="dividend-heading" className="flex flex-col gap-4">
      <h2 id="dividend-heading" className="text-lg font-semibold">
        배당 가능성
      </h2>

      <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        {/* 큰 배지 */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-lg px-5 py-2 text-2xl font-bold ${RESULT_STYLE[judgement.result]}`}
          >
            {judgement.result}
          </span>
          {judgement.method && (
            <span className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-medium dark:border-zinc-700">
              판단 방식: {judgement.method}
            </span>
          )}
        </div>

        {/* 3단계: 공매 착수 vs 반려 검토 의견 (참고용) */}
        <div
          className={`rounded-lg border px-4 py-3 ${
            judgement.recommendation.decision === "공매 반려(해제 협의) 검토"
              ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950"
              : judgement.recommendation.decision === "공매 착수 검토"
                ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950"
                : "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950"
          }`}
        >
          <p className="text-sm font-semibold">
            ③ 공매 착수 vs 반려 검토 의견:{" "}
            <span className="text-base">{judgement.recommendation.decision}</span>
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6">
            {judgement.recommendation.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-zinc-500">
            착수·반려는 담당자가 결정합니다. 이 의견은 참고용입니다.
          </p>
        </div>

        {/* 쉬운 설명 */}
        <div className="flex flex-col gap-1 text-sm leading-7">
          {explanation.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>

        {/* 개수 기준으로 판단한 이유 */}
        {judgement.methodReasons.length > 0 && (
          <NoticeBanner variant="info">
            <p className="font-semibold">개수 기준으로 판단한 이유</p>
            <ul className="mt-1 list-disc pl-5">
              {judgement.methodReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </NoticeBanner>
        )}

        {judgement.priceNotes.length > 0 && (
          <NoticeBanner variant="warning">
            <ul className="list-disc pl-5">
              {judgement.priceNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </NoticeBanner>
        )}

        {/* 판정 보류 이유 */}
        {judgement.holdReasons.length > 0 && (
          <NoticeBanner variant="warning">
            <p className="font-semibold">판정을 보류한 이유 (사람 확인 필요)</p>
            <ul className="mt-1 list-disc pl-5">
              {judgement.holdReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </NoticeBanner>
        )}

        {/* 계산 과정 */}
        {judgement.calculation.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">계산 과정</h3>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-6">
              {judgement.calculation.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </div>
        )}

        {/* 근거 자료 (판정마다 1개 이상) */}
        {judgement.evidence.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">근거 자료</h3>
            <ul className="mt-1 flex flex-col gap-1.5 text-sm">
              {judgement.evidence.map((item) => (
                <li
                  key={`${item.role}-${item.label}`}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-medium dark:bg-zinc-800">
                    {ROLE_LABEL[item.role]}
                  </span>
                  <span className="font-medium">{item.label}</span>
                  {item.sources.length > 0 && (
                    <span className="text-xs text-zinc-500">
                      출처: {item.sources.map(formatSource).join(", ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!hasResult && judgement.result !== "판정 안 함" && (
          <p className="text-xs text-zinc-500">
            보류된 항목을 확인하고 자료를 보완하면 다시 분석할 수 있습니다.
          </p>
        )}
      </div>

      {/* 쉬운 풀이: 이 결과에 나온 전문용어 */}
      {terms.length > 0 && (
        <details open className="rounded-lg border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
          <summary className="cursor-pointer font-semibold">쉬운 용어 풀이 ({terms.length}개)</summary>
          <dl className="mt-2 flex flex-col gap-2">
            {terms.map((entry) => (
              <div key={entry.term}>
                <dt className="font-medium">{entry.term}</dt>
                <dd className="text-zinc-600 dark:text-zinc-400">{entry.meaning}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <p className="text-xs font-medium text-zinc-500">참고용, 담당자 최종 확인 필요</p>
    </section>
  );
}
