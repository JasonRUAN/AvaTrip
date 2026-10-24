import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentChainId, LEGACY_CHAIN_ID, scopeKey } from "./chains";
import { createLogger } from "./logger";
import type { PlanOffers } from "./demo-run";
import type { ItineraryDay, Quote, TripRequest, VoucherDetail } from "./types";

const log = createLogger("store");

/**
 * 进程内状态。
 *
 * 演示规模下不需要数据库，但凭证的链下明细（details）链上只有哈希、
 * 无法重建，所以 vouchers 必须落盘持久化：后端重启后 tokenURI / 凭证
 * 查询仍能拿到完整明细，而不是退化为「从链上状态重建」的空壳。
 * 生产化时把这几张表换成 Postgres 即可，接口不变。
 */

/** 数据文件锚定在本模块目录下，避免受启动时 cwd 影响 */
const DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".data"
);
const VOUCHERS_FILE = path.join(DATA_DIR, "vouchers.json");
const ITINERARIES_FILE = path.join(DATA_DIR, "itineraries.json");
const KERNEL_FILE = path.join(DATA_DIR, "kernel.json");

export interface RunRecord {
  runId: string;
  tripId: string;
  request: TripRequest;
  quote?: Quote;
  days?: ItineraryDay[];
  selectedOfferIds?: string[];
  createdAt: number;
  chainId?: number;
}

export interface OrderRecord {
  orderId: string;
  runId: string;
  tripId: string;
  traveler: `0x${string}`;
  total: string;
  createTxHash?: `0x${string}`;
  status: "funded" | "verifying" | "settling" | "settled" | "partial" | "failed";
  createdAt: number;
}

/** 可恢复的分账任务。id = `${chainId}:${orderId}`，也是幂等键。 */
export interface SettlementJob {
  id: string;
  chainId: number;
  orderId: string;
  runId: string;
  traveler: `0x${string}`;
  status: "pending" | "running" | "settled" | "partial" | "failed";
  attempts: number;
  /** item index → 已签发 tokenId，重试时跳过 */
  issued: Record<string, string>;
  lastError?: string;
  updatedAt: number;
}

export interface OrderItinerary {
  orderId: string;
  runId: string;
  days: ItineraryDay[];
  quote?: Quote;
  request?: TripRequest;
  chainId?: number;
}

interface PersistedVoucher extends VoucherDetail {
  chainId?: number;
}

export const runs = new Map<string, RunRecord>();
export const quotes = new Map<string, Quote>();
/** runId → 询价结果（发券时需要原始明细） */
export const offersByRun = new Map<string, PlanOffers>();
export const orders = new Map<string, OrderRecord>();
export const jobs = new Map<string, SettlementJob>();
export const itineraries = new Map<string, OrderItinerary>(loadPersistedItineraries());
/** `${chainId}:${tokenId}` → 凭证明细（链下部分，持久化到 .data/vouchers.json） */
export const vouchers = new Map<string, VoucherDetail>(
  loadPersistedVouchers()
);
/** holder(小写) → `${chainId}:${tokenId}`[] */
export const vouchersByHolder = new Map<string, string[]>();

hydrateKernel();

// 启动时按持有人重建二级索引（索引本身不落盘）
for (const [id, voucher] of vouchers) {
  const key = voucher.holder.toLowerCase();
  const list = vouchersByHolder.get(key) ?? [];
  if (!list.includes(id)) list.push(id);
  vouchersByHolder.set(key, list);
}

log.info("本地状态已恢复", {
  vouchers: vouchers.size,
  holders: vouchersByHolder.size,
  itineraries: itineraries.size,
  runs: runs.size,
  orders: orders.size,
  jobs: jobs.size,
});

function loadPersistedVouchers(): [string, VoucherDetail][] {
  try {
    const raw = readFileSync(VOUCHERS_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedVoucher[];
    if (!Array.isArray(parsed)) {
      log.warn("凭证明细文件格式异常，按空状态启动", { file: VOUCHERS_FILE });
      return [];
    }
    const rows = parsed
      .filter((v) => v && typeof v.tokenId === "string")
      .map((v) => {
        const chainId = v.chainId ?? LEGACY_CHAIN_ID;
        return [scopeKey(chainId, v.tokenId), v] as [string, VoucherDetail];
      });
    log.info("已加载凭证明细", {
      file: VOUCHERS_FILE,
      count: rows.length,
      dropped: parsed.length - rows.length,
    });
    return rows;
  } catch (error) {
    // 文件不存在属正常首次启动；解析失败则意味着链下明细真的丢了，必须报警
    const reason = (error as Error).message;
    if (reason.includes("ENOENT")) log.info("未找到凭证明细文件，从空状态启动", { file: VOUCHERS_FILE });
    else log.error("凭证明细加载失败（链下明细可能已丢失）", { file: VOUCHERS_FILE }, error);
    return [];
  }
}

function persistVouchers(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify([...vouchers.values()]);
    writeFileSync(VOUCHERS_FILE, payload, "utf8");
    log.debug("凭证明细已落盘", { count: vouchers.size, bytes: payload.length });
    notifyFlusher();
  } catch (error) {
    log.error("凭证明细落盘失败", { file: VOUCHERS_FILE }, error);
  }
}

export function indexVoucher(voucher: VoucherDetail, chainId = currentChainId()): void {
  const stored: PersistedVoucher = { ...voucher, chainId };
  const id = scopeKey(chainId, voucher.tokenId);
  vouchers.set(id, stored);
  const key = voucher.holder.toLowerCase();
  const list = vouchersByHolder.get(key) ?? [];
  if (!list.includes(id)) list.push(id);
  vouchersByHolder.set(key, list);
  log.debug("凭证已索引", {
    tokenId: voucher.tokenId,
    holder: voucher.holder,
    category: voucher.category,
    status: voucher.status,
  });
  persistVouchers();
}

function loadPersistedItineraries(): [string, OrderItinerary][] {
  try {
    const raw = readFileSync(ITINERARIES_FILE, "utf8");
    const parsed = JSON.parse(raw) as OrderItinerary[];
    if (!Array.isArray(parsed)) {
      log.warn("行程单文件格式异常，按空状态启动", { file: ITINERARIES_FILE });
      return [];
    }
    return parsed
      .filter((item) => item && typeof item.orderId === "string")
      .map((item) => {
        const chainId = item.chainId ?? LEGACY_CHAIN_ID;
        return [scopeKey(chainId, item.orderId), item] as [string, OrderItinerary];
      });
  } catch (error) {
    const reason = (error as Error).message;
    if (!reason.includes("ENOENT")) {
      log.error("行程单加载失败", { file: ITINERARIES_FILE }, error);
    }
    return [];
  }
}

function persistItineraries(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify([...itineraries.values()]);
    writeFileSync(ITINERARIES_FILE, payload, "utf8");
    log.debug("行程单已落盘", { count: itineraries.size, bytes: payload.length });
    notifyFlusher();
  } catch (error) {
    log.error("行程单落盘失败", { file: ITINERARIES_FILE }, error);
  }
}

export function saveItinerary(snapshot: OrderItinerary, chainId = currentChainId()): void {
  const stored = { ...snapshot, chainId };
  itineraries.set(scopeKey(chainId, snapshot.orderId), stored);
  log.debug("保存行程单", { orderId: snapshot.orderId, chainId, runId: snapshot.runId, days: snapshot.days.length });
  persistItineraries();
}

export function getItinerary(orderId: string, chainId = currentChainId()): OrderItinerary | undefined {
  return itineraries.get(scopeKey(chainId, orderId));
}

export function putOrder(order: OrderRecord, chainId = currentChainId()): void {
  orders.set(scopeKey(chainId, order.orderId), order);
  persistKernel();
}

export function saveRun(run: RunRecord): void {
  runs.set(run.runId, run);
  persistKernel();
}

export function saveQuote(runId: string, quote: Quote): void {
  quotes.set(runId, quote);
  persistKernel();
}

export function saveOffers(runId: string, offers: PlanOffers): void {
  offersByRun.set(runId, offers);
  persistKernel();
}

export function getJob(chainId: number, orderId: string): SettlementJob | undefined {
  return jobs.get(scopeKey(chainId, orderId));
}

export function saveJob(job: SettlementJob): void {
  jobs.set(job.id, job);
  persistKernel();
}

export function listJobs(): SettlementJob[] {
  return [...jobs.values()];
}

export function getOrder(orderId: string, chainId = currentChainId()): OrderRecord | undefined {
  return orders.get(scopeKey(chainId, orderId));
}

export function getVoucher(tokenId: string, chainId = currentChainId()): VoucherDetail | undefined {
  return vouchers.get(scopeKey(chainId, tokenId));
}

export interface KernelSnapshot {
  runs: RunRecord[];
  quotes: Array<{ runId: string; quote: Quote }>;
  offers: Array<{ runId: string; offers: PlanOffers }>;
  orders: Array<{ scope: string; order: OrderRecord }>;
  jobs: SettlementJob[];
  vouchers: Array<{ scope: string; voucher: PersistedVoucher }>;
  itineraries: Array<{ scope: string; itinerary: OrderItinerary }>;
}

interface KernelFile {
  runs?: RunRecord[];
  quotes?: Array<{ runId: string; quote: Quote }>;
  offers?: Array<{ runId: string; offers: PlanOffers }>;
  orders?: Array<{ scope: string; order: OrderRecord }>;
  jobs?: SettlementJob[];
}

let flusher: ((snapshot: KernelSnapshot) => void) | null = null;
let silentFlush = false;

export function setKernelFlusher(fn: ((snapshot: KernelSnapshot) => void) | null): void {
  flusher = fn;
}

export function getKernelSnapshot(): KernelSnapshot {
  return {
    runs: [...runs.values()],
    quotes: [...quotes.entries()].map(([runId, quote]) => ({ runId, quote })),
    offers: [...offersByRun.entries()].map(([runId, offers]) => ({ runId, offers })),
    orders: [...orders.entries()].map(([scope, order]) => ({ scope, order })),
    jobs: [...jobs.values()],
    vouchers: [...vouchers.entries()].map(([scope, voucher]) => ({
      scope,
      voucher: voucher as PersistedVoucher,
    })),
    itineraries: [...itineraries.entries()].map(([scope, itinerary]) => ({ scope, itinerary })),
  };
}

function notifyFlusher(): void {
  if (silentFlush || !flusher) return;
  flusher(getKernelSnapshot());
}

function persistKernel(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const file: KernelFile = {
      runs: [...runs.values()],
      quotes: [...quotes.entries()].map(([runId, quote]) => ({ runId, quote })),
      offers: [...offersByRun.entries()].map(([runId, offers]) => ({ runId, offers })),
      orders: [...orders.entries()].map(([scope, order]) => ({ scope, order })),
      jobs: [...jobs.values()],
    };
    writeFileSync(KERNEL_FILE, JSON.stringify(file), "utf8");
  } catch (error) {
    log.error("订单内核落盘失败", { file: KERNEL_FILE }, error);
  }
  notifyFlusher();
}

function hydrateKernel(): void {
  try {
    const parsed = JSON.parse(readFileSync(KERNEL_FILE, "utf8")) as KernelFile;
    for (const run of parsed.runs ?? []) {
      if (run?.runId) runs.set(run.runId, run);
    }
    for (const row of parsed.quotes ?? []) {
      if (row?.runId && row.quote) quotes.set(row.runId, row.quote);
    }
    for (const row of parsed.offers ?? []) {
      if (row?.runId && row.offers) offersByRun.set(row.runId, row.offers);
    }
    for (const row of parsed.orders ?? []) {
      if (row?.scope && row.order) orders.set(row.scope, row.order);
    }
    for (const job of parsed.jobs ?? []) {
      if (job?.id) jobs.set(job.id, job);
    }
  } catch (error) {
    const reason = (error as Error).message;
    if (!reason.includes("ENOENT")) log.error("订单内核加载失败", { file: KERNEL_FILE }, error);
  }
}

/** Postgres 启动时用库内快照覆盖内存，并回写本地文件。不再次推回数据库。 */
export function replaceKernel(snapshot: KernelSnapshot): void {
  silentFlush = true;
  try {
    runs.clear();
    quotes.clear();
    offersByRun.clear();
    orders.clear();
    jobs.clear();
    vouchers.clear();
    itineraries.clear();
    vouchersByHolder.clear();
    for (const run of snapshot.runs) runs.set(run.runId, run);
    for (const row of snapshot.quotes) quotes.set(row.runId, row.quote);
    for (const row of snapshot.offers) offersByRun.set(row.runId, row.offers);
    for (const row of snapshot.orders) orders.set(row.scope, row.order);
    for (const job of snapshot.jobs) jobs.set(job.id, job);
    for (const row of snapshot.vouchers) {
      vouchers.set(row.scope, row.voucher);
      const key = row.voucher.holder.toLowerCase();
      const list = vouchersByHolder.get(key) ?? [];
      if (!list.includes(row.scope)) list.push(row.scope);
      vouchersByHolder.set(key, list);
    }
    for (const row of snapshot.itineraries) itineraries.set(row.scope, row.itinerary);
    persistKernel();
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(VOUCHERS_FILE, JSON.stringify([...vouchers.values()]), "utf8");
    writeFileSync(ITINERARIES_FILE, JSON.stringify([...itineraries.values()]), "utf8");
  } finally {
    silentFlush = false;
  }
}

export function listVouchersByHolder(holder: string, chainId = currentChainId()): VoucherDetail[] {
  const prefix = `${chainId}:`;
  const ids = vouchersByHolder.get(holder.toLowerCase()) ?? [];
  return ids
    .filter((id) => id.startsWith(prefix))
    .map((id) => vouchers.get(id))
    .filter((v): v is VoucherDetail => Boolean(v));
}
