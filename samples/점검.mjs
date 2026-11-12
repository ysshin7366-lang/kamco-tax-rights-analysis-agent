// 가상 샘플 5건 최종 점검 (PLAN 작업 11)
// 실행: 개발 서버를 켠 상태(npm run dev)에서  node samples/점검.mjs
// 주소를 바꾸려면:  BASE=http://localhost:3000 node samples/점검.mjs
//
// 확인하는 것 (PLAN 성공 기준)
//  ① 규칙 시험   — 경계값(49.99/50/80/80.01%, 선순위 0~4건)에서 높음/보통/낮음이 맞는가
//  ② 처리 시간   — 파일을 올린 순간부터 결과가 올 때까지 10분 이내인가
//  ③ 순위 일치율 — 정답표 권리 항목 중 분류(선순위/기준/후순위/미정/제외)와 순위가 같은 비율이 90% 이상인가
//  ④ 판정 일치   — 높음/보통/낮음/판정 보류가 건마다 정답표와 같은가
//  ⑤ 일관성      — 같은 샘플을 3회 반복해도 순위·판정·근거 출처가 항상 같은가
//
// 주의: 정답표는 숙련자 검토 전의 초안입니다. 검토·확정 전 결과는 참고용입니다.
// 샘플은 모두 가상 자료입니다. 실행하면 샘플 내용이 AI 서비스(OpenAI)로 전송됩니다.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyByAmount,
  classifyByCount,
  formatRatio,
} from "../src/lib/server/judgeDividend.ts";

const BASE = process.env.BASE ?? "http://localhost:3000";
const ROOT = dirname(fileURLToPath(import.meta.url));
const REPEAT = 3;
const TIME_LIMIT_SEC = 600; // 10분

const answerKey = JSON.parse(readFileSync(join(ROOT, "정답표.json"), "utf8"));
let failures = 0;
const mark = (ok) => (ok ? "✓" : "✗");
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${mark(ok)} ${label}${detail ? "  " + detail : ""}`);
}

// ───────── ① 규칙 시험 ─────────
console.log("\n[1] 판정 규칙 경계값 시험");
const amountCases = [
  [4999, 10000, "높음"], // 49.99%
  [5000, 10000, "보통"], // 50.00%
  [8000, 10000, "보통"], // 80.00%
  [8001, 10000, "낮음"], // 80.01%
  [200000000, 400000000, "보통"], // 정확히 50%
  [800100000, 1000000000, "낮음"], // 80.01%
];
for (const [sum, price, want] of amountCases) {
  check(`${formatRatio(sum, price)} → ${want}`, classifyByAmount(sum, price) === want);
}
const countCases = [[0, "높음"], [1, "높음"], [2, "보통"], [3, "보통"], [4, "낮음"], [5, "낮음"]];
for (const [n, want] of countCases) {
  check(`선순위 ${n}건 → ${want}`, classifyByCount(n) === want);
}

// ───────── 샘플 실행 ─────────
async function analyze(sample) {
  const form = new FormData();
  const dir = join(ROOT, sample.폴더);
  for (const name of readdirSync(dir).sort()) {
    form.append("files", new File([readFileSync(join(dir, name))], name));
  }
  const started = Date.now();
  const response = await fetch(`${BASE}/api/analyze`, { method: "POST", body: form });
  const seconds = (Date.now() - started) / 1000;
  return { seconds, data: await response.json() };
}

// 반복 비교용: 설명 문장(쉬운 설명·근거 문장)은 달라도 되므로 순위·판정·출처만 본다
function core(data) {
  return JSON.stringify({
    rights: data.ranking.rights.map((r) => [
      r.type, r.holder, r.receiptDate, r.receiptNo, r.amount, r.position, r.rank, r.status,
      r.disposition, r.tier, r.sources.map((s) => [s.document, s.page]),
    ]),
    malso: data.ranking.malsoStandard?.id ?? null,
    blockers: data.ranking.proceedBlockers,
    conditions: data.ranking.conditions,
    burdens: data.ranking.burdens,
    cancelled: data.ranking.cancelled.map((r) => [r.type, r.holder]),
    tenants: data.ranking.unregisteredTenants.map((r) => [r.type, r.holder]),
    conflicts: data.ranking.conflicts,
    hold: data.ranking.holdReasons,
    judge: {
      result: data.judgement.result,
      method: data.judgement.method,
      ratio: data.judgement.ratioText,
      decision: data.judgement.recommendation.decision,
      calc: data.judgement.calculation,
      evidence: data.judgement.evidence.map((e) => [e.role, e.label, e.sources.map((s) => [s.document, s.page])]),
    },
  });
}

function classify(data) {
  return [
    ...data.ranking.rights.map((r) => ({
      type: r.type, holder: r.holder, cls: r.position, rank: r.rank,
      disposition: r.disposition, tier: r.tier,
    })),
    ...data.ranking.cancelled.map((r) => ({ type: r.type, holder: r.holder, cls: "제외(말소)", rank: null })),
    ...data.ranking.unregisteredTenants.map((r) => ({ type: r.type, holder: r.holder, cls: "제외(미등기)", rank: null })),
  ];
}

console.log("\n[2~5] 샘플 5건 (각 " + REPEAT + "회 반복)");
let totalItems = 0;
let matchedItems = 0;
let judgeMatched = 0;
let consistent = 0;
let slowest = 0;

for (const sample of answerKey.샘플) {
  const runs = [];
  for (let i = 0; i < REPEAT; i++) runs.push(await analyze(sample));
  const first = runs[0];
  console.log(`\n── ${sample.폴더}`);

  if (!first.data.ok) {
    check("분석 성공", false, first.data.message);
    totalItems += sample.권리.length;
    continue;
  }
  const times = runs.map((r) => r.seconds);
  slowest = Math.max(slowest, ...times);
  check(
    `처리 시간 ${times.map((t) => t.toFixed(1)).join(" / ")}초 (한도 ${TIME_LIMIT_SEC}초)`,
    Math.max(...times) <= TIME_LIMIT_SEC,
  );

  // ③ 항목 단위 일치
  const actual = classify(first.data);
  let matched = 0;
  for (const expected of sample.권리) {
    totalItems++;
    const found = actual.find((a) => a.type === expected.종류 && a.holder === expected.권리자);
    // 분류(선/후순위)와 접수 순위, 그리고 정답표에 적힌 처분(말소기준권리/인수/소멸)·예상 배분순위까지 같아야 일치
    const ok =
      found &&
      found.cls === expected.분류 &&
      (found.rank ?? null) === (expected.순위 ?? null) &&
      (expected.처분 === undefined || found.disposition === expected.처분) &&
      (expected.배분순위 === undefined || (found.tier ?? null) === expected.배분순위);
    if (ok) { matched++; matchedItems++; }
    else {
      console.log(
        `   ✗ ${expected.종류} ${expected.권리자}: 정답 ${expected.분류}/${expected.순위}/${expected.처분 ?? "-"}/${expected.배분순위 ?? "-"}순위` +
          ` ↔ 결과 ${found ? [found.cls, found.rank, found.disposition ?? "-", (found.tier ?? "-") + "순위"].join("/") : "없음"}`,
      );
    }
  }
  // 정답표에 없는 항목을 더 만든 경우는 틀린 것으로 센다 (분모는 그대로)
  const extra = actual.length - sample.권리.length;
  check(`권리 항목 일치 ${matched}/${sample.권리.length}`, matched === sample.권리.length && extra <= 0,
    extra > 0 ? `(정답표에 없는 항목 ${extra}건 추가됨)` : "");

  // ④ 판정 일치
  const j = first.data.judgement;
  const expectedJudge = sample.판정;
  const judgeOk =
    j.result === expectedJudge.결과 &&
    (expectedJudge.방식 ? j.method === expectedJudge.방식 : j.method === null) &&
    (expectedJudge.비율 ? j.ratioText === expectedJudge.비율 : true);
  if (judgeOk) judgeMatched++;
  check(`판정 ${j.result}${j.method ? " (" + j.method + ")" : ""}${j.ratioText ? " " + j.ratioText : ""}`, judgeOk,
    `정답: ${expectedJudge.결과}${expectedJudge.방식 ? " (" + expectedJudge.방식 + ")" : ""}${expectedJudge.비율 ? " " + expectedJudge.비율 : ""}`);

  // 말소기준권리와 공매 착수/반려 검토 의견
  const malso = first.data.ranking.malsoStandard;
  const malsoText = malso ? `${malso.type} ${malso.holder}` : "없음";
  check(`말소기준권리 ${malsoText}`, malsoText === sample.말소기준권리, `정답: ${sample.말소기준권리}`);
  check(
    `공매 착수/반려 의견 ${j.recommendation.decision}`,
    j.recommendation.decision === sample.의견,
    `정답: ${sample.의견}`,
  );

  // 근거가 1개 이상 붙는지 (판정 안 함 제외)
  if (j.result !== "판정 안 함") check("근거 1개 이상", j.evidence.length >= 1);

  // ⑤ 일관성
  const same = runs.every((r) => r.data.ok && core(r.data) === core(first.data));
  if (same) consistent++;
  check(`${REPEAT}회 반복 결과 동일 (순위·판정·출처)`, same);
}

const rate = totalItems === 0 ? 0 : (matchedItems / totalItems) * 100;
console.log("\n──────── 요약 ────────");
check(`권리 순위 일치율 ${matchedItems}/${totalItems} = ${rate.toFixed(1)}% (기준 90% 이상)`, rate >= 90);
check(`판정 일치 ${judgeMatched}/${answerKey.샘플.length}`, judgeMatched === answerKey.샘플.length);
check(`반복 일관성 ${consistent}/${answerKey.샘플.length}`, consistent === answerKey.샘플.length);
check(`가장 느린 처리 시간 ${slowest.toFixed(1)}초 (기준 ${TIME_LIMIT_SEC}초 이내)`, slowest <= TIME_LIMIT_SEC);
console.log(failures === 0 ? "\n점검 통과 (정답표는 초안이므로 숙련자 검토 후 다시 확인 필요)" : `\n실패 ${failures}건`);
process.exit(failures === 0 ? 0 : 1);
