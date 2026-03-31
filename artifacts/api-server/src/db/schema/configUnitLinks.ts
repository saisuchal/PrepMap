import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const configUnitLinksTable = pgTable("config_unit_links", {
  id: text("id").primaryKey(),
  configId: text("config_id").notNull(),
  unitLibraryId: text("unit_library_id").notNull(),
  sortOrder: text("sort_order").notNull().default("0"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertConfigUnitLinkSchema = createInsertSchema(configUnitLinksTable);
export type InsertConfigUnitLink = z.infer<typeof insertConfigUnitLinkSchema>;
export type ConfigUnitLink = typeof configUnitLinksTable.$inferSelect;

