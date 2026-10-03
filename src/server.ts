/**
 * 纯 Node.js http 实现的 REST API（无第三方运行时依赖）。
 *
 * 路由：
 *   POST   /api/streams                 创建流
 *   GET    /api/streams/:id             查询参数与当前状态
 *   POST   /api/streams/:id/generate    生成接下来 N 个状态并原子推进
 *   POST   /api/streams/:id/jumps/preview  纯预览跳步（不写状态）
 *   POST   /api/streams/:id/jumps       提交跳步（expectedVersion 乐观锁）
 *   POST   /api/streams/:id/subsequence 创建步长子序列
 *   GET    /api/streams/:id/operations  导出操作记录
 *   GET    /healthz                     健康检查
 *
 * 端口：环境变量 PORT 指定则使用之；否则自动选择空闲端口，
 * 并把实际端口写入 data/port.json 供 CLI 读取。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { LcgService } from './service.js';
import { Store } from './store.js';
import { ValidationError, type ErrorCode } from './validate.js';

// 编译后位于 dist/，源码直跑位于 src/，分别回到项目根
const projectRoot = resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.LCG_DATA_DIR
  ? resolve(process.env.LCG_DATA_DIR)
  : join(projectRoot, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, 'lcg.sqlite');
const PORT_FILE = join(DATA_DIR, 'port.json');

export const store = Store.open(DB_PATH);
export const service = new LcgService(store);

interface HttpError {
  code: ErrorCode;
  message: string;
  field?: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        rejectPromise(new ValidationError('BAD_REQUEST', '请求体超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          rejectPromise(new ValidationError('BAD_REQUEST', '请求体必须是 JSON 对象'));
          return;
        }
        resolvePromise(parsed as Record<string, unknown>);
      } catch {
        rejectPromise(new ValidationError('BAD_REQUEST', '请求体不是合法 JSON'));
      }
    });
    req.on('error', rejectPromise);
  });
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_INTEGER: 400,
  OUT_OF_RANGE: 400,
  M_TOO_SMALL: 400,
  TOO_MANY_DIGITS: 400,
  BATCH_TOO_LARGE: 400,
  MISSING_FIELD: 400,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
};

export function createApp(): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        send(res, 200, { ok: true, dataDir: DATA_DIR });
        return;
      }

      const m = path.match(/^\/api\/streams\/([^/]+)(\/(generate|jumps(\/preview)?|subsequence|operations))?$/);
      if (m) {
        const id = decodeURIComponent(m[1] as string);
        const action = m[3] as string | undefined;
        if (action === undefined && method === 'GET') {
          send(res, 200, service.get(id));
          return;
        }
        if (action === 'operations' && method === 'GET') {
          const limitRaw = url.searchParams.get('limit');
          const offsetRaw = url.searchParams.get('offset');
          send(
            res,
            200,
            service.listOperations(
              id,
              limitRaw === null ? undefined : Number(limitRaw),
              offsetRaw === null ? undefined : Number(offsetRaw),
            ),
          );
          return;
        }
        if (method !== 'POST') {
          send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${method} ${path}` } });
          return;
        }
        const body = await readJson(req);
        if (action === 'generate') {
          send(res, 200, service.generate(id, body.count, body.expectedVersion));
          return;
        }
        if (action === 'jumps/preview') {
          send(res, 200, service.previewJump(id, body.k));
          return;
        }
        if (action === 'jumps') {
          send(res, 200, service.commitJump(id, body.k, body.expectedVersion));
          return;
        }
        if (action === 'subsequence') {
          send(res, 200, service.createSubsequence(id, body.r, body.d));
          return;
        }
      }

      if (method === 'POST' && path === '/api/streams') {
        const body = await readJson(req);
        send(res, 201, service.create({
          m: body.m,
          a: body.a,
          c: body.c,
          seed: body.seed,
        }));
        return;
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${method} ${path}` } } satisfies { error: HttpError });
    } catch (err) {
      if (err instanceof ValidationError) {
        send(res, STATUS_BY_CODE[err.code], {
          error: { code: err.code, message: err.message, field: err.field },
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      send(res, 500, { error: { code: 'BAD_REQUEST', message: `服务器内部错误：${message}` } });
    }
  });
}

function listenPreferredPort(app: Server, preferred: number | undefined): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    app.on('error', rejectPromise);
    if (preferred !== undefined) {
      app.listen(preferred, '127.0.0.1', () => {
        const addr = app.address();
        resolvePromise(typeof addr === 'object' && addr ? addr.port : preferred);
      });
    } else {
      // 端口 0 = 由操作系统分配空闲端口
      app.listen(0, '127.0.0.1', () => {
        const addr = app.address();
        resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
      });
    }
  });
}

async function main(): Promise<void> {
  const preferred = process.env.PORT ? Number(process.env.PORT) : undefined;
  if (preferred !== undefined && (!Number.isSafeInteger(preferred) || preferred < 1 || preferred > 65535)) {
    throw new Error(`环境变量 PORT 非法：${process.env.PORT}`);
  }
  const app = createApp();
  const port = await listenPreferredPort(app, preferred);
  writeFileSync(PORT_FILE, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');
  console.log(`LCG 服务已启动：http://127.0.0.1:${port}`);
  console.log(`数据目录：${DATA_DIR}`);
  console.log(`SQLite：${DB_PATH}`);
  const shutdown = (): void => {
    app.closeAllConnections?.();
    app.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 仅作为入口直接运行时启动（被测试 import 时不启动）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
