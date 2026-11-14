"use strict";
// Run: API_KEY=testkey DATABASE_URL=postgres://... node test.js
const assert = require("assert");
const { app, initDb, pool } = require("./server");

const KEY = process.env.API_KEY;
let base;
const call = (method, path, body, headers = {}, key = KEY) =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));

const hour = 3600000;
const future = (h) => new Date(Date.now() + h * hour).toISOString();
const past = (h) => new Date(Date.now() - h * hour).toISOString();
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("  ok  " + name); };

(async () => {
  await initDb();
  const server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  const slots = [
    { id: "s1", provider: "dr-a", start: future(2), end: future(3) },
    { id: "s2", provider: "dr-b", start: future(1), end: future(2) },
    { id: "s3", provider: "dr-a", start: future(4), end: future(5) },
    { id: "s4", provider: "dr-a", start: future(6), end: future(7) },
    { id: "past", provider: "dr-a", start: past(2), end: past(1) },
  ];
  const reset = () => call("POST", "/reset", { slots });

  console.log("Level 1");
  await t("reset replaces slots", async () => { const r = await reset(); assert.equal(r.status, 200); });
  await t("slots sorted by start, with available flag", async () => {
    const r = await call("GET", "/slots");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.slots.map((s) => s.id), ["past", "s2", "s1", "s3", "s4"]);
    assert.ok(r.body.slots.every((s) => s.available === true));
  });
  await t("provider filter is an exact match", async () => {
    const r = await call("GET", "/slots?provider=dr-b");
    assert.deepEqual(r.body.slots.map((s) => s.id), ["s2"]);
    assert.equal((await call("GET", "/slots?provider=dr")).body.slots.length, 0);
  });
  let booking;
  await t("book + lookup", async () => {
    const r = await call("POST", "/bookings", { slot_id: "s1", name: "Ada", email: "ada@example.com" });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "confirmed");
    assert.equal(r.body.slot_id, "s1");
    booking = r.body;
    const g = await call("GET", "/bookings/" + booking.id);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body, booking);
    assert.equal((await call("GET", "/bookings/nope")).status, 404);
  });
  await t("booked slot shows available=false", async () => {
    const r = await call("GET", "/slots");
    assert.equal(r.body.slots.find((s) => s.id === "s1").available, false);
  });

  console.log("Level 2");
  await t("401 without / with wrong key, on every route", async () => {
    for (const [m, p] of [["GET", "/slots"], ["POST", "/bookings"], ["GET", "/bookings?email=a@b.co"], ["GET", "/bookings/x"], ["DELETE", "/bookings/x"], ["POST", "/reset"]]) {
      assert.equal((await call(m, p, m === "GET" || m === "DELETE" ? undefined : {}, {}, null)).status, 401, m + p);
      const w = await call(m, p, m === "GET" || m === "DELETE" ? undefined : {}, {}, "wrong");
      assert.equal(w.status, 401);
      assert.ok(typeof w.body.error === "string");
    }
  });
  await reset();
  await t("validation: missing/empty/invalid -> 400", async () => {
    const bad = [
      {}, { slot_id: "s1" }, { slot_id: "s1", name: "A" }, { slot_id: "s1", email: "a@b.co" },
      { slot_id: "s1", name: "   ", email: "a@b.co" }, { slot_id: "s1", name: "A", email: "   " },
      { slot_id: "s1", name: "A", email: "not-an-email" }, { name: "A", email: "a@b.co" },
      { slot_id: "s1", name: 5, email: "a@b.co" },
    ];
    for (const b of bad) assert.equal((await call("POST", "/bookings", b)).status, 400, JSON.stringify(b));
    assert.equal((await call("POST", "/bookings", "{bad json")).status, 400);
  });
  await t("unknown slot 404, started slot 400", async () => {
    await reset();
    assert.equal((await call("POST", "/bookings", { slot_id: "zzz", name: "A", email: "v1@x.co" })).status, 404);
    assert.equal((await call("POST", "/bookings", { slot_id: "past", name: "A", email: "v2@x.co" })).status, 400);
  });
  await t("trims name/email, lowercases email", async () => {
    await reset();
    const r = await call("POST", "/bookings", { slot_id: "s1", name: "  Ada L  ", email: "  ADA@Example.COM " });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, "Ada L");
    assert.equal(r.body.email, "ada@example.com");
  });

  console.log("Level 3");
  await t("second booking of same slot -> 409", async () => {
    await reset();
    assert.equal((await call("POST", "/bookings", { slot_id: "s1", name: "A", email: "c1@x.co" })).status, 201);
    assert.equal((await call("POST", "/bookings", { slot_id: "s1", name: "B", email: "c2@x.co" })).status, 409);
  });
  await t("50 simultaneous requests for one slot: exactly one wins", async () => {
    await reset();
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => call("POST", "/bookings", { slot_id: "s3", name: "P" + i, email: `race${i}@x.co` })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 49);
  });
  await t("cancel frees the slot; double-cancel 409; unknown 404", async () => {
    await reset();
    const b = (await call("POST", "/bookings", { slot_id: "s2", name: "A", email: "k1@x.co" })).body;
    const d = await call("DELETE", "/bookings/" + b.id);
    assert.equal(d.status, 200);
    assert.equal(d.body.status, "cancelled");
    assert.equal((await call("DELETE", "/bookings/" + b.id)).status, 409);
    assert.equal((await call("DELETE", "/bookings/nope")).status, 404);
    assert.equal((await call("GET", "/slots")).body.slots.find((s) => s.id === "s2").available, true);
    assert.equal((await call("POST", "/bookings", { slot_id: "s2", name: "B", email: "k2@x.co" })).status, 201);
  });

  console.log("Level 4");
  await t("same idempotency key + body -> same status/id, one booking", async () => {
    await reset();
    const h = { "Idempotency-Key": "key-1" };
    const body = { slot_id: "s1", name: "A", email: "i1@x.co" };
    const a = await call("POST", "/bookings", body, h);
    const b = await call("POST", "/bookings", body, h);
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    assert.equal(a.body.id, b.body.id);
    assert.equal((await call("GET", "/bookings?email=i1@x.co")).body.bookings.length, 1);
  });
  await t("idempotency key reused with different body -> 422", async () => {
    const r = await call("POST", "/bookings", { slot_id: "s2", name: "A", email: "i1@x.co" }, { "Idempotency-Key": "key-1" });
    assert.equal(r.status, 422);
  });
  await t("10 simultaneous retries with one key -> one booking, same id", async () => {
    await reset();
    const body = { slot_id: "s4", name: "A", email: "i2@x.co" };
    const rs = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/bookings", body, { "Idempotency-Key": "burst" })));
    assert.ok(rs.every((r) => r.status === 201));
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  });
  await t("paging: oldest first, limit/cursor, case-insensitive email", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: "m" + i, provider: "p", start: future(10 + i), end: future(11 + i) }));
    await call("POST", "/reset", { slots: many });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await call("POST", "/bookings", { slot_id: "m" + i, name: "N", email: "Page@X.co" })).body.id);
    await call("POST", "/bookings", { slot_id: "m4", name: "N", email: "other@x.co" });
    const p1 = await call("GET", "/bookings?email=PAGE@x.CO&limit=3");
    assert.deepEqual(p1.body.bookings.map((b) => b.id), ids.slice(0, 3));
    assert.ok(p1.body.next_cursor);
    const p2 = await call("GET", "/bookings?email=page@x.co&limit=3&cursor=" + encodeURIComponent(p1.body.next_cursor));
    assert.deepEqual(p2.body.bookings.map((b) => b.id), ids.slice(3));
    assert.equal(p2.body.next_cursor, null);
    const exact = await call("GET", "/bookings?email=page@x.co&limit=4");
    assert.equal(exact.body.next_cursor, null);
  });
  await t("limit/email validation", async () => {
    for (const q of ["limit=0", "limit=51", "limit=abc", "limit=1.5", "limit=-1"]) {
      assert.equal((await call("GET", `/bookings?email=a@b.co&${q}`)).status, 400, q);
    }
    assert.equal((await call("GET", "/bookings")).status, 400);
    assert.equal((await call("GET", "/bookings?email=a@b.co&limit=50")).status, 200);
    assert.equal((await call("GET", "/bookings?email=a@b.co")).status, 200);
  });

  console.log("Level 5");
  await t("6th attempt in a minute -> 429 + Retry-After; others unaffected", async () => {
    await reset();
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await call("POST", "/bookings", { slot_id: "nope", name: "S", email: "spam@x.co" }));
    assert.ok(rs.every((r) => r.status === 404)); // failed attempts count
    const sixth = await call("POST", "/bookings", { slot_id: "s1", name: "S", email: "SPAM@x.co" });
    assert.equal(sixth.status, 429);
    const ra = Number(sixth.headers.get("Retry-After"));
    assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, "Retry-After " + ra);
    assert.equal((await call("POST", "/bookings", { slot_id: "s1", name: "S", email: "fine@x.co" })).status, 201);
  });
  await t("simultaneous spam: at most 5 get through", async () => {
    await reset();
    const rs = await Promise.all(Array.from({ length: 12 }, () => call("POST", "/bookings", { slot_id: "nope", name: "S", email: "burst@x.co" })));
    assert.equal(rs.filter((r) => r.status === 404).length, 5);
    assert.equal(rs.filter((r) => r.status === 429).length, 7);
  });

  console.log(`\nAll ${passed} checks passed`);
  server.close(); await pool.end();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
