import { describe, expect, it, vi } from "vitest";
import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  reconcileConnectedAccountAliases,
  replaceConnectedAccountWithFreshGrant,
  type StableIdentityAccountRecord,
} from "../src/connected-account-dedup.js";

type TestAccount = {
  describe: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
};

type TestRecord = StableIdentityAccountRecord<TestAccount>;

function description(accountIdentityKey?: string): AccountDescription {
  return {
    displayName: "Google Analytics (8 properties)",
    ...(accountIdentityKey === undefined ? {} : { accountIdentityKey }),
    avatar: { url: "https://example.test/analytics.svg" },
  };
}

function account() {
  return {
    describe: vi.fn(),
    revoke: vi.fn(),
  };
}

function record(
    id: number, accountIdentityKey?: string,
    overrides: Partial<TestRecord> = {}): TestRecord {
  return {
    id,
    account: account(),
    description: description(accountIdentityKey),
    vendorId: "analytics",
    ...overrides,
  };
}

describe("connected-account stable identity deduplication", () => {
  it("keeps the lowest account id and marks higher records as preserved aliases", () => {
    const records = [record(9, "ga:user-a"), record(2, "ga:user-a"), record(5, "ga:user-b")];

    expect(reconcileConnectedAccountAliases(records).map(item => item.id).toSorted()).toEqual([9]);
    expect(records.find(item => item.id === 2)?.duplicateOf).toBeUndefined();
    expect(records.find(item => item.id === 9)?.duplicateOf).toBe(2);
    expect(records.find(item => item.id === 5)?.duplicateOf).toBeUndefined();
  });

  it("never groups identities across vendors", () => {
    const analytics = record(1, "shared-hash");
    const anotherVendor = record(2, "shared-hash", { vendorId: "another" });

    expect(reconcileConnectedAccountAliases([analytics, anotherVendor])).toEqual([]);
    expect(analytics.duplicateOf).toBeUndefined();
    expect(anotherVendor.duplicateOf).toBeUndefined();
  });

  it("clears a stale alias marker when identities no longer match", () => {
    const formerAlias = record(7, "ga:user-b", { duplicateOf: 3 });

    expect(reconcileConnectedAccountAliases([record(3, "ga:user-a"), formerAlias]))
      .toEqual([formerAlias]);
    expect(formerAlias.duplicateOf).toBeUndefined();
  });

  it("moves the fresh capability onto the canonical id without revoking either grant", () => {
    const oldAccount = account();
    const freshAccount = account();
    const canonical = record(2, "ga:user-a", {
      account: oldAccount,
      credentialsExpired: true,
      duplicateOf: 1,
    });
    const fresh = record(12, "ga:user-a", {
      account: freshAccount,
      credentialExpiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    replaceConnectedAccountWithFreshGrant(canonical, fresh);

    expect(canonical.id).toBe(2);
    expect(canonical.account).toBe(freshAccount);
    expect(canonical.description).toBe(fresh.description);
    expect(canonical.credentialExpiresAt).toEqual(fresh.credentialExpiresAt);
    expect(canonical.credentialsExpired).toBe(false);
    expect(canonical.duplicateOf).toBeUndefined();
    expect(oldAccount.revoke).not.toHaveBeenCalled();
    expect(freshAccount.revoke).not.toHaveBeenCalled();
  });

  it("ignores missing, oversized, and control-character identity keys", () => {
    const malformed = [
      record(1),
      record(2, "x".repeat(257)),
      record(3, "bad\nkey"),
      record(4, ""),
    ];

    expect(reconcileConnectedAccountAliases(malformed)).toEqual([]);
    expect(malformed.every(item => item.duplicateOf === undefined)).toBe(true);
  });
});
