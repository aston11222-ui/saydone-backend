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
  res.send("Server v3 parser active");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

function isIsoDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function inferExpectedHints(text) {
  const t = normalizeWhitespace(text).toLowerCase();

  return {
    hasTomorrow:
      /\b(завтра|tomorrow)\b/.test(t),
    hasToday:
      /\b(сегодня|сьогодні|today)\b/.test(t),
    hasMorning:
      /\b(утра|утром|ранку|вранці|morning|am)\b/.test(t),
    hasDaytime:
      /\b(дня|днем|daytime)\b/.test(t),
    hasEvening:
      /\b(вечера|вечером|вечора|увечері|evening|pm)\b/.test(t),
    hasNight:
      /\b(ночи|ночью|ночі|вночі|night)\b/.test(t),
  };
}

function extractHourMinute(text) {
  const t = normalizeWhitespace(text).toLowerCase();

  const numeric = t.match(/(?:^|[\s,])(\\d{1,2})(?:[:\\.](\\d{2}))?(?=$|[\\s,!.?])/);
  if (numeric) {
    return {
      hour: parseInt(numeric[1], 10),
      minute: numeric[2] ? parseInt(numeric[2], 10) : 0,
    };
  }

  const words = {
    "ноль": 0,
    "один": 1,
    "час": 1,
    "два": 2,
    "три": 3,
    "четыре": 4,
    "пять": 5,
    "шесть": 6,
    "семь": 7,
    "восемь": 8,
    "девять": 9,
    "десять": 10,
    "одиннадцать": 11,
    "двенадцать": 12,
  };

  for (const [word, value] of Object.entries(words)) {
    const re = new RegExp(`(?:^|\\s)${word}(?:$|\\s)`, "i");
    if (re.test(t)) {
      return { hour: value, minute: 0 };
    }
  }

  return null;
}

function applyDayPart(hour, hints) {
  let h = hour;

  if (hints.hasMorning) {
    if (h === 12) return 0;
    return h;
  }

  if (hints.hasDaytime) {
    if (h >= 1 && h <= 11) return h + 12;
    return h;
  }

  if (hints.hasEvening) {
    if (h >= 1 && h <= 11) return h + 12;
    return h;
  }

  if (hints.hasNight) {
    if (h === 12) return 0;
    return h;
  }

  return h;
}

function validateAndRepairModelResult(inputText, nowIso, modelResult) {
  const original = normalizeWhitespace(inputText);
  const hints = inferExpectedHints(original);
  const extracted = extractHourMinute(original);
  const now = new Date(nowIso);

  if (!modelResult || typeof modelResult !== "object") {
    return { ok: false, error: "Model result is not an object" };
  }

  let text = normalizeWhitespace(modelResult.text);
  let datetime = modelResult.datetime;

  if (!text) {
    return { ok: false, error: "Model returned empty text" };
  }

  if (!isIsoDateTime(datetime)) {
    return { ok: false, error: "Model returned invalid datetime" };
  }

  let dt = new Date(datetime);

  if (Number.isNaN(dt.getTime())) {
    return { ok: false, error: "Datetime parse failed" };
  }

  // Если фраза явно содержит "завтра", а модель вернула сегодня — чинить
  if (hints.hasTomorrow) {
    const nowY = now.getUTCFullYear();
    const nowM = now.getUTCMonth();
    const nowD = now.getUTCDate();

    const dtY = dt.getUTCFullYear();
    const dtM = dt.getUTCMonth();
    const dtD = dt.getUTCDate();

    const sameUtcDay = nowY === dtY && nowM === dtM && nowD === dtD;

    if (sameUtcDay) {
      dt = new Date(dt.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // Если во фразе есть точный час — чинить несоответствия
  if (extracted && extracted.hour >= 0 && extracted.hour <= 23) {
    const expectedHour = applyDayPart(extracted.hour, hints);
    const expectedMinute = extracted.minute ?? 0;

    const actualHour = dt.getHours();
    const actualMinute = dt.getMinutes();

    const hourMismatch = actualHour !== expectedHour;
    const minuteMismatch = actualMinute !== expectedMinute;

    if (hourMismatch || minuteMismatch) {
      dt = new Date(
        dt.getFullYear(),
        dt.getMonth(),
        dt.getDate(),
        expectedHour,
        expectedMinute,
        0,
        0
      );
    }
  }

  // Если нет "сегодня", нет "завтра", но время уже прошло — переносить на завтра
  if (!hints.hasToday && !hints.hasTomorrow && extracted) {
    if (dt.getTime() <= now.getTime()) {
      dt = new Date(dt.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  return {
    ok: true,
    text,
    datetime: dt.toISOString(),
  };
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
You are a STRICT reminder parser.

Return ONLY valid JSON with exactly these keys:
{
  "text": "string",
  "datetime": "ISO-8601 datetime with timezone offset"
}

Rules:
1. Never explain anything.
2. Never guess wildly.
3. Preserve the user's intended action in "text", but remove time/date words.
4. Respect these words strictly:
   - "завтра" / "tomorrow" = next day
   - "сегодня" / "сьогодні" / "today" = current day
5. Respect day parts strictly:
   - "утра", "утром", "ранку", "вранці", "am" => 00:00-11:59
   - "дня" => 12:00-16:59
   - "вечера", "вечором", "вечора", "pm" => 17:00-23:59
   - "ночи", "ночью", "ночі" => 00:00-05:59
6. Examples:
   - "7 утра" => 07:00
   - "7 вечера" => 19:00
   - "в 20:30" => 20:30
7. If the user gave an exact time, keep that exact time.
8. If no day word is specified and the time already passed today, move to tomorrow.
9. Use the provided locale, timezone, and now as the source of truth.
10. Support Russian, Ukrainian, and English.

Do not output markdown. Output only JSON.
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
                  datetime: "2026-04-05T18:15:00+03:00",
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

    const checked = validateAndRepairModelResult(cleanedText, now, parsed);

    if (!checked.ok) {
      return res.status(500).json({
        ok: false,
        error: checked.error,
        raw: parsed,
      });
    }

    return res.json({
      ok: true,
      text: checked.text,
      datetime: checked.datetime,
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
