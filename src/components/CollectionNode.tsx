import { useEffect, useRef } from "react";
import AddIcon from "@mui/icons-material/Add";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import type { CollectionTreeNode } from "../lib/collections";

type CollectionNodeProps = {
  node: CollectionTreeNode;
  depth: number;
  expandedIds: Set<string>;
  selectedCollectionId: string | null;
  editingCollectionId: string | null;
  editingName: string;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string) => void;
  onCreateChild: (parentId: string) => void;
  onDelete: (id: string, name: string) => void;
  onStartRename: (id: string, currentName: string) => void;
  onEditNameChange: (value: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
};

function renderCollectionIcon(icon: string) {
  switch (icon) {
    case "folder":
    default:
      return <FolderOutlinedIcon fontSize="inherit" />;
  }
}

function CollectionNode({
  node,
  depth,
  expandedIds,
  selectedCollectionId,
  editingCollectionId,
  editingName,
  onToggleExpand,
  onSelect,
  onCreateChild,
  onDelete,
  onStartRename,
  onEditNameChange,
  onConfirmRename,
  onCancelRename,
}: CollectionNodeProps) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedIds.has(node.collection.id);
  const isSelected = selectedCollectionId === node.collection.id;
  const isEditing = editingCollectionId === node.collection.id;
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [isEditing]);

  return (
    <li className="collection-node">
      <div
        className={`collection-row ${isSelected ? "active" : ""}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <button
          type="button"
          className={`tree-toggle ${hasChildren ? "" : "ghost"}`}
          onClick={() => {
            if (hasChildren) {
              onToggleExpand(node.collection.id);
            }
          }}
          aria-label={isExpanded ? "Collapse collection" : "Expand collection"}
        >
          {hasChildren ? (
            isExpanded ? (
              <ExpandMoreIcon fontSize="inherit" />
            ) : (
              <ChevronRightIcon fontSize="inherit" />
            )
          ) : null}
        </button>
        <button
          type="button"
          className="collection-select"
          onClick={() => onSelect(node.collection.id)}
        >
          <span className="collection-node-icon" aria-hidden="true">
            {renderCollectionIcon(node.collection.icon || "folder")}
          </span>
          {isEditing ? (
            <input
              ref={nameInputRef}
              className="collection-rename-input"
              value={editingName}
              onChange={(event) => onEditNameChange(event.currentTarget.value)}
              onBlur={() => onConfirmRename()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onConfirmRename();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelRename();
                }
              }}
            />
          ) : (
            <span
              className="collection-name"
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onStartRename(node.collection.id, node.collection.name);
              }}
            >
              {node.collection.name}
            </span>
          )}
        </button>
        <div className="collection-row-actions collection-actions">
          <button
            type="button"
            className="collection-action-button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCreateChild(node.collection.id);
            }}
            aria-label={`Create child collection under ${node.collection.name}`}
          >
            <AddIcon fontSize="inherit" />
          </button>
          <button
            type="button"
            className="collection-action-button danger"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDelete(node.collection.id, node.collection.name);
            }}
            aria-label={`Delete collection ${node.collection.name}`}
          >
            <DeleteOutlineIcon fontSize="inherit" />
          </button>
        </div>
      </div>
      {hasChildren && isExpanded && (
        <ul className="collection-tree-list">
          {node.children.map((childNode) => (
            <CollectionNode
              key={childNode.collection.id}
              node={childNode}
              depth={depth + 1}
              expandedIds={expandedIds}
              selectedCollectionId={selectedCollectionId}
              editingCollectionId={editingCollectionId}
              editingName={editingName}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              onDelete={onDelete}
              onStartRename={onStartRename}
              onEditNameChange={onEditNameChange}
              onConfirmRename={onConfirmRename}
              onCancelRename={onCancelRename}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default CollectionNode;
