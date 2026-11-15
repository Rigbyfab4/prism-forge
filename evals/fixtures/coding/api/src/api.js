export class NotFoundError extends Error {}

export class ApiError extends Error {
  constructor(status, message) {
    super(message ?? `request failed with status ${status}`);
    this.status = status;
  }
}

const BASE = 'https://api.example.com';

// Loads a user by id. `fetchImpl` defaults to the global fetch (tests pass a fake).
export async function fetchUser(id, fetchImpl = fetch) {
  const res = await fetchImpl(`${BASE}/users/${encodeURIComponent(id)}`);
  return res.json();
}
