import { describe, expect, it } from "vitest";
import type { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { snapshotVendorDescription } from "../src/rpc-result.js";

describe("Workers RPC result normalization", () => {
  it("turns a one-shot custom thenable into a reusable native promise", async () => {
    let awaitCount = 0;
    const rpcValue: VendorDescription & Disposable = {
      displayName: "Google Analytics",
      url: "https://analytics.google.com/",
      [Symbol.dispose]() {},
    };
    const rpcResult: PromiseLike<typeof rpcValue> = {
      // oxlint-disable-next-line unicorn/no-thenable -- Deliberately models a Workers RPC result.
      then(onfulfilled, onrejected) {
        awaitCount += 1;
        if (awaitCount > 1) return new Promise(() => {});
        return Promise.resolve(rpcValue).then(onfulfilled, onrejected);
      },
    };

    const reusable = snapshotVendorDescription(() => rpcResult);

    const first = await reusable;
    const second = await reusable;
    expect(first).toEqual({
      displayName: "Google Analytics",
      url: "https://analytics.google.com/",
    });
    expect(second).toBe(first);
    expect(first).not.toBe(rpcValue);
    expect(Symbol.dispose in first).toBe(false);
    expect(awaitCount).toBe(1);
  });

  it("converts a synchronous RPC startup failure into a rejected promise", async () => {
    const failure = new Error("service unavailable");

    await expect(snapshotVendorDescription(() => { throw failure; })).rejects.toBe(failure);
  });
});
