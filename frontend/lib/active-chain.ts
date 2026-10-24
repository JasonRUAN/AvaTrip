import { DEFAULT_CHAIN_ID } from "./chains";

/** 非 React 模块（Explorer、离线演示地址）读取当前选择。ChainProvider 在渲染时同步。 */
let activeChainId = DEFAULT_CHAIN_ID;

export function getActiveChainId(): number {
  return activeChainId;
}

export function setActiveChainId(chainId: number): void {
  activeChainId = chainId;
}
