// Design Ref: §1 ⑤ 쉬운 설명 — 판정 이유를 쉬운 말로 풀어 쓴다.
// AI가 아니라 정해진 문장 틀로 만들어, 같은 결과에는 항상 같은 설명이 나온다. (PRD §3 편차 목표)
// 화면과 서버가 함께 쓰는 공용 파일이다.

import type { DividendJudgement, RankingResult } from "@/lib/types";

/** 판정 이유를 쉬운 말 한두 문장으로 설명한다. */
export function explainJudgement(
  judgement: DividendJudgement,
  ranking: RankingResult,
): string[] {
  const lines: string[] = [];

  switch (judgement.result) {
    case "판정 안 함":
      lines.push(judgement.noJudgementReason ?? "판정할 수 있는 자료가 없습니다.");
      return lines;

    case "판정 보류":
      lines.push(
        "순위를 정할 수 없는 항목이 있어, 지금은 배당 가능성을 판단하지 않고 보류합니다. 아래 보류 이유의 항목을 사람이 확인한 뒤 다시 분석해 주세요.",
      );
      return lines;

    default:
      break;
  }

  const ref = ranking.reference;
  const refText = ref
    ? `기준 권리(${[ref.type, ref.holder, ref.receiptDate].filter(Boolean).join(" · ")})`
    : "기준 권리";
  const count = judgement.seniorCount;

  if (judgement.method === "금액 기준") {
    const ratio = judgement.ratioText ?? "";
    if (judgement.result === "높음") {
      lines.push(
        `${refText}보다 배분 순서가 앞선 선순위 채권의 금액 합계가 예상 매각가의 ${ratio}로 절반(50%)에 못 미칩니다. 앞선 채권을 먼저 갚고도 남는 몫이 큰 편이라 배당받을 가능성이 '높음'입니다.`,
      );
    } else if (judgement.result === "보통") {
      lines.push(
        `선순위 권리의 금액 합계가 예상 매각가의 ${ratio}로, 절반(50%) 이상 80% 이하입니다. 앞선 권리가 매각 대금의 상당 부분을 차지하므로 배당받을 가능성이 '보통'입니다.`,
      );
    } else {
      lines.push(
        `선순위 권리의 금액 합계가 예상 매각가의 ${ratio}로 80%를 넘습니다. 앞선 권리를 먼저 갚으면 남는 몫이 적어 배당받을 가능성이 '낮음'입니다.`,
      );
    }
  } else {
    if (judgement.result === "높음") {
      lines.push(
        `${refText}보다 배분 순서가 앞선 선순위 채권이 ${count}건(0~1건)으로 적어, 배당받을 가능성이 '높음'입니다.`,
      );
    } else if (judgement.result === "보통") {
      lines.push(
        `선순위 권리가 ${count}건(2~3건)입니다. 앞선 권리가 어느 정도 있어 배당받을 가능성이 '보통'입니다.`,
      );
    } else {
      lines.push(
        `선순위 권리가 ${count}건(4건 이상)으로 많아, 배당받을 가능성이 '낮음'입니다.`,
      );
    }
    lines.push("금액이 아니라 선순위 권리의 개수만으로 판단한 결과라 금액 기준보다 거친 판단입니다.");
  }

  if (judgement.boundaryNote) lines.push(judgement.boundaryNote);
  return lines;
}
