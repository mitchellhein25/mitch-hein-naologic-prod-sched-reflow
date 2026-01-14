# DAG Implementation for Dependencies

This document explains how a Directed Acyclic Graph (DAG) approach would work for implementing dependency resolution in the reflow service, from building the graph to traversing it.

## 1. Building the DAG

The first step is to construct the graph from work orders and their dependency relationships:

```typescript
interface DAGNode {
  workOrder: WorkOrderDocument;
  dependencies: DAGNode[];  // Nodes this depends on (incoming edges)
  dependents: DAGNode[];    // Nodes that depend on this (outgoing edges)
  inDegree: number;         // Number of incoming edges
}

function buildDAG(workOrders: WorkOrderDocument[]): Map<string, DAGNode> {
  // Step 1: Create nodes for all work orders
  const nodeMap = new Map<string, DAGNode>();
  
  for (const wo of workOrders) {
    nodeMap.set(wo.docId, {
      workOrder: wo,
      dependencies: [],
      dependents: [],
      inDegree: 0
    });
  }
  
  // Step 2: Build edges based on dependsOnWorkOrderIds
  for (const wo of workOrders) {
    const node = nodeMap.get(wo.docId)!;
    const dependsOnIds = wo.data.dependsOnWorkOrderIds || [];
    
    for (const depId of dependsOnIds) {
      const depNode = nodeMap.get(depId);
      if (depNode) {
        // Add edge: depNode -> node (dependency must finish before this starts)
        node.dependencies.push(depNode);
        depNode.dependents.push(node);
        node.inDegree++;
      }
    }
  }
  
  return nodeMap;
}
```

### Example: Building the Graph

For a simple linear chain (`wo-001 → wo-002 → wo-003`):
- `wo-001`: no dependencies (inDegree = 0)
- `wo-002`: depends on `wo-001` (inDegree = 1)
- `wo-003`: depends on `wo-002` (inDegree = 1)

For multiple dependencies (`wo-012` depends on `wo-010` and `wo-011`):
- `wo-010`: no dependencies (inDegree = 0)
- `wo-011`: no dependencies (inDegree = 0)
- `wo-012`: depends on `wo-010` and `wo-011` (inDegree = 2)

## 2. Topological Sort (Kahn's Algorithm)

Topological sorting gives us the correct order to process nodes so that all dependencies are handled before their dependents:

```typescript
function topologicalSort(nodeMap: Map<string, DAGNode>): DAGNode[] {
  const sorted: DAGNode[] = [];
  const queue: DAGNode[] = [];
  
  // Step 1: Find all nodes with no dependencies (inDegree = 0)
  for (const node of nodeMap.values()) {
    if (node.inDegree === 0) {
      queue.push(node);
    }
  }
  
  // Step 2: Process nodes level by level
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    
    // Step 3: For each dependent, decrement inDegree
    // When inDegree reaches 0, add to queue
    for (const dependent of current.dependents) {
      dependent.inDegree--;
      if (dependent.inDegree === 0) {
        queue.push(dependent);
      }
    }
  }
  
  // Step 4: Check for cycles (if sorted.length < nodeMap.size, there's a cycle)
  if (sorted.length < nodeMap.size) {
    throw new Error("Circular dependency detected!");
  }
  
  return sorted;
}
```

### How It Works

**For a linear chain (`wo-001 → wo-002 → wo-003`):**

1. **Initial state:**
   - `wo-001`: inDegree = 0 → add to queue
   - `wo-002`: inDegree = 1
   - `wo-003`: inDegree = 1

2. **Process `wo-001`:**
   - Remove from queue, add to sorted
   - Process `wo-001`'s dependents (`wo-002`)
   - `wo-002`.inDegree becomes 0 → add to queue

3. **Process `wo-002`:**
   - Remove from queue, add to sorted
   - Process `wo-002`'s dependents (`wo-003`)
   - `wo-003`.inDegree becomes 0 → add to queue

4. **Process `wo-003`:**
   - Remove from queue, add to sorted
   - No dependents, done

**Result:** `[wo-001, wo-002, wo-003]` - perfect processing order!

**For multiple dependencies (`wo-012` depends on `wo-010`, `wo-011`):**

1. **Initial state:**
   - `wo-010`: inDegree = 0 → add to queue
   - `wo-011`: inDegree = 0 → add to queue
   - `wo-012`: inDegree = 2

2. **Process `wo-010`:**
   - Remove from queue, add to sorted
   - Process `wo-010`'s dependents (`wo-012`)
   - `wo-012`.inDegree becomes 1 (still waiting on `wo-011`)

3. **Process `wo-011`:**
   - Remove from queue, add to sorted
   - Process `wo-011`'s dependents (`wo-012`)
   - `wo-012`.inDegree becomes 0 → add to queue

4. **Process `wo-012`:**
   - Remove from queue, add to sorted
   - Done

**Result:** `[wo-010, wo-011, wo-012]` or `[wo-011, wo-010, wo-012]` (order of independent nodes doesn't matter)

## 3. Traversing and Resolving Dependencies

Once we have the topological order, we can process nodes in a single pass:

```typescript
function resolveDependenciesWithDAG(
  workOrders: WorkOrderDocument[],
  workCentersMap: Map<string, WorkCenterDocument>
): void {
  // Build the DAG
  const nodeMap = buildDAG(workOrders);
  
  // Get topological order
  const sortedNodes = topologicalSort(nodeMap);
  
  // Process in topological order - guarantees dependencies are processed first
  for (const node of sortedNodes) {
    // Process the node
  }
}
```