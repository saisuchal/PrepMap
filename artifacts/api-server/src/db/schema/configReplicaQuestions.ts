import { bigserial, boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const configReplicaQuestionsTable = pgTable("config_replica_questions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  configId: text("config_id").notNull(),
  markType: text("mark_type").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  unitTitle: text("unit_title").notNull(),
  topicTitle: text("topic_title").notNull(),
  subtopicTitle: text("subtopic_title").notNull(),
  isStarred: boolean("is_starred").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertConfigReplicaQuestionSchema = createInsertSchema(configReplicaQuestionsTable).omit({ id: true });
export type InsertConfigReplicaQuestion = z.infer<typeof insertConfigReplicaQuestionSchema>;
export type ConfigReplicaQuestion = typeof configReplicaQuestionsTable.$inferSelect;

