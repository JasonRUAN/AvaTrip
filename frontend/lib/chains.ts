import { http, type Transport } from "viem";
import { avalancheFuji, monadTestnet, sepolia, type Chain } from "viem/chains";
import chainsMeta from "@/deployments/chains.json";
import fujiDeployment from "@/deployments/fuji.json";
import monadDeployment from "@/deployments/monad.json";
import sepoliaDeployment from "@/deployments/sepolia.json";
import type { Address } from "./types";

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
  agents: {
    flight: string;
    hotel: string;
    attraction: string;
    dining: string;
  };
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

export interface ChainContracts {
  chainId: number;
  deployed: boolean;
  usdc: Address;
  agentRegistry: Address;
  tripSettlement: Address;
  travelVoucher: Address;
  agentReview: Address;
  orchestrator: Address;
  agents: {
    flight: Address;
    hotel: Address;
    attraction: Address;
    dining: Address;
  };
}

export interface AppChain {
  key: string;
  chainId: number;
  name: string;
  shortName: string;
  nativeSymbol: string;
  rpc: string;
  explorers: ExplorerTemplates;
  contracts: ChainContracts;
  deployed: boolean;
  reviewDeployed: boolean;
  viemChain: Chain;
}

/**
 * 部署文件按文件名登记。新增一条链时：在 chains.json 加一条，
 * 把对应 json 放进 deployments/，并在这里补一行 import。
 */
const DEPLOYMENTS: Record<string, DeploymentFile> = {
  "fuji.json": fujiDeployment as DeploymentFile,
  "monad.json": monadDeployment as DeploymentFile,
  "sepolia.json": sepoliaDeployment as DeploymentFile,
};

const VIEM_CHAINS: Record<number, Chain> = {
  [monadTestnet.id]: monadTestnet,
  [avalancheFuji.id]: avalancheFuji,
  [sepolia.id]: sepolia,
};

/**
 * Next 只在构建期静态替换 `process.env.NEXT_PUBLIC_XXX` 字面量，
 * 所以这里必须逐个写死，不能按 rpcEnv 动态拼 key（拼出来的一律是 undefined）。
 */
const RPC_FROM_ENV: Record<string, string | undefined> = {
  MONAD_RPC: process.env.NEXT_PUBLIC_MONAD_RPC,
  FUJI_RPC: process.env.NEXT_PUBLIC_FUJI_RPC,
  SEPOLIA_RPC: process.env.NEXT_PUBLIC_SEPOLIA_RPC,
};

function rpcOf(meta: ChainMeta): string {
  const fromEnv = RPC_FROM_ENV[meta.rpcEnv];
  return fromEnv && fromEnv.length > 0 ? fromEnv : meta.defaultRpc;
}

function toContracts(file: DeploymentFile | undefined, chainId: number): ChainContracts {
  const agents = file?.agents;
  return {
    chainId: file?.chainId ?? chainId,
    deployed: Boolean(file?.deployed),
    usdc: (file?.usdc ?? ZERO) as Address,
    agentRegistry: (file?.agentRegistry ?? ZERO) as Address,
    tripSettlement: (file?.tripSettlement ?? ZERO) as Address,
    travelVoucher: (file?.travelVoucher ?? ZERO) as Address,
    agentReview: (file?.agentReview ?? ZERO) as Address,
    orchestrator: (file?.orchestrator ?? ZERO) as Address,
    agents: {
      flight: (agents?.flight ?? ZERO) as Address,
      hotel: (agents?.hotel ?? ZERO) as Address,
      attraction: (agents?.attraction ?? ZERO) as Address,
      dining: (agents?.dining ?? ZERO) as Address,
    },
  };
}

function deployedOf(contracts: ChainContracts): boolean {
  return (
    contracts.deployed &&
    contracts.usdc !== ZERO &&
    contracts.tripSettlement !== ZERO &&
    contracts.travelVoucher !== ZERO
  );
}

function buildChain(meta: ChainMeta): AppChain {
  const rpc = rpcOf(meta);
  const known = VIEM_CHAINS[meta.chainId];
  const viemChain: Chain = known
    ? { ...known, rpcUrls: { default: { http: [rpc] } } }
    : {
        id: meta.chainId,
        name: meta.name,
        nativeCurrency: { name: meta.nativeSymbol, symbol: meta.nativeSymbol, decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      };
  const contracts = toContracts(DEPLOYMENTS[meta.deploymentFile], meta.chainId);
  const deployed = deployedOf(contracts);
  return {
    key: meta.key,
    chainId: meta.chainId,
    name: meta.name,
    shortName: meta.shortName,
    nativeSymbol: meta.nativeSymbol,
    rpc,
    explorers: meta.explorers,
    contracts,
    deployed,
    reviewDeployed: deployed && contracts.agentReview !== ZERO,
    viemChain,
  };
}

const metaFile = chainsMeta as { default: string; chains: ChainMeta[] };

export const appChains: AppChain[] = metaFile.chains.map(buildChain);

const byId = new Map(appChains.map((chain) => [chain.chainId, chain]));
const byKey = new Map(appChains.map((chain) => [chain.key, chain]));

export const DEFAULT_CHAIN_KEY = metaFile.default || "sepolia";
export const DEFAULT_CHAIN = byKey.get(DEFAULT_CHAIN_KEY) ?? appChains[0]!;
export const DEFAULT_CHAIN_ID = DEFAULT_CHAIN.chainId;

/** 旧 tokenURI / 未带 chainId 的请求仍按 Fuji。 */
export const LEGACY_CHAIN_ID = 43113;

export function listChains(): AppChain[] {
  return appChains;
}

export function getChainById(chainId: number): AppChain | undefined {
  return byId.get(chainId);
}

export function getChainByKey(key: string): AppChain | undefined {
  return byKey.get(key);
}

export function contractsFor(chainId: number): ChainContracts {
  return (getChainById(chainId) ?? DEFAULT_CHAIN).contracts;
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

export function withChain(url: string, chainId: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}chainId=${chainId}`;
}

const RPC_OPTS = { timeout: 12_000, retryCount: 1, retryDelay: 400 } as const;

export const wagmiChains = appChains.map((chain) => chain.viemChain) as [Chain, ...Chain[]];

export const wagmiTransports = Object.fromEntries(
  appChains.map((chain) => [chain.chainId, http(chain.rpc, RPC_OPTS)])
) as Record<number, Transport>;
