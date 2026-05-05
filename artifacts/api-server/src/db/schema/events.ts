import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const eventsTable = pgTable("events", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  universityId: text("university_id").notNull(),
  batch: text("batch").notNull().default("2025"),
  year: text("year").notNull(),
  branch: text("branch").notNull(),
  exam: text("exam").notNull(),
  configId: text("config_id").notNull(),
  topicId: text("topic_id"),
  subtopicId: text("subtopic_id"),
  questionId: text("question_id"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertEventSchema = createInsertSchema(eventsTable).omit({ id: true, timestamp: true, createdAt: true, updatedAt: true });
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof eventsTable.$inferSelect;
