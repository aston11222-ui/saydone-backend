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
  res.send("AI semantic parser active");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function offsetMinutesToIso(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = pad2(Math.floor(abs / 60));
  const mm = pad2(abs % 60);
  return `${sign}${hh}:${mm}`;
}

function toIsoWithOffsetFromLocal(date, offsetMinutes) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    offsetMinutesToIso(offsetMinutes)
  );
}

function parseLocalNow(localNow) {
  // localNow приходит без offset, например 2026-04-05T18:18:00
  // создаём локальный Date из его частей
  const m = String(localNow).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) return null;

  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || "0"),
    0
  );
}

function normalizeUnit(unit) {
  if (!unit) return null;
  const u = String(unit).toLowerCase().trim();

  if (["minute", "minutes", "min", "минута", "минуты", "минут", "хвилина", "хвилини", "хвилин"].includes(u)) {
    return "minute";
  }
  if (["hour", "hours", "hr", "hrs", "час", "часа", "часов", "година", "години", "годин"].includes(u)) {
    return "hour";
  }
  if (["day", "days", "день", "дня", "дней", "день", "дні", "днів"].includes(u)) {
    return "day";
  }
  return u;
}

function normalizeDayRef(dayRef) {
  if (!dayRef) return "none";
  const v = String(dayRef).toLowerCase().trim();
  if (["today", "сегодня", "сьогодні", "heute"].includes(v)) return "today";
  if (["tomorrow", "завтра", "morgen"].includes(v)) return "tomorrow";
  return "none";
}

function normalizeDayPeriod(period) {
  if (!period) return "none";
  const p = String(period).toLowerCase().trim();

  if ([
    "morning", "утро", "утром", "утра", "ранок", "ранку", "вранці", "morgen", "morgens"
  ].includes(p)) {
    return "morning";
  }

  if ([
    "afternoon", "day", "день", "дня", "nachmittag", "nachmittags"
  ].includes(p)) {
    return "afternoon";
  }

  if ([
    "evening", "вечер", "вечером", "вечера", "вечір", "вечора", "увечері", "abend", "abends"
  ].includes(p)) {
    return "evening";
  }

  if ([
    "night", "ночь", "ночи", "ночью", "ніч", "ночі", "вночі", "nacht", "nachts"
  ].includes(p)) {
    return "night";
  }

  if (["am", "a.m."].includes(p)) return "morning";
  if (["pm", "p.m."].includes(p)) return "evening";

  return "none";
}

function convertHour(hour, dayPeriod) {
  let h = Number(hour);
  if (!Number.isFinite(h)) return null;
  if (h < 0 || h > 23) return null;

  const p = normalizeDayPeriod(dayPeriod);

  // Если уже 24-часовой формат — оставляем
  if (h > 12) return h;

  if (p === "morning") {
    // 12 утра = 00:00
    if (h === 12) return 0;
    return h;
  }

  if (p === "afternoon") {
    // 12 дня = 12:00, 1-11 дня = 13-23? Нет. Для "2 дня" = 14:00
    if (h === 12) return 12;
    return h + 12;
  }

  if (p === "evening") {
    // 6 вечера = 18:00, 11 вечера = 23:00, 12 вечера = 12:00
    if (h === 12) return 12;
    return h + 12;
  }

  if (p === "night") {
    // 1 ночи = 01:00, 12 ночи = 00:00
    if (h === 12) return 0;
    return h;
  }

  // без части суток:
  // 1..12 считаем как есть
  return h;
}

function computeDatetime(parsed, localNow, offsetMinutes) {
  const mode = String(parsed.mode || "unknown").toLowerCase().trim();

  if (mode === "relative") {
    const amount = Number(parsed.relative_amount);
    const unit = normalizeUnit(parsed.relative_unit);

    if (!Number.isFinite(amount) || amount <= 0 || !unit) return "";

    const dt = new Date(localNow);

    if (unit === "minute") {
      dt.setMinutes(dt.getMinutes() + amount);
    } else if (unit === "hour") {
      dt.setHours(dt.getHours() + amount);
    } else if (unit === "day") {
      dt.setDate(dt.getDate() + amount);
    } else {
      return "";
    }

    return toIsoWithOffsetFromLocal(dt, offsetMinutes);
  }

  if (mode === "absolute") {
    const rawHour =
      parsed.hour_24 != null && parsed.hour_24 !== ""
        ? Number(parsed.hour_24)
        : parsed.hour_12 != null && parsed.hour_12 !== ""
          ? convertHour(parsed.hour_12, parsed.day_period)
          : null;

    const minute =
      parsed.minute != null && parsed.minute !== ""
        ? Number(parsed.minute)
        : 0;

    if (!Number.isFinite(rawHour) || rawHour < 0 || rawHour > 23) return "";
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return "";

    const dayRef = normalizeDayRef(parsed.day_reference);
    const dt = new Date(localNow);
    dt.setSeconds(0, 0);
    dt.setHours(rawHour, minute, 0, 0);

    if (dayRef === "tomorrow") {
      dt.setDate(dt.getDate() + 1);
    } else if (dayRef === "none") {
      if (dt.getTime() <= localNow.getTime()) {
        dt.setDate(dt.getDate() + 1);
      }
    }

    return toIsoWithOffsetFromLocal(dt, offsetMinutes);
  }

  return "";
}

app.post("/parse", async (req, res) => {
  try {
    const { text, locale, local_now, utc_offset_minutes } = req.body ?? {};

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
    const localNow = parseLocalNow(local_now);

    if (!localNow) {
      return res.status(400).json({
        ok: false,
        error: "Invalid local_now format",
      });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a multilingual reminder understanding engine.

You MUST understand the user's phrase semantically and return ONLY valid JSON
with exactly these keys:

{
  "text": "string",
  "mode": "relative|absolute|unknown",
  "relative_amount": "number|null",
  "relative_unit": "minute|hour|day|null",
  "day_reference": "today|tomorrow|none",
  "hour_12": "number|null",
  "hour_24": "number|null",
  "minute": "number|null",
  "day_period": "morning|afternoon|evening|night|none"
}

Rules:
1. The user may speak in ANY language.
2. Detect the language from the phrase automatically.
3. Use locale only as a hint.
4. "text" must NEVER be empty if the input phrase is non-empty.
5. If the phrase contains only timing and no separate task, keep the original phrase in "text".
6. If the phrase contains both a task and timing, keep only the task in "text".
7. For relative phrases:
   - "через полчаса" => mode=relative, relative_amount=30, relative_unit=minute
   - "через пол часа" => same
   - "через час" => mode=relative, relative_amount=1, relative_unit=hour
   - "через 2 часа" => mode=relative, relative_amount=2, relative_unit=hour
   - same logic for Ukrainian, English, German, etc.
8. For absolute phrases:
   - "в 9 вечера" => mode=absolute, hour_12=9, day_period=evening
   - "в 11 вечера" => mode=absolute, hour_12=11, day_period=evening
   - "в 12 вечера" => mode=absolute, hour_12=12, day_period=evening
   - "в 9 утра" => mode=absolute, hour_12=9, day_period=morning
   - "в 21:00" => mode=absolute, hour_24=21, minute=0
9. If the phrase includes tomorrow/today equivalents, set day_reference properly.
10. If time is unclear, return mode="unknown".
11. Never explain. Never add extra keys. Never output markdown.
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
                input: "поставь напоминание через пол часа",
                output: {
                  text: "поставь напоминание через пол часа",
                  mode: "relative",
                  relative_amount: 30,
                  relative_unit: "minute",
                  day_reference: "none",
                  hour_12: null,
                  hour_24: null,
                  minute: null,
                  day_period: "none"
                }
              },
              {
                input: "поставь напоминание через час",
                output: {
                  text: "поставь напоминание через час",
                  mode: "relative",
                  relative_amount: 1,
                  relative_unit: "hour",
                  day_reference: "none",
                  hour_12: null,
                  hour_24: null,
                  minute: null,
                  day_period: "none"
                }
              },
              {
                input: "купить молоко в 11 вечера",
                output: {
                  text: "купить молоко",
                  mode: "absolute",
                  relative_amount: null,
                  relative_unit: null,
                  day_reference: "none",
                  hour_12: 11,
                  hour_24: null,
                  minute: 0,
                  day_period: "evening"
                }
              },
              {
                input: "купить молоко в 12 вечера",
                output: {
                  text: "купить молоко",
                  mode: "absolute",
                  relative_amount: null,
                  relative_unit: null,
                  day_reference: "none",
                  hour_12: 12,
                  hour_24: null,
                  minute: 0,
                  day_period: "evening"
                }
              },
              {
                input: "Buy milk at 9 in the evening",
                output: {
                  text: "Buy milk",
                  mode: "absolute",
                  relative_amount: null,
                  relative_unit: null,
                  day_reference: "none",
                  hour_12: 9,
                  hour_24: null,
                  minute: 0,
                  day_period: "evening"
                }
              },
              {
                input: "Remind me in an hour",
                output: {
                  text: "Remind me in an hour",
                  mode: "relative",
                  relative_amount: 1,
                  relative_unit: "hour",
                  day_reference: "none",
                  hour_12: null,
                  hour_24: null,
                  minute: null,
                  day_period: "none"
                }
              },
              {
                input: "Kaufe Milch um 11 Uhr abends",
                output: {
                  text: "Kaufe Milch",
                  mode: "absolute",
                  relative_amount: null,
                  relative_unit: null,
                  day_reference: "none",
                  hour_12: 11,
                  hour_24: null,
                  minute: 0,
                  day_period: "evening"
                }
              }
            ]
          })
        }
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

    const resultText = normalizeWhitespace(parsed.text) || cleanedText;
    const resultDatetime = computeDatetime(parsed, localNow, utc_offset_minutes);

    return res.json({
      ok: true,
      text: resultText,
      datetime: resultDatetime,
      raw: parsed
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
