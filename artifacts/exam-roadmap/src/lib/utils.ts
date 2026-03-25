import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Node } from "@workspace/api-client-react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type TreeNode = Node & { children: TreeNode[] };

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

  return roots;
}
