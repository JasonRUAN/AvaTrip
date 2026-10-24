import assert from "node:assert/strict";
import test from "node:test";
import { resetInternalNonces, signInternalRequest, verifyInternalRequest } from "./internal-auth";

const now = 1_700_000_000_000;
const body = JSON.stringify({ orderId: "1" });

function headers() {
  return signInternalRequest("POST", "/v1/vouchers/issue", body, now);
}

test("签名请求可以通过，改包体或重放 nonce 会被拒绝", () => {
  resetInternalNonces();
  const signed = headers();
  const ok = verifyInternalRequest({
    method: "POST",
    path: "/v1/vouchers/issue",
    body,
    ...{
      timestamp: signed["x-internal-timestamp"],
      nonce: signed["x-internal-nonce"],
      signature: signed["x-internal-signature"],
    },
    now,
  });
  assert.equal(ok.ok, true);

  const replay = verifyInternalRequest({
    method: "POST",
    path: "/v1/vouchers/issue",
    body,
    timestamp: signed["x-internal-timestamp"],
    nonce: signed["x-internal-nonce"],
    signature: signed["x-internal-signature"],
    now,
  });
  assert.equal(replay.ok, false);

  resetInternalNonces();
  const tampered = verifyInternalRequest({
    method: "POST",
    path: "/v1/vouchers/issue",
    body: JSON.stringify({ orderId: "2" }),
    timestamp: signed["x-internal-timestamp"],
    nonce: signed["x-internal-nonce"],
    signature: signed["x-internal-signature"],
    now,
  });
  assert.equal(tampered.ok, false);
});

test("超出时间窗的签名无效", () => {
  resetInternalNonces();
  const signed = headers();
  const verdict = verifyInternalRequest({
    method: "POST",
    path: "/v1/vouchers/issue",
    body,
    timestamp: signed["x-internal-timestamp"],
    nonce: signed["x-internal-nonce"],
    signature: signed["x-internal-signature"],
    now: now + 10 * 60 * 1000,
  });
  assert.equal(verdict.ok, false);
});
