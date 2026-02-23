import { useState } from "react";
import LanguageOutlinedIcon from "@mui/icons-material/LanguageOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import type { Item } from "../App";

const SIDEBAR_TAG_DRAG_MIME = "application/x-stumble-tag";

type ItemGridProps = {
  items: Item[];
  selectedIds: string[];
  tileSize: number;
  reorderDropTargetItemId?: string | null;
  reorderDropPosition?: "before" | "after" | null;
  onSelectItem: (itemId: string, event: React.MouseEvent) => void;
  onEmptyAreaClick: (event: React.MouseEvent<HTMLElement>) => void;
  onItemPointerDown: (item: Item, event: React.PointerEvent<HTMLButtonElement>) => void;
  onItemDoubleClick: (item: Item) => void;
  onItemContextMenu: (item: Item, event: React.MouseEvent) => void;
  onImageThumbnailMissing: (item: Item) => void;
  onDropFiles: (files: FileList) => void | Promise<void>;
  onDropTagOnItem?: (itemId: string, tagId: string) => void | Promise<void>;
};

function ItemGrid({
  items,
  selectedIds,
  tileSize,
  reorderDropTargetItemId = null,
  reorderDropPosition = null,
  onSelectItem,
  onEmptyAreaClick,
  onItemPointerDown,
  onItemDoubleClick,
  onItemContextMenu,
  onImageThumbnailMissing,
  onDropFiles,
  onDropTagOnItem,
}: ItemGridProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [tagDropTargetItemId, setTagDropTargetItemId] = useState<string | null>(null);

  const getDraggedTagId = (dataTransfer: DataTransfer): string | null => {
    try {
      const raw = dataTransfer.getData(SIDEBAR_TAG_DRAG_MIME);
      if (raw) {
        const parsed = JSON.parse(raw) as { tagId?: unknown };
        if (typeof parsed.tagId === "string" && parsed.tagId.trim().length > 0) {
          return parsed.tagId;
        }
      }
    } catch {
      // ignore parse failures
    }
    return null;
  };

  const isFileDrag = (dataTransfer: DataTransfer): boolean =>
    Array.from(dataTransfer.types ?? []).includes("Files");

  const handleDrop: React.DragEventHandler<HTMLElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    setTagDropTargetItemId(null);
    if (event.dataTransfer.files.length > 0) {
      void onDropFiles(event.dataTransfer.files);
    }
  };

  const getThumbnailClass = (type: Item["type"]) => {
    return `thumbnail thumbnail-${type}`;
  };

  const handleWrapClick: React.MouseEventHandler<HTMLElement> = (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-item-id]")) {
      return;
    }
    onEmptyAreaClick(event);
  };

  return (
    <section
      className={`item-grid-wrap ${isDragOver ? "drag-over" : ""}`}
      onClick={handleWrapClick}
      onDragOver={(event) => {
        if (!isFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setIsDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!isFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        setIsDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <section
        className="item-grid"
        style={{ "--tile-size": `${tileSize}px` } as React.CSSProperties}
        onDragOverCapture={(event) => {
          const draggedTagId = getDraggedTagId(event.dataTransfer);
          if (!draggedTagId) {
            return;
          }
          const targetElement =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-item-id]")
              : null;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          const targetItemId = targetElement?.dataset.itemId ?? null;
          setTagDropTargetItemId((current) => (current === targetItemId ? current : targetItemId));
        }}
        onDropCapture={(event) => {
          const draggedTagId = getDraggedTagId(event.dataTransfer);
          if (!draggedTagId) {
            return;
          }
          const targetElement =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-item-id]")
              : null;
          event.preventDefault();
          event.stopPropagation();
          const targetItemId = targetElement?.dataset.itemId ?? null;
          setTagDropTargetItemId(null);
          if (!targetItemId) {
            return;
          }
          void onDropTagOnItem?.(targetItemId, draggedTagId);
        }}
        onDragLeaveCapture={(event) => {
          const relatedTarget = event.relatedTarget;
          if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
            return;
          }
          setTagDropTargetItemId(null);
        }}
      >
        {items.map((item) => {
          const isImporting = item.importStatus === "processing";
          const isBookmarkMetaPending =
            item.type === "bookmark" && item.importStatus === "ready" && item.metaStatus === "pending";
          const isThumbPending =
            item.type === "image" &&
            item.importStatus === "ready" &&
            item.thumbStatus === "pending" &&
            !item.hasThumb;
          const hasImportError = item.importStatus === "error";
          const hasBookmarkMetaError = item.type === "bookmark" && item.metaStatus === "error";
          const showErrorOverlay =
            hasImportError ||
            hasBookmarkMetaError ||
            (item.type === "image" && item.thumbStatus === "error");
          const imageSrc =
            item.type === "image"
              ? item.hasThumb && item.thumbUrl
                ? item.thumbUrl
                : item.previewUrl
              : undefined;

          return (
            <button
              key={item.id}
              type="button"
              data-item-id={item.id}
              draggable={false}
              className={`item-card ${selectedIds.includes(item.id) ? "selected" : ""} ${
                reorderDropTargetItemId === item.id && reorderDropPosition
                  ? `reorder-target reorder-target-${reorderDropPosition}`
                  : ""
              } ${tagDropTargetItemId === item.id ? "item-card-tag-drop-target" : ""}`}
              onClick={(event) => onSelectItem(item.id, event)}
              onDoubleClick={() => onItemDoubleClick(item)}
              onContextMenu={(event) => onItemContextMenu(item, event)}
              onPointerDown={(event) => {
                console.log("[dnd][tile][pointerdown]", { itemId: item.id, button: event.button });
                onItemPointerDown(item, event);
              }}
              onDragStart={(event) => {
                event.preventDefault();
              }}
              onDragOverCapture={(event) => {
                const draggedTagId = getDraggedTagId(event.dataTransfer);
                if (!draggedTagId) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "copy";
                setTagDropTargetItemId((current) => (current === item.id ? current : item.id));
              }}
              onDragLeaveCapture={(event) => {
                const relatedTarget = event.relatedTarget;
                if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
                  return;
                }
                setTagDropTargetItemId((current) => (current === item.id ? null : current));
              }}
              onDropCapture={(event) => {
                const draggedTagId = getDraggedTagId(event.dataTransfer);
                if (!draggedTagId) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                setTagDropTargetItemId(null);
                void onDropTagOnItem?.(item.id, draggedTagId);
              }}
            >
              <div className={getThumbnailClass(item.type)}>
                {item.type === "image" && imageSrc ? (
                  <>
                    <img
                      className="thumbnail-image-element"
                      src={imageSrc}
                      alt={item.title}
                      draggable={false}
                      loading="lazy"
                      onError={() => {
                        if (!item.hasThumb) return;
                        onImageThumbnailMissing(item);
                      }}
                    />
                  </>
                ) : item.type === "bookmark" ? (
                  <span className="bookmark-favicon" aria-hidden="true">
                    {item.faviconUrl ? (
                      <img
                        className="bookmark-favicon-image"
                        src={item.faviconUrl}
                        alt=""
                        draggable={false}
                        loading="lazy"
                      />
                    ) : (
                      <span className="bookmark-favicon-icon">
                        <LanguageOutlinedIcon fontSize="inherit" />
                      </span>
                    )}
                  </span>
                ) : item.type === "note" ? (
                  <p className="note-snippet">{item.noteText || item.description}</p>
                ) : (
                  <span className="thumbnail-label">{item.type}</span>
                )}
                {(isImporting || isBookmarkMetaPending) && (
                  <div className="thumbnail-status-overlay pending" aria-hidden="true">
                    <span className="thumbnail-status-spinner" />
                    <span className="thumbnail-status-label">
                      {isImporting ? "Importing..." : "Fetching..."}
                    </span>
                  </div>
                )}
                {isThumbPending && (
                  <div className="thumbnail-thumb-pending" aria-hidden="true">
                    <span className="thumbnail-status-spinner" />
                  </div>
                )}
                {showErrorOverlay && (
                  <div className="thumbnail-status-overlay error" aria-hidden="true">
                    <span className="thumbnail-status-icon">
                      <WarningAmberOutlinedIcon fontSize="inherit" />
                    </span>
                  </div>
                )}
              </div>
              <div className="item-info">
                <h4 className="item-title">
                  {item.type === "bookmark" && item.metaStatus === "pending"
                    ? item.title || "Loading..."
                    : item.title}
                </h4>
                <p className="item-dimensions">
                  {item.type === "bookmark"
                    ? item.hostname || "bookmark"
                    : item.type === "image"
                    ? item.width && item.height
                      ? `${item.width}x${item.height}`
                      : "unknown"
                    : ""}
                </p>
              </div>
            </button>
          );
        })}
        {items.length === 0 && <p>No items match your search.</p>}
      </section>
      {isDragOver && <div className="drop-overlay">Drop files to import</div>}
    </section>
  );
}

export default ItemGrid;
