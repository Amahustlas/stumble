import type { Item } from "../App";

type PreviewPanelProps = {
  selectedCount: number;
  item: Item | null;
  onDescriptionChange: (value: string) => void;
  onOpenBookmarkUrl: (url: string) => void | Promise<void>;
  onDeleteSelection: () => void;
  onMoveSelection: () => void;
  onDuplicateSelection: () => void;
};

function formatPreviewUrlLabel(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    return `${parsed.hostname}${path}`;
  } catch {
    return urlValue;
  }
}

function PreviewPanel({
  selectedCount,
  item,
  onDescriptionChange,
  onOpenBookmarkUrl,
  onDeleteSelection,
  onMoveSelection,
  onDuplicateSelection,
}: PreviewPanelProps) {
  if (selectedCount > 1) {
    return (
      <aside className="preview-panel">
        <h3>Selection</h3>
        <p>{selectedCount} items selected</p>
        <div className="bulk-actions">
          <button type="button" className="danger" onClick={onDeleteSelection}>
            Delete
          </button>
          <button type="button" onClick={onMoveSelection}>
            Move
          </button>
          <button type="button" onClick={onDuplicateSelection}>
            Duplicate
          </button>
        </div>
      </aside>
    );
  }

  if (!item) {
    return (
      <aside className="preview-panel">
        <h3>Preview</h3>
        <p>Select an item to preview details.</p>
      </aside>
    );
  }

  const previewSrc = item.type === "image" ? item.previewUrl || "" : "";
  const bookmarkUrlLabel = item.type === "bookmark" && item.sourceUrl
    ? formatPreviewUrlLabel(item.sourceUrl)
    : null;

  return (
    <aside className="preview-panel">
      <h3>Preview</h3>
      <div className="preview-media">
        {item.type === "image" && previewSrc ? (
          <img className="preview-media-image" src={previewSrc} alt={item.title} />
        ) : item.type === "bookmark" ? (
          <div className="preview-bookmark-summary">
            <div className="preview-bookmark-favicon" aria-hidden="true">
              {item.faviconUrl ? <img src={item.faviconUrl} alt="" /> : "URL"}
            </div>
            <div className="preview-bookmark-text">
              <div className="preview-bookmark-title">{item.title || "Untitled bookmark"}</div>
              <div className="preview-bookmark-host">{item.hostname || "-"}</div>
            </div>
          </div>
        ) : (
          "Media Preview"
        )}
      </div>
      <dl className="preview-metadata">
        <div>
          <dt>Filename</dt>
          <dd>{item.filename}</dd>
        </div>
        <div>
          <dt>Title</dt>
          <dd>{item.title}</dd>
        </div>
        {item.type === "bookmark" && (
          <div>
            <dt>URL</dt>
            <dd>
              {item.sourceUrl ? (
                <button
                  type="button"
                  className="preview-link-button"
                  onClick={() => {
                    if (item.sourceUrl) {
                      void onOpenBookmarkUrl(item.sourceUrl);
                    }
                  }}
                  title={item.sourceUrl}
                >
                  {bookmarkUrlLabel}
                </button>
              ) : (
                "-"
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Type</dt>
          <dd>{item.type}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{item.status}</dd>
        </div>
        <div>
          <dt>Rating</dt>
          <dd>{item.rating}</dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>{item.tags.join(", ") || "-"}</dd>
        </div>
        <div>
          <dt>Collection</dt>
          <dd>{item.collectionPath}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{item.createdAt}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{item.updatedAt}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{item.size}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>{item.format}</dd>
        </div>
        {item.type === "image" && (
          <div>
            <dt>Dimensions</dt>
            <dd>
              {item.width && item.height
                ? `${item.width}x${item.height}`
                : "unknown"}
            </dd>
          </div>
        )}
      </dl>

      <label className="description-editor" htmlFor="item-description">
        Description
        <textarea
          id="item-description"
          value={item.description}
          onChange={(event) => onDescriptionChange(event.currentTarget.value)}
          rows={5}
        />
      </label>

      <div className="bulk-actions">
        <button type="button" className="danger" onClick={onDeleteSelection}>
          Delete
        </button>
        <button type="button" onClick={onMoveSelection}>
          Move
        </button>
        <button type="button" onClick={onDuplicateSelection}>
          Duplicate
        </button>
      </div>
    </aside>
  );
}

export default PreviewPanel;
