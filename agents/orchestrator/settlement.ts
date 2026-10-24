import { parseEventLogs } from "viem";
import { SETTLEMENT_ABI } from "../shared/abis";
import { audit } from "../shared/audit";
import {
  compareOrderBinding,
  expectedItemsFromQuote,
  receiptBindsOrder,
  type OnChainOrderView,
} from "../shared/order-binding";
import { claimSettlement, outcomePhase } from "../shared/order-machine";
import {
  contractAddresses,
  enqueueWalletSend,
  orchestratorWallet,
  publicClient,
} from "../shared/clients";
import { currentChainId, isChainReady, scopeKey } from "../shared/chains";
import { CATEGORY_TO_KEY } from "../shared/env";
import { createLogger, startTimer } from "../shared/logger";
import { getOrderChannel, touch } from "../shared/sse";
import { getJob, getOrder, offersByRun, putOrder, runs, saveJob, type SettlementJob } from "../shared/store";
import type { CategoryCode, Quote, SettlementEvent, SettlementStep } from "../shared/types";
import { listAgentProfiles } from "./registry";
import { issueViaProvider } from "./voucher";

export interface SettleParams {
  orderId: string;
  runId: string;
  quote?: Quote;
  traveler: `0x${string}`;
}

const log = createLogger("settlement");

async function readOnChainOrder(orderId: string): Promise<OnChainOrderView | null> {
  const { settlement } = contractAddresses();
  const order = await publicClient.readContract({
    address: settlement,
    abi: SETTLEMENT_ABI,
    functionName: "getOrder",
    args: [BigInt(orderId)],
  });
  if (order[0] === "0x0000000000000000000000000000000000000000") return null;
  const items = await publicClient.readContract({
    address: settlement,
    abi: SETTLEMENT_ABI,
    functionName: "getItems",
    args: [BigInt(orderId)],
  });
  return {
    traveler: order[0],
    total: order[1],
    status: Number(order[5]),
    itineraryHash: order[3],
    items: items.map((item) => ({
      provider: item.provider,
      amount: item.amount,
      category: Number(item.category),
      itemHash: item.itemHash,
    })),
  };
}

async function assertReceipt(txHash: `0x${string}`, orderId: string, traveler: string, total: bigint) {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const parsed = parseEventLogs({
    abi: SETTLEMENT_ABI,
    logs: receipt.logs,
    eventName: "OrderCreated",
  });
  const bound = receiptBindsOrder(
    parsed.map((item) => ({
      orderId: item.args.orderId,
      traveler: item.args.traveler,
      total: item.args.total,
    })),
    { orderId: BigInt(orderId), traveler, total }
  );
  if (!bound) {
    throw new Error("ORDER_CREATED_MISMATCH");
  }
}

async function itemAlreadySettled(orderId: string, index: number): Promise<boolean> {
  const { settlement } = contractAddresses();
  return publicClient.readContract({
    address: settlement,
    abi: SETTLEMENT_ABI,
    functionName: "isItemSettled",
    args: [BigInt(orderId), BigInt(index)],
  });
}

export async function settleOrder(params: SettleParams): Promise<void> {
  const { orderId, runId, quote } = params;
  const elapsed = startTimer();
  const settleLog = log.child({ orderId, runId });
  const channel = getOrderChannel(orderId);
  const emit = (event: SettlementEvent) => {
    touch(scopeKey(currentChainId(), orderId));
    channel.push(event);
  };

  if (!quote) {
    settleLog.error("分账中止：找不到报价单");
    emit({ type: "settlement.error", code: "QUOTE_MISSING", message: "找不到该订单对应的报价单" });
    return;
  }

  const chainId = currentChainId();
  const record = getOrder(orderId);
  const existingJob = getJob(chainId, orderId);
  const claim = claimSettlement(existingJob);
  if (claim === "duplicate") {
    settleLog.warn("分账任务已在执行，忽略重复请求");
    return;
  }
  if (claim === "done" && existingJob?.status === "settled") {
    emit({
      type: "settlement.done",
      orderId,
      tokenIds: Object.values(existingJob.issued),
      status: "settled",
    });
    return;
  }
  if (claim === "done") {
    emit({
      type: "settlement.error",
      code: "SETTLEMENT_EXHAUSTED",
      message: "分账重试次数已用尽",
    });
    return;
  }

  const job: SettlementJob = {
    id: scopeKey(chainId, orderId),
    chainId,
    orderId,
    runId,
    traveler: params.traveler,
    status: "running",
    attempts: (existingJob?.attempts ?? 0) + 1,
    issued: { ...(existingJob?.issued ?? {}) },
    updatedAt: Date.now(),
  };
  saveJob(job);
  if (record) {
    record.status = "settling";
    putOrder(record, chainId);
  }

  const request = runs.get(runId)?.request;
  const offers = offersByRun.get(runId);
  const now = Math.floor(Date.now() / 1000);
  const validTo = now + 90 * 24 * 3600;
  const profiles = await listAgentProfiles();

  emit({ type: "settlement.start", orderId, total: quote.total });

  const chainReady = isChainReady();
  let settleOnChain = false;
  if (chainReady) {
    try {
      const onChain = await readOnChainOrder(orderId);
      if (!onChain) {
        throw Object.assign(new Error("链上不存在该订单"), { code: "ORDER_NOT_ONCHAIN" });
      }
      const verdict = compareOrderBinding(onChain, {
        traveler: params.traveler,
        total: BigInt(quote.total),
        itineraryHash: quote.itineraryHash,
        items: expectedItemsFromQuote(quote),
      });
      if (!verdict.ok) {
        throw Object.assign(new Error(verdict.message), { code: verdict.code });
      }
      const txHash = record?.createTxHash;
      if (!txHash) {
        throw Object.assign(new Error("缺少创建订单的交易哈希"), { code: "TX_HASH_MISSING" });
      }
      await assertReceipt(txHash, orderId, params.traveler, BigInt(quote.total));
      settleOnChain = true;
      audit("settlement.verified", { orderId, chainId, traveler: params.traveler });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "ORDER_BINDING_FAILED";
      const message = error instanceof Error ? error.message : "链上订单校验失败";
      job.status = "failed";
      job.lastError = message;
      job.updatedAt = Date.now();
      saveJob(job);
      if (record) {
        record.status = "failed";
        putOrder(record, chainId);
      }
      audit("settlement.rejected", { orderId, chainId, code, message });
      settleLog.error("拒绝分账：链上绑定未通过，不会改走模拟", { code, message });
      emit({ type: "settlement.error", code, message });
      return;
    }
  }

  settleLog.info("开始分账", {
    total: quote.total,
    lineItems: quote.lineItems.length,
    traveler: params.traveler,
    mode: settleOnChain ? "onchain" : "simulated",
    chainReady,
    attempt: job.attempts,
  });
  if (!settleOnChain) {
    settleLog.warn("链上能力未启用，交易哈希为模拟值", { chainReady });
  }

  const issued = await Promise.all(
    quote.lineItems.map(async (lineItem, index) => {
      const category = lineItem.category as CategoryCode;
      const stepKey = String(index);
      const step: SettlementStep = {
        key: `${orderId}-${index}`,
        provider: lineItem.provider,
        providerName: lineItem.providerName,
        category,
        label: lineItem.label,
        status: "settling",
      };
      if (job.issued[stepKey]) {
        step.status = "issued";
        step.tokenId = job.issued[stepKey];
        emit({ type: "settlement.step", step });
        return job.issued[stepKey];
      }
      emit({ type: "settlement.step", step });
      const stepLog = settleLog.child({ index, provider: lineItem.provider, category: lineItem.category });

      try {
        if (settleOnChain) {
          const already = await itemAlreadySettled(orderId, index);
          if (!already) {
            const wallet = orchestratorWallet();
            const { settlement } = contractAddresses();
            const txElapsed = startTimer();
            const { hash, receipt } = await enqueueWalletSend(wallet.account.address, async () => {
              const hash = await wallet.writeContract({
                address: settlement,
                abi: SETTLEMENT_ABI,
                functionName: "settle",
                args: [BigInt(orderId), [BigInt(index)]],
                chain: undefined,
              });
              const receipt = await publicClient.waitForTransactionReceipt({ hash });
              return { hash, receipt };
            });
            if (receipt.status === "reverted") {
              throw new Error("分账交易已回滚");
            }
            stepLog.info("分账交易已确认", {
              txHash: hash,
              ms: txElapsed(),
              gasUsed: receipt.gasUsed?.toString(),
              blockNumber: receipt.blockNumber?.toString(),
            });
            step.txHash = hash;
          }
        } else {
          await sleep(400);
          step.txHash = simulateHash();
          stepLog.debug("已生成模拟分账哈希", { txHash: step.txHash });
        }
        step.status = "paid";
        emit({ type: "settlement.step", step: { ...step } });

        const { title, details } = voucherContent(category, lineItem, offers, request, quote.tripId);
        const profile = profiles.find(
          (item) => item.address.toLowerCase() === lineItem.provider.toLowerCase()
        );
        if (!profile) throw new Error(`找不到服务商 endpoint: ${lineItem.provider}`);

        const voucher = await issueViaProvider({
          endpoint: profile.endpoint,
          category,
          holder: params.traveler,
          orderId,
          title,
          details,
          validFrom: now,
          validTo,
        });
        step.voucherTxHash = voucher.txHash;
        step.tokenId = voucher.tokenId;
        step.voucherCode = voucher.detail.code;
        step.status = "issued";
        job.issued[stepKey] = voucher.tokenId;
        job.updatedAt = Date.now();
        saveJob(job);
        emit({ type: "settlement.step", step: { ...step } });
        stepLog.info("凭证签发完成", { tokenId: voucher.tokenId, voucherTxHash: voucher.txHash });
        return voucher.tokenId;
      } catch (error) {
        stepLog.error("分账条目失败", { label: lineItem.label }, error);
        step.status = "failed";
        step.error = error instanceof Error ? error.message : "分账失败";
        emit({ type: "settlement.step", step: { ...step } });
        return undefined;
      }
    })
  );
  const tokenIds = issued.filter((id): id is string => Boolean(id));
  const failed = issued.length - tokenIds.length;
  const phase = outcomePhase(tokenIds.length, failed);
  job.status = phase === "settled" ? "settled" : phase === "partial" ? "partial" : "failed";
  job.updatedAt = Date.now();
  if (phase !== "settled") job.lastError = `${failed} 个条目失败`;
  saveJob(job);
  if (record) {
    record.status = phase;
    putOrder(record, chainId);
  }

  if (phase === "settled") {
    emit({ type: "settlement.done", orderId, tokenIds, status: "settled" });
    audit("settlement.completed", { orderId, chainId, issued: tokenIds.length });
    settleLog.info("分账完成", { ms: elapsed(), issued: tokenIds.length });
    return;
  }

  audit("settlement.incomplete", { orderId, chainId, issued: tokenIds.length, failed, phase });
  settleLog.error("分账未全部完成，不标记为 settled", { ms: elapsed(), issued: tokenIds.length, failed, phase });
  emit({
    type: "settlement.error",
    code: phase === "partial" ? "PARTIAL_SETTLEMENT" : "SETTLEMENT_FAILED",
    message: phase === "partial" ? "部分条目分账或发券失败" : "分账失败",
    details: tokenIds.join(","),
  });
}

function voucherContent(
  category: CategoryCode,
  lineItem: { label: string; itemId?: string },
  offers: ReturnType<typeof offersByRun.get>,
  request?: { destination?: string; pax?: number; startDate?: string },
  tripId?: string
): { title: string; details: Record<string, string> } {
  const key = CATEGORY_TO_KEY[category];
  if (!offers) {
    return { title: lineItem.label, details: { ...(tripId ? { 行程: tripId } : {}), 说明: lineItem.label } };
  }
  if (key === "flight") {
    const flight =
      (lineItem.itemId && offers.flights.find((f) => f.id === lineItem.itemId)) ||
      offers.flights.find((f) => lineItem.label.includes(f.flightNo)) ||
      offers.flights[0];
    if (!flight) return { title: lineItem.label, details: { ...(tripId ? { 行程: tripId } : {}), 说明: lineItem.label } };
    return {
      title: `${flight.flightNo} ${flight.from.code} → ${flight.to.code}`,
      details: {
        ...(tripId ? { 行程: tripId } : {}),
        航司: flight.carrier,
        机型: flight.aircraft,
        航班: `${flight.flightNo} ${flight.from.airport}(${flight.from.code}) → ${flight.to.airport}(${flight.to.code})`,
        起飞: `${flight.departAt} 起飞`,
        到达: `${flight.arriveAt} 到达`,
        舱位: flight.cabin,
        乘客: `${request?.pax ?? 2} 人`,
      },
    };
  }
  if (key === "hotel") {
    const hotel =
      (lineItem.itemId && offers.hotels.find((h) => h.id === lineItem.itemId)) ||
      offers.hotels.find((h) => lineItem.label.includes(h.name)) ||
      offers.hotels[0];
    if (!hotel) return { title: lineItem.label, details: { ...(tripId ? { 行程: tripId } : {}), 说明: lineItem.label } };
    return {
      title: hotel.name,
      details: {
        ...(tripId ? { 行程: tripId } : {}),
        酒店: hotel.name,
        星级: `${hotel.stars} 星`,
        地址: hotel.address,
        房型: hotel.roomType,
        入住: hotel.checkIn,
        退房: hotel.checkOut,
      },
    };
  }
  if (key === "attraction") {
    const attraction =
      (lineItem.itemId && offers.attractions.find((a) => a.id === lineItem.itemId)) ||
      offers.attractions.find((a) => lineItem.label.includes(a.name)) ||
      offers.attractions[0];
    if (!attraction) return { title: lineItem.label, details: { ...(tripId ? { 行程: tripId } : {}), 说明: lineItem.label } };
    return {
      title: attraction.name,
      details: {
        ...(tripId ? { 行程: tripId } : {}),
        景点: attraction.name,
        区域: attraction.area,
        开放时间: attraction.openHours,
      },
    };
  }
  const dining =
    (lineItem.itemId && offers.restaurants.find((d) => d.id === lineItem.itemId)) ||
    offers.restaurants.find((d) => lineItem.label.includes(d.name)) ||
    offers.restaurants[0];
  if (!dining) return { title: lineItem.label, details: { ...(tripId ? { 行程: tripId } : {}), 说明: lineItem.label } };
  return {
    title: dining.name,
    details: {
      ...(tripId ? { 行程: tripId } : {}),
      餐厅: dining.name,
      区域: dining.area,
      菜系: dining.cuisine,
    },
  };
}

function simulateHash(): `0x${string}` {
  let out = "0x";
  const chars = "0123456789abcdef";
  for (let i = 0; i < 64; i++) out += chars[Math.floor(Math.random() * 16)];
  return out as `0x${string}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
