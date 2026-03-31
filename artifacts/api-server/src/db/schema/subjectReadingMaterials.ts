import { pgTable, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subjectReadingMaterialsTable = pgTable("subject_reading_materials", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id").notNull(),
  title: text("title").notNull(),
  materialType: text("material_type").notNull().default("reference"),
  fileUrl: text("file_url").notNull(),
  sourceOrder: integer("source_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSubjectReadingMaterialSchema = createInsertSchema(subjectReadingMaterialsTable);
export type InsertSubjectReadingMaterial = z.infer<typeof insertSubjectReadingMaterialSchema>;
export type SubjectReadingMaterial = typeof subjectReadingMaterialsTable.$inferSelect;
