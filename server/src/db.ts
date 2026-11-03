import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;

export function createDb(databaseUrl: string): Db {
  // Prisma stores DateTime as UTC `timestamp` (no zone). Pin the session to UTC so
  // raw SQL `now()` compares correctly whatever the server's timezone is.
  const adapter = new PrismaPg({ connectionString: databaseUrl, options: "-c TimeZone=UTC" });
  return new PrismaClient({ adapter });
}
