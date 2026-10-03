#!/usr/bin/env node
/**
 * 命令行客户端：通过 HTTP 与本地服务通信。
 *
 * 用法：
 *   lcg create  --m 10 --a 3 --c 5 --seed 7
 *   lcg get     <id>
 *   lcg generate <id> --count 5 --expected-version 1
 *   lcg jump-preview <id> --k 100000000000000000000
 *   lcg jump    <id> --k 100000000000000000000 --expected-version 1
 *   lcg subseq  <id> --r 2 --d 3
 *   lcg ops     <id> [--limit 100] [--offset 0]
 *   lcg serve                      在前台启动服务（默认自动选空闲端口）
 *   lcg demo                       自动启动临时服务并跑完整演示
 *
 * 目标地址解析顺序：--base URL > 环境变量 LCG_BASE > data/port.json。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.LCG_DATA_DIR ?? join(projectRoot, 'data');
const PORT_FILE = join(DATA_DIR, 'port.json');

interface CliError {
  error: { code: string; message: string; field?: string };
}

class CliHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`[HTTP ${status}] ${code}: ${message}`);
  }
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const flag = `--${name}=`;
  const j = args.findIndex((x) => x.startsWith(flag));
  if (j >= 0) return (args[j] as string).slice(flag.length);
  return undefined;
}

function requireArg(args: string[], name: string): string {
  const v = arg(args, name);
  if (v === undefined) {
    console.error(`缺少必填参数 --${name}`);
    process.exit(2);
  }
  return v;
}

function resolveBase(extra?: string): string {
  const explicit = extra ?? process.env.LCG_BASE;
  if (explicit) return explicit.replace(/\/+$/, '');
  if (existsSync(PORT_FILE)) {
    try {
      const info = JSON.parse(readFileSync(PORT_FILE, 'utf8')) as { port?: number };
      if (info.port) return `http://127.0.0.1:${info.port}`;
    } catch {
      // fallthrough
    }
  }
  console.error('找不到服务地址：请先运行 `lcg serve`，或用 --base / LCG_BASE 指定。');
  process.exit(2);
}

async function request<T>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const e = parsed as CliError;
    throw new CliHttpError(res.status, e.error?.code ?? 'ERROR', e.error?.message ?? text);
  }
  return parsed as T;
}

const print = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'serve': {
      const entry = fileURLToPath(import.meta.url).endsWith('.ts')
        ? join(projectRoot, 'src', 'server.ts')
        : join(projectRoot, 'dist', 'server.js');
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...rest], {
        stdio: 'inherit',
        env: process.env,
      });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }
    case 'create': {
      const base = resolveBase(arg(rest, 'base'));
      print(
        await request(base, 'POST', '/api/streams', {
          m: requireArg(rest, 'm'),
          a: requireArg(rest, 'a'),
          c: requireArg(rest, 'c'),
          seed: requireArg(rest, 'seed'),
        }),
      );
      return;
    }
    case 'get': {
      const base = resolveBase(arg(rest, 'base'));
      const id = rest[0];
      if (!id) {
        console.error('用法：lcg get <id>');
        process.exit(2);
      }
      print(await request(base, 'GET', `/api/streams/${encodeURIComponent(id as string)}`));
      return;
    }
    case 'generate': {
      const base = resolveBase(arg(rest, 'base'));
      const id = rest[0];
      print(
        await request(base, 'POST', `/api/streams/${encodeURIComponent(id as string)}/generate`, {
          count: Number(requireArg(rest, 'count')),
          expectedVersion: Number(requireArg(rest, 'expected-version')),
        }),
      );
      return;
    }
    case 'jump-preview': {
      const base = resolveBase(arg(rest, 'base'));
      const id = rest[0];
      print(
        await request(base, 'POST', `/api/streams/${encodeURIComponent(id as string)}/jumps/preview`, {
          k: requireArg(rest, 'k'),
        }),
      );
      return;
    }
    case 'jump': {
      const base = resolveBase(arg(rest, 'base'));
      const id = rest[0];
      print(
        await request(base, 'POST', `/api/streams/${encodeURIComponent(id as string)}/jumps`, {
          k: requireArg(rest, 'k'),
          expectedVersion: Number(requireArg(rest, 'expected-version')),
        }),
      );
      return;
    }
    case 'subseq': {
      const base = resolveBase(arg(rest, 'base'));
      const id = rest[0];
      print(
        await request(base, 'POST', `/api/streams/${encodeURIComponent(id as string)}/subsequence`, {
          r: requireArg(rest, 'r'),
          d: requireArg(rest, 'd'),
        }),
      );
      return;
    }
    case 'ops': {
      const base = resolveBase(arg(rest, 'base'));
      const id = rest[0];
      const limit = arg(rest, 'limit') ?? '100';
      const offset = arg(rest, 'offset') ?? '0';
      print(
        await request(
          base,
          'GET',
          `/api/streams/${encodeURIComponent(id as string)}/operations?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
        ),
      );
      return;
    }
    case 'demo':
      await runDemo();
      return;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(readFileSync(new URL('./help.txt', import.meta.url), 'utf8'));
      return;
    default:
      console.error(`未知命令：${cmd}。运行 lcg help 查看用法。`);
      process.exit(2);
  }
}

/** 自动启动一个使用临时数据目录的服务，跑完演示后关闭。 */
async function runDemo(): Promise<void> {
  const tmpDir = join(DATA_DIR, `demo-${Date.now()}`);
  const entry = fileURLToPath(import.meta.url).endsWith('.ts')
    ? join(projectRoot, 'src', 'server.ts')
    : join(projectRoot, 'dist', 'server.js');
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', entry],
    {
      env: { ...process.env, LCG_DATA_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  let base = '';
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('服务启动超时')), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      process.stdout.write(`[server] ${line}`);
      const mm = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (mm) {
        clearTimeout(timer);
        base = `http://127.0.0.1:${mm[1]}`;
        resolvePromise();
      }
    });
    child.on('exit', (code) => rejectPromise(new Error(`服务提前退出，code=${code}`)));
  });

  const bigK = '9007199254740993'; // 2^53+1，超过 Number.MAX_SAFE_INTEGER
  try {
    console.log('\n=== 1) 创建流 m=10, a=3, c=5, seed=7 ===');
    const s1 = await request<{ id: string; version: number }>(base, 'POST', '/api/streams', {
      m: '10', a: '3', c: '5', seed: '7',
    });
    print(s1);

    console.log('\n=== 2) 生成接下来 5 个状态（7 不计入；版本 1 -> 2）===');
    const g1 = await request<{
      values: string[];
      startPosition: string;
      endPosition: string;
    }>(base, 'POST', `/api/streams/${s1.id}/generate`, {
      count: 5, expectedVersion: s1.version,
    });
    print(g1);

    console.log('\n=== 3) 预览超大跳步（不写状态，重复预览结果一致）===');
    print(await request(base, 'POST', `/api/streams/${s1.id}/jumps/preview`, { k: bigK }));
    print(await request(base, 'POST', `/api/streams/${s1.id}/jumps/preview`, { k: bigK }));

    console.log('\n=== 4) 同版本冲突：用旧版本号再生成应被拒绝 (HTTP 409) ===');
    try {
      await request(base, 'POST', `/api/streams/${s1.id}/generate`, {
        count: 1, expectedVersion: s1.version,
      });
      console.log('错误：冲突请求未被拒绝');
    } catch (e) {
      console.log(`已按预期拒绝 -> ${(e as Error).message}`);
    }

    console.log('\n=== 5) 提交超大跳步（版本 2 -> 3）===');
    print(await request(base, 'POST', `/api/streams/${s1.id}/jumps`, {
      k: bigK, expectedVersion: 2,
    }));

    console.log('\n=== 6) 子序列 r=2, d=3：位置 2,5,8,... 与原序列一致性 ===');
    const s2 = await request<{ id: string }>(base, 'POST', '/api/streams', {
      m: '17', a: '5', c: '3', seed: '1',
    });
    print(await request(base, 'POST', `/api/streams/${s2.id}/subsequence`, { r: '2', d: '3' }));

    console.log('\n=== 7) 导出操作记录 ===');
    print(await request(base, 'GET', `/api/streams/${s1.id}/operations`));
  } finally {
    child.kill();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
