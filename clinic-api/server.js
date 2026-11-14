"use strict";
/**
 * Clinic booking API: Koya Cohort 4 assessment, Task 1.
 * Express + Postgres. All API routes require the X-API-Key header.
 * The demo web page lives at /app (static, no key needed to load it).
 */
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
if (!API_KEY) throw new Error("API_KEY env var is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL env var is required");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 10,
});

const RATE_LIMIT = 5; // attempts per email per window
const RATE_WINDOW_MS = 60 * 1000;

// ---------- schema ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      pk        BIGSERIAL PRIMARY KEY,
      slot_id   TEXT NOT NULL UNIQUE,   -- id as text, for lookups
      slot_json JSONB NOT NULL,         -- the slot exactly as it was sent
      provider  TEXT,
      start_at  TIMESTAMPTZ NOT NULL,
      end_at    TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS bookings (
      seq        BIGSERIAL PRIMARY KEY, -- insertion order, used for paging
      id         TEXT NOT NULL UNIQUE,
      slot_pk    BIGINT NOT NULL,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      status     TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- The guarantee behind level 3: a slot can have only one confirmed booking.
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
      ON bookings (slot_pk) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);
    CREATE TABLE IF NOT EXISTS idempotency (
      key           TEXT PRIMARY KEY,
      request_hash  TEXT NOT NULL,
      status_code   INT NOT NULL,
      response_json JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id    BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      at_ms BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempts_email_at ON attempts (email, at_ms);
  `);
}

// ---------- helpers ----------
const app = express();
app.disable("x-powered-by");

function send(res, status, body) {
  return res.status(status).json(body);
}
const fail = (res, status, message) => send(res, status, { error: message });

function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bookingOut(row, slotJson) {
  return {
    id: row.id,
    slot_id: slotJson ? slotJson.id : row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

// Run fn(client) inside a transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

// ---------- middleware ----------
// Static demo page (served before auth so a browser can load it).
app.use("/app", express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  const given = req.get("X-API-Key") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return fail(res, 401, "Missing or invalid API key");
  next();
});

app.use(express.json({ limit: "2mb" }));

// ---------- POST /reset ----------
app.post("/reset", async (req, res, next) => {
  try {
    const slots = req.body && req.body.slots;
    if (!Array.isArray(slots)) return fail(res, 400, "Body must be {\"slots\": [...]}");
    const prepared = [];
    const seen = new Set();
    for (const s of slots) {
      if (!s || typeof s !== "object" || s.id === undefined || s.id === null || s.id === "") {
        return fail(res, 400, "Every slot needs an id");
      }
      const start = new Date(s.start);
      if (isNaN(start.getTime())) return fail(res, 400, "Every slot needs a valid start");
      const end = s.end ? new Date(s.end) : null;
      if (end && isNaN(end.getTime())) return fail(res, 400, "Invalid end");
      const sid = String(s.id);
      if (seen.has(sid)) return fail(res, 400, "Duplicate slot id: " + sid);
      seen.add(sid);
      prepared.push({ sid, json: s, provider: s.provider == null ? null : String(s.provider), start, end });
    }
    await tx(async (c) => {
      await c.query("TRUNCATE bookings, slots, idempotency, attempts RESTART IDENTITY");
      for (const p of prepared) {
        await c.query(
          "INSERT INTO slots (slot_id, slot_json, provider, start_at, end_at) VALUES ($1,$2,$3,$4,$5)",
          [p.sid, JSON.stringify(p.json), p.provider, p.start, p.end]
        );
      }
    });
    send(res, 200, { slots: prepared.length });
  } catch (e) { next(e); }
});

// ---------- GET /slots ----------
app.get("/slots", async (req, res, next) => {
  try {
    const params = [];
    let where = "";
    if (req.query.provider !== undefined) {
      params.push(String(req.query.provider));
      where = "WHERE s.provider = $1";
    }
    const { rows } = await pool.query(
      `SELECT s.slot_json,
              EXISTS (SELECT 1 FROM bookings b WHERE b.slot_pk = s.pk AND b.status = 'confirmed') AS booked
         FROM slots s ${where}
         ORDER BY s.start_at ASC, s.pk ASC`,
      params
    );
    send(res, 200, { slots: rows.map((r) => ({ ...r.slot_json, available: !r.booked })) });
  } catch (e) { next(e); }
});

// ---------- POST /bookings ----------
app.post("/bookings", async (req, res, next) => {
  try {
    const raw = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const idemKey = req.get("Idempotency-Key") || null;
    const bodyHash = crypto.createHash("sha256").update(stableStringify(raw)).digest("hex");

    // Normalise (level 2): trim name and email, lowercase email.
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";

    // One transaction per request. Advisory locks serialise requests that share
    // an Idempotency-Key or an email, so retries and rate limits are exact.
    const result = await tx(async (c) => {
      if (idemKey) {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [idemKey]);
        const prev = await c.query("SELECT request_hash, status_code, response_json FROM idempotency WHERE key = $1", [idemKey]);
        if (prev.rows.length) {
          if (prev.rows[0].request_hash !== bodyHash) {
            return { status: 422, body: { error: "Idempotency-Key was already used with a different request body" } };
          }
          return { status: prev.rows[0].status_code, body: prev.rows[0].response_json };
        }
      }

      // Level 5: max 5 attempts per email per minute (failed attempts count).
      if (email) {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [email]);
        const now = Date.now();
        const since = now - RATE_WINDOW_MS;
        await c.query("DELETE FROM attempts WHERE email = $1 AND at_ms <= $2", [email, since]);
        const cnt = await c.query("SELECT COUNT(*)::int AS n, MIN(at_ms) AS oldest FROM attempts WHERE email = $1", [email]);
        if (cnt.rows[0].n >= RATE_LIMIT) {
          const oldest = Number(cnt.rows[0].oldest);
          const retry = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
          return { status: 429, body: { error: "Too many booking attempts, try again later" }, retryAfter: retry };
        }
        await c.query("INSERT INTO attempts (email, at_ms) VALUES ($1, $2)", [email, now]);
      }

      // Level 2: validation.
      if (raw.slot_id === undefined || raw.slot_id === null || raw.slot_id === "" || typeof raw.slot_id === "object") {
        return { status: 400, body: { error: "slot_id is required" } };
      }
      if (!name) return { status: 400, body: { error: "name is required" } };
      if (!email) return { status: 400, body: { error: "email is required" } };
      if (!EMAIL_RE.test(email)) return { status: 400, body: { error: "email is not valid" } };

      const slotRes = await c.query("SELECT pk, slot_json, start_at FROM slots WHERE slot_id = $1", [String(raw.slot_id)]);
      if (!slotRes.rows.length) return { status: 404, body: { error: "Slot not found" } };
      const slot = slotRes.rows[0];
      if (new Date(slot.start_at).getTime() <= Date.now()) {
        return { status: 400, body: { error: "Slot has already started" } };
      }

      // Level 3: the partial unique index decides who wins a race.
      await c.query("SAVEPOINT book");
      let inserted;
      try {
        inserted = await c.query(
          `INSERT INTO bookings (id, slot_pk, name, email, status)
           VALUES ($1, $2, $3, $4, 'confirmed')
           RETURNING id, name, email, status, created_at`,
          [crypto.randomUUID(), slot.pk, name, email]
        );
      } catch (e) {
        if (e.code === "23505") {
          await c.query("ROLLBACK TO SAVEPOINT book");
          return { status: 409, body: { error: "Slot is already booked" } };
        }
        throw e;
      }
      const out = bookingOut({ ...inserted.rows[0], slot_id: String(raw.slot_id) }, slot.slot_json);

      if (idemKey) {
        await c.query(
          "INSERT INTO idempotency (key, request_hash, status_code, response_json) VALUES ($1,$2,$3,$4)",
          [idemKey, bodyHash, 201, JSON.stringify(out)]
        );
      }
      return { status: 201, body: out };
    });

    if (result.retryAfter) res.set("Retry-After", String(result.retryAfter));
    send(res, result.status, result.body);
  } catch (e) { next(e); }
});

// ---------- GET /bookings ----------
app.get("/bookings", async (req, res, next) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    if (!email) return fail(res, 400, "email query parameter is required");

    let limit = 10;
    if (req.query.limit !== undefined) {
      const l = String(req.query.limit);
      if (!/^\d+$/.test(l)) return fail(res, 400, "limit must be an integer from 1 to 50");
      limit = parseInt(l, 10);
      if (limit < 1 || limit > 50) return fail(res, 400, "limit must be an integer from 1 to 50");
    }

    let after = 0;
    if (req.query.cursor !== undefined && req.query.cursor !== "") {
      const decoded = Buffer.from(String(req.query.cursor), "base64url").toString("utf8");
      if (!/^c:\d+$/.test(decoded)) return fail(res, 400, "Invalid cursor");
      after = parseInt(decoded.slice(2), 10);
    }

    const { rows } = await pool.query(
      `SELECT b.seq, b.id, b.name, b.email, b.status, b.created_at, s.slot_json
         FROM bookings b JOIN slots s ON s.pk = b.slot_pk
        WHERE b.email = $1 AND b.seq > $2
        ORDER BY b.seq ASC
        LIMIT $3`,
      [email, after, limit + 1]
    );
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const next_cursor = hasMore ? Buffer.from("c:" + page[page.length - 1].seq).toString("base64url") : null;
    send(res, 200, { bookings: page.map((r) => bookingOut(r, r.slot_json)), next_cursor });
  } catch (e) { next(e); }
});

// ---------- GET /bookings/:id ----------
app.get("/bookings/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.email, b.status, b.created_at, s.slot_json
         FROM bookings b JOIN slots s ON s.pk = b.slot_pk WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return fail(res, 404, "Booking not found");
    send(res, 200, bookingOut(rows[0], rows[0].slot_json));
  } catch (e) { next(e); }
});

// ---------- DELETE /bookings/:id ----------
app.delete("/bookings/:id", async (req, res, next) => {
  try {
    const out = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT b.id, b.name, b.email, b.status, b.created_at, s.slot_json
           FROM bookings b JOIN slots s ON s.pk = b.slot_pk WHERE b.id = $1 FOR UPDATE OF b`,
        [req.params.id]
      );
      if (!rows.length) return { status: 404, body: { error: "Booking not found" } };
      if (rows[0].status === "cancelled") return { status: 409, body: { error: "Booking is already cancelled" } };
      await c.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [req.params.id]);
      return { status: 200, body: bookingOut({ ...rows[0], status: "cancelled" }, rows[0].slot_json) };
    });
    send(res, out.status, out.body);
  } catch (e) { next(e); }
});

// ---------- fallbacks ----------
app.use((req, res) => fail(res, 404, "Not found"));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return fail(res, 400, "Request body is not valid JSON");
  }
  console.error(err);
  fail(res, 500, "Internal server error");
});

// ---------- seed demo slots so the web page has something to show ----------
async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM slots");
  if (rows[0].n > 0) return;
  const providers = ["Dr. Adeyemi", "Dr. Okafor"];
  const base = new Date();
  base.setUTCHours(9, 0, 0, 0);
  let id = 1;
  for (let day = 1; day <= 5; day++) {
    for (const [pi, provider] of providers.entries()) {
      for (let h = 0; h < 3; h++) {
        const start = new Date(base.getTime() + day * 86400000 + (h * 2 + pi) * 3600000);
        const end = new Date(start.getTime() + 3600000);
        const sid = "slot-" + id++;
        const json = { id: sid, provider, start: start.toISOString(), end: end.toISOString() };
        await pool.query(
          "INSERT INTO slots (slot_id, slot_json, provider, start_at, end_at) VALUES ($1,$2,$3,$4,$5)",
          [sid, JSON.stringify(json), provider, start, end]
        );
      }
    }
  }
}

if (require.main === module) {
  initDb()
    .then(seedIfEmpty)
    .then(() => app.listen(PORT, () => console.log("Listening on " + PORT)))
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { app, initDb, pool };
