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
  res.send("Server v2 parser active");
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

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a reminder parser. Extract reminder task text and exact datetime from the user phrase. Return only valid JSON with keys text and datetime. Datetime must be ISO 8601. Use locale, timezone, and now as source of truth. Support Russian, Ukrainian, and English. Remove time words from text."
        },
        {
          role: "user",
          content: JSON.stringify({
            locale,
            timezone,
            now,
            text,
            examples: [
              {
                input: "позвонить завтра в 8 утра",
                output: {
                  text: "позвонить",
                  datetime: "2026-04-03T08:00:00+03:00"
                }
              },
              {
                input: "таблетки в 2 дня",
                output: {
                  text: "таблетки",
                  datetime: "2026-04-02T14:00:00+03:00"
                }
              },
              {
                input: "напомни через 1 день",
                output: {
                  text: "напомни",
                  datetime: "2026-04-03T10:00:00+03:00"
                }
              },
              {
                input: "напомни через 1 час 20 минут",
                output: {
                  text: "напомни",
                  datetime: "2026-04-02T11:20:00+03:00"
                }
              },
              {
                input: "восемь сорок пять вечера позвонить другу",
                output: {
                  text: "позвонить другу",
                  datetime: "2026-04-02T20:45:00+03:00"
                }
              }
            ]
          })
        }
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

    if (!result.text || !result.datetime) {
      return res.status(500).json({
        ok: false,
        error: "Invalid JSON from model",
        raw: result
      });
    }

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
