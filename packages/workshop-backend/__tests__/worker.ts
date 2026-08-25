import { WorkerEntrypoint } from "cloudflare:workers";

export * from "../src/server.js";
export { default } from "../src/server.js";

let accountDescribeCount = 0;
let supportedResourcesCount = 0;
let revokeCount = 0;

export class TestAccount extends WorkerEntrypoint {
  async describe() {
    accountDescribeCount += 1;
    return {
      displayName: "Analytics User",
      uniqueName: "analytics@example.com",
      accountIdentityKey: "provider-user-hash",
      avatar: { url: "https://analytics.example/avatar.png" },
    };
  }

  async getSupportedResources() {
    supportedResourcesCount += 1;
    return [{
      urlPattern: "https://analytics.google.com/*",
      title: "Analytics property",
      description: "Read-only analytics reporting",
    }];
  }

  async revoke() { revokeCount += 1; }
  async getDescribeCount() { return accountDescribeCount; }
  async getSupportedResourcesCount() { return supportedResourcesCount; }
  async getRevokeCount() { return revokeCount; }
  async reset() {
    accountDescribeCount = 0;
    supportedResourcesCount = 0;
    revokeCount = 0;
  }
}
