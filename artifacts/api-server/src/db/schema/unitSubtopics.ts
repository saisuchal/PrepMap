import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const unitSubtopicsTable = pgTable("unit_subtopics", {
  id: text("id").primaryKey(),
  unitTopicId: text("unit_topic_id").notNull(),
  title: text("title").notNull(),
  normalizedTitle: text("normalized_title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  explanation: text("explanation"),
  facts: text("facts"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUnitSubtopicSchema = createInsertSchema(unitSubtopicsTable);
export type InsertUnitSubtopic = z.infer<typeof insertUnitSubtopicSchema>;
export type UnitSubtopic = typeof unitSubtopicsTable.$inferSelect;
