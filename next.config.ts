import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // 보고서 양식(.hwpx)을 배포본에도 포함시킨다 (/api/report가 실행 중에 읽는다)
  outputFileTracingIncludes: {
    "/api/report": ["./양식/**/*"],
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
