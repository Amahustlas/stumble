import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";

export type TopbarSortOption = "newest" | "oldest" | "name-asc" | "rating-desc";

type TopbarTagFilter = {
  id: string;
  name: string;
  color: string;
};

type TopbarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  activeTagFilter?: TopbarTagFilter | null;
  onClearTagFilter?: () => void;
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
  activeTagFilter = null,
  onClearTagFilter,
  tileSize,
  onTileSizeChange,
  sortOption,
  onSortOptionChange,
  onAddUrl,
  onImport,
}: TopbarProps) {
  return (
    <header className={`topbar ${activeTagFilter ? "has-filters" : ""}`}>
      <div className="topbar-search">
        <input
          type="text"
          placeholder="Search items..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.currentTarget.value)}
        />
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
            <option value="name-asc">Name A→Z</option>
            <option value="rating-desc">Rating high→low</option>
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
            onChange={(e) => onTileSizeChange(Number(e.currentTarget.value))}
          />
        </label>
      </div>

      {activeTagFilter ? (
        <div className="topbar-filter-row" aria-label="Active filters">
          <button
            type="button"
            className="tag-row active topbar-filter-chip"
            style={{ "--tag-chip-color": activeTagFilter.color } as React.CSSProperties}
            onClick={() => onClearTagFilter?.()}
            title={`Clear tag filter: ${activeTagFilter.name}`}
          >
            <span
              className="tag-row-dot"
              style={{ backgroundColor: activeTagFilter.color }}
              aria-hidden="true"
            />
            <span className="tag-row-label">{activeTagFilter.name}</span>
            <span className="topbar-filter-chip-close" aria-hidden="true">
              <CloseOutlinedIcon fontSize="inherit" />
            </span>
          </button>
        </div>
      ) : null}
    </header>
  );
}

export default Topbar;
