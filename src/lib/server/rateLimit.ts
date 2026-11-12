// 사용량 제한 — 로그인이 없는 공개 주소에서 AI 사용 요금이 무제한으로 나가지 않도록 막는다.
//   1) 같은 접속 주소(IP)당 1시간에 20회까지
//   2) 서버 한 대 기준 하루 전체 300회까지
// 데이터베이스 없이 서버 메모리에만 기록한다. (PRD: 저장·DB 기능은 만들지 않음)
//   - 서버가 다시 시작되면 기록이 사라진다. 운영(Vercel)에서는 서버가 수시로 새로 떠서(작업 중 약 5건마다 확인됨)
//     이 제한만으로는 부족하다. → 서버 대수와 무관한 Vercel 방화벽 규칙(접속 주소당 10분에 20회)을 함께 쓴다.
//   - 확실한 금액 상한은 OpenAI의 월 사용 한도로 따로 건다.
// 기록하는 것은 접속 주소와 시각뿐이며, 올린 자료는 기록하지 않는다.
// 한도는 환경변수 RATE_LIMIT_PER_HOUR, RATE_LIMIT_PER_DAY로 바꿀 수 있다.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function readLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// 접속 주소별 요청 시각, 전체 요청 시각 (서버 메모리)
const perIp = new Map<string, number[]>();
let global: number[] = [];
let lastCleanup = 0;

function prune(times: number[], windowMs: number, now: number): number[] {
  const from = now - windowMs;
  let start = 0;
  while (start < times.length && times[start] <= from) start++;
  return start === 0 ? times : times.slice(start);
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * 요청 한 번을 기록하고 허용 여부를 돌려준다. 허용될 때만 횟수에 들어간다.
 * @param key 접속 주소(없으면 "unknown")
 * @param now 현재 시각(시험용으로 바꿀 수 있다)
 */
export function checkRateLimit(key: string, now: number = Date.now()): RateLimitResult {
  // 내 컴퓨터(npm run dev)에서 반복해서 확인할 때 막히지 않도록, 운영 배포가 아닐 때는 제한하지 않는다.
  // (시험할 때는 환경변수 RATE_LIMIT_FORCE=1로 켤 수 있다)
  if (process.env.NODE_ENV !== "production" && !process.env.RATE_LIMIT_FORCE) {
    return { allowed: true };
  }

  const perHour = readLimit("RATE_LIMIT_PER_HOUR", 20);
  const perDay = readLimit("RATE_LIMIT_PER_DAY", 300);

  // 오래된 기록을 가끔 정리해 메모리가 계속 늘지 않게 한다
  if (now - lastCleanup > HOUR_MS) {
    lastCleanup = now;
    for (const [ip, times] of perIp) {
      const kept = prune(times, HOUR_MS, now);
      if (kept.length === 0) perIp.delete(ip);
      else perIp.set(ip, kept);
    }
  }

  global = prune(global, DAY_MS, now);
  const mine = prune(perIp.get(key) ?? [], HOUR_MS, now);

  if (mine.length >= perHour) {
    const wait = Math.ceil((mine[0] + HOUR_MS - now) / 1000);
    perIp.set(key, mine);
    return { allowed: false, retryAfterSeconds: Math.max(wait, 1) };
  }
  if (global.length >= perDay) {
    const wait = Math.ceil((global[0] + DAY_MS - now) / 1000);
    perIp.set(key, mine);
    return { allowed: false, retryAfterSeconds: Math.max(wait, 1) };
  }

  mine.push(now);
  perIp.set(key, mine);
  global.push(now);
  return { allowed: true };
}

/** 요청에서 접속 주소를 읽는다. (Vercel 뒤에서는 전달 헤더에 들어 있다) */
export function clientKey(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for");
  const real = headers.get("x-real-ip");
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0];
  return (vercel ?? real ?? forwarded ?? "unknown").trim() || "unknown";
}

/** 시험용: 기록을 모두 지운다 */
export function resetRateLimit(): void {
  perIp.clear();
  global = [];
  lastCleanup = 0;
}
