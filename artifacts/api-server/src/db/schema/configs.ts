import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const configsTable = pgTable("configs", {
  id: text("id").primaryKey(),
  universityId: text("university_id").notNull(),
  year: text("year").notNull(),
  branch: text("branch").notNull(),
  subject: text("subject").notNull(),
  exam: text("exam").notNull(),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by").notNull(),
  syllabusFileUrl: text("syllabus_file_url"),
  paperFileUrls: text("paper_file_urls").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertConfigSchema = createInsertSchema(configsTable);
export type InsertConfig = z.infer<typeof insertConfigSchema>;
export type Config = typeof configsTable.$inferSelect;
