/**
 * 线性同余发生器的仿射跳步数学（全程 BigInt，不经过 Number）。
 *
 * 一步变换：x_next = (a * x + c) mod m
 * 记作仿射函数 f(x) = A * x + B (mod m)，本模块内用 [A, B] 表示。
 *
 * 复合约定（先 g 后 f）：
 *   compose(f, g)(x) = f(g(x))
 * 即“先走 g 对应的步数，再走 f 对应的步数”。
 * 因而 k 步变换 f^k 通过快速幂求 compose 得到：
 *   f^(u+v) = compose(f^u, f^v)
 *   jump(u+v, x) = jump(u, jump(v, x)) = jump(v, jump(u, x))
 *
 * 注意：不使用 (a^k - 1)/(a - 1) 的普通除法，也不假设 a-1 在模 m
 * 下存在逆元（合法参数不保证可逆，例如合数模数、a=1 等）。
 * 复杂度 O(log k)，k 为 0n 时直接返回恒等映射 [1, 0]，状态保持不变。
 */

export interface AffineMap {
  /** 乘系数 A (mod m) */
  readonly A: bigint;
  /** 加系数 B (mod m) */
  readonly B: bigint;
}

/** f(g(x))：先应用 g，再应用 f。返回的映射步数 = f 步数 + g 步数。 */
export function compose(f: AffineMap, g: AffineMap, m: bigint): AffineMap {
  return {
    A: (f.A * g.A) % m,
    B: (f.A * g.B + f.B) % m,
  };
}

/** 恒等映射，对应 0 步。 */
export function identity(): AffineMap {
  return { A: 1n, B: 0n };
}

/**
 * 求一步变换 f(x) = (a x + c) mod m 的 k 次复合 f^k。
 * k 必须为非负整数。二进制平方幂，O(log k)。
 */
export function powerMap(
  a: bigint,
  c: bigint,
  m: bigint,
  k: bigint,
): AffineMap {
  if (k < 0n) throw new RangeError('步数必须为非负整数');
  let result: AffineMap = identity(); // 累计的答案
  let cur: AffineMap = { A: ((a % m) + m) % m, B: ((c % m) + m) % m };
  let exp = k;
  while (exp > 0n) {
    if (exp & 1n) {
      // result = cur ∘ result 亦可，二者给出相同幂；
      // 这里采用 result = result ∘ cur，语义为“先走 cur 再走已有 result”。
      result = compose(result, cur, m);
    }
    cur = compose(cur, cur, m);
    exp >>= 1n;
  }
  return result;
}

/** 从状态 x 出发，跳 k 步后到达的状态。k=0 时原样返回。 */
export function jump(
  x: bigint,
  a: bigint,
  c: bigint,
  m: bigint,
  k: bigint,
): bigint {
  if (k === 0n) return x;
  const fk = powerMap(a, c, m, k);
  return (fk.A * x + fk.B) % m;
}

/** 单步：x_next = (a*x + c) mod m。 */
export function step(x: bigint, a: bigint, c: bigint, m: bigint): bigint {
  return (a * x + c) % m;
}

/**
 * 从状态 x 出发，依次生成“接下来的” n 个状态（不含 x 自身）。
 * 用于小 n 的批量生成；返回数组长度等于 n。
 */
export function generateNext(
  x: bigint,
  a: bigint,
  c: bigint,
  m: bigint,
  n: number,
): bigint[] {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError('生成数量必须为非负安全整数');
  }
  const out: bigint[] = [];
  let cur = x;
  for (let i = 0; i < n; i++) {
    cur = step(cur, a, c, m);
    out.push(cur);
  }
  return out;
}
