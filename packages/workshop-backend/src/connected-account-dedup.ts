import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";

const MAX_ACCOUNT_IDENTITY_KEY_LENGTH = 256;

export type StableIdentityAccountRecord<Account = unknown> = {
  id: number;
  account: Account;
  description: AccountDescription;
  vendorId: string;
  credentialExpiresAt?: Date;
  credentialsExpired?: boolean;
  duplicateOf?: number;
};

export function getAccountIdentityKey(description: AccountDescription): string | undefined {
  const key = description.accountIdentityKey;
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_ACCOUNT_IDENTITY_KEY_LENGTH ||
      !/^[\x21-\x7e]+$/.test(key)) {
    return undefined;
  }
  return key;
}

/**
 * Mark repeated stable account identities as aliases without deleting either underlying account.
 * Records are reconciled in account-id order so the canonical id is deterministic and stable.
 * Returns the records whose alias marker changed and therefore need to be persisted.
 */
export function reconcileConnectedAccountAliases<T extends StableIdentityAccountRecord>(
    records: T[]): T[] {
  const changed: T[] = [];
  const canonicalByIdentity = new Map<string, number>();
  for (const record of records.toSorted((left, right) => left.id - right.id)) {
    const identityKey = getAccountIdentityKey(record.description);
    const groupKey = identityKey === undefined ? undefined : `${record.vendorId}\0${identityKey}`;
    const duplicateOf = groupKey === undefined ? undefined : canonicalByIdentity.get(groupKey);
    if (groupKey !== undefined && duplicateOf === undefined) {
      canonicalByIdentity.set(groupKey, record.id);
    }
    if (record.duplicateOf !== duplicateOf) {
      if (duplicateOf === undefined) {
        delete record.duplicateOf;
      } else {
        record.duplicateOf = duplicateOf;
      }
      changed.push(record);
    }
  }
  return changed;
}

/** Replace a canonical record with a fresh grant without touching either provider grant. */
export function replaceConnectedAccountWithFreshGrant<
    Account,
    T extends StableIdentityAccountRecord<Account>,
>(existing: T, fresh: StableIdentityAccountRecord<Account>): void {
  existing.account = fresh.account;
  existing.description = fresh.description;
  existing.credentialExpiresAt = fresh.credentialExpiresAt;
  existing.credentialsExpired = false;
  delete existing.duplicateOf;
}
