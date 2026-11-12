// Design Ref: §2 ⑥, 권리분석기준.md — 말소기준권리 찾기 → 인수/소멸 구분 → 예상 배분순위 → 위임기관 조세채권보다 앞선 채권(선순위) 찾기.
// 모두 고정 규칙이라 같은 입력이면 항상 같은 결과가 나온다. (AI를 부르지 않는다)
// 판정(높음/보통/낮음)과 공매 착수·반려 의견은 judgeDividend.ts에서 이 결과를 받아 만든다.
//
// 용어
//  - 말소기준권리: 압류·가압류·근저당·담보가등기·경매개시결정(+배분요구한 최선순위 전세권) 중 접수일자가 가장 빠른 것
//  - 기준 권리(위임기관 조세채권): "압류(조세)" 중 접수일자가 가장 빠른 것 (조세채권 간 압류선착주의)
//  - 선순위: 배분 순서에서 기준 권리보다 앞서는 채권 / 후순위: 뒤인 채권

import type { AiExtraction } from "../aiSchema";
import type {
  Disposition,
  Position,
  RankedRight,
  RankingResult,
  RightStatus,
} from "../types";
import {
  normalizeRights,
  type DocumentText,
  type MergedRight,
} from "./normalizeRights";

const NOT_REFLECTED = [
  "강제징수비(1순위), 임금채권(2·6순위), 소액임차인 최우선변제(2순위)는 금액을 알 수 없어 순위 계산에 반영하지 않았습니다. 이들이 있으면 조세 배분가능성은 더 낮아질 수 있습니다.",
  "2023.4.1. 국세기본법령 개정(확정임차인의 당해세 우선원칙 예외, 임대인 변경 시 국세 우선 한도), 상가 환산보증금·소액임차인 보증금표 판정은 반영하지 않았습니다.",
  "금액 안분·순환흡수 등 실제 배분금액 계산은 하지 않았습니다. 순위와 기준 권리보다 앞선 채권의 합계까지만 계산합니다.",
];

// 당해세: 공매대상 부동산 자체에 부과된 국세·지방세 (권리분석기준.md §4.2)
const DANGHAESE_KEYWORDS = [
  "상속세",
  "증여세",
  "종합부동산세",
  "종부세",
  "재산세",
  "자동차세",
  "지역자원시설세",
  "지방교육세",
];

type Category =
  | "tax" // 압류(조세)
  | "dues" // 압류(공과금)
  | "general" // 가압류, 압류(기타) → 9순위 일반채권
  | "secured" // 근저당, 담보가등기
  | "jeonse" // 전세권
  | "tenant" // 임차권, 임차권등기명령
  | "auction" // 경매개시결정
  | "burden" // 소유권이전가등기, 가처분, 환매등기, 지상권, 지역권, 예고등기
  | "other";

function categoryOf(type: MergedRight["type"]): Category {
  switch (type) {
    case "압류(조세)":
      return "tax";
    case "압류(공과금)":
      return "dues";
    case "가압류":
    case "압류(기타)":
      return "general";
    case "근저당":
    case "담보가등기":
      return "secured";
    case "전세권":
      return "jeonse";
    case "임차권":
    case "임차권등기명령":
      return "tenant";
    case "경매개시결정":
      return "auction";
    case "소유권이전가등기":
    case "가처분":
    case "환매등기":
    case "지상권":
    case "지역권":
    case "예고등기":
      return "burden";
    default:
      return "other";
  }
}

type Item = {
  merged: MergedRight;
  id: string;
  cat: Category;
  /** 접수 일자가 정확히 하나일 때만 값이 있다 */
  date: string | null;
  number: number | null;
};

function toNumber(receiptNo: string | null): number | null {
  if (!receiptNo) return null;
  const value = Number(receiptNo);
  return Number.isSafeInteger(value) ? value : null;
}

/** YYYY-MM-DD에 일 수를 더한다 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * 두 항목의 앞뒤를 비교한다. 정할 수 없으면 0을 돌려준다.
 *  -1: a가 앞, 1: a가 뒤, 0: 정할 수 없음 (같은 날인데 접수번호를 비교할 수 없음 등)
 */
function compareKey(
  a: { date: string; number: number | null },
  b: { date: string; number: number | null },
): -1 | 0 | 1 {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  if (a.number === null || b.number === null || a.number === b.number) return 0;
  return a.number < b.number ? -1 : 1;
}

const labelOf = (m: MergedRight) => [m.type, m.holder].filter(Boolean).join(" ");
const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;

function isDanghaese(taxKind: string | null): boolean {
  return taxKind !== null && DANGHAESE_KEYWORDS.some((word) => taxKind.includes(word));
}

/** 임차인의 배분 기준일: 확정일자가 전입일자보다 빠르면 전입일 다음날, 아니면 확정일자 (권리분석기준.md §5) */
function tenantPriorityDate(m: MergedRight, receiptDate: string | null): string | null {
  if (m.fixedDate) {
    return m.moveInDate && m.moveInDate >= m.fixedDate ? addDays(m.moveInDate, 1) : m.fixedDate;
  }
  if (m.moveInDate) return addDays(m.moveInDate, 1); // 확정일자 없음: 대항력 기준일만
  return receiptDate; // 임차권등기명령 등 등기된 경우
}

export function rankRights(
  normalized: ReturnType<typeof normalizeRights>,
  allItemsFailedVerification: boolean,
): RankingResult {
  const cancelledMerged = normalized.merged.filter((m) => m.cancelled === "말소");
  // 등기도 안 되었고 전입일자·확정일자도 없는 임차인은 계산에서 뺀다(안내만)
  const tenantMerged = normalized.merged.filter(
    (m) =>
      m.cancelled !== "말소" &&
      categoryOf(m.type) === "tenant" &&
      m.registered === "미등기" &&
      !m.moveInDate &&
      !m.fixedDate,
  );
  const active = normalized.merged.filter(
    (m) => !cancelledMerged.includes(m) && !tenantMerged.includes(m),
  );

  // AI가 항목을 어떤 순서로 돌려주든 같은 결과가 나오도록, 먼저 고정된 기준으로 줄을 세운다
  const stable = (m: MergedRight) =>
    [
      m.dateCandidates[0] ?? "9999-99-99",
      (toNumber(m.receiptNo) ?? Number.MAX_SAFE_INTEGER).toString().padStart(16, "0"),
      m.type,
      m.holder ?? "",
      String(m.amount ?? ""),
      m.sources[0]?.document ?? "",
      String(m.sources[0]?.page ?? ""),
    ].join("|");
  active.sort((a, b) => (stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0));

  const items: Item[] = active.map((merged, index) => ({
    merged,
    id: `r${index + 1}`,
    cat: categoryOf(merged.type),
    date: merged.dateCandidates.length === 1 ? merged.dateCandidates[0] : null,
    number: toNumber(merged.receiptNo),
  }));

  const globalHold: string[] = [];
  const assumptions: string[] = [];
  const key = (item: Item) => ({ date: item.date as string, number: item.number });

  // ───── 1단계: 말소기준권리 찾기 ─────
  const candidates = items.filter(
    (item) =>
      item.cat === "tax" ||
      item.cat === "dues" ||
      item.cat === "general" ||
      item.cat === "secured" ||
      item.cat === "auction" ||
      (item.cat === "jeonse" && item.merged.distributionDemand === true),
  );
  // 문서끼리 접수 일자가 다른 항목은 가장 빠른 날짜로 말소기준권리 후보를 비교한다(상태에는 "사람 확인 필요"로 표시됨)
  const mKey = (item: Item) => ({
    date: item.merged.dateCandidates[0] as string,
    number: item.number,
  });
  const datedCandidates = candidates.filter((item) => item.merged.dateCandidates.length > 0);
  let malso: Item | null = null;

  if (candidates.length === 0) {
    globalHold.push(
      "말소기준권리가 될 수 있는 권리(압류·가압류·근저당·담보가등기·경매개시결정)를 자료에서 찾지 못했습니다.",
    );
  } else if (datedCandidates.length === 0) {
    globalHold.push("말소기준권리 후보의 접수 일자를 알 수 없어 말소기준권리를 정할 수 없습니다.");
  } else {
    const sorted = [...datedCandidates].sort((a, b) => compareKey(mKey(a), mKey(b)));
    const top = sorted[0];
    const second = sorted[1];
    const tie =
      second !== undefined &&
      mKey(top).date === mKey(second).date &&
      compareKey(mKey(top), mKey(second)) === 0;
    if (tie) {
      globalHold.push(
        "같은 날 접수된 말소기준권리 후보의 접수번호를 비교할 수 없어 말소기준권리를 정할 수 없습니다.",
      );
    } else {
      malso = top;
      if (candidates.length > datedCandidates.length) {
        assumptions.push(
          "접수 일자를 알 수 없는 말소기준권리 후보가 있어, 날짜를 아는 것 중 가장 빠른 권리를 말소기준권리로 보았습니다.",
        );
      }
    }
  }
  if (
    items.some((item) => item.cat === "jeonse" && item.merged.distributionDemand !== true)
  ) {
    assumptions.push(
      "전세권은 배분요구가 확인되지 않아 말소기준권리 후보에서 뺐습니다. 최선순위 전세권이 배분요구를 하면 말소기준권리가 될 수 있습니다.",
    );
  }

  // ───── 기준 권리(위임기관 조세채권): "압류(조세)" 중 접수일자가 가장 빠른 것 ─────
  const taxItems = items.filter((item) => item.cat === "tax");
  const datedTax = taxItems.filter((item) => item.date !== null);
  let reference: Item | null = null;

  if (taxItems.length === 0) {
    globalHold.push("기준 권리(압류(조세))를 자료에서 찾지 못했습니다.");
  } else if (datedTax.length === 0) {
    globalHold.push("압류(조세)의 접수 일자를 알 수 없어 기준 권리를 정할 수 없습니다.");
  } else {
    const sorted = [...datedTax].sort((a, b) => compareKey(key(a), key(b)));
    const top = sorted[0];
    const second = sorted[1];
    const tie =
      second !== undefined && top.date === second.date && compareKey(key(top), key(second)) === 0;
    if (tie) {
      globalHold.push(
        "같은 날 접수된 압류(조세)의 접수번호를 비교할 수 없어 기준 권리를 정할 수 없습니다.",
      );
    } else {
      reference = top;
    }
  }

  // ───── 배분 순서 비교용 날짜 ─────
  // 조세·공과금: 법정기일(납부기한). 자료가 없으면 압류일자(접수일자)로 대신 비교한다.
  const lawKey = (item: Item): string | null => item.merged.lawDate ?? item.date;
  // 담보·임차인: 설정일자(접수일자) / 임차인은 우선변제 기준일
  const securedKey = (item: Item): string | null =>
    item.cat === "tenant"
      ? tenantPriorityDate(item.merged, item.date)
      : (item.date ?? item.merged.dateCandidates[0] ?? null); // 문서끼리 날짜가 다르면 가장 빠른 날짜
  const isSecuredLike = (item: Item) =>
    item.cat === "secured" || item.cat === "jeonse" || item.cat === "tenant";

  const refKey = reference ? lawKey(reference) : null;
  const refDang = reference ? isDanghaese(reference.merged.taxKind) : false;

  const usedFallback = items.some((item) => item.cat === "tax" && item.merged.lawDate === null);
  if (usedFallback) {
    assumptions.push(
      "법정기일 자료가 없어 압류일자(접수일자)로 대신 비교했습니다. 실제 법정기일은 압류일자와 같거나 더 빨라, 조세채권의 순위가 더 높아질 수 있습니다.",
    );
  }
  if (items.some((item) => item.cat === "tax" && item.merged.taxKind === null)) {
    assumptions.push(
      "세목 자료가 없어 조세 압류를 당해세로 보지 않았습니다. 재산세·종합부동산세 등 당해세이면 담보채권보다 앞서 배분됩니다.",
    );
  }
  if (items.some((item) => item.cat === "tax" && /상속세|증여세/.test(item.merged.taxKind ?? ""))) {
    assumptions.push("상속세·증여세는 당해세로 보려면 등기원인(상속·증여)이 일치하는지 확인해야 합니다.");
  }

  /** 이 조세·공과금보다 먼저 설정된 담보채권이 있는지 (있으면 7순위·8순위, 없으면 4순위) */
  const hasEarlierSecured = (item: Item): boolean => {
    const k = lawKey(item);
    if (k === null) return false;
    return items.some((other) => {
      if (!isSecuredLike(other)) return false;
      const sk = securedKey(other);
      return sk !== null && sk < k;
    });
  };

  // ───── 항목별 위치·상태 ─────
  const holdPerItem = new Map<string, string[]>();
  const positionOf = new Map<string, Position>();
  const dispositionOf = new Map<string, Disposition>();
  const tierOf = new Map<string, { tier: number | null; label: string | null }>();
  const proceedBlockers: string[] = [];
  const conditions: string[] = [];
  const burdens: string[] = [];

  items.forEach((item) => {
    const m = item.merged;
    const reasons: string[] = [];
    let position: Position = "미정";
    let tier: number | null = null;
    let tierLabel: string | null = null;

    // —— 말소기준권리 기준의 처분(인수/소멸)
    let disposition: Disposition;
    const isMalso = malso !== null && item.id === malso.id;
    const alwaysExtinguished =
      item.cat === "tax" ||
      item.cat === "dues" ||
      item.cat === "general" ||
      item.cat === "secured" ||
      item.cat === "auction";
    if (isMalso) {
      disposition = "말소기준권리";
    } else if (alwaysExtinguished) {
      disposition = "소멸"; // 압류·가압류·근저당·담보가등기는 말소기준권리 전·후 모두 말소
    } else if (item.cat === "other" || malso === null) {
      disposition = "확인 필요";
    } else if (item.cat === "tenant") {
      // 대항력: 전입일 다음날이 말소기준권리 접수일 이하이면 인수 (같은 날이면 임차인 우선)
      const basis = m.moveInDate ? addDays(m.moveInDate, 1) : item.date;
      const md = mKey(malso).date;
      if (basis === null) disposition = "확인 필요";
      else if (basis < md) disposition = "인수";
      else if (basis > md) disposition = "소멸";
      else disposition = m.moveInDate ? "인수" : "확인 필요";
    } else {
      // 전세권·가등기·가처분·환매·지상권·지역권·예고등기: 말소기준권리보다 앞서면 인수, 뒤이면 소멸
      if (item.date === null) disposition = "확인 필요";
      else {
        const c = compareKey(key(item), mKey(malso));
        disposition = c < 0 ? "인수" : c > 0 ? "소멸" : "확인 필요";
      }
    }

    // —— 배분 순서상의 위치와 배분순위
    switch (item.cat) {
      case "tax": {
        const dang = isDanghaese(m.taxKind);
        const k = lawKey(item);
        tier = k === null ? null : dang ? 3 : hasEarlierSecured(item) ? 7 : 4;
        tierLabel =
          tier === null
            ? null
            : tier === 3
              ? "3순위 당해세"
              : tier === 4
                ? "4순위 조세채권(담보보다 법정기일이 빠름)"
                : "7순위 조세채권(담보보다 법정기일이 늦음)";
        if (reference && item.id === reference.id) {
          position = "기준";
        } else if (!reference) {
          position = "미정";
        } else if (dang && !refDang) {
          position = "선순위"; // 당해세는 압류선착주의 없이 다른 조세채권보다 우선
        } else if (!dang && refDang) {
          position = "후순위";
        } else if (m.dateCandidates.length === 0) {
          position = "미정";
          reasons.push("접수 일자를 알 수 없어 기준 권리와의 앞뒤를 정할 수 없습니다.");
        } else {
          // 조세채권 상호간에는 법정기일과 관계없이 압류선착주의 (문서끼리 날짜가 다르면 날짜마다 비교)
          const sides = m.dateCandidates.map((date) =>
            compareKey({ date, number: item.number }, key(reference)),
          );
          if (sides.includes(0)) {
            position = "미정";
            reasons.push("기준 권리와 같은 날 압류되었는데 접수번호로 앞뒤를 비교할 수 없습니다.");
          } else if (new Set(sides).size > 1) {
            position = "미정";
            reasons.push("문서끼리 접수 일자가 달라 기준 권리와의 앞뒤가 바뀔 수 있습니다.");
          } else {
            position = sides[0] === -1 ? "선순위" : "후순위";
          }
        }
        break;
      }
      case "dues": {
        // 공과금은 가압류(일반채권)와 동순위(9순위)로 본다. 조세·담보채권보다 뒤이고, 가압류와는 채권액 비율로 나눈다.
        tier = 9;
        tierLabel = "9순위 공과금(가압류와 동순위)";
        position = reference ? "후순위" : "미정"; // 공과금은 언제나 조세채권에 우선할 수 없다
        break;
      }
      case "general": {
        tier = 9;
        tierLabel = "9순위 일반채권(공과금과 동순위)";
        position = reference ? "후순위" : "미정";
        break;
      }
      case "secured":
      case "jeonse":
      case "tenant": {
        tier = 5;
        tierLabel =
          item.cat === "tenant"
            ? m.fixedDate
              ? "5순위 확정일자 임차인"
              : "임차인(확정일자 없음, 대항력 기준일로 비교)"
            : "5순위 담보채권";
        // 비교할 날짜들: 임차인은 우선변제 기준일, 담보는 설정일자(문서끼리 다르면 모두)
        const dates =
          item.cat === "tenant"
            ? [securedKey(item)].filter((v): v is string => v !== null)
            : m.dateCandidates;
        if (!reference) {
          position = "미정";
        } else if (dates.length === 0 || refKey === null) {
          position = "미정";
          reasons.push(
            item.cat === "tenant"
              ? "임차인의 전입일자·확정일자·접수 일자를 알 수 없어 앞뒤를 정할 수 없습니다."
              : "접수 일자를 알 수 없어 기준 권리와의 앞뒤를 정할 수 없습니다.",
          );
        } else {
          // 법정기일 전에 설정된 담보채권은 조세채권에 우선, 같은 날이면 조세채권 우선
          const ahead = dates.map((d) => d < refKey);
          if (ahead.every(Boolean)) position = "선순위";
          else if (ahead.every((v) => !v)) position = "후순위";
          else {
            position = "미정";
            reasons.push("문서끼리 접수 일자가 달라 기준 권리와의 앞뒤가 바뀔 수 있습니다.");
          }
        }
        break;
      }
      default: {
        position = "해당 없음";
        break;
      }
    }

    // —— 인수되는 권리·반려/조건부 사유
    if (disposition === "인수") {
      if (item.cat === "burden") {
        if (m.type === "소유권이전가등기" || m.type === "가처분") {
          proceedBlockers.push(
            `${labelOf(m)}: 말소기준권리보다 앞서 설정되어 낙찰자가 인수하는 최선순위 ${m.type}입니다. 공매 불가 사유라 위임기관과 해제 협의가 필요합니다.`,
          );
        } else if (m.type === "예고등기") {
          proceedBlockers.push(
            `${labelOf(m)}: 소유권말소 예고등기가 있는 재산은 공매 불가 사유입니다. 위임기관과 협의가 필요합니다.`,
          );
        } else {
          burdens.push(`${labelOf(m)}: 말소기준권리보다 앞서 설정되어 낙찰자가 인수합니다.`);
        }
      } else if (item.cat === "jeonse") {
        burdens.push(
          `${labelOf(m)}${m.amount !== null ? ` ${won(m.amount)}` : ""}: 말소기준권리보다 앞서 설정되어 낙찰자가 인수할 수 있습니다. (배분요구 종기까지 배분요구하면 말소)`,
        );
      } else if (item.cat === "tenant") {
        burdens.push(
          `${labelOf(m)}${m.amount !== null ? ` 보증금 ${won(m.amount)}` : ""}: 대항력이 있어 낙찰자가 보증금을 인수할 수 있습니다. (배분요구하면 우선변제 후 부족분만 인수)`,
        );
      }
    }
    if (
      disposition === "소멸" &&
      item.cat === "burden" &&
      (m.type === "소유권이전가등기" || m.type === "가처분") &&
      item.date !== null &&
      reference &&
      reference.date !== null &&
      item.date < reference.date
    ) {
      conditions.push(
        `${labelOf(m)}: 말소기준권리보다 뒤이지만 위임기관 압류보다 앞서 설정되었습니다. 조건부 공매 진행이 가능하며, 본등기 이행 시 압류가 말소될 수 있어 매각조건 공고와 잔대금 납부 전 확인이 필요합니다.`,
      );
    }

    // —— 판정을 보류해야 하는 이유
    if (item.cat === "burden" && item.date === null) {
      reasons.push("접수 일자를 알 수 없어 인수 여부를 정할 수 없습니다.");
    }
    // 말소 여부를 알 수 없으면 계산에 넣을 수 없다. (후순위·해당 없음이 확실하면 선순위 계산과 무관하므로 제외)
    if (position !== "후순위" && position !== "해당 없음") {
      if (m.cancelled === "모름") reasons.push("말소 여부를 알 수 없습니다.");
    }
    if (item.cat === "tenant" && !m.moveInDate && !m.fixedDate && m.registered === "모름") {
      reasons.push("임차 항목의 등기 여부와 전입일자를 알 수 없습니다.");
    }

    positionOf.set(item.id, position);
    dispositionOf.set(item.id, disposition);
    tierOf.set(item.id, { tier, label: tierLabel });
    holdPerItem.set(item.id, reasons);
  });

  // 가압류 이후에 설정된 담보권이 있으면 순환배분 안내
  const provisional = items.filter((item) => item.merged.type === "가압류" && item.date !== null);
  const afterProvisional = items.filter(
    (item) =>
      (item.cat === "secured" || item.cat === "jeonse") &&
      item.date !== null &&
      provisional.some((p) => (p.date as string) < (item.date as string)),
  );
  if (afterProvisional.length > 0) {
    assumptions.push(
      `가압류보다 늦게 설정된 담보권(${afterProvisional.map((i) => labelOf(i.merged)).join(", ")})은 가압류와 평등관계가 되어 순환배분(안분 후 흡수) 계산이 필요합니다. 금액 배분은 계산하지 않았습니다.`,
    );
  }

  // ───── 순위 번호: 순서를 정할 수 없는 항목이 하나라도 있으면 붙이지 않는다 ─────
  const everyDated = items.every((item) => item.date !== null);
  let order: Item[] = [];
  let ranksAssigned = false;

  if (everyDated && items.length > 0) {
    const sorted = [...items].sort((a, b) => compareKey(key(a), key(b)));
    ranksAssigned = sorted.every(
      (item, i) => i === 0 || compareKey(key(sorted[i - 1]), key(item)) !== 0,
    );
    order = sorted;
  }
  if (!ranksAssigned) {
    // 날짜가 있는 항목을 앞에, 없는 항목을 뒤에 두고 같은 조건이면 처음 나온 순서를 지킨다
    order = [...items].sort((a, b) => {
      if (a.date === null && b.date === null) return 0;
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return compareKey(key(a), key(b));
    });
  }

  // ───── 화면에 쓸 모양으로 바꾸기 ─────
  const toRanked = (item: Item, rank: number | null): RankedRight => {
    const m = item.merged;
    const reasons = holdPerItem.get(item.id) ?? [];
    const statusReasons: string[] = [];
    const missingFields: string[] = [];
    const position = positionOf.get(item.id) ?? "미정";
    const disposition = dispositionOf.get(item.id) ?? "확인 필요";
    const tier = tierOf.get(item.id) ?? { tier: null, label: null };

    // 등기되지 않은 임차인은 접수일자가 없는 것이 정상이다 (전입일자·확정일자로 비교)
    const tenantByDates = item.cat === "tenant" && (m.moveInDate !== null || m.fixedDate !== null);
    if (m.dateCandidates.length === 0 && !tenantByDates) missingFields.push("접수일자");
    // 금액은 선순위 합계에만 쓰이므로, 기준 권리·후순위·해당 없음의 빈 금액은 "확인 불가"로 보지 않는다
    const amountMatters = position === "선순위" || position === "미정";
    if (m.amount === null && !m.amountConflict && amountMatters) {
      missingFields.push("금액");
    }
    // 조세는 법정기일이 없으면 압류일자로 대신 비교하므로 알려 준다.
    // 공과금은 가압류와 동순위(9순위)로 보아 납부기한을 비교에 쓰지 않으므로 "확인 불가"로 보지 않는다.
    if (item.cat === "tax" && m.lawDate === null) {
      missingFields.push("법정기일");
    }

    if (m.dateCandidates.length > 1) {
      statusReasons.push(`문서끼리 접수 일자가 다릅니다 (${m.dateCandidates.join(" / ")}).`);
    }
    if (m.amountConflict) statusReasons.push("문서끼리 금액이 달라 금액 없음으로 봅니다.");
    statusReasons.push(...reasons);
    if (m.cancelled === "모름" && !statusReasons.includes("말소 여부를 알 수 없습니다.")) {
      statusReasons.push("말소 여부를 알 수 없습니다.");
    }
    if (disposition === "확인 필요" && item.cat !== "other" && malso !== null) {
      statusReasons.push("말소기준권리를 기준으로 한 인수/소멸 여부를 정할 수 없습니다.");
    }
    if (item.cat === "other") {
      statusReasons.push("권리 종류를 분류하지 못해 인수/소멸과 배분순위를 정할 수 없습니다.");
    }

    const needsHuman = statusReasons.length > 0;
    const status: RightStatus = needsHuman
      ? "사람 확인 필요"
      : missingFields.length > 0
        ? "확인 불가"
        : "정상";

    return {
      id: item.id,
      type: m.type,
      holder: m.holder,
      receiptDate: item.date,
      receiptNo: m.receiptNo,
      amount: m.amount,
      registered: m.registered,
      note: m.note,
      sources: m.sources,
      status,
      statusReasons,
      missingFields,
      position,
      disposition,
      tier: tier.tier,
      tierLabel: tier.label,
      lawDate: item.cat === "tax" ? m.lawDate : null,
      taxKind: item.cat === "tax" ? m.taxKind : null,
      rank,
      blocksJudgement: reasons.length > 0,
    };
  };

  const rights = order.map((item, index) =>
    toRanked(item, ranksAssigned ? index + 1 : null),
  );

  // 말소·미등기 항목은 계산에서 빼지만 화면에는 안내한다
  const asExcluded = (m: MergedRight, id: string, note: string): RankedRight => ({
    id,
    type: m.type,
    holder: m.holder,
    receiptDate: m.dateCandidates.length === 1 ? m.dateCandidates[0] : null,
    receiptNo: m.receiptNo,
    amount: m.amount,
    registered: m.registered,
    note: m.note,
    sources: m.sources,
    status: categoryOf(m.type) === "tenant" && m.registered === "미등기" ? "사람 확인 필요" : "정상",
    statusReasons: [note],
    missingFields: [],
    position: "해당 없음",
    disposition: m.cancelled === "말소" ? "소멸" : "확인 필요",
    tier: null,
    tierLabel: null,
    rank: null,
    blocksJudgement: false,
  });

  const cancelled = cancelledMerged.map((m, i) =>
    asExcluded(m, `c${i + 1}`, "말소된 권리라 순위·판정 계산에서 뺐습니다."),
  );
  const unregisteredTenants = tenantMerged.map((m, i) =>
    asExcluded(
      m,
      `t${i + 1}`,
      "등기도 되어 있지 않고 전입일자·확정일자도 없는 임차인이라 반영하지 않았습니다.",
    ),
  );

  const referenceRanked = reference ? (rights.find((r) => r.id === reference.id) ?? null) : null;
  const malsoRanked = malso ? (rights.find((r) => r.id === malso.id) ?? null) : null;

  const holdReasons = [
    ...globalHold,
    ...rights
      .filter((r) => r.blocksJudgement)
      .flatMap((r) => {
        const merged = items.find((item) => item.id === r.id)?.merged;
        const name = merged ? labelOf(merged) : r.type;
        return (holdPerItem.get(r.id) ?? []).map((reason) => `${name}: ${reason}`);
      }),
  ];

  return {
    rights,
    cancelled,
    unregisteredTenants,
    excluded: normalized.excluded,
    conflicts: normalized.conflicts,
    reference: referenceRanked,
    malsoStandard: malsoRanked,
    proceedBlockers: [...new Set(proceedBlockers)].sort(),
    conditions: [...new Set(conditions)].sort(),
    burdens: [...new Set(burdens)].sort(),
    assumptions,
    holdReasons,
    allItemsFailedVerification,
    ranksAssigned,
    unappliedRules: NOT_REFLECTED,
    priceCandidates: normalized.priceCandidates,
  };
}

/** AI가 읽어 낸 항목을 정리하고 순위를 매긴다 (작업 6의 입구) */
export function buildRanking(
  extraction: AiExtraction,
  documents: DocumentText[],
): RankingResult {
  const normalized = normalizeRights(extraction, documents);
  const allItemsFailedVerification =
    normalized.aiFoundItems &&
    normalized.merged.length === 0 &&
    normalized.excluded.length > 0;
  return rankRights(normalized, allItemsFailedVerification);
}
