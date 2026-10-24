export type OrderPhase =
  | "funded"
  | "verifying"
  | "settling"
  | "settled"
  | "partial"
  | "failed";

const TRANSITIONS: Record<OrderPhase, readonly OrderPhase[]> = {
  funded: ["verifying", "settling", "failed"],
  verifying: ["settling", "failed"],
  settling: ["settled", "partial", "failed"],
  settled: [],
  partial: ["settling", "settled", "failed"],
  failed: ["settling"],
};

export function canTransition(from: OrderPhase, to: OrderPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionOrder(from: OrderPhase, to: OrderPhase): OrderPhase {
  if (!canTransition(from, to)) {
    throw new Error(`非法订单状态迁移 ${from} → ${to}`);
  }
  return to;
}

export type JobClaim = "claimed" | "duplicate" | "done";

export interface ClaimableJob {
  status: "pending" | "running" | "settled" | "partial" | "failed";
  attempts: number;
  updatedAt: number;
}

const STALE_RUNNING_MS = 2 * 60 * 1000;
export const MAX_JOB_ATTEMPTS = 5;

/**
 * 同一 chainId:orderId 只允许一个执行者。
 * settled 直接返回；running 且未过期视为重复请求。
 */
export function claimSettlement(
  job: ClaimableJob | undefined,
  now = Date.now()
): JobClaim {
  if (!job) return "claimed";
  if (job.status === "settled") return "done";
  if (job.status === "running" && now - job.updatedAt < STALE_RUNNING_MS) return "duplicate";
  if (job.status === "failed" && job.attempts >= MAX_JOB_ATTEMPTS) return "done";
  return "claimed";
}

export function outcomePhase(issued: number, failed: number): OrderPhase {
  if (issued > 0 && failed === 0) return "settled";
  if (issued > 0 && failed > 0) return "partial";
  return "failed";
}
