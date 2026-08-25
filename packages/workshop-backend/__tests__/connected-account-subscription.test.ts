import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { ConnectedAccountsSubscriber } from "@gadgets/workshop-shared/api";
import type {
  AccountDescription,
  GatekeeperUser,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectedAccountRecord, UserDurableObject } from "../src/user.js";

type TestGatekeeperVendor = {
  getDescribeCount(): Promise<number>;
  reset(): Promise<void>;
};

type TestGatekeeperAccount = {
  getDescribeCount(): Promise<number>;
  getSupportedResourcesCount(): Promise<number>;
  getRevokeCount(): Promise<number>;
  reset(): Promise<void>;
};

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    GATEKEEPER_STABLE_TEST: Service<TestGatekeeperVendor>;
    TEST_ACCOUNT: Service<TestGatekeeperAccount>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type SeedableUser = {
  ctx: {
    exports: {
      TestAccount(options: object): Fetcher<GatekeeperUser>;
    };
  };
  storage: {
    nextAccountId: { put(value: number): void };
    connectedAccounts: {
      get(id: number): ConnectedAccountRecord | undefined;
      put(record: ConnectedAccountRecord): void;
    };
  };
};

const ACCOUNT_DESCRIPTION: AccountDescription = {
  displayName: "Analytics User",
  uniqueName: "analytics@example.com",
  avatar: { url: "https://analytics.example/avatar.png" },
};

const REFRESHED_ACCOUNT_DESCRIPTION: AccountDescription = {
  ...ACCOUNT_DESCRIPTION,
  accountIdentityKey: "provider-user-hash",
};

describe("connected account subscription", () => {
  it("separates vendor RPC snapshots for identity refresh, advertisement, and live updates", async () => {
    await env.GATEKEEPER_STABLE_TEST.reset();
    await env.TEST_ACCOUNT.reset();
    const user = env.TEST_USER.get(env.TEST_USER.newUniqueId());

    await runInDurableObject(user, (instance: UserDurableObject) => {
      const testUser = instance as unknown as SeedableUser;
      const storage = testUser.storage;
      storage.nextAccountId.put(10);
      storage.connectedAccounts.put({
        id: 2,
        vendorId: "stable_test",
        account: testUser.ctx.exports.TestAccount({}),
        description: ACCOUNT_DESCRIPTION,
        duplicateOf: 9,
      });
      storage.connectedAccounts.put({
        id: 9,
        vendorId: "stable_test",
        account: testUser.ctx.exports.TestAccount({}),
        description: ACCOUNT_DESCRIPTION,
        duplicateOf: 2,
      });
    });

    const added: Array<{
      id: number;
      description: AccountDescription;
      vendor: VendorDescription;
      supportedResources: SupportedResource[];
      credentialsValid: boolean;
      vendorId: string;
    }> = [];
    const events: string[] = [];
    let markReady: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });

    class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
      add(id: number, description: AccountDescription, vendor: VendorDescription,
          supportedResources: SupportedResource[], credentialsValid: boolean, vendorId: string) {
        added.push({ id, description, vendor, supportedResources, credentialsValid, vendorId });
        events.push(`add:${id}:${credentialsValid}`);
      }
      remove(id: number) {
        events.push(`remove:${id}`);
        const index = added.findIndex(account => account.id === id);
        if (index !== -1) added.splice(index, 1);
      }
      ready() {
        events.push("ready");
        markReady();
      }
    }

    using subscriber = new RpcStub(new Subscriber());
    using _subscription = await user.subscribeConnectedAccounts(subscriber);
    await ready;

    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(events).toEqual(["add:2:true", "ready"]);
    expect(added[0]).toEqual({
      id: 2,
      description: REFRESHED_ACCOUNT_DESCRIPTION,
      vendor: {
        displayName: "Stable Analytics Vendor",
        url: "https://analytics.google.com/",
        stableAccountIdentity: true,
      },
      supportedResources: [{
        urlPattern: "https://analytics.google.com/*",
        title: "Analytics property",
        description: "Read-only analytics reporting",
      }],
      credentialsValid: true,
      vendorId: "stable_test",
    });
    await expect(env.GATEKEEPER_STABLE_TEST.getDescribeCount()).resolves.toBe(2);
    await expect(env.TEST_ACCOUNT.getDescribeCount()).resolves.toBe(2);
    await expect(env.TEST_ACCOUNT.getSupportedResourcesCount()).resolves.toBe(1);

    await user.markCredentialsExpired(9);
    expect(events).toEqual(["add:2:true", "ready"]);
    await expect(env.GATEKEEPER_STABLE_TEST.getDescribeCount()).resolves.toBe(2);
    await expect(env.TEST_ACCOUNT.getSupportedResourcesCount()).resolves.toBe(1);

    await user.markCredentialsExpired(2);
    await vi.waitFor(() => expect(added).toHaveLength(2));
    expect(events).toEqual(["add:2:true", "ready", "add:2:false"]);
    expect(added[1]).toMatchObject({ id: 2, credentialsValid: false });
    await expect(env.GATEKEEPER_STABLE_TEST.getDescribeCount()).resolves.toBe(3);
    await expect(env.TEST_ACCOUNT.getSupportedResourcesCount()).resolves.toBe(2);

    await user.markCredentialsRestored(2);
    await vi.waitFor(() => expect(added).toHaveLength(3));
    expect(events).toEqual([
      "add:2:true",
      "ready",
      "add:2:false",
      "add:2:true",
    ]);
    expect(added[2]).toMatchObject({ id: 2, credentialsValid: true });
    await expect(env.GATEKEEPER_STABLE_TEST.getDescribeCount()).resolves.toBe(4);
    await expect(env.TEST_ACCOUNT.getDescribeCount()).resolves.toBe(3);
    await expect(env.TEST_ACCOUNT.getSupportedResourcesCount()).resolves.toBe(3);
    await expect(env.TEST_ACCOUNT.getRevokeCount()).resolves.toBe(0);

    const persisted = await runInDurableObject(user, (instance: UserDurableObject) => {
      const storage = (instance as unknown as SeedableUser).storage.connectedAccounts;
      const canonical = storage.get(2);
      const alias = storage.get(9);
      return {
        canonicalIdentity: canonical?.description.accountIdentityKey,
        canonicalDuplicateOf: canonical?.duplicateOf,
        aliasIdentity: alias?.description.accountIdentityKey,
        aliasDuplicateOf: alias?.duplicateOf,
      };
    });
    expect(persisted).toEqual({
      canonicalIdentity: "provider-user-hash",
      canonicalDuplicateOf: undefined,
      aliasIdentity: "provider-user-hash",
      aliasDuplicateOf: 2,
    });
  }, 5_000);
});
