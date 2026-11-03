// Local development only: runs a real PostgreSQL 18 from the embedded-postgres
// binaries, so no Docker or system install is needed. Never used in production.
//   npm run dev:db        (keeps running; Ctrl+C to stop)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const port = Number(process.env["DEV_DB_PORT"] ?? 54329);
const databaseDir = path.resolve(process.env["DEV_DB_DIR"] ?? ".pgdata");
const fresh = !existsSync(databaseDir);

const pg = new EmbeddedPostgres({
  databaseDir,
  port,
  user: "uic",
  password: "uic-dev-password",
  persistent: true,
  onLog: () => {},
  onError: (e) => console.error(String(e)),
});
// If start fails with "pre-existing shared memory block is still in use", an old
// postgres.exe from this folder is still running (e.g. after a force-kill); stop it.

if (fresh) await pg.initialise();
await pg.start();
if (fresh) {
  await pg.createDatabase("uic");
  await pg.createDatabase("uic_shadow");
}

console.log(`Postgres 18 ready: postgresql://uic:uic-dev-password@localhost:${port}/uic`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
