import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, type LogFields } from "./logger";

const log = createLogger("audit");
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".data");
const AUDIT_FILE = path.join(DATA_DIR, "audit.log");

/** 结构化审计：控制台一条，磁盘一行 JSON。不记录密钥字段。 */
export function audit(event: string, fields: LogFields = {}): void {
  const row = { ts: new Date().toISOString(), event, ...fields };
  log.info(event, fields);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify(row)}\n`, "utf8");
  } catch (error) {
    log.error("审计日志落盘失败", { event }, error);
  }
}
