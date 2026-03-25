import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subtopicContentsTable = pgTable("subtopic_contents", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull(),
  explanation: text("explanation").notNull(),
  twoMarkQuestion: text("two_mark_question").notNull(),
  twoMarkAnswer: text("two_mark_answer").notNull(),
  fiveMarkQuestion: text("five_mark_question").notNull(),
  fiveMarkAnswer: text("five_mark_answer").notNull(),
});

export const insertSubtopicContentSchema = createInsertSchema(subtopicContentsTable);
export type InsertSubtopicContent = z.infer<typeof insertSubtopicContentSchema>;
export type SubtopicContent = typeof subtopicContentsTable.$inferSelect;
