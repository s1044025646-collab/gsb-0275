/**
 * 业务服务层：参数校验 → BigInt 跳步计算 → SQLite 原子持久化。
 */
import { Store, type StreamRow } from './store.js';
import {
  generateNext,
  jump,
  powerMap,
  step,
} from './math.js';
import {
  parseCount,
  parsePositive,
  parseStep,
  parseVersion,
  validateParams,
  type LcgParamsInput,
} from './validate.js';

export interface StreamView {
  id: string;
  m: string;
  a: string;
  c: string;
  state: string;
  position: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const view = (r: StreamRow): StreamView => ({
  id: r.id,
  m: r.m,
  a: r.a,
  c: r.c,
  state: r.state,
  position: r.position,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class LcgService {
  constructor(private readonly store: Store) {}

  create(input: LcgParamsInput): StreamView {
    const p = validateParams(input);
    return view(this.store.createStream(p));
  }

  get(id: string): StreamView {
    return view(this.store.getStream(id));
  }

  /**
   * 生成接下来的 n 个状态（不含当前 state），并原子推进。
   * 返回值中 startPosition = 推进前的绝对步号（当前 state 所在位置），
   * values[0] 对应位置 startPosition+1，values[n-1] 对应 endPosition。
   */
  generate(
    id: string,
    countRaw: unknown,
    expectedVersionRaw: unknown,
  ): { stream: StreamView; startPosition: string; endPosition: string; values: string[] } {
    const count = parseCount(countRaw);
    const expectedVersion = parseVersion(expectedVersionRaw);
    const row = this.store.getStream(id);
    const m = BigInt(row.m);
    const a = BigInt(row.a);
    const c = BigInt(row.c);
    const state = BigInt(row.state);
    const pos = BigInt(row.position);

    const values = generateNext(state, a, c, m, count).map((v) => v.toString());
    const newState =
      values.length === 0 ? state : BigInt(values[values.length - 1] as string);
    const newPosition = pos + BigInt(count);

    const updated = this.store.advance(
      id,
      expectedVersion,
      newState,
      newPosition,
      'generate',
      { count, values },
    );
    return {
      stream: view(updated),
      startPosition: pos.toString(),
      endPosition: newPosition.toString(),
      values,
    };
  }

  /**
   * 纯预览跳 k 步：只计算，不写库、不改版本。
   * k=0 时 finalState 与当前 state 相同。
   */
  previewJump(
    id: string,
    kRaw: unknown,
  ): { fromPosition: string; toPosition: string; fromState: string; finalState: string; steps: string } {
    const k = parseStep(kRaw);
    const row = this.store.getStream(id);
    const m = BigInt(row.m);
    const state = BigInt(row.state);
    const pos = BigInt(row.position);
    const finalState = jump(state, BigInt(row.a), BigInt(row.c), m, k);
    return {
      fromPosition: pos.toString(),
      toPosition: (pos + k).toString(),
      fromState: state.toString(),
      finalState: finalState.toString(),
      steps: k.toString(),
    };
  }

  /** 提交跳步：带 expectedVersion 乐观锁，原子更新。 */
  commitJump(
    id: string,
    kRaw: unknown,
    expectedVersionRaw: unknown,
  ): { stream: StreamView; fromPosition: string; toPosition: string; fromState: string; finalState: string } {
    const k = parseStep(kRaw);
    const expectedVersion = parseVersion(expectedVersionRaw);
    const row = this.store.getStream(id);
    const m = BigInt(row.m);
    const state = BigInt(row.state);
    const pos = BigInt(row.position);
    const finalState = jump(state, BigInt(row.a), BigInt(row.c), m, k);
    const newPosition = pos + k;
    const updated = this.store.advance(
      id,
      expectedVersion,
      finalState,
      newPosition,
      'jump',
      { steps: k.toString(), fromState: state.toString(), finalState: finalState.toString() },
    );
    return {
      stream: view(updated),
      fromPosition: pos.toString(),
      toPosition: newPosition.toString(),
      fromState: state.toString(),
      finalState: finalState.toString(),
    };
  }

  /**
   * 创建步长子序列：取原序列位置 r, r+d, r+2d, ... 构成的新流。
   *
   * 新流仍是 LCG：
   *   seed' = x_r = 从原 seed 跳 r 步（O(log r)）
   *   d 步变换 f^d(x) = A*x + B (mod m)，由仿射复合快速幂得到（O(log d)），
   *   故新流参数为 (m, a'=A, c'=B, seed'=x_r)。
   * 不复制任何中间输出。
   */
  createSubsequence(
    parentId: string,
    rRaw: unknown,
    dRaw: unknown,
  ): {
    parent: StreamView;
    subsequence: StreamView;
    r: string;
    d: string;
    firstState: string;
    stepMap: { a: string; c: string };
    consistency: {
      checkPositions: string[];
      parentStates: string[];
      subsequenceStates: string[];
      match: boolean;
    };
  } {
    const r = parseStep(rRaw, 'r');
    const d = parsePositive(dRaw, 'd');
    const parent = this.store.getStream(parentId);
    const m = BigInt(parent.m);
    const a = BigInt(parent.a);
    const c = BigInt(parent.c);

    // 首状态：从“原始种子”位置 0 计算 x_r，而非从父流当前位置。
    // parent.state 位于 parent.position；x_r = jump(seed, r)。
    // 这里以当前状态为起点仅在 r 语义为“相对当前位置”时成立；
    // 按需求 r 为“原序列位置”，因此需从初始种子推算。初始种子即
    // position=0 时的状态，已保存在 create 操作记录中。
    const seed = this.initialSeed(parentId);
    const firstState = jump(seed, a, c, m, r);
    const fd = powerMap(a, c, m, d);

    const created = this.store.createStream({ m, a: fd.A, c: fd.B, seed: firstState });
    // 一致性展示：子序列前 5 项（位置 r, r+d, ..., r+4d）与原序列直接跳步比对
    const checkCount = 5;
    const checkPositions: string[] = [];
    const parentStates: string[] = [];
    const subStates: string[] = [];
    let subCur = firstState;
    let match = true;
    for (let i = 0; i < checkCount; i++) {
      const q = r + d * BigInt(i);
      const px = jump(seed, a, c, m, q);
      checkPositions.push(q.toString());
      parentStates.push(px.toString());
      subStates.push(subCur.toString());
      if (px !== subCur) match = false;
      subCur = step(subCur, fd.A, fd.B, m);
    }

    // 补写关联记录（只读型说明，通过一次 0 步预览不合适；直接用 advance 会改版本，
    // 因此关联信息已在 create 后无法直接追加——这里用 store 的低层接口补一条记录）
    this.store.db
      .prepare(
        `INSERT INTO operations (stream_id,type,detail,position,version,created_at)
         VALUES ($sid,$type,$detail,$pos,$ver,$ts)`,
      )
      .run(
        {
          sid: created.id,
          type: 'subsequence',
          detail: JSON.stringify({ parentId, r: r.toString(), d: d.toString() }),
          pos: '0',
          ver: created.version,
          ts: new Date().toISOString(),
        },
      );

    return {
      parent: view(parent),
      subsequence: view(this.store.getStream(created.id)),
      r: r.toString(),
      d: d.toString(),
      firstState: firstState.toString(),
      stepMap: { a: fd.A.toString(), c: fd.B.toString() },
      consistency: { checkPositions, parentStates, subsequenceStates: subStates, match },
    };
  }

  /** 取流的初始种子（position=0 的状态），从 create 记录读取。 */
  private initialSeed(id: string): bigint {
    const row = this.store.db
      .prepare(
        `SELECT detail FROM operations
         WHERE stream_id = $sid AND type = 'create'
         ORDER BY id ASC LIMIT 1`,
      )
      .get({ sid: id }) as { detail?: string } | undefined;
    if (!row?.detail) {
      // 理论上不会发生：createStream 与 create 记录同事务写入
      throw new Error('初始种子记录缺失');
    }
    return BigInt((JSON.parse(row.detail) as { seed: string }).seed);
  }

  listOperations(id: string, limitRaw: unknown, offsetRaw: unknown) {
    const limit = clampInt(limitRaw, 100, 1, 1000);
    const offset = clampInt(offsetRaw, 0, 0, Number.MAX_SAFE_INTEGER);
    return this.store.listOperations(id, limit, offset).map((o) => ({
      id: o.id,
      type: o.type,
      detail: safeParseJson(o.detail),
      position: o.position,
      version: o.version,
      createdAt: o.created_at,
    }));
  }
}

function clampInt(raw: unknown, dft: number, min: number, max: number): number {
  if (raw === undefined || raw === null) return dft;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return dft;
  return Math.min(max, Math.max(min, raw));
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
