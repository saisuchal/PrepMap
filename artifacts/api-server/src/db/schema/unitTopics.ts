import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const unitTopicsTable = pgTable("unit_topics", {
  id: text("id").primaryKey(),
  unitLibraryId: text("unit_library_id").notNull(),
  title: text("title").notNull(),
  normalizedTitle: text("normalized_title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  explanation: text("explanation"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUnitTopicSchema = createInsertSchema(unitTopicsTable);
export type InsertUnitTopic = z.infer<typeof insertUnitTopicSchema>;
export type UnitTopicRow = typeof unitTopicsTable.$inferSelect;
