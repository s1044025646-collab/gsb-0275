import { jumpAffine, jumpState, applyAffine } from "./lcg";
import { Store, StreamRow } from "./store";
import { ApiError } from "./errors";
import {
  parseDec,
  parseCount,
  checkRange,
  checkModulus,
  MAX_BATCH,
  MAX_EXPORT,
} from "./validate";

export interface StreamView {
  id: number;
  name: string;
  m: string;
  a: string;
  c: string;
  seed: string;
  state: string;
  pos: string;
  version: number;
  parentId: number | null;
  subR: string | null;
  subD: string | null;
  createdAt: string;
}

function view(row: StreamRow): StreamView {
  return {
    id: row.id,
    name: row.name,
    m: row.m,
    a: row.a,
    c: row.c,
    seed: row.seed,
    state: row.state,
    pos: row.pos,
    version: row.version,
    parentId: row.parent_id,
    subR: row.sub_r,
    subD: row.sub_d,
    createdAt: row.created_at,
  };
}

export class Service {
  constructor(public store: Store) {}

  private mustGet(id: number): StreamRow {
    const row = this.store.getStream(id);
    if (!row) throw new ApiError("NOT_FOUND", `流 ${id} 不存在`, 404);
    return row;
  }

  createStream(input: {
    name?: string;
    m: unknown;
    a: unknown;
    c: unknown;
    seed: unknown;
  }): StreamView {
    const m = parseDec(input.m, "m");
    checkModulus(m);
    const a = parseDec(input.a, "a");
    const c = parseDec(input.c, "c");
    const seed = parseDec(input.seed, "seed");
    checkRange(a, m, "a");
    checkRange(c, m, "c");
    checkRange(seed, m, "seed");
    const name =
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 100)
        : "stream";
    const id = this.store.tx(() => {
      const newId = this.store.insertStream({
        name,
        m: m.toString(),
        a: a.toString(),
        c: c.toString(),
        seed: seed.toString(),
      });
      this.store.logOp(newId, "create", {
        m: m.toString(),
        a: a.toString(),
        c: c.toString(),
        seed: seed.toString(),
      });
      return newId;
    });
    return view(this.mustGet(id));
  }

  getStream(id: number): StreamView {
    return view(this.mustGet(id));
  }

  listStreams(): StreamView[] {
    return this.store.listStreams().map(view);
  }

  // 生成接下来 n 个状态（不含当前状态），原子推进。
  generate(
    id: number,
    nRaw: unknown,
    expectedVersionRaw?: unknown,
  ): {
    streamId: number;
    startPos: string;
    endPos: string;
    values: string[];
    finalState: string;
    version: number;
  } {
    const n = parseCount(nRaw, "n", MAX_BATCH);
    if (n < 1) throw new ApiError("INVALID_PARAM", "n 必须 >= 1");
    return this.store.tx(() => {
      const row = this.mustGet(id);
      const expected = this.resolveVersion(row, expectedVersionRaw);
      const m = BigInt(row.m);
      const a = BigInt(row.a);
      const c = BigInt(row.c);
      let x = BigInt(row.state);
      const values: bigint[] = [];
      for (let i = 0; i < n; i++) {
        x = (a * x + c) % m;
        values.push(x);
      }
      const startPos = BigInt(row.pos);
      const endPos = startPos + BigInt(n);
      if (!this.store.advance(id, expected, x.toString(), endPos.toString())) {
        throw new ApiError(
          "VERSION_CONFLICT",
          `版本冲突：当前版本已变化，请重新读取后重试`,
          409,
        );
      }
      this.store.insertOutputs(id, startPos + 1n, values);
      this.store.logOp(id, "generate", { n, from: startPos.toString() });
      const after = this.mustGet(id);
      return {
        streamId: id,
        startPos: startPos.toString(),
        endPos: endPos.toString(),
        values: values.map(String),
        finalState: x.toString(),
        version: after.version,
      };
    });
  }

  // 预览跳步：不写库。
  previewJump(id: number, kRaw: unknown) {
    const row = this.mustGet(id);
    const k = parseDec(kRaw, "k");
    const m = BigInt(row.m);
    const newState = jumpState(
      BigInt(row.a),
      BigInt(row.c),
      m,
      BigInt(row.state),
      k,
    );
    return {
      streamId: id,
      k: k.toString(),
      fromPos: row.pos,
      toPos: (BigInt(row.pos) + k).toString(),
      fromState: row.state,
      toState: newState.toString(),
      version: row.version,
      committed: false,
    };
  }

  // 提交跳步：带期望版本，原子推进。
  commitJump(id: number, kRaw: unknown, expectedVersionRaw?: unknown) {
    const k = parseDec(kRaw, "k");
    return this.store.tx(() => {
      const row = this.mustGet(id);
      const expected = this.resolveVersion(row, expectedVersionRaw);
      const m = BigInt(row.m);
      const newState = jumpState(
        BigInt(row.a),
        BigInt(row.c),
        m,
        BigInt(row.state),
        k,
      );
      const newPos = BigInt(row.pos) + k;
      if (!this.store.advance(id, expected, newState.toString(), newPos.toString())) {
        throw new ApiError("VERSION_CONFLICT", "版本冲突，请重新读取后重试", 409);
      }
      this.store.logOp(id, "jump", { k: k.toString() });
      const after = this.mustGet(id);
      return {
        streamId: id,
        k: k.toString(),
        fromPos: row.pos,
        toPos: newPos.toString(),
        fromState: row.state,
        toState: newState.toString(),
        version: after.version,
        committed: true,
      };
    });
  }

  // 创建子序列流：取原序列第 r, r+d, r+2d, ... 项（0 基，seed 为第 0 项）。
  createSubstream(id: number, rRaw: unknown, dRaw: unknown, name?: string) {
    const r = parseDec(rRaw, "r");
    const d = parseDec(dRaw, "d");
    if (d < 1n) throw new ApiError("INVALID_PARAM", "d 必须 >= 1");
    return this.store.tx(() => {
      const parent = this.mustGet(id);
      const m = BigInt(parent.m);
      const a = BigInt(parent.a);
      const c = BigInt(parent.c);
      const seed = BigInt(parent.seed);
      // d 步复合变换即子序列的一步变换
      const step = jumpAffine(a, c, m, d);
      // 子序列首项 = 原序列第 r 项
      const subSeed = jumpState(a, c, m, seed, r);
      const subName =
        name && name.trim()
          ? name.trim().slice(0, 100)
          : `${parent.name}-sub(r=${r},d=${d})`;
      const newId = this.store.insertStream({
        name: subName,
        m: m.toString(),
        a: step.mul.toString(),
        c: step.add.toString(),
        seed: subSeed.toString(),
        parentId: id,
        subR: r.toString(),
        subD: d.toString(),
      });
      this.store.logOp(newId, "substream", {
        parentId: id,
        r: r.toString(),
        d: d.toString(),
      });
      return view(this.mustGet(newId));
    });
  }

  // 校验子序列当前状态与原流对应位置一致（展示用）。
  verifySubstream(id: number) {
    const sub = this.mustGet(id);
    if (sub.parent_id == null) {
      throw new ApiError("INVALID_PARAM", `流 ${id} 不是子序列流`);
    }
    const parent = this.mustGet(sub.parent_id);
    const m = BigInt(parent.m);
    const r = BigInt(sub.sub_r!);
    const d = BigInt(sub.sub_d!);
    const subPos = BigInt(sub.pos);
    // 子流第 subPos 项对应原序列第 r + subPos*d 项
    const origIndex = r + subPos * d;
    const expected = jumpState(
      BigInt(parent.a),
      BigInt(parent.c),
      m,
      BigInt(parent.seed),
      origIndex,
    );
    return {
      substreamId: id,
      parentId: parent.id,
      subPos: sub.pos,
      originalIndex: origIndex.toString(),
      subState: sub.state,
      originalValue: expected.toString(),
      consistent: expected.toString() === sub.state,
    };
  }

  exportRecords(id: number, fromRaw?: unknown, limitRaw?: unknown) {
    this.mustGet(id);
    const from = fromRaw === undefined ? 0n : parseDec(fromRaw, "from");
    const limit =
      limitRaw === undefined ? 1000 : parseCount(limitRaw, "limit", MAX_EXPORT);
    const outputs = this.store.getOutputs(id, from, limit);
    const ops = this.store.listOps(id, 100);
    return { streamId: id, outputs, recentOps: ops };
  }

  private resolveVersion(row: StreamRow, raw: unknown): number {
    if (raw === undefined || raw === null) return row.version;
    const v =
      typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw) && raw.length <= 15
          ? Number(raw)
          : NaN;
    if (Number.isNaN(v)) {
      throw new ApiError("INVALID_PARAM", "expectedVersion 必须是非负整数");
    }
    return v;
  }
}
