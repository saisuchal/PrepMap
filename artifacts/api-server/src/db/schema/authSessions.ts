import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const authSessionsTable = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => ({
    refreshTokenHashUnique: uniqueIndex("auth_sessions_refresh_token_hash_unique").on(table.refreshTokenHash),
    userIdIdx: index("auth_sessions_user_id_idx").on(table.userId),
    expiresAtIdx: index("auth_sessions_expires_at_idx").on(table.expiresAt),
  }),
);

export type AuthSession = typeof authSessionsTable.$inferSelect;
