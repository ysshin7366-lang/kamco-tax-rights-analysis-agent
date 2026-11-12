// Design Ref: §2 ④⑤ — AI가 읽어 낸 항목을 검증·정리하고, 같은 권리를 묶어 문서끼리 어긋난 값을 찾는다.
//   ④ 원문 확인(띄어쓰기·줄바꿈 무시), 출처 확인, 날짜·금액 형식 정리, 말소·미등기 분리
//   ⑤ 같은 권리 묶기(접수번호 우선) → 불일치 점검 → 모든 칸이 같은 것만 하나로 합치기
// 순서·분류는 이 파일이 아니라 rankRights.ts에서 정한다. 이 파일은 AI 호출 없이 같은 입력이면 항상 같은 결과를 낸다.
// (일부러 외부 패키지·경로 별칭을 쓰지 않아 단독으로 시험할 수 있다)

import type { AiExtraction, AiPriceCandidate, AiRight } from "../aiSchema";
import type {
  Conflict,
  ExcludedItem,
  RightType,
  SourceRef,
  VerifiedPriceCandidate,
} from "../types";

/** 읽어 낸 문서 한 개 (extractText.ts의 ExtractedDocument와 같은 모양) */
export type DocumentText = {
  name: string;
  kind: "txt" | "pdf" | "hwpx" | "xlsx";
  text: string;
  pages: number | null;
};

/** 정리를 마친 권리 한 건(문서끼리 묶은 뒤) */
export type MergedRight = {
  type: RightType;
  holder: string | null;
  /** 문서에서 확인된 서로 다른 접수 일자 후보(0개=없음, 2개 이상=문서끼리 다름) */
  dateCandidates: string[];
  receiptNo: string | null;
  amount: number | null;
  amountConflict: boolean;
  cancelled: "말소" | "유효" | "모름";
  registered: "등기" | "미등기" | "모름";
  /** 조세 압류의 법정기일·공과금의 납부기한 (자료에 적혀 있을 때만) */
  lawDate: string | null;
  /** 조세·공과금의 세목 (예: 재산세) */
  taxKind: string | null;
  /** 임차인의 전입일자·확정일자 */
  moveInDate: string | null;
  fixedDate: string | null;
  /** 전세권자의 배분요구 여부 (모르면 null) */
  distributionDemand: boolean | null;
  note: string;
  sources: SourceRef[];
};

export type NormalizedRights = {
  merged: MergedRight[];
  excluded: ExcludedItem[];
  conflicts: Conflict[];
  priceCandidates: VerifiedPriceCandidate[];
  /** AI가 항목을 하나 이상 찾았는지 */
  aiFoundItems: boolean;
};

// ───────── 원문 확인 ─────────

const squash = (text: string) => text.replace(/\s+/g, "");

type PageSegment = { page: number; squashed: string };

function splitPages(text: string): PageSegment[] {
  const segments: PageSegment[] = [];
  const parts = text.split(/\[p\.(\d+)\]/);
  // parts: [앞부분, "1", 1쪽 글자, "2", 2쪽 글자, ...]
  for (let i = 1; i < parts.length; i += 2) {
    segments.push({ page: Number(parts[i]), squashed: squash(parts[i + 1] ?? "") });
  }
  return segments;
}

type Located = { ok: true; page: number | null } | { ok: false };

/** AI가 돌려준 원문 문장이 실제 글자 안에 있는지 확인하고, PDF면 코드가 쪽 번호를 직접 정한다. */
function locateQuote(doc: DocumentText, quote: string): Located {
  const q = squash(quote);
  if (q.length === 0) return { ok: false };

  // 쪽 번호가 있는 것은 PDF뿐이다. .txt·.hwpx·.xlsx는 글자 전체에서 찾고 쪽은 null
  if (doc.kind !== "pdf") {
    return squash(doc.text).includes(q) ? { ok: true, page: null } : { ok: false };
  }

  const segments = splitPages(doc.text);
  const hit = segments.find((segment) => segment.squashed.includes(q));
  if (hit) return { ok: true, page: hit.page };

  // 쪽 경계에 걸친 문장: 이어 붙인 글자 안에 있으면 시작 쪽을 쓴다
  const joined = segments.map((segment) => segment.squashed).join("");
  if (joined.includes(q)) {
    const head = q.slice(0, Math.min(12, q.length));
    const start = segments.find((segment) => segment.squashed.includes(head));
    return { ok: true, page: start ? start.page : null };
  }
  return { ok: false };
}

// ───────── 값 정리 ─────────

function cleanDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const valid =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d;
  return valid ? value : null;
}

function cleanAmount(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function cleanReceiptNo(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits === "" ? null : digits;
}

function cleanText(value: string | null): string | null {
  const text = value?.trim();
  return text ? text : null;
}

type CleanItem = {
  type: RightType;
  holder: string | null;
  date: string | null;
  receiptNo: string | null;
  amount: number | null;
  cancelled: "말소" | "유효" | "모름";
  registered: "등기" | "미등기" | "모름";
  lawDate: string | null;
  taxKind: string | null;
  moveInDate: string | null;
  fixedDate: string | null;
  distributionDemand: boolean | null;
  note: string;
  source: SourceRef;
};

function describe(right: AiRight): string {
  return [right.type, right.holder].filter(Boolean).join(" ");
}

// ───────── 같은 권리 묶기 ─────────

/** 접수번호가 있으면 "종류+접수번호", 없고 접수일이 있으면 "종류+접수일(+권리자)". 둘 다 없으면 묶지 않는다. */
function groupKey(item: CleanItem, index: number): string {
  if (item.receiptNo) return `${item.type}|번호|${item.receiptNo}`;
  if (item.date) return `${item.type}|일자|${item.date}|${item.holder ?? ""}`;
  return `${item.type}|단독|${index}`;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function label(item: { type: RightType; holder: string | null }): string {
  return [item.type, item.holder].filter(Boolean).join(" ");
}

// ───────── 메인 ─────────

export function normalizeRights(
  extraction: AiExtraction,
  documents: DocumentText[],
): NormalizedRights {
  const docByName = new Map(documents.map((doc) => [doc.name, doc]));
  const excluded: ExcludedItem[] = [];
  const clean: CleanItem[] = [];

  // ④ 검증: 출처 문서가 올린 문서와 맞고, 원문 문장이 실제 글자 안에 있어야 한다
  extraction.rights.forEach((right) => {
    // 안전장치: 원문과 설명 어디에도 "가등기"가 없는데 소유권이전가등기로 분류된 항목은
    // 소유자가 바뀐 본등기(소유권 이전)를 잘못 읽은 것이라 권리로 보지 않는다. (공매 반려 사유로 오해하지 않도록)
    if (right.type === "소유권이전가등기" && !/가\s*등기/.test(`${right.quote} ${right.note}`)) {
      excluded.push({
        description: describe(right),
        reason: "소유권 이전(본등기)으로 보여 권리분석 대상에서 뺐습니다. (가등기가 아님)",
      });
      return;
    }
    const doc = docByName.get(right.source.document);
    if (!doc) {
      excluded.push({
        description: describe(right),
        reason: "출처(문서명)가 없거나 올린 문서와 맞지 않아 뺐습니다.",
      });
      return;
    }
    const located = locateQuote(doc, right.quote);
    if (!located.ok) {
      excluded.push({
        description: describe(right),
        reason: "근거 문장을 올린 자료에서 확인하지 못해 뺐습니다.",
      });
      return;
    }
    clean.push({
      type: right.type,
      holder: cleanText(right.holder),
      date: cleanDate(right.receiptDate),
      receiptNo: cleanReceiptNo(right.receiptNo),
      amount: cleanAmount(right.amount),
      cancelled: right.cancelled,
      // 임차 항목이 아니면 등기 여부는 의미가 없어 "등기"로 고정한다
      registered:
        right.type === "임차권" || right.type === "임차권등기명령" ? right.registered : "등기",
      lawDate: cleanDate(right.lawDate),
      taxKind: cleanText(right.taxKind),
      moveInDate: cleanDate(right.moveInDate),
      fixedDate: cleanDate(right.fixedDate),
      distributionDemand: right.distributionDemand,
      note: right.note.trim(),
      source: { document: doc.name, page: located.page, quote: right.quote.trim() },
    });
  });

  // 매각가 후보도 같은 방식으로 확인한다
  const priceCandidates: VerifiedPriceCandidate[] = [];
  extraction.priceCandidates.forEach((candidate: AiPriceCandidate) => {
    const doc = docByName.get(candidate.source.document);
    const amount = cleanAmount(candidate.amount);
    if (!doc || amount === null) return;
    const located = locateQuote(doc, candidate.quote);
    if (!located.ok) return;
    priceCandidates.push({
      kind: candidate.kind,
      amount,
      source: { document: doc.name, page: located.page, quote: candidate.quote.trim() },
    });
  });

  // ⑤ 같은 권리 묶기
  const groups = new Map<string, CleanItem[]>();
  clean.forEach((item, index) => {
    const key = groupKey(item, index);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  });

  const merged: MergedRight[] = [];
  const conflicts: Conflict[] = [];

  groups.forEach((items) => {
    const first = items[0];
    const name = label(first);

    // 접수 일자: 문서끼리 서로 다른 값이 있으면 불일치
    const dateCandidates = uniq(
      items.map((item) => item.date).filter((v): v is string => v !== null),
    ).sort();
    if (dateCandidates.length > 1) {
      conflicts.push({
        right: name,
        field: "접수일자",
        values: items
          .filter((item) => item.date !== null)
          .map((item) => ({
            value: item.date as string,
            document: item.source.document,
            page: item.source.page,
          })),
      });
    }

    // 금액: 서로 다르면 불일치. 이 경우 금액 없음으로 본다
    const amounts = uniq(
      items.map((item) => item.amount).filter((v): v is number => v !== null),
    );
    const amountConflict = amounts.length > 1;
    if (amountConflict) {
      conflicts.push({
        right: name,
        field: "금액",
        values: items
          .filter((item) => item.amount !== null)
          .map((item) => ({
            value: `${(item.amount as number).toLocaleString("ko-KR")}원`,
            document: item.source.document,
            page: item.source.page,
          })),
      });
    }

    // 말소·등기 여부: 문서마다 다르면 "모름"으로 본다
    const cancelledSet = uniq(items.map((item) => item.cancelled));
    const registeredSet = uniq(items.map((item) => item.registered));

    // 모든 칸이 같은 항목만 하나로 합친다 (출처는 모두 남긴다)
    const sources: SourceRef[] = [];
    items.forEach((item) => {
      const dup = sources.some(
        (s) => s.document === item.source.document && s.page === item.source.page && s.quote === item.source.quote,
      );
      if (!dup) sources.push(item.source);
    });
    // 출처도 항상 같은 순서로 (문서명 → 쪽 → 문장)
    sources.sort((a, b) =>
      a.document !== b.document
        ? a.document < b.document ? -1 : 1
        : (a.page ?? 0) !== (b.page ?? 0)
          ? (a.page ?? 0) - (b.page ?? 0)
          : a.quote < b.quote ? -1 : a.quote > b.quote ? 1 : 0,
    );

    merged.push({
      type: first.type,
      holder: items.map((item) => item.holder).find((v) => v !== null) ?? null,
      dateCandidates,
      receiptNo: items.map((item) => item.receiptNo).find((v) => v !== null) ?? null,
      amount: amountConflict ? null : (amounts[0] ?? null),
      amountConflict,
      cancelled: cancelledSet.length === 1 ? cancelledSet[0] : "모름",
      registered: registeredSet.length === 1 ? registeredSet[0] : "모름",
      lawDate: items.map((item) => item.lawDate).find((v) => v !== null) ?? null,
      taxKind: items.map((item) => item.taxKind).find((v) => v !== null) ?? null,
      moveInDate: items.map((item) => item.moveInDate).find((v) => v !== null) ?? null,
      fixedDate: items.map((item) => item.fixedDate).find((v) => v !== null) ?? null,
      distributionDemand:
        items.map((item) => item.distributionDemand).find((v) => v !== null) ?? null,
      note: first.note,
      sources,
    });
  });

  // 안내 목록도 AI가 준 순서와 상관없이 항상 같은 순서로
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  excluded.sort((a, b) => byText(a.description + a.reason, b.description + b.reason));
  conflicts.sort((a, b) => byText(a.right + a.field, b.right + b.field));
  conflicts.forEach((conflict) =>
    conflict.values.sort((a, b) => byText(a.document + a.value, b.document + b.value)),
  );
  priceCandidates.sort((a, b) =>
    byText(
      `${a.kind}|${String(a.amount).padStart(16, "0")}|${a.source.document}`,
      `${b.kind}|${String(b.amount).padStart(16, "0")}|${b.source.document}`,
    ),
  );

  return {
    merged,
    excluded,
    conflicts,
    priceCandidates,
    aiFoundItems: extraction.rights.length > 0,
  };
}
