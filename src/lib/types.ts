// Design Ref: §2.3 주고받는 정보의 모양 — 화면과 서버가 함께 쓰는 공용 모양.
// 지금(작업 4)은 "파일을 받아 글자를 읽었다"까지의 뼈대만 있다.
// 권리 목록·판정·근거 칸은 작업 5~9에서 이 파일에 이어서 채운다.

import type { RIGHT_TYPES } from "@/lib/aiSchema";

// ───────── 권리 정리·순위 결과 (작업 6) ─────────

export type RightType = (typeof RIGHT_TYPES)[number];

/** 화면에 표시할 상태 (용어 정의: DESIGN §2.2) */
export type RightStatus = "정상" | "확인 불가" | "사람 확인 필요";

/**
 * 위임기관 조세채권(기준 권리)과 비교한 배분 순서상의 위치
 * - 선순위: 배분에서 기준 권리보다 앞서는 채권 / 후순위: 뒤인 채권
 * - 해당 없음: 배분받는 채권이 아닌 권리(가처분·가등기·지상권·경매개시결정 등)
 */
export type Position = "선순위" | "기준" | "후순위" | "미정" | "해당 없음";

/** 말소기준권리와 비교한 처분 (권리분석기준.md §3.3 총괄표) */
export type Disposition = "말소기준권리" | "인수" | "소멸" | "확인 필요";

/** 출처: 문서명은 필수, 쪽은 PDF일 때만 있다(.txt는 null) */
export type SourceRef = {
  document: string;
  page: number | null;
  /** 자료에서 그대로 가져온 근거 문장 */
  quote: string;
};

export type RankedRight = {
  id: string;
  type: RightType;
  holder: string | null;
  /** 접수 일자(YYYY-MM-DD). 없거나 문서끼리 다르면 null */
  receiptDate: string | null;
  receiptNo: string | null;
  /** 원 단위. 없거나 문서끼리 다르면 null */
  amount: number | null;
  registered: "등기" | "미등기" | "모름";
  note: string;
  sources: SourceRef[];
  status: RightStatus;
  /** 상태의 이유(쉬운 말) */
  statusReasons: string[];
  /** 자료에 없는 칸 이름 (예: "접수일자", "금액") */
  missingFields: string[];
  position: Position;
  /** 말소기준권리 기준의 처분: 말소기준권리 / 인수(낙찰자가 부담) / 소멸(매각으로 말소) / 확인 필요 */
  disposition: Disposition;
  /** 예상 배분순위 1~9순위 (배분받는 채권이 아니면 null, 권리분석기준.md §4) */
  tier: number | null;
  /** 배분순위 설명 (예: "5순위 담보채권") */
  tierLabel: string | null;
  /** 조세 압류의 법정기일 (공과금·그 밖의 권리는 null). 보고서의 배분 계산에 쓴다 */
  lawDate?: string | null;
  /** 조세 압류의 세목 (자료에 없으면 null) */
  taxKind?: string | null;
  /** 접수일자 순 순위. 순서를 정할 수 없는 항목이 하나라도 있으면 모두 null */
  rank: number | null;
  /** true면 이 항목 때문에 판정을 보류한다 (작업 8에서 사용) */
  blocksJudgement: boolean;
};

export type ExcludedItem = {
  /** 예: "근저당 가상은행" */
  description: string;
  reason: string;
};

export type Conflict = {
  right: string;
  field: "접수일자" | "금액";
  values: { value: string; document: string; page: number | null }[];
};

export type VerifiedPriceCandidate = {
  kind: "최저입찰가" | "감정가";
  amount: number;
  source: SourceRef;
};

// ───────── 배당 가능성 판정 (작업 8) ─────────

export type JudgementResult = "높음" | "보통" | "낮음" | "판정 보류" | "판정 안 함";

export type PriceOrigin = "입력" | "최저입찰가" | "감정가";

export type UsedPrice = {
  value: number;
  origin: PriceOrigin;
  /** 자료에서 읽은 값이면 출처, 사용자가 입력한 값이면 null */
  source: SourceRef | null;
};

/** 판정의 근거로 보여줄 자료 (최소 1개 이상 붙는다) */
export type EvidenceItem = {
  label: string;
  role: "선순위" | "기준 권리" | "보류 원인" | "예상 매각가";
  sources: SourceRef[];
};

/** 공매 착수 vs 반려 검토 의견 (권리분석기준.md §9). 앱은 결정하지 않고 참고 의견만 낸다. */
export type Recommendation = {
  decision: "공매 착수 검토" | "신중 검토" | "공매 반려(해제 협의) 검토" | "판단 보류";
  reasons: string[];
};

export type DividendJudgement = {
  /** 공매 착수/반려 검토 의견 */
  recommendation: Recommendation;
  result: JudgementResult;
  /** 판정 보류·판정 안 함이면 null */
  method: "금액 기준" | "개수 기준" | null;
  /** 개수 기준으로 판정한 이유 (금액 기준이면 비어 있음) */
  methodReasons: string[];
  seniorCount: number;
  /** 금액 기준일 때만 값이 있다 (원) */
  seniorSum: number | null;
  price: UsedPrice | null;
  /** 예상 매각가에 대한 안내 (자료끼리 값이 다름 등) */
  priceNotes: string[];
  /** 비율 글자 (예: "50.00%", 소수 둘째 자리 버림). 금액 기준일 때만 */
  ratioText: string | null;
  /** 경계값을 근소하게 넘었을 때의 안내 */
  boundaryNote: string | null;
  /** 적용한 기준표 한 줄 (예: "50% 이상 80% 이하 → 보통") */
  bandText: string | null;
  /** 계산 과정 (한 줄씩) */
  calculation: string[];
  /** 판정 보류의 이유 */
  holdReasons: string[];
  /** 판정 안 함의 이유 (예: 권리 항목 없음) */
  noJudgementReason: string | null;
  evidence: EvidenceItem[];
};

export type RankingResult = {
  /** 순위 계산 대상 권리 (정렬된 순서) */
  rights: RankedRight[];
  /** 말소된 항목 (계산에서 뺌) */
  cancelled: RankedRight[];
  /** 등기되지 않은 임차인 (계산에서 뺌, 판정 보류의 원인 아님) */
  unregisteredTenants: RankedRight[];
  /** 출처가 없거나 원문 확인에 실패해 뺀 항목 */
  excluded: ExcludedItem[];
  /** 문서끼리 어긋난 값 */
  conflicts: Conflict[];
  reference: RankedRight | null;
  /** 말소기준권리 (찾지 못했거나 정할 수 없으면 null) */
  malsoStandard: RankedRight | null;
  /** 공매 반려(해제 협의)를 검토해야 하는 사유 (최선순위 가등기·가처분, 말소 예고등기 등) */
  proceedBlockers: string[];
  /** 조건부 진행 사유 (말소기준권리 뒤이지만 위임기관 압류보다 앞선 가등기·가처분 등) */
  conditions: string[];
  /** 낙찰자가 인수하게 되는 권리 안내 */
  burdens: string[];
  /** 자료가 없어 가정한 내용 (예: 법정기일 미확인 → 압류일자로 대체) */
  assumptions: string[];
  /** 판정 보류의 이유 (비어 있으면 보류 아님). 권리가 0건인 경우는 작업 8에서 따로 다룬다 */
  holdReasons: string[];
  /** AI가 항목을 찾았지만 전부 원문 확인에 실패한 경우 true */
  allItemsFailedVerification: boolean;
  /** 순위 번호를 붙였는지 */
  ranksAssigned: boolean;
  /** 반영하지 않은 규칙 안내 */
  unappliedRules: string[];
  /** 원문 확인을 통과한 예상 매각가 후보 */
  priceCandidates: VerifiedPriceCandidate[];
};

/** 서버가 돌려주는 오류 종류 (DESIGN §2.3). 화면에는 종류별 안내 문구만 보여준다. */
export type AnalyzeErrorCode =
  | "invalid" // 파일 개수 초과·형식 불가·크기 초과·매각가 입력 오류 등 올린 내용의 문제
  | "scanned" // 글자가 없는 파일(스캔본)
  | "unreadable" // 빈 파일·암호 PDF·깨진 파일
  | "tooBig" // 파일·글자 수 초과
  | "rateLimited" // 사용량 제한 초과 (같은 주소에서 너무 자주 요청)
  | "timeout" // 시간 초과
  | "unavailable"; // AI·서버 문제 (내부 이유는 화면에 드러내지 않음)

export type AnalyzeErrorResponse = {
  ok: false;
  code: AnalyzeErrorCode;
  /** 화면에 그대로 보여줄 안내 문구 */
  message: string;
};

/** 읽어 낸 파일 한 개의 요약 (글자 전체는 화면으로 보내지 않는다) */
export type DocumentSummary = {
  name: string;
  kind: "txt" | "pdf" | "hwpx" | "xlsx";
  /** PDF 쪽 수 (그 밖의 형식은 null) */
  pages: number | null;
  /** 읽어 낸 글자 수 */
  chars: number;
};

export type AnalyzeSuccessResponse = {
  ok: true;
  documents: DocumentSummary[];
  /** 사용자가 입력한 예상 매각가 (입력하지 않았으면 null) */
  price: number | null;
  /** 정리·순위를 매긴 결과 (작업 6). 배당 가능성 판정은 작업 8에서 이어 붙인다 */
  ranking: RankingResult;
  /** 배당 가능성 판정 (작업 8). 화면에는 작업 9에서 붙인다 */
  judgement: DividendJudgement;
  /**
   * 자료에 사건번호(사례번호)가 여러 개 들어 있으면 사건별로 나누어 분석한 결과.
   * 이 칸이 있으면 화면은 위의 ranking·judgement 대신 이 목록을 보여준다. (위 두 칸은 첫 사건의 값)
   */
  cases?: CaseResult[];
};

/** 사건 한 건의 분석 결과 */
export type CaseResult = {
  /** 자료에 적힌 사건번호 (예: "001") */
  key: string;
  /** 부동산 표시 등 사건을 알아보기 위한 짧은 설명 (없으면 빈 글자) */
  label: string;
  /** 소유자(체납자) 이름 — 자료에서 찾은 경우만 (없으면 빈 글자) */
  owner?: string;
  /** 이 사건 분석에 쓴 자료 조각 */
  documents: DocumentSummary[];
  /** 분석에 성공하면 들어 있다 */
  ranking: RankingResult | null;
  judgement: DividendJudgement | null;
  /** 이 사건만 실패했을 때의 안내 문구 */
  error: string | null;
};

export type AnalyzeResponse = AnalyzeSuccessResponse | AnalyzeErrorResponse;

/** 서버·화면 공용 안내 문구 */
export const UNAVAILABLE_MESSAGE =
  "지금은 분석할 수 없습니다. 잠시 후 다시 시도해 주세요.";
export const RATE_LIMIT_MESSAGE =
  "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
export const TIMEOUT_MESSAGE =
  "분석 시간이 너무 오래 걸립니다. 파일을 줄이거나 잠시 후 다시 시도해 주세요.";
