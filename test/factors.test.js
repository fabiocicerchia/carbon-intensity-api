import assert from "node:assert/strict";
import { test } from "node:test";
import { mixToDirectIntensity } from "../src/factors.js";

test("weights by generation", () => {
  assert.ok(Math.abs(mixToDirectIntensity({ gas: 1000, solar: 500 }) - 470000 / 1500) < 1e-6);
});

test("ignores non-positive values", () => {
  assert.ok(Math.abs(mixToDirectIntensity({ gas: 1000, hydro: -200, wind: 0 }) - 470) < 1e-6);
});

test("null when empty", () => {
  assert.equal(mixToDirectIntensity({}), null);
  assert.equal(mixToDirectIntensity({ gas: 0 }), null);
});
