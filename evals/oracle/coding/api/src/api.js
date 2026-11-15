export class NotFoundError extends Error {}

export class ApiError extends Error {
  constructor(status, message) {
    super(message ?? `request failed with status ${status}`);
    this.status = status;
  }
}

const BASE = 'https://api.example.com';

export async function fetchUser(id, fetchImpl = fetch) {
  const res = await fetchImpl(`${BASE}/users/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new NotFoundError(`user ${id} not found`);
  if (!res.ok) throw new ApiError(res.status);
  return res.json();
}
