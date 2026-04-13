import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
 
dotenv.config();
 
const app = express();
app.use(cors());
app.use(express.json());
 
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 
// ─── Защита от спама ──────────────────────────────────────────────────────────
 
// 1. Rate limiter — встроенный, без зависимостей
//    Хранит счётчики запросов по IP в памяти
const rateLimitMap = new Map(); // ip -> { count, resetAt }
 
const RATE_LIMIT     = 30;   // максимум запросов
const RATE_WINDOW_MS = 60_000; // за 60 секунд
 
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
 
  if (!entry || now > entry.resetAt) {
    // Новое окно
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
 
  if (entry.count >= RATE_LIMIT) {
    return false; // превышен лимит
  }
 
  entry.count++;
  return true;
}
 
// Чистим старые записи раз в 5 минут чтобы не накапливались
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);
 
// 2. Секретный ключ приложения
//    Задай в переменных окружения Render: APP_SECRET=любой_длинный_ключ
//    Если не задан — проверка отключена (для совместимости)
const APP_SECRET = process.env.APP_SECRET || null;
 
function authMiddleware(req, res, next) {
  // Rate limit по IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    console.warn(`[RATE_LIMIT] ${ip}`);
    return res.status(429).json({ ok: false, error: "too_many_requests" });
  }
 
  // Проверка секретного ключа (если задан)
  if (APP_SECRET) {
    const key = req.headers['x-app-key'];
    if (key !== APP_SECRET) {
      console.warn(`[AUTH_FAIL] ${ip} key=${key?.slice(0,8)}`);
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
  }
 
  next();
}
 
// ─────────────────────────────────────────────────────────────────────────────
 
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
    .replace(/\b(послезавтра|day after tomorrow|übermorgen|après-demain|pasado mañana|pojutrze|dopodomani)\b/gi, " ")
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
  const hasDayAfterTomorrow = /\b(послезавтра|day after tomorrow|übermorgen|après-demain|pasado mañana|pojutrze|dopodomani)\b/i.test(src);
  const hasTomorrow = !hasDayAfterTomorrow && /\b(завтра|tomorrow|morgen|demain|mañana|jutro|domani)\b/i.test(src);
  const hasToday    = /\b(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi)\b/i.test(src);
 
  let m = src.match(/\b(?:в|во|о|at|um|а|a las|o|alle)?\s*(\d{1,2})[:.](\d{2})\b/i);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const dt = new Date(now);
      dt.setHours(hour, minute, 0, 0);
      if (hasDayAfterTomorrow) dt.setDate(dt.getDate() + 2);
      else if (hasTomorrow) dt.setDate(dt.getDate() + 1);
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
      if (hasDayAfterTomorrow) dt.setDate(dt.getDate() + 2);
      else if (hasTomorrow) dt.setDate(dt.getDate() + 1);
      else if (!hasToday && dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 1);
      return { text: cleanTaskText(text), datetime: toIsoWithOffsetFromLocal(dt, offsetMinutes) };
    }
  }
  return null;
}
 
app.post("/parse", authMiddleware, async (req, res) => {
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
              "For RELATIVE time (через/in + number): add that duration to 'now'. " +
              "For ABSOLUTE time: extract the exact HH:MM the user said. " +
              "For 'завтра/tomorrow': use tomorrow's date. " +
              "For 'послезавтра/day after tomorrow': use the day after tomorrow. " +
              "For 'через N дней/in N days': add N days to now."
          },
          {
            role: "user",
            content: JSON.stringify({ locale, now: nowIso, text: cleanedText })
          }
        ]
      });
 
      const content = aiResponse.choices?.[0]?.message?.content;
      if (content) {
        const result = JSON.parse(content);
        if (result.text && result.datetime) {
          const words = cleanedText.toLowerCase();
 
          // Сервер сам вычисляет дату — AI только парсит время HH:MM
          // Получаем время от AI
          const timeMatch = result.datetime.match(/T(\d{2}:\d{2}:\d{2})/);
          const timeStr = timeMatch ? timeMatch[1] : null;
          const offset = nowIso.slice(19); // +03:00
 
          if (timeStr) {
            const dt = new Date(localNow);
 
            // Проверяем слова про день
            // Для относительного времени (через N минут/часов) — AI считает сам, не трогаем дату
            const isRelativeTime = /\bчерез\s+\d+\s*(мин|минут|час|секунд|сек)/i.test(words) ||
                                   /\bin\s+\d+\s*(min|hour|sec)/i.test(words);
            if (isRelativeTime) {
              // Оставляем datetime от AI как есть
              console.log(`[AI/relative] "${cleanedText}" -> ${result.datetime}`);
              return res.json({ ok: true, text: result.text, datetime: result.datetime, lang, source: "ai" });
            }
 
            //  не работает с кириллицей — используем пробелы/начало строки
            const isTomorrow = /(^|\s)(завтра)(\s|$)/i.test(words) ||
                               /\b(tomorrow|morgen|demain|mañana|jutro|domani)\b/i.test(words);
            const isDayAfter = /(^|\s)(послезавтра)(\s|$)/i.test(words) ||
                               /\b(day after tomorrow|übermorgen|après-demain|pasado mañana|pojutrze|dopodomani)\b/i.test(words);
            const daysMatch  = words.match(/через\s+(\d+)\s*(дн|день|дней|дня)/i) ||
                               words.match(/\bin\s+(\d+)\s*days?\b/i);
            const nDays      = daysMatch ? parseInt(daysMatch[1]) : 0;
 
            // Дни недели — на всех языках приложения
            // 0=вс, 1=пн, 2=вт, 3=ср, 4=чт, 5=пт, 6=сб
            const weekdayMap = [
              // воскресенье
              [/(^|\s)(воскресенье|воскресенья|неділя|неділю)(\s|$)/i, /\b(sunday|sonntag|dimanche|domingo|niedziela|domenica)\b/i, 0],
              // понедельник
              [/(^|\s)(понедельник|понедельника|понеділок|понеділка)(\s|$)/i, /\b(monday|montag|lundi|lunes|poniedziałek|lunedì)\b/i, 1],
              // вторник
              [/(^|\s)(вторник|вторника|вівторок|вівторка)(\s|$)/i, /\b(tuesday|dienstag|mardi|martes|wtorek|martedì)\b/i, 2],
              // среда
              [/(^|\s)(среда|среду|середа|середу)(\s|$)/i, /\b(wednesday|mittwoch|mercredi|miércoles|środa|mercoledì)\b/i, 3],
              // четверг
              [/(^|\s)(четверг|четверга|четвер|четверга)(\s|$)/i, /\b(thursday|donnerstag|jeudi|jueves|czwartek|giovedì)\b/i, 4],
              // пятница
              [/(^|\s)(пятница|пятницу|п'ятниця|п'ятницю)(\s|$)/i, /\b(friday|freitag|vendredi|viernes|piątek|venerdì)\b/i, 5],
              // суббота
              [/(^|\s)(суббота|субботу|субота|суботу)(\s|$)/i, /\b(saturday|samstag|samedi|sábado|sobota|sabato)\b/i, 6],
            ];
 
            // Ищем день недели во фразе
            let weekdayTarget = -1;
            for (const [reCyrillic, reLatin, dayNum] of weekdayMap) {
              if (reCyrillic.test(words) || reLatin.test(words)) {
                weekdayTarget = dayNum;
                break;
              }
            }
 
            if (isDayAfter) {
              dt.setDate(dt.getDate() + 2);
            } else if (isTomorrow) {
              dt.setDate(dt.getDate() + 1);
            } else if (nDays > 0) {
              dt.setDate(dt.getDate() + nDays);
            } else if (weekdayTarget !== -1) {
              // Вычисляем сколько дней до нужного дня недели
              const todayDay = localNow.getDay(); // 0=вс..6=сб
              let diff = weekdayTarget - todayDay;
              if (diff < 0) diff += 7;   // уже прошёл на этой неделе — берём следующую
              // diff === 0 означает сегодня — оставляем сегодня
              dt.setDate(dt.getDate() + diff);
            }
 
            // Иначе — сегодня, но проверяем не прошло ли время
            if (!isDayAfter && !isTomorrow && nDays === 0 && weekdayTarget === -1) {
              const [h, m] = timeStr.split(':').map(Number);
              const aiTotalMin = h * 60 + m;
              const nowTotalMin = localNow.getHours() * 60 + localNow.getMinutes();
              const hasToday = /(^|\s)(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi)(\s|$)/i.test(words);
              if (aiTotalMin < nowTotalMin && !hasToday) {
                dt.setDate(dt.getDate() + 1);
              }
            }
 
            const y  = dt.getFullYear();
            const mo = pad2(dt.getMonth() + 1);
            const d  = pad2(dt.getDate());
            result.datetime = `${y}-${mo}-${d}T${timeStr}${offset}`;
          }
 
          console.log(`[AI] "${cleanedText}" -> ${result.datetime}`);
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

