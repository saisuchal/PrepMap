import app from "./app";
import { logger } from "./lib/logger";
import { initializeDatabase } from "./db";

const isProduction = process.env["NODE_ENV"] === "production";
const rawPort =
  process.env["API_PORT"] ?? (isProduction ? process.env["PORT"] : undefined) ?? "4000";

const port = Number(rawPort);
const skipDbInit = String(process.env["SKIP_DB_INIT"] || "").toLowerCase() === "true";
const allowStartWithoutDbInit =
  String(process.env["ALLOW_START_WITHOUT_DB_INIT"] || "").toLowerCase() === "true";

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start() {
  if (skipDbInit) {
    logger.warn("Skipping database initialization (SKIP_DB_INIT=true)");
  } else {
    try {
      logger.info("Initializing database before accepting requests");
      await initializeDatabase();
      logger.info("Database initialization completed");
    } catch (initErr) {
      logger.error({ err: initErr }, "Database initialization failed");
      if (!allowStartWithoutDbInit) {
        process.exit(1);
      }
      logger.warn("Continuing startup without DB init (ALLOW_START_WITHOUT_DB_INIT=true)");
    }
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

start();

