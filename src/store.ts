import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface StreamRow {
  id: number;
  name: string;
  m: string;
  a: string;
  c: string;
  seed: string;
  state: string;
  pos: string; // 已产生的步数（绝对步号，十进制字符串）
  version: number;
  parent_id: number | null;
  sub_r: string | null;
  sub_d: string | null;
  created_at: string;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS streams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        m TEXT NOT NULL,
        a TEXT NOT NULL,
        c TEXT NOT NULL,
        seed TEXT NOT NULL,
        state TEXT NOT NULL,
        pos TEXT NOT NULL DEFAULT '0',
        version INTEGER NOT NULL DEFAULT 0,
        parent_id INTEGER,
        sub_r TEXT,
        sub_d TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS outputs (
        stream_id INTEGER NOT NULL,
        seq TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (stream_id, seq)
      );
      CREATE TABLE IF NOT EXISTS ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getStream(id: number): StreamRow | undefined {
    return this.db
      .prepare("SELECT * FROM streams WHERE id = ?")
      .get(id) as unknown as StreamRow | undefined;
  }

  listStreams(): StreamRow[] {
    return this.db
      .prepare("SELECT * FROM streams ORDER BY id")
      .all() as unknown as StreamRow[];
  }

  insertStream(s: {
    name: string;
    m: string;
    a: string;
    c: string;
    seed: string;
    parentId?: number | null;
    subR?: string | null;
    subD?: string | null;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO streams (name, m, a, c, seed, state, pos, version, parent_id, sub_r, sub_d)
         VALUES (?, ?, ?, ?, ?, ?, '0', 0, ?, ?, ?)`,
      )
      .run(
        s.name,
        s.m,
        s.a,
        s.c,
        s.seed,
        s.seed,
        s.parentId ?? null,
        s.subR ?? null,
        s.subD ?? null,
      );
    return Number(r.lastInsertRowid);
  }

  // 仅当版本匹配时推进状态，返回是否成功。
  advance(
    id: number,
    expectedVersion: number,
    newState: string,
    newPos: string,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE streams SET state = ?, pos = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(newState, newPos, id, expectedVersion);
    return Number(r.changes) === 1;
  }

  insertOutputs(streamId: number, startSeq: bigint, values: bigint[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO outputs (stream_id, seq, value) VALUES (?, ?, ?)",
    );
    for (let i = 0; i < values.length; i++) {
      stmt.run(streamId, (startSeq + BigInt(i)).toString(), values[i].toString());
    }
  }

  getOutputs(streamId: number, fromSeq: bigint, limit: number) {
    return this.db
      .prepare(
        "SELECT seq, value FROM outputs WHERE stream_id = ? AND CAST(seq AS INTEGER) >= ? ORDER BY CAST(seq AS INTEGER) LIMIT ?",
      )
      .all(streamId, fromSeq.toString(), limit) as unknown as {
      seq: string;
      value: string;
    }[];
  }

  logOp(streamId: number, type: string, detail: unknown): void {
    this.db
      .prepare("INSERT INTO ops (stream_id, type, detail) VALUES (?, ?, ?)")
      .run(streamId, type, JSON.stringify(detail));
  }

  listOps(streamId: number, limit: number) {
    return this.db
      .prepare(
        "SELECT id, type, detail, created_at FROM ops WHERE stream_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(streamId, limit);
  }

  close(): void {
    this.db.close();
  }
}
