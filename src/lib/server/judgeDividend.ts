// Design Ref: §2 ⑦, §2.2 — 배당 가능성을 "높음 / 보통 / 낮음"으로 판정한다. (판정 보류·판정 안 함 포함)
// 모두 고정 규칙이라 같은 입력이면 항상 같은 결과가 나온다. (AI를 부르지 않는다)
//
//  기준표 (PRD §5 ②)
//   금액 기준: 선순위 합계 ÷ 예상 매각가  → 50% 미만=높음 / 50% 이상 80% 이하=보통 / 80% 초과=낮음
//   개수 기준: 선순위 권리 개수            → 0~1건=높음   / 2~3건=보통            / 4건 이상=낮음
//  경계값 계산은 소수를 쓰지 않고 정수끼리 비교한다. (합계×100 과 매각가×50·×80)
// 외부 패키지·경로 별칭을 쓰지 않아 단독으로 시험할 수 있다.

import type {
  DividendJudgement,
  EvidenceItem,
  JudgementResult,
  RankedRight,
  RankingResult,
  Recommendation,
  SourceRef,
  UsedPrice,
} from "../types";

// 큰 정수 계산용 상수 (이 프로젝트 설정에서는 100n 같은 표기를 쓸 수 없어 함수로 만든다)
const B50 = BigInt(50);
const B80 = BigInt(80);
const B100 = BigInt(100);
const B10000 = BigInt(10000);

type Level = Extract<JudgementResult, "높음" | "보통" | "낮음">;

const won = (value: number | bigint) => `${value.toLocaleString("ko-KR")}원`;
const labelOf = (right: RankedRight) =>
  [right.type, right.holder].filter(Boolean).join(" ");

// ───────── 기준표 ─────────

/** 금액 기준: 선순위 합계와 예상 매각가를 정수로 비교해 단계를 정한다. */
export function classifyByAmount(sum: number, price: number): Level {
  const s = BigInt(sum);
  const p = BigInt(price);
  if (s * B100 < p * B50) return "높음"; // 50% 미만
  if (s * B100 <= p * B80) return "보통"; // 50% 이상 80% 이하
  return "낮음"; // 80% 초과
}

/** 개수 기준: 선순위 권리 개수로 단계를 정한다. */
export function classifyByCount(count: number): Level {
  if (count <= 1) return "높음";
  if (count <= 3) return "보통";
  return "낮음";
}

const AMOUNT_BAND: Record<Level, string> = {
  높음: "50% 미만 → 높음",
  보통: "50% 이상 80% 이하 → 보통",
  낮음: "80% 초과 → 낮음",
};
const COUNT_BAND: Record<Level, string> = {
  높음: "선순위 0~1건 → 높음",
  보통: "선순위 2~3건 → 보통",
  낮음: "선순위 4건 이상 → 낮음",
};

/** 비율을 소수 둘째 자리까지 "버림"으로 쓴다. (예: 80.0049% → "80.00%") */
export function formatRatio(sum: number, price: number): string {
  const hundredths = (BigInt(sum) * B10000) / BigInt(price); // 100분의 1 퍼센트 단위, 버림
  const whole = hundredths / B100;
  const frac = (hundredths % B100).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

// ───────── 예상 매각가 정하기 ─────────

type PriceCandidate = { kind: "최저입찰가" | "감정가"; amount: number; source: SourceRef };

/** 입력값 → 자료의 최저 입찰가 → 감정가 순서. 자료끼리 값이 다르면 매각가 없음으로 본다. */
export function pickPrice(
  userPrice: number | null,
  candidates: PriceCandidate[],
): { price: UsedPrice | null; notes: string[] } {
  if (userPrice !== null) {
    return { price: { value: userPrice, origin: "입력", source: null }, notes: [] };
  }
  const notes: string[] = [];
  for (const kind of ["최저입찰가", "감정가"] as const) {
    const ofKind = candidates.filter((c) => c.kind === kind);
    const values = [...new Set(ofKind.map((c) => c.amount))];
    if (values.length === 1) {
      return {
        price: { value: values[0], origin: kind, source: ofKind[0].source },
        notes,
      };
    }
    if (values.length > 1) {
      notes.push(
        `자료끼리 ${kind === "최저입찰가" ? "최저 입찰가" : "감정가"}가 달라(${values
          .map(won)
          .join(" / ")}) 예상 매각가를 정할 수 없습니다. (사람 확인 필요)`,
      );
      return { price: null, notes };
    }
  }
  return { price: null, notes };
}

// ───────── 판정 ─────────

function evidenceOf(
  right: RankedRight,
  role: EvidenceItem["role"],
): EvidenceItem {
  return { label: labelOf(right), role, sources: right.sources };
}

const originText = (price: UsedPrice) =>
  price.origin === "입력"
    ? "직접 입력한 값"
    : `${price.origin === "최저입찰가" ? "최저 입찰가" : "감정가"} (${price.source?.document}${
        price.source?.page != null ? ` · ${price.source.page}쪽` : ""
      })`;

type CoreJudgement = Omit<DividendJudgement, "recommendation">;

function judgeCore(ranking: RankingResult, userPrice: number | null): CoreJudgement {
  const base: CoreJudgement = {
    result: "판정 안 함",
    method: null,
    methodReasons: [],
    seniorCount: 0,
    seniorSum: null,
    price: null,
    priceNotes: [],
    ratioText: null,
    boundaryNote: null,
    bandText: null,
    calculation: [],
    holdReasons: [],
    noJudgementReason: null,
    evidence: [],
  };

  // 1) 권리 항목이 없으면 판정하지 않는다
  if (ranking.rights.length === 0) {
    return {
      ...base,
      noJudgementReason: ranking.allItemsFailedVerification
        ? "모든 항목이 원문 확인에 실패해 판정하지 않았습니다."
        : "순위 계산에 넣을 권리 항목을 찾지 못해 판정하지 않았습니다.",
    };
  }

  // 2) 순위 계산에 넣을 수 없는 항목이 있으면 판정을 보류한다
  if (ranking.holdReasons.length > 0) {
    const evidence: EvidenceItem[] = ranking.rights
      .filter((right) => right.blocksJudgement)
      .map((right) => evidenceOf(right, "보류 원인"));
    if (ranking.reference) evidence.push(evidenceOf(ranking.reference, "기준 권리"));
    // 기준 권리를 못 찾은 경우처럼 원인이 되는 항목이 없으면, 읽은 권리 전부를 근거로 보여준다 (근거 1개 이상)
    if (evidence.length === 0) {
      ranking.rights.forEach((right) => evidence.push(evidenceOf(right, "보류 원인")));
    }
    return {
      ...base,
      result: "판정 보류",
      holdReasons: ranking.holdReasons,
      evidence,
    };
  }

  // 3) 선순위 권리와 예상 매각가
  const seniors = ranking.rights.filter((right) => right.position === "선순위");
  const { price, notes } = pickPrice(userPrice, ranking.priceCandidates);

  const evidence: EvidenceItem[] = seniors.map((right) => evidenceOf(right, "선순위"));
  if (ranking.reference) evidence.push(evidenceOf(ranking.reference, "기준 권리"));

  // 4) 금액 기준을 쓸 수 있는지: 선순위 전부에 금액이 있고 예상 매각가가 있어야 한다
  const withoutAmount = seniors.filter((right) => right.amount === null);
  const methodReasons: string[] = [];
  if (price === null) {
    methodReasons.push(
      notes.length > 0
        ? "예상 매각가를 정할 수 없어 개수 기준으로 판정했습니다."
        : "예상 매각가가 없어 개수 기준으로 판정했습니다.",
    );
  }
  if (withoutAmount.length > 0) {
    methodReasons.push(
      `금액이 없는 선순위 권리(${withoutAmount.map(labelOf).join(", ")})가 있어 개수 기준으로 판정했습니다.`,
    );
  }

  if (price !== null && withoutAmount.length === 0) {
    // 금액 기준
    const sum = seniors.reduce((total, right) => total + (right.amount as number), 0);
    const result = classifyByAmount(sum, price.value);
    const ratioText = formatRatio(sum, price.value);

    // 표시(버림)가 50.00%·80.00%로 같아 보여도 경계를 넘었으면 안내한다
    let boundaryNote: string | null = null;
    const s100 = BigInt(sum) * B100;
    const p = BigInt(price.value);
    if (ratioText === "80.00%" && s100 > p * B80) {
      boundaryNote = "80%를 근소하게 넘어 '낮음'으로 판정했습니다.";
    } else if (ratioText === "50.00%" && s100 > p * B50) {
      boundaryNote = "50%를 근소하게 넘어 '보통'으로 판정했습니다.";
    }

    evidence.push({
      label: `예상 매각가 ${won(price.value)}`,
      role: "예상 매각가",
      sources: price.source ? [price.source] : [],
    });

    return {
      ...base,
      result,
      method: "금액 기준",
      seniorCount: seniors.length,
      seniorSum: sum,
      price,
      priceNotes: notes,
      ratioText,
      boundaryNote,
      bandText: AMOUNT_BAND[result],
      calculation: [
        seniors.length > 0
          ? `선순위(기준 권리보다 앞선 채권) 합계 = ${seniors
              .map((right) => `${labelOf(right)} ${won(right.amount as number)}`)
              .join(" + ")} = ${won(sum)}`
          : "선순위 권리가 없어 합계는 0원입니다.",
        `예상 매각가 = ${won(price.value)} — ${originText(price)}`,
        `비율 = ${won(sum)} ÷ ${won(price.value)} = ${ratioText}`,
        `기준표: ${AMOUNT_BAND[result]}`,
      ],
      evidence,
    };
  }

  // 개수 기준
  const result = classifyByCount(seniors.length);
  return {
    ...base,
    result,
    method: "개수 기준",
    methodReasons,
    seniorCount: seniors.length,
    price,
    priceNotes: notes,
    bandText: COUNT_BAND[result],
    calculation: [
      `선순위 권리 개수 = ${seniors.length}건${
        seniors.length > 0 ? ` (${seniors.map(labelOf).join(", ")})` : ""
      }`,
      `기준표: ${COUNT_BAND[result]}`,
    ],
    evidence,
  };
}

// ───────── 공매 착수 vs 반려 검토 의견 (권리분석기준.md §9) ─────────

const MIN_SALE_VALUE = 1_000_000; // 추산가액 100만원 미만은 매각 실익이 없어 공매 불가 (§9.2)

function recommend(ranking: RankingResult, core: CoreJudgement): Recommendation {
  if (core.result === "판정 안 함") {
    return {
      decision: "판단 보류",
      reasons: [core.noJudgementReason ?? "판단할 자료가 부족합니다."],
    };
  }
  if (core.result === "판정 보류") {
    return {
      decision: "판단 보류",
      reasons: [
        "순위 계산에 넣을 수 없는 항목이 있어 공매 착수·반려를 판단하지 않습니다. 사람이 확인한 뒤 다시 분석해 주세요.",
        ...core.holdReasons,
      ],
    };
  }

  const reasons: string[] = [];
  let decision: Recommendation["decision"] = "공매 착수 검토";

  // ① 최선순위 가등기·가처분, 말소 예고등기: 공매 불가 → 위임기관과 해제 협의
  if (ranking.proceedBlockers.length > 0) {
    decision = "공매 반려(해제 협의) 검토";
    reasons.push(...ranking.proceedBlockers);
  }
  // ② 추산가액 100만원 미만
  if (core.price !== null && core.price.value < MIN_SALE_VALUE) {
    decision = "공매 반려(해제 협의) 검토";
    reasons.push("예상 매각가가 100만원 미만이라 매각 실익이 없어 공매 불가 검토 대상입니다.");
  }
  // ③ 선순위 채권이 매각대금을 다 가져가 위임기관 조세채권에 남을 여지가 없음 (국세징수법 제57조 등)
  if (core.method === "금액 기준" && core.seniorSum !== null && core.price !== null) {
    if (core.seniorSum >= core.price.value) {
      decision = "공매 반려(해제 협의) 검토";
      reasons.push(
        `기준 권리보다 앞선 채권 합계(${won(core.seniorSum)})가 예상 매각가(${won(core.price.value)}) 이상이라 위임기관 조세채권에 배분될 금액이 남을 여지가 없습니다. 압류 해제·체납처분 중지 요건(국세징수법 제57조, 지방세징수법 제104조)을 검토하세요. 다만 교부청구·참가압류가 있고 그 체납액 기준으로 남을 여지가 있으면 계속할 수 있습니다.`,
      );
    }
  }
  // ④ 앞선 채권 비중이 큼
  if (decision === "공매 착수 검토" && core.result === "낮음") {
    decision = "신중 검토";
    reasons.push(
      "기준 권리보다 앞선 채권(선순위 근저당·임차인 등)이 많아 조세 배분 실익이 낮습니다. 위임기관과 협의해 진행 여부를 검토하세요. (선순위 채권 과다)",
    );
  }
  if (decision === "공매 착수 검토") {
    reasons.push(
      core.result === "높음"
        ? "기준 권리보다 앞선 채권이 적어 조세 배분이 가능할 것으로 보입니다."
        : "기준 권리보다 앞선 채권이 일부 있습니다. 배분 실익이 있는지 금액을 확인하며 진행을 검토하세요.",
    );
  }
  if (core.method === "개수 기준") {
    reasons.push("금액 자료가 부족해 선순위 채권 개수로만 판단했습니다. 금액 확인 후 다시 보시길 권합니다.");
  }

  // 조건부 진행·인수 권리 안내
  ranking.conditions.forEach((text) => reasons.push(`[조건부 진행] ${text}`));
  ranking.burdens.forEach((text) => reasons.push(`[인수 권리] ${text}`));

  return { decision, reasons };
}

export function judgeDividend(
  ranking: RankingResult,
  userPrice: number | null,
): DividendJudgement {
  const core = judgeCore(ranking, userPrice);
  return { ...core, recommendation: recommend(ranking, core) };
}
