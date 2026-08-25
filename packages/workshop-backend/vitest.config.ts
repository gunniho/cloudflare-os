import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

const kCurrentWorker = Symbol.for('miniflare.kCurrentWorker') as never

// Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
// production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
// tests import modules directly; the main Worker and test-only bindings support focused Durable
// Object integration tests without loading the full deployment configuration.
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: './__tests__/worker.ts',
      miniflare: {
        compatibilityDate: '2026-02-02',
        compatibilityFlags: ['allow_irrevocable_stub_storage', 'experimental', 'nodejs_compat'],
        durableObjects: {
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_USER: { className: 'UserDurableObject', useSQLite: true },
        },
        kvNamespaces: ['BLUEPRINTS'],
        serviceBindings: {
          GATEKEEPER_STABLE_TEST: { name: 'test-gatekeeper', entrypoint: 'TestVendor' },
          TEST_ACCOUNT: { name: kCurrentWorker, entrypoint: 'TestAccount' },
        },
        workers: [{
          name: 'test-gatekeeper',
          modules: true,
          compatibilityDate: '2026-02-02',
          compatibilityFlags: ['allow_irrevocable_stub_storage'],
          script: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            let describeCount = 0;
            export class TestVendor extends WorkerEntrypoint {
              async describe() {
                describeCount += 1;
                return {
                  displayName: "Stable Analytics Vendor",
                  url: "https://analytics.google.com/",
                  stableAccountIdentity: true,
                };
              }

              async getDescribeCount() { return describeCount; }
              async reset() { describeCount = 0; }
            }
          `,
        }],
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
  },
})
