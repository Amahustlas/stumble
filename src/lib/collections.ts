import type { Collection } from "./db";

export type CollectionTreeNode = {
  collection: Collection;
  children: CollectionTreeNode[];
};

export function buildCollectionTree(collections: Collection[]): CollectionTreeNode[] {
  const byId = new Map<
    string,
    {
      node: CollectionTreeNode;
      parentId: string | null;
      createdAt: number;
    }
  >();

  collections.forEach((collection) => {
    byId.set(collection.id, {
      node: {
        collection,
        children: [],
      },
      parentId: collection.parentId ?? null,
      createdAt: collection.createdAt,
    });
  });

  const roots: Array<{ node: CollectionTreeNode; createdAt: number }> = [];

  byId.forEach(({ node, parentId, createdAt }) => {
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.node.children.push(node);
      return;
    }
    roots.push({ node, createdAt });
  });

  const sortNodes = (nodes: CollectionTreeNode[]) => {
    nodes.sort((a, b) => a.collection.name.localeCompare(b.collection.name));
    nodes.forEach((node) => {
      if (node.children.length > 0) {
        sortNodes(node.children);
      }
    });
  };

  const rootNodes = roots.map((entry) => entry.node);
  sortNodes(rootNodes);

  return roots
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((entry) => entry.node);
}

export function buildCollectionPathMap(collections: Collection[]): Map<string, string> {
  const byId = new Map(collections.map((collection) => [collection.id, collection]));
  const cache = new Map<string, string>();

  const resolvePath = (id: string, seen: Set<string>): string => {
    const cached = cache.get(id);
    if (cached) return cached;

    const collection = byId.get(id);
    if (!collection) return "All Items";

    const parentId = collection.parentId ?? null;
    if (!parentId || !byId.has(parentId) || seen.has(id)) {
      cache.set(id, collection.name);
      return collection.name;
    }

    seen.add(id);
    const parentPath = resolvePath(parentId, seen);
    const fullPath = `${parentPath}/${collection.name}`;
    cache.set(id, fullPath);
    return fullPath;
  };

  collections.forEach((collection) => {
    resolvePath(collection.id, new Set<string>());
  });

  return cache;
}

export function collectCollectionSubtreeIds(
  collections: Collection[],
  rootCollectionId: string,
): Set<string> {
  const childrenByParentId = new Map<string, string[]>();

  collections.forEach((collection) => {
    const parentId = collection.parentId ?? null;
    if (!parentId) return;
    const siblingIds = childrenByParentId.get(parentId);
    if (siblingIds) {
      siblingIds.push(collection.id);
    } else {
      childrenByParentId.set(parentId, [collection.id]);
    }
  });

  const subtreeIds = new Set<string>();
  const stack = [rootCollectionId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (subtreeIds.has(currentId)) continue;
    subtreeIds.add(currentId);
    const childIds = childrenByParentId.get(currentId) ?? [];
    childIds.forEach((childId) => stack.push(childId));
  }

  return subtreeIds;
}
