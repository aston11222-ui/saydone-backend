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
You are a strict multilingual reminder parsing engine.

You parse the user's reminder phrase into structured JSON.

Return ONLY valid JSON with exactly these keys:
{
  "text": "string",
  "datetime": "string"
}

Definitions:
- "text" = cleaned reminder task text
- "datetime" = ISO-8601 datetime with timezone offset, for example:
  2026-04-06T21:00:00+03:00

Universal rules:
1. The user may speak in ANY language.
2. Detect and understand the user's language automatically.
3. Use locale only as a helpful hint, but parse from the actual phrase text.
4. Use local_now as the user's current local date/time.
5. Use utc_offset_minutes to construct the timezone offset in the output datetime.
6. Never ignore day words like:
   - today / tomorrow
   - сегодня / завтра
   - сьогодні / завтра
   - heute / morgen
   - and equivalent words in other languages
7. Never ignore time-of-day words like:
   - morning / evening / night / afternoon
   - утра / вечера / ночи / дня
   - ранку / вечора / ночі / дня
   - morgens / abends / nachts / nachmittags
   - and equivalent words in other languages
8. Interpret evening / pm correctly:
   - 6 in the evening = 18:00
   - 7 in the evening = 19:00
   - 8 in the evening = 20:00
   - 9 in the evening = 21:00
   - 10 in the evening = 22:00
   - 11 in the evening = 23:00
9. Interpret morning / am correctly:
   - 7 in the morning = 07:00
   - 9 in the morning = 09:00
10. Respect exact numeric times exactly:
   - 20:30 means 20:30
   - 21 00 means 21:00
11. Respect relative expressions exactly:
   - in an hour / через час / через годину / in einer Stunde => +1 hour
   - in 20 minutes / через 20 минут / через 20 хвилин / in 20 Minuten => +20 minutes
   - in half an hour / через полчаса / через пів години / in einer halben Stunde => +30 minutes
   - in a day / через день / через день / in einem Tag => +1 day
   - in 2 days / через 2 дня / через 2 дні / in 2 Tagen => +2 days
12. If the phrase contains both task and time, keep only the task in "text".
13. If the phrase contains only timing and no separate task, keep the original phrase in "text".
14. Never return empty "text" when the input phrase is non-empty.
15. If a time is given but no explicit day is given, and that local time has already passed today, move it to tomorrow.
16. If datetime cannot be determined reliably, return:
{
  "text": "<original phrase>",
  "datetime": ""
}
17. Never explain reasoning.
18. Never add extra keys.
19. Never output markdown.

Examples of multilingual behavior:
- "buy milk at 9 in the evening" => 21:00
- "купить молоко в 9 вечера" => 21:00
- "купити молоко о 9 вечора" => 21:00
- "Kaufe Milch um 9 Uhr abends" => 21:00
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
                  locale: "ru_RU",
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "Купить молоко в 9 вечера",
                },
                output: {
                  text: "Купить молоко",
                  datetime: "2026-04-05T21:00:00+03:00",
                },
              },
              {
                input: {
                  locale: "ru_RU",
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
                  locale: "uk_UA",
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "Купити молоко о 9 вечора",
                },
                output: {
                  text: "Купити молоко",
                  datetime: "2026-04-05T21:00:00+03:00",
                },
              },
              {
                input: {
                  locale: "uk_UA",
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 180,
                  text: "Нагадай через годину",
                },
                output: {
                  text: "Нагадай через годину",
                  datetime: "2026-04-05T19:18:00+03:00",
                },
              },
              {
                input: {
                  locale: "en_US",
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: -240,
                  text: "Buy milk at 9 in the evening",
                },
                output: {
                  text: "Buy milk",
                  datetime: "2026-04-05T21:00:00-04:00",
                },
              },
              {
                input: {
                  locale: "en_US",
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: -240,
                  text: "Remind me in an hour",
                },
                output: {
                  text: "Remind me in an hour",
                  datetime: "2026-04-05T19:18:00-04:00",
                },
              },
              {
                input: {
                  locale: "de_DE",
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 120,
                  text: "Kaufe Milch um 9 Uhr abends",
                },
                output: {
                  text: "Kaufe Milch",
                  datetime: "2026-04-05T21:00:00+02:00",
                },
              },
              {
                input: {
                  locale: "de_DE",
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: 120,
                  text: "Erinnere mich in einer Stunde",
                },
                output: {
                  text: "Erinnere mich in einer Stunde",
                  datetime: "2026-04-05T19:18:00+02:00",
                },
              },
              {
                input: {
                  locale: "ru_RU",
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
                  locale: "ru_RU",
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
                  locale: "en_US",
                  local_now: "2026-04-05T18:18:00",
                  utc_offset_minutes: -240,
                  text: "remind me in 2 days to call mom at 7 pm",
                },
                output: {
                  text: "call mom",
                  datetime: "2026-04-07T19:00:00-04:00",
                },
              }
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

    if (!resultText) {
      resultText = cleanedText;
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
