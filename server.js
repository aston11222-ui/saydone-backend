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
  res.send("AI parser active");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function isValidIsoDateTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  );
}

app.post("/parse", async (req, res) => {
  try {
    const {
      text,
      locale,
      local_now,
      utc_offset_minutes,
    } = req.body ?? {};

    if (
      !text ||
      !locale ||
      !local_now ||
      typeof utc_offset_minutes !== "number"
    ) {
      return res.status(400).json({
        ok: false,
        error: "Missing text, locale, local_now or utc_offset_minutes",
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
You are a strict reminder parsing engine.

Your task:
Convert the user's reminder phrase into structured JSON.

Return ONLY valid JSON with exactly these keys:
{
  "text": "string",
  "datetime": "ISO-8601 datetime with timezone offset"
}

STRICT RULES:
1. Use the user's local current datetime as the source of truth.
2. Use utc_offset_minutes to construct the timezone offset in the output.
3. Respect relative time expressions exactly:
   - "через полчаса" = +30 minutes
   - "через 2 часа" = +2 hours
   - "через день" = +1 day
   - "через 2 дня" = +2 days
4. Respect absolute date expressions:
   - "завтра" = next day
   - "сегодня" / "today" = current day
5. Respect time-of-day words exactly:
   - "утра" / "am" => morning, e.g. 7 утра = 07:00
   - "вечера" / "pm" => evening, e.g. 6 вечера = 18:00
   - "дня" => daytime, e.g. 2 дня = 14:00
   - "ночи" => night, e.g. 1 ночи = 01:00
6. Respect exact numeric time exactly:
   - "в 20:30" => 20:30
   - "в 8" => 08:00 unless the phrase explicitly says evening/pm
7. If user gives a time but no explicit day, and that time has already passed in the user's local day, move it to tomorrow.
8. The "text" field must keep the reminder meaning, but remove time/date words.
9. Never explain. Never add extra keys. Never output markdown.
10. If the phrase is incomplete or impossible to parse reliably, still return JSON:
{
  "text": "<best cleaned reminder text or original short text>",
  "datetime": ""
}

The output datetime must include timezone offset, for example:
2026-04-06T18:00:00+03:00
          `.trim(),
        },
        {
          role: "user",
          content: JSON.stringify({
            locale,
            local_now,
            utc_offset_minutes,
            text: cleanedText,
            examples: [
              {
                input: {
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "напомни через полчаса купить молоко",
                },
                output: {
                  text: "купить молоко",
                  datetime: "2026-04-05T18:48:00+03:00",
                },
              },
              {
                input: {
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "напомни завтра в 6 вечера",
                },
                output: {
                  text: "напомни",
                  datetime: "2026-04-06T18:00:00+03:00",
                },
              },
              {
                input: {
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "встреча в 9 утра",
                },
                output: {
                  text: "встреча",
                  datetime: "2026-04-06T09:00:00+03:00",
                },
              },
              {
                input: {
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "позвонить маме в 8",
                },
                output: {
                  text: "позвонить маме",
                  datetime: "2026-04-06T08:00:00+03:00",
                },
              },
              {
                input: {
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "купить хлеб в 20:30",
                },
                output: {
                  text: "купить хлеб",
                  datetime: "2026-04-05T20:30:00+03:00",
                },
              },
              {
                input: {
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: -240,
                  text: "remind me in 2 days to call mom at 7 pm",
                },
                output: {
                  text: "call mom",
                  datetime: "2026-04-07T19:00:00-04:00",
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
    const resultDatetime = typeof parsed.datetime === "string"
      ? parsed.datetime.trim()
      : "";

    if (!resultText) {
      return res.status(500).json({
        ok: false,
        error: "Model returned empty text",
        raw: parsed,
      });
    }

    if (!resultDatetime || !isValidIsoDateTime(resultDatetime)) {
      return res.json({
        ok: true,
        text: resultText,
        datetime: "",
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
