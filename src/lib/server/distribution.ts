// 배분계산 엔진 — 권리분석기준.md §4~§6 (교육자료 배분순위, 압류선착주의, 순환배분)
// 매각대금을 채권자에게 배분하는 금액 계산을 한다. 모두 고정 규칙이라 같은 입력이면 항상 같은 결과가 나온다.
//
//  배분 순서
//   1순위 강제징수비 → 3순위 당해세 → (조세·공과금·담보·일반채권은 아래 우열 규칙으로 비교)
//   * 조세 ↔ 조세 : 압류선착주의(법정기일과 무관). 교부청구(압류 없음)는 압류한 조세보다 뒤, 교부청구끼리는 동순위
//   * 납세담보 : 다른 조세채권에 항상 우선
//   * 조세 ↔ 담보 : 담보 설정일자가 조세 법정기일보다 빠르면 담보 우선, 같은 날이면 조세 우선
//   * 공과금 ↔ 담보 : 납부기한(없으면 압류일)과 설정일자 중 빠른 쪽 우선, 같은 날이면 동순위
//   * 조세 > 공과금 > 일반채권(가압류 등)
//   * 담보 ↔ 가압류 : 담보 설정이 가압류보다 빠르면 담보 우선, 늦으면 평등관계(가압류의 처분금지적 효력)
//  우열이 서로 맞물려 순서를 정할 수 없는 경우(순환관계)는 "1차 안분 → 2차 열후자로부터 흡수"로 계산한다. (교육자료 사례 5)
// 외부 패키지·경로 별칭을 쓰지 않아 단독으로 시험할 수 있다.

export type CreditorKind = "당해세" | "납세담보" | "조세" | "공과금" | "담보" | "일반";

export type Creditor = {
  id: string;
  /** 채권자 이름 */
  name: string;
  kind: CreditorKind;
  /** 권리관계 표시 (예: "국세 압류", "근저당권") */
  label: string;
  /** 실채권액(원). 근저당은 자료가 없으면 채권최고액을 쓴다 */
  amount: number;
  /** 압류일자·설정일자·가압류 접수일자 (YYYY-MM-DD). 교부청구처럼 압류가 없으면 null */
  baseDate: string | null;
  /** 조세의 법정기일, 공과금의 납부기한 (없으면 null → baseDate로 대신 비교) */
  lawDate: string | null;
  /** 설정금액(채권최고액 등, 표시용) */
  settledAmount?: number | null;
};

export type DistributionInput = {
  /** 배분할 금액 = 매각대금 + 예치이자 */
  fund: number;
  /** 강제징수비(1순위) */
  cost: number;
  creditors: Creditor[];
  /**
   * true이면 일반채권(가압류 등)을 항상 맨 뒤로 둔다: 조세·공과금·담보채권 모두 일반채권보다 앞선다.
   * 가압류와 그 뒤에 설정된 근저당권의 평등관계(순환배분)를 적용하지 않아, 국세·지방세 압류가 가압류보다 항상 선순위가 된다.
   * 공과금은 가압류와 동순위(채권액 비율로 안분)이며 조세·담보채권보다 뒤이다.
   * 국세·지방세 압류끼리는 압류일자(압류선착주의), 조세 압류와 근저당은 법정기일과 설정일 비교.
   * false(기본)이면 교육자료 사례 5처럼 평등관계와 순환배분을 적용한다.
   */
  generalLast?: boolean;
};

export type RelationOptions = { generalLast?: boolean };

export type AllocationGroup = "단독" | "동순위" | "순환";

export type Allocation = {
  creditor: Creditor;
  amount: number;
  /** 표시용 순위 번호 (강제징수비가 1순위, 그 다음부터 순서대로. 동순위·순환은 같은 번호) */
  rank: number;
  group: AllocationGroup;
  /** 채권액에서 배분받지 못한 부족분 */
  shortfall: number;
};

export type CircularStep = {
  member: string;
  claim: number;
  firstShare: number;
  lack: number;
  absorbed: { from: string; amount: number }[];
  finalAmount: number;
};

export type DistributionResult = {
  fund: number;
  cost: number;
  /** 실제 강제징수비 배분액 (배분할 금액이 모자라면 줄어들 수 있음) */
  costPaid: number;
  allocations: Allocation[];
  /** 순환배분 계산 과정 (순환관계가 없으면 빈 목록) */
  circular: { members: string[]; available: number; steps: CircularStep[] }[];
  /** 채권자에게 나눠 준 합계 (강제징수비 제외) */
  distributed: number;
  /** 모든 채권을 갚고 남은 금액 (체납자에게 지급) */
  surplus: number;
  notes: string[];
};

// ───────── 우열 비교 ─────────

/** 1: a가 우선, -1: b가 우선, 0: 동순위(평등) */
export function relation(a: Creditor, b: Creditor, options: RelationOptions = {}): 1 | 0 | -1 {
  const cmpDate = (x: string | null, y: string | null): 1 | 0 | -1 => {
    if (x === null && y === null) return 0;
    if (x === null) return -1; // 날짜(압류)가 있는 쪽이 앞
    if (y === null) return 1;
    return x < y ? 1 : x > y ? -1 : 0; // 빠른 날짜가 우선
  };
  const lawKey = (c: Creditor) => c.lawDate ?? c.baseDate;
  const flip = (r: 1 | 0 | -1): 1 | 0 | -1 => (r === 1 ? -1 : r === -1 ? 1 : 0);

  if (a.kind === b.kind) {
    return a.kind === "일반" ? 0 : cmpDate(a.baseDate, b.baseDate);
  }
  // 서로 다른 종류: 위쪽(작은 번호)이 a가 되도록 순서를 맞춰 비교한다
  const order: CreditorKind[] = ["당해세", "납세담보", "조세", "공과금", "담보", "일반"];
  const ia = order.indexOf(a.kind);
  const ib = order.indexOf(b.kind);
  if (ia > ib) return flip(relation(b, a, options));

  // 이제 a의 종류가 b보다 앞선 종류다
  switch (a.kind) {
    case "당해세":
    case "납세담보":
      return b.kind === "담보" && a.kind === "납세담보" ? cmpDate(a.baseDate, b.baseDate) : 1;
    case "조세": {
      if (b.kind === "공과금" || b.kind === "일반") return 1;
      // 조세 ↔ 담보: 담보 설정일이 조세 법정기일보다 빠르면 담보 우선, 같은 날이면 조세 우선
      const s = b.baseDate;
      const t = lawKey(a);
      if (s === null || t === null) return 1;
      return s < t ? -1 : 1;
    }
    case "공과금": {
      // 공과금은 가압류(일반채권)와 동순위로 보고, 담보채권보다는 뒤로 둔다(일반채권이 항상 맨 뒤인 기준)
      if (options.generalLast) return b.kind === "일반" ? 0 : -1;
      if (b.kind === "일반") return 1;
      // 공과금 ↔ 담보: 납부기한(없으면 압류일)과 설정일자 비교
      const d = lawKey(a);
      const s = b.baseDate;
      if (d === null || s === null) return 1;
      return d < s ? 1 : d > s ? -1 : 0;
    }
    case "담보": {
      // 일반채권을 항상 맨 뒤로 두는 기준이면 담보가 항상 앞선다
      if (options.generalLast) return 1;
      // 담보 ↔ 일반(가압류): 담보 설정이 먼저면 담보 우선, 아니면 평등
      const s = a.baseDate;
      const g = b.baseDate;
      if (s === null || g === null) return 0;
      return s < g ? 1 : 0;
    }
    default:
      return 0;
  }
}

// ───────── 정수 안분 ─────────

/** total을 weights 비율로 나눈다(원 단위, 최대잔여법). 합계는 정확히 total이 된다. */
export function prorate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const T = BigInt(total);
  const S = BigInt(sum);
  const base = weights.map((w) => (T * BigInt(w)) / S);
  const used = base.reduce((a, b) => a + b, BigInt(0));
  let left = Number(T - used);
  const remainders = weights
    .map((w, i) => ({ i, r: (T * BigInt(w)) % S }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const result = base.map((v) => Number(v));
  for (let k = 0; left > 0 && k < remainders.length; k++, left--) result[remainders[k].i] += 1;
  return result;
}

// ───────── 묶음(동순위·순환) 찾기 ─────────

type Component = { members: number[]; circular: boolean };

function buildComponents(creditors: Creditor[], options: RelationOptions): Component[] {
  const n = creditors.length;
  const rel: (1 | 0 | -1)[][] = creditors.map((a) =>
    creditors.map((b) => (a === b ? 0 : relation(a, b, options))),
  );

  // 동순위로 묶기
  const parent = creditors.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rel[i][j] === 0) parent[find(i)] = find(j);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  const groupList = [...groups.values()];
  const groupOf = new Array<number>(n);
  groupList.forEach((g, gi) => g.forEach((m) => (groupOf[m] = gi)));

  // 묶음 사이의 우선 관계 → 강연결요소(순환) 찾기
  const G = groupList.length;
  const edges: number[][] = Array.from({ length: G }, () => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (rel[i][j] === 1 && groupOf[i] !== groupOf[j] && !edges[groupOf[i]].includes(groupOf[j])) {
        edges[groupOf[i]].push(groupOf[j]);
      }
  let index = 0;
  const idx = new Array<number>(G).fill(-1);
  const low = new Array<number>(G).fill(0);
  const onStack = new Array<boolean>(G).fill(false);
  const stack: number[] = [];
  const sccs: number[][] = [];
  const strong = (v: number) => {
    idx[v] = low[v] = index++;
    stack.push(v);
    onStack[v] = true;
    for (const w of edges[v]) {
      if (idx[w] === -1) {
        strong(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop() as number;
        onStack[w] = false;
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  };
  for (let v = 0; v < G; v++) if (idx[v] === -1) strong(v);

  const compOfGroup = new Array<number>(G);
  sccs.forEach((c, ci) => c.forEach((g) => (compOfGroup[g] = ci)));
  const comps: Component[] = sccs.map((c) => {
    const members = c.flatMap((g) => groupList[g]).sort((a, b) => a - b);
    // 묶음이 둘 이상이거나, 한 묶음 안에 서로 우열이 있으면 순환관계
    const strictInside = members.some((i) => members.some((j) => rel[i][j] === 1));
    return { members, circular: c.length > 1 || strictInside };
  });

  // 위쪽 요소부터 처리하도록 위상 정렬 (같은 단계는 이른 날짜·이름 순으로 고정)
  const cn = comps.length;
  const cEdges: Set<number>[] = Array.from({ length: cn }, () => new Set<number>());
  const indeg = new Array<number>(cn).fill(0);
  for (let g = 0; g < G; g++)
    for (const w of edges[g]) {
      const a = compOfGroup[g];
      const b = compOfGroup[w];
      if (a !== b && !cEdges[a].has(b)) {
        cEdges[a].add(b);
        indeg[b]++;
      }
    }
  const sortKey = (c: Component) => {
    const first = c.members
      .map((i) => creditors[i])
      .sort((a, b) => ((a.baseDate ?? "9999") < (b.baseDate ?? "9999") ? -1 : 1))[0];
    return `${first.baseDate ?? "9999-99-99"}|${first.id}`;
  };
  const ready = comps.map((_, i) => i).filter((i) => indeg[i] === 0);
  const ordered: Component[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (sortKey(comps[a]) < sortKey(comps[b]) ? -1 : 1));
    const v = ready.shift() as number;
    ordered.push(comps[v]);
    for (const w of cEdges[v]) if (--indeg[w] === 0) ready.push(w);
  }
  return ordered;
}

// ───────── 배분 ─────────

export function distribute(input: DistributionInput): DistributionResult {
  const { creditors } = input;
  const notes: string[] = [];
  const costPaid = Math.min(input.cost, input.fund);
  let remaining = input.fund - costPaid;
  if (costPaid < input.cost) notes.push("배분할 금액이 강제징수비보다 적어 강제징수비도 일부만 배분했습니다.");

  const amountOf = new Map<string, number>();
  const groupOf = new Map<string, AllocationGroup>();
  const rankOf = new Map<string, number>();
  const circular: DistributionResult["circular"] = [];

  const options: RelationOptions = { generalLast: input.generalLast };
  const components = buildComponents(creditors, options);
  let rank = 1; // 1순위는 강제징수비

  for (const comp of components) {
    rank++;
    const members = comp.members.map((i) => creditors[i]);
    const claims = members.map((m) => m.amount);
    const total = claims.reduce((a, b) => a + b, 0);
    members.forEach((m) => rankOf.set(m.id, rank));

    if (remaining >= total) {
      // 전액 배분
      members.forEach((m) => amountOf.set(m.id, m.amount));
      members.forEach((m) => groupOf.set(m.id, comp.circular ? "순환" : members.length > 1 ? "동순위" : "단독"));
      remaining -= total;
      continue;
    }

    if (!comp.circular) {
      // 단독 또는 동순위: 남은 금액을 채권액 비율로 안분
      const shares = prorate(remaining, claims);
      members.forEach((m, i) => {
        amountOf.set(m.id, shares[i]);
        groupOf.set(m.id, members.length > 1 ? "동순위" : "단독");
      });
      remaining = 0;
      continue;
    }

    // 순환배분: 1차 안분 → 2차 열후자로부터 흡수
    const available = remaining;
    const first = prorate(available, claims);
    const lack = members.map((m, i) => m.amount - first[i]);
    const current = [...first];
    const pool = [...first];
    const higher = (x: number, y: number) => relation(members[x], members[y], options) === 1;
    const score = members.map((_, x) => {
      let s = 0;
      members.forEach((_, y) => {
        if (x !== y && higher(x, y)) s++;
        if (x !== y && higher(y, x)) s--;
      });
      return s;
    });
    // 우선하는 쪽부터 처리하고, 한 채권자는 자기보다 열후한 채권자(낮은 쪽부터)의 1차 안분액에서 부족분만큼 흡수한다
    const order = members.map((_, i) => i).sort((a, b) => (score[b] !== score[a] ? score[b] - score[a] : a - b));
    const absorbed: { from: string; amount: number }[][] = members.map(() => []);
    for (const x of order) {
      let need = lack[x];
      const lowers = members
        .map((_, y) => y)
        .filter((y) => y !== x && higher(x, y))
        .sort((a, b) => (score[a] !== score[b] ? score[a] - score[b] : a - b)); // 가장 열후한 쪽부터
      for (const y of lowers) {
        if (need <= 0) break;
        const take = Math.min(need, pool[y]);
        if (take > 0) {
          current[x] += take;
          current[y] -= take;
          pool[y] -= take;
          need -= take;
          absorbed[x].push({ from: members[y].name, amount: take });
        }
      }
    }
    members.forEach((m, i) => {
      amountOf.set(m.id, current[i]);
      groupOf.set(m.id, "순환");
    });
    circular.push({
      members: members.map((m) => m.name),
      available,
      steps: members.map((m, i) => ({
        member: m.name,
        claim: m.amount,
        firstShare: first[i],
        lack: lack[i],
        absorbed: absorbed[i],
        finalAmount: current[i],
      })),
    });
    notes.push(
      "순환관계가 있는 채권(가압류와 그 뒤의 근저당권, 조세채권 등)은 교육자료 사례 5의 방식(1차 안분 후 열후자로부터 흡수)으로 계산했습니다. 참고용이며 관계가 복잡하면 실제 계산과 다를 수 있습니다.",
    );
    remaining = 0;
  }

  const allocations: Allocation[] = [...creditors]
    .map((c) => ({
      creditor: c,
      amount: amountOf.get(c.id) ?? 0,
      rank: rankOf.get(c.id) ?? rank,
      group: groupOf.get(c.id) ?? ("단독" as AllocationGroup),
      shortfall: c.amount - (amountOf.get(c.id) ?? 0),
    }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.creditor.id < b.creditor.id ? -1 : 1));

  const distributed = allocations.reduce((s, a) => s + a.amount, 0);
  return {
    fund: input.fund,
    cost: input.cost,
    costPaid,
    allocations,
    circular,
    distributed,
    surplus: input.fund - costPaid - distributed,
    notes: [...new Set(notes)],
  };
}
