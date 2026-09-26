import assert from "node:assert/strict";
import test from "node:test";

import {
  findTetherAuthAccount,
} from "../src/account.ts";

test("proven Tetherplane account resolves to stable subject only", async () => {
  const account =
    await findTetherAuthAccount(
      undefined as never,
      "account-owner:01",
    );

  assert.ok(account);
  assert.equal(
    account.accountId,
    "account-owner:01",
  );
  assert.deepEqual(
    await account.claims(
      "id_token",
      "openid tetherplane:access",
      {},
      [],
    ),
    {
      sub: "account-owner:01",
    },
  );
});

test("unsafe account subjects are not loadable", async () => {
  for (const subject of [
    "",
    " leading",
    "trailing ",
    "../admin",
    "account/other",
    "line\nbreak",
    "x".repeat(129),
  ]) {
    assert.equal(
      await findTetherAuthAccount(
        undefined as never,
        subject,
      ),
      undefined,
    );
  }
});
