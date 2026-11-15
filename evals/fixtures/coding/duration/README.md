# duration

## parseDuration(str) -> number

Parses a human duration string and returns the number of **seconds**.

- Units: `h` (hours), `m` (minutes), `s` (seconds). Case-insensitive.
- Each component is a non-negative integer followed by its unit, e.g. `90m`, `1h30m`, `45s`.
- Components may be separated by whitespace (`1h 5m 10s`); leading/trailing whitespace is ignored.
- Each unit may appear at most once, and units must appear in the order h, m, s.
- Anything else (empty string, a bare number, an unknown unit, a decimal, a negative number,
  a repeated or out-of-order unit) throws a `TypeError`.

Examples: `"2h"` -> 7200, `"1h30m"` -> 5400, `"1H 5m 10s"` -> 3910, `"0s"` -> 0.
