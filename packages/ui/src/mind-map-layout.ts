import type { MindMap, MindMapNode } from "@sessionlore/core";

/**
 * Lays the mind map out left to right, one column per level (Project,
 * Workflow, Task and Suggestion, Session), and works out which nodes a
 * collapse hides. React Flow has no layout of its own.
 */

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 44;
const COLUMN_WIDTH = 290;
const ROW_HEIGHT = 56;

const column: Record<MindMapNode["kind"], number> = { project: 0, workflow: 1, suggestion: 2, task: 2, session: 3 };

export interface PlacedNode {
  node: MindMapNode;
  x: number;
  y: number;
  /** Children that collapsing this node hides; 0 when it has none or is expanded. */
  hidden: number;
  /** Whether it has children a collapse would hide. */
  collapsible: boolean;
  collapsed: boolean;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: MindMap["edges"];
}

/** Suggestions stay beside their collapsed Workflow; collapsing hides the Workflows of a Project and the Tasks of a Workflow. */
const collapses = (child: MindMapNode) => child.kind !== "suggestion";

export function layoutMindMap(map: MindMap, collapsed: ReadonlySet<string>): Layout {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const children = new Map<string, MindMapNode[]>();
  const hasParent = new Set<string>();
  for (const e of map.edges) {
    const child = byId.get(e.target);
    if (!child || !byId.has(e.source)) continue;
    const siblings = children.get(e.source);
    if (siblings) siblings.push(child);
    else children.set(e.source, [child]);
    hasParent.add(e.target);
  }
  const shownChildren = (node: MindMapNode) =>
    (children.get(node.id) ?? []).filter((c) => !collapsed.has(node.id) || !collapses(c));

  const y = new Map<string, number>();
  let row = 0;
  const place = (node: MindMapNode): number => {
    const placed = y.get(node.id);
    if (placed !== undefined) return placed;
    y.set(node.id, -1); // Guards against a cycle; replaced below.
    const ys = shownChildren(node)
      .filter((c) => !y.has(c.id))
      .map(place);
    const own = ys.length > 0 ? (Math.min(...ys) + Math.max(...ys)) / 2 : row++ * ROW_HEIGHT;
    y.set(node.id, own);
    return own;
  };
  for (const root of map.nodes.filter((n) => !hasParent.has(n.id))) place(root);

  const nodes = map.nodes
    .filter((n) => y.has(n.id))
    .map((node): PlacedNode => {
      const collapsible = (children.get(node.id) ?? []).some(collapses);
      const isCollapsed = collapsible && collapsed.has(node.id);
      return {
        node,
        x: column[node.kind] * COLUMN_WIDTH,
        y: y.get(node.id)!,
        hidden: isCollapsed ? (children.get(node.id) ?? []).filter(collapses).length : 0,
        collapsible,
        collapsed: isCollapsed,
      };
    });
  const shown = new Set(nodes.map((n) => n.node.id));
  return { nodes, edges: map.edges.filter((e) => shown.has(e.source) && shown.has(e.target)) };
}

/** Above this many nodes the map opens with Workflows collapsed, so it starts readable. */
export const COLLAPSE_ABOVE = 150;

export function initiallyCollapsed(map: MindMap): string[] {
  return map.nodes.length > COLLAPSE_ABOVE ? map.nodes.filter((n) => n.kind === "workflow").map((n) => n.id) : [];
}
