import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const nodesTable = pgTable("nodes", {
  id: text("id").primaryKey(),
  configId: text("config_id").notNull(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  parentId: text("parent_id"),
  explanation: text("explanation"),
  learningGoal: text("learning_goal"),
  exampleBlock: text("example_block"),
  supportNote: text("support_note"),
  prerequisiteTitles: text("prerequisite_titles"),
  prerequisiteNodeIds: text("prerequisite_node_ids"),
  nextRecommendedTitles: text("next_recommended_titles"),
  nextRecommendedNodeIds: text("next_recommended_node_ids"),
  unitTopicId: text("unit_topic_id"),
  unitSubtopicId: text("unit_subtopic_id"),
  sortOrder: text("sort_order").notNull().default("0"),
});

export const insertNodeSchema = createInsertSchema(nodesTable);
export type InsertNode = z.infer<typeof insertNodeSchema>;
export type Node = typeof nodesTable.$inferSelect;
