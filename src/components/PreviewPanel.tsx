import { useEffect, useMemo, useState } from "react";
import FavoriteBorderOutlinedIcon from "@mui/icons-material/FavoriteBorderOutlined";
import FavoriteOutlinedIcon from "@mui/icons-material/FavoriteOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import type { Item } from "../App";
import type { Tag } from "../lib/db";

type PreviewPanelProps = {
  selectedCount: number;
  item: Item | null;
  availableTags: Tag[];
  onDescriptionChange: (value: string) => void;
  onSetItemRating: (itemId: string, rating: number) => void | Promise<void>;
  onToggleItemFavorite: (itemId: string) => void | Promise<void>;
  onUpdateItemTags: (itemId: string, tagIds: string[]) => void | Promise<void>;
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
  availableTags,
  onDescriptionChange,
  onSetItemRating,
  onToggleItemFavorite,
  onUpdateItemTags,
  onOpenBookmarkUrl,
  onDeleteSelection,
  onMoveSelection,
  onDuplicateSelection,
}: PreviewPanelProps) {
  const [tagInputValue, setTagInputValue] = useState("");
  const [activeTagSuggestionIndex, setActiveTagSuggestionIndex] = useState(0);
  const [isTagInputFocused, setIsTagInputFocused] = useState(false);

  useEffect(() => {
    setTagInputValue("");
    setActiveTagSuggestionIndex(0);
    setIsTagInputFocused(false);
  }, [item?.id]);

  const tagById = useMemo(() => {
    const map = new Map<string, Tag>();
    availableTags.forEach((tag) => {
      map.set(tag.id, tag);
    });
    return map;
  }, [availableTags]);

  const selectedTagIds = item?.tagIds ?? [];
  const selectedTagIdSet = useMemo(() => new Set(selectedTagIds), [selectedTagIds]);
  const selectedTags = useMemo(() => {
    if (!item) {
      return [] as Array<{ id: string; name: string; color: string }>;
    }
    return item.tagIds.map((tagId, index) => {
      const tag = tagById.get(tagId);
      return {
        id: tagId,
        name: tag?.name ?? item.tags[index] ?? "Unknown tag",
        color: tag?.color ?? "#64748b",
      };
    });
  }, [item, tagById]);

  const filteredTagSuggestions = useMemo(() => {
    const query = tagInputValue.trim().toLowerCase();
    return availableTags.filter((tag) => {
      if (selectedTagIdSet.has(tag.id)) {
        return false;
      }
      if (!query) {
        return true;
      }
      return tag.name.toLowerCase().includes(query);
    });
  }, [availableTags, selectedTagIdSet, tagInputValue]);

  useEffect(() => {
    if (activeTagSuggestionIndex < filteredTagSuggestions.length) {
      return;
    }
    setActiveTagSuggestionIndex(0);
  }, [activeTagSuggestionIndex, filteredTagSuggestions.length]);

  const applyItemTagIds = (nextTagIds: string[]) => {
    if (!item) {
      return;
    }
    void onUpdateItemTags(item.id, nextTagIds);
  };

  const addTagToSelection = (tagId: string) => {
    if (!item || selectedTagIdSet.has(tagId)) {
      return;
    }
    applyItemTagIds([...item.tagIds, tagId]);
    setTagInputValue("");
    setActiveTagSuggestionIndex(0);
  };

  const removeTagFromSelection = (tagId: string) => {
    if (!item) {
      return;
    }
    applyItemTagIds(item.tagIds.filter((id) => id !== tagId));
  };

  const handleTagInputKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (!item) {
      return;
    }
    if (event.key === "ArrowDown") {
      if (filteredTagSuggestions.length === 0) return;
      event.preventDefault();
      setActiveTagSuggestionIndex((current) =>
        Math.min(current + 1, filteredTagSuggestions.length - 1),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      if (filteredTagSuggestions.length === 0) return;
      event.preventDefault();
      setActiveTagSuggestionIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const selectedSuggestion =
        filteredTagSuggestions[activeTagSuggestionIndex] ?? filteredTagSuggestions[0] ?? null;
      if (!selectedSuggestion) {
        return;
      }
      event.preventDefault();
      addTagToSelection(selectedSuggestion.id);
      return;
    }
    if (event.key === "Backspace" && tagInputValue.length === 0 && item.tagIds.length > 0) {
      event.preventDefault();
      applyItemTagIds(item.tagIds.slice(0, -1));
    }
  };

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
  const bookmarkUrlLabel =
    item.type === "bookmark" && item.sourceUrl ? formatPreviewUrlLabel(item.sourceUrl) : null;
  const showTagSuggestions = isTagInputFocused && filteredTagSuggestions.length > 0;

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
          <dd>
            <div className="preview-rating-controls" role="group" aria-label="Item rating">
              {Array.from({ length: 5 }, (_, index) => {
                const value = index + 1;
                const selected = item.rating >= value;
                const isExactSelection = item.rating === value;
                return (
                  <button
                    key={value}
                    type="button"
                    className={`preview-star-button ${selected ? "active" : ""}`}
                    aria-label={
                      isExactSelection ? `Clear ${value}-star rating` : `Set rating to ${value}`
                    }
                    aria-pressed={isExactSelection}
                    onClick={() => {
                      void onSetItemRating(item.id, isExactSelection ? 0 : value);
                    }}
                  >
                    {selected ? (
                      <StarRoundedIcon fontSize="inherit" />
                    ) : (
                      <StarBorderRoundedIcon fontSize="inherit" />
                    )}
                  </button>
                );
              })}
            </div>
          </dd>
        </div>
        <div>
          <dt>Favorite</dt>
          <dd>
            <button
              type="button"
              className={`preview-favorite-toggle ${item.isFavorite ? "active" : ""}`}
              aria-pressed={item.isFavorite}
              onClick={() => {
                void onToggleItemFavorite(item.id);
              }}
            >
              <span className="preview-favorite-toggle-icon" aria-hidden="true">
                {item.isFavorite ? (
                  <FavoriteOutlinedIcon fontSize="inherit" />
                ) : (
                  <FavoriteBorderOutlinedIcon fontSize="inherit" />
                )}
              </span>
              <span>{item.isFavorite ? "Favorite" : "Not favorite"}</span>
            </button>
          </dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>
            <div className="preview-tags-editor">
              <div className="preview-tag-chip-list">
                {selectedTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="preview-tag-chip"
                    style={{ "--tag-chip-color": tag.color } as React.CSSProperties}
                  >
                    <span
                      className="preview-tag-chip-dot"
                      style={{ backgroundColor: tag.color }}
                      aria-hidden="true"
                    />
                    <span className="preview-tag-chip-label">{tag.name}</span>
                    <button
                      type="button"
                      className="preview-tag-chip-remove"
                      aria-label={`Remove tag ${tag.name}`}
                      onClick={() => removeTagFromSelection(tag.id)}
                    >
                      X
                    </button>
                  </span>
                ))}
              </div>
              <div className="preview-tag-input-wrap">
                <input
                  type="text"
                  className="preview-tag-input"
                  value={tagInputValue}
                  onChange={(event) => {
                    setTagInputValue(event.currentTarget.value);
                    setActiveTagSuggestionIndex(0);
                  }}
                  onKeyDown={handleTagInputKeyDown}
                  onFocus={() => setIsTagInputFocused(true)}
                  onBlur={() => setIsTagInputFocused(false)}
                  placeholder="Add tag..."
                  autoComplete="off"
                />
                {showTagSuggestions ? (
                  <div className="preview-tag-suggestions" role="listbox" aria-label="Tags">
                    {filteredTagSuggestions.slice(0, 8).map((tag, index) => (
                      <button
                        key={tag.id}
                        type="button"
                        className={`preview-tag-suggestion ${
                          index === activeTagSuggestionIndex ? "active" : ""
                        }`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          addTagToSelection(tag.id);
                        }}
                      >
                        <span
                          className="preview-tag-suggestion-dot"
                          style={{ backgroundColor: tag.color }}
                          aria-hidden="true"
                        />
                        <span>{tag.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </dd>
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
            <dd>{item.width && item.height ? `${item.width}x${item.height}` : "unknown"}</dd>
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
