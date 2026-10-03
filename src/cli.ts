#!/usr/bin/env node
import path from "node:path";
import { Store } from "./store";
import { Service } from "./service";
import { startServer } from "./server";
import { ApiError } from "./errors";

const DATA_DIR = process.env.LCG_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "lcg.db");

function print(v: unknown) {
  console.log(JSON.stringify(v, null, 2));
}

function usage(): never {
  console.log(`用法: lcg <命令> [参数]

服务:
  serve [--port N]                     启动 HTTP API（默认自动选择空闲端口）

流操作（直接读写 ${DB_PATH}）:
  create --m M --a A --c C --seed S [--name NAME]
  list
  show <id>
  generate <id> --n N [--expected-version V]
  jump <id> --k K [--commit] [--expected-version V]
  substream <id> --r R --d D [--name NAME]
  verify <id>
  export <id> [--from SEQ] [--limit N]

所有整数参数均为十进制字符串。`);
  process.exit(1);
}

function parseFlags(args: string[]): {
  pos: string[];
  flags: Record<string, string | boolean>;
} {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      pos.push(t);
    }
  }
  return { pos, flags };
}

function need(flags: Record<string, string | boolean>, key: string): string {
  const v = flags[key];
  if (typeof v !== "string") throw new ApiError("INVALID_PARAM", `缺少参数 --${key}`);
  return v;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const { pos, flags } = parseFlags(rest);

  if (cmd === "serve") {
    const port =
      typeof flags.port === "string"
        ? Number(flags.port)
        : process.env.PORT
          ? Number(process.env.PORT)
          : 0; // 0 = 自动选择空闲端口
    const service = new Service(new Store(DB_PATH));
    const { port: actual } = await startServer(service, port);
    console.log(`LCG 服务已启动: http://127.0.0.1:${actual}  数据目录: ${DATA_DIR}`);
    return;
  }

  const service = new Service(new Store(DB_PATH));
  try {
    switch (cmd) {
      case "create":
        print(
          service.createStream({
            name: typeof flags.name === "string" ? flags.name : undefined,
            m: need(flags, "m"),
            a: need(flags, "a"),
            c: need(flags, "c"),
            seed: need(flags, "seed"),
          }),
        );
        break;
      case "list":
        print(service.listStreams());
        break;
      case "show":
        print(service.getStream(Number(pos[0])));
        break;
      case "generate":
        print(
          service.generate(
            Number(pos[0]),
            need(flags, "n"),
            flags["expected-version"],
          ),
        );
        break;
      case "jump":
        if (flags.commit) {
          print(
            service.commitJump(
              Number(pos[0]),
              need(flags, "k"),
              flags["expected-version"],
            ),
          );
        } else {
          print(service.previewJump(Number(pos[0]), need(flags, "k")));
        }
        break;
      case "substream":
        print(
          service.createSubstream(
            Number(pos[0]),
            need(flags, "r"),
            need(flags, "d"),
            typeof flags.name === "string" ? flags.name : undefined,
          ),
        );
        break;
      case "verify":
        print(service.verifySubstream(Number(pos[0])));
        break;
      case "export":
        print(
          service.exportRecords(
            Number(pos[0]),
            typeof flags.from === "string" ? flags.from : undefined,
            typeof flags.limit === "string" ? flags.limit : undefined,
          ),
        );
        break;
      default:
        usage();
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`错误 [${e.code}]: ${e.message}`);
      process.exit(2);
    }
    throw e;
  } finally {
    service.store.close();
  }
}

main();
