// Returns the items on the given page of results.
export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}

// Number of pages needed to show `total` results.
export function pageCount(total, pageSize) {
  return Math.floor(total / pageSize);
}
