"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { setActiveChainId } from "./active-chain";
import {
  DEFAULT_CHAIN,
  DEFAULT_CHAIN_KEY,
  getChainByKey,
  type AppChain,
} from "./chains";

const STORAGE_KEY = "avatrip.chain";
const LEGACY_STORAGE_KEY = "avatrip.chain";
const CHANGE_EVENT = "avatrip-chain";

function readStoredChainKey(): string {
  const saved =
    window.localStorage.getItem(STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_STORAGE_KEY);
  return saved && getChainByKey(saved) ? saved : DEFAULT_CHAIN_KEY;
}

function subscribeChainKey(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

function writeChainKey(key: string) {
  window.localStorage.setItem(STORAGE_KEY, key);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

interface ChainContextValue {
  chain: AppChain;
  chains: AppChain[];
  selectChain: (key: string) => Promise<void>;
}

const ChainContext = createContext<ChainContextValue | null>(null);

export function ChainProvider({
  children,
  chains,
}: {
  children: ReactNode;
  chains: AppChain[];
}) {
  const key = useSyncExternalStore(
    subscribeChainKey,
    readStoredChainKey,
    () => DEFAULT_CHAIN_KEY,
  );
  const { isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const chain = getChainByKey(key) ?? DEFAULT_CHAIN;

  setActiveChainId(chain.chainId);

  const selectChain = useCallback(
    async (nextKey: string) => {
      const next = getChainByKey(nextKey);
      if (!next || next.key === key) return;
      const prev = key;
      writeChainKey(next.key);
      if (!isConnected) return;
      try {
        await switchChainAsync({ chainId: next.chainId });
      } catch (error) {
        console.error("[chain] 切换钱包网络失败:", error);
        writeChainKey(prev);
      }
    },
    [isConnected, key, switchChainAsync],
  );

  const value = useMemo(
    () => ({ chain, chains, selectChain }),
    [chain, chains, selectChain],
  );

  return (
    <ChainContext.Provider value={value}>{children}</ChainContext.Provider>
  );
}

export function useAppChain(): AppChain & {
  selectChain: (key: string) => Promise<void>;
  chains: AppChain[];
} {
  const ctx = useContext(ChainContext);
  if (!ctx) throw new Error("useAppChain 必须在 ChainProvider 内使用");
  return { ...ctx.chain, selectChain: ctx.selectChain, chains: ctx.chains };
}
