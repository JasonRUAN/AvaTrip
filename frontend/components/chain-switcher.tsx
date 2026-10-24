"use client";

import { useAppChain } from "@/lib/chain-context";
import { useT } from "@/lib/i18n/context";

/** 顶栏网络切换。选择写入 localStorage，已连接钱包时同步 switchChain。 */
export function ChainSwitcher() {
  const { t } = useT();
  const { key, chains, selectChain } = useAppChain();

  return (
    <div
      role="group"
      aria-label={t("chain.label")}
      className="flex items-center gap-0.5 rounded-full border border-brand-100 bg-white/90 p-0.5 shadow-soft"
    >
      {chains.map((chain) => {
        const active = chain.key === key;
        return (
          <button
            key={chain.key}
            type="button"
            aria-pressed={active}
            title={t("chain.switchTo", { network: chain.shortName })}
            onClick={() => {
              void selectChain(chain.key);
            }}
            className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-bold transition-all ${
              active
                ? "sky-gradient text-white shadow-soft"
                : "text-ink-500 hover:bg-brand-50 hover:text-brand-700"
            }`}
          >
            {chain.shortName}
          </button>
        );
      })}
    </div>
  );
}
