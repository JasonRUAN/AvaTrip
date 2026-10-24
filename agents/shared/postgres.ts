import { createLogger } from "./logger";
import {
  getKernelSnapshot,
  replaceKernel,
  setKernelFlusher,
  type KernelSnapshot,
} from "./store";

const log = createLogger("postgres");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  run_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
  run_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  scope TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS settlement_jobs (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS vouchers (
  scope TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS itineraries (
  scope TEXT PRIMARY KEY,
  payload JSONB NOT NULL
);
`;

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end: () => Promise<void>;
};

let pool: Queryable | null = null;
let flushChain: Promise<void> = Promise.resolve();

async function upsert(table: string, key: string, rows: Array<{ id: string; payload: unknown }>) {
  if (!pool) return;
  for (const row of rows) {
    await pool.query(
      `INSERT INTO ${table} (${key}, payload) VALUES ($1, $2::jsonb)
       ON CONFLICT (${key}) DO UPDATE SET payload = EXCLUDED.payload`,
      [row.id, JSON.stringify(row.payload)]
    );
  }
}

async function flushSnapshot(snapshot: KernelSnapshot): Promise<void> {
  if (!pool) return;
  await upsert("runs", "run_id", snapshot.runs.map((run) => ({ id: run.runId, payload: run })));
  await upsert("quotes", "run_id", snapshot.quotes.map((row) => ({ id: row.runId, payload: row.quote })));
  await upsert("offers", "run_id", snapshot.offers.map((row) => ({ id: row.runId, payload: row.offers })));
  await upsert("orders", "scope", snapshot.orders.map((row) => ({ id: row.scope, payload: row.order })));
  await upsert("settlement_jobs", "id", snapshot.jobs.map((job) => ({ id: job.id, payload: job })));
  await upsert("vouchers", "scope", snapshot.vouchers.map((row) => ({ id: row.scope, payload: row.voucher })));
  await upsert(
    "itineraries",
    "scope",
    snapshot.itineraries.map((row) => ({ id: row.scope, payload: row.itinerary }))
  );
}

function scheduleFlush(snapshot: KernelSnapshot): void {
  flushChain = flushChain
    .then(() => flushSnapshot(snapshot))
    .catch((error: unknown) => {
      log.error("Postgres 写入失败，内存与本地文件仍保留", {}, error);
    });
}

async function readTable(table: string, key: string): Promise<Array<{ id: string; payload: unknown }>> {
  if (!pool) return [];
  const result = await pool.query(`SELECT ${key} AS id, payload FROM ${table}`);
  return result.rows.map((row) => ({ id: String(row.id), payload: row.payload }));
}

function payloadOf<T>(row: { payload: unknown }): T {
  return row.payload as T;
}

/**
 * DATABASE_URL 存在时把 run / quote / order / settlement / voucher 放到 Postgres。
 * 连不上则继续用本地 kernel.json，不阻断演示。
 */
export async function initPostgres(): Promise<boolean> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    log.info("未配置 DATABASE_URL，订单内核使用本地文件");
    return false;
  }
  try {
    const pg = await import("pg");
    const Pool = pg.Pool ?? pg.default.Pool;
    const next = new Pool({ connectionString: url }) as Queryable;
    await next.query("SELECT 1");
    await next.query(SCHEMA);
    pool = next;
    const [runRows, quoteRows, offerRows, orderRows, jobRows, voucherRows, itineraryRows] = await Promise.all([
      readTable("runs", "run_id"),
      readTable("quotes", "run_id"),
      readTable("offers", "run_id"),
      readTable("orders", "scope"),
      readTable("settlement_jobs", "id"),
      readTable("vouchers", "scope"),
      readTable("itineraries", "scope"),
    ]);
    const total =
      runRows.length + quoteRows.length + offerRows.length + orderRows.length + jobRows.length + voucherRows.length + itineraryRows.length;
    if (total > 0) {
      const snapshot: KernelSnapshot = {
        runs: runRows.map((row) => payloadOf(row)),
        quotes: quoteRows.map((row) => ({ runId: row.id, quote: payloadOf(row) })),
        offers: offerRows.map((row) => ({ runId: row.id, offers: payloadOf(row) })),
        orders: orderRows.map((row) => ({ scope: row.id, order: payloadOf(row) })),
        jobs: jobRows.map((row) => payloadOf(row)),
        vouchers: voucherRows.map((row) => ({ scope: row.id, voucher: payloadOf(row) })),
        itineraries: itineraryRows.map((row) => ({ scope: row.id, itinerary: payloadOf(row) })),
      };
      replaceKernel(snapshot);
      log.info("已从 Postgres 恢复订单内核", { rows: total });
    } else {
      await flushSnapshot(getKernelSnapshot());
      log.info("Postgres 为空，已写入当前本地内核");
    }
    setKernelFlusher((snapshot) => scheduleFlush(snapshot));
    return true;
  } catch (error) {
    log.error("Postgres 不可用，回退到本地文件", {}, error);
    pool = null;
    return false;
  }
}
