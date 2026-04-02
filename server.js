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
  res.send("Server is working ??");
});

app.post("/parse", async (req, res) => {
  try {
    const { text, locale, timezone, now } = req.body;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Извлеки напоминание и время.

Ответ строго JSON:
{
 "text": "...",
 "datetime": "ISO дата"
}
`
        },
        {
          role: "user",
          content: JSON.stringify({ text, locale, timezone, now })
        }
      ]
    });

    const result = JSON.parse(response.choices[0].message.content);

    res.json({
      ok: true,
      ...result
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

app.listen(3000, () => {
  console.log("Server started");
});