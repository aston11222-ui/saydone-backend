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

Return ONLY valid JSON with exactly these keys:
{
  "text": "string",
  "datetime": "string"
}

Rules:
1. Use the user's local current datetime as the source of truth.
2. Use utc_offset_minutes to construct the timezone offset in the output.
3. Never return empty "text" if the user phrase is not empty.
4. If the phrase contains both a task and time, keep only the task in "text".
5. If the phrase contains only timing and no separate task, keep the original phrase in "text".
6. Parse relative phrases exactly:
   - "через час" = +1 hour
   - "через 2 часа" = +2 hours
   - "через 20 минут" = +20 minutes
   - "через полчаса" = +30 minutes
   - "через день" = +1 day
   - "через 2 дня" = +2 days
7. Parse absolute phrases exactly:
   - "завтра" = next day
   - "сегодня" / "today" = current day
8. Parse time-of-day exactly:
   - "8 вечера" = 20:00
   - "6 вечера" = 18:00
   - "9 утра" = 09:00
   - "2 дня" = 14:00
   - "1 ночи" = 01:00
9. Parse exact numeric time exactly:
   - "в 20:30" = 20:30
   - "в 8" = 08:00 unless the phrase explicitly says evening/pm
10. If user gives a time but no explicit day, and that time already passed today, move it to tomorrow.
11. If datetime cannot be determined reliably, return:
{
  "text": "<original phrase>",
  "datetime": ""
}
12. Never explain. Never add extra keys. Never output markdown.

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
                  text: "напомни через час",
                },
                output: {
                  text: "напомни через час",
                  datetime: "2026-04-05T19:18:00+03:00",
                },
              },
              {
                input: {
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "Поставь напоминание через час",
                },
                output: {
                  text: "Поставь напоминание через час",
                  datetime: "2026-04-05T19:18:00+03:00",
                },
              },
              {
                input: {
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "Купить молоко в 8 вечера",
                },
                output: {
                  text: "Купить молоко",
                  datetime: "2026-04-05T20:00:00+03:00",
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
                  utc_offset_minutes: 180,
                  text: "напомни завтра в 6 вечера",
                },
                output: {
                  text: "напомни завтра в 6 вечера",
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

    let resultText = normalizeWhitespace(parsed.text);
    let resultDatetime =
      typeof parsed.datetime === "string" ? parsed.datetime.trim() : "";

    // если модель не вернула text — берём исходную фразу
    if (!resultText) {
      resultText = cleanedText;
    }

    // если datetime пустой или невалидный — не падаем, просто отдаем пустую дату
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
