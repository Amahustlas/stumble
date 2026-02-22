import { useEffect, useState } from "react";
import AppsOutlinedIcon from "@mui/icons-material/AppsOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import StarBorderOutlinedIcon from "@mui/icons-material/StarBorderOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import type { Collection } from "../lib/db";
import type { CollectionTreeNode } from "../lib/collections";
import CollectionTree from "./CollectionTree";

type SidebarProps = {
  collections: CollectionTreeNode[];
  tags: string[];
  selectedCollectionId: string | null;
  isItemDragActive?: boolean;
  onSelectCollection: (collectionId: string | null) => void;
  onCreateCollection: (parentId: string | null) => Promise<Collection | null>;
  onRenameCollection: (id: string, name: string) => Promise<boolean>;
  onDeleteCollection: (id: string, name: string) => void;
  collectionDropTargetId: string | null;
  collectionDropMode: "move" | "duplicate" | null;
  onCollectionDragOver: (collectionId: string, event: React.DragEvent<HTMLElement>) => void;
  onCollectionDragLeave: (collectionId: string, event: React.DragEvent<HTMLElement>) => void;
  onCollectionDrop: (collectionId: string, event: React.DragEvent<HTMLElement>) => void;
};

const menuItems = [
  { label: "All Items", icon: <AppsOutlinedIcon fontSize="inherit" /> },
  { label: "Recents", icon: <ScheduleOutlinedIcon fontSize="inherit" /> },
  { label: "Favorites", icon: <StarBorderOutlinedIcon fontSize="inherit" /> },
  { label: "Archive", icon: <Inventory2OutlinedIcon fontSize="inherit" /> },
  { label: "Trash", icon: <DeleteOutlineOutlinedIcon fontSize="inherit" /> },
];

function Sidebar({
  collections,
  tags,
  selectedCollectionId,
  isItemDragActive = false,
  onSelectCollection,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  collectionDropTargetId,
  collectionDropMode,
  onCollectionDragOver,
  onCollectionDragLeave,
  onCollectionDrop,
}: SidebarProps) {
  const [activeMenu, setActiveMenu] = useState("All Items");
  const [showTags, setShowTags] = useState(true);

  useEffect(() => {
    if (selectedCollectionId !== null && activeMenu !== "") {
      setActiveMenu("");
      return;
    }
    if (selectedCollectionId === null && activeMenu === "") {
      setActiveMenu("All Items");
    }
  }, [selectedCollectionId, activeMenu]);

  const handleMenuClick = (menuLabel: string) => {
    setActiveMenu(menuLabel);
    if (menuLabel === "All Items") {
      onSelectCollection(null);
    }
  };

  const resolveCollectionDropTargetId = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) {
      return null;
    }
    const row = target.closest<HTMLElement>("[data-collection-drop-id]");
    return row?.dataset.collectionDropId ?? null;
  };

  return (
    <aside
      className={`sidebar ${isItemDragActive ? "drag-active" : ""}`}
      onDragEnter={(event) => {
        const collectionId = resolveCollectionDropTargetId(event.target);
        if (!collectionId) {
          return;
        }
        console.log("[dnd][sidebar][fallback][dragenter]", { targetCollectionId: collectionId });
      }}
      onDragOver={(event) => {
        const collectionId = resolveCollectionDropTargetId(event.target);
        if (!collectionId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        console.log("[dnd][sidebar][fallback][dragover]", {
          targetCollectionId: collectionId,
          altKey: event.altKey,
        });
        onCollectionDragOver(collectionId, event);
      }}
      onDrop={(event) => {
        const collectionId = resolveCollectionDropTargetId(event.target);
        if (!collectionId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        console.log("[dnd][sidebar][fallback][drop]", {
          targetCollectionId: collectionId,
          types: Array.from(event.dataTransfer.types ?? []),
        });
        onCollectionDrop(collectionId, event);
      }}
    >
      <h1 className="sidebar-title">Stumble</h1>

      <div className="sidebar-section">
        <h2 className="sidebar-heading">Menu</h2>
        <ul className="sidebar-list">
          {menuItems.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                className={`sidebar-nav-item ${activeMenu === item.label ? "active" : ""}`}
                onClick={() => handleMenuClick(item.label)}
              >
                <span className="menu-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <CollectionTree
        nodes={collections}
        selectedCollectionId={selectedCollectionId}
        onSelectCollection={(id) => {
          setActiveMenu("");
          onSelectCollection(id);
        }}
        onCreateCollection={onCreateCollection}
        onRenameCollection={onRenameCollection}
        onDeleteCollection={onDeleteCollection}
        collectionDropTargetId={collectionDropTargetId}
        collectionDropMode={collectionDropMode}
        onCollectionDragOver={onCollectionDragOver}
        onCollectionDragLeave={onCollectionDragLeave}
        onCollectionDrop={onCollectionDrop}
      />

      <div className="sidebar-section">
        <button
          type="button"
          className="sidebar-heading heading-toggle"
          onClick={() => setShowTags((current) => !current)}
        >
          Tags {showTags ? "v" : ">"}
        </button>
        {showTags && (
          <div className="tag-list">
            {tags.map((tag) => (
              <button key={tag} type="button" className="tag-chip">
                #{tag}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

export default Sidebar;
