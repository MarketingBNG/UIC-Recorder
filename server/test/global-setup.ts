import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

// Spins up a throwaway PostgreSQL 18 and applies the real migrations.
export default async function setup() {
  const dir = path.resolve(process.env["TEST_DB_DIR"] ?? ".pgtest");
  rmSync(dir, { recursive: true, force: true });
  // TEST_DB_PORT lets a second checkout (git worktree) run tests at the same time.
  const port = Number(process.env["TEST_DB_PORT"] ?? 54339);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: "uic",
    password: "test",
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("uic_test");
  const url = `postgresql://uic:test@localhost:${port}/uic_test`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  process.env["TEST_DATABASE_URL"] = url;

  return async () => {
    await pg.stop();
  };
}
