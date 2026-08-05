import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { AuthService } from "./auth.service.js";
import type { MailService } from "./mail.service.js";
import type { DatabaseService } from "../database/database.service.js";

test("production reset tokens and outbox messages share one transaction", async () => {
  let insideTransaction = false;
  let queued = false;
  const client = {
    query: async (sql: string) => ({
      rows: [],
      rowCount: sql.includes("password_reset_tokens") && sql.includes("SELECT 1") ? 0 : 1,
    }),
  } as unknown as PoolClient;
  const database = {
    query: async () => ({ rows: [{
      id: "10000000-0000-4000-8000-000000000001",
      email: "founder@example.com",
      normalized_email: "founder@example.com",
      full_name: "Founder",
      password_hash: null,
      email_verified_at: new Date(),
      status: "ACTIVE",
    }] }),
    transaction: async <T>(work: (transactionClient: PoolClient) => Promise<T>) => {
      insideTransaction = true;
      try {
        return await work(client);
      } finally {
        insideTransaction = false;
      }
    },
  };
  const mail = {
    usesDurableOutbox: true,
    dispatchLink: async (_to: string, _kind: string, _token: string, queryClient?: PoolClient) => {
      assert.equal(insideTransaction, true);
      assert.equal(queryClient, client);
      queued = true;
      return undefined;
    },
  };
  const service = new AuthService(
    database as unknown as DatabaseService,
    mail as unknown as MailService,
  );

  await service.requestPasswordReset("founder@example.com");

  assert.equal(queued, true);
});
