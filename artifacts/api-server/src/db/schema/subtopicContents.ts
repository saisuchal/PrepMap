import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subtopicContentsTable = pgTable("subtopic_contents", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull(),
  explanation: text("explanation").notNull(),
});

export const insertSubtopicContentSchema = createInsertSchema(subtopicContentsTable);
export type InsertSubtopicContent = z.infer<typeof insertSubtopicContentSchema>;
export type SubtopicContent = typeof subtopicContentsTable.$inferSelect;
