/**
 * SQLite 存储层（Node.js 内置 node:sqlite，无需编译原生模块）。
 *
 * streams:    LCG 参数、当前状态、绝对步号 position、版本 version
 * operations: 操作记录（create/generate/jump/subsequence/preview 不入库）
 *
 * 所有“生成并推进 / 跳步推进”都在单个事务中完成：
 * 先校验 expectedVersion，再更新状态、步号、版本并写操作记录；
 * 任一步失败整体回滚，不会只推进一部分。
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';

export interface StreamRow {
  id: string;
  m: string;
  a: string;
  c: string;
  state: string;
  position: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface NewStreamInput {
  m: bigint;
  a: bigint;
  c: bigint;
  seed: bigint;
}

export interface OperationRow {
  id: number;
  stream_id: string;
  type: string;
  detail: string;
  position: string;
  version: number;
  created_at: string;
}

const nowIso = (): string => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  /** 按数据库路径复用同一连接，避免多连接在 WAL 下互不可见。 */
  private static readonly instances = new Map<string, Store>();

  static open(dbPath: string): Store {
    const existing = Store.instances.get(dbPath);
    if (existing) return existing;
    const created = new Store(dbPath);
    Store.instances.set(dbPath, created);
    return created;
  }

  private readonly insStream: StatementSync;
  private readonly insOp: StatementSync;
  private readonly getStreamStmt: StatementSync;
  private readonly updateStmt: StatementSync;
  private readonly listOpsStmt: StatementSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.init();
    this.insStream = this.db.prepare(
      `INSERT INTO streams (id,m,a,c,state,position,version,created_at,updated_at)
       VALUES ($id,$m,$a,$c,$state, '0', 1, $ts, $ts)`,
    );
    this.insOp = this.db.prepare(
      `INSERT INTO operations (stream_id,type,detail,position,version,created_at)
       VALUES ($sid,$type,$detail,$pos,$ver,$ts)`,
    );
    this.getStreamStmt = this.db.prepare('SELECT * FROM streams WHERE id = $id');
    this.updateStmt = this.db.prepare(
      `UPDATE streams
         SET state = $state, position = $pos, version = version + 1, updated_at = $ts
       WHERE id = $id AND version = $ver`,
    );
    this.listOpsStmt = this.db.prepare(
      `SELECT * FROM operations WHERE stream_id = $sid
       ORDER BY id ASC LIMIT $lim OFFSET $off`,
    );
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        id         TEXT PRIMARY KEY,
        m          TEXT NOT NULL,
        a          TEXT NOT NULL,
        c          TEXT NOT NULL,
        state      TEXT NOT NULL,
        position   TEXT NOT NULL DEFAULT '0',
        version    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id  TEXT NOT NULL,
        type       TEXT NOT NULL,
        detail     TEXT NOT NULL,
        position   TEXT NOT NULL,
        version    INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(stream_id) REFERENCES streams(id)
      );
    `);
  }

  private toRow(r: unknown): StreamRow {
    const o = r as Record<string, unknown>;
    return {
      id: o.id as string,
      m: o.m as string,
      a: o.a as string,
      c: o.c as string,
      state: o.state as string,
      position: o.position as string,
      version: o.version as number,
      created_at: o.created_at as string,
      updated_at: o.updated_at as string,
    };
  }

  /** 创建流并写 create 记录（同一事务）。 */
  createStream(p: NewStreamInput, id: string = randomUUID()): StreamRow {
    const ts = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insStream.run({
        id,
        m: p.m.toString(),
        a: p.a.toString(),
        c: p.c.toString(),
        state: p.seed.toString(),
        ts,
      });
      this.insOp.run({
        sid: id,
        type: 'create',
        detail: JSON.stringify({
          m: p.m.toString(),
          a: p.a.toString(),
          c: p.c.toString(),
          seed: p.seed.toString(),
        }),
        pos: '0',
        ver: 1,
        ts,
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getStream(id);
  }

  getStream(id: string): StreamRow {
    const r = this.getStreamStmt.get({ id });
    if (!r) {
      throw new ValidationError('NOT_FOUND', `流 ${id} 不存在`);
    }
    return this.toRow(r);
  }

  /**
   * 在事务中原子推进流：
   * 仅当数据库当前 version === expectedVersion 时更新，
   * 同时写一条操作记录。版本不符抛 VERSION_CONFLICT。
   */
  advance(
    id: string,
    expectedVersion: number,
    newState: bigint,
    newPosition: bigint,
    type: string,
    detail: Record<string, unknown>,
  ): StreamRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getStreamStmt.get({ id });
      if (!current) {
        throw new ValidationError('NOT_FOUND', `流 ${id} 不存在`);
      }
      const curVer = (current as Record<string, unknown>).version as number;
      if (curVer !== expectedVersion) {
        throw new ValidationError(
          'VERSION_CONFLICT',
          `版本冲突：期望版本 ${expectedVersion}，当前版本 ${curVer}`,
        );
      }
      const ts = nowIso();
      const res = this.updateStmt.run({
        state: newState.toString(),
        pos: newPosition.toString(),
        ts,
        id,
        ver: expectedVersion,
      });
      if (res.changes !== 1) {
        throw new ValidationError('VERSION_CONFLICT', '版本冲突：状态已被其他请求修改');
      }
      this.insOp.run({
        sid: id,
        type,
        detail: JSON.stringify(detail),
        pos: newPosition.toString(),
        ver: expectedVersion + 1,
        ts,
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getStream(id);
  }

  listOperations(id: string, limit: number, offset: number): OperationRow[] {
    this.getStream(id); // 不存在则 404
    const rows = this.listOpsStmt.all({
      sid: id,
      lim: BigInt(limit),
      off: BigInt(offset),
    }) as unknown[];
    return rows.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        id: o.id as number,
        stream_id: o.stream_id as string,
        type: o.type as string,
        detail: o.detail as string,
        position: o.position as string,
        version: o.version as number,
        created_at: o.created_at as string,
      };
    });
  }

  close(): void {
    this.db.close();
    for (const [path, s] of Store.instances) {
      if (s === this) Store.instances.delete(path);
    }
  }
}
