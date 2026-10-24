import type { MiddlewareHandler } from "hono";

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

function clientIp(header: (name: string) => string | undefined): string {
  const forwarded = header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return header("x-real-ip") ?? "local";
}

/** 公开写接口的滑动窗口限流。只拦截 POST。 */
export function rateLimit(options: { max: number; windowMs: number; name: string }): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    const now = Date.now();
    const key = `${options.name}:${clientIp((name) => c.req.header(name))}`;
    const bucket = buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((at) => now - at < options.windowMs);
    if (bucket.hits.length >= options.max) {
      c.header("retry-after", String(Math.ceil(options.windowMs / 1000)));
      return c.json({ error: "RATE_LIMITED", message: "请求过于频繁，请稍后再试" }, 429);
    }
    bucket.hits.push(now);
    buckets.set(key, bucket);
    await next();
  };
}
