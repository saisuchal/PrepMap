import app from "./app";
import { logger } from "./lib/logger";
import { initializeDatabase } from "./db";

const isProduction = process.env["NODE_ENV"] === "production";
const rawPort =
  process.env["API_PORT"] ?? (isProduction ? process.env["PORT"] : undefined) ?? "4000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start() {
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");

    // Run initialization after bind so API stays reachable even if schema sync is slow.
    initializeDatabase()
      .then(() => {
        logger.info("Database initialization completed");
      })
      .catch((initErr) => {
        logger.error({ err: initErr }, "Database initialization failed");
      });
  });
}

start();
