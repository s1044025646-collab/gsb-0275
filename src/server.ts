import http from "node:http";
import { Service } from "./service";
import { ApiError } from "./errors";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_PARAM", "请求体必须是合法 JSON");
  }
}

function parseId(s: string | undefined, name = "id"): number {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ApiError("INVALID_PARAM", `${name} 必须是正整数`);
  }
  return n;
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body =
        method === "POST" || method === "PUT" ? await readBody(req) : {};

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/streams") {
        return send(res, 201, service.createStream(body));
      }
      if (method === "GET" && url.pathname === "/streams") {
        return send(res, 200, service.listStreams());
      }
      if (parts[0] === "streams" && parts.length >= 2) {
        const id = parseId(parts[1]);
        const action = parts[2];
        if (method === "GET" && parts.length === 2) {
          return send(res, 200, service.getStream(id));
        }
        if (method === "POST" && action === "generate") {
          return send(
            res,
            200,
            service.generate(id, body.n, body.expectedVersion),
          );
        }
        if (method === "POST" && action === "jump") {
          if (body.commit === true) {
            return send(
              res,
              200,
              service.commitJump(id, body.k, body.expectedVersion),
            );
          }
          return send(res, 200, service.previewJump(id, body.k));
        }
        if (method === "POST" && action === "substream") {
          return send(
            res,
            201,
            service.createSubstream(id, body.r, body.d, body.name),
          );
        }
        if (method === "GET" && action === "verify") {
          return send(res, 200, service.verifySubstream(id));
        }
        if (method === "GET" && action === "export") {
          return send(
            res,
            200,
            service.exportRecords(
              id,
              url.searchParams.get("from") ?? undefined,
              url.searchParams.get("limit") ?? undefined,
            ),
          );
        }
      }
      send(res, 404, { code: "NOT_FOUND", message: "路由不存在" });
    } catch (e) {
      if (e instanceof ApiError) {
        send(res, e.status, { code: e.code, message: e.message });
      } else {
        send(res, 500, {
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });
}

export function startServer(
  service: Service,
  port: number,
): Promise<{ server: http.Server; port: number }> {
  const server = createServer(service);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actual });
    });
  });
}
