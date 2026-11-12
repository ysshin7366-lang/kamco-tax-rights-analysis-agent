// Design Ref: §1 ④ 권리 순위 표 — 순위 | 권리 종류 | 접수일자 | 금액 | 선/후순위 | 상태 | 출처(문서명·쪽)
// "확인 불가"·"사람 확인 필요"는 눈에 띄는 색 배지로 보여주고,
// 제외된 항목·말소된 항목·반영하지 않은 규칙은 표 아래에 따로 안내한다.
// Plan SC: 모든 권리 항목에 출처(문서명·쪽)를 함께 표시한다 (PRD §5 ①)

import NoticeBanner from "@/components/NoticeBanner";
import type {
  Conflict,
  Disposition,
  Position,
  RankedRight,
  RankingResult,
  RightStatus,
  SourceRef,
} from "@/lib/types";

const POSITION_STYLE: Record<Position, string> = {
  선순위: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  기준: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  후순위: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  미정: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  "해당 없음": "bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400",
};

const DISPOSITION_STYLE: Record<Disposition, string> = {
  말소기준권리: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200",
  인수: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  소멸: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  "확인 필요": "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

const DISPOSITION_HINT: Record<Disposition, string> = {
  말소기준권리: "소멸되는 최선순위 권리. 이후에 설정된 권리는 모두 말소됨",
  인수: "공매로 소멸되지 않고 낙찰자가 부담하는 권리",
  소멸: "공매(매각)로 말소되는 권리",
  "확인 필요": "자료가 부족해 인수/소멸을 정할 수 없음",
};

const STATUS_STYLE: Record<RightStatus, string> = {
  정상: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  "확인 불가": "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  "사람 확인 필요": "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

const POSITION_HINT: Record<Position, string> = {
  선순위: "기준 권리보다 앞서 접수된 권리",
  기준: "기준 권리: 압류(조세) 중 접수일자가 가장 빠른 것",
  후순위: "기준 권리보다 뒤에 접수된 권리",
  미정: "자료가 부족해 앞뒤를 정할 수 없음",
  "해당 없음": "배분받는 채권이 아니라 순서를 매기지 않음",
};

function Badge({ className, title, children }: { className: string; title?: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${className}`}
    >
      {children}
    </span>
  );
}

function formatAmount(amount: number | null): string {
  return amount === null ? "" : `${amount.toLocaleString("ko-KR")}원`;
}

/** 출처 한 개를 "문서명 · 2쪽" 모양으로 쓴다. (.txt는 쪽이 없어 "—") */
function formatSource(source: Pick<SourceRef, "document" | "page">): string {
  return source.page === null
    ? `${source.document} · 쪽 —`
    : `${source.document} · ${source.page}쪽`;
}

function MissingValue() {
  return <span className="font-medium text-amber-700 dark:text-amber-400">확인 불가</span>;
}

function RightRow({ right }: { right: RankedRight }) {
  return (
    <tr className="border-t border-zinc-200 align-top dark:border-zinc-800">
      <td className="whitespace-nowrap px-3 py-3 text-center font-semibold">{right.rank ?? "미정"}</td>
      <td className="px-3 py-3">
        <p className="font-medium">{right.type}</p>
        {right.holder && <p className="text-xs text-zinc-500">{right.holder}</p>}
        {right.note && (
          <p className="mt-1 text-xs leading-5 text-zinc-500">{right.note}</p>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        {right.receiptDate ??
          (right.missingFields.includes("접수일자") ? (
            <MissingValue />
          ) : (
            <span className="text-zinc-400" title="등기되지 않아 접수일자가 없음(전입일자·확정일자로 비교)">—</span>
          ))}
        {right.receiptNo && (
          <p className="text-xs text-zinc-500">접수번호 {right.receiptNo}</p>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-right">
        {right.amount !== null ? (
          formatAmount(right.amount)
        ) : right.missingFields.includes("금액") ? (
          <MissingValue />
        ) : (
          <span className="text-zinc-400" title="판정에 쓰이지 않는 칸이라 표시하지 않음">—</span>
        )}
      </td>
      <td className="px-3 py-3">
        <Badge
          className={DISPOSITION_STYLE[right.disposition]}
          title={DISPOSITION_HINT[right.disposition]}
        >
          {right.disposition}
        </Badge>
      </td>
      <td className="px-3 py-3 text-xs leading-5">
        {right.tierLabel ?? <span className="text-zinc-400">—</span>}
      </td>
      <td className="px-3 py-3">
        <Badge className={POSITION_STYLE[right.position]} title={POSITION_HINT[right.position]}>
          {right.position}
        </Badge>
      </td>
      <td className="px-3 py-3">
        <Badge className={STATUS_STYLE[right.status]}>{right.status}</Badge>
        {right.statusReasons.length > 0 && (
          <ul className="mt-1 flex max-w-56 flex-col gap-0.5 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
            {right.statusReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-3 text-xs leading-5">
        <ul className="flex flex-col gap-0.5">
          {right.sources.map((source) => (
            <li key={`${source.document}-${source.page}-${source.quote}`}>
              {formatSource(source)}
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

function ListNotice({ title, rights }: { title: string; rights: RankedRight[] }) {
  if (rights.length === 0) return null;
  return (
    <details className="rounded-lg border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
      <summary className="cursor-pointer font-medium">
        {title} ({rights.length}건)
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5 text-zinc-600 dark:text-zinc-400">
        {rights.map((right) => (
          <li key={right.id}>
            <span className="font-medium text-foreground">
              {[right.type, right.holder].filter(Boolean).join(" ")}
            </span>
            {right.amount !== null && ` · ${formatAmount(right.amount)}`} —{" "}
            {right.sources.map(formatSource).join(", ")}
            <br />
            <span className="text-xs">{right.statusReasons.join(" ")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ConflictNotice({ conflicts }: { conflicts: Conflict[] }) {
  if (conflicts.length === 0) return null;
  return (
    <NoticeBanner variant="warning">
      <p className="font-semibold">자료끼리 내용이 서로 맞지 않습니다. (사람 확인 필요)</p>
      <ul className="mt-1 list-disc pl-5">
        {conflicts.map((conflict) => (
          <li key={`${conflict.right}-${conflict.field}`}>
            {conflict.right}의 {conflict.field}:{" "}
            {conflict.values
              .map((v) => `${v.value} (${formatSource(v)})`)
              .join(" ↔ ")}
          </li>
        ))}
      </ul>
    </NoticeBanner>
  );
}

export default function RightsTable({ ranking }: { ranking: RankingResult }) {
  const { rights, cancelled, unregisteredTenants, excluded, conflicts, reference } = ranking;
  const nothingFound =
    rights.length === 0 && cancelled.length === 0 && unregisteredTenants.length === 0;

  return (
    <section aria-labelledby="rights-heading" className="flex flex-col gap-4">
      <h2 id="rights-heading" className="text-lg font-semibold">
        권리 순위
      </h2>

      {nothingFound ? (
        <NoticeBanner variant="error">
          {ranking.allItemsFailedVerification
            ? "모든 항목이 원문 확인에 실패했습니다. 자료를 확인해 주세요."
            : "권리 항목을 찾지 못했습니다. 올린 자료를 확인해 주세요."}
        </NoticeBanner>
      ) : (
        <>
          {/* 1단계: 말소기준권리 */}
          {ranking.malsoStandard ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              <strong className="text-foreground">① 말소기준권리:</strong>{" "}
              {ranking.malsoStandard.type} {ranking.malsoStandard.holder} ·{" "}
              {ranking.malsoStandard.receiptDate ?? "접수일자 불명"} — 이 권리 이후에 설정된
              권리는 모두 말소되고, 이전에 설정된 권리는 낙찰자가 인수합니다.
            </p>
          ) : (
            <NoticeBanner variant="warning">
              ① 말소기준권리를 정하지 못했습니다. 처분(인수/소멸)은 &quot;확인 필요&quot;로
              표시되며 사람 확인이 필요합니다.
            </NoticeBanner>
          )}

          {/* 2단계: 예상 배분순위의 기준이 되는 위임기관 조세채권 */}
          {reference ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              <strong className="text-foreground">② 기준 권리(위임기관 조세채권):</strong>{" "}
              {reference.type} {reference.holder} · {reference.receiptDate} — 배분 순서에서 이보다
              앞서는 채권이 선순위입니다.
            </p>
          ) : (
            <NoticeBanner variant="warning">
              ② 기준 권리(압류(조세))를 정하지 못했습니다. 선순위·후순위는 &quot;미정&quot;으로
              표시되며 사람 확인이 필요합니다.
            </NoticeBanner>
          )}

          {rights.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th scope="col" className="whitespace-nowrap px-3 py-2 text-center">접수 순위</th>
                    <th scope="col" className="px-3 py-2">권리 종류</th>
                    <th scope="col" className="px-3 py-2">접수일자</th>
                    <th scope="col" className="px-3 py-2 text-right">금액</th>
                    <th scope="col" className="px-3 py-2">처분</th>
                    <th scope="col" className="px-3 py-2">예상 배분순위</th>
                    <th scope="col" className="px-3 py-2">선/후순위</th>
                    <th scope="col" className="px-3 py-2">상태</th>
                    <th scope="col" className="px-3 py-2">출처(문서명·쪽)</th>
                  </tr>
                </thead>
                <tbody>
                  {/* 예상 배분순위 순서로 늘어놓는다 (같은 배분순위는 접수 순위 순) */}
                  {[...rights]
                    .sort((a, b) => {
                      const ta = a.tier ?? 99;
                      const tb = b.tier ?? 99;
                      if (ta !== tb) return ta - tb;
                      return (a.rank ?? 999) - (b.rank ?? 999);
                    })
                    .map((right) => (
                      <RightRow key={right.id} right={right} />
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <NoticeBanner variant="info">
              순위를 매길 권리가 없습니다. 아래 안내를 확인해 주세요.
            </NoticeBanner>
          )}

          {!ranking.ranksAssigned && rights.length > 0 && (
            <p className="text-xs text-zinc-500">
              순서를 정할 수 없는 항목이 있어 순위 번호를 붙이지 않았습니다.
            </p>
          )}
        </>
      )}

      <ConflictNotice conflicts={conflicts} />
      <ListNotice title="말소된 항목 (계산에서 뺌)" rights={cancelled} />
      <ListNotice title="등기되지 않은 임차인 (반영하지 않음)" rights={unregisteredTenants} />

      {excluded.length > 0 && (
        <details className="rounded-lg border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
          <summary className="cursor-pointer font-medium">
            제외된 항목 ({excluded.length}건)
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-zinc-600 dark:text-zinc-400">
            {excluded.map((item, index) => (
              <li key={`${item.description}-${index}`}>
                <span className="font-medium text-foreground">{item.description}</span> —{" "}
                {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!nothingFound && ranking.assumptions.length > 0 && (
        <NoticeBanner variant="warning">
          <p className="font-semibold">자료가 없어 가정한 내용</p>
          <ul className="mt-1 list-disc pl-5">
            {ranking.assumptions.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </NoticeBanner>
      )}

      {!nothingFound && ranking.unappliedRules.length > 0 && (
        <NoticeBanner variant="info">
          <p className="font-semibold">반영하지 않은 규칙</p>
          <ul className="mt-1 list-disc pl-5">
            {ranking.unappliedRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </NoticeBanner>
      )}
    </section>
  );
}
