// Design Ref: §1 — 경고·오류·"참고용" 문구를 한 부품으로 모아 쓴다.
// 종류(variant)에 따라 색만 달라진다: 경고(warning), 오류(error), 안내(info).

type NoticeBannerProps = {
  variant?: "warning" | "error" | "info";
  children: React.ReactNode;
};

const styles = {
  warning: "border-amber-400 bg-amber-50 text-amber-900",
  error: "border-red-400 bg-red-50 text-red-900",
  info: "border-sky-300 bg-sky-50 text-sky-900",
} as const;

const icons = {
  warning: "⚠",
  error: "✕",
  info: "ℹ",
} as const;

export default function NoticeBanner({
  variant = "info",
  children,
}: NoticeBannerProps) {
  return (
    <div
      role={variant === "error" ? "alert" : "note"}
      className={`flex gap-3 rounded-lg border px-4 py-3 text-sm leading-6 ${styles[variant]}`}
    >
      <span aria-hidden="true" className="font-bold">
        {icons[variant]}
      </span>
      <div>{children}</div>
    </div>
  );
}
