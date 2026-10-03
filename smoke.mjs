// 冒烟脚本：以固定 PORT 启动已构建服务，跑 create/generate/get，再关闭。
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const port = 38275;
const child = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', 'dist/server.js'],
  { env: { ...process.env, PORT: String(port), LCG_DATA_DIR: 'data/smoke' }, stdio: 'inherit' },
);
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try {
    const h = await fetch(`${base}/healthz`);
    if (h.ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  const s = await (
    await fetch(`${base}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ m: '10', a: '3', c: '5', seed: '7' }),
    })
  ).json();
  const g = await (
    await fetch(`${base}/api/streams/${s.id}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 3, expectedVersion: 1 }),
    })
  ).json();
  if (g.values.join(',') !== '6,3,4') throw new Error('冒烟序列不匹配: ' + g.values);
  console.log('SMOKE OK:', g.values.join(','), 'version', g.stream.version);
} finally {
  child.kill();
  await new Promise((r) => child.on('exit', r));
  await new Promise((r) => setTimeout(r, 200));
  rmSync('data/smoke', { recursive: true, force: true });
}
