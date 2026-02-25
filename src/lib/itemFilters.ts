export type ItemListSortOption = "newest" | "oldest" | "name-asc" | "rating-desc";

export const ADVANCED_ITEM_FILTER_TYPE_OPTIONS = [
  "image",
  "video",
  "file",
  "bookmark",
  "note",
] as const;

export type AdvancedItemFilterType = (typeof ADVANCED_ITEM_FILTER_TYPE_OPTIONS)[number];

export type AdvancedItemFilters = {
  types: AdvancedItemFilterType[];
  tagIds: string[];
  minRating: number;
  favoritesOnly: boolean;
};

type FilterableItemType = "bookmark" | "image" | "video" | "pdf" | "file" | "note";

type FilterableItem = {
  id: string;
  filename: string;
  type: FilterableItemType;
  title: string;
  description: string;
  rating: number;
  isFavorite: boolean;
  tagIds: string[];
  tags?: string[];
  createdAt: string;
  sourceUrl?: string;
  url?: string;
  hostname?: string;
  noteText?: string;
};

type FilterItemsArgs<TItem extends FilterableItem> = {
  items: TItem[];
  searchQuery: string;
  filters: AdvancedItemFilters;
  sortOption: ItemListSortOption;
  skipSort?: boolean;
};

export function createDefaultAdvancedItemFilters(): AdvancedItemFilters {
  return {
    types: [],
    tagIds: [],
    minRating: 0,
    favoritesOnly: false,
  };
}

export function hasActiveAdvancedItemFilters(filters: AdvancedItemFilters): boolean {
  return (
    filters.types.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.minRating > 0 ||
    filters.favoritesOnly
  );
}

export function normalizeAdvancedItemFilters(value: unknown): AdvancedItemFilters {
  const fallback = createDefaultAdvancedItemFilters();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const record = value as Partial<Record<keyof AdvancedItemFilters, unknown>>;
  const validTypeSet = new Set<string>(ADVANCED_ITEM_FILTER_TYPE_OPTIONS);
  const nextTypes = Array.isArray(record.types)
    ? Array.from(
        new Set(
          record.types.filter(
            (entry): entry is AdvancedItemFilterType =>
              typeof entry === "string" && validTypeSet.has(entry),
          ),
        ),
      )
    : fallback.types;
  const nextTagIds = Array.isArray(record.tagIds)
    ? Array.from(
        new Set(
          record.tagIds.filter(
            (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
          ),
        ),
      )
    : fallback.tagIds;
  const minRatingRaw = typeof record.minRating === "number" ? record.minRating : 0;
  const minRating = Number.isFinite(minRatingRaw)
    ? Math.max(0, Math.min(5, Math.round(minRatingRaw)))
    : 0;

  return {
    types: nextTypes,
    tagIds: nextTagIds,
    minRating,
    favoritesOnly: Boolean(record.favoritesOnly),
  };
}

export function formatAdvancedItemFilterTypeLabel(type: AdvancedItemFilterType): string {
  switch (type) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "file":
      return "File";
    case "bookmark":
      return "Bookmark";
    case "note":
      return "Note";
    default:
      return type;
  }
}

function normalizeItemRating(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(5, Math.round(value)));
}

function dateSortValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareItemsBySortOption<TItem extends FilterableItem>(
  left: TItem,
  right: TItem,
  sortOption: ItemListSortOption,
): number {
  if (sortOption === "name-asc") {
    const nameCompare = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return right.id.localeCompare(left.id);
  }

  if (sortOption === "rating-desc") {
    const leftRating = normalizeItemRating(left.rating);
    const rightRating = normalizeItemRating(right.rating);
    if (leftRating !== rightRating) {
      return rightRating - leftRating;
    }
    const createdDelta = dateSortValue(right.createdAt) - dateSortValue(left.createdAt);
    if (createdDelta !== 0) {
      return createdDelta;
    }
    return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  }

  const leftCreatedAt = dateSortValue(left.createdAt);
  const rightCreatedAt = dateSortValue(right.createdAt);
  if (leftCreatedAt !== rightCreatedAt) {
    return sortOption === "oldest"
      ? leftCreatedAt - rightCreatedAt
      : rightCreatedAt - leftCreatedAt;
  }

  return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
}

function itemTypeToFilterBucket(itemType: FilterableItemType): AdvancedItemFilterType | null {
  switch (itemType) {
    case "image":
    case "video":
    case "bookmark":
    case "note":
      return itemType;
    case "file":
    case "pdf":
      return "file";
    default:
      return null;
  }
}

export function filterItems<TItem extends FilterableItem>(args: FilterItemsArgs<TItem>): TItem[] {
  const { items, searchQuery, filters, sortOption, skipSort = false } = args;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const selectedTypes = filters.types.length > 0 ? new Set(filters.types) : null;
  const selectedTagIds = filters.tagIds.length > 0 ? new Set(filters.tagIds) : null;
  const minRating = filters.minRating > 0 ? filters.minRating : 0;

  const filtered = items.filter((item) => {
    if (filters.favoritesOnly && !item.isFavorite) {
      return false;
    }

    if (selectedTypes) {
      const bucket = itemTypeToFilterBucket(item.type);
      if (!bucket || !selectedTypes.has(bucket)) {
        return false;
      }
    }

    if (selectedTagIds) {
      const hasMatchingTag = item.tagIds.some((tagId) => selectedTagIds.has(tagId));
      if (!hasMatchingTag) {
        return false;
      }
    }

    if (minRating > 0 && normalizeItemRating(item.rating) < minRating) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    const searchableValues = [
      item.title,
      item.filename,
      item.description,
      item.sourceUrl ?? item.url,
      item.hostname,
      item.noteText,
      item.tags?.join(" "),
    ];

    return searchableValues
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .some((value) => value.toLowerCase().includes(normalizedQuery));
  });

  if (skipSort) {
    return filtered;
  }

  return filtered.slice().sort((left, right) => compareItemsBySortOption(left, right, sortOption));
}
