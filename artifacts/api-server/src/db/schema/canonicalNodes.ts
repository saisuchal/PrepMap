import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const canonicalNodesTable = pgTable("canonical_nodes", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id").notNull(),
  unitLibraryId: text("unit_library_id").notNull(),
  title: text("title").notNull(),
  normalizedTitle: text("normalized_title"),
  type: text("type").notNull(),
  parentCanonicalNodeId: text("parent_canonical_node_id"),
  explanation: text("explanation"),
  learningGoal: text("learning_goal"),
  exampleBlock: text("example_block"),
  supportNote: text("support_note"),
  prerequisiteTitles: text("prerequisite_titles"),
  prerequisiteNodeIds: text("prerequisite_node_ids"),
  nextRecommendedTitles: text("next_recommended_titles"),
  nextRecommendedNodeIds: text("next_recommended_node_ids"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCanonicalNodeSchema = createInsertSchema(canonicalNodesTable);
export type InsertCanonicalNode = z.infer<typeof insertCanonicalNodeSchema>;
export type CanonicalNode = typeof canonicalNodesTable.$inferSelect;
