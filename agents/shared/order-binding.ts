import type { Quote } from "./types";

/** 链上 OrderStatus：None / Funded / Settled / Cancelled */
export const ORDER_STATUS_FUNDED = 1;
export const ORDER_STATUS_SETTLED = 2;

export interface BoundItem {
  provider: string;
  amount: bigint;
  category: number;
  itemHash: string;
}

export interface OnChainOrderView {
  traveler: string;
  total: bigint;
  status: number;
  itineraryHash: string;
  items: BoundItem[];
}

export interface BindingFailure {
  ok: false;
  code: string;
  message: string;
}

export type BindingResult = { ok: true } | BindingFailure;

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function expectedItemsFromQuote(quote: Quote): BoundItem[] {
  return quote.lineItems.map((item) => ({
    provider: item.provider,
    amount: BigInt(item.amount),
    category: item.category,
    itemHash: item.itemHash,
  }));
}

/**
 * 逐项核对链上订单与服务端报价。
 * Funded 可以分账；Settled 只允许补发尚未签发的凭证，不能当成新订单重放。
 */
export function compareOrderBinding(
  onChain: OnChainOrderView,
  expected: {
    traveler: string;
    total: bigint;
    itineraryHash?: string;
    items: BoundItem[];
  }
): BindingResult {
  if (!sameHex(onChain.traveler, expected.traveler)) {
    return { ok: false, code: "TRAVELER_MISMATCH", message: "链上旅客与登记旅客不一致" };
  }
  if (onChain.status !== ORDER_STATUS_FUNDED && onChain.status !== ORDER_STATUS_SETTLED) {
    return { ok: false, code: "STATUS_NOT_FUNDED", message: "链上订单不是已托管或已结清状态" };
  }
  if (onChain.total !== expected.total) {
    return { ok: false, code: "TOTAL_MISMATCH", message: "链上总额与报价总额不一致" };
  }
  if (expected.itineraryHash && !sameHex(onChain.itineraryHash, expected.itineraryHash)) {
    return { ok: false, code: "ITINERARY_MISMATCH", message: "链上行程哈希与报价不一致" };
  }
  if (onChain.items.length !== expected.items.length) {
    return {
      ok: false,
      code: "ITEM_COUNT_MISMATCH",
      message: `链上条目数 ${onChain.items.length} 与报价 ${expected.items.length} 不一致`,
    };
  }
  for (let index = 0; index < expected.items.length; index += 1) {
    const chainItem = onChain.items[index]!;
    const want = expected.items[index]!;
    const aligned =
      sameHex(chainItem.provider, want.provider) &&
      chainItem.amount === want.amount &&
      chainItem.category === want.category &&
      sameHex(chainItem.itemHash, want.itemHash);
    if (!aligned) {
      return {
        ok: false,
        code: "ITEM_MISMATCH",
        message: `第 ${index} 项的 provider / amount / category / itemHash 与报价不一致`,
      };
    }
  }
  return { ok: true };
}

export interface OrderCreatedLog {
  orderId: bigint;
  traveler: string;
  total: bigint;
}

/** 交易回执里必须有与本次登记一致的 OrderCreated。 */
export function receiptBindsOrder(
  logs: OrderCreatedLog[],
  expected: { orderId: bigint; traveler: string; total: bigint }
): boolean {
  return logs.some(
    (log) =>
      log.orderId === expected.orderId &&
      sameHex(log.traveler, expected.traveler) &&
      log.total === expected.total
  );
}

/** 客户端重放的报价必须和编排器保存的报价逐项一致，不能换条目。 */
export function quotesCompatible(stored: Quote, submitted: Quote): boolean {
  if (stored.total !== submitted.total) return false;
  if (stored.itineraryHash.toLowerCase() !== submitted.itineraryHash.toLowerCase()) return false;
  if (stored.lineItems.length !== submitted.lineItems.length) return false;
  return stored.lineItems.every((item, index) => {
    const other = submitted.lineItems[index]!;
    return (
      item.provider.toLowerCase() === other.provider.toLowerCase() &&
      item.amount === other.amount &&
      item.category === other.category &&
      item.itemHash.toLowerCase() === other.itemHash.toLowerCase()
    );
  });
}
