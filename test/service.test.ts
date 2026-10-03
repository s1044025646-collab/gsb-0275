import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { LcgService, type StreamView } from '../dist/service.js';
import { ValidationError } from '../dist/validate.js';
import { jump } from '../dist/math.js';

let dir: string;
let store: Store;
let svc: LcgService;
let storeClosed = false;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lcg-test-'));
  store = new Store(join(dir, 't.sqlite'));
  svc = new LcgService(store);
  storeClosed = false;
});

afterEach(() => {
  if (!storeClosed) store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('创建流：参数校验与错误码', () => {
  assert.throws(() => svc.create({ m: '1', a: '0', c: '0', seed: '0' }), (e: Error) => {
    return e instanceof ValidationError && e.code === 'M_TOO_SMALL';
  });
  assert.throws(() => svc.create({ m: '10', a: '10', c: '0', seed: '0' }), (e: Error) => {
    return e instanceof ValidationError && e.code === 'OUT_OF_RANGE';
  });
  assert.throws(() => svc.create({ m: '10', a: '1.5', c: '0', seed: '0' }), (e: Error) => {
    return e instanceof ValidationError && e.code === 'INVALID_INTEGER';
  });
  // 超过安全整数但以字符串传入是允许的；以 number 传入缺字段类型报错
  assert.throws(() => svc.create({ m: 10, a: 3, c: 5, seed: 7 }), (e: Error) => {
    return e instanceof ValidationError && e.code === 'MISSING_FIELD';
  });
});

test('生成 N 个状态：不含当前种子，位置与版本推进', () => {
  const s = svc.create({ m: '10', a: '3', c: '5', seed: '7' });
  const r = svc.generate(s.id, 5, 1);
  assert.deepEqual(r.values, ['6', '3', '4', '7', '6']);
  assert.equal(r.startPosition, '0');
  assert.equal(r.endPosition, '5');
  assert.equal(r.stream.version, 2);
  assert.equal(r.stream.state, '6');
  assert.equal(r.stream.position, '5');

  // 下一批接着第 5 个位置之后：当前 state=6 -> 3
  const r2 = svc.generate(s.id, 1, 2);
  assert.deepEqual(r2.values, ['3']);
  assert.equal(r2.startPosition, '5');
  assert.equal(r2.endPosition, '6');
});

test('count=0 不推进状态但占用版本（仍是一次可审计操作）', () => {
  const s = svc.create({ m: '10', a: '3', c: '5', seed: '7' });
  const r = svc.generate(s.id, 0, 1);
  assert.deepEqual(r.values, []);
  assert.equal(r.stream.state, '7');
  assert.equal(r.stream.position, '0');
  assert.equal(r.stream.version, 2);
});

test('预览跳步不写库、不改版本，重复预览一致', () => {
  const s = svc.create({ m: '10', a: '3', c: '5', seed: '7' });
  const p1 = svc.previewJump(s.id, '9007199254740993');
  const p2 = svc.previewJump(s.id, '9007199254740993');
  assert.deepEqual(p1, p2);
  const after = svc.get(s.id);
  assert.equal(after.version, 1);
  assert.equal(after.state, '7');
  // 预览值与数学层一致
  const expect = jump(7n, 3n, 5n, 10n, 9007199254740993n).toString();
  assert.equal(p1.finalState, expect);
  assert.equal(p1.toPosition, '9007199254740993');
});

test('零步提交：状态不变，版本仍 +1，步号不变', () => {
  const s = svc.create({ m: '10', a: '3', c: '5', seed: '7' });
  const r = svc.commitJump(s.id, '0', 1);
  assert.equal(r.finalState, '7');
  assert.equal(r.stream.version, 2);
  assert.equal(r.stream.position, '0');
});

test('版本冲突：同一版本上第二个推进请求被拒绝且状态不变', () => {
  const s = svc.create({ m: '10', a: '3', c: '5', seed: '7' });
  svc.generate(s.id, 2, 1); // 版本 -> 2；序列前两项 6,3，state = 3, position = 2
  assert.throws(
    () => svc.generate(s.id, 1, 1), // 过期版本号
    (e: Error) => e instanceof ValidationError && e.code === 'VERSION_CONFLICT',
  );
  assert.throws(
    () => svc.commitJump(s.id, '3', 1),
    (e: Error) => e instanceof ValidationError && e.code === 'VERSION_CONFLICT',
  );
  const cur = svc.get(s.id);
  assert.equal(cur.version, 2);
  assert.equal(cur.state, '3');
  assert.equal(cur.position, '2');
  // 用正确版本仍可继续
  const ok = svc.generate(s.id, 1, 2);
  assert.equal(ok.stream.version, 3);
});

test('超大步号跳步后继续生成与连续序列一致', () => {
  const s = svc.create({ m: '10', a: '3', c: '5', seed: '7' });
  const K = '123456789012345678901234';
  const j = svc.commitJump(s.id, K, 1);
  assert.equal(j.toPosition, K);
  assert.equal(j.stream.version, 2);
  // 再生成 3 个，等于从原种子跳 K+1,K+2,K+3
  const g = svc.generate(s.id, 3, 2);
  const [m, a, c, seed] = [10n, 3n, 5n, 7n];
  const base = BigInt(K);
  assert.deepEqual(
    g.values,
    [1n, 2n, 3n].map((i) => jump(seed, a, c, m, base + i).toString()),
  );
});

test('子序列：新流状态等于原序列位置 r,r+d,r+2d,...，且不复制中间输出', () => {
  const parent = svc.create({ m: '17', a: '5', c: '3', seed: '1' });
  const r = svc.createSubsequence(parent.id, '2', '3');
  assert.equal(r.consistency.match, true);
  assert.deepEqual(r.consistency.checkPositions, ['2', '5', '8', '11', '14']);
  // 用子序列流逐代 10 项，与原序列直接跳步对照
  const sub = svc.get(r.subsequence.id);
  const [m, a, c, seed] = [17n, 5n, 3n, 1n];
  let cur = BigInt(sub.state);
  const sa = BigInt(sub.a);
  const sc = BigInt(sub.c);
  for (let i = 0; i < 10; i++) {
    const q = 2n + 3n * BigInt(i);
    cur = i === 0 ? cur : (sa * cur + sc) % m;
    assert.equal(cur, jump(seed, a, c, m, q), `子序列第 ${i} 项不一致`);
  }
  // 首状态严格等于 x_2
  assert.equal(r.firstState, jump(1n, 5n, 3n, 17n, 2n).toString());
});

test('r=0 的子序列从原序列首项开始', () => {
  const parent = svc.create({ m: '17', a: '5', c: '3', seed: '1' });
  const r = svc.createSubsequence(parent.id, '0', '4');
  assert.equal(r.subsequence.state, '1');
  assert.equal(r.consistency.match, true);
});

test('子序列参数校验：d 必须为正', () => {
  const parent = svc.create({ m: '17', a: '5', c: '3', seed: '1' });
  assert.throws(() => svc.createSubsequence(parent.id, '0', '0'), (e: Error) => {
    return e instanceof ValidationError && e.code === 'OUT_OF_RANGE';
  });
});

test('操作记录导出包含 create/generate/jump', () => {
  const s = svc.create({ m: '10', a: '3', c: '5', seed: '7' });
  svc.generate(s.id, 2, 1);
  svc.commitJump(s.id, '10', 2);
  const ops = svc.listOperations(s.id, 100, 0);
  assert.deepEqual(ops.map((o) => o.type), ['create', 'generate', 'jump']);
  assert.equal(ops[2]!.position, '12'); // 2 + 10
  const genDetail = ops[1]!.detail as { values: string[]; count: number };
  assert.deepEqual(genDetail.values, ['6', '3']);
});

test('重启衔接：关闭后重新打开同一数据库，序列继续一致', () => {
  const s0: StreamView = svc.create({ m: '10', a: '3', c: '5', seed: '7' });
  svc.commitJump(s0.id, '1000000000000000000', 1);
  const before = svc.get(s0.id);
  store.close();

  const store2 = new Store(join(dir, 't.sqlite'));
  const svc2 = new LcgService(store2);
  const after = svc2.get(s0.id);
  assert.equal(after.state, before.state);
  assert.equal(after.position, before.position);
  assert.equal(after.version, 2);
  const g = svc2.generate(s0.id, 3, 2);
  const [m, a, c, seed] = [10n, 3n, 5n, 7n];
  const base = BigInt(after.position);
  assert.deepEqual(
    g.values,
    [1n, 2n, 3n].map((i) => jump(seed, a, c, m, base + i).toString()),
  );
  store2.close();
  storeClosed = true;
});

