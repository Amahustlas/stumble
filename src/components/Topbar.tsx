import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";
import {
  ADVANCED_ITEM_FILTER_TYPE_OPTIONS,
  formatAdvancedItemFilterTypeLabel,
  hasActiveAdvancedItemFilters,
  type AdvancedItemFilters,
  type ItemListSortOption,
} from "../lib/itemFilters";

export type TopbarSortOption = ItemListSortOption;

export type TopbarFilterChip = {
  id: string;
  label: string;
  color?: string;
  title?: string;
};

type TopbarTagOption = {
  id: string;
  name: string;
  color: string;
};

type TopbarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  availableTags: TopbarTagOption[];
  advancedFilters: AdvancedItemFilters;
  onAdvancedFiltersChange: (nextFilters: AdvancedItemFilters) => void;
  activeFilterChips: TopbarFilterChip[];
  onRemoveFilterChip: (chipId: string) => void;
  onClearAllFilterChips: () => void;
  tileSize: number;
  onTileSizeChange: (value: number) => void;
  sortOption: TopbarSortOption;
  onSortOptionChange: (value: TopbarSortOption) => void;
  onAddUrl: () => void;
  onImport: () => void;
};

function Topbar({
  searchQuery,
  onSearchChange,
  availableTags,
  advancedFilters,
  onAdvancedFiltersChange,
  activeFilterChips,
  onRemoveFilterChip,
  onClearAllFilterChips,
  tileSize,
  onTileSizeChange,
  sortOption,
  onSortOptionChange,
  onAddUrl,
  onImport,
}: TopbarProps) {
  const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false);
  const filterPopoverRef = useRef<HTMLDivElement | null>(null);
  const hasActivePopoverFilters = hasActiveAdvancedItemFilters(advancedFilters);
  const selectedTypeSet = useMemo(() => new Set(advancedFilters.types), [advancedFilters.types]);
  const selectedTagIdSet = useMemo(() => new Set(advancedFilters.tagIds), [advancedFilters.tagIds]);

  const activePopoverFilterCount =
    advancedFilters.types.length +
    advancedFilters.tagIds.length +
    (advancedFilters.minRating > 0 ? 1 : 0) +
    (advancedFilters.favoritesOnly ? 1 : 0);

  useEffect(() => {
    if (!isFilterPopoverOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const targetNode = event.target;
      if (!(targetNode instanceof Node)) {
        return;
      }
      if (!filterPopoverRef.current?.contains(targetNode)) {
        setIsFilterPopoverOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFilterPopoverOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFilterPopoverOpen]);

  const updateFilters = (partial: Partial<AdvancedItemFilters>) => {
    onAdvancedFiltersChange({
      ...advancedFilters,
      ...partial,
    });
  };

  const toggleTypeFilter = (typeValue: (typeof ADVANCED_ITEM_FILTER_TYPE_OPTIONS)[number]) => {
    const nextTypes = selectedTypeSet.has(typeValue)
      ? advancedFilters.types.filter((entry) => entry !== typeValue)
      : [...advancedFilters.types, typeValue];

    updateFilters({ types: nextTypes });
  };

  const toggleTagFilter = (tagId: string) => {
    const nextTagIds = selectedTagIdSet.has(tagId)
      ? advancedFilters.tagIds.filter((entry) => entry !== tagId)
      : [...advancedFilters.tagIds, tagId];

    updateFilters({ tagIds: nextTagIds });
  };

  return (
    <header className={`topbar ${activeFilterChips.length > 0 ? "has-filters" : ""}`}>
      <div className="topbar-search">
        <input
          className="topbar-search-input"
          type="text"
          placeholder="Search items..."
          value={searchQuery}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
        />

        <div className="topbar-filter-popover-anchor" ref={filterPopoverRef}>
          <button
            type="button"
            className={`topbar-filter-button ${hasActivePopoverFilters ? "active" : ""}`}
            onClick={() => setIsFilterPopoverOpen((current) => !current)}
            aria-haspopup="dialog"
            aria-expanded={isFilterPopoverOpen}
          >
            Filters
            {activePopoverFilterCount > 0 ? (
              <span className="topbar-filter-button-count" aria-hidden="true">
                {activePopoverFilterCount}
              </span>
            ) : null}
          </button>

          {isFilterPopoverOpen ? (
            <div className="topbar-filter-popover" role="dialog" aria-label="Advanced filters">
              <section className="topbar-filter-section">
                <div className="topbar-filter-section-title">Type</div>
                <div className="topbar-filter-checkbox-list">
                  {ADVANCED_ITEM_FILTER_TYPE_OPTIONS.map((typeValue) => (
                    <label key={typeValue} className="topbar-filter-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedTypeSet.has(typeValue)}
                        onChange={() => toggleTypeFilter(typeValue)}
                      />
                      <span>{formatAdvancedItemFilterTypeLabel(typeValue)}</span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="topbar-filter-section">
                <div className="topbar-filter-section-title">Tags</div>
                {availableTags.length > 0 ? (
                  <div className="topbar-filter-checkbox-list topbar-filter-tag-list">
                    {availableTags.map((tag) => (
                      <label key={tag.id} className="topbar-filter-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedTagIdSet.has(tag.id)}
                          onChange={() => toggleTagFilter(tag.id)}
                        />
                        <span className="topbar-filter-tag-label">
                          <span
                            className="topbar-filter-tag-dot"
                            style={{ backgroundColor: tag.color } as CSSProperties}
                            aria-hidden="true"
                          />
                          <span>{tag.name}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="topbar-filter-empty">No tags yet</div>
                )}
              </section>

              <section className="topbar-filter-section topbar-filter-inline-fields">
                <label className="topbar-filter-field" htmlFor="topbar-filter-rating">
                  <span className="topbar-filter-section-title">Rating</span>
                  <select
                    id="topbar-filter-rating"
                    value={String(advancedFilters.minRating)}
                    onChange={(event) =>
                      updateFilters({ minRating: Math.max(0, Math.min(5, Number(event.currentTarget.value) || 0)) })
                    }
                  >
                    <option value="0">Any</option>
                    <option value="1">&gt;= 1</option>
                    <option value="2">&gt;= 2</option>
                    <option value="3">&gt;= 3</option>
                    <option value="4">&gt;= 4</option>
                    <option value="5">&gt;= 5</option>
                  </select>
                </label>

                <label className="topbar-filter-checkbox topbar-filter-checkbox-inline">
                  <input
                    type="checkbox"
                    checked={advancedFilters.favoritesOnly}
                    onChange={(event) => updateFilters({ favoritesOnly: event.currentTarget.checked })}
                  />
                  <span>Favorites only</span>
                </label>
              </section>
            </div>
          ) : null}
        </div>
      </div>

      <div className="topbar-actions">
        <button type="button" onClick={onAddUrl}>
          Add URL
        </button>
        <button type="button" onClick={onImport}>
          Import
        </button>
        <label className="topbar-sort-control" htmlFor="item-sort">
          Sort
          <select
            id="item-sort"
            value={sortOption}
            onChange={(event) => onSortOptionChange(event.currentTarget.value as TopbarSortOption)}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name-asc">Name A-Z</option>
            <option value="rating-desc">Rating high-low</option>
          </select>
        </label>
        <label className="tile-size-control" htmlFor="tile-size">
          Tile size
          <input
            id="tile-size"
            type="range"
            min={170}
            max={300}
            value={tileSize}
            onChange={(event) => onTileSizeChange(Number(event.currentTarget.value))}
          />
        </label>
      </div>

      {activeFilterChips.length > 0 ? (
        <div className="topbar-filter-row" aria-label="Active filters">
          {activeFilterChips.map((chip) => {
            const isTagChip = typeof chip.color === "string" && chip.color.length > 0;
            return (
              <button
                key={chip.id}
                type="button"
                className={
                  isTagChip
                    ? "tag-row active topbar-filter-chip"
                    : "topbar-filter-chip-pill topbar-filter-chip"
                }
                style={
                  isTagChip
                    ? ({ "--tag-chip-color": chip.color } as CSSProperties)
                    : undefined
                }
                onClick={() => onRemoveFilterChip(chip.id)}
                title={chip.title ?? `Remove filter: ${chip.label}`}
              >
                {isTagChip ? (
                  <span
                    className="tag-row-dot"
                    style={{ backgroundColor: chip.color } as CSSProperties}
                    aria-hidden="true"
                  />
                ) : null}
                <span className={isTagChip ? "tag-row-label" : "topbar-filter-chip-label"}>
                  {chip.label}
                </span>
                <span className="topbar-filter-chip-close" aria-hidden="true">
                  <CloseOutlinedIcon fontSize="inherit" />
                </span>
              </button>
            );
          })}

          <button
            type="button"
            className="topbar-filter-clear-all"
            onClick={onClearAllFilterChips}
          >
            Clear all
          </button>
        </div>
      ) : null}
    </header>
  );
}

export default Topbar;
