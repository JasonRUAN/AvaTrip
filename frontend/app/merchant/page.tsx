"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DemoBadge } from "@/components/demo-badge";
import { IphoneFrame } from "@/components/merchant/iphone-frame";
import { ScannerApp, type ScannedVoucher } from "@/components/merchant/scanner-app";
import { VoucherCard } from "@/components/voucher-card";
import { useAppChain } from "@/lib/chain-context";
import { getChainById, withChain } from "@/lib/chains";
import { BACKEND_URL } from "@/lib/contracts";
import { invalidateVoucherList } from "@/lib/session-cache";
import { canonicalVoucherId } from "@/lib/voucher-id";
import { useT } from "@/lib/i18n/context";
import { backendErrorText } from "@/lib/backend-error";
import type { VoucherDetail } from "@/lib/types";

/**
 * 提示语的错误类型。
 *
 * 之前是靠 `message.includes("失败")` 判断红/绿样式，翻译后这条判断必然失效；
 * 改成结构化 code，样式与文案解耦。
 */
type NoticeCode = "success" | "not_found" | "not_exist" | "failed" | "network";
type EntryMode = "scan" | "manual";

interface Notice {
  code: NoticeCode;
  text: string;
}

/** 商户核销端：扫码与手工输入共用同一套预览和链上核销 */
export default function MerchantPage() {
  const { t, locale } = useT();
  const appChain = useAppChain();
  const [mode, setMode] = useState<EntryMode>("scan");
  const [input, setInput] = useState("");
  const [record, setRecord] = useState<{
    key: string;
    detail: VoucherDetail | null;
    notice: Notice | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const lookupId = canonicalVoucherId(input);
  // 凭证是按链隔离的：切链后同一编号要重新查，所以缓存 key 带上 chainId
  const recordKey = lookupId ? `${appChain.chainId}:${lookupId}` : "";
  const active = record && record.key === recordKey ? record : null;
  const detail = active?.detail ?? null;
  const notice = active?.notice ?? null;

  useEffect(() => {
    // lookupId 为空时 recordKey 也是空，active 自然取不到旧记录，
    // 所以这里不需要（也不能）在 effect 体里同步 setState 清空
    if (!lookupId) return;
    let cancelled = false;

    fetch(withChain(`${BACKEND_URL}/api/vouchers/${lookupId}`, appChain.chainId))
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("404"))))
      .then((payload: VoucherDetail) => {
        if (cancelled) return;
        setRecord({ key: recordKey, detail: payload, notice: null });
        // 后端已经不是有效态：持有者那边的列表缓存作废，避免还显示「有效」
        if (payload.status !== "Issued") invalidateVoucherList();
      })
      .catch(() => {
        if (cancelled) return;
        setRecord({
          key: recordKey,
          detail: null,
          notice: { code: "not_found", text: t("merchant.notFound") },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [appChain.chainId, lookupId, recordKey, t]);

  // 仅 Issued 状态可核销；Redeemed / Voided 均视为不可重复使用
  const unavailable = detail !== null && detail.status !== "Issued";

  const setNotice = (next: Notice | null) => {
    setRecord((prev) => ({
      key: recordKey,
      detail: prev && prev.key === recordKey ? prev.detail : null,
      notice: next,
    }));
  };

  const redeem = async () => {
    if (!lookupId) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        withChain(`${BACKEND_URL}/api/vouchers/${lookupId}/redeem`, appChain.chainId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chainId: appChain.chainId }),
        }
      );
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        txHash?: string;
        providerName?: string;
      };

      if (!response.ok) {
        // 已核销 / 已作废不是错误，把票面状态同步过来即可
        if (payload.error === "ALREADY_REDEEMED" || payload.error === "VOUCHER_VOIDED") {
          const status = payload.error === "VOUCHER_VOIDED" ? "Voided" : "Redeemed";
          setRecord((prev) => ({
            key: recordKey,
            detail: prev && prev.key === recordKey && prev.detail ? { ...prev.detail, status } : null,
            notice: null,
          }));
          invalidateVoucherList();
          return;
        }
        setNotice(
          payload.error === "VOUCHER_NOT_FOUND"
            ? { code: "not_exist", text: t("merchant.notExist") }
            : {
                code: "failed",
                // 后端只回 code：按当前语言取字典，未知 code 才回退服务端 message
                text:
                  backendErrorText(locale, {
                    code: payload.error,
                    message: payload.message,
                  }) ?? t("merchant.redeemFailed"),
              }
        );
        return;
      }

      setRecord((prev) => ({
        key: recordKey,
        detail:
          prev && prev.key === recordKey && prev.detail
            ? { ...prev.detail, status: "Redeemed" }
            : null,
        notice: null,
      }));
      // 状态已变成 Redeemed：持有者那边的凭证页缓存作废，避免还显示「有效」
      invalidateVoucherList();
      setNotice({
        code: "success",
        text:
          t("merchant.redeemSuccess", {
            provider: payload.providerName ?? detail?.providerName ?? t("merchant.issuerFallback"),
          }) + (payload.txHash ? "" : t("merchant.demoSuffix")),
      });
    } catch {
      setNotice({ code: "network", text: t("merchant.backendDown") });
    } finally {
      setBusy(false);
    }
  };

  const redeemLabel = busy
    ? t("merchant.redeeming")
    : unavailable
      ? detail?.status === "Voided"
        ? t("merchant.voided")
        : t("merchant.alreadyRedeemed")
      : t("merchant.confirm");

  const onScanned = (scanned: ScannedVoucher) => {
    // 二维码里带了链就跟着切过去，否则凭证会查不到
    if (scanned.chainId && scanned.chainId !== appChain.chainId) {
      const target = getChainById(scanned.chainId);
      if (target) void appChain.selectChain(target.key);
    }
    setInput(scanned.tokenId);
    setMode("manual");
  };

  return (
    <main className="flex min-h-[calc(100dvh-68px)] items-center justify-center px-0 py-0 md:px-4 md:py-6">
      <IphoneFrame variant={mode}>
        <div className="relative z-20 px-4 pt-14 pb-2">
          <div
            role="tablist"
            aria-label={t("merchant.title")}
            className={`grid grid-cols-2 rounded-full p-1 ${
              mode === "scan" ? "bg-white/15 backdrop-blur-md" : "bg-white/80 shadow-soft"
            }`}
          >
            {(
              [
                ["scan", t("merchant.modeScan")],
                ["manual", t("merchant.modeManual")],
              ] as const
            ).map(([id, label]) => {
              const selected = mode === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setMode(id)}
                  className={`h-8 cursor-pointer rounded-full text-xs font-bold transition-colors ${
                    selected
                      ? "bg-brand-600 text-white shadow-soft"
                      : mode === "scan"
                        ? "text-white/80"
                        : "text-ink-500"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {mode === "scan" ? (
          <ScannerApp onDetected={onScanned} onUseManual={() => setMode("manual")} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-1 pb-3">
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight text-brand-gradient">
                {t("merchant.title")}
              </h1>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                {t("merchant.subtitle")}
              </p>
            </div>

            <div>
              <p className="mb-2 text-xs font-bold tracking-wide text-ink-300">
                {t("merchant.step1")}
              </p>
              <input
                value={input}
                onChange={(event) =>
                  setInput(event.target.value.toUpperCase().replace(/[^A-Z0-9#-]/g, ""))
                }
                inputMode="numeric"
                autoCapitalize="characters"
                spellCheck={false}
                autoFocus
                placeholder={t("merchant.tokenPlaceholder")}
                className="w-full rounded-xl border border-brand-100 bg-white px-4 py-3 font-mono text-lg font-bold tracking-wide text-ink-900 outline-none transition-all focus:border-brand-400 focus:shadow-glow"
              />
              <p className="mt-2 text-xs text-ink-500">
                {t("merchant.identity")}
                {detail ? (
                  <span className="font-bold text-ink-900">{detail.providerName}</span>
                ) : (
                  <span className="text-ink-300">{t("merchant.identityEmpty")}</span>
                )}
              </p>
            </div>

            <button
              type="button"
              disabled={busy || !lookupId || unavailable}
              onClick={redeem}
              className="sky-gradient flex h-12 w-full cursor-pointer items-center justify-center rounded-2xl text-base font-bold text-white shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-glow disabled:cursor-not-allowed disabled:opacity-60"
            >
              {redeemLabel}
            </button>

            {unavailable && !busy && !notice ? (
              <p className="rounded-xl bg-ink-100 px-3 py-2 text-xs font-semibold text-ink-500">
                {t("merchant.unavailable")}
              </p>
            ) : null}

            {notice ? (
              <p
                className={`rounded-xl px-3 py-2 text-xs font-semibold ${
                  notice.code === "success"
                    ? "bg-mint-100 text-mint-500"
                    : "bg-coral-100 text-coral-500"
                }`}
              >
                {notice.text}
              </p>
            ) : null}
            {detail?.status === "Redeemed" ? (
              <Link href="/vouchers" className="text-xs font-bold text-brand-700 hover:underline">
                {t("merchant.rateLink")}
              </Link>
            ) : null}

            <div className="flex items-center gap-2">
              <DemoBadge tone="warn" label={t("merchant.demoLabel")} />
              <span className="text-[11px] text-ink-300">{t("merchant.demoNote")}</span>
            </div>

            {detail ? (
              <VoucherCard voucher={detail} />
            ) : (
              <div className="rounded-3xl border border-dashed border-brand-200 bg-white/50 px-5 py-10 text-center">
                <span className="text-3xl">🎫</span>
                <p className="mt-2 text-sm font-semibold text-ink-500">
                  {t("merchant.previewEmpty")}
                </p>
              </div>
            )}
          </div>
        )}
      </IphoneFrame>
    </main>
  );
}
