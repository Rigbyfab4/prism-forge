# cache-service

We keep ~100k session records in an in-process cache keyed by session id (UUID strings)
and look them up on every request.
