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
  res.send("Server v5 parser active");
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

function toIsoWithOffset(date, offset = "+03:00") {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${offset}`
  );
}

function cleanupReminderText(text) {
  return normalizeWhitespace(
    text
      .replace(/\bнапомни\b/gi, "")
      .replace(/\bсегодня\b/gi, "")
      .replace(/\bсьогодні\b/gi, "")
      .replace(/\btoday\b/gi, "")
      .replace(/\bзавтра\b/gi, "")
      .replace(/\btomorrow\b/gi, "")
      .replace(/\bчерез\b/gi, "")
      .replace(/\bполчаса\b/gi, "")
      .replace(/\bпол часа\b/gi, "")
      .replace(/\bпол часа\b/gi, "")
      .replace(/\bутра\b/gi, "")
      .replace(/\bутром\b/gi, "")
      .replace(/\bвечера\b/gi, "")
      .replace(/\bвечером\b/gi, "")
      .replace(/\bдня\b/gi, "")
      .replace(/\bночи\b/gi, "")
      .replace(/\bв\b/gi, " ")
      .replace(/\bво\b/gi, " ")
      .replace(/\s+/g, " ")
  );
}

function extractRelative(text, now) {
  const t = text.toLowerCase();

  if (/через\s+пол\s*часа|через\s+полчаса/.test(t)) {
    const dt = new Date(now.getTime() + 30 * 60 * 1000);
    return {
      text: cleanupReminderText(text),
      datetime: dt,
    };
  }

  const minMatch = t.match(/через\s+(\d{1,3})\s*(минут|минута|минуты|мин|хвилин|хвилину|хв)/i);
  if (minMatch) {
    const minutes = parseInt(minMatch[1], 10);
    const dt = new Date(now.getTime() + minutes * 60 * 1000);
    return {
      text: cleanupReminderText(text),
      datetime: dt,
    };
  }

  const hourMatch = t.match(/через\s+(\d{1,3})\s*(час|часа|часов|годину|години|годин)/i);
  if (hourMatch) {
    const hours = parseInt(hourMatch[1], 10);
    const dt = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return {
      text: cleanupReminderText(text),
      datetime: dt,
    };
  }

  return null;
}

function extractAbsolute(text, now) {
  const t = text.toLowerCase();

  const hasTomorrow = /\bзавтра\b|\btomorrow\b/.test(t);
  const hasToday = /\bсегодня\b|\bсьогодні\b|\btoday\b/.test(t);

  const match = t.match(/(?:^|[\s,])(?:в|во)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(утра|утром|вечера|вечером|дня|ночи|ранку|вранці|вечора|увечері|ночі|am|pm)?/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const suffix = (match[3] || "").toLowerCase();

  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;

  if (["вечера", "вечером", "вечора", "увечері"].includes(suffix) && hour < 12) {
    hour += 12;
  }

  if (suffix === "дня" && hour < 12) {
    hour += 12;
  }

  if (["утра", "утром", "ранку", "вранці"].includes(suffix)) {
    if (hour === 12) hour = 0;
  }

  if (["ночи", "ночі"].includes(suffix)) {
    if (hour === 12) hour = 0;
    // 1..5 остаются как есть
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const dt = new Date(now);
  dt.setSeconds(0, 0);
  dt.setHours(hour, minute, 0, 0);

  if (hasTomorrow) {
    dt.setDate(dt.getDate() + 1);
  } else if (!hasToday && dt.getTime() <= now.getTime()) {
    dt.setDate(dt.getDate() + 1);
  }

  return {
    text: cleanupReminderText(text),
    datetime: dt,
  };
}

function localParse(text, nowIso) {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return null;

  const rel = extractRelative(text, now);
  if (rel && rel.text) return rel;

  const abs = extractAbsolute(text, now);
  if (abs && abs.text) return abs;

  return null;
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

    // 1) Сначала пытаемся распарсить локально на сервере
    const local = localParse(cleanedText, now);
    if (local) {
      return res.json({
        ok: true,
        text: local.text || cleanedText,
        datetime: toIsoWithOffset(local.datetime, "+03:00"),
        source: "local_parser",
      });
    }

    // 2) Если локально не вышло — идём в OpenAI
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a strict reminder parser.

Return ONLY valid JSON with exactly:
{
  "text": "string",
  "datetime": "ISO-8601 datetime with timezone offset"
}

Rules:
- Respect "завтра" as next day.
- Respect "утра" as morning, e.g. 9 утра = 09:00.
- Respect "вечера" as evening, e.g. 6 вечера = 18:00.
- Respect exact numeric times like 20:30 exactly.
- If no day is given and time already passed today, move to tomorrow.
- Remove time words from "text", but keep the actual reminder meaning.
- Use locale, timezone and now as source of truth.
- Output JSON only.
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
                input: "Встреча в 9 утра",
                output: {
                  text: "встреча",
                  datetime: "2026-04-06T09:00:00+03:00",
                },
              },
              {
                input: "напомни завтра в 6 вечера",
                output: {
                  text: "напомни",
                  datetime: "2026-04-06T18:00:00+03:00",
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

    if (!parsed.text || !parsed.datetime) {
      return res.status(500).json({
        ok: false,
        error: "Invalid JSON from model",
        raw: parsed,
      });
    }

    return res.json({
      ok: true,
      text: normalizeWhitespace(parsed.text),
      datetime: parsed.datetime,
      source: "openai",
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
