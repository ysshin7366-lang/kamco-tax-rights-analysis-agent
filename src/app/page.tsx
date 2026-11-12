import AnalyzerPanel from "@/components/AnalyzerPanel";
import NoticeBanner from "@/components/NoticeBanner";

// Design Ref: §1 ① 머리말 — 제목, 한 줄 안내, 사용 순서 3단계, 개인정보 경고(항상 표시)
// Plan SC: 첫 화면에 경고 문구가 보인다 (PLAN 작업 1)

const steps = [
  { title: "자료 올리기", body: "분석할 물건의 자료 파일(최대 15개)을 선택합니다." },
  { title: "분석하기", body: "버튼을 누르면 권리 순위와 배당 가능성을 정리합니다." },
  { title: "결과·근거 확인", body: "순위 표와 판단 근거, 계산 과정을 확인합니다." },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight">권리분석 에이전트</h1>
        <p className="text-base leading-7 text-zinc-600 dark:text-zinc-400">
          올린 자료로 권리 순위와 배당 가능성을 참고용으로 확인합니다.
        </p>
      </header>

      <NoticeBanner variant="warning">
        <strong>개인정보가 가려지지 않은 자료는 올리지 마세요.</strong>{" "}
        이름·주소·주민번호 등을 가린 자료나 가상(샘플) 자료만 사용해 주세요.
      </NoticeBanner>

      <ol className="grid gap-3 sm:grid-cols-3">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <p className="text-sm font-semibold text-sky-700 dark:text-sky-400">
              {index + 1}단계
            </p>
            <p className="mt-1 font-semibold">{step.title}</p>
            <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              {step.body}
            </p>
          </li>
        ))}
      </ol>

      <AnalyzerPanel />

      <p className="text-sm text-zinc-500">
        모든 결과는 참고용이며, 담당자 최종 확인이 필요합니다.
      </p>
    </main>
  );
}
