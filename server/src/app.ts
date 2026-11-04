import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyServerOptions } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { HttpError, type Deps } from "./context.js";
import { authRoutes } from "./routes/auth.js";
import { callRoutes } from "./routes/calls.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { deviceRoutes } from "./routes/device.js";
import { firefliesRoutes } from "./routes/fireflies.js";
import { importRoutes } from "./routes/import.js";
import { internalRoutes } from "./routes/internal.js";

export async function buildApp(deps: Deps, opts: FastifyServerOptions = {}) {
  const app = Fastify({
    trustProxy: true, // behind Coolify's reverse proxy
    bodyLimit: 1024 * 1024, // JSON bodies; audio is streamed separately
    ...opts,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
        mediaSrc: ["'self'"],
        connectSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", "https://accounts.google.com"],
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "Internal error" });
  });

  app.get("/health", { config: { rateLimit: false } }, async () => {
    await deps.db.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  await app.register(async (s) => authRoutes(s, deps));
  await app.register(async (s) => deviceRoutes(s, deps));
  await app.register(async (s) => callRoutes(s, deps));
  await app.register(async (s) => internalRoutes(s, deps));
  await app.register(async (s) => importRoutes(s, deps));
  await app.register(async (s) => dashboardRoutes(s, deps));
  await app.register(async (s) => firefliesRoutes(s, deps));

  // Built dashboard (React SPA), served from the same origin.
  // Built: dist/src/app.js -> dist/public. Dev (tsx src/app.ts): falls back to dist/public too.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = [path.resolve(here, "../public"), path.resolve(here, "../dist/public")].find((d) =>
    existsSync(path.join(d, "index.html")),
  );
  if (publicDir) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      const isApi = /^\/(api|v1|internal|auth)\b/.test(req.url);
      if (req.method === "GET" && !isApi) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return app;
}
