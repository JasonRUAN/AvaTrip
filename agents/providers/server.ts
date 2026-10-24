import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { privateKeyToAccount } from "viem/accounts";
import { currentDeployment, defaultChainId, isChainReady, listChains, runWithChain } from "../shared/chains";
import { audit } from "../shared/audit";
import { verifyInternalRequest } from "../shared/internal-auth";
import { KEY_TO_CATEGORY, env, type AgentKey } from "../shared/env";
import { accessLog, type AppEnv } from "../shared/access-log";
import { createLogger, installProcessGuards, startTimer } from "../shared/logger";
import {
  searchAttractions,
  searchFlights,
  searchHotels,
  searchRestaurants,
} from "../shared/inventory";
import type { CategoryCode, TripRequest } from "../shared/types";
import { ensureVoucher, issueVoucher, redeemVoucher } from "./voucher";

function agentAddress(): `0x${string}` {
  if (env.AGENT_KEY) return privateKeyToAccount(env.AGENT_KEY).address;
  return (currentDeployment()?.agents?.[env.AGENT_CATEGORY] ??
    "0x0000000000000000000000000000000000000000") as `0x${string}`;
}

function requestedChainId(raw: unknown): number {
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (Number.isFinite(n) && listChains().some((chain) => chain.chainId === n)) return n;
  return defaultChainId();
}

async function authorizedBody(c: {
  req: {
    method: string;
    path: string;
    header: (name: string) => string | undefined;
    text: () => Promise<string>;
  };
}): Promise<{ ok: true; raw: string } | { ok: false; reason: string }> {
  const raw = await c.req.text();
  const verdict = verifyInternalRequest({
    method: c.req.method,
    path: c.req.path,
    body: raw,
    timestamp: c.req.header("x-internal-timestamp"),
    nonce: c.req.header("x-internal-nonce"),
    signature: c.req.header("x-internal-signature"),
  });
  if (!verdict.ok) {
    audit("internal.rejected", { path: c.req.path, reason: verdict.reason });
    return verdict;
  }
  return { ok: true, raw };
}

function supportedKeys(): AgentKey[] {
  return env.AGENT_CATEGORIES.length ? [...env.AGENT_CATEGORIES] : [env.AGENT_CATEGORY];
}

function parseRequestedKey(raw: unknown): AgentKey {
  if (typeof raw === "number" && raw >= 0 && raw <= 3) {
    return (["flight", "hotel", "attraction", "dining"] as const)[raw];
  }
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower === "flight" || lower === "hotel" || lower === "attraction" || lower === "dining") {
      return lower;
    }
  }
  return supportedKeys()[0] ?? env.AGENT_CATEGORY;
}

const log = createLogger("provider", { agent: env.AGENT_NAME, defaultCategory: env.AGENT_CATEGORY });

async function rfq(request: TripRequest, tripId: string, key: AgentKey) {
  const provider = agentAddress();
  const elapsed = startTimer();
  const result =
    key === "flight"
      ? await searchFlights(request, tripId, provider)
      : key === "hotel"
        ? await searchHotels(request, tripId, provider)
        : key === "attraction"
          ? await searchAttractions(request, tripId, provider)
          : await searchRestaurants(request, tripId, provider);
  log.info("库存检索完成", {
    category: key,
    tripId,
    items: result.items.length,
    ms: result.ms ?? elapsed(),
  });
  return result;
}

const app = new Hono<AppEnv>();
app.use("/*", accessLog(`provider:${env.AGENT_CATEGORY}`));
app.use("/*", cors());

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: env.AGENT_NAME,
    category: env.AGENT_CATEGORY,
    categories: supportedKeys(),
    address: agentAddress(),
    chains: listChains().map((chain) => ({
      key: chain.key,
      chainId: chain.chainId,
      ready: isChainReady(chain.chainId) && Boolean(env.AGENT_KEY),
    })),
  })
);

app.post("/v1/rfq", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    tripId?: string;
    request?: TripRequest;
    category?: CategoryCode | AgentKey;
  } | null;
  if (!body?.request || !body.tripId) {
    log.warn("询价请求缺少必要字段", { reqId: c.get("reqId"), hasRequest: Boolean(body?.request), hasTripId: Boolean(body?.tripId) });
    return c.json({ error: "INVALID_REQUEST" }, 400);
  }
  const key = parseRequestedKey(body.category);
  if (!supportedKeys().includes(key)) {
    // 编排器把类目分给了不负责该品类的 Agent，回空列表前先留痕
    log.warn("收到不支持的类目询价", { reqId: c.get("reqId"), requested: body.category, parsed: key, supported: supportedKeys() });
    return c.json({ agentAddress: agentAddress(), category: KEY_TO_CATEGORY[key], items: [], ms: 0 });
  }
  log.info("收到询价请求", { reqId: c.get("reqId"), tripId: body.tripId, category: key });
  const result = await rfq(body.request, body.tripId, key);
  return c.json({
    agentAddress: agentAddress(),
    category: KEY_TO_CATEGORY[key],
    items: result.items,
    ms: result.ms,
  });
});

app.post("/v1/vouchers/issue", async (c) => {
  const auth = await authorizedBody(c);
  if (!auth.ok) {
    log.warn("内部接口鉴权失败", { reqId: c.get("reqId"), path: c.req.path, reason: auth.reason });
    return c.json({ error: "UNAUTHORIZED" }, 401);
  }
  const body = JSON.parse(auth.raw) as (Parameters<typeof issueVoucher>[0] & { chainId?: number }) | null;
  if (!body?.holder || !body.orderId) {
    log.warn("发券请求缺少必要字段", { reqId: c.get("reqId"), hasHolder: Boolean(body?.holder), hasOrderId: Boolean(body?.orderId) });
    return c.json({ error: "INVALID_REQUEST" }, 400);
  }
  try {
    const issued = await runWithChain(requestedChainId(body.chainId), () => issueVoucher(body));
    log.info("已签发凭证", {
      reqId: c.get("reqId"),
      tokenId: issued.tokenId,
      orderId: body.orderId,
      holder: issued.detail.holder,
      txHash: issued.txHash,
    });
    return c.json(issued);
  } catch (error) {
    log.error("发券失败", { reqId: c.get("reqId"), orderId: body.orderId }, error);
    throw error;
  }
});

app.post("/v1/vouchers/redeem", async (c) => {
  const auth = await authorizedBody(c);
  if (!auth.ok) {
    log.warn("内部接口鉴权失败", { reqId: c.get("reqId"), path: c.req.path, reason: auth.reason });
    return c.json({ error: "UNAUTHORIZED" }, 401);
  }
  const body = JSON.parse(auth.raw) as { tokenId?: string; chainId?: number } | null;
  if (!body?.tokenId) {
    log.warn("核销请求缺少 tokenId", { reqId: c.get("reqId") });
    return c.json({ error: "INVALID_REQUEST" }, 400);
  }
  try {
    const result = await runWithChain(requestedChainId(body.chainId), () => redeemVoucher(body.tokenId!));
    log.info("已核销凭证", { reqId: c.get("reqId"), tokenId: body.tokenId, txHash: result.txHash });
    return c.json(result);
  } catch (error) {
    log.error("核销失败", { reqId: c.get("reqId"), tokenId: body.tokenId }, error);
    return c.json(
      { error: "REDEEM_FAILED", message: error instanceof Error ? error.message : "核销失败" },
      500
    );
  }
});

app.get("/v1/vouchers/:tokenId", async (c) => {
  const tokenId = c.req.param("tokenId");
  const chainId = requestedChainId(c.req.query("chainId"));
  const voucher = await runWithChain(chainId, () => ensureVoucher(tokenId));
  if (!voucher) {
    log.debug("查询凭证未命中", { reqId: c.get("reqId"), tokenId });
    return c.json({ error: "VOUCHER_NOT_FOUND" }, 404);
  }
  return c.json(voucher);
});

app.onError((error, c) => {
  log.error("请求处理失败", { reqId: c.get("reqId"), method: c.req.method, path: c.req.path }, error);
  return c.json({ error: "INTERNAL_ERROR", message: "服务暂时不可用" }, 500);
});

installProcessGuards(env.AGENT_NAME);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info("子 Agent 已启动", {
    agent: env.AGENT_NAME,
    url: `http://localhost:${info.port}`,
    port: info.port,
    categories: supportedKeys(),
    address: agentAddress(),
    chains: listChains().map((chain) => ({
      key: chain.key,
      chainId: chain.chainId,
      ready: isChainReady(chain.chainId) && Boolean(env.AGENT_KEY),
    })),
    hasAgentKey: Boolean(env.AGENT_KEY),
    logLevel: process.env.LOG_LEVEL ?? "info",
  });
});
