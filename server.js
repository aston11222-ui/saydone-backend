import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Rate limiter ──────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT     = 30;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimitMap.entries()) if (now > e.resetAt) rateLimitMap.delete(ip);
}, 5 * 60_000);

const APP_SECRET = process.env.APP_SECRET || null;
function authMiddleware(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: "too_many_requests" });
  if (APP_SECRET) {
    const key = req.headers['x-app-key'];
    if (key !== APP_SECRET) return res.status(403).json({ ok: false, error: "forbidden" });
  }
  next();
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, "0");
function offsetToStr(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs  = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
function toIso(date, offsetMinutes) {
  return `${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}` +
         `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
         offsetToStr(offsetMinutes);
}
function parseLocalNow(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0), 0);
}
function resolveTime(body) {
  const { now } = body;
  if (!now) return null;
  const localNow = parseLocalNow(now);
  if (!localNow) return null;
  let offsetMinutes = 0;
  const m = String(now).match(/([+-])(\d{2}):(\d{2})$/);
  if (m) offsetMinutes = (+m[2] * 60 + +m[3]) * (m[1] === '+' ? 1 : -1);
  return { localNow, offsetMinutes };
}

app.get("/",       (_, res) => res.send("SayDone multilingual parser v2"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ── Main parse endpoint ───────────────────────────────────────────────────────
app.post("/parse", authMiddleware, async (req, res) => {
  try {
    const { text, locale } = req.body ?? {};
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    const timeCtx = resolveTime(req.body);
    if (!timeCtx) return res.status(400).json({ ok: false, error: "Missing time context" });

    const { localNow, offsetMinutes } = timeCtx;
    const nowIso    = toIso(localNow, offsetMinutes);
    const offsetStr = offsetToStr(offsetMinutes);
    const input     = String(text).replace(/\s+/g, " ").trim();

    const DOW = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const dow = DOW[localNow.getDay()];

    // ── System prompt: completely delegate to AI, server only validates ──────
    const systemPrompt = `You are a precise multilingual reminder parser for a voice reminder app.
The user speaks one of: Russian, Ukrainian, English, German, French, Spanish, Polish.

Current local time: ${nowIso} (${dow})
Timezone offset: ${offsetStr}

Your job: extract (1) the task text and (2) the exact datetime.

DATE RULES — read carefully for every language:

RELATIVE DAYS (add N days to TODAY's date):
  Russian:   "через N день/дня/дней"
  Ukrainian: "через N день/дня/дні/днів" OR "за N день/дня/дні/днів"
  English:   "in N day/days"
  German:    "in N Tag/Tagen"
  French:    "dans N jour/jours"
  Spanish:   "en N día/días"
  Polish:    "za N dzień/dni"

TOMORROW (today's date + 1):
  RU: "завтра" | UK: "завтра" | EN: "tomorrow" | DE: "morgen" | FR: "demain" | ES: "mañana" | PL: "jutro"

DAY AFTER TOMORROW (today's date + 2):
  RU: "послезавтра" | UK: "після завтра"/"позавтра" | EN: "day after tomorrow" | DE: "übermorgen" | FR: "après-demain" | ES: "pasado mañana" | PL: "pojutrze"

WEEKDAYS (next occurrence of that weekday; if today is that day, use next week):
  Monday:    RU: понедельник | UK: понеділок | DE: Montag | FR: lundi | ES: lunes | PL: poniedziałek
  Tuesday:   RU: вторник | UK: вівторок | DE: Dienstag | FR: mardi | ES: martes | PL: wtorek
  Wednesday: RU: среда | UK: середа | DE: Mittwoch | FR: mercredi | ES: miércoles | PL: środa
  Thursday:  RU: четверг | UK: четвер | DE: Donnerstag | FR: jeudi | ES: jueves | PL: czwartek
  Friday:    RU: пятница | UK: п'ятниця | DE: Freitag | FR: vendredi | ES: viernes | PL: piątek
  Saturday:  RU: суббота | UK: субота | DE: Samstag | FR: samedi | ES: sábado | PL: sobota
  Sunday:    RU: воскресенье | UK: неділя | DE: Sonntag | FR: dimanche | ES: domingo | PL: niedziela

TIME OF DAY RULES:
  Morning (am): RU: "утра/утром" | UK: "ранку/вранці" | EN: "am/morning" | DE: "morgens/Uhr morgens"
  Afternoon:    RU: "дня" | UK: "дня" | EN: "afternoon" | DE: "nachmittags"
  Evening (pm): RU: "вечера/вечером" | UK: "вечора/увечері" | EN: "pm/evening" | DE: "abends" | FR: "du soir" | ES: "de la tarde/noche" | PL: "wieczorem"
  Night:        RU: "ночи/ночью" | UK: "ночі/вночі" | EN: "at night" | DE: "nachts"
  
  "9 вечера" = "9 вечора" = "9 pm" = "9 abends" = 21:00
  "9 утра"   = "9 ранку"  = "9 am" = "9 morgens" = 09:00
  "3 дня"    = "3 дня"    = "3 pm" = 15:00
  "полдень"  = "полудень" = "noon" = "midi" = "mediodía" = 12:00

RELATIVE TIME (add to current datetime):
  RU/UK: "через N минут/хвилин" → +N minutes
  RU/UK: "через N часа/годин"   → +N hours
  EN: "in N minutes/hours"
  DE: "in N Minuten/Stunden"
  FR: "dans N minutes/heures"
  ES: "en N minutos/horas"
  PL: "za N minut/godzin"

DEFAULT: if no time stated → 09:00. If no date stated and time has passed today → tomorrow.

TASK TEXT: strip ALL date/time words. Keep only the task. Use same language as input.

Return ONLY valid JSON, no markdown:
{"text": "task description", "datetime": "YYYY-MM-DDTHH:MM:SS${offsetStr}"}`;

    const userMsg = `Locale: ${locale || "unknown"}\nVoice input: "${input}"`;

    // ── Call OpenAI ───────────────────────────────────────────────────────────
    let aiResult = null;
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system",  content: systemPrompt },
          { role: "user",    content: userMsg      },
        ],
      });
      const raw = response.choices?.[0]?.message?.content;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.text && parsed.datetime) aiResult = parsed;
      }
    } catch (aiErr) {
      console.warn("[AI] error:", aiErr.message);
    }

    if (aiResult) {
      // Validate datetime format — must be parseable
      const dt = new Date(aiResult.datetime);
      if (!isNaN(dt.getTime())) {
        console.log(`[AI] "${input}" → ${aiResult.datetime}`);
        return res.json({ ok: true, text: aiResult.text, datetime: aiResult.datetime, source: "ai" });
      }
      console.warn("[AI] invalid datetime:", aiResult.datetime);
    }

    // ── Fallback: regex rules ─────────────────────────────────────────────────
    const w = input.toLowerCase();

    // Helper: set HH:MM on a date
    function withTime(d, h, m) { const r = new Date(d); r.setHours(h, m, 0, 0); return r; }
    function addDays(d, n)      { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

    // Time period → hour offset
    function periodHour(h, period) {
      const p = (period || "").toLowerCase();
      const eve = ["вечера","вечером","вечора","увечері","evening","pm","abends","du soir","de la tarde","de la noche","wieczorem","tarde"];
      const morn = ["утра","утром","ранку","вранці","morning","am","morgens","du matin","de la mañana","rano"];
      const aftn = ["дня","afternoon","nachmittags","de l'après-midi"];
      const nght = ["ночи","ночью","ночі","вночі","night","nachts","de noche","w nocy"];
      const hh = Number(h);
      if (eve.some(x => p.includes(x)))  return hh === 12 ? 12 : (hh < 12 ? hh + 12 : hh);
      if (morn.some(x => p.includes(x))) return hh === 12 ? 0  : hh;
      if (aftn.some(x => p.includes(x))) return hh === 12 ? 12 : (hh < 12 ? hh + 12 : hh);
      if (nght.some(x => p.includes(x))) return hh >= 21 ? hh : (hh < 6 ? hh : hh + 12);
      return hh;
    }

    // Detect base date
    let baseDate = new Date(localNow);

    const isDayAfter = /(послезавтра|після\s*завтра|позавтра|day after tomorrow|übermorgen|après-demain|pasado mañana|pojutrze)/i.test(w);
    const isTomorrow = !isDayAfter && /(^|\s)(завтра|tomorrow|morgen|demain|mañana|jutro)(\s|$)/i.test(w);

    const relDays = w.match(/(?:через|за)\s+(\d+)\s*(?:дн[іьейя]|день|дня|днів)|in\s+(\d+)\s*days?|in\s+(\d+)\s*Tagen?|dans\s+(\d+)\s*jours?|en\s+(\d+)\s*días?|za\s+(\d+)\s*dni/i);
    const nDays = relDays ? +( relDays[1]||relDays[2]||relDays[3]||relDays[4]||relDays[5]||relDays[6] ) : 0;

    // Relative minutes/hours
    const relMins  = w.match(/(?:через|за)\s+(\d+)\s*(?:мин(?:ут[аы]?|ут)?|хвилин)|in\s+(\d+)\s*minutes?|dans\s+(\d+)\s*minutes?|en\s+(\d+)\s*minutos?|za\s+(\d+)\s*minut|in\s+(\d+)\s*Minuten?/i);
    const relHours = w.match(/(?:через|за)\s+(\d+)\s*(?:час(?:а|ов|ів)?|годин(?:и|)?)|in\s+(\d+)\s*hours?|dans\s+(\d+)\s*heures?|en\s+(\d+)\s*horas?|za\s+(\d+)\s*godzin|in\s+(\d+)\s*Stunden?/i);

    if (relMins) {
      const n = +( relMins[1]||relMins[2]||relMins[3]||relMins[4]||relMins[5]||relMins[6] );
      const dt = new Date(localNow); dt.setMinutes(dt.getMinutes() + n);
      const task = input.replace(/(?:напомни|нагадай|remind me to?|erinnere mich)\s+/i,"").replace(/через\s+\d+\s*\S+/i,"").trim() || input;
      return res.json({ ok: true, text: task, datetime: toIso(dt, offsetMinutes), source: "rule" });
    }
    if (relHours) {
      const n = +( relHours[1]||relHours[2]||relHours[3]||relHours[4]||relHours[5]||relHours[6] );
      const dt = new Date(localNow); dt.setHours(dt.getHours() + n);
      const task = input.replace(/(?:напомни|нагадай|remind me to?|erinnere mich)\s+/i,"").replace(/через\s+\d+\s*\S+/i,"").trim() || input;
      return res.json({ ok: true, text: task, datetime: toIso(dt, offsetMinutes), source: "rule" });
    }

    if (isDayAfter)   baseDate = addDays(localNow, 2);
    else if (isTomorrow) baseDate = addDays(localNow, 1);
    else if (nDays > 0)  baseDate = addDays(localNow, nDays);

    // Detect time  
    // Strip relative day/week expressions so their numbers don't confuse time parsing
  const wNoRel = w
    .replace(/(?:через|за)\s+\d+\s*(?:дн[іьейя]|день|дня|днів|хвилин|хвилини|годин(?:и|)?|час(?:а|ів|ів)?)/gi, "")
    .replace(/in\s+\d+\s*(?:days?|hours?|minutes?|Tagen?|Stunden?|Minuten?)/gi, "")
    .replace(/dans\s+\d+\s*(?:jours?|heures?|minutes?)/gi, "")
    .replace(/en\s+\d+\s*(?:días?|horas?|minutos?)/gi, "")
    .replace(/za\s+\d+\s*(?:dni|godzin|minut)/gi, "")
    .trim();

  // Match: explicit HH:MM, or hour with period word, or hour with time preposition
  // Priority 1: explicit HH:MM (always unambiguous)
  let tm = wNoRel.match(/\b(\d{1,2}):(\d{2})\b/i);
  let tmHour, tmMin, tmPeriod;
  if (tm) {
    tmHour = +tm[1]; tmMin = +tm[2]; tmPeriod = "";
  } else {
    // Priority 2: hour + period word (9 вечора, 9 pm, 9 abends, 21h, etc.)
    const periodRe = /(\d{1,2})h?\s*(?:uhr\s*)?(утра|утром|ранку|вранці|дня|вечера|вечером|вечора|увечері|ночи|ночью|ночі|вночі|morning|afternoon|evening|night|am|pm|morgens|abends|nachts|nachmittags|du soir|du matin|de la tarde|de la noche|de la mañana|wieczorem|rano)/i;
    tm = wNoRel.match(periodRe);
    if (tm) {
      tmHour = +tm[1]; tmMin = 0; tmPeriod = tm[2];
    } else {
      // Priority 3: preposition + hour (о 9, at 9, um 9, à 9, a las 9)
      const prepRe = /(?:^|\s)(?:в|во|о|at|um|à|a las|alle|o)\s+(\d{1,2})(?:[:.h](\d{2}))?(?!\s*(?:дн|day|Tag|jour|día|dni))/i;
      tm = wNoRel.match(prepRe);
      if (tm) { tmHour = +tm[1]; tmMin = tm[2] ? +tm[2] : 0; tmPeriod = ""; }
    }
  }
  const hasTm = tm != null;
    if (hasTm) {
      const hRaw = tmHour, mRaw = tmMin, period = tmPeriod;
      const h24 = periodHour(hRaw, period);
      if (h24 >= 0 && h24 <= 23 && mRaw >= 0 && mRaw <= 59) {
        let dt = withTime(baseDate, h24, mRaw);
        // If same-day time already passed and no explicit date → push to tomorrow
        if (!isDayAfter && !isTomorrow && nDays === 0 && dt.getTime() <= localNow.getTime()) {
          dt = addDays(dt, 1);
        }
        const task = input.replace(/(?:напомни|нагадай|remind me to?|erinnere mich)\s+/i,"")
          .replace(/(через|за)\s+\d+\s*\S+/gi,"")
          .replace(/завтра|послезавтра|tomorrow|morgen|demain|mañana|jutro/gi,"")
          .replace(/\d{1,2}[:.]?\d{0,2}\s*(утра|утром|ранку|вранці|дня|вечера|вечором|вечора|увечері|ночи|ночью|ночі|вночі|morning|afternoon|evening|night|am|pm|morgens|abends|du soir|du matin|de la tarde|wieczorem|rano)/gi,"")
          .replace(/\s+/g," ").trim() || input;
        return res.json({ ok: true, text: task, datetime: toIso(dt, offsetMinutes), source: "rule" });
      }
    }

    // No time found — use 09:00
    if (isDayAfter || isTomorrow || nDays > 0) {
      const dt = withTime(baseDate, 9, 0);
      return res.json({ ok: true, text: input, datetime: toIso(dt, offsetMinutes), source: "rule/notime" });
    }

    return res.json({ ok: true, text: input, datetime: "", source: "unparsed" });

  } catch (e) {
    console.error("PARSE ERROR:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SayDone parser v2 started on port ${port}`));

