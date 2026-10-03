import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateNext, jump, powerMap, step } from '../dist/math.js';

/** 朴素逐步迭代，仅用于测试对照。 */
function slowJump(x: bigint, a: bigint, c: bigint, m: bigint, k: bigint): bigint {
  let cur = x;
  for (let i = 0n; i < k; i++) cur = (a * cur + c) % m;
  return cur;
}

test('手算序列：m=10,a=3,c=5,seed=7 前 5 项为 6,3,4,7,6', () => {
  const [m, a, c] = [10n, 3n, 5n];
  assert.deepEqual(generateNext(7n, a, c, m, 5), [6n, 3n, 4n, 7n, 6n]);
});

test('手算序列：a=1（纯加法）m=7,a=1,c=2,seed=1 前 4 项为 3,5,0,2', () => {
  assert.deepEqual(generateNext(1n, 1n, 2n, 7n, 4), [3n, 5n, 0n, 2n]);
});

test('a=0：首项后全部为 c', () => {
  assert.deepEqual(generateNext(4n, 0n, 9n, 11n, 3), [9n, 9n, 9n]);
  assert.equal(jump(4n, 0n, 9n, 11n, 50n), 9n);
});

test('c=0 且合数模数 m=12,a=5,seed=2', () => {
  assert.deepEqual(generateNext(2n, 5n, 0n, 12n, 4), [10n, 2n, 10n, 2n]);
});

test('k=0 保持原状态（包括大 k=0）', () => {
  for (const [a, c, m, x] of [
    [3n, 5n, 10n, 7n],
    [0n, 0n, 2n, 0n],
    [1n, 0n, 100n, 99n],
  ] as const) {
    assert.equal(jump(x, a, c, m, 0n), x);
  }
});

test('小 k：快速跳步与逐步迭代完全一致（多组参数扫描）', () => {
  const cases: Array<[bigint, bigint, bigint, bigint]> = [
    [3n, 5n, 10n, 7n],
    [1n, 2n, 7n, 1n],
    [0n, 9n, 11n, 4n],
    [5n, 0n, 12n, 2n],
    [22695477n, 1n, 2147483648n, 12345n], // 常见非素模 LCG 参数
    [5n, 3n, 17n, 1n],
  ];
  for (const [a, c, m, x] of cases) {
    for (let k = 0n; k <= 60n; k++) {
      assert.equal(
        jump(x, a, c, m, k),
        slowJump(x, a, c, m, k),
        `参数 (a=${a},c=${c},m=${m},x=${x}) k=${k} 不一致`,
      );
    }
  }
});

test('复合关系 jump(u+v,x) = jump(v, jump(u, x))，含超过安全整数的步号', () => {
  const [a, c, m, x] = [3n, 5n, 10n, 7n];
  const offsets = [0n, 1n, 2n, 3n, 7n, 100n, 9007199254740993n, 123456789012345678901234n];
  for (const u of offsets) {
    for (const v of offsets) {
      const lhs = jump(x, a, c, m, u + v);
      const rhs1 = jump(jump(x, a, c, m, u), a, c, m, v);
      const rhs2 = jump(jump(x, a, c, m, v), a, c, m, u);
      assert.equal(lhs, rhs1, `u=${u},v=${v}: jump(u+v)!=jump(v,jump(u))`);
      assert.equal(lhs, rhs2, `u=${u},v=${v}: jump(u+v)!=jump(u,jump(v))`);
    }
  }
});

test('极大模数与步数（200 位参数，30 位步号）仍为 O(log k) 即时完成', () => {
  const m = 10n ** 199n + 37n;
  const a = 10n ** 198n + 123456789n;
  const c = 987654321n;
  const x = m - 1n;
  const k = 99999999999999999999999999999n;
  const y = jump(x, a, c, m, k);
  assert.ok(y >= 0n && y < m);
  // 同一 k 重复计算结果一致
  assert.equal(jump(x, a, c, m, k), y);
  // 幂映射系数正确（结果映射应用于 x 应等于 y）
  const fk = powerMap(a, c, m, k);
  assert.equal((fk.A * x + fk.B) % m, y);
});

test('step 与 jump(x,1) 一致', () => {
  assert.equal(step(7n, 3n, 5n, 10n), jump(7n, 3n, 5n, 10n, 1n));
});

