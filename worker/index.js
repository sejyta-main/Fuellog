import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL = "gemini-3.8-flash";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 2_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const MEAL_SCHEMA = {
  type: "object",
  required: [
    "name", "items", "kcal", "protein", "carbs", "fat", "sat_fat",
    "gluten_risk", "gluten_note", "confidence", "assumptions", "questions"
  ],
  properties: {
    name: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["item", "est"],
        properties: {
          item: { type: "string" },
          est: { type: "string" }
        }
      }
    },
    kcal: { type: "number" },
    protein: { type: "number" },
    carbs: { type: "number" },
    fat: { type: "number" },
    sat_fat: { type: "number" },
    gluten_risk: { type: "string", enum: ["none", "possible", "likely"] },
    gluten_note: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    assumptions: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } }
  }
};

const SYSTEM_PROMPT = `You are FuelLog's meal-analysis engine. Identify visible foods and estimate realistic edible portions. Return nutrition for the complete meal, including cooking fats and sauces when they are visible or strongly implied. Do not claim photographic precision. When oil, dressing, filling, serving depth, or another meaningful calorie source cannot be determined, state the assumption and ask one concise question. The user is strictly gluten-free: flag bread, pasta, cereal, soy sauce, malt, breading, cross-contamination, or uncertain packaged products. Output must follow the supplied JSON schema.`;

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

function requestId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGIN || "https://sejyta-main.github.io")
    .split(",").map(x => x.trim()).filter(Boolean);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) || local ? origin : allowed[0],
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = String(env.ALLOWED_ORIGIN || "https://sejyta-main.github.io")
    .split(",").map(x => x.trim()).filter(Boolean);
  return allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function errorResponse(request, env, status, code, message, id, retryable = false) {
  return json({ ok: false, error: { code, message, retryable }, requestId: id }, status, corsHeaders(request, env));
}

function authorized(request, env) {
  const expected = env.APP_TOKEN;
  if (!expected) return false;
  return request.headers.get("Authorization") === `Bearer ${expected}`;
}

function cleanText(value, max = 300) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function finiteNumber(value, field, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new Error(`Invalid ${field} in AI response`);
  }
  return Math.round(number * 10) / 10;
}

export function normalizeMeal(value) {
  if (!value || typeof value !== "object") throw new Error("AI response was not an object");
  const fat = finiteNumber(value.fat, "fat", 1_000);
  const satFat = Math.min(fat, finiteNumber(value.sat_fat, "saturated fat", 1_000));
  const risk = ["none", "possible", "likely"].includes(value.gluten_risk) ? value.gluten_risk : "possible";
  const confidence = ["low", "medium", "high"].includes(value.confidence) ? value.confidence : "low";
  const strings = list => Array.isArray(list) ? list.map(x => cleanText(x, 240)).filter(Boolean).slice(0, 5) : [];
  const items = Array.isArray(value.items) ? value.items.slice(0, 12).map(item => ({
    item: cleanText(item?.item, 120),
    est: cleanText(item?.est, 120)
  })).filter(item => item.item) : [];

  return {
    name: cleanText(value.name, 120) || "Estimated meal",
    items,
    kcal: finiteNumber(value.kcal, "calories", 10_000),
    protein: finiteNumber(value.protein, "protein", 1_000),
    carbs: finiteNumber(value.carbs, "carbohydrates", 2_000),
    fat,
    sat_fat: satFat,
    gluten_risk: risk,
    gluten_note: cleanText(value.gluten_note, 300),
    confidence,
    assumptions: strings(value.assumptions),
    questions: strings(value.questions)
  };
}

function decodeJson(text) {
  const clean = String(text || "").replace(/```json|```/gi, "").trim();
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("AI returned no JSON");
  return JSON.parse(clean.slice(first, last + 1));
}

function validateInput(body) {
  if (!body || !["photo", "description"].includes(body.kind)) {
    return "Request kind must be photo or description";
  }
  if (body.kind === "description") {
    const description = cleanText(body.description, MAX_DESCRIPTION_LENGTH);
    if (!description) return "Meal description is empty";
  }
  if (body.kind === "photo") {
    const image = body.image;
    if (!image || !ALLOWED_IMAGE_TYPES.has(image.mimeType) || typeof image.data !== "string") {
      return "Photo must be JPEG, PNG, or WebP";
    }
    const bytes = Math.ceil(image.data.length * 3 / 4);
    if (bytes > MAX_IMAGE_BYTES) return "Compressed photo exceeds 4 MB";
  }
  return "";
}

function promptFor(body) {
  if (body.kind === "description") {
    return `Estimate this meal from the user's description: "${cleanText(body.description, MAX_DESCRIPTION_LENGTH)}". Use typical portions only when quantities are omitted and clearly list those assumptions.`;
  }
  return "Analyze this meal photo. Estimate each visible food and its edible portion. Include likely cooking oil or sauce only when visually or contextually justified, and ask about it when uncertainty could materially change calories.";
}

async function callGemini(body, env) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const input = [{ type: "text", text: promptFor(body) }];
  if (body.kind === "photo") {
    input.push({ type: "image", mime_type: body.image.mimeType, data: body.image.data });
  }
  const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const interaction = await client.interactions.create({
    model,
    input,
    system_instruction: SYSTEM_PROMPT,
    generation_config: { temperature: 0.2 },
    response_format: { type: "text", mime_type: "application/json", schema: MEAL_SCHEMA },
    store: false
  }, {
    timeout_ms: 35_000,
    retries: { strategy: "none" }
  });
  if (!interaction.output_text) throw new Error("AI returned no text");
  return interaction.output_text;
}

function errorStatus(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  return Number.isFinite(status) ? status : 0;
}

async function geminiWithRetry(body, env, generate) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await generate(body, env);
    } catch (error) {
      lastError = error;
      const status = errorStatus(error);
      const retryable = RETRYABLE_STATUS.has(status) || error?.name === "RequestTimeoutError" || error?.name === "TypeError";
      if (!retryable || attempt === 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 450 + Math.floor(Math.random() * 250)));
    }
  }
  throw lastError;
}

function upstreamMessage(status, detail) {
  if (/api key|credential|permission|authentication/i.test(String(detail || ""))) {
    return "The Gemini API key is invalid, restricted, or the API is disabled.";
  }
  if (status === 400) return "Gemini rejected the request or image format.";
  if (status === 401 || status === 403) return "The Gemini API key is invalid, restricted, or the API is disabled.";
  if (status === 404) return "The configured Gemini model is unavailable.";
  if (status === 429) return "Gemini quota is temporarily exhausted. Try again shortly.";
  if (status >= 500) return "Gemini is temporarily unavailable.";
  return cleanText(detail, 180) || "Gemini request failed.";
}

export async function handleRequest(request, env, deps = {}) {
  const generate = deps.generate || callGemini;
  const id = requestId();
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!isAllowedOrigin(request, env)) return errorResponse(request, env, 403, "ORIGIN_DENIED", "This website is not allowed to use the AI service.", id);
  if (!authorized(request, env)) return errorResponse(request, env, 401, "ACCESS_DENIED", "The FuelLog AI access code is incorrect.", id);
  if (!env.GEMINI_API_KEY) return errorResponse(request, env, 503, "NOT_CONFIGURED", "The AI service has no Gemini key configured.", id);

  const url = new URL(request.url);
  if (url.pathname === "/health") {
    if (request.method !== "POST") return errorResponse(request, env, 405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.", id);
    const probe = { kind: "description", description: "One medium banana" };
    try {
      const text = await geminiWithRetry(probe, env, generate);
      normalizeMeal(decodeJson(text));
      return json({ ok: true, model: env.GEMINI_MODEL || DEFAULT_MODEL, requestId: id }, 200, cors);
    } catch (error) {
      const status = errorStatus(error);
      const timeout = error?.name === "AbortError" || error?.name === "RequestTimeoutError";
      const upstream = status > 0;
      return errorResponse(request, env, status === 429 ? 429 : timeout ? 504 : 502, timeout ? "TIMEOUT" : upstream ? "GEMINI_ERROR" : "INVALID_RESPONSE", timeout ? "Gemini did not respond in time." : upstream ? upstreamMessage(status, error?.message) : "Gemini returned an invalid test response.", id, timeout || RETRYABLE_STATUS.has(status));
    }
  }

  if (url.pathname !== "/analyze") return errorResponse(request, env, 404, "NOT_FOUND", "Endpoint not found.", id);
  if (request.method !== "POST") return errorResponse(request, env, 405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.", id);

  let body;
  try {
    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 6_000_000) return errorResponse(request, env, 413, "REQUEST_TOO_LARGE", "Request exceeds 6 MB.", id);
    body = await request.json();
  } catch {
    return errorResponse(request, env, 400, "INVALID_JSON", "Request body is not valid JSON.", id);
  }
  const inputError = validateInput(body);
  if (inputError) return errorResponse(request, env, 400, "INVALID_INPUT", inputError, id);

  try {
    const text = await geminiWithRetry(body, env, generate);
    const meal = normalizeMeal(decodeJson(text));
    return json({ ok: true, meal, model: env.GEMINI_MODEL || DEFAULT_MODEL, requestId: id }, 200, cors);
  } catch (error) {
    const status = errorStatus(error);
    const timeout = error?.name === "AbortError" || error?.name === "RequestTimeoutError";
    const invalid = error instanceof SyntaxError || /AI response|AI returned|Invalid /.test(error?.message || "");
    return errorResponse(
      request, env,
      status === 429 ? 429 : timeout ? 504 : 502,
      timeout ? "TIMEOUT" : invalid ? "INVALID_RESPONSE" : status ? "GEMINI_ERROR" : "NETWORK_ERROR",
      timeout ? "Gemini did not respond in time." : invalid ? "Gemini returned incomplete nutrition data. Please retry." : status ? upstreamMessage(status, error?.message) : "The AI service could not reach Gemini.",
      id,
      timeout || RETRYABLE_STATUS.has(status) || !status
    );
  }
}

export default { fetch: handleRequest };
