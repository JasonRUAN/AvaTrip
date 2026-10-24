import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, type Chain, type PublicClient } from "viem";
import { avalancheFuji, monadTestnet, sepolia } from "viem/chains";
import { createLogger } from "./logger";

const log = createLogger("chains");
const here = dirname(fileURLToPath(import.meta.url));

/** 未带 chainId 的旧请求（已铸 Fuji NFT 的 tokenURI）继续落到 Fuji。 */
export const LEGACY_CHAIN_ID = 43113;
export const DEFAULT_CHAIN_KEY = "sepolia";
const ZERO = "0x0000000000000000000000000000000000000000";

export interface DeploymentFile {
  chainId: number;
  deployed: boolean;
  usdc: string;
  agentRegistry: string;
  tripSettlement: string;
  travelVoucher: string;
  agentReview?: string;
  orchestrator: string;
  agents: Record<string, string>;
}

export interface ExplorerTemplates {
  home: string;
  tx: string;
  address: string;
  token: string;
}

interface ChainMeta {
  key: string;
  chainId: number;
  name: string;
  shortName: string;
  nativeSymbol: string;
  rpcEnv: string;
  defaultRpc: string;
  deploymentFile: string;
  explorers: ExplorerTemplates;
}

export interface AppChain {
  key: string;
  chainId: number;
  name: string;
  shortName: string;
  nativeSymbol: string;
  rpc: string;
  deploymentFile: string;
  explorers: ExplorerTemplates;
  deployment: DeploymentFile | null;
  viemChain: Chain;
}

interface ChainsFile {
  default: string;
  chains: ChainMeta[];
}

const KNOWN_VIEM: Record<number, Chain> = {
  [avalancheFuji.id]: avalancheFuji,
  [monadTestnet.id]: monadTestnet,
  [sepolia.id]: sepolia,
};

const chainStorage = new AsyncLocalStorage<number>();
let configuredDefaultKey = "sepolia";

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    log.debug("读取 JSON 失败", { path, reason: (error as Error).message });
    return null;
  }
}

function chainsFilePath(): string | null {
  const candidates = [
    process.env.CHAINS_FILE,
    resolve(here, "../../deployments/chains.json"),
    resolve(here, "../deployments/chains.json"),
    resolve(process.cwd(), "deployments/chains.json"),
    resolve(process.cwd(), "../deployments/chains.json"),
  ].filter((path): path is string => Boolean(path));
  for (const path of candidates) {
    if (readJson<ChainsFile>(path)) return path;
  }
  return null;
}

function loadDeployment(fileName: string): DeploymentFile | null {
  const root = chainsFilePath();
  const base = root ? dirname(root) : resolve(here, "../../deployments");
  const candidates = [
    resolve(base, fileName),
    resolve(here, "../../deployments", fileName),
    resolve(here, "../deployments", fileName),
    resolve(process.cwd(), "deployments", fileName),
    resolve(process.cwd(), "../deployments", fileName),
  ];
  for (const path of candidates) {
    const parsed = readJson<DeploymentFile>(path);
    if (parsed) {
      log.info("已加载合约部署信息", {
        path,
        chainId: parsed.chainId,
        deployed: Boolean(parsed.deployed),
        settlement: parsed.tripSettlement,
      });
      return parsed;
    }
  }
  log.warn("未找到部署文件", { fileName });
  return null;
}

function rpcOf(meta: ChainMeta): string {
  const fromEnv = process.env[meta.rpcEnv];
  return fromEnv && fromEnv.length > 0 ? fromEnv : meta.defaultRpc;
}

function viemChainOf(meta: ChainMeta, rpc: string): Chain {
  const known = KNOWN_VIEM[meta.chainId];
  const base =
    known ??
    defineChain({
      id: meta.chainId,
      name: meta.name,
      nativeCurrency: { name: meta.nativeSymbol, symbol: meta.nativeSymbol, decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
  return {
    ...base,
    rpcUrls: { default: { http: [rpc] } },
  };
}

function loadChains(): AppChain[] {
  const path = chainsFilePath();
  const file = path ? readJson<ChainsFile>(path) : null;
  if (!file?.chains?.length) {
    throw new Error("缺少 deployments/chains.json");
  }
  if (file.default) configuredDefaultKey = file.default;
  return file.chains.map((meta) => {
    const rpc = rpcOf(meta);
    return {
      key: meta.key,
      chainId: meta.chainId,
      name: meta.name,
      shortName: meta.shortName,
      nativeSymbol: meta.nativeSymbol,
      rpc,
      deploymentFile: meta.deploymentFile,
      explorers: meta.explorers,
      deployment: loadDeployment(meta.deploymentFile),
      viemChain: viemChainOf(meta, rpc),
    };
  });
}

export const appChains: AppChain[] = loadChains();

const byId = new Map(appChains.map((chain) => [chain.chainId, chain]));
const byKey = new Map(appChains.map((chain) => [chain.key, chain]));

export function listChains(): AppChain[] {
  return appChains;
}

export function getChainById(chainId: number): AppChain | undefined {
  return byId.get(chainId);
}

export function getChainByKey(key: string): AppChain | undefined {
  return byKey.get(key);
}

export function currentChainId(): number {
  return chainStorage.getStore() ?? LEGACY_CHAIN_ID;
}

/** 新请求未带 chainId 时的产品默认链（chains.json 的 default，当前是 Monad）。 */
export function defaultChainId(): number {
  return getChainByKey(configuredDefaultKey)?.chainId ?? appChains[0]!.chainId;
}

export function currentChain(): AppChain {
  const chain = getChainById(currentChainId());
  if (!chain) throw new Error(`未知 chainId ${currentChainId()}`);
  return chain;
}

export function currentDeployment(): DeploymentFile | null {
  return currentChain().deployment;
}

/** 在这条链的上下文里执行。async 函数里的 await 会保持同一条链。 */
export function runWithChain<T>(chainId: number, fn: () => T): T {
  if (!getChainById(chainId)) {
    throw new Error(`未知 chainId ${chainId}`);
  }
  return chainStorage.run(chainId, fn);
}

export function isChainReady(chainId = currentChainId()): boolean {
  const deployment = getChainById(chainId)?.deployment;
  return Boolean(
    deployment?.deployed &&
      deployment.tripSettlement &&
      deployment.tripSettlement !== ZERO &&
      (process.env.ORCHESTRATOR_KEY ?? "").length > 0
  );
}

export function scopeKey(chainId: number, id: string): string {
  return `${chainId}:${id}`;
}

export type { PublicClient };
