"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ScrollRail } from "./scroll-rail";
import { explorerTx, shortHash } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { categoryLabel, settlementStatusText } from "@/lib/i18n/labels";
import type { SettlementStep } from "@/lib/types";

/** 超过 8 条就限高，只露出 8 行，其余在列表内滚动 */
const SCROLL_AFTER = 8;

const CATEGORY_ICON: Record<number, string> = {
  0: "✈️",
  1: "🏨",
  2: "🎟️",
  3: "🍜",
};

function statusTone(status: SettlementStep["status"]) {
  if (status === "issued") return "bg-mint-500";
  if (status === "paid") return "bg-brand-500";
  if (status === "settling") return "bg-amber-500";
  if (status === "failed") return "bg-coral-500";
  return "bg-ink-100";
}

function statusLabelTone(status: SettlementStep["status"]) {
  if (status === "failed") return "text-coral-500";
  if (status === "issued") return "text-mint-500";
  if (status === "settling" || status === "paid") return "text-amber-700";
  return "text-ink-300";
}

function isLive(status: SettlementStep["status"]) {
  return status === "settling" || status === "paid";
}

export function SettlementTimeline({ steps }: { steps: SettlementStep[] }) {
  const { t, locale } = useT();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const [listMax, setListMax] = useState<number>();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followKey =
    steps.find((step) => isLive(step.status))?.key ??
    steps.find((step) => step.status === "failed")?.key ??
    null;

  const issued = steps.filter((step) => step.status === "issued").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const working = steps.filter((step) => isLive(step.status)).length;
  const scrollable = steps.length > SCROLL_AFTER;
  const progress =
    steps.length === 0 ? 0 : Math.round((issued / steps.length) * 100);

  const measureList = useCallback(() => {
    const root = scrollerRef.current;
    if (!root || steps.length <= SCROLL_AFTER) {
      setListMax((prev) => (prev === undefined ? prev : undefined));
      return;
    }
    const list = root.querySelector("ol");
    const card = root.querySelector<HTMLElement>("li > div");
    const button = card?.querySelector<HTMLElement>("button");
    if (!list || !card || !button) return;
    const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
    const borderY = card.offsetHeight - card.clientHeight;
    const row = button.offsetHeight + borderY;
    const next = Math.ceil(row * SCROLL_AFTER + gap * (SCROLL_AFTER - 1));
    setListMax((prev) => (prev === next ? prev : next));
  }, [steps.length]);

  useLayoutEffect(() => {
    measureList();
    const button = scrollerRef.current?.querySelector("li button");
    if (!button || steps.length <= SCROLL_AFTER) return;
    const observer = new ResizeObserver(() => measureList());
    observer.observe(button);
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measureList();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [measureList, steps.length]);

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
  }, [steps.length, openKey, scrollable, listMax, refreshFade]);

  useEffect(() => {
    if (!followKey) return;
    const root = scrollerRef.current;
    const node = root?.querySelector<HTMLElement>(`[data-step="${followKey}"]`);
    if (!root || !node) return;
    const nodeRect = node.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (nodeRect.top < rootRect.top + 6) {
      root.scrollBy({
        top: nodeRect.top - rootRect.top - 8,
        behavior: "smooth",
      });
    } else if (nodeRect.bottom > rootRect.bottom - 6) {
      root.scrollBy({
        top: nodeRect.bottom - rootRect.bottom + 8,
        behavior: "smooth",
      });
    }
  }, [followKey]);

  if (steps.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-bold tracking-wide text-ink-500">
            {t("settlement.title")}
          </h3>
          <p className="mt-0.5 text-[11px] font-semibold text-ink-300">
            {t("settlement.issued", { issued, total: steps.length })}
            {working > 0 ? t("settlement.working", { n: working }) : ""}
            {failed > 0 ? t("settlement.failed", { n: failed }) : ""}
            {scrollable ? t("settlement.scroll") : ""}
          </p>
        </div>
        <span className="font-display text-sm font-bold text-ink-700">
          {progress}%
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-brand-100">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            failed && issued === 0 ? "bg-coral-500" : "bg-mint-500"
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={refreshFade}
          style={scrollable ? { maxHeight: listMax ?? "32.5rem" } : undefined}
          className={
            scrollable
              ? "scroll-hint overflow-y-auto overscroll-contain pr-4"
              : undefined
          }
        >
          <ol className="relative flex flex-col gap-1.5 pl-5">
            <span className="absolute left-[7px] top-2 bottom-2 w-px rounded-full bg-brand-100" />

            {steps.map((step) => {
              const open = openKey === step.key;
              const expandable = Boolean(
                step.txHash || step.tokenId || step.error,
              );

              return (
                <li
                  key={step.key}
                  data-step={step.key}
                  className="relative animate-fade-up"
                >
                  <span
                    className={`absolute -left-5 top-2 flex h-4 w-4 items-center justify-center rounded-full text-[9px] text-white shadow-soft ${statusTone(step.status)} ${
                      step.status === "settling" ? "animate-breathe" : ""
                    }`}
                  >
                    {step.status === "issued"
                      ? "✓"
                      : (CATEGORY_ICON[step.category] ?? "•")}
                  </span>

                  <div
                    className={`rounded-xl border bg-white/90 shadow-card ${
                      open ? "border-brand-200" : "border-brand-100"
                    }`}
                  >
                    <button
                      type="button"
                      disabled={!expandable}
                      aria-expanded={open}
                      onClick={() =>
                        setOpenKey((current) =>
                          current === step.key ? null : step.key,
                        )
                      }
                      className="flex w-full cursor-pointer items-start gap-2 px-2.5 py-2 text-left disabled:cursor-default"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-bold text-ink-900">
                            {step.providerName}
                          </span>
                          <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-px text-[10px] font-bold text-brand-700">
                            {categoryLabel(step.category, locale)}
                          </span>
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[11px] text-ink-300">
                            {step.label}
                          </span>
                          {step.tokenId && !open ? (
                            <span className="shrink-0 rounded-md bg-mint-100 px-1.5 py-px text-[10px] font-bold text-mint-500">
                              #{step.tokenId}
                            </span>
                          ) : null}
                        </span>
                      </span>

                      <span className="flex shrink-0 items-center gap-1 pt-0.5">
                        <span
                          className={`text-[11px] font-bold ${statusLabelTone(step.status)}`}
                        >
                          {settlementStatusText(step.status, locale)}
                        </span>
                        {expandable ? (
                          <span
                            className={`text-[10px] text-ink-300 transition-transform ${
                              open ? "rotate-180" : ""
                            }`}
                          >
                            ▾
                          </span>
                        ) : null}
                      </span>
                    </button>

                    {open ? (
                      <div className="flex flex-wrap items-center gap-1.5 border-t border-brand-50 px-2.5 py-2">
                        {step.txHash ? (
                          <a
                            href={explorerTx(step.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-2 py-1 font-mono text-[11px] font-bold text-brand-700 transition-colors hover:bg-brand-100"
                          >
                            settle {shortHash(step.txHash)} ↗
                          </a>
                        ) : null}

                        {step.tokenId ? (
                          <span className="rounded-lg bg-mint-100 px-2 py-1 text-[11px] font-bold text-mint-500">
                            {t("settlement.voucherCode", {
                              tokenId: step.tokenId,
                              code: step.voucherCode ?? "",
                            })}
                          </span>
                        ) : null}

                        {step.voucherTxHash ? (
                          <a
                            href={explorerTx(step.voucherTxHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-2 py-1 font-mono text-[11px] font-bold text-brand-700 transition-colors hover:bg-brand-100"
                          >
                            mint {shortHash(step.voucherTxHash)} ↗
                          </a>
                        ) : null}

                        {step.error ? (
                          <p className="w-full text-[11px] font-semibold text-coral-500">
                            {step.error}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        {scrollable && fade.top ? (
          <div className="pointer-events-none absolute top-0 right-4 left-0 h-6 bg-gradient-to-b from-white to-transparent" />
        ) : null}
        {scrollable && fade.bottom ? (
          <div className="pointer-events-none absolute right-4 bottom-0 left-0 h-7 bg-gradient-to-t from-white to-transparent" />
        ) : null}
        <ScrollRail active={scrollable} scrollerRef={scrollerRef} />
      </div>
    </div>
  );
}
