import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { loadMigrationConfig } from "../config.js";

async function migrate() {
  const pool = new Pool({ connectionString: loadMigrationConfig().databaseUrl });
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql"));
  files.sort();

  try {
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const exists = await pool.query(
        "SELECT to_regclass('schema_migrations') AS table_name",
      );
      const hasTable = Boolean(exists.rows[0]?.table_name);
      const applied = hasTable
        ? await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version])
        : { rowCount: 0 };
      if (applied.rowCount) continue;
      await pool.query(await readFile(resolve(directory, file), "utf8"));
      process.stdout.write(`Applied migration ${version}\n`);
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
