import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (_, res) => {
  res.send("Server is working");
});

app.post("/parse", async (req, res) => {
  try {
    const { text, locale, timezone, now } = req.body ?? {};

    if (!text || !locale || !timezone || !now) {
      return res.status(400).json({
        ok: false,
        error: "Missing text, locale, timezone or now"
      });
    }

    const systemPrompt = `
You are a reminder time parser.

Your task:
Extract reminder task text and exact datetime from the user's phrase.

You must return ONLY valid JSON in this format:
{
  "text": "task without time words",
  "datetime": "ISO 8601 datetime"
}

Rules:
- Use locale, timezone, and current datetime from the input as source of truth.
- Understand Russian, Ukrainian, and English.
- Interpret phrases like:
  - "позвонить завтра в 8 утра"
  - "в 8.45 вечера"
  - "через 1 день"
  - "через 1 час 20 минут"
  - "восемь сорок пять вечера"
- Remove time/date words from "text" and keep only the reminder meaning.
- If user says only time and no task, keep the original text without time words if possible.
- Do not explain anything.
- Do not return markdown.
- Do not return anything except JSON.

Examples:

Input:
{
  "text": "позвонить завтра в 8 утра",
  "locale": "ru_RU",
  "timezone": "Europe/Kyiv",
  "now": "2026-04-02T10:00:00+03:00"
}
Output:
{
  "text": "позвонить",
  "datetime": "2026-04-03T08:00:00+03:00"
}

Input:
{
  "text": "таблетки в 2 дня",
  "locale": "ru_RU",
  "timezone": "Europe/Kyiv",
  "now": "2026-04-02T10:00:00+03:00"
}
Output:
{
  "text": "таблетки",
  "datetime": "2026-04-02T14:00:00+03:00"
}

Input:
{
  "text": "напомни через 1 день",
  "locale": "ru_RU",
  "timezone": "Europe/Kyiv",
  "now": "2026-04-02T10:00:00+03:00"
}
Output:
{
  "text": "напомни",
  "datetime": "2026-04-03T10:00:00+03:00"
}

Input:
{
  "text": "напомни через 1 час 20 минут",
  "locale": "ru_RU",
  "timezone": "Europe/Kyiv",
  "now": "2026-04-02T10:00:00+03:00"
}
Output:
{
  "text": "напомни",
  "datetime": "2026-04-02T11:20:00+03:00"
}

Input:
{
  "text": "восемь сорок пять вечера позвонить другу",
  "locale": "ru_RU",
  "timezone": "Europe/Kyiv",
  "now": "2026-04-02T10:00:00+03:00"
}
Output:
{
  "text": "позвонить другу",
  "datetime": "2026-04-02T20:45:00+03:00"
}
`;

    const userPayload = {
      text,
      locale,
      timezone,
      now,
    };

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) }
      ]
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(500).json({
        ok: false,
        error: "Empty response from OpenAI"
      });
    }

    const result = JSON.parse(content);

    return res.json({
      ok: true,
      text: result.text,
      datetime: result.datetime
    });
  } catch (e) {
    console.error("PARSE ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "server_error"
    });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
