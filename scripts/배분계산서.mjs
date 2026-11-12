// 배분계산서·배분계산내역표 생성기
// 실행:  node scripts/배분계산서.mjs [입력엑셀경로] [출력폴더]
//   입력엑셀: 권리분석 입력자료(.xlsx, 사례번호·등기목적·접수일자·권리자·채권금액·법정기일·비고)
//   출력폴더: 기본값 배분계산서_산출물/
//
// 하는 일
//  1) 엑셀의 사례(부동산)마다 채권자 목록을 만들고
//  2) src/lib/server/distribution.ts(교육자료 배분순위 규칙)로 배분금액을 계산한 뒤
//  3) 한글(.hwpx) 양식 두 가지의 빈칸을 채운다: 배분계산서(국세징수법 시행규칙 별지 제82호), 배분계산내역표
//     (양식은 scripts/hwpx-form/ 에 있는 원본 양식을 hwpx로 바꾼 파일이며, 표 모양은 그대로 두고 글만 채운다)
//
// 가정 (자료에 없는 값, 아래 ASSUMPTIONS에서 바꿀 수 있다)
//  - 매각대금: 채권 합계 × 사례별 비율(낮은 순위 채권자가 일부만 배분받는 모습이 보이도록)
//  - 강제징수비 100만원, 예치이자 0원, 교부일·기관장은 양식의 문구(2026.11.18, 충북지역본부장)
//  - 근저당권의 실채권액은 자료가 없어 채권최고액으로 가정
//  - 건강보험료의 납부기한은 자료가 없어 압류일자로 대신 비교
// 모든 사람·주소·금액은 교육용 가상자료이며 결과는 참고용이다.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { distribute } from "../src/lib/server/distribution.ts";
import { fillRow, finishForm, openForm, setRowHeight } from "./양식채우기.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = process.argv[2] ?? "C:/Users/user/Downloads/권리분석데이터).xlsx";
const OUT = resolve(process.argv[3] ?? join(ROOT, "배분계산서_산출물"));

const ASSUMPTIONS = {
  cost: 1_000_000, // 강제징수비(1순위)
  interest: 0, // 매각대금 예치이자
  issueDate: "2026.11.18", // 교부일 (양식에 적힌 날짜)
  agency: "한국자산관리공사 충북지역본부장", // 양식에 적힌 기관장
  // 사례별 매각대금 = 채권 합계 × 비율 (5백만원 단위로 반올림)
  priceRatio: { "001": 0.7, "002": 0.55, "003": 0.8, "004": 0.6, "005": 0.5, "006": 0.75, "007": 0.65, "008": 0.85, "009": 0.6, "010": 0.7 },
  defaultRatio: 0.7,
};

// ───────────── 입력 엑셀 읽기 ─────────────

function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function readSheet(path) {
  const files = unzipSync(new Uint8Array(readFileSync(path)), {
    filter: (f) => f.name === "xl/sharedStrings.xml" || f.name === "xl/worksheets/sheet1.xml",
  });
  // 글자는 sharedStrings에 있을 수도, 칸 안(inlineStr)에 있을 수도 있다
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) =>
        decodeXml([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
      )
    : [];
  const rows = [];
  for (const row of strFromU8(files["xl/worksheets/sheet1.xml"]).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = {};
    for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c[1])?.[1];
      const type = /\bt="([^"]*)"/.exec(c[1])?.[1];
      const body = c[2] ?? "";
      if (!ref) continue;
      if (type === "inlineStr") {
        cells[ref] = decodeXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        continue;
      }
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (v === undefined) continue;
      cells[ref] = type === "s" ? shared[Number(v)] : decodeXml(v);
    }
    rows.push(cells);
  }
  return rows;
}

/** 엑셀 날짜 번호나 YYYY-MM-DD 글자를 YYYY-MM-DD로 맞춘다 */
function asDate(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{5}$/.test(v)) return new Date(Date.UTC(1899, 11, 30) + Number(v) * 86400000).toISOString().slice(0, 10);
  return null;
}

function loadCases(path) {
  const rows = readSheet(path).slice(1); // 첫 줄은 머리글
  const cases = new Map();
  for (const r of rows) {
    const no = r.A;
    if (!no) continue;
    if (!cases.has(no)) cases.set(no, { no, property: r.B, owner: r.C, rows: [] });
    cases.get(no).rows.push({
      part: r.D, // 갑구/을구
      seq: r.E,
      purpose: r.F,
      date: asDate(r.G),
      holder: r.H,
      amount: r.I && /^\d+$/.test(r.I) ? Number(r.I) : null,
      lawDate: asDate(r.K),
      note: r.L ?? r.K ?? "",
    });
  }
  return [...cases.values()].sort((a, b) => a.no.localeCompare(b.no));
}

/** 사례의 등기 항목을 배분 채권자 목록으로 바꾼다 */
function toCreditors(c) {
  const creditors = [];
  const assumptions = [];
  for (const r of c.rows) {
    if (r.purpose.startsWith("소유권")) continue;
    const id = `${r.part}${r.seq}`;
    if (r.purpose === "압류") {
      const note = r.note ?? "";
      if (/건강보험|국민연금|고용|산재/.test(note) || /공단/.test(r.holder)) {
        creditors.push({ id, name: r.holder, kind: "공과금", label: `${/건강보험/.test(note) ? "건강보험료" : "공과금"} 압류`, amount: r.amount, baseDate: r.date, lawDate: null, settledAmount: null });
        if (!assumptions.includes("공과금(건강보험료)은 가압류와 동순위로 보아 채권액 비율로 나누었습니다.")) {
          assumptions.push("공과금(건강보험료)은 가압류와 동순위로 보아 채권액 비율로 나누었습니다.");
        }
      } else {
        creditors.push({ id, name: r.holder, kind: "조세", label: /지방세/.test(note) ? "지방세 압류" : "국세 압류", amount: r.amount, baseDate: r.date, lawDate: r.lawDate, settledAmount: null, taxKind: /지방세/.test(note) ? "지방세" : "국세" });
      }
    } else if (r.purpose === "가압류") {
      creditors.push({ id, name: r.holder, kind: "일반", label: "가압류", amount: r.amount, baseDate: r.date, lawDate: null, settledAmount: null });
    } else if (r.purpose.startsWith("근저당")) {
      creditors.push({ id, name: r.holder, kind: "담보", label: "근저당권", amount: r.amount, baseDate: r.date, lawDate: null, settledAmount: r.amount });
    }
  }
  if (creditors.some((x) => x.label === "근저당권")) {
    assumptions.push("근저당권의 실채권액은 자료가 없어 채권최고액으로 가정했습니다.");
  }
  return { creditors, assumptions };
}

// ───────────── 표시 형식 ─────────────

const won = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
const dot = (d) => (d ? d.replace(/-/g, ".") : "");

// ───────────── 양식 ① 배분계산서 (국세징수법 시행규칙 별지 제82호 서식) ─────────────
// 양식의 줄 번호(0부터): 0 관리번호, 3~5 체납자, 6~10 금액·재산·체납액, 11~12 채권자 머리, 13~17 채권자 칸(5줄),
// 19 배분순위 머리, 20~21 순위 칸(2줄), 22 합계, 23 기타, 24~26 교부 문구·날짜·기관장

function distributionStatement(c, data) {
  const { result, fund, price, agencyTax, claimSum, ratio, shortages } = data;
  const form = openForm("배분계산서");
  const R = form.rows;
  const head = R.slice(0, 11);
  head[0] = fillRow(form, R[0], { 7: [`[관리번호 : 2026-${c.no}]`, "RIGHT"] });
  head[3] = fillRow(form, R[3], { 3: c.owner, 12: "(가상자료 - 기재하지 않음)" });
  head[4] = fillRow(form, R[4], { 3: "-", 12: "-" });
  head[5] = fillRow(form, R[5], { 3: ["(자료 없음)", "LEFT"] });
  head[6] = fillRow(form, R[6], { 6: [won(price), "RIGHT"] });
  head[7] = fillRow(form, R[7], { 6: [won(ASSUMPTIONS.interest), "RIGHT"] });
  head[8] = fillRow(form, R[8], { 6: [won(fund), "RIGHT"] });
  head[9] = fillRow(form, R[9], { 6: [c.property, "LEFT"] });
  head[10] = fillRow(form, R[10], {
    6: [agencyTax ? `${won(agencyTax.amount)}  (${agencyTax.name}, ${agencyTax.label}, 압류 ${dot(agencyTax.baseDate)})` : "(압류(조세) 자료 없음)", "LEFT"],
  });

  // 채권자 칸: 채권자 수만큼 (양식 첫 칸 줄을 복사)
  const credRows = result.allocations.map((a) =>
    setRowHeight(fillRow(form, R[13], { 0: a.creditor.name, 4: "(자료 없음)", 15: [won(a.creditor.amount), "RIGHT"] }), 1700),
  );
  head[2] = setRowHeight(R[2], 3800); // 제목 줄은 낮추어 채권자가 많아도 한 쪽에 들어가게 한다

  // 배분순위 칸: 강제징수비, 채권자들, (잔액), 합계
  const rankRows = [];
  const rank = (spec) => rankRows.push(setRowHeight(fillRow(form, R[20], spec), 1700));
  rank({ 0: "1", 2: "강제징수비 (공매에 소요된 비용)", 5: "-", 8: "-", 10: [won(result.costPaid), "RIGHT"], 13: "-", 16: "" });
  for (const a of result.allocations) {
    const remark = [];
    if (a.group === "동순위") remark.push("동순위(안분)");
    if (a.group === "순환") remark.push("순환배분");
    if (a.shortfall > 0 && a.amount > 0) remark.push("일부 배분");
    if (a.amount === 0) remark.push("배분 없음");
    rank({ 0: String(a.rank), 2: a.creditor.name, 5: "-", 8: "-", 10: [won(a.amount), "RIGHT"], 13: a.amount > 0 ? ASSUMPTIONS.issueDate : "-", 16: remark.join(", ") });
  }
  if (result.surplus > 0) rank({ 0: "-", 2: "체납자에게 지급(잔액)", 5: "-", 8: "-", 10: [won(result.surplus), "RIGHT"], 13: ASSUMPTIONS.issueDate, 16: "" });
  const total = fillRow(form, R[22], { 10: [won(result.costPaid + result.distributed + result.surplus), "RIGHT"], 13: "", 16: "" });

  // 기타: 짧게 (판단 근거 전체는 배분계산내역표에 적는다)
  const notes = [
    "교육용 가상자료이며 실제 등기사항·체납정보와 무관합니다. 결과는 참고용, 담당자 최종 확인 필요.",
    `가정: 매각대금 ${won(price)}(채권 합계 ${won(claimSum)}의 ${Math.round(ratio * 100)}%), 강제징수비 ${won(ASSUMPTIONS.cost)}, 예치이자 ${won(ASSUMPTIONS.interest)}.`,
    "배분 근거: 국세·지방세 압류와 근저당권은 법정기일과 등기(설정)일로 선후를 판단하고(같은 날이면 조세 우선), 국세·지방세 압류는 가압류보다 항상 선순위로 하였습니다. 자세한 근거는 배분계산내역표를 참고하세요.",
    ...(shortages.length ? [`배분받지 못한 부족분: ${shortages.join(", ")}.`] : []),
  ];
  const note = setRowHeight(fillRow(form, R[23], { 2: [notes, "LEFT"] }), 2400);

  const rows = [...head, R[11], R[12], ...credRows, R[18], R[19], ...rankRows, total, note, setRowHeight(R[24], 2000), setRowHeight(R[25], 1800), setRowHeight(R[26], 4200)];
  return finishForm(form, rows, "배분계산서");
}

// ───────────── 양식 ② 배분계산내역표 ─────────────
// 양식의 줄 번호: 1 관리번호, 2~3 매각재산, 4 매각금액, 5 예치이자, 6 배분할금액, 8~9 체납세액 머리, 10 체납세액 칸, 11 계,
// 13~14 배분순위 머리, 15~24 채권자 칸(두 줄씩 5쌍), 25 계, 26 기타 머리, 27 기타 내용

function detailTable(c, data) {
  const { result, fund, price, taxRows, notesLines } = data;
  const form = openForm("배분계산내역표");
  const R = form.rows;
  const head = R.slice(0, 7).map((r) => r);
  head[1] = fillRow(form, R[1], { 4: [`2026-${c.no}`, "LEFT"] });
  head[2] = fillRow(form, R[2], { 4: [c.property, "LEFT"] });
  head[4] = fillRow(form, R[4], { 4: [won(price), "RIGHT"] });
  head[5] = fillRow(form, R[5], { 4: [won(ASSUMPTIONS.interest), "RIGHT"] });
  head[6] = fillRow(form, R[6], { 4: [won(fund), "RIGHT"] });

  // 체납세액 현황: 조세 압류마다 한 줄
  let taxSum = 0;
  const taxLines = taxRows.length
    ? taxRows.map((t) => {
        taxSum += t.amount;
        return fillRow(form, R[10], { 0: dot(t.lawDate ?? t.baseDate) || "-", 2: "-", 4: [[t.taxKind ?? "조세", t.name], "CENTER"], 6: [won(t.amount), "RIGHT"], 8: "-", 10: "-", 12: "-", 14: [won(t.amount), "RIGHT"], 16: "" });
      })
    : [fillRow(form, R[10], { 0: "-", 2: "-", 4: "(조세 압류 없음)", 6: "-", 8: "-", 10: "-", 12: "-", 14: "-", 16: "" })];
  const taxTotal = fillRow(form, R[11], { 4: "", 6: [won(taxSum), "RIGHT"], 8: "-", 10: "-", 12: "-", 14: [won(taxSum), "RIGHT"], 16: "" });

  // 배분순위 및 금액: 두 줄 한 쌍 = 채권자 한 명
  const pair = (spec, spec2) => [setRowHeight(fillRow(form, R[15], spec), 1500), setRowHeight(fillRow(form, R[16], spec2), 1500)];
  const pairs = [];
  pairs.push(...pair(
    { 0: "1", 1: "강제징수비", 3: "-", 5: "-", 7: "-", 9: "-", 11: [won(ASSUMPTIONS.cost), "RIGHT"], 13: [won(ASSUMPTIONS.cost), "RIGHT"], 15: [won(result.costPaid), "RIGHT"] },
    { 3: "", 5: "" },
  ));
  for (const a of result.allocations) {
    const cr = a.creditor;
    pairs.push(...pair(
      { 0: String(a.rank), 1: cr.label, 3: cr.name, 5: [won(cr.settledAmount ?? cr.amount), "RIGHT"], 7: [won(cr.amount), "RIGHT"], 9: "-", 11: "-", 13: [won(cr.amount), "RIGHT"], 15: [won(a.amount), "RIGHT"] },
      { 3: "", 5: [`(${dot(cr.baseDate)})`, "RIGHT"] },
    ));
  }
  if (result.surplus > 0) {
    pairs.push(...pair({ 0: "-", 1: "잔액", 3: "체납자", 5: "-", 7: "-", 9: "-", 11: "-", 13: "-", 15: [won(result.surplus), "RIGHT"] }, { 3: "", 5: "" }));
  }
  const claimSum = result.allocations.reduce((s, a) => s + a.creditor.amount, 0);
  const sumRow = fillRow(form, R[25], { 3: "", 5: "", 7: [won(claimSum), "RIGHT"], 9: "-", 11: [won(ASSUMPTIONS.cost), "RIGHT"], 13: [won(claimSum + ASSUMPTIONS.cost), "RIGHT"], 15: [won(result.costPaid + result.distributed + result.surplus), "RIGHT"] });
  const note = fillRow(form, R[27], { 0: [notesLines, "LEFT"] });

  const rows = [...head, R[7], R[8], R[9], ...taxLines, taxTotal, R[12], R[13], R[14], ...pairs, sumRow, R[26], note];
  return finishForm(form, rows, "배분계산내역표");
}

// ───────────── 사례별 계산 ─────────────

function prepareCase(c) {
  const { creditors, assumptions } = toCreditors(c);
  const claimSum = creditors.reduce((s, x) => s + x.amount, 0);
  const ratio = ASSUMPTIONS.priceRatio[c.no] ?? ASSUMPTIONS.defaultRatio;
  const price = Math.max(ASSUMPTIONS.cost + 5_000_000, Math.round((claimSum * ratio) / 5_000_000) * 5_000_000);
  const fund = price + ASSUMPTIONS.interest;
  // 일반채권(가압류)은 항상 맨 뒤: 국세·지방세 압류는 가압류보다 항상 선순위이고, 평등관계·순환배분은 적용하지 않는다
  const result = distribute({ fund, cost: ASSUMPTIONS.cost, creditors, generalLast: true });

  const taxCreditors = creditors.filter((x) => x.kind === "조세").sort((a, b) => (a.baseDate < b.baseDate ? -1 : 1));
  const agencyTax = taxCreditors[0] ?? null; // 압류에 관계되는 체납액: 가장 먼저 압류한 조세
  const taxRows = taxCreditors.map((x) => ({ ...x }));

  // 선순위 판단 근거: 국세·지방세 압류와 근저당권은 법정기일과 등기(설정)일을 비교한다
  const basis = [];
  const byAmount = new Map(result.allocations.map((a) => [a.creditor.id, a.amount]));
  const taxes = creditors.filter((x) => x.kind === "조세");
  const mortgages = creditors.filter((x) => x.kind === "담보");
  const provisionals = creditors.filter((x) => x.kind === "일반");
  for (const t of taxes) {
    for (const m of mortgages) {
      const law = t.lawDate ?? t.baseDate;
      const mortgageFirst = m.baseDate < law;
      basis.push(
        mortgageFirst
          ? `[선순위 판단] ${m.name} 근저당 설정일 ${dot(m.baseDate)} < ${t.name} ${t.label} 법정기일 ${dot(law)} → 근저당권 선순위`
          : `[선순위 판단] ${t.name} ${t.label} 법정기일 ${dot(law)} ≤ ${m.name} 근저당 설정일 ${dot(m.baseDate)} → 압류(조세) 선순위`,
      );
      // 자동 검사: 먼저인 쪽이 전액 배분받기 전에 뒤의 쪽이 배분받으면 안 된다
      const first = mortgageFirst ? m : t;
      const second = mortgageFirst ? t : m;
      if (byAmount.get(second.id) > 0 && byAmount.get(first.id) < first.amount) {
        throw new Error(`우선순위 위반: ${first.name}이(가) 전액 배분받기 전에 ${second.name}이(가) 배분받았습니다 (사례 ${c.no})`);
      }
    }
    for (const g of provisionals) {
      if (byAmount.get(g.id) > 0 && byAmount.get(t.id) < t.amount) {
        throw new Error(`우선순위 위반: ${t.name}이(가) 전액 배분받기 전에 가압류 ${g.name}이(가) 배분받았습니다 (사례 ${c.no})`);
      }
    }
  }
  if (taxes.length > 0 && provisionals.length > 0) {
    basis.push(`[선순위 판단] 국세·지방세 압류는 가압류(${provisionals.map((g) => g.name).join(", ")})보다 항상 선순위입니다.`);
  }

  const circular = result.circular.map((cs) =>
    `순환배분(안분 후 흡수) 계산: ${cs.steps
      .map((s) => `${s.member} 채권 ${won(s.claim)} → 1차 안분 ${won(s.firstShare)}${s.absorbed.length ? ` + 흡수 ${s.absorbed.map((a) => `${a.from} ${won(a.amount)}`).join(", ")}` : ""}${s.finalAmount !== s.firstShare ? ` → 배분 ${won(s.finalAmount)}` : ""}`)
      .join(" / ")}`,
  );
  const shortages = result.allocations.filter((a) => a.shortfall > 0).map((a) => `${a.creditor.name} ${won(a.shortfall)}`);
  const baseNotes = [
    `교육용 가상자료입니다. 실제 등기사항·체납정보와 무관하며 결과는 참고용, 담당자 최종 확인 필요.`,
    `가정: 매각대금 ${won(price)}(채권 합계 ${won(claimSum)}의 ${Math.round(ratio * 100)}%), 강제징수비 ${won(ASSUMPTIONS.cost)}, 예치이자 ${won(ASSUMPTIONS.interest)}.`,
    `배분 기준: 국세·지방세 압류와 근저당권은 법정기일과 등기(설정)일을 비교해 빠른 쪽이 선순위(같은 날이면 조세 우선), 국세·지방세 압류끼리는 압류일자 순(압류선착주의), 공과금은 가압류와 동순위(채권액 비율 안분)이며 조세·근저당보다 뒤입니다. 국세·지방세 압류는 가압류보다 항상 선순위이고, 가압류와 뒤에 설정된 근저당권의 평등관계·순환배분은 적용하지 않았습니다(권리분석기준.md §4~6 기준을 이 요청에 맞게 단순화).`,
    ...basis,
    ...assumptions,
    ...(shortages.length ? [`배분받지 못한 부족분: ${shortages.join(", ")}.`] : []),
    ...circular,
    ...result.notes.filter((n) => !n.startsWith("순환관계")),
  ];
  return { creditors, result, fund, price, agencyTax, taxRows, claimSum, ratio, baseNotes, shortages };
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const cases = loadCases(INPUT);
  if (cases.length === 0) throw new Error("입력 엑셀에서 사례를 찾지 못했습니다.");
  const summary = [];
  const heights = [];
  for (const c of cases) {
    const data = prepareCase(c);
    const stmt = distributionStatement(c, data);
    const detail = detailTable(c, { ...data, notesLines: data.baseNotes });
    writeFileSync(join(OUT, `${c.no}_배분계산서.hwpx`), stmt.bytes);
    writeFileSync(join(OUT, `${c.no}_배분계산내역표.hwpx`), detail.bytes);
    heights.push(`${c.no}: 배분계산서 표 높이 ${stmt.height}, 내역표 ${detail.height} (한 쪽 사용 가능 약 75000)`);

    const lines = [`## 사례 ${c.no} — ${c.property} (소유자 ${c.owner})`, ""];
    lines.push(`- 매각대금(가정) ${won(data.price)} (채권 합계 ${won(data.claimSum)}의 ${Math.round(data.ratio * 100)}%), 강제징수비 ${won(ASSUMPTIONS.cost)}`);
    lines.push("", "| 순위 | 채권자 | 권리관계 | 실채권액 | 배분금액 | 부족분 | 비고 |", "|---|---|---|---|---|---|---|");
    lines.push(`| 1 | 강제징수비 | - | ${won(ASSUMPTIONS.cost)} | ${won(data.result.costPaid)} | - | |`);
    for (const a of data.result.allocations) {
      lines.push(`| ${a.rank} | ${a.creditor.name} | ${a.creditor.label} | ${won(a.creditor.amount)} | ${won(a.amount)} | ${a.shortfall > 0 ? won(a.shortfall) : "-"} | ${a.group === "단독" ? "" : a.group} |`);
    }
    lines.push("", ...data.result.circular.map((cs) => `- 순환배분: ${cs.steps.map((s) => `${s.member} ${won(s.firstShare)}→${won(s.finalAmount)}`).join(", ")}`), "");
    summary.push(lines.join("\n"));
    console.log(`${c.no}: 배분할 금액 ${won(data.fund)} → ${data.result.allocations.map((a) => `${a.creditor.name} ${won(a.amount)}`).join(" / ")}`);
  }
  writeFileSync(
    join(OUT, "요약.md"),
    [
      "# 배분계산 요약 (가상자료, 참고용)",
      "",
      "- 입력: 권리분석 입력자료(.xlsx) 10건. 배분 규칙은 권리분석기준.md §4~6(교육자료 배분순위·압류선착주의)이며, 요청에 따라 ① 국세·지방세 압류와 근저당권은 법정기일과 등기(설정)일로 선순위를 판단하고 ② 국세·지방세 압류는 가압류보다 항상 선순위로 두었습니다(가압류=일반채권은 맨 뒤, 평등관계·순환배분 미적용) ③ 국세·지방세 압류끼리는 압류일자 순 ④ 공과금(건강보험료 등)은 가압류와 동순위로 채권액 비율에 따라 안분하며 조세·근저당보다 뒤로 두었습니다.",
      "- 가정: 매각대금은 사례별로 채권 합계의 일정 비율, 강제징수비 100만원, 예치이자 0원, 근저당 실채권액=채권최고액, 건강보험료 납부기한=압류일자.",
      "- 파일: 사례마다 `NNN_배분계산서.hwpx`(국세징수법 시행규칙 별지 제82호 서식)와 `NNN_배분계산내역표.hwpx`가 있습니다.",
      "",
      ...summary,
    ].join("\n"),
  );
  console.log(`\n${heights.join("\n")}`);
  console.log(`\n${cases.length}건 완료 → ${OUT}`);
}

main();
