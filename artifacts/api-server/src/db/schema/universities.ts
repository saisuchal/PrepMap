import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const universitiesTable = pgTable("universities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type University = typeof universitiesTable.$inferSelect;

