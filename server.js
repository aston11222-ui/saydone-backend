import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
 
dotenv.config();
 
const app = express();
app.use(cors());
app.use(express.json());
 
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 
app.get("/", (_, res) => res.send("Hybrid multilingual parser active"));
app.get("/health", (_, res) => res.json({ ok: true }));
 
function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
function pad2(n) { return String(n).padStart(2, "0"); }
function offsetMinutesToIso(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs  = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
function toIsoWithOffsetFromLocal(date, offsetMinutes) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    offsetMinutesToIso(offsetMinutes)
  );
}
function parseLocalNow(localNow) {
  const m = String(localNow).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]||0), 0);
}
function resolveTime(body) {
  const { now, local_now, utc_offset_minutes } = body;
  if (now) {
    const localNow = parseLocalNow(now);
    if (!localNow) return null;
    let offsetMinutes = 0;
    const m = String(now).match(/([+-])(\d{2}):(\d{2})$/);
    if (m) offsetMinutes = (Number(m[2]) * 60 + Number(m[3])) * (m[1] === '+' ? 1 : -1);
    return { localNow, offsetMinutes };
  }
  if (local_now && typeof utc_offset_minutes === "number") {
    const localNow = parseLocalNow(local_now);
    if (!localNow) return null;
    return { localNow, offsetMinutes: utc_offset_minutes };
  }
  return null;
}
function detectLang(locale, text) {
  const l = String(locale || "").toLowerCase();
  const t = String(text || "");
  if (l.startsWith("uk")) return "uk";
  if (l.startsWith("ru")) return "ru";
  if (l.startsWith("en")) return "en";
  if (l.startsWith("de")) return "de";
  if (l.startsWith("fr")) return "fr";
  if (l.startsWith("es")) return "es";
  if (l.startsWith("pl")) return "pl";
  if (l.startsWith("it")) return "it";
  if (/[a-z]/i.test(t)) return "en";
  return "unknown";
}
function cleanTaskText(text) {
  let t = normalizeWhitespace(text);
  t = t
    .replace(/^\s*(поставь напоминание|напомни|напомнить)\s+/i, "")
    .replace(/^\s*(поставити нагадування|нагадай|нагадати)\s+/i, "")
    .replace(/^\s*(remind me to|remind me)\s+/i, "")
    .replace(/\b(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi)\b/gi, " ")
    .replace(/\b(завтра|tomorrow|morgen|demain|mañana|jutro|domani)\b/gi, " ")
    .replace(/\bчерез\s+\S+(\s+\S+)?\b/gi, " ")
    .replace(/\bin\s+\S+(\s+\S+)?\b/gi, " ")
    .replace(/\b(?:в|во|о|at|um)?\s*\d{1,2}(?:[:.\s]\d{2})?\s*(утра|утром|дня|вечера|вечером|ночи|ранку|вранці|вечора|увечері|ночі|morning|afternoon|evening|night|am|pm)?\b/gi, " ");
  t = normalizeWhitespace(t);
  return t || normalizeWhitespace(text);
}
function parseRelative(text, now, offsetMinutes) {
  const src = text.toLowerCase();
  const patterns = [
    { re: /\bчерез\s+пол\s*часа\b/i, amount: 30, unit: "minute" },
    { re: /\bчерез\s+полчаса\b/i,     amount: 30, unit: "minute" },
    { re: /\bчерез\s+час\b/i,         amount: 1,  unit: "hour"   },
    { re: /\bчерез\s+(\d+)\s*мин(?:ут[аы]?|ут|)\b/i, unit: "minute" },
    { re: /\bчерез\s+(\d+)\s*час(?:а|ов)?\b/i,        unit: "hour"   },
    { re: /\bчерез\s+(\d+)\s*дн(?:я|ей)?\b/i,         unit: "day"    },
    { re: /\bчерез\s+день\b/i,        amount: 1,  unit: "day"    },
    { re: /\bчерез\s+пів\s+години\b/i,amount: 30, unit: "minute" },
    { re: /\bчерез\s+годину\b/i,      amount: 1,  unit: "hour"   },
    { re: /\bчерез\s+(\d+)\s*хвилин\b/i,             unit: "minute" },
    { re: /\bчерез\s+(\d+)\s*годин(?:и|)?\b/i,        unit: "hour"   },
    { re: /\bчерез\s+(\d+)\s*дн(?:і|ів)\b/i,          unit: "day"    },
    { re: /\bin\s+half\s+an\s+hour\b/i, amount: 30, unit: "minute" },
    { re: /\bin\s+an\s+hour\b/i,        amount: 1,  unit: "hour"   },
    { re: /\bin\s+(\d+)\s*minutes?\b/i, unit: "minute" },
    { re: /\bin\s+(\d+)\s*hours?\b/i,   unit: "hour"   },
    { re: /\bin\s+(\d+)\s*days?\b/i,    unit: "day"    },
  ];
  for (const p of patterns) {
    const m = src.match(p.re);
    if (!m) continue;
    const amount = p.amount ?? Number(m[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const dt = new Date(now);
    if (p.unit === "minute") dt.setMinutes(dt.getMinutes() + amount);
    if (p.unit === "hour")   dt.setHours(dt.getHours() + amount);
    if (p.unit === "day")    dt.setDate(dt.getDate() + amount);
    return { text: cleanTaskText(text), datetime: toIsoWithOffsetFromLocal(dt, offsetMinutes) };
  }
  return null;
}
function periodTo24Hour(hour, period) {
  const h = Number(hour);
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  if (h > 12) return h;
  const p = (period || "").toLowerCase();
  const morning   = ["утра","утром","ранку","вранці","morning","am","morgens"];
  const afternoon = ["дня","afternoon","nachmittags"];
  const evening   = ["вечера","вечером","вечора","увечері","evening","pm","abends"];
  const night     = ["ночи","ночью","ночі","вночі","night","nachts"];
  if (morning.includes(p))   return h === 12 ? 0 : h;
  if (afternoon.includes(p)) return h === 12 ? 12 : h + 12;
  if (evening.includes(p))   return h === 12 ? 12 : h + 12;
  if (night.includes(p))     return h === 12 ? 0 : h;
  return h;
}
function parseAbsolute(text, now, offsetMinutes) {
  const src = text.toLowerCase();
  const hasTomorrow = /\b(завтра|tomorrow|morgen|demain|mañana|jutro|domani)\b/i.test(src);
  const hasToday    = /\b(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi)\b/i.test(src);
 
  let m = src.match(/\b(?:в|во|о|at|um|а|a las|o|alle)?\s*(\d{1,2})[:.](\d{2})\b/i);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const dt = new Date(now);
      dt.setHours(hour, minute, 0, 0);
      if (hasTomorrow) dt.setDate(dt.getDate() + 1);
      else if (!hasToday && dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 1);
      return { text: cleanTaskText(text), datetime: toIsoWithOffsetFromLocal(dt, offsetMinutes) };
    }
  }
 
  m = src.match(
    /\b(?:в|во|о|at|um|а|a las|o|alle)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(утра|утром|дня|вечера|вечером|ночи|ранку|вранці|вечора|увечері|ночі|morning|afternoon|evening|night|am|pm|morgens|nachmittags|abends|nachts)\b/i
  );
  if (m) {
    const hour24 = periodTo24Hour(m[1], m[3]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour24 != null && minute >= 0 && minute <= 59) {
      const dt = new Date(now);
      dt.setHours(hour24, minute, 0, 0);
      if (hasTomorrow) dt.setDate(dt.getDate() + 1);
      else if (!hasToday && dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 1);
      return { text: cleanTaskText(text), datetime: toIsoWithOffsetFromLocal(dt, offsetMinutes) };
    }
  }
  return null;
}
 
app.post("/parse", async (req, res) => {
  try {
    const { text, locale } = req.body ?? {};
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });
 
    const timeCtx = resolveTime(req.body);
    if (!timeCtx) return res.status(400).json({ ok: false, error: "Missing time context" });
 
    const { localNow, offsetMinutes } = timeCtx;
    const cleanedText = normalizeWhitespace(text);
    const lang = detectLang(locale, cleanedText);
    const nowIso = toIsoWithOffsetFromLocal(localNow, offsetMinutes);
 
    // 1. OpenAI
    try {
      const aiResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a reminder parser. Extract the reminder task and exact datetime from the user phrase. " +
              "Return ONLY valid JSON with keys 'text' (task without time words) and 'datetime' (ISO 8601 with timezone offset). " +
              "Support Russian, Ukrainian, English, German, French, Spanish, Polish, Italian. " +
              "Use the provided 'now' as the current local time. " +
              "For RELATIVE time (через/in/fra/dans + number): add that duration to 'now' to get the exact datetime. " +
              "For ABSOLUTE time (at 9pm, в 6 утра, в 14:00): compare with 'now'. If that time is STILL IN THE FUTURE today, keep it today. Only schedule for tomorrow if the time has ALREADY PASSED. " +
              "Example: now=07:19, user says 'в 12:00 дня' -> today at 12:00 (future). now=21:50, user says 'в 9 вечера' -> tomorrow (past)."
          },
          {
            role: "user",
            content: JSON.stringify({
              locale,
              now: nowIso,
              text: cleanedText,
              examples: [
                { input: "позвонить завтра в 8 утра",            output: { text: "позвонить",        datetime: "2026-04-09T08:00:00+03:00" } },
                { input: "таблетки в 2 дня",                     output: { text: "таблетки",          datetime: "2026-04-08T14:00:00+03:00" } },
                { input: "напомни через 1 час 20 минут",         output: { text: "напомни",           datetime: "2026-04-08T22:20:00+03:00" } },
                { input: "поставь напоминание в 2 ночи",        output: { text: "напоминание",       datetime: "2026-04-09T02:00:00+03:00" } },
                { input: "взять документ в 9 49 вечера",        output: { text: "взять документ",    datetime: "2026-04-09T21:49:00+03:00" } },
              ]
            })
          }
        ]
      });
 
      const content = aiResponse.choices?.[0]?.message?.content;
      if (content) {
        const result = JSON.parse(content);
        if (result.text && result.datetime) {
                    // Если AI вернул прошедшее время — переносим на завтра
          // Сравниваем строки напрямую чтобы избежать UTC конвертации
          const words = cleanedText.toLowerCase();
          const hasRelative = words.includes('через') || /\bin\s+\d/i.test(words);
          if (!hasRelative) {
            // Берём только дату и время из ISO строки без timezone конвертации
            const dtStr = result.datetime; // например 2026-04-09T07:00:00+03:00
            const dtMatch = dtStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
            if (dtMatch) {
              const aiH = parseInt(dtMatch[4]), aiM = parseInt(dtMatch[5]);
              const nowH = localNow.getHours(), nowM = localNow.getMinutes();
              const aiTotalMin = aiH * 60 + aiM;
              const nowTotalMin = nowH * 60 + nowM;
              if (aiTotalMin < nowTotalMin) {
                // Просто заменяем дату в строке на завтра
                const tomorrow = new Date(localNow);
                tomorrow.setDate(tomorrow.getDate() + 1);
                const y = tomorrow.getFullYear();
                const mo = pad2(tomorrow.getMonth() + 1);
                const d = pad2(tomorrow.getDate());
                result.datetime = result.datetime.replace(/^\d{4}-\d{2}-\d{2}/, `${y}-${mo}-${d}`);
                console.log(`[AI+tomorrow] "${cleanedText}" -> ${result.datetime}`);
              } else {
                console.log(`[AI] "${cleanedText}" -> ${result.datetime}`);
              }
            }
          } else {
            console.log(`[AI] "${cleanedText}" -> ${result.datetime}`);
          }
 
          return res.json({ ok: true, text: result.text, datetime: result.datetime, lang, source: "ai" });
        }
      }
    } catch (aiErr) {
      console.warn("OpenAI failed, fallback to rules:", aiErr.message);
    }
 
    // 2. Fallback regex
    const relative = parseRelative(cleanedText, localNow, offsetMinutes);
    if (relative) {
      console.log(`[RULE/relative] "${cleanedText}" -> ${relative.datetime}`);
      return res.json({ ok: true, ...relative, lang, source: "relative_rule" });
    }
 
    const absolute = parseAbsolute(cleanedText, localNow, offsetMinutes);
    if (absolute) {
      console.log(`[RULE/absolute] "${cleanedText}" -> ${absolute.datetime}`);
      return res.json({ ok: true, ...absolute, lang, source: "absolute_rule" });
    }
 
    // 3. Не распознали время
    return res.json({ ok: true, text: cleanedText, datetime: "", lang, source: "unparsed" });
 
  } catch (e) {
    console.error("PARSE ERROR:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});
 
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server started on port ${port}`));

