import { useState } from "react";
import LanguageOutlinedIcon from "@mui/icons-material/LanguageOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import type { Item } from "../App";

type ItemGridProps = {
  items: Item[];
  selectedIds: string[];
  tileSize: number;
  onSelectItem: (itemId: string, event: React.MouseEvent) => void;
  onItemDoubleClick: (item: Item) => void;
  onItemContextMenu: (item: Item, event: React.MouseEvent) => void;
  onImageThumbnailMissing: (item: Item) => void;
  onDropFiles: (files: FileList) => void | Promise<void>;
};

function ItemGrid({
  items,
  selectedIds,
  tileSize,
  onSelectItem,
  onItemDoubleClick,
  onItemContextMenu,
  onImageThumbnailMissing,
  onDropFiles,
}: ItemGridProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDrop: React.DragEventHandler<HTMLElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      void onDropFiles(event.dataTransfer.files);
    }
  };

  const getThumbnailClass = (type: Item["type"]) => {
    return `thumbnail thumbnail-${type}`;
  };

  return (
    <section
      className={`item-grid-wrap ${isDragOver ? "drag-over" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragOver(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        setIsDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <section
        className="item-grid"
        style={{ "--tile-size": `${tileSize}px` } as React.CSSProperties}
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
              className={`item-card ${selectedIds.includes(item.id) ? "selected" : ""}`}
              onClick={(event) => onSelectItem(item.id, event)}
              onDoubleClick={() => onItemDoubleClick(item)}
              onContextMenu={(event) => onItemContextMenu(item, event)}
            >
              <div className={getThumbnailClass(item.type)}>
                {item.type === "image" && imageSrc ? (
                  <>
                    <img
                      className="thumbnail-image-element"
                      src={imageSrc}
                      alt={item.title}
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
