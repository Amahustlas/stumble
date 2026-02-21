import { useEffect, useState } from "react";
import AppsOutlinedIcon from "@mui/icons-material/AppsOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import StarBorderOutlinedIcon from "@mui/icons-material/StarBorderOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import type { CollectionNode } from "../App";

type SidebarProps = {
  collections: CollectionNode[];
  tags: string[];
  activeCollectionId: string | null;
  onSelectCollection: (collectionId: string | null) => void;
};

type CollectionTreeItemProps = {
  node: CollectionNode;
  level: number;
  expandedIds: Set<string>;
  activeCollectionId: string | null;
  onToggleExpand: (id: string) => void;
  onSelectCollection: (id: string) => void;
};

const menuItems = [
  { label: "All Items", icon: <AppsOutlinedIcon fontSize="inherit" /> },
  { label: "Recents", icon: <ScheduleOutlinedIcon fontSize="inherit" /> },
  { label: "Favorites", icon: <StarBorderOutlinedIcon fontSize="inherit" /> },
  { label: "Archive", icon: <Inventory2OutlinedIcon fontSize="inherit" /> },
  { label: "Trash", icon: <DeleteOutlineOutlinedIcon fontSize="inherit" /> },
];

function CollectionTreeItem({
  node,
  level,
  expandedIds,
  activeCollectionId,
  onToggleExpand,
  onSelectCollection,
}: CollectionTreeItemProps) {
  const hasChildren = Boolean(node.children?.length);
  const isExpanded = expandedIds.has(node.id);

  return (
    <li className="collection-node">
      <div
        className={`collection-row ${activeCollectionId === node.id ? "active" : ""}`}
        style={{ paddingLeft: `${8 + level * 14}px` }}
      >
        <button
          type="button"
          className={`tree-toggle ${hasChildren ? "" : "ghost"}`}
          onClick={() => hasChildren && onToggleExpand(node.id)}
          aria-label={isExpanded ? "Collapse collection" : "Expand collection"}
        >
          {hasChildren ? (isExpanded ? "v" : ">") : ""}
        </button>
        <button
          type="button"
          className="collection-select"
          onClick={() => onSelectCollection(node.id)}
        >
          <span className="collection-node-icon" aria-hidden="true">
            #
          </span>
          <span
            className="collection-color"
            style={{ backgroundColor: node.color }}
            aria-hidden="true"
          />
          <span>{node.name}</span>
        </button>
      </div>

      {hasChildren && isExpanded && (
        <ul className="collection-tree-list">
          {node.children!.map((child) => (
            <CollectionTreeItem
              key={child.id}
              node={child}
              level={level + 1}
              expandedIds={expandedIds}
              activeCollectionId={activeCollectionId}
              onToggleExpand={onToggleExpand}
              onSelectCollection={onSelectCollection}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Sidebar({
  collections,
  tags,
  activeCollectionId,
  onSelectCollection,
}: SidebarProps) {
  const [activeMenu, setActiveMenu] = useState("All Items");
  const [expandedIds, setExpandedIds] = useState(
    new Set<string>(collections.map((collection) => collection.id)),
  );
  const [showTags, setShowTags] = useState(true);

  useEffect(() => {
    setExpandedIds(new Set(collections.map((collection) => collection.id)));
  }, [collections]);

  const handleMenuClick = (menuLabel: string) => {
    setActiveMenu(menuLabel);
    if (menuLabel === "All Items") {
      onSelectCollection(null);
    }
  };

  const handleToggleExpand = (id: string) => {
    setExpandedIds((currentExpandedIds) => {
      const next = new Set(currentExpandedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <aside className="sidebar">
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

      <div className="sidebar-section">
        <h2 className="sidebar-heading">Collections</h2>
        <ul className="collection-tree-list">
          {collections.map((collection) => (
            <CollectionTreeItem
              key={collection.id}
              node={collection}
              level={0}
              expandedIds={expandedIds}
              activeCollectionId={activeCollectionId}
              onToggleExpand={handleToggleExpand}
              onSelectCollection={onSelectCollection}
            />
          ))}
        </ul>
      </div>

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
