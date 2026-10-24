import assert from "node:assert/strict";
import test from "node:test";
import { claimSettlement, outcomePhase, transitionOrder } from "./order-machine";

test("全部成功才是 settled，部分失败保持 partial", () => {
  assert.equal(outcomePhase(2, 0), "settled");
  assert.equal(outcomePhase(1, 1), "partial");
  assert.equal(outcomePhase(0, 2), "failed");
});

test("settling 不能被重复认领，过期 running 可以恢复", () => {
  const now = 1_000_000;
  assert.equal(claimSettlement({ status: "running", attempts: 1, updatedAt: now - 1_000 }, now), "duplicate");
  assert.equal(claimSettlement({ status: "running", attempts: 1, updatedAt: now - 10 * 60_000 }, now), "claimed");
  assert.equal(claimSettlement({ status: "settled", attempts: 1, updatedAt: now }, now), "done");
  assert.equal(claimSettlement({ status: "partial", attempts: 1, updatedAt: now }, now), "claimed");
});

test("非法迁移会抛出", () => {
  assert.equal(transitionOrder("settling", "settled"), "settled");
  assert.throws(() => transitionOrder("settled", "settling"));
});
