# FuelLog

FuelLog is a private-first meal, macro, and progress tracker hosted on GitHub Pages. Meal logs and progress photos remain on the device. Optional AI meal estimation uses a Cloudflare Worker so the Gemini API key is never exposed in the public page.

## AI architecture

- The browser resizes meal photos, converts them to JPEG, and sends a maximum 4 MB payload.
- The Worker verifies the GitHub Pages origin and a private FuelLog access code.
- The Worker calls the pinned stable Gemini model with a strict JSON schema, validates the result, and returns actionable errors.
- Ask FuelLog calculates exact remaining calories and macros on-device without using AI. Complex questions send the current question, up to ten recent chat messages, today's meal log, targets, and seven compact daily summaries through the protected Worker. Chat history remains on the device.
- Complex chat uses Gemini 3.5 Flash-Lite first. Meal analysis retains Gemini 3.8 Flash for quality; both paths automatically fall back to stable Flash-Lite models on model-specific quota or availability errors.
- The editable review screen remains mandatory because a photo cannot reveal exact weights or hidden ingredients.

## Smart Quick entries

- Quick entries are ranked from the previous 45 days so meals frequently logged near the current time appear first.
- **Create group** combines two or more Quick entries into a reusable meal such as a shake; grouped meals retain their component list and support portion scaling.
- Existing logs and Quick entries remain compatible; no data migration is required.

## One-time Cloudflare setup

1. Create a free Cloudflare account and a Workers API token.
2. In the GitHub repository, add these Actions secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `GEMINI_API_KEY`
   - `FUELLOG_APP_TOKEN` — create a long random access code used only by FuelLog.
3. Run the **Deploy FuelLog AI Worker** workflow.
4. Copy the resulting `https://fuellog-ai.<your-subdomain>.workers.dev` URL.
5. Open FuelLog → AI and enter that URL plus the same `FUELLOG_APP_TOKEN` access code.

For local development, copy the secrets into `.dev.vars` (this file is ignored), then run:

```sh
npm install
npm run dev:worker
```

## Tests

```sh
npm test
```
