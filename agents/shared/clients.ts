import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  nonceManager,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  currentChain,
  currentChainId,
  getChainById,
  type AppChain,
} from "./chains";
import { env } from "./env";
import { createLogger } from "./logger";

const log = createLogger("chain");
const ZERO = "0x0000000000000000000000000000000000000000";

type AgentWallet = WalletClient<ReturnType<typeof http>, Chain, Account>;

const publicClients = new Map<number, PublicClient>();
const wallets = new Map<string, AgentWallet>();
const sendQueue = new Map<string, Promise<unknown>>();

function clientFor(chain: AppChain): PublicClient {
  const cached = publicClients.get(chain.chainId);
  if (cached) return cached;
  const client = createPublicClient({
    chain: chain.viemChain,
    transport: http(chain.rpc),
  });
  publicClients.set(chain.chainId, client);
  log.info("链上读客户端已初始化", { chainId: chain.chainId, key: chain.key, rpc: chain.rpc });
  return client;
}

/**
 * 现有调用点仍写 `publicClient.readContract`。
 * 实际连哪条链由 `runWithChain` 决定；没包上下文时落到 Fuji，兼容旧 tokenURI。
 */
export const publicClient: PublicClient = new Proxy({} as PublicClient, {
  get(_target, prop) {
    const client = clientFor(currentChain());
    const value = Reflect.get(client, prop, client) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
});

export function walletFor(key: `0x${string}`, chainId = currentChainId()): AgentWallet {
  const chain = getChainById(chainId) ?? currentChain();
  const cacheKey = `${chain.chainId}:${key}`;
  const cached = wallets.get(cacheKey);
  if (cached) return cached;
  const account: Account = privateKeyToAccount(key, { nonceManager });
  const wallet = createWalletClient({
    account,
    chain: chain.viemChain,
    transport: http(chain.rpc),
  });
  wallets.set(cacheKey, wallet);
  log.info("钱包客户端已创建", { address: account.address, chainId: chain.chainId });
  return wallet;
}

/**
 * 同一地址、同一条链的链上任务排队。调用方应将“广播到确认”都放进任务，
 * 避免公共 RPC 的 pending nonce 滞后导致重复分配 nonce。
 * 两条链的 nonce 互不影响，所以队列键带 chainId。
 */
export function enqueueWalletSend<T>(address: string, send: () => Promise<T>): Promise<T> {
  const key = `${currentChainId()}:${address.toLowerCase()}`;
  const prev = sendQueue.get(key) ?? Promise.resolve();
  const next = prev.then(send, send);
  log.debug("交易入队", { address: key });
  sendQueue.set(
    key,
    next.then(
      () => undefined,
      (error: unknown) => {
        log.warn("队列中交易失败", { address: key }, error);
      }
    )
  );
  return next;
}

export function orchestratorWallet() {
  if (!env.ORCHESTRATOR_KEY) {
    log.warn("缺少 ORCHESTRATOR_KEY，无法构造编排器钱包");
    throw new Error("未配置 ORCHESTRATOR_KEY");
  }
  return walletFor(env.ORCHESTRATOR_KEY);
}

export function providerWallet() {
  if (!env.AGENT_KEY) {
    log.warn("缺少 AGENT_KEY，无法构造服务商钱包");
    throw new Error("未配置 AGENT_KEY");
  }
  return walletFor(env.AGENT_KEY);
}

export function contractAddresses() {
  const deployment = currentChain().deployment;
  if (!deployment) {
    log.error("缺少部署文件，无法解析合约地址", { chainId: currentChainId() });
    throw new Error(`缺少 chain ${currentChainId()} 的部署文件`);
  }
  return {
    usdc: deployment.usdc as `0x${string}`,
    registry: deployment.agentRegistry as `0x${string}`,
    settlement: deployment.tripSettlement as `0x${string}`,
    voucher: deployment.travelVoucher as `0x${string}`,
    review: (deployment.agentReview ?? ZERO) as `0x${string}`,
  };
}

export async function walletBalance(label: string, address: `0x${string}`): Promise<string> {
  const chain = currentChain();
  try {
    const balance = await clientFor(chain).getBalance({ address });
    const text = `${label}: ${Number(formatEther(balance)).toFixed(4)} ${chain.nativeSymbol}`;
    log.debug("余额查询成功", { label, address, chainId: chain.chainId, balance: text });
    return text;
  } catch (error) {
    log.warn("余额查询失败（RPC 可能不可用）", { label, address, chainId: chain.chainId }, error);
    return `${label}: 查询失败 ${(error as Error).message}`;
  }
}
