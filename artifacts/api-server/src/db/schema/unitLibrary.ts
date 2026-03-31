import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type UnitTopic = {
  title: string;
  subtopics: string[];
};

export const unitLibraryTable = pgTable("unit_library", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id").notNull(),
  unitTitle: text("unit_title").notNull(),
  normalizedUnitTitle: text("normalized_unit_title").notNull(),
  topics: jsonb("topics").$type<UnitTopic[]>().notNull().default([]),
  sourceText: text("source_text"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUnitLibrarySchema = createInsertSchema(unitLibraryTable);
export type InsertUnitLibrary = z.infer<typeof insertUnitLibrarySchema>;
export type UnitLibrary = typeof unitLibraryTable.$inferSelect;

