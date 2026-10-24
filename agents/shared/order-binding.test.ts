import assert from "node:assert/strict";
import test from "node:test";
import {
  compareOrderBinding,
  quotesCompatible,
  receiptBindsOrder,
  ORDER_STATUS_FUNDED,
  ORDER_STATUS_SETTLED,
} from "./order-binding";
import type { Quote } from "./types";

const traveler = "0x1111111111111111111111111111111111111111";
const provider = "0x2222222222222222222222222222222222222222";
const itemHash = `0x${"ab".repeat(32)}` as const;
const itineraryHash = `0x${"cd".repeat(32)}` as const;

function quote(): Quote {
  return {
    runId: "run_1",
    tripId: "trip_1",
    total: "1000000",
    itineraryHash,
    totalUsd: 1,
    budgetState: "within",
    lineItems: [
      {
        provider,
        providerName: "Flight",
        category: 0,
        amount: "1000000",
        itemHash,
        label: "NH959",
      },
    ],
  };
}

const onChain = {
  traveler,
  total: 1000000n,
  status: ORDER_STATUS_FUNDED,
  itineraryHash,
  items: [{ provider, amount: 1000000n, category: 0, itemHash }],
};

test("逐项一致时通过绑定", () => {
  const result = compareOrderBinding(onChain, {
    traveler,
    total: 1000000n,
    itineraryHash,
    items: onChain.items,
  });
  assert.equal(result.ok, true);
});

test("伪造旅客、金额或 itemHash 不能通过", () => {
  assert.equal(
    compareOrderBinding(onChain, {
      traveler: "0x3333333333333333333333333333333333333333",
      total: 1000000n,
      items: onChain.items,
    }).ok,
    false
  );
  const wrongHash = compareOrderBinding(
    { ...onChain, items: [{ ...onChain.items[0]!, itemHash: `0x${"11".repeat(32)}` }] },
    { traveler, total: 1000000n, itineraryHash, items: onChain.items }
  );
  assert.equal(wrongHash.ok, false);
  if (!wrongHash.ok) assert.equal(wrongHash.code, "ITEM_MISMATCH");
});

test("已结清订单仍可核对，取消订单不行", () => {
  assert.equal(compareOrderBinding({ ...onChain, status: ORDER_STATUS_SETTLED }, {
    traveler,
    total: 1000000n,
    items: onChain.items,
  }).ok, true);
  const cancelled = compareOrderBinding({ ...onChain, status: 3 }, {
    traveler,
    total: 1000000n,
    items: onChain.items,
  });
  assert.equal(cancelled.ok, false);
});

test("回执必须包含一致的 OrderCreated", () => {
  assert.equal(
    receiptBindsOrder([{ orderId: 7n, traveler, total: 1000000n }], {
      orderId: 7n,
      traveler,
      total: 1000000n,
    }),
    true
  );
  assert.equal(
    receiptBindsOrder([{ orderId: 8n, traveler, total: 1000000n }], {
      orderId: 7n,
      traveler,
      total: 1000000n,
    }),
    false
  );
});

test("客户端报价不能替换服务端条目", () => {
  const stored = quote();
  assert.equal(quotesCompatible(stored, quote()), true);
  assert.equal(quotesCompatible(stored, { ...quote(), total: "1" }), false);
});
