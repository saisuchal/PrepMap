import { pgTable, text, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const configsTable = pgTable("configs", {
  id: text("id").primaryKey(),
  universityId: text("university_id").notNull(),
  year: text("year").notNull(),
  branch: text("branch").notNull(),
  subject: text("subject").notNull(),
  exam: text("exam").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const insertConfigSchema = createInsertSchema(configsTable);
export type InsertConfig = z.infer<typeof insertConfigSchema>;
export type Config = typeof configsTable.$inferSelect;
