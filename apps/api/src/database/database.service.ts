import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { loadConfig } from "../config.js";

type DatabaseContext = {
  userId: string;
  onboardingOrganizationId?: string;
};

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly config = loadConfig();
  private readonly pool = new Pool({
    connectionString: this.config.databaseUrl,
    max: this.config.databasePoolMax,
  });

  query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    context?: DatabaseContext,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (context) {
        await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
        if (context.onboardingOrganizationId) {
          await client.query(
            "SELECT set_config('app.onboarding_organization_id', $1, true)",
            [context.onboardingOrganizationId],
          );
        }
      }
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
