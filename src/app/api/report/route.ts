// 대시보드의 분석 결과를 한글(.hwpx) 보고서로 만들어 내려받게 한다. (POST /api/report)
// 화면이 이미 가진 분석 결과(JSON)를 다시 보내 주면, 양식 폴더의 양식에 채워 .zip으로 돌려준다.
// AI를 부르지 않고 자료 파일도 받지 않는다. 결과는 저장하지 않고 응답 후 버린다.

import { buildReportZip, type ExtraTax, type ReportCase } from "@/lib/server/buildReport";
import type { AnalyzeSuccessResponse } from "@/lib/types";

const MAX_BODY_BYTES = 3 * 1024 * 1024;

const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return bad("보낸 내용이 너무 큽니다.", 413);
    const body = (await request.json()) as { result?: AnalyzeSuccessResponse; caseKey?: string; prices?: Record<string, number | null>; extras?: Record<string, ExtraTax[]> };
    const result = body.result;
    if (!result || result.ok !== true || !result.ranking || !result.judgement) return bad("보고서로 만들 분석 결과가 없습니다.");

    // 사건별 결과가 있으면 그것을, 없으면 한 건짜리 결과를 보고서 한 건으로 만든다
    // 사건별 예상 매각금액: 사건마다 따로 보낸 값을 우선하고, 없으면 분석할 때 입력한 값을 쓴다
    const priceOf = (key: string): number | null => {
      const own = body.prices?.[key];
      if (typeof own === "number" && Number.isSafeInteger(own) && own > 0) return own;
      return typeof result.price === "number" ? result.price : null;
    };
    const cleanExtras = (list: ExtraTax[] | undefined): ExtraTax[] =>
      (list ?? [])
        .filter((e) => e && typeof e.holder === "string" && typeof e.taxKind === "string" && Number.isSafeInteger(e.amount) && e.amount > 0)
        .map((e) => ({ ...e, lawDate: typeof e.lawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.lawDate) ? e.lawDate : null }))
        .slice(0, 10);
    let cases: ReportCase[];
    if (result.cases) {
      cases = result.cases
        .filter((c) => c.ranking && c.judgement && (!body.caseKey || c.key === body.caseKey))
        .map((c) => ({ key: c.key, label: c.label, owner: c.owner ?? "", ranking: c.ranking!, judgement: c.judgement!, price: priceOf(c.key), extras: cleanExtras(body.extras?.[c.key]) }));
    } else {
      cases = [{ key: "분석결과", label: "", owner: "", ranking: result.ranking, judgement: result.judgement, price: priceOf("분석결과"), extras: cleanExtras(body.extras?.["분석결과"]) }];
    }
    if (cases.length === 0) return bad("보고서로 만들 사건이 없습니다.");

    const zip = buildReportZip(cases);
    const name = body.caseKey ? `권리분석_보고서_사건${body.caseKey}.zip` : "권리분석_보고서.zip";
    return new Response(Buffer.from(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="report.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error(`[report] 처리 실패: ${error instanceof Error ? error.name : "UnknownError"}`);
    return bad("보고서를 만들 수 없습니다. 잠시 후 다시 시도해 주세요.", 500);
  }
}
