import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, normalizeMeal } from "../worker/index.js";

const env = {
  APP_TOKEN: "test-access-code",
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_MODEL: "gemini-3.8-flash",
  ALLOWED_ORIGIN: "https://sejyta-main.github.io"
};

function request(path, body, overrides = {}) {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer test-access-code",
      "Content-Type": "application/json",
      "Origin": "https://sejyta-main.github.io",
      ...(overrides.headers || {})
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
}

const generateMeal = async () => JSON.stringify(validMeal);

const validMeal = {
  name: "Chicken and rice",
  items: [{ item: "Chicken breast", est: "150 g" }, { item: "Rice", est: "180 g" }],
  kcal: 560,
  protein: 50,
  carbs: 58,
  fat: 14,
  sat_fat: 3,
  gluten_risk: "none",
  gluten_note: "",
  confidence: "medium",
  assumptions: ["One teaspoon cooking oil"],
  questions: ["Was extra oil used?"]
};

test("normalizes and caps nutrition values", () => {
  const meal = normalizeMeal({ ...validMeal, fat: 5, sat_fat: 9 });
  assert.equal(meal.sat_fat, 5);
  assert.equal(meal.items.length, 2);
});

test("rejects missing access code", async () => {
  const response = await handleRequest(request("/health", null, { headers: { Authorization: "" } }), env, { generate: generateMeal });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "ACCESS_DENIED");
});

test("rejects an unapproved website origin", async () => {
  const response = await handleRequest(request("/health", null, { headers: { Origin: "https://attacker.example" } }), env, { generate: generateMeal });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ORIGIN_DENIED");
});

test("health performs a real Gemini request", async () => {
  let calls = 0;
  const response = await handleRequest(request("/health", null), env, { generate: async () => { calls += 1; return JSON.stringify(validMeal); } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test("returns a validated description estimate", async () => {
  const response = await handleRequest(request("/analyze", { kind: "description", description: "150 g chicken and rice" }), env, { generate: generateMeal });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.meal.name, "Chicken and rice");
  assert.equal(result.meal.kcal, 560);
});

test("rejects unsupported photo data", async () => {
  const response = await handleRequest(request("/analyze", { kind: "photo", image: { mimeType: "image/heic", data: "abc" } }), env, { generate: generateMeal });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_INPUT");
});

test("maps Gemini quota errors and retries once", async () => {
  let calls = 0;
  const response = await handleRequest(request("/analyze", { kind: "description", description: "banana" }), env, {
    generate: async () => { calls += 1; const error = new Error("upstream failure"); error.status = 429; throw error; }
  });
  const result = await response.json();
  assert.equal(response.status, 429);
  assert.equal(result.error.code, "GEMINI_ERROR");
  assert.equal(result.error.retryable, true);
  assert.equal(calls, 2);
});
