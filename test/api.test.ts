import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'lcg-api-'));
// 必须在动态 import server 之前设置：server 模块加载时即用 LCG_DATA_DIR 打开数据库
process.env.LCG_DATA_DIR = dir;

const { createApp, store } = await import('../dist/server.js');

let base: string;
let server: Server;

before(async () => {
  server = createApp();
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : ({} as T) };
}

test('HTTP 端到端：创建/查询/生成/预览/冲突/跳步/子序列/记录', async () => {
  const health = await call<{ ok: boolean }>('GET', '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const created = await call<{ id: string; version: number }>('POST', '/api/streams', {
    m: '10', a: '3', c: '5', seed: '7',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const bad = await call('POST', '/api/streams', { m: '1', a: '0', c: '0', seed: '0' });
  assert.equal(bad.status, 400);
  assert.equal((bad.body as { error: { code: string } }).error.code, 'M_TOO_SMALL');

  const gen = await call<{ values: string[]; stream: { version: number } }>(
    'POST', `/api/streams/${id}/generate`, { count: 5, expectedVersion: 1 },
  );
  assert.deepEqual(gen.body.values, ['6', '3', '4', '7', '6']);

  const conflict = await call('POST', `/api/streams/${id}/generate`, { count: 1, expectedVersion: 1 });
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body as { error: { code: string } }).error.code, 'VERSION_CONFLICT');

  const preview = await call<{ finalState: string }>(
    'POST', `/api/streams/${id}/jumps/preview`, { k: '9007199254740993' },
  );
  assert.equal(preview.status, 200);

  const jumpRes = await call<{ stream: { position: string; version: number } }>(
    'POST', `/api/streams/${id}/jumps`, { k: '9007199254740993', expectedVersion: 2 },
  );
  assert.equal(jumpRes.status, 200);
  assert.equal(jumpRes.body.stream.position, '9007199254740998'); // 5 + (2^53+1)

  const p2 = await call(
    'POST', `/api/streams/${id}/subsequence`,
  );
  assert.equal(p2.status, 400); // 缺 r/d

  const ops = await call<unknown[]>('GET', `/api/streams/${id}/operations`);
  assert.equal(ops.status, 200);
  assert.ok(Array.isArray(ops.body));
  assert.equal((ops.body as Array<{ type: string }>).map((o) => o.type).join(','), 'create,generate,jump');

  assert.equal((await call('GET', '/api/streams/no-such-id')).status, 404);
  assert.equal((await call('GET', '/nope')).status, 404);
});

