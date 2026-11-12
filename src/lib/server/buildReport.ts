// 대시보드의 분석 결과를 한글(.hwpx) 보고서로 만든다. (서버 전용, AI를 부르지 않는 고정 규칙)
// 양식 폴더의 배분계산서·배분계산내역표 양식의 빈칸에 결과(권리 순위·배분순위·판정)를 채운다.
//  - 예상 매각가를 입력했고 모든 채권액을 알면: 배분 계산(distribution.ts)으로 배분금액까지 채운다.
//  - 그렇지 않으면: 배분순위 순서대로 권리만 나열하고 배분금액은 "-"로 둔다.
// 결과는 항상 "참고용, 담당자 최종 확인 필요"이다.

import { strToU8, zipSync, type Zippable } from "fflate";
import { distribute, type Creditor, type CreditorKind } from "@/lib/server/distribution";
import { fillRow, finishForm, openForm, setRowHeight } from "@/lib/server/fillForm";
import type { DividendJudgement, RankedRight, RankingResult } from "@/lib/types";

export type ReportCase = {
  key: string;
  label: string;
  owner: string;
  ranking: RankingResult;
  judgement: DividendJudgement;
  /** 이 사건의 예상 매각금액(원). 입력하지 않았으면 null */
  price: number | null;
  /** 자료에는 없지만 사람이 알려 준 당해세 등 추가 채권 (보고서에만 반영한다) */
  extras?: ExtraTax[];
};

/** 사람이 직접 알려 주는 추가 당해세 채권 (예: 대전시청 재산세 2,000,000원) */
export type ExtraTax = { holder: string; taxKind: string; amount: number; /** 법정기일 (YYYY-MM-DD, 모르면 비움) */ lawDate?: string | null };

/** 사건마다 같은 강제징수비(1순위)로 계산한다 */
export const ENFORCEMENT_COST = 10_000_000;

const won = (n: number) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
const dot = (d: string | null | undefined) => (d ? d.replace(/-/g, ".") : "");
const todayText = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // 한국 시간
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
};

type Line = {
  rank: number | string;
  name: string;
  /** 권리 종류 (예: 근저당, 압류(조세)) */
  label: string;
  claim: number | null;
  date: string | null;
  /** 배분금액 (계산하지 않았으면 null) */
  paid: number | null;
  remark: string;
  right: RankedRight;
};

function kindOf(r: RankedRight): CreditorKind | null {
  switch (r.type) {
    case "근저당":
    case "전세권":
    case "담보가등기":
    case "임차권":
    case "임차권등기명령":
      return "담보";
    case "압류(조세)":
      return r.tier === 3 ? "당해세" : "조세";
    case "압류(공과금)":
      return "공과금";
    case "가압류":
    case "압류(기타)":
      return "일반";
    default:
      return null; // 가처분·가등기 등 금액을 배분받지 않는 권리
  }
}

/** 표에 적을 권리 이름: 당해세는 세목까지 적는다 */
const labelFor = (r: RankedRight) => (r.tier === 3 ? `당해세(${r.taxKind ?? "조세"})` : r.type);

/** 배분 대상 권리를 배분순위 순서로 늘어놓고, 가능하면 배분금액도 계산한다 */
function arrange(c: ReportCase, price: number | null) {
  // 추가 당해세는 3순위로, 날짜와 관계없이 다른 채권보다 먼저 배분한다 (압류선착주의·법정기일 비교 없음)
  const extraRights: RankedRight[] = (c.extras ?? []).map((e, i) => ({
    id: `extra${i + 1}`, type: "압류(조세)", holder: e.holder, receiptDate: null, receiptNo: null, amount: e.amount, registered: "등기",
    note: "사람이 추가한 당해세", sources: [], status: "정상", statusReasons: [], missingFields: [], position: "선순위", disposition: "소멸",
    tier: 3, tierLabel: "3순위 당해세", lawDate: e.lawDate ?? null, taxKind: e.taxKind, rank: null, blocksJudgement: false,
  }));
  const targets = [...extraRights, ...c.ranking.rights].filter((r) => kindOf(r) !== null);
  const byTier = [...targets].sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99) || (a.rank ?? 999) - (b.rank ?? 999));
  const name = (r: RankedRight) => r.holder ?? "(권리자 불명)";

  const allKnown = targets.length > 0 && targets.every((r) => r.amount !== null && (r.receiptDate !== null || r.tier === 3));
  if (price !== null && allKnown) {
    const creditors: Creditor[] = targets.map((r) => ({
      id: r.id,
      name: name(r),
      kind: kindOf(r) as CreditorKind,
      label: r.type,
      amount: r.amount as number,
      baseDate: r.receiptDate,
      lawDate: r.lawDate ?? null,
      settledAmount: r.type === "근저당" ? r.amount : null,
    }));
    const result = distribute({ fund: price, cost: ENFORCEMENT_COST, creditors, generalLast: true });
    const lines: Line[] = result.allocations.map((a) => {
      const right = targets.find((r) => r.id === a.creditor.id) as RankedRight;
      const remark = [a.group === "동순위" ? "동순위(안분)" : "", a.amount === 0 ? "배분 없음" : a.shortfall > 0 ? "일부 배분" : ""].filter(Boolean).join(", ");
      return { rank: a.rank, name: a.creditor.name, label: labelFor(right), claim: a.creditor.amount, date: right.receiptDate, paid: a.amount, remark, right };
    });
    return { lines, computed: true as const, surplus: result.surplus, costPaid: result.costPaid };
  }

  let rank = 1;
  const lines: Line[] = byTier.map((r, i) => {
    if (i > 0 && (byTier[i - 1].tier ?? 99) !== (r.tier ?? 99)) rank++;
    return { rank: rank + 1, name: name(r), label: labelFor(r), claim: r.amount, date: r.receiptDate, paid: null, remark: r.tierLabel ?? "", right: r };
  });
  return { lines, computed: false as const, surplus: 0, costPaid: null };
}

/** 두 양식의 "기타" 칸에 들어갈 설명 */
function notesOf(c: ReportCase, price: number | null, computed: boolean): string[] {
  const j = c.judgement;
  const notes: string[] = [];
  notes.push(`배당 가능성: ${j.result}${j.method ? ` (${j.method})` : ""} / 검토 의견: ${j.recommendation.decision}`);
  for (const reason of j.recommendation.reasons) notes.push(`· ${reason}`);
  const malso = c.ranking.malsoStandard;
  if (malso) notes.push(`말소기준권리: ${malso.type} ${malso.holder ?? ""} (${dot(malso.receiptDate) || "접수일자 불명"})`);
  const ref = c.ranking.reference;
  if (ref) notes.push(`기준 권리(위임기관 조세채권): ${ref.type} ${ref.holder ?? ""} (${dot(ref.receiptDate)})`);
  if (!computed) {
    notes.push(
      price === null
        ? "예상 매각가를 입력하지 않았거나 금액을 알 수 없어 배분금액은 계산하지 않았고, 배분순위 순서만 나열했습니다."
        : "채권액 또는 접수일자를 알 수 없는 권리가 있어 배분금액은 계산하지 않았고, 배분순위 순서만 나열했습니다.",
    );
  } else {
    notes.push(`배분 계산 가정: 매각대금 ${won(price as number)}(입력한 예상 매각금액), 강제징수비 ${won(ENFORCEMENT_COST)}, 예치이자 0원, 근저당 실채권액 = 채권최고액.`);
  }
  for (const e of c.extras ?? []) notes.push(`추가 반영: ${e.holder} 당해세(${e.taxKind}) ${won(e.amount)}${e.lawDate ? `, 법정기일 ${dot(e.lawDate)}` : ""} — 자료에 없어 사람이 알려 준 값이며, 당해세는 3순위로 다른 조세·담보채권보다 먼저 배분합니다.`);
  notes.push("배분 기준: 국세·지방세 압류와 근저당은 법정기일과 설정일 비교(같은 날이면 조세 우선), 조세 압류끼리는 압류일자 순, 공과금은 가압류와 동순위(채권액 비율 안분), 국세·지방세 압류는 가압류보다 항상 선순위.");
  for (const a of c.ranking.assumptions) notes.push(`· ${a}`);
  notes.push("이 보고서는 참고용이며 담당자 최종 확인이 필요합니다.");
  return notes;
}

// ───── 양식 ① 배분계산서 ─────
// 양식 줄 번호: 0 관리번호, 3~5 체납자, 6~10 금액·재산·체납액, 11~12 채권자 머리, 13 채권자 칸, 18~19 배분순위 머리, 20 순위 칸, 22 합계, 23 기타, 24~26 교부 문구·날짜·기관장
function statement(c: ReportCase): Uint8Array {
  const price = c.price;
  const form = openForm("배분계산서");
  const R = form.rows;
  const { lines, computed, surplus, costPaid } = arrange(c, price);

  const head = R.slice(0, 11);
  head[0] = fillRow(form, R[0], { 7: [`[관리번호 : ${c.key}]`, "RIGHT"] });
  head[2] = setRowHeight(R[2], 3800);
  head[3] = fillRow(form, R[3], { 3: c.owner || "(자료 확인 필요)", 12: "-" });
  head[4] = fillRow(form, R[4], { 3: "-", 12: "-" });
  head[5] = fillRow(form, R[5], { 3: ["(자료 없음)", "LEFT"] });
  head[6] = fillRow(form, R[6], { 6: [price !== null ? won(price) : "(예상 매각가 미입력)", "RIGHT"] });
  head[7] = fillRow(form, R[7], { 6: ["0원", "RIGHT"] });
  head[8] = fillRow(form, R[8], { 6: [price !== null ? won(price) : "(예상 매각가 미입력)", "RIGHT"] });
  head[9] = fillRow(form, R[9], { 6: [c.label || "(자료 확인 필요)", "LEFT"] });
  const ref = c.ranking.reference;
  head[10] = fillRow(form, R[10], {
    6: [ref ? `${ref.amount !== null ? `${won(ref.amount)}  ` : ""}(${ref.holder ?? ""}, ${ref.type}, 압류 ${dot(ref.receiptDate)})` : "(압류(조세) 자료 없음)", "LEFT"],
  });

  const credRows = lines.map((l) =>
    setRowHeight(fillRow(form, R[13], { 0: l.name, 4: ["(자료 없음)", "LEFT"], 15: [l.claim !== null ? won(l.claim) : "-", "RIGHT"] }), 1700),
  );

  const rankRows: string[] = [];
  const rank = (spec: Record<number, string | [string, "RIGHT"]>) => rankRows.push(setRowHeight(fillRow(form, R[20], spec), 1700));
  rank({ 0: "1", 2: "강제징수비 (공매에 소요된 비용)", 5: "-", 8: "-", 10: [won(computed ? (costPaid ?? 0) : ENFORCEMENT_COST), "RIGHT"], 13: computed ? todayText() : "-", 16: "" });
  for (const l of lines) {
    rank({
      0: String(l.rank), 2: `${l.name} (${l.label})`, 5: "-", 8: "-",
      10: [l.paid !== null ? won(l.paid) : "-", "RIGHT"], 13: l.paid !== null && l.paid > 0 ? todayText() : "-", 16: l.remark,
    });
  }
  if (computed && surplus > 0) rank({ 0: "-", 2: "체납자에게 지급(잔액)", 5: "-", 8: "-", 10: [won(surplus), "RIGHT"], 13: todayText(), 16: "" });
  const total = fillRow(form, R[22], { 10: [computed && price !== null ? won(price) : "-", "RIGHT"], 13: "", 16: "" });

  const note = setRowHeight(fillRow(form, R[23], { 2: [notesOf(c, price, computed), "LEFT"] }), 2400);
  const date = fillRow(form, R[25], { 0: todayText() });
  const rows = [...head, R[11], R[12], ...credRows, R[18], R[19], ...rankRows, total, note, setRowHeight(R[24], 2000), setRowHeight(date, 1800), setRowHeight(R[26], 4200)];
  return finishForm(form, rows, `배분계산서 ${c.key}`);
}

// ───── 양식 ② 배분계산내역표 ─────
// 양식 줄 번호: 1 관리번호, 2~3 매각재산, 4 매각금액, 5 예치이자, 6 배분할금액, 7~9 체납세액 머리, 10 체납세액 칸, 11 계, 12~14 배분순위 머리, 15~16 채권자 칸(두 줄), 25 계, 26~27 기타
function detail(c: ReportCase): Uint8Array {
  const price = c.price;
  const form = openForm("배분계산내역표");
  const R = form.rows;
  const { lines, computed, surplus, costPaid } = arrange(c, price);
  const money = price !== null ? won(price) : "(예상 매각가 미입력)";

  const head = R.slice(0, 7);
  head[1] = fillRow(form, R[1], { 4: [c.key, "LEFT"] });
  head[2] = fillRow(form, R[2], { 4: [c.label || "(자료 확인 필요)", "LEFT"] });
  head[4] = fillRow(form, R[4], { 4: [money, "RIGHT"] });
  head[5] = fillRow(form, R[5], { 4: ["0원", "RIGHT"] });
  head[6] = fillRow(form, R[6], { 4: [money, "RIGHT"] });

  // 체납세액 현황에는 위임기관(그 사건에서 가장 먼저 압류한 조세 압류권자)의 내역만 적는다
  const refId = c.ranking.reference?.id;
  const taxes = lines.filter((l) => l.right.type === "압류(조세)" && l.right.id === refId);
  let taxSum = 0;
  let taxUnknown = false;
  // 세목(국세·지방세)별로 한 줄: 첫일 = 가장 이른 법정기일, 끝일 = 가장 늦은 법정기일 (1건이면 둘이 같다)
  const kinds = [...new Set(taxes.map((l) => l.right.taxKind ?? "조세"))];
  const taxLines = taxes.length
    ? kinds.map((kind) => {
        const group = taxes.filter((l) => (l.right.taxKind ?? "조세") === kind);
        const dates = group.map((l) => l.right.lawDate ?? l.right.receiptDate).filter((d): d is string => !!d).sort();
        let sum = 0;
        let unknown = false;
        for (const l of group) {
          if (l.claim === null) unknown = true;
          else sum += l.claim;
        }
        if (unknown) taxUnknown = true;
        else taxSum += sum;
        const amount = unknown ? "-" : won(sum);
        return fillRow(form, R[10], {
          0: dot(dates[0]) || "-", 2: dot(dates[dates.length - 1]) || "-", 4: [[kind, ...group.map((l) => l.name)], "CENTER"],
          6: [amount, "RIGHT"], 8: "-", 10: "-", 12: "-", 14: [amount, "RIGHT"], 16: "",
        });
      })
    : [fillRow(form, R[10], { 0: "-", 2: "-", 4: "(조세 압류 없음)", 6: "-", 8: "-", 10: "-", 12: "-", 14: "-", 16: "" })];
  const sumText = taxes.length && !taxUnknown ? won(taxSum) : "-";
  const taxTotal = fillRow(form, R[11], { 4: "", 6: [sumText, "RIGHT"], 8: "-", 10: "-", 12: "-", 14: [sumText, "RIGHT"], 16: "" });

  const pair = (a: Record<number, never | string | [string, "RIGHT"]>, b: Record<number, string | [string, "RIGHT"]>) => [
    setRowHeight(fillRow(form, R[15], a), 1500),
    setRowHeight(fillRow(form, R[16], b), 1500),
  ];
  const pairs: string[] = [];
  pairs.push(...pair({ 0: "1", 1: "강제징수비", 3: "-", 5: "-", 7: "-", 9: "-", 11: [won(ENFORCEMENT_COST), "RIGHT"], 13: [won(ENFORCEMENT_COST), "RIGHT"], 15: [computed ? won(costPaid ?? 0) : "-", "RIGHT"] }, { 3: "", 5: "" }));
  for (const l of lines) {
    const claim = l.claim !== null ? won(l.claim) : "-";
    // 압류권자(조세·공과금·기타 압류)는 설정금액·설정일자가 없으므로 비워 둔다
    const seizure = l.right.type.startsWith("압류");
    pairs.push(
      ...pair(
        {
          0: String(l.rank), 1: l.label, 3: l.name, 5: [seizure ? "-" : claim, "RIGHT"], 7: [claim, "RIGHT"], 9: "-", 11: "-", 13: [claim, "RIGHT"],
          15: [l.paid !== null ? won(l.paid) : "-", "RIGHT"],
        },
        { 3: l.remark, 5: [seizure || !l.date ? "" : `(${dot(l.date)})`, "RIGHT"] },
      ),
    );
  }
  if (computed && surplus > 0) pairs.push(...pair({ 0: "-", 1: "잔액", 3: "체납자", 5: "-", 7: "-", 9: "-", 11: "-", 13: "-", 15: [won(surplus), "RIGHT"] }, { 3: "", 5: "" }));
  const claimKnown = lines.every((l) => l.claim !== null);
  const claimSum = lines.reduce((s, l) => s + (l.claim ?? 0), 0);
  const sumRow = fillRow(form, R[25], {
    3: "", 5: "", 7: [claimKnown ? won(claimSum) : "-", "RIGHT"], 9: "-", 11: [won(ENFORCEMENT_COST), "RIGHT"], 13: [claimKnown ? won(claimSum + ENFORCEMENT_COST) : "-", "RIGHT"],
    15: [computed && price !== null ? won(price) : "-", "RIGHT"],
  });
  const note = fillRow(form, R[27], { 0: [notesOf(c, price, computed), "LEFT"] });
  const rows = [...head, R[7], R[8], R[9], ...taxLines, taxTotal, R[12], R[13], R[14], ...pairs, sumRow, R[26], note];
  return finishForm(form, rows, `배분계산내역표 ${c.key}`);
}

const safe = (s: string) => s.replace(/[^0-9A-Za-z가-힣-]/g, "_") || "사건";

/** 사건들의 보고서(.hwpx)를 묶어 .zip 파일 내용으로 돌려준다 */
export function buildReportZip(cases: ReportCase[]): Uint8Array {
  const files: Zippable = {};
  for (const c of cases) {
    const k = safe(c.key);
    files[`${k}_배분계산서.hwpx`] = [statement(c), { level: 0 }];
    files[`${k}_배분계산내역표.hwpx`] = [detail(c), { level: 0 }];
  }
  files["읽어보세요.txt"] = strToU8(
    ["이 폴더의 한글(.hwpx) 파일은 권리분석 대시보드의 결과를 배분계산서·배분계산내역표 양식에 채운 것입니다.", "결과는 참고용이며 담당자 최종 확인이 필요합니다.", ""].join("\r\n"),
  );
  return zipSync(files);
}
