import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  universityId: text("university_id").notNull(),
  branch: text("branch").notNull(),
  year: text("year").notNull(),
  role: text("role").notNull().default("student"),
  password: text("password").notNull(),
  mustResetPassword: boolean("must_reset_password").notNull().default(false),
  securityQuestion: text("security_question"),
  securityAnswerHash: text("security_answer_hash"),
  lastSuccessfulLoginAt: timestamp("last_successful_login_at"),
  lastPasswordResetAt: timestamp("last_password_reset_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable);
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
