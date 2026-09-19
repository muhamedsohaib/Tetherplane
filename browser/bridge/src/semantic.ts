import { createHash } from "node:crypto";

import type { SemanticReference } from "./index.ts";

export type BackendSemanticNode = {
  backend_id: string;
  role: string;
  accessible_name: string;
  ancestry?: Array<{
    role: string;
    accessible_name: string;
  }>;
  document_id: string;
  frame_id: string;
  value?: string | undefined;
  description?: string | undefined;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  sensitive?: boolean;
  hidden?: boolean;
};

export type SnapshotSemanticNode = {
  ref: SemanticReference;
  role: string;
  accessible_name: string;
  ancestry: Array<{
    role: string;
    accessible_name: string;
  }>;
  document_id: string;
  frame_id: string;
  value?: string | undefined;
  description?: string | undefined;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
};

export type BrowserSemanticSnapshot = {
  revision: number;
  nodes: SnapshotSemanticNode[];
  truncated: boolean;
  omitted_nodes: number;
};

export class StaleReferenceError extends Error {
  readonly code = "stale_reference" as const;
  readonly match_count: number;

  constructor(message: string, matchCount: number) {
    super(message);
    this.name = "StaleReferenceError";
    this.match_count = matchCount;
  }
}

export class SemanticSnapshotEngine {
  snapshot(
    backendNodes: BackendSemanticNode[],
    options: {
      revision: number;
      max_nodes?: number;
    },
  ): BrowserSemanticSnapshot {
    const maxNodes = normalizeMaxNodes(options.max_nodes);
    const visible = backendNodes.filter((node) => !node.hidden);
    const selected = visible.slice(0, maxNodes);
    const occurrenceBySignature = new Map<string, number>();

    const nodes = selected.map((node) => {
      const ancestry = normalizedAncestry(node);
      const signature = semanticSignature({
        role: node.role,
        accessible_name: node.accessible_name,
        ancestry,
        document_id: node.document_id,
        frame_id: node.frame_id,
      });
      const occurrence = (occurrenceBySignature.get(signature) ?? 0) + 1;
      occurrenceBySignature.set(signature, occurrence);

      const ref: SemanticReference = {
        ref_id: `ref_${signature}_${occurrence}`,
        role: node.role,
        accessible_name: node.accessible_name,
        ancestry,
        document_id: node.document_id,
        frame_id: node.frame_id,
        snapshot_revision: options.revision,
      };

      const snapshotNode: SnapshotSemanticNode = {
        ref,
        role: node.role,
        accessible_name: node.accessible_name,
        ancestry,
        document_id: node.document_id,
        frame_id: node.frame_id,
      };

      if (!node.sensitive && node.value !== undefined) {
        snapshotNode.value = node.value;
      }
      if (!node.sensitive && node.description !== undefined) {
        snapshotNode.description = node.description;
      }
      if (node.disabled !== undefined) {
        snapshotNode.disabled = node.disabled;
      }
      if (node.checked !== undefined) {
        snapshotNode.checked = node.checked;
      }
      if (node.selected !== undefined) {
        snapshotNode.selected = node.selected;
      }

      return snapshotNode;
    });

    return {
      revision: options.revision,
      nodes,
      truncated: visible.length > nodes.length,
      omitted_nodes: Math.max(0, visible.length - nodes.length),
    };
  }

  reacquire(
    reference: SemanticReference,
    backendNodes: BackendSemanticNode[],
  ): BackendSemanticNode {
    const matches = backendNodes.filter(
      (node) =>
        !node.hidden &&
        node.role === reference.role &&
        node.accessible_name === reference.accessible_name &&
        node.document_id === reference.document_id &&
        node.frame_id === reference.frame_id &&
        ancestryEqual(normalizedAncestry(node), reference.ancestry),
    );

    if (matches.length !== 1) {
      throw new StaleReferenceError(
        matches.length === 0
          ? "semantic reference could not be reacquired"
          : "semantic reference became ambiguous after rerender",
        matches.length,
      );
    }

    return structuredClone(matches[0]!);
  }
}

function normalizeMaxNodes(value: number | undefined): number {
  if (value === undefined) {
    return 200;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError("max_nodes must be a positive integer");
  }
  return Math.min(value, 2_000);
}

function normalizedAncestry(
  node: BackendSemanticNode,
): Array<{ role: string; accessible_name: string }> {
  return (node.ancestry ?? []).map((ancestor) => ({
    role: ancestor.role,
    accessible_name: ancestor.accessible_name,
  }));
}

function ancestryEqual(
  left: Array<{ role: string; accessible_name: string }>,
  right: Array<{ role: string; accessible_name: string }>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every(
    (item, index) =>
      item.role === right[index]?.role &&
      item.accessible_name === right[index]?.accessible_name,
  );
}

function semanticSignature(input: {
  role: string;
  accessible_name: string;
  ancestry: Array<{ role: string; accessible_name: string }>;
  document_id: string;
  frame_id: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 20);
}
