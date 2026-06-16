import assert from "node:assert/strict";
import test from "node:test";
import { issueChallenge, verifyChallenge, scoreBehavior } from "../src/flux-core.mjs";
import { clearMemoryStoreForTests } from "../src/store.mjs";

function req(cookie = "") {
  return { headers: { cookie }, socket: { remoteAddress: "127.0.0.1" } };
}

function res() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    }
  };
}

function cookieFrom(response) {
  return response.headers["Set-Cookie"].split(";", 1)[0];
}

function slotCenter(slot) {
  const tile = 128;
  const col = slot % 3;
  const row = Math.floor(slot / 3);
  return [col * tile + tile / 2, row * tile + tile / 2];
}

function operationEvents(challenge, targetMapping, includeClick = true) {
  const events = [];
  const tileToSlot = new Map(challenge.tiles.map((tile) => [tile.id, tile.start_slot]));
  let t = 0;
  let guard = 0;
  while ([...Array(9).keys()].some((id) => tileToSlot.get(id) !== targetMapping[id])) {
    const tileId = [...Array(9).keys()].find((id) => tileToSlot.get(id) !== targetMapping[id]);
    const fromSlot = tileToSlot.get(tileId);
    const toSlot = targetMapping[tileId];
    const [sx, sy] = slotCenter(fromSlot);
    const [ex, ey] = slotCenter(toSlot);
    events.push({ type: "down", x: sx, y: sy, t, tile_id: tileId, from_slot: fromSlot });
    for (let step = 1; step <= 8; step += 1) {
      const u = step / 8;
      const bend = Math.sin(Math.PI * u);
      t += step === 4 ? 160 : 76;
      events.push({
        type: "move",
        x: sx + (ex - sx) * u + 22 * bend,
        y: sy + (ey - sy) * u + (step % 2 ? 12 : -9) * bend,
        t
      });
    }
    t += 90;
    events.push({ type: "swap", x: ex, y: ey, t, tile_id: tileId, from_slot: fromSlot, to_slot: toSlot });
    const other = [...tileToSlot.entries()].find(([, slot]) => slot === toSlot)[0];
    tileToSlot.set(tileId, toSlot);
    tileToSlot.set(other, fromSlot);
    t += 85;
    events.push({ type: "up", x: ex, y: ey, t, tile_id: tileId, from_slot: fromSlot, to_slot: toSlot });
    t += 130;
    guard += 1;
    assert.ok(guard <= 9);
  }
  if (includeClick) {
    t += 240;
    events.push({ type: "verify_click", x: 220, y: 470, t, target: "check" });
  }
  return events;
}

test("manual verify intent gates otherwise correct solutions", async () => {
  clearMemoryStoreForTests();
  const r1 = res();
  const challenge = await issueChallenge(req(), r1);
  const cookie = cookieFrom(r1);
  const answer = [...Array(9).keys()];
  const withoutClick = await verifyChallenge(req(cookie), {
    challenge_id: challenge.challenge_id,
    mapping: answer,
    events: operationEvents(challenge, answer, false)
  });
  assert.equal(withoutClick.status, 200);
  assert.deepEqual(withoutClick.body, { pass: false, reason: "verification_failed" });

  const r2 = res();
  const challenge2 = await issueChallenge(req(), r2);
  const cookie2 = cookieFrom(r2);
  const withClick = await verifyChallenge(req(cookie2), {
    challenge_id: challenge2.challenge_id,
    mapping: answer,
    events: operationEvents(challenge2, answer, true)
  });
  assert.equal(withClick.status, 200);
  assert.deepEqual(withClick.body, { pass: true });
});

test("replay is rejected after a successful challenge", async () => {
  clearMemoryStoreForTests();
  const response = res();
  const challenge = await issueChallenge(req(), response);
  const cookie = cookieFrom(response);
  const answer = [...Array(9).keys()];
  const payload = {
    challenge_id: challenge.challenge_id,
    mapping: answer,
    events: operationEvents(challenge, answer, true)
  };
  const first = await verifyChallenge(req(cookie), payload);
  const second = await verifyChallenge(req(cookie), payload);
  assert.deepEqual(first.body, { pass: true });
  assert.equal(second.body.pass, false);
});

test("behavior scorer rejects straight robotic motion", () => {
  const events = [
    { type: "down", x: 0, y: 0, t: 0 },
    { type: "move", x: 20, y: 20, t: 80 },
    { type: "move", x: 40, y: 40, t: 160 },
    { type: "up", x: 60, y: 60, t: 240 },
    { type: "verify_click", x: 80, y: 80, t: 320, target: "check" }
  ];
  const score = scoreBehavior(events);
  assert.equal(score.straight_robotic, 1);
  assert.ok(score.score <= 0.35);
});
