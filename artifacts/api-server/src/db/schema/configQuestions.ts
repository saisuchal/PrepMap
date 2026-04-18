import { bigserial, boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const configQuestionsTable = pgTable("config_questions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  configId: text("config_id").notNull(),
  unitSubtopicId: text("unit_subtopic_id"),
  markType: text("mark_type").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  isStarred: boolean("is_starred").notNull().default(false),
  starSource: text("star_source").notNull().default("none"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertConfigQuestionSchema = createInsertSchema(configQuestionsTable).omit({ id: true });
export type InsertConfigQuestion = z.infer<typeof insertConfigQuestionSchema>;
export type ConfigQuestion = typeof configQuestionsTable.$inferSelect;
