// Design Ref: §2.3 권리 1건의 모양, §2.2 세부 규칙 1 — AI가 돌려줘야 하는 답의 모양(zod).
// AI 답을 이 모양으로 받아 검사한다. 모양이 맞지 않으면 "지금은 분석할 수 없습니다"로 처리한다.
// 화면에서도 타입을 쓰므로 공용 폴더(lib)에 둔다. 비밀 값은 없다.

import { z } from "zod";

/**
 * 권리 종류 (고정 목록, PRD §5 + 권리분석기준.md §3.3 총괄표)
 * - 압류(조세): 세무서·시·군·구의 국세·지방세 체납 압류 / 압류(공과금): 건강보험·국민연금·고용·산재보험 등 공과금 압류
 * - 압류(기타): 그 밖의 압류(일반 채권자 등)
 */
export const RIGHT_TYPES = [
  "근저당",
  "가압류",
  "압류(조세)",
  "압류(공과금)",
  "압류(기타)",
  "임차권",
  "전세권",
  "담보가등기",
  "소유권이전가등기",
  "가처분",
  "경매개시결정",
  "임차권등기명령",
  "환매등기",
  "지상권",
  "지역권",
  "예고등기",
  "기타",
] as const;

const sourceSchema = z.object({
  document: z.string().describe("출처 문서 이름. 입력의 '=== 문서: 이름 ===' 표시에 적힌 이름 그대로"),
  page: z
    .number()
    .int()
    .nullable()
    .describe("PDF 쪽 번호. 글자 앞의 [p.N] 표시에서 읽는다. .txt이거나 알 수 없으면 null"),
});

export const rightSchema = z.object({
  type: z.enum(RIGHT_TYPES).describe("권리 종류. 목록에 없으면 '기타'"),
  holder: z
    .string()
    .nullable()
    .describe("권리자(압류 기관·근저당권자·임차인 등). 자료에 없으면 null"),
  receiptDate: z
    .string()
    .nullable()
    .describe("접수 일자 YYYY-MM-DD. 자료에 없거나 불명확하면 null"),
  receiptNo: z
    .string()
    .nullable()
    .describe("접수번호. 숫자만 쓴다('제12345호' → '12345'). 자료에 없으면 null"),
  amount: z
    .number()
    .int()
    .nullable()
    .describe("금액(원 단위 정수). 근저당=채권최고액, 임차권=보증금, 가압류·압류=청구금액, 전세권=전세금. 자료에 없으면 null"),
  cancelled: z
    .enum(["말소", "유효", "모름"])
    .describe("말소(지워진) 여부. 말소 표시가 있으면 '말소', 확실히 살아 있으면 '유효', 알 수 없으면 '모름'"),
  registered: z
    .enum(["등기", "미등기", "모름"])
    .describe("등기 여부. 임차 항목이 아닌 권리는 '등기'. 임차 항목은 등기되어 있으면 '등기', 등기 없이 계약서 등으로만 확인되면 '미등기', 알 수 없으면 '모름'"),
  lawDate: z
    .string()
    .nullable()
    .describe("조세 압류의 법정기일 또는 공과금(건강보험료 등)의 납부기한 YYYY-MM-DD. 자료에 적혀 있을 때만, 없으면 null. 압류일자(접수일자)를 여기에 넣지 않는다"),
  taxKind: z
    .string()
    .nullable()
    .describe("조세·공과금 압류의 세목(예: 재산세, 종합부동산세, 상속세, 증여세, 자동차세, 소득세, 부가가치세, 건강보험료). 자료에 적혀 있을 때만, 없으면 null"),
  moveInDate: z
    .string()
    .nullable()
    .describe("임차인의 전입일자(주민등록 전입, 상가는 사업자등록 신청일) YYYY-MM-DD. 임차 항목이 아니거나 자료에 없으면 null"),
  fixedDate: z
    .string()
    .nullable()
    .describe("임차인의 확정일자 YYYY-MM-DD. 임차 항목이 아니거나 자료에 없으면 null"),
  distributionDemand: z
    .boolean()
    .nullable()
    .describe("전세권자가 배분요구(채권신고)를 했는지. 전세권이 아니거나 자료에 없으면 null"),
  source: sourceSchema,
  quote: z
    .string()
    .describe("이 권리를 확인한 근거 문장을 자료에서 한 글자도 바꾸지 않고 그대로 복사한 것"),
  note: z
    .string()
    .describe("이 권리가 무엇인지 신입도 이해하도록 쓴 쉬운 설명 한 줄. 선순위·후순위나 배당 가능성은 쓰지 않는다"),
});

export const priceCandidateSchema = z.object({
  kind: z.enum(["최저입찰가", "감정가"]),
  amount: z.number().int().describe("원 단위 정수"),
  source: sourceSchema,
  quote: z.string().describe("근거 문장을 자료에서 그대로 복사한 것"),
});

export const extractionSchema = z.object({
  rights: z.array(rightSchema).describe("자료에서 확인된 권리 항목 전부. 하나도 없으면 빈 목록"),
  priceCandidates: z
    .array(priceCandidateSchema)
    .describe("자료에 적힌 예상 매각가 후보(최저 입찰가, 감정가). 없으면 빈 목록"),
});

export type AiRight = z.infer<typeof rightSchema>;
export type AiPriceCandidate = z.infer<typeof priceCandidateSchema>;
export type AiExtraction = z.infer<typeof extractionSchema>;
