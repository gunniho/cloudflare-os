import type { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Snapshot one vendor-description RPC result into a reusable plain value.
 *
 * Workers RPC results can carry session disposal metadata even when their declared type is a plain
 * serializable object. The async boundary consumes the call once, and the structured clone keeps
 * only the durable data that a subscription may safely reuse in a later execution context.
 */
export async function snapshotVendorDescription(
    operation: () => PromiseLike<VendorDescription & Partial<Disposable>>)
    : Promise<VendorDescription> {
  return structuredClone(await operation());
}
