import { pgTable, text, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subtopicQuestionsTable = pgTable("subtopic_questions", {
  id: serial("id").primaryKey(),
  nodeId: text("node_id").notNull(),
  markType: text("mark_type").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
});

export const insertSubtopicQuestionSchema = createInsertSchema(subtopicQuestionsTable).omit({ id: true });
export type InsertSubtopicQuestion = z.infer<typeof insertSubtopicQuestionSchema>;
export type SubtopicQuestion = typeof subtopicQuestionsTable.$inferSelect;
