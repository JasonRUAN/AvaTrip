"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { DemoBadge } from "./demo-badge";
import { ScrollRail } from "./scroll-rail";
import { PayButtonChain } from "./pay-button-chain";
import { SettlementTimeline } from "./settlement-timeline";
import type { useCheckout } from "@/hooks/use-checkout";
import { formatUsd } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { budgetToneText, categoryLabel } from "@/lib/i18n/labels";
import type { BudgetState } from "@/lib/i18n/labels";
import type { Quote } from "@/lib/types";

/** 报价明细默认只露出这么多行，其余在列表内滚动 */
const QUOTE_VISIBLE_ROWS = 8;

const CATEGORY_ICON: Record<number, string> = {
  0: "✈️",
  1: "🏨",
  2: "🎟️",
  3: "🍜",
};

const BUDGET_TONE: Record<BudgetState, { cls: string }> = {
  comfortable: { cls: "text-mint-500 bg-mint-100" },
  within: { cls: "text-amber-700 bg-amber-100" },
  over: { cls: "text-coral-500 bg-coral-100" },
};

export function QuotePanel({
  quote,
  budget,
  checkout,
}: {
  quote?: Quote;
  budget?: number;
  checkout: ReturnType<typeof useCheckout>;
}) {
  const { t, locale } = useT();
  const scrollerRef = useRef<HTMLUListElement>(null);
  const [listMax, setListMax] = useState<number>();
  const [fade, setFade] = useState({ top: false, bottom: false });
  const itemCount = quote?.lineItems.length ?? 0;
  const scrollable = itemCount > QUOTE_VISIBLE_ROWS;

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !scrollable) {
      setListMax((prev) => (prev === undefined ? prev : undefined));
      return;
    }
    const last = el.querySelectorAll("li")[QUOTE_VISIBLE_ROWS - 1];
    if (!last) return;
    const next = last.offsetTop + last.offsetHeight;
    setListMax((prev) => (prev === next ? prev : next));
  }, [scrollable]);

  useLayoutEffect(() => {
    measure();
  }, [measure, itemCount]);

  useEffect(() => {
    const el = scrollerRef.current;
    const first = el?.querySelector("li");
    if (!el || !first || !scrollable) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(first);
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [measure, scrollable, itemCount]);

  const refreshFade = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !scrollable) {
      setFade({ top: false, bottom: false });
      return;
    }
    setFade({
      top: el.scrollTop > 6,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 6,
    });
  }, [scrollable]);

  useEffect(() => {
    const id = requestAnimationFrame(() => refreshFade());
    return () => cancelAnimationFrame(id);
  }, [itemCount, listMax, scrollable, refreshFade]);

  if (!quote) {
    return (
      <div className="rounded-3xl border border-dashed border-brand-200 bg-white/50 px-5 py-10 text-center">
        <span className="text-3xl">🧾</span>
        <p className="mt-2 text-sm font-semibold text-ink-500">
          {t("quote.empty")}
        </p>
      </div>
    );
  }

  const tone = BUDGET_TONE[quote.budgetState];

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-brand-100 bg-white/90 p-4 shadow-card animate-pop-in">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="font-display text-base font-bold text-ink-900">
            {t("quote.title")}
          </h3>
          <DemoBadge tone="soft" label={t("quote.demoPrice")} />
          {budget ? (
            <span
              className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold ${tone.cls}`}
            >
              {budgetToneText(quote.budgetState, locale)}
            </span>
          ) : null}
        </div>

        <div className="relative">
          <ul
            ref={scrollerRef}
            onScroll={refreshFade}
            style={
              scrollable ? { maxHeight: listMax ?? "17.25rem" } : undefined
            }
            className={
              scrollable
                ? "scroll-hint relative flex flex-col divide-y divide-brand-50 overflow-y-auto overscroll-contain pr-4"
                : "relative flex flex-col divide-y divide-brand-50"
            }
          >
            {quote.lineItems.length === 0 ? (
              <li className="py-3 text-center text-xs text-ink-300">
                {t("quote.noSelection")}
              </li>
            ) : null}
            {quote.lineItems.map((item) => (
              <li
                key={item.itemHash}
                className="flex items-center gap-2.5 py-2.5"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-sm">
                  {CATEGORY_ICON[item.category] ?? "•"}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-bold text-ink-900">
                    {item.providerName}
                  </p>
                  <p className="truncate text-[11px] text-ink-300">
                    {item.label}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="font-display text-sm font-bold text-ink-900">
                    ${formatUsd(item.amount)}
                  </p>
                  <p className="text-[10px] text-ink-300">
                    {categoryLabel(item.category, locale)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {scrollable && fade.top ? (
            <div className="pointer-events-none absolute top-0 right-4 left-0 h-5 bg-gradient-to-b from-white to-transparent" />
          ) : null}
          {scrollable && fade.bottom ? (
            <div className="pointer-events-none absolute right-4 bottom-0 left-0 h-6 bg-gradient-to-t from-white to-transparent" />
          ) : null}
          <ScrollRail active={scrollable} scrollerRef={scrollerRef} />
        </div>

        <div
          className={`mt-3 flex items-baseline justify-between border-t border-brand-100 pt-3 ${
            scrollable ? "pr-4" : ""
          }`}
        >
          <span className="text-xs font-bold text-ink-500">
            {t("quote.total")}
          </span>
          <span className="font-display text-2xl font-bold text-brand-gradient">
            ${formatUsd(quote.total)}
          </span>
        </div>
      </div>

      {checkout.stage === "done" ? (
        <div className="rounded-2xl border border-mint-500/30 bg-mint-100/70 p-4 animate-pop-in">
          <p className="font-display text-base font-bold text-mint-500">
            {t("quote.doneTitle", { n: checkout.tokenIds.length })}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-ink-500">
            {t("quote.doneBody")}
          </p>
          <Link
            href="/vouchers"
            className="sky-gradient mt-3 flex h-11 w-full items-center justify-center rounded-xl text-sm font-bold text-white shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-glow"
          >
            {t("quote.viewVouchers")}
          </Link>
        </div>
      ) : (
        <PayButtonChain
          stage={checkout.stage}
          busy={checkout.busy}
          error={checkout.error}
          payDisabled={
            !quote || quote.lineItems.length === 0 || quote.total === "0"
          }
          onFaucet={checkout.actions.faucet}
          onApprove={checkout.actions.approve}
          onPay={checkout.actions.pay}
        />
      )}

      <SettlementTimeline steps={checkout.steps} />
    </div>
  );
}
