// 线性同余生成器核心数学模块。
// 一步变换视为模 m 下的仿射函数 f(x) = (a*x + c) mod m，
// 用 (mul, add) 表示仿射映射 x -> mul*x + add (mod m)。
// 复合约定：compose(f, g) 表示“先应用 g，再应用 f”，即 f∘g。

export interface Affine {
  mul: bigint;
  add: bigint;
}

export function compose(f: Affine, g: Affine, m: bigint): Affine {
  // (f∘g)(x) = f.mul*(g.mul*x + g.add) + f.add
  return {
    mul: (f.mul * g.mul) % m,
    add: (f.mul * g.add + f.add) % m,
  };
}

export function applyAffine(f: Affine, x: bigint, m: bigint): bigint {
  return (f.mul * x + f.add) % m;
}

// 计算 k 步复合变换，O(log k)，k 必须为非负整数。
export function jumpAffine(a: bigint, c: bigint, m: bigint, k: bigint): Affine {
  if (k < 0n) throw new Error("k must be non-negative");
  let result: Affine = { mul: 1n, add: 0n }; // 恒等映射
  let base: Affine = { mul: a % m, add: c % m };
  let e = k;
  while (e > 0n) {
    if (e & 1n) result = compose(base, result, m); // result <- base∘result
    base = compose(base, base, m);
    e >>= 1n;
  }
  return result;
}

// 直接计算 k 步后的状态。
export function jumpState(a: bigint, c: bigint, m: bigint, x: bigint, k: bigint): bigint {
  return applyAffine(jumpAffine(a, c, m, k), x, m);
}
