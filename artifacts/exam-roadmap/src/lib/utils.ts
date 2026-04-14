import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Node } from "@/api-client";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type TreeNode = Node & { children: TreeNode[] };

function toNumericSortOrder(value: string | undefined): number {
  const n = Number(String(value || "").trim());
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function siblingFallbackSort(a: TreeNode, b: TreeNode): number {
  const bySortOrder = toNumericSortOrder(a.sortOrder) - toNumericSortOrder(b.sortOrder);
  if (bySortOrder !== 0) return bySortOrder;
  return String(a.title || "").localeCompare(String(b.title || ""));
}

function orderSiblingsByRecommendationChain(siblings: TreeNode[]): TreeNode[] {
  if (siblings.length <= 1) return siblings;

  const byId = new Map(siblings.map((s) => [s.id, s]));
  const hasSibling = (id: string | null | undefined) => !!id && byId.has(id);
  const sortedByFallback = [...siblings].sort(siblingFallbackSort);

  // Pick heads whose prerequisite is outside the sibling set (or absent), then walk next links.
  const heads = sortedByFallback.filter((node) => {
    const prereqId = node.prerequisiteNodeIds?.[0];
    return !hasSibling(prereqId);
  });

  const visited = new Set<string>();
  const ordered: TreeNode[] = [];

  const walkChain = (start: TreeNode) => {
    let current: TreeNode | undefined = start;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      ordered.push(current);
      const nextId = current.nextRecommendedNodeIds?.[0];
      current = hasSibling(nextId) ? byId.get(String(nextId)) : undefined;
    }
  };

  for (const head of heads) walkChain(head);
  for (const node of sortedByFallback) {
    if (!visited.has(node.id)) walkChain(node);
  }

  return ordered;
}

export function buildTree(nodes: Node[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // First pass: initialize all nodes in the map
  nodes.forEach(node => {
    map.set(node.id, { ...node, children: [] });
  });

  // Second pass: build the tree
  nodes.forEach(node => {
    const treeNode = map.get(node.id)!;
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(treeNode);
    } else {
      roots.push(treeNode);
    }
  });

  const sortRecursively = (list: TreeNode[]) => {
    const ordered = orderSiblingsByRecommendationChain(list);
    ordered.forEach((node, index) => {
      list[index] = node;
      if (node.children.length > 0) sortRecursively(node.children);
    });
  };

  sortRecursively(roots);

  return roots;
}

