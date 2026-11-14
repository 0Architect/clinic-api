# Clinic booking API

Booking API plus a small web page for the Koya Cohort 4 assessment (Task 1).
Node 18+, Express, Postgres. Implements levels 1 to 5 of the spec at koyaacademy.com/assessment-api.

- API: every route needs the `X-API-Key` header.
- Web page: `/app/` (static, loads without a key; paste the key into the box, or open `/app/#key=YOUR_KEY` once).

## Run locally

```
npm install
export API_KEY=some-long-random-string
export DATABASE_URL=postgres://user:pass@localhost:5432/clinic
npm start          # http://localhost:3000/app/
npm test           # runs the 19 checks (uses the same two env vars; it resets the DB)
```

Tables are created automatically on start. If the database is empty, a few demo slots are added so the page has something to show. `POST /reset` replaces them.

## How each level works

| Level | Approach |
|---|---|
| 1 | Slots and bookings live in Postgres, so they survive restarts and redeploys. |
| 2 | One middleware checks `X-API-Key` (constant-time compare) before everything. Bodies are validated; `name`/`email` are trimmed and the email is lowercased. |
| 3 | A partial unique index, `one confirmed booking per slot`, makes the database the referee. Two simultaneous requests cannot both insert; the loser gets 409. Cancelling sets `status = 'cancelled'`, which drops the row out of the index and frees the slot. |
| 4 | `Idempotency-Key`: a per-key advisory lock plus a stored response means retries (even simultaneous ones) return the same status and booking id. A different body with the same key returns 422. Paging uses an opaque cursor over an insertion sequence, so results are stable oldest-first. |
| 5 | A per-email sliding window (5 attempts per 60s, failed attempts counted) kept in Postgres and guarded by an advisory lock, so a burst cannot sneak past it. The 429 carries `Retry-After` in whole seconds. |

## Deploy (free): Neon + Render

1. **Database.** Sign up at neon.tech, create a project, copy the connection string (it ends in `?sslmode=require`).
2. **GitHub.** Create a public repo, push this folder (`node_modules` is git-ignored).
3. **Render.** New > Web Service > pick the repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables: `API_KEY` (make one: `openssl rand -hex 16`) and `DATABASE_URL` (the Neon string).
4. **Check it:**
   ```
   curl -H "X-API-Key: YOUR_KEY" https://YOUR-APP.onrender.com/slots
   ```
   Then open `https://YOUR-APP.onrender.com/app/#key=YOUR_KEY`.

Note: Render's free web services go to sleep after idle time, and the first request after that can take around a minute. Open the URL yourself shortly before submitting and check it responds.
