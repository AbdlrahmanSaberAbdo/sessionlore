import type { BrowseFilter, HarnessId, MindMap, MindMapNode } from "@sessionlore/core";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useMemo, useState } from "react";
import { FilterBar, harnessName, plural } from "../components/filters.js";
import { initiallyCollapsed, layoutMindMap, NODE_HEIGHT, NODE_WIDTH, type PlacedNode } from "../mind-map-layout.js";
import { filterQuery, Link, suggestionPath } from "../router.js";

/**
 * Projects → Workflows → Tasks → Sessions as a graph, with Suggestions beside
 * their Workflow and nodes coloured by Harness. Clicking a node shows its
 * details; Projects and Workflows can be collapsed.
 */
export function MindMapScreen({
  map,
  filter,
  initialSelected,
  initialCollapsed,
}: {
  map: MindMap;
  filter: BrowseFilter;
  initialSelected?: string;
  initialCollapsed?: string[];
}) {
  const [selected, setSelected] = useState<string | undefined>(initialSelected);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initialCollapsed ?? initiallyCollapsed(map)));
  const layout = useMemo(() => layoutMindMap(map, collapsed), [map, collapsed]);
  const placed = layout.nodes.find((n) => n.node.id === selected);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const collapseAll = (kind: MindMapNode["kind"] | null) =>
    setCollapsed(new Set(kind ? map.nodes.filter((n) => n.kind === kind).map((n) => n.id) : []));

  const nodes = useMemo(
    (): Node<{ placed: PlacedNode }>[] =>
      layout.nodes.map((p) => ({
        id: p.node.id,
        type: "mind",
        position: { x: p.x, y: p.y },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: { placed: p },
        selected: p.node.id === selected,
      })),
    [layout, selected],
  );
  const edges = useMemo(
    (): Edge[] => layout.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    [layout],
  );
  const harnesses = [...new Set(map.nodes.flatMap((n) => n.harnesses))].sort();

  return (
    <>
      <h1>Mind map</h1>
      <FilterBar filter={filter} options={map.filters} />
      {map.nodes.length === 0 ? (
        <p className="muted">No Workflows{filterQuery(filter) ? " match these filters" : " yet"}.</p>
      ) : (
        <>
          <div className="mind-toolbar">
            <div className="legend" aria-label="Harness colours">
              {harnesses.map((h) => (
                <span key={h} className={`legend-item harness-${h}`}>
                  {harnessName(h)}
                </span>
              ))}
              {harnesses.length > 1 ? <span className="legend-item harness-mixed">Several Harnesses</span> : null}
            </div>
            <span className="muted small">{plural(layout.nodes.length, "node")} shown</span>
            <button type="button" onClick={() => collapseAll("workflow")}>
              Collapse Workflows
            </button>
            <button type="button" onClick={() => collapseAll(null)}>
              Expand all
            </button>
          </div>
          <div className="mind-layout">
            <div className="mind-map">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodeClick={(_, node) => setSelected(node.id)}
                  onNodeDoubleClick={(_, node) => toggle(node.id)}
                  onPaneClick={() => setSelected(undefined)}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  onlyRenderVisibleElements={layout.nodes.length > 100}
                  minZoom={0.1}
                  fitView
                  colorMode="system"
                  width={1000}
                  height={600}
                >
                  <Background />
                  <Controls showInteractive={false} />
                  <MiniMap pannable zoomable nodeClassName={(n) => harnessClass((n.data as { placed: PlacedNode }).placed.node.harnesses)} />
                </ReactFlow>
            </div>
            <aside className="mind-details panel" aria-label="Details">
              {placed ? (
                <Details placed={placed} filter={filter} onToggle={() => toggle(placed.node.id)} />
              ) : (
                <p className="muted">Click a node to see its details. Double-click a Project or Workflow to collapse it.</p>
              )}
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function harnessClass(harnesses: HarnessId[]): string {
  return harnesses.length === 1 ? `harness-${harnesses[0]}` : "harness-mixed";
}

function MindNode({ data }: NodeProps<Node<{ placed: PlacedNode }>>) {
  const { node, hidden } = data.placed;
  return (
    <div className={`mind-node ${node.kind} ${harnessClass(node.harnesses)}`} title={node.label}>
      {node.kind !== "project" ? <Handle type="target" position={Position.Left} isConnectable={false} /> : null}
      <span className="mind-kind">{kindName[node.kind]}</span>
      <span className="mind-label">{node.label}</span>
      {hidden > 0 ? <span className="mind-hidden">+{hidden} hidden</span> : null}
      {node.kind !== "session" ? <Handle type="source" position={Position.Right} isConnectable={false} /> : null}
    </div>
  );
}

// Defined once, outside any component, as React Flow asks.
const nodeTypes = { mind: MindNode };

const kindName: Record<MindMapNode["kind"], string> = {
  project: "Project",
  workflow: "Workflow",
  task: "Task",
  session: "Session",
  suggestion: "Suggestion",
};

function Details({ placed, filter, onToggle }: { placed: PlacedNode; filter: BrowseFilter; onToggle: () => void }) {
  const { node } = placed;
  return (
    <>
      <p className="muted small">{kindName[node.kind]}</p>
      <h2>{node.label}</h2>
      <p className="muted">{node.harnesses.map(harnessName).join(", ")}</p>
      <NodeFacts node={node} filter={filter} />
      {placed.collapsible ? (
        <button type="button" onClick={onToggle}>
          {placed.collapsed ? "Expand" : "Collapse"}
        </button>
      ) : null}
    </>
  );
}

function NodeFacts({ node, filter }: { node: MindMapNode; filter: BrowseFilter }) {
  switch (node.kind) {
    case "project":
      return <p className="small">{node.path}</p>;
    case "workflow":
      return (
        <>
          <p>
            {plural(node.tasks, "Task")} in {plural(node.sessions, "Session")} ·{" "}
            {node.correctionsPerTask === null ? "–" : node.correctionsPerTask.toFixed(2)} Corrections per Task
          </p>
          <Link href={`/workflows/${node.workflow}${filterQuery(filter)}`}>Open Workflow</Link>
        </>
      );
    case "task":
      return (
        <>
          <p>
            Started {node.at.slice(0, 10)} · {plural(node.corrections, "Correction")}
          </p>
          <Link href={`/sessions/${encodeURIComponent(node.session)}#task-${node.position}`}>Open in its Session</Link>
        </>
      );
    case "session":
      return (
        <>
          <p>
            {node.project?.name ?? "No Project"} · started {node.startedAt.slice(0, 16).replace("T", " ")}
          </p>
          <Link href={`/sessions/${encodeURIComponent(node.session)}`}>Open Session</Link>
        </>
      );
    case "suggestion":
      return (
        <>
          <p>
            Skill Suggestion <span className={`state ${node.state.toLowerCase()}`}>{node.state}</span>
          </p>
          <Link href={suggestionPath(node.suggestion)}>{node.state === "Pending" ? "Review it" : "Open Suggestion"}</Link>
        </>
      );
  }
}
