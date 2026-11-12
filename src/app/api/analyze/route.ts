// Design Ref: §2 서버 API 1개 — POST /api/analyze
// 화면이 보낸 파일(여러 개)과 예상 매각가를 받아, 검사하고 글자를 읽어 답을 돌려준다.
// 지금(작업 4)은 "받아서 글자를 읽고 요약을 돌려주는" 뼈대까지만 있다. AI 연결은 작업 5.
// 올린 자료는 저장하지 않고 응답 후 버린다. 오류 기록에는 오류 종류만 남긴다. (DESIGN §6)

import { AiUnavailableError, extractRights } from "@/lib/server/aiClient";
import { judgeDividend } from "@/lib/server/judgeDividend";
import { checkRateLimit, clientKey } from "@/lib/server/rateLimit";
import { buildRanking } from "@/lib/server/rankRights";
import { splitCases } from "@/lib/server/splitCases";
import {
  ExtractError,
  extractAll,
  type InputFile,
} from "@/lib/server/extractText";
import {
  RATE_LIMIT_MESSAGE,
  TIMEOUT_MESSAGE,
  UNAVAILABLE_MESSAGE,
  type AnalyzeErrorCode,
  type AnalyzeErrorResponse,
  type AnalyzeSuccessResponse,
  type CaseResult,
} from "@/lib/types";
import { MAX_TOTAL_BYTES, MESSAGES, parsePrice } from "@/lib/validateUpload";

// 서버 최대 실행 시간 300초. Vercel Hobby 한도(300초)와 같다. (작업 4에서 문서로 확인함)
export const maxDuration = 300;

// 요청 전체 크기 상한: 파일 합계 4MB + 파일 이름 등 부가 정보 여유.
// Vercel 요청 크기 한도는 4.5MB라서 그 안쪽으로 둔다.
const MAX_REQUEST_BYTES = MAX_TOTAL_BYTES + 400 * 1024;

const STATUS: Record<AnalyzeErrorCode, number> = {
  invalid: 400,
  scanned: 422,
  unreadable: 422,
  tooBig: 413,
  rateLimited: 429,
  timeout: 504,
  unavailable: 500,
};

function fail(code: AnalyzeErrorCode, message: string) {
  const body: AnalyzeErrorResponse = { ok: false, code, message };
  return Response.json(body, { status: STATUS[code] });
}

export async function POST(request: Request) {
  try {
    // 1) 요청이 너무 크면 읽기 전에 돌려보낸다
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_REQUEST_BYTES) {
      return fail("tooBig", MESSAGES.tooBig);
    }

    // 2) 보낸 내용 꺼내기
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return fail("invalid", MESSAGES.badFormat);
    }

    const entries = formData.getAll("files");
    const uploaded = entries.filter(
      (entry): entry is File => typeof entry !== "string",
    );
    if (uploaded.length === 0) {
      return fail("invalid", "분석할 파일을 먼저 선택해 주세요.");
    }

    // 3) 예상 매각가 검사 (비어 있으면 입력하지 않은 것)
    const rawPrice = formData.get("price");
    const price = parsePrice(typeof rawPrice === "string" ? rawPrice : "");
    if (!price.ok) return fail("invalid", price.message);

    // 4) 파일 검사 + 글자 읽기 (하나라도 실패하면 전체 중단)
    const files: InputFile[] = await Promise.all(
      uploaded.map(async (file) => ({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const documents = await extractAll(files);

    // 4-2) 사용량 제한: AI 요금이 드는 단계 직전에 확인한다. 형식·크기 검사에서 걸린 요청은 횟수에 넣지 않는다.
    const limit = checkRateLimit(clientKey(request.headers));
    if (!limit.allowed) {
      const body: AnalyzeErrorResponse = {
        ok: false,
        code: "rateLimited",
        message: RATE_LIMIT_MESSAGE,
      };
      return Response.json(body, {
        status: STATUS.rateLimited,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      });
    }

    // 4-3) 자료에 사건번호가 여러 개 있으면 사건별로 나누어 각각 분석한다
    const bundles = splitCases(documents);
    if (bundles) {
      const summaries = documents.map((doc) => ({ name: doc.name, kind: doc.kind, pages: doc.pages, chars: doc.text.length }));
      const results: CaseResult[] = new Array(bundles.length);
      let next = 0;
      // 사건 3건씩 동시에 분석한다 (전체 시간을 줄이되 AI에 한꺼번에 몰리지 않게)
      const worker = async () => {
        while (next < bundles.length) {
          const index = next++;
          const bundle = bundles[index];
          const docSummaries = bundle.documents.map((d) => ({ name: d.name, kind: d.kind, pages: d.pages, chars: d.text.length }));
          try {
            const extraction = await extractRights(bundle.documents);
            const ranking = buildRanking(extraction, bundle.documents);
            const judgement = judgeDividend(ranking, price.value);
            results[index] = { key: bundle.key, label: bundle.label, owner: bundle.owner, documents: docSummaries, ranking, judgement, error: null };
          } catch (error) {
            const kind = error instanceof Error ? error.name : "UnknownError";
            console.error(`[analyze] 사건 분석 실패: ${kind}`); // 자료·AI 답은 기록하지 않는다
            const message = kind === "TimeoutError" || kind === "AbortError" ? TIMEOUT_MESSAGE : UNAVAILABLE_MESSAGE;
            results[index] = { key: bundle.key, label: bundle.label, documents: docSummaries, ranking: null, judgement: null, error: message };
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);

      const firstOk = results.find((r) => r.ranking && r.judgement);
      if (!firstOk || !firstOk.ranking || !firstOk.judgement) {
        return fail("unavailable", UNAVAILABLE_MESSAGE);
      }
      const body: AnalyzeSuccessResponse = {
        ok: true,
        documents: summaries,
        price: price.value,
        ranking: firstOk.ranking,
        judgement: firstOk.judgement,
        cases: results,
      };
      return Response.json(body);
    }

    // 5) AI에 1회 질문해 권리 항목을 읽어 낸다 (작업 5). 정리·순위·판정은 작업 6~8에서 이어 붙인다.
    const extraction = await extractRights(documents);

    // 6) 검증·정리하고 접수일자 순으로 순위를 매긴다 (작업 6, AI를 부르지 않는 고정 규칙)
    const ranking = buildRanking(extraction, documents);

    // 7) 배당 가능성을 판정한다 (작업 8, AI를 부르지 않는 고정 규칙)
    const judgement = judgeDividend(ranking, price.value);

    // 8) 요약·순위·판정을 돌려준다 (글자 전체는 화면으로 보내지 않는다)
    const body: AnalyzeSuccessResponse = {
      ok: true,
      documents: documents.map((doc) => ({
        name: doc.name,
        kind: doc.kind,
        pages: doc.pages,
        chars: doc.text.length,
      })),
      price: price.value,
      ranking,
      judgement,
    };
    return Response.json(body);
  } catch (error) {
    if (error instanceof ExtractError) {
      return fail(error.code, error.message);
    }
    // 그 밖의 문제: 이유는 화면에 드러내지 않고, 기록에는 오류 종류만 남긴다
    const kind = error instanceof Error ? error.name : "UnknownError";
    // AI 오류는 "종류+상태 번호"만 담겨 있어 기록해도 안전하다 (자료·키·AI 답은 담지 않는다)
    const detail = error instanceof AiUnavailableError ? ` (${error.message})` : "";
    console.error(`[analyze] 처리 실패: ${kind}${detail}`);
    if (kind === "TimeoutError" || kind === "AbortError") {
      return fail("timeout", TIMEOUT_MESSAGE);
    }
    return fail("unavailable", UNAVAILABLE_MESSAGE);
  }
}
