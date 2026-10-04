import http from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openLedger, LedgerError, FERMENT_DAYS } from "./lib/ledger.js";
import { page } from "./lib/ui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "data");
mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT || 3039);

const ledger = await openLedger(dataDir);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LedgerError("bad_json", "请求体不是合法 JSON", 400);
  }
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function route(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : {};

  if (req.method === "GET" && p === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page({ fermentDays: FERMENT_DAYS }));
  }
  if (req.method === "GET" && p === "/api/batches")
    return send(res, 200, await ledger.listBatches());
  if (req.method === "POST" && p === "/api/batches") {
    const out = await ledger.registerBatch(body);
    return send(res, 201, out);
  }

  const batch = p.match(/^\/api\/batches\/([^/]+)$/);
  if (batch) {
    if (req.method === "GET") return send(res, 200, await ledger.getBatch(batch[1]));
  }
  const observe = p.match(/^\/api\/batches\/([^/]+)\/observations$/);
  if (observe && req.method === "POST") {
    const out = await ledger.recordObservation(observe[1], body);
    return send(res, 201, out);
  }
  const transfer = p.match(/^\/api\/batches\/([^/]+)\/transfer$/);
  if (transfer && req.method === "POST") {
    const out = await ledger.transferVat(transfer[1], body);
    return send(res, 201, out);
  }

  if (req.method === "GET" && p === "/api/vats") return send(res, 200, await ledger.listVats());
  if (req.method === "POST" && p === "/api/vats") {
    const out = await ledger.configureVat(body);
    return send(res, out.duplicate ? 200 : 201, out);
  }

  if (req.method === "GET" && p === "/api/events")
    return send(res, 200, await ledger.listEvents(Object.fromEntries(url.searchParams)));
  if (req.method === "GET" && p === "/api/stats") return send(res, 200, await ledger.stats());
  if (req.method === "GET" && p === "/api/legacy") return send(res, 200, await ledger.legacy());

  send(res, 404, { error: "not_found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    await route(req, res, url);
  } catch (error) {
    if (error instanceof LedgerError) {
      return send(res, error.http, {
        error: error.code,
        message: error.message,
        ...(Object.keys(error.details).length ? { details: error.details } : {}),
      });
    }
    send(res, 500, { error: "internal", message: error.message });
  }
});

server.listen(port, () =>
  console.log(`古法纸浆入缸账 listening on http://localhost:${port}（数据目录 ${dataDir}）`),
);

export { server };
