import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { startServer } from "../src/server";

let server: http.Server;
let base: string;
let dir: string;
let service: Service;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcg-http-"));
  service = new Service(new Store(path.join(dir, "t.db")));
  const started = await startServer(service, 0);
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(() => {
  service.store.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(p: string, body: unknown) {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("HTTP API 端到端", async () => {
  const created = await post("/streams", { m: "8", a: "5", c: "1", seed: "0" });
  assert.equal(created.status, 201);
  const id = created.json.id;

  const gen = await post(`/streams/${id}/generate`, {
    n: "2",
    expectedVersion: 0,
  });
  assert.deepEqual(gen.json.values, ["1", "6"]);

  const preview = await post(`/streams/${id}/jump`, { k: "2" });
  assert.equal(preview.json.toState, "4");
  assert.equal(preview.json.committed, false);

  const conflict = await post(`/streams/${id}/generate`, {
    n: "1",
    expectedVersion: 0,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "VERSION_CONFLICT");

  const sub = await post(`/streams/${id}/substream`, { r: "0", d: "2" });
  assert.equal(sub.status, 201);
  const verify = await fetch(`${base}/streams/${sub.json.id}/verify`);
  assert.equal((await verify.json()).consistent, true);

  const bad = await post("/streams", { m: "1", a: "0", c: "0", seed: "0" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "INVALID_PARAM");
});
