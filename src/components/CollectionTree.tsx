import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import type { Collection } from "../lib/db";
import type { CollectionTreeNode } from "../lib/collections";
import CollectionNode from "./CollectionNode";

type CollectionTreeProps = {
  nodes: CollectionTreeNode[];
  selectedCollectionId: string | null;
  onSelectCollection: (id: string) => void;
  onCreateCollection: (parentId: string | null) => Promise<Collection | null>;
  onRenameCollection: (id: string, name: string) => Promise<boolean>;
  onDeleteCollection: (id: string, name: string) => void;
};

type CollectionSnapshot = {
  name: string;
  hasChildren: boolean;
};

function flattenNodes(nodes: CollectionTreeNode[]): Map<string, CollectionSnapshot> {
  const snapshotById = new Map<string, CollectionSnapshot>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    snapshotById.set(node.collection.id, {
      name: node.collection.name,
      hasChildren: node.children.length > 0,
    });
    node.children.forEach((child) => stack.push(child));
  }

  return snapshotById;
}

function CollectionTree({
  nodes,
  selectedCollectionId,
  onSelectCollection,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
}: CollectionTreeProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const isRenameCommitPendingRef = useRef(false);

  const collectionSnapshotById = useMemo(() => flattenNodes(nodes), [nodes]);

  useEffect(() => {
    setExpandedIds((currentExpandedIds) => {
      const nextExpandedIds = new Set<string>();
      currentExpandedIds.forEach((expandedId) => {
        if (collectionSnapshotById.get(expandedId)?.hasChildren) {
          nextExpandedIds.add(expandedId);
        }
      });
      if (currentExpandedIds.size === 0) {
        nodes.forEach((node) => {
          if (node.children.length > 0) {
            nextExpandedIds.add(node.collection.id);
          }
        });
      }
      return nextExpandedIds;
    });

    if (editingCollectionId && !collectionSnapshotById.has(editingCollectionId)) {
      setEditingCollectionId(null);
      setEditingName("");
    }
  }, [nodes, collectionSnapshotById, editingCollectionId]);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((currentExpandedIds) => {
      const nextExpandedIds = new Set(currentExpandedIds);
      if (nextExpandedIds.has(id)) {
        nextExpandedIds.delete(id);
      } else {
        nextExpandedIds.add(id);
      }
      return nextExpandedIds;
    });
  }, []);

  const handleCreateCollection = useCallback(
    (parentId: string | null) => {
      void (async () => {
        try {
          const createdCollection = await onCreateCollection(parentId);
          if (!createdCollection) {
            return;
          }

          if (parentId) {
            setExpandedIds((currentExpandedIds) => {
              const nextExpandedIds = new Set(currentExpandedIds);
              nextExpandedIds.add(parentId);
              return nextExpandedIds;
            });
          }

          setEditingCollectionId(createdCollection.id);
          setEditingName(createdCollection.name);
        } catch (error) {
          console.error("Failed to create collection from tree:", error);
        }
      })();
    },
    [onCreateCollection],
  );

  const handleStartRename = useCallback((id: string, currentName: string) => {
    setEditingCollectionId(id);
    setEditingName(currentName);
  }, []);

  const handleCancelRename = useCallback(() => {
    if (isRenameCommitPendingRef.current) {
      return;
    }
    setEditingCollectionId(null);
    setEditingName("");
  }, []);

  const handleConfirmRename = useCallback(() => {
    if (isRenameCommitPendingRef.current) {
      return;
    }

    const targetCollectionId = editingCollectionId;
    if (!targetCollectionId) {
      return;
    }

    const currentSnapshot = collectionSnapshotById.get(targetCollectionId);
    if (!currentSnapshot) {
      setEditingCollectionId(null);
      setEditingName("");
      return;
    }

    const trimmedName = editingName.trim();
    if (trimmedName.length === 0 || trimmedName === currentSnapshot.name) {
      setEditingCollectionId(null);
      setEditingName("");
      return;
    }

    isRenameCommitPendingRef.current = true;
    void onRenameCollection(targetCollectionId, trimmedName)
      .catch((error) => {
        console.error("Failed to rename collection from tree:", error);
      })
      .finally(() => {
        isRenameCommitPendingRef.current = false;
        setEditingCollectionId(null);
        setEditingName("");
      });
  }, [editingCollectionId, editingName, onRenameCollection, collectionSnapshotById]);

  const handleDeleteCollection = useCallback(
    (id: string, name: string) => {
      if (editingCollectionId === id) {
        setEditingCollectionId(null);
        setEditingName("");
      }
      onDeleteCollection(id, name);
    },
    [editingCollectionId, onDeleteCollection],
  );

  return (
    <div className="sidebar-section">
      <div className="sidebar-heading-row">
        <h2 className="sidebar-heading">Collections</h2>
        <button
          type="button"
          className="sidebar-heading-action"
          onClick={() => handleCreateCollection(null)}
          aria-label="Create top-level collection"
        >
          <AddIcon fontSize="inherit" />
        </button>
      </div>
      {nodes.length === 0 ? (
        <div className="collection-empty">No collections yet</div>
      ) : (
        <ul className="collection-tree-list">
          {nodes.map((node) => (
            <CollectionNode
              key={node.collection.id}
              node={node}
              depth={0}
              expandedIds={expandedIds}
              selectedCollectionId={selectedCollectionId}
              editingCollectionId={editingCollectionId}
              editingName={editingName}
              onToggleExpand={handleToggleExpand}
              onSelect={onSelectCollection}
              onCreateChild={(parentId) => handleCreateCollection(parentId)}
              onDelete={handleDeleteCollection}
              onStartRename={handleStartRename}
              onEditNameChange={setEditingName}
              onConfirmRename={handleConfirmRename}
              onCancelRename={handleCancelRename}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default CollectionTree;
