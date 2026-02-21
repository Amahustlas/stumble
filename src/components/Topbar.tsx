type TopbarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  tileSize: number;
  onTileSizeChange: (value: number) => void;
  onAddUrl: () => void;
  onImport: () => void;
};

function Topbar({
  searchQuery,
  onSearchChange,
  tileSize,
  onTileSizeChange,
  onAddUrl,
  onImport,
}: TopbarProps) {
  return (
    <header className="topbar">
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
    </header>
  );
}

export default Topbar;
