import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, modelCandidates, normalizeMeal } from "../worker/index.js";

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

test("uses Flash-Lite for chat and keeps meal fallbacks", () => {
  assert.deepEqual(modelCandidates({}, "chat"), ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]);
  assert.deepEqual(modelCandidates({}, "meal"), ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.equal(modelCandidates({ GEMINI_CHAT_MODEL: "custom-chat" }, "chat")[0], "custom-chat");
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

test("returns a grounded chat answer", async () => {
  let received;
  const response = await handleRequest(request("/chat", {
    message: "What should I eat to reach protein?",
    history: [{ role: "user", content: "Keep it practical" }],
    context: {
      targets: { kcal: 2250, protein: 180, carbs: 240, fat: 70 },
      today: [{ name: "Breakfast", kcal: 450, p: 30, c: 50, f: 12 }],
      recent: [{ date: "2026-09-19", kcal: 2100, p: 170, c: 220, f: 65 }]
    }
  }), env, { chat: async body => { received = body; return "Add a gluten-free yogurt and whey bowl."; } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.answer, "Add a gluten-free yogurt and whey bowl.");
  assert.equal(received.message, "What should I eat to reach protein?");
});

test("rejects an empty chat question", async () => {
  const response = await handleRequest(request("/chat", { message: "   " }), env, { chat: async () => "unused" });
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.equal(result.error.code, "INVALID_INPUT");
});

test("caps oversized chat requests", async () => {
  const response = await handleRequest(request("/chat", { message: "x".repeat(81_000) }), env, { chat: async () => "unused" });
  assert.equal(response.status, 413);
});
