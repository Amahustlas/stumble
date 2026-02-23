import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import AppsOutlinedIcon from "@mui/icons-material/AppsOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DriveFileRenameOutlineOutlinedIcon from "@mui/icons-material/DriveFileRenameOutlineOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FileCopyOutlinedIcon from "@mui/icons-material/FileCopyOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import PaletteOutlinedIcon from "@mui/icons-material/PaletteOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import StarBorderOutlinedIcon from "@mui/icons-material/StarBorderOutlined";
import type { Collection, Tag } from "../lib/db";
import type { CollectionTreeNode } from "../lib/collections";
import CollectionTree from "./CollectionTree";

type SidebarProps = {
  collections: CollectionTreeNode[];
  tags: Tag[];
  tagColorPalette: readonly string[];
  selectedCollectionId: string | null;
  selectedTagId: string | null;
  isItemDragActive?: boolean;
  onSelectCollection: (collectionId: string | null) => void;
  onSelectTag: (tagId: string | null) => void;
  onSelectMenuView?: (menuLabel: string) => void;
  onCreateCollection: (parentId: string | null) => Promise<Collection | null>;
  onRenameCollection: (id: string, name: string) => Promise<boolean>;
  onDeleteCollection: (id: string, name: string) => void;
  onCreateTag: () => Promise<Tag | null>;
  onRenameTag: (id: string, name: string) => Promise<boolean>;
  onDuplicateTag: (id: string) => Promise<Tag | null>;
  onUpdateTagColor: (id: string, color: string) => Promise<boolean>;
  onDeleteTag: (id: string) => void;
  onReorderTags: (orderedTagIds: string[]) => void | Promise<void>;
  onDropTagOnItem?: (itemId: string, tagId: string) => void | Promise<void>;
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

type TagMenuState = {
  open: boolean;
  x: number;
  y: number;
  tagId: string | null;
};

type TagDropTargetState = {
  tagId: string;
  position: "before" | "after";
} | null;

type PointerTagDragCandidate = {
  pointerId: number;
  tagId: string;
  startX: number;
  startY: number;
};

type ActiveTagPointerDrag = {
  pointerId: number;
  tagId: string;
  clientX: number;
  clientY: number;
};

const TAG_CONTEXT_MENU_WIDTH = 220;
const TAG_CONTEXT_MENU_HEIGHT = 248;

function sidebarTagDropTargetFromPoint(
  clientX: number,
  clientY: number,
  draggedTagId: string,
): TagDropTargetState {
  if (typeof document === "undefined") {
    return null;
  }

  const chips = Array.from(
    document.querySelectorAll<HTMLElement>("#sidebar-tags-list [data-tag-chip-id]"),
  );
  for (const chip of chips) {
    const tagId = chip.dataset.tagChipId;
    if (!tagId || tagId === draggedTagId) {
      continue;
    }
    const rect = chip.getBoundingClientRect();
    const withinX = clientX >= rect.left && clientX <= rect.right;
    const withinY = clientY >= rect.top && clientY <= rect.bottom;
    if (!withinX || !withinY) {
      continue;
    }
    return {
      tagId,
      position: clientX < rect.left + rect.width / 2 ? "before" : "after",
    };
  }
  return null;
}

function itemCardIdFromPoint(clientX: number, clientY: number): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>(".item-grid .item-card[data-item-id]"),
  );
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const withinX = clientX >= rect.left && clientX <= rect.right;
    const withinY = clientY >= rect.top && clientY <= rect.bottom;
    if (withinX && withinY) {
      return card.dataset.itemId ?? null;
    }
  }
  return null;
}

function nextSidebarTagFallbackName(tags: Tag[], editingTagId: string): string {
  const normalizedNames = new Set(
    tags
      .filter((tag) => tag.id !== editingTagId)
      .map((tag) => tag.name.trim().toLowerCase()),
  );
  if (!normalizedNames.has("new tag")) {
    return "New tag";
  }
  let suffix = 2;
  while (normalizedNames.has(`new tag ${suffix}`)) {
    suffix += 1;
  }
  return `New tag ${suffix}`;
}

function Sidebar({
  collections,
  tags,
  tagColorPalette,
  selectedCollectionId,
  selectedTagId,
  isItemDragActive = false,
  onSelectCollection,
  onSelectTag,
  onSelectMenuView,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onCreateTag,
  onRenameTag,
  onDuplicateTag,
  onUpdateTagColor,
  onDeleteTag,
  onReorderTags,
  onDropTagOnItem,
  collectionDropTargetId,
  collectionDropMode,
  onCollectionDragOver,
  onCollectionDragLeave,
  onCollectionDrop,
}: SidebarProps) {
  const [activeMenu, setActiveMenu] = useState("All Items");
  const [showTags, setShowTags] = useState(true);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [tagMenu, setTagMenu] = useState<TagMenuState>({
    open: false,
    x: 0,
    y: 0,
    tagId: null,
  });
  const tagRenameInputRef = useRef<HTMLInputElement | null>(null);
  const isTagRenameCommitPendingRef = useRef(false);
  const tagMenuRef = useRef<HTMLDivElement | null>(null);
  const [draggedTagId, setDraggedTagId] = useState<string | null>(null);
  const draggedTagIdRef = useRef<string | null>(null);
  const [tagDropTarget, setTagDropTarget] = useState<TagDropTargetState>(null);
  const pointerTagDragCandidateRef = useRef<PointerTagDragCandidate | null>(null);
  const activePointerTagDragRef = useRef<ActiveTagPointerDrag | null>(null);
  const [customTagDragState, setCustomTagDragState] = useState<ActiveTagPointerDrag | null>(null);
  const hoveredItemDropTargetIdRef = useRef<string | null>(null);
  const suppressNextTagClickUntilRef = useRef(0);

  useEffect(() => {
    if ((selectedCollectionId !== null || selectedTagId !== null) && activeMenu !== "") {
      setActiveMenu("");
      return;
    }
    if (selectedCollectionId === null && selectedTagId === null && activeMenu === "") {
      setActiveMenu("All Items");
    }
  }, [selectedCollectionId, selectedTagId, activeMenu]);

  useEffect(() => {
    if (!editingTagId) {
      return;
    }
    if (!tags.some((tag) => tag.id === editingTagId)) {
      setEditingTagId(null);
      setEditingTagName("");
    }
  }, [editingTagId, tags]);

  useEffect(() => {
    if (!editingTagId) return;
    tagRenameInputRef.current?.focus();
    tagRenameInputRef.current?.select();
  }, [editingTagId]);

  useEffect(() => {
    if (!tagMenu.open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && tagMenuRef.current?.contains(target)) {
        return;
      }
      setTagMenu((current) => ({ ...current, open: false, tagId: null }));
    };

    const handleWindowBlur = () => {
      setTagMenu((current) => ({ ...current, open: false, tagId: null }));
    };

    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [tagMenu.open]);

  const setHoveredItemDropTargetId = useCallback((nextItemId: string | null) => {
    const previousItemId = hoveredItemDropTargetIdRef.current;
    if (previousItemId === nextItemId) {
      return;
    }
    if (previousItemId && typeof document !== "undefined") {
      const prevCard = document.querySelector<HTMLElement>(
        `.item-grid .item-card[data-item-id="${CSS.escape(previousItemId)}"]`,
      );
      prevCard?.classList.remove("item-card-tag-drop-target");
    }
    hoveredItemDropTargetIdRef.current = nextItemId;
    if (nextItemId && typeof document !== "undefined") {
      const nextCard = document.querySelector<HTMLElement>(
        `.item-grid .item-card[data-item-id="${CSS.escape(nextItemId)}"]`,
      );
      nextCard?.classList.add("item-card-tag-drop-target");
    }
  }, []);

  const clearPointerTagDrag = useCallback(() => {
    pointerTagDragCandidateRef.current = null;
    activePointerTagDragRef.current = null;
    draggedTagIdRef.current = null;
    setDraggedTagId(null);
    setTagDropTarget(null);
    setHoveredItemDropTargetId(null);
    setCustomTagDragState(null);
  }, [setHoveredItemDropTargetId]);

  const handleMenuClick = (menuLabel: string) => {
    setActiveMenu(menuLabel);
    onSelectMenuView?.(menuLabel);
    if (
      menuLabel === "All Items" ||
      menuLabel === "Favorites" ||
      menuLabel === "Recents" ||
      menuLabel === "Archive" ||
      menuLabel === "Trash"
    ) {
      onSelectTag(null);
      onSelectCollection(null);
    }
  };

  const handleCreateTag = () => {
    void (async () => {
      try {
        const createdTag = await onCreateTag();
        if (!createdTag) {
          return;
        }
        setShowTags(true);
        setEditingTagId(createdTag.id);
        setEditingTagName(createdTag.name);
      } catch (error) {
        console.error("Failed to create tag from sidebar:", error);
      }
    })();
  };

  const handleStartRenameTag = (tag: Tag) => {
    setEditingTagId(tag.id);
    setEditingTagName(tag.name);
    setTagMenu((current) => ({ ...current, open: false, tagId: null }));
  };

  const handleCancelRenameTag = () => {
    if (isTagRenameCommitPendingRef.current) {
      return;
    }
    setEditingTagId(null);
    setEditingTagName("");
  };

  const handleConfirmRenameTag = () => {
    if (isTagRenameCommitPendingRef.current) {
      return;
    }
    const targetTagId = editingTagId;
    if (!targetTagId) {
      return;
    }
    const currentTag = tags.find((tag) => tag.id === targetTagId);
    if (!currentTag) {
      setEditingTagId(null);
      setEditingTagName("");
      return;
    }

    const trimmedName = editingTagName.trim();
    const nextName =
      trimmedName.length > 0 ? trimmedName : nextSidebarTagFallbackName(tags, targetTagId);

    isTagRenameCommitPendingRef.current = true;
    void onRenameTag(targetTagId, nextName)
      .finally(() => {
        isTagRenameCommitPendingRef.current = false;
        setEditingTagId(null);
        setEditingTagName("");
      });
  };

  const resolveCollectionDropTargetId = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) {
      return null;
    }
    const row = target.closest<HTMLElement>("[data-collection-drop-id]");
    return row?.dataset.collectionDropId ?? null;
  };

  const activeTagForMenu = useMemo(
    () => (tagMenu.tagId ? tags.find((tag) => tag.id === tagMenu.tagId) ?? null : null),
    [tagMenu.tagId, tags],
  );

  const boundedTagMenuX = Math.max(
    8,
    Math.min(tagMenu.x, window.innerWidth - TAG_CONTEXT_MENU_WIDTH - 8),
  );
  const boundedTagMenuY = Math.max(
    8,
    Math.min(tagMenu.y, window.innerHeight - TAG_CONTEXT_MENU_HEIGHT - 8),
  );

  const resolveTagReorder = useCallback((
    sourceTagId: string,
    targetTagId: string,
    position: "before" | "after",
  ) => {
    if (sourceTagId === targetTagId) {
      return;
    }
    const currentOrder = tags.map((tag) => tag.id);
    const withoutSource = currentOrder.filter((tagId) => tagId !== sourceTagId);
    const targetIndex = withoutSource.indexOf(targetTagId);
    if (targetIndex < 0) {
      return;
    }
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    withoutSource.splice(insertIndex, 0, sourceTagId);
    void onReorderTags(withoutSource);
  }, [onReorderTags, tags]);

  useEffect(() => {
    const DRAG_THRESHOLD_PX = 6;

    const handlePointerMove = (event: PointerEvent) => {
      const candidate = pointerTagDragCandidateRef.current;
      const active = activePointerTagDragRef.current;
      if (!candidate && !active) {
        return;
      }

      const trackedPointerId = active?.pointerId ?? candidate?.pointerId;
      if (trackedPointerId !== undefined && trackedPointerId !== event.pointerId) {
        return;
      }

      if (event.buttons === 0) {
        clearPointerTagDrag();
        return;
      }

      let nextActive = active;
      if (!nextActive && candidate) {
        const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
        if (distance < DRAG_THRESHOLD_PX) {
          return;
        }
        nextActive = {
          pointerId: candidate.pointerId,
          tagId: candidate.tagId,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        activePointerTagDragRef.current = nextActive;
        pointerTagDragCandidateRef.current = null;
        draggedTagIdRef.current = candidate.tagId;
        setDraggedTagId(candidate.tagId);
      }

      if (!nextActive) {
        return;
      }

      event.preventDefault();
      const nextTagDropTarget = sidebarTagDropTargetFromPoint(
        event.clientX,
        event.clientY,
        nextActive.tagId,
      );
      setTagDropTarget((current) =>
        current?.tagId === nextTagDropTarget?.tagId &&
        current?.position === nextTagDropTarget?.position
          ? current
          : nextTagDropTarget,
      );

      setHoveredItemDropTargetId(itemCardIdFromPoint(event.clientX, event.clientY));

      const nextState: ActiveTagPointerDrag = {
        ...nextActive,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      activePointerTagDragRef.current = nextState;
      setCustomTagDragState(nextState);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const candidate = pointerTagDragCandidateRef.current;
      const active = activePointerTagDragRef.current;
      if (!candidate && !active) {
        return;
      }

      const trackedPointerId = active?.pointerId ?? candidate?.pointerId;
      if (trackedPointerId !== undefined && trackedPointerId !== event.pointerId) {
        return;
      }

      if (!active) {
        pointerTagDragCandidateRef.current = null;
        return;
      }

      event.preventDefault();
      suppressNextTagClickUntilRef.current = Date.now() + 250;

      const finalTagDropTarget = sidebarTagDropTargetFromPoint(
        event.clientX,
        event.clientY,
        active.tagId,
      );
      const finalItemId = itemCardIdFromPoint(event.clientX, event.clientY);
      const draggedTagId = active.tagId;

      clearPointerTagDrag();

      if (finalItemId) {
        void onDropTagOnItem?.(finalItemId, draggedTagId);
        return;
      }

      if (finalTagDropTarget) {
        resolveTagReorder(draggedTagId, finalTagDropTarget.tagId, finalTagDropTarget.position);
      }
    };

    const handlePointerCancel = () => {
      if (!pointerTagDragCandidateRef.current && !activePointerTagDragRef.current) {
        return;
      }
      clearPointerTagDrag();
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    window.addEventListener("blur", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      window.removeEventListener("blur", handlePointerCancel);
    };
  }, [clearPointerTagDrag, onDropTagOnItem, resolveTagReorder, setHoveredItemDropTargetId]);

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
        <div className="sidebar-heading-row sidebar-heading-row-hover">
          <button
            type="button"
            className="sidebar-heading heading-toggle sidebar-heading-toggle-button"
            onClick={() => setShowTags((current) => !current)}
            aria-expanded={showTags}
            aria-controls="sidebar-tags-list"
          >
            <span className="sidebar-heading-toggle-icon" aria-hidden="true">
              {showTags ? (
                <ExpandMoreIcon fontSize="inherit" />
              ) : (
                <ChevronRightIcon fontSize="inherit" />
              )}
            </span>
            <span>Tags</span>
          </button>
          <button
            type="button"
            className="sidebar-heading-action"
            onClick={handleCreateTag}
            aria-label="Create tag"
            title="Create tag"
          >
            <AddIcon fontSize="inherit" />
          </button>
        </div>
        {showTags && (
          <ul id="sidebar-tags-list" className="tag-row-list">
            {tags.length === 0 ? (
              <li className="tag-empty">No tags yet</li>
            ) : (
              tags.map((tag) => {
                const isEditing = editingTagId === tag.id;
                const isActive = selectedTagId === tag.id;
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      data-tag-chip-id={tag.id}
                      draggable={false}
                      className={`tag-row ${isActive ? "active" : ""} ${
                        draggedTagId === tag.id ? "dragging" : ""
                      } ${
                        tagDropTarget?.tagId === tag.id
                          ? `drop-${tagDropTarget.position}`
                          : ""
                      }`}
                      style={{ "--tag-chip-color": tag.color } as React.CSSProperties}
                      onClick={(event) => {
                        if (Date.now() < suppressNextTagClickUntilRef.current) {
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        setActiveMenu("");
                        onSelectTag(tag.id);
                      }}
                      onPointerDown={(event) => {
                        if (isEditing) {
                          return;
                        }
                        if (!event.isPrimary || event.button !== 0) {
                          return;
                        }
                        pointerTagDragCandidateRef.current = {
                          pointerId: event.pointerId,
                          tagId: tag.id,
                          startX: event.clientX,
                          startY: event.clientY,
                        };
                      }}
                      onDragStart={(event) => {
                        // Tag drag uses our custom pointer flow. Prevent native browser drag
                        // so Tauri/WebView doesn't show a blocked cursor.
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        handleStartRenameTag(tag);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setTagMenu({
                          open: true,
                          x: event.clientX,
                          y: event.clientY,
                          tagId: tag.id,
                        });
                      }}
                    >
                      <span
                        className="tag-row-dot"
                        style={{ backgroundColor: tag.color }}
                        aria-hidden="true"
                      />
                      {isEditing ? (
                        <input
                          ref={tagRenameInputRef}
                          className="tag-rename-input"
                          value={editingTagName}
                          onChange={(event) => setEditingTagName(event.currentTarget.value)}
                          onBlur={handleConfirmRenameTag}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              handleConfirmRenameTag();
                              return;
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              handleCancelRenameTag();
                            }
                          }}
                        />
                      ) : (
                        <span className="tag-row-label">{tag.name}</span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      {tagMenu.open && activeTagForMenu ? (
        <div
          ref={tagMenuRef}
          className="context-menu tag-context-menu"
          style={{ left: `${boundedTagMenuX}px`, top: `${boundedTagMenuY}px` }}
          role="menu"
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => handleStartRenameTag(activeTagForMenu)}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <DriveFileRenameOutlineOutlinedIcon fontSize="inherit" />
            </span>
            <span className="context-menu-label">Rename</span>
            <span className="context-menu-shortcut" />
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              void onDuplicateTag(activeTagForMenu.id);
              setTagMenu((current) => ({ ...current, open: false, tagId: null }));
            }}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <FileCopyOutlinedIcon fontSize="inherit" />
            </span>
            <span className="context-menu-label">Duplicate</span>
            <span className="context-menu-shortcut" />
          </button>
          <div className="tag-context-color-section" role="group" aria-label="Change tag color">
            <div className="tag-context-color-title">
              <span className="tag-context-color-title-icon" aria-hidden="true">
                <PaletteOutlinedIcon fontSize="inherit" />
              </span>
              <span>Change color</span>
            </div>
            <div className="tag-context-color-grid">
              {tagColorPalette.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`tag-context-color-swatch ${
                    activeTagForMenu.color === color ? "active" : ""
                  }`}
                  style={{ backgroundColor: color }}
                  aria-label={`Set tag color ${color}`}
                  onClick={() => {
                    void onUpdateTagColor(activeTagForMenu.id, color);
                    setTagMenu((current) => ({ ...current, open: false, tagId: null }));
                  }}
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            className="context-menu-item danger"
            onClick={() => {
              onDeleteTag(activeTagForMenu.id);
              setTagMenu((current) => ({ ...current, open: false, tagId: null }));
            }}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <DeleteOutlineOutlinedIcon fontSize="inherit" />
            </span>
            <span className="context-menu-label">Delete</span>
            <span className="context-menu-shortcut" />
          </button>
        </div>
      ) : null}

      {customTagDragState && draggedTagId ? (
        <div
          className="custom-tag-drag-ghost"
          style={
            {
              left: `${customTagDragState.clientX + 12}px`,
              top: `${customTagDragState.clientY + 12}px`,
            } as React.CSSProperties
          }
          aria-hidden="true"
        >
          <span
            className="tag-row-dot"
            style={{
              backgroundColor: tags.find((tag) => tag.id === draggedTagId)?.color ?? "#64748b",
            }}
          />
          <span>
            {tags.find((tag) => tag.id === draggedTagId)?.name ?? "Tag"}
          </span>
        </div>
      ) : null}
    </aside>
  );
}

export default Sidebar;
