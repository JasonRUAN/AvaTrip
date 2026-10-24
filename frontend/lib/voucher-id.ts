/**
 * 对外凭证号：MT-000012。
 * 链上和后端接口内部一律用 ERC-721 的纯数字 tokenId（如 12），两边必须用同一套规则互转。
 *
 * 对外编号只是「给商户看 / 印在票面」的展示形式，入库前必须先用
 * `canonicalVoucherId` 还原成数字 tokenId，避免把 MT- 前缀带到 API 路径里。
 */

const PREFIX = "MT";

function unpad(digits: string): string {
  const trimmed = digits.replace(/^0+/, "");
  return trimmed.length > 0 ? trimmed : "0";
}

/** 用户输入已完整，可以拿去查询。半截的 MT-00001 不算。 */
export function isVoucherIdReady(input: string): boolean {
  const raw = input.trim().toUpperCase();
  if (/^\d+$/.test(raw)) return Number(raw) > 0;
  return new RegExp(`^${PREFIX}-\\d{6,}$`).test(raw);
}

/** 对外编号 / `#12` / 纯数字 → 存储用的数字 tokenId。认不出则返回 null。 */
export function canonicalVoucherId(input: string): string | null {
  const raw = input.trim().toUpperCase();
  const prefixed = new RegExp(`^${PREFIX}-(\\d+)$`).exec(raw);
  if (prefixed) return unpad(prefixed[1]!);
  const plain = /^#?(\d+)$/.exec(raw);
  if (plain) return unpad(plain[1]!);
  return null;
}

/** 12 → MT-000012。已经是对外编号时原样补齐。 */
export function formatVoucherId(tokenId: string): string {
  const canonical = canonicalVoucherId(tokenId);
  if (!canonical) return tokenId;
  return `${PREFIX}-${canonical.padStart(6, "0")}`;
}
