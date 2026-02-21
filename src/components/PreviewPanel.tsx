import type { Item } from "../App";

type PreviewPanelProps = {
  selectedCount: number;
  item: Item | null;
  onDescriptionChange: (value: string) => void;
  onDeleteSelection: () => void;
  onMoveSelection: () => void;
  onDuplicateSelection: () => void;
};

function PreviewPanel({
  selectedCount,
  item,
  onDescriptionChange,
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

  return (
    <aside className="preview-panel">
      <h3>Preview</h3>
      <div className="preview-media">
        {item.type === "image" && previewSrc ? (
          <img className="preview-media-image" src={previewSrc} alt={item.title} />
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
