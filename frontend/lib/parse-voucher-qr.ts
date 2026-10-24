import { canonicalVoucherId, isVoucherIdReady } from "./voucher-id";

/**
 * 从扫到的文本里取出凭证 tokenId。
 *
 * 票面二维码是 `/verify/{tokenId}?chain={chainId}`（凭证卡在浏览器里生成）
 * 或 `moontrip://voucher/{tokenId}?chain={chainId}`（没有 origin 时的兜底），
 * 也接受直接印出来的 `MT-000012` / 纯数字编号。
 */

export interface VoucherQrPayload {
  /** 数字 tokenId，可直接拼进 /api/vouchers/:tokenId */
  tokenId: string;
  /** 二维码里带的链；多链部署下商户端据此切到凭证所在的那条链 */
  chainId?: number;
}

const DEEP_LINK = /(?:moontrip|avatrip):\/\/voucher\/([^/?#\s]+)/i;
const VERIFY_PATH = /\/verify\/([^/?#\s]+)/i;

function toChainId(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 解析失败返回 null，调用方据此提示「不是 AvaTrip 凭证二维码」。 */
export function parseVoucherQrPayload(text: string): VoucherQrPayload | null {
  const raw = text.trim();
  if (!raw) return null;

  // 1) 完整 URL：http(s) 走 /verify 路径，moontrip:// 走 deep link
  const embedded = VERIFY_PATH.exec(raw)?.[1] ?? DEEP_LINK.exec(raw)?.[1];
  let candidate = embedded ?? raw;
  let chainId: number | undefined;

  if (embedded && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      chainId = toChainId(url.searchParams.get("chain"));
    } catch {
      // 自定义协议 URL 解析失败就只当普通文本继续认编号
    }
  }

  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // 非法转义就按原文继续认编号
  }

  const tokenId = isVoucherIdReady(candidate)
    ? canonicalVoucherId(candidate)
    : null;
  if (!tokenId) return null;

  return chainId ? { tokenId, chainId } : { tokenId };
}

/** 只要编号、不关心链的便捷入口。 */
export function parseVoucherQr(text: string): string | null {
  return parseVoucherQrPayload(text)?.tokenId ?? null;
}
