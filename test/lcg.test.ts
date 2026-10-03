import { test } from "node:test";
import assert from "node:assert/strict";
import { jumpAffine, jumpState, applyAffine, compose } from "../src/lcg";

// 手算序列：m=8, a=5, c=1, seed=0 -> 1, 6, 7, 4, 5, 2, 3, 0, 1, ...
const M = 8n, A = 5n, C = 1n, SEED = 0n;
const KNOWN = [1n, 6n, 7n, 4n, 5n, 2n, 3n, 0n];

function iterate(a: bigint, c: bigint, m: bigint, x: bigint, k: bigint): bigint {
  for (let i = 0n; i < k; i++) x = (a * x + c) % m;
  return x;
}

test("手算已知序列前几项", () => {
  let x = SEED;
  for (const expected of KNOWN) {
    x = (A * x + C) % M;
    assert.equal(x, expected);
  }
});

test("小 k 跳步与逐步迭代一致", () => {
  for (let k = 0n; k <= 20n; k++) {
    assert.equal(jumpState(A, C, M, SEED, k), iterate(A, C, M, SEED, k), `k=${k}`);
  }
});

test("k=0 保持原状态", () => {
  assert.equal(jumpState(A, C, M, 3n, 0n), 3n);
});

test("a=1, c=0 恒等变换", () => {
  assert.equal(jumpState(1n, 0n, 97n, 42n, 1000n), 42n);
});

test("a=1 纯增量（无需求逆）", () => {
  assert.equal(jumpState(1n, 7n, 100n, 5n, 13n), (5n + 7n * 13n) % 100n);
});

test("a=0 归零后只剩增量", () => {
  assert.equal(jumpState(0n, 3n, 10n, 9n, 1n), 3n);
  assert.equal(jumpState(0n, 3n, 10n, 9n, 50n), 3n);
});

test("合数模数且 a-1 不可逆（a 与 m 不互素）", () => {
  // m=12, a=4: a-1=3 与 12 不互素，无模逆；a 与 m 也不互素
  for (let k = 0n; k <= 30n; k++) {
    assert.equal(jumpState(4n, 5n, 12n, 7n, k), iterate(4n, 5n, 12n, 7n, k));
  }
});

test("复合关系 jump(u+v) = jump(v) ∘ jump(u)", () => {
  const m = 2n ** 31n - 1n;
  const a = 48271n, c = 12345n, x = 999983n;
  for (const [u, v] of [[3n, 5n], [100n, 250n], [0n, 7n]] as const) {
    const lhs = jumpState(a, c, m, x, u + v);
    const rhs = jumpState(a, c, m, jumpState(a, c, m, x, u), v);
    assert.equal(lhs, rhs);
  }
});

test("仿射复合顺序：compose(f,g) 先 g 后 f", () => {
  const m = 17n;
  const f = { mul: 3n, add: 2n };
  const g = { mul: 5n, add: 1n };
  const fg = compose(f, g, m);
  const x = 11n;
  assert.equal(applyAffine(fg, x, m), applyAffine(f, applyAffine(g, x, m), m));
});

test("超过安全整数的步号", () => {
  const big = 2n ** 60n + 12345n;
  const m = 2n ** 61n - 1n;
  const a = 6364136223846793005n % m;
  const c = 1442695040888963407n % m;
  const x = 88172645463325252n;
  // 用复合关系验证大步数（无法逐步迭代）
  const u = big / 2n, v = big - u;
  assert.equal(
    jumpState(a, c, m, x, big),
    jumpState(a, c, m, jumpState(a, c, m, x, u), v),
  );
  // 与已知小步数锚点拼接验证正确性
  const anchor = iterate(a, c, m, x, 1000n);
  assert.equal(
    jumpState(a, c, m, x, 1000n + big),
    jumpState(a, c, m, anchor, big),
  );
});

test("大模数下与逐步迭代抽样一致", () => {
  const m = 2n ** 48n;
  const a = 25214903917n, c = 11n, x = 12345n;
  for (const k of [1n, 2n, 3n, 100n, 1000n, 65536n]) {
    assert.equal(jumpState(a, c, m, x, k), iterate(a, c, m, x, k));
  }
});
