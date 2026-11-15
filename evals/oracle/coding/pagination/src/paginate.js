export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
export function pageCount(total, pageSize) {
  return Math.ceil(total / pageSize);
}
