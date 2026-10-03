import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { ApiError } from "../src/errors";

let dir: string;
let dbPath: string;
let service: Service;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcg-test-"));
  dbPath = path.join(dir, "test.db");
  service = new Service(new Store(dbPath));
});

afterEach(() => {
  service.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function createSimple() {
  return service.createStream({ name: "t", m: "8", a: "5", c: "1", seed: "0" });
}

test("创建流并校验参数", () => {
  const s = createSimple();
  assert.equal(s.state, "0");
  assert.equal(s.pos, "0");
  assert.throws(
    () => service.createStream({ m: "1", a: "0", c: "0", seed: "0" }),
    (e: any) => e instanceof ApiError && e.code === "INVALID_PARAM",
  );
  assert.throws(
    () => service.createStream({ m: "8", a: "8", c: "0", seed: "0" }),
    /范围/,
  );
  assert.throws(
    () => service.createStream({ m: "8", a: "1", c: "0", seed: "3.5" }),
    (e: any) => e.code === "INVALID_PARAM",
  );
});

test("生成 N 个数：返回接下来的 N 个状态，不含当前种子", () => {
  const s = createSimple();
  const r = service.generate(s.id, "4", s.version);
  assert.deepEqual(r.values, ["1", "6", "7", "4"]);
  assert.equal(r.startPos, "0");
  assert.equal(r.endPos, "4");
  assert.equal(r.finalState, "4");
  assert.equal(r.version, 1);
});

test("预览跳步不写状态，重复预览结果一致", () => {
  const s = createSimple();
  const p1 = service.previewJump(s.id, "3");
  const p2 = service.previewJump(s.id, "3");
  assert.equal(p1.toState, "7");
  assert.equal(p1.committed, false);
  assert.deepEqual(p1, p2);
  assert.equal(service.getStream(s.id).state, "0");
  assert.equal(service.getStream(s.id).version, 0);
});

test("提交跳步推进状态，版本冲突被拒绝", () => {
  const s = createSimple();
  const r = service.commitJump(s.id, "3", s.version);
  assert.equal(r.toState, "7");
  assert.equal(r.version, 1);
  // 同一旧版本再次提交 -> 409
  assert.throws(
    () => service.commitJump(s.id, "1", s.version),
    (e: any) => e instanceof ApiError && e.code === "VERSION_CONFLICT",
  );
  // 状态未被部分推进
  assert.equal(service.getStream(s.id).pos, "3");
});

test("跳步与逐步生成结果一致", () => {
  const s1 = createSimple();
  const s2 = service.createStream({ m: "8", a: "5", c: "1", seed: "0" });
  service.commitJump(s1.id, "6", s1.version);
  service.generate(s2.id, "6", s2.version);
  assert.equal(service.getStream(s1.id).state, service.getStream(s2.id).state);
  assert.equal(service.getStream(s1.id).pos, "6");
});

test("子序列等于原序列第 r, r+d, ... 项", () => {
  const parent = createSimple();
  const sub = service.createSubstream(parent.id, "1", "3");
  // 原序列: 0,1,6,7,4,5,2,3,0,... 第 1,4,7 项 = 1,4,3
  assert.equal(sub.state, "1");
  const gen = service.generate(sub.id, "2", sub.version);
  assert.deepEqual(gen.values, ["4", "3"]);
  const v = service.verifySubstream(sub.id);
  assert.equal(v.consistent, true);
  assert.equal(v.originalIndex, "7");
});

test("超过安全整数的跳步", () => {
  const s = service.createStream({
    m: "2305843009213693951",
    a: "1752450205419405103",
    c: "1442695040888963407",
    seed: "42",
  });
  const big = (2n ** 60n + 7n).toString();
  const r = service.commitJump(s.id, big, s.version);
  assert.equal(r.toPos, (2n ** 60n + 7n).toString());
  // 预览与提交一致
  const p = service.previewJump(s.id, "0");
  assert.equal(p.toState, r.toState);
});

test("重启后（重开数据库）序列衔接一致", () => {
  const s = createSimple();
  service.generate(s.id, "3", s.version);
  service.store.close();
  // 重新打开同一数据库
  const service2 = new Service(new Store(dbPath));
  const restored = service2.getStream(s.id);
  assert.equal(restored.state, "7");
  assert.equal(restored.pos, "3");
  const r = service2.generate(s.id, "2", restored.version);
  assert.deepEqual(r.values, ["4", "5"]);
  service2.store.close();
  // 重新挂回新 service 供 afterEach 关闭
  service = new Service(new Store(dbPath));
  service.store.close();
  service = new Service(new Store(path.join(dir, "unused.db")));
});

test("导出记录包含输出与操作日志", () => {
  const s = createSimple();
  service.generate(s.id, "3", s.version);
  const exp = service.exportRecords(s.id);
  assert.equal(exp.outputs.length, 3);
  assert.deepEqual(
    exp.outputs.map((o) => o.value),
    ["1", "6", "7"],
  );
  assert.ok(exp.recentOps.length >= 2);
});

test("批量上限", () => {
  const s = createSimple();
  assert.throws(
    () => service.generate(s.id, "10001"),
    (e: any) => e.code === "LIMIT_EXCEEDED",
  );
});
