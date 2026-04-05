import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (_, res) => {
  res.send("Server v4 parser active");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function looksLikeIsoWithOffset(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
  );
}

app.post("/parse", async (req, res) => {
  try {
    const { text, locale, timezone, now } = req.body ?? {};

    if (!text || !locale || !timezone || !now) {
      return res.status(400).json({
        ok: false,
        error: "Missing text, locale, timezone or now",
      });
    }

    const cleanedText = normalizeWhitespace(text);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a strict reminder parser.

Return ONLY valid JSON with exactly these keys:
{
  "text": "string",
  "datetime": "ISO-8601 datetime with timezone offset"
}

Rules:
1. Use the provided locale, timezone, and now as source of truth.
2. Respect date words strictly:
   - "завтра" / "tomorrow" = next day
   - "сегодня" / "сьогодні" / "today" = current day
3. Respect time-of-day words strictly:
   - "утра", "утром", "ранку", "вранці", "am" => morning
   - "дня" => daytime
   - "вечера", "вечером", "вечора", "увечері", "pm" => evening
   - "ночи", "ночью", "ночі", "вночі" => night
4. Examples:
   - "7 утра" => 07:00
   - "7 вечера" => 19:00
   - "в 8" => 08:00 unless user clearly means evening
   - "в 20:30" => 20:30
5. If no explicit day is given and the exact time has already passed today, schedule it for tomorrow.
6. Preserve the reminder action in "text", but remove time/date words from it.
7. Do not explain anything.
8. Do not add extra keys.
9. "datetime" MUST include timezone offset, for example +03:00.

Output only JSON.
          `.trim(),
        },
        {
          role: "user",
          content: JSON.stringify({
            locale,
            timezone,
            now,
            text: cleanedText,
            examples: [
              {
                input: "напомни завтра позвонить в 7 утра",
                output: {
                  text: "позвонить",
                  datetime: "2026-04-06T07:00:00+03:00",
                },
              },
              {
                input: "позвонить маме в 8",
                output: {
                  text: "позвонить маме",
                  datetime: "2026-04-06T08:00:00+03:00",
                },
              },
              {
                input: "купить хлеб в 20:30",
                output: {
                  text: "купить хлеб",
                  datetime: "2026-04-05T20:30:00+03:00",
                },
              },
              {
                input: "напомни через полчаса купить молоко",
                output: {
                  text: "купить молоко",
                  datetime: "2026-04-05T18:48:00+03:00",
                },
              },
              {
                input: "восемь сорок пять вечера позвонить другу",
                output: {
                  text: "позвонить другу",
                  datetime: "2026-04-05T20:45:00+03:00",
                },
              },
            ],
          }),
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(500).json({
        ok: false,
        error: "Empty response from OpenAI",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "Model returned non-JSON",
        raw: content,
      });
    }

    const resultText = normalizeWhitespace(parsed.text);
    const resultDatetime = parsed.datetime;

    if (!resultText || !looksLikeIsoWithOffset(resultDatetime)) {
      return res.status(500).json({
        ok: false,
        error: "Invalid JSON from model",
        raw: parsed,
      });
    }

    return res.json({
      ok: true,
      text: resultText,
      datetime: resultDatetime,
    });
  } catch (e) {
    console.error("PARSE ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "server_error",
    });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
