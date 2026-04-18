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
const RATE_LIMIT = 30, RATE_WINDOW_MS = 60_000;
function checkRateLimit(ip) {
  const now = Date.now(), entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) { rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS }); return true; }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++; return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of rateLimitMap.entries()) if (now > e.resetAt) rateLimitMap.delete(ip); }, 5*60_000);

const APP_SECRET = process.env.APP_SECRET || null;
function authMiddleware(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: "too_many_requests" });
  if (APP_SECRET && req.headers['x-app-key'] !== APP_SECRET) return res.status(403).json({ ok: false, error: "forbidden" });
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, "0");
function offsetToStr(o) { const s = o>=0?"+":"-", a=Math.abs(o); return `${s}${pad2(Math.floor(a/60))}:${pad2(a%60)}`; }
function toIso(d, o) {
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${offsetToStr(o)}`;
}
function parseLocalNow(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0), 0) : null;
}
function resolveTime(body) {
  const localNow = parseLocalNow(body.now); if (!localNow) return null;
  let offsetMinutes = 0;
  const m = String(body.now).match(/([+-])(\d{2}):(\d{2})$/);
  if (m) offsetMinutes = (+m[2]*60 + +m[3]) * (m[1]==='+' ? 1 : -1);
  return { localNow, offsetMinutes };
}
function withTime(d, h, m) { const r = new Date(d); r.setHours(h, m, 0, 0); return r; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function normalizeWS(s) { return String(s||"").replace(/\s+/g," ").trim(); }

// ── Period → 24h hour ─────────────────────────────────────────────────────────
function periodTo24h(h, period) {
  const p = (period||"").toLowerCase(), hh = Number(h);
  const evening   = ["вечера","вечером","вечора","увечері","вечір","evening","pm","abends","du soir","de la tarde","de la noche","wieczorem","tarde","soir","noche"];
  const morning   = ["утра","утром","ранку","вранці","morning","am","morgens","du matin","de la mañana","rano","matin","mañana"];
  const afternoon = ["дня","дня","afternoon","nachmittags","de l'après-midi","après-midi"];
  const night     = ["ночи","ночью","ночі","вночі","night","nachts","de noche","w nocy","nuit"];
  if (evening.some(x => p.includes(x)))   return hh===12 ? 12 : (hh<12 ? hh+12 : hh);
  if (morning.some(x => p.includes(x)))   return hh===12 ? 0  : hh;
  if (afternoon.some(x => p.includes(x))) return hh===12 ? 12 : (hh<12 ? hh+12 : hh);
  if (night.some(x => p.includes(x)))     return hh>=21 ? hh : (hh<=5 ? hh : hh+12);
  return hh; // no period — return as-is
}

// ── Weekday detection (all app languages) ─────────────────────────────────────
// Returns 0=Sun,1=Mon,...,6=Sat or -1 if not found
function detectWeekday(w) {
  const map = [
    // Sun=0
    [/(^|\s)(воскресенье|воскресенья|воскресіння|неділя|неділю|неділі)(\s|$)/i, /\b(sunday|sonntag|dimanche|domingo|niedziela)\b/i, 0],
    // Mon=1
    [/(^|\s)(понедельник|понедельника|понеділок|понеділка|понеділку)(\s|$)/i, /\b(monday|montag|lundi|lunes|poniedziałek)\b/i, 1],
    // Tue=2
    [/(^|\s)(вторник|вторника|вівторок|вівторка|вівторку)(\s|$)/i, /\b(tuesday|dienstag|mardi|martes|wtorek)\b/i, 2],
    // Wed=3
    [/(^|\s)(среда|среду|середа|середу|середи|середі)(\s|$)/i, /\b(wednesday|mittwoch|mercredi|miércoles|środa|środę)\b/i, 3],
    // Thu=4
    [/(^|\s)(четверг|четверга|четвер|четверга|четверу)(\s|$)/i, /\b(thursday|donnerstag|jeudi|jueves|czwartek)\b/i, 4],
    // Fri=5
    [/(^|\s)(пятница|пятницу|п'ятниця|п'ятницю|п'ятниці)(\s|$)/i, /\b(friday|freitag|vendredi|viernes|piątek)\b/i, 5],
    // Sat=6
    [/(^|\s)(суббота|субботу|субота|суботу|суботи)(\s|$)/i, /\b(saturday|samstag|samedi|sábado|sobota)\b/i, 6],
  ];
  for (const [reCyr, reLat, day] of map) {
    if (reCyr.test(w) || reLat.test(w)) return day;
  }
  return -1;
}

// ── Clean task text ───────────────────────────────────────────────────────────
function cleanTask(text) {
  let t = normalizeWS(text);
  // Remove command prefixes
  t = t.replace(/^\s*(поставь напоминание|напомни|напомнить|поставити нагадування|нагадай|нагадати|remind me to|remind me|erinnere mich|rappelle-moi|recuérdame|przypomnij mi|przypomnij)\s+/i, "");
  // Remove day keywords
  t = t.replace(/\b(послезавтра|після\s*завтра|позавтра|day after tomorrow|übermorgen|après-demain|pasado mañana|pojutrze)\b/gi, " ");
  t = t.replace(/(^|\s)(завтра|tomorrow|morgen|demain|mañana|jutro)(\s|$)/gi, " ");
  t = t.replace(/(^|\s)(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj)(\s|$)/gi, " ");
  // Remove relative expressions
  t = t.replace(/\b(через|за)\s+\d+\s*(минут|хвилин|мин|хв|секунд|сек|час(?:а|ов|ів)?|годин(?:и|)?|дн[іьейя]|день|дня|днів|тиждень|неделю)\b/gi, " ");
  t = t.replace(/\b(in|in)\s+\d+\s*(minutes?|hours?|days?|weeks?|Minuten?|Stunden?|Tagen?|Wochen?|jours?|heures?|días?|horas?|dni|godzin|minut|tygodni)\b/gi, " ");
  t = t.replace(/\b(dans|en|za)\s+\d+\s*\S+/gi, " ");
  // Remove time expressions
  t = t.replace(/\b\d{1,2}:\d{2}\b/g, " ");
  t = t.replace(/\b\d{1,2}h\b/gi, " ");
  t = t.replace(/\b\d{1,2}\s*(утра|утром|ранку|вранці|дня|вечера|вечером|вечора|увечері|ночи|ночью|ночі|вночі|morning|afternoon|evening|night|am|pm|morgens|abends|nachts|du soir|du matin|de la tarde|de la noche|de la mañana|wieczorem|rano|uhr)\b/gi, " ");
  t = t.replace(/\b(в|во|о|at|um|à|a las|alle|o)\s+\d{1,2}\b/gi, " ");
  // Remove weekday names
  t = t.replace(/\bна\s+(понедельник|вторник|среду|четверг|пятниц[ау]|суббот[уа]|воскресенье[е]?)\b/gi, " ");
  t = t.replace(/\b(понедельник|вторник|среда|среду|четверг|пятниц[ау]|суббот[уа]|воскресенье[е]?)\b/gi, " ");
  t = t.replace(/\b(понеділок|вівторок|середа?|середу|четвер|п'ятниц[яю]|субот[аи]|неділ[яю])\b/gi, " ");
  t = t.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, " ");
  t = t.replace(/\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/gi, " ");
  t = t.replace(/\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi, " ");
  t = t.replace(/\b(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b/gi, " ");
  t = t.replace(/\b(poniedziałek|wtorek|środa?|środę|czwartek|piątek|sobota|niedziela)\b/gi, " ");
  return normalizeWS(t) || normalizeWS(text);
}

app.get("/", (_, res) => res.send("SayDone multilingual parser v3"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ── Main parse endpoint ───────────────────────────────────────────────────────
app.post("/parse", authMiddleware, async (req, res) => {
  try {
    const { text, locale } = req.body ?? {};
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });
    const timeCtx = resolveTime(req.body);
    if (!timeCtx) return res.status(400).json({ ok: false, error: "Missing time context" });

    const { localNow, offsetMinutes } = timeCtx;
    const nowIso = toIso(localNow, offsetMinutes);
    const offsetStr = offsetToStr(offsetMinutes);
    const input = normalizeWS(text);
    const w = input.toLowerCase();

    const DOW_EN = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const dow = DOW_EN[localNow.getDay()];

    // ── 1. Detect date modifiers (before AI call) ─────────────────────────────
    const isDayAfter = /(послезавтра|після\s*завтра|позавтра|day after tomorrow|übermorgen|après-demain|pasado mañana|pojutrze)/i.test(w);
    const isTomorrow = !isDayAfter && /(^|\s)(завтра|tomorrow|morgen|demain|jutro)(\s|$)/i.test(w);
    const relDaysM = w.match(/(?:(?:через|за)\s+(\d+)\s*(?:дн[іьейя]|день|дня|днів))|(?:in\s+(\d+)\s*days?)|(?:in\s+(\d+)\s*Tagen?)|(?:dans\s+(\d+)\s*jours?)|(?:en\s+(\d+)\s*días?)|(?:za\s+(\d+)\s*dni)/i);
    const nDays = relDaysM ? +([...relDaysM.slice(1)].find(x=>x!=null)||0) : 0;
    const weekdayTarget = detectWeekday(w);

    // Relative minutes/hours (handled separately — no base date change)
    const relMinsM  = w.match(/(?:через|за)\s+(\d+)\s*(?:мин(?:ут[аы]?|ут)?|хвилин(?:и)?)|in\s+(\d+)\s*minutes?|dans\s+(\d+)\s*minutes?|en\s+(\d+)\s*minutos?|za\s+(\d+)\s*minut|in\s+(\d+)\s*Minuten?/i);
    const relHoursM = w.match(/(?:через|за)\s+(\d+)\s*(?:час(?:а|ов|ів)?|годин(?:и|)?)|in\s+(\d+)\s*hours?|dans\s+(\d+)\s*heures?|en\s+(\d+)\s*horas?|za\s+(\d+)\s*godzin|in\s+(\d+)\s*Stunden?/i);

    if (relMinsM) {
      const n = +([...relMinsM.slice(1)].find(x=>x!=null)||0);
      const dt = new Date(localNow); dt.setMinutes(dt.getMinutes() + n);
      return res.json({ ok: true, text: cleanTask(input), datetime: toIso(dt, offsetMinutes), source: "rule/relmin" });
    }
    if (relHoursM) {
      const n = +([...relHoursM.slice(1)].find(x=>x!=null)||0);
      const dt = new Date(localNow); dt.setHours(dt.getHours() + n);
      return res.json({ ok: true, text: cleanTask(input), datetime: toIso(dt, offsetMinutes), source: "rule/relhour" });
    }

    // ── 2. Call OpenAI — get time HH:MM from AI ───────────────────────────────
    const systemPrompt = `You are a multilingual time extractor for a reminder app.
Extract ONLY the time (HH:MM in 24h format) and the task text from the user's voice input.
Languages: Russian, Ukrainian, English, German, French, Spanish, Polish.

Current time: ${nowIso} (${dow})

TIME EXTRACTION RULES:
- "9 вечера/вечора/pm/abends/du soir/de la tarde" → 21:00
- "9 утра/ранку/am/morgens/du matin/de la mañana/rano" → 09:00
- "3 дня/дня/afternoon/nachmittags" → 15:00
- "1 ночи/ночі/night" → 01:00
- "полдень/полудень/noon/midi/mediodía" → 12:00
- "полночь/опівніч/midnight/minuit" → 00:00
- If no time mentioned → use null
- "10:00 утра/ранку/am/morgens" → "10:00" (already 24h, do NOT add 12)
- "10:00 вечера/вечора/pm/abends" → "22:00"
- "8:00 утра/ранку/am" → "08:00"
- When time is in HH:MM format with утра/am/morning → keep as is if < 12
- When time is in HH:MM format with вечера/pm/evening → add 12 if < 12

DO NOT calculate dates. ONLY return the time in 24h HH:MM format.
Task text: remove ALL date/time/weekday words, keep only the task in input language.

Return ONLY valid JSON:
{"time": "HH:MM", "text": "task only"}
If no time found: {"time": null, "text": "task only"}`;

    let aiTime = null, aiText = null;
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: `Locale: ${locale||"unknown"}\nInput: "${input}"` },
        ],
      });
      const raw = response.choices?.[0]?.message?.content;
      if (raw) {
        const parsed = JSON.parse(raw);
        aiText = parsed.text || null;
        if (parsed.time && /^\d{1,2}:\d{2}$/.test(parsed.time)) {
          const [hh, mm] = parsed.time.split(":").map(Number);
          if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) aiTime = { h: hh, m: mm };
        }
      }
    } catch (aiErr) {
      console.warn("[AI] error:", aiErr.message);
    }

    // ── 3. Fallback: extract time with regex if AI failed ─────────────────────
    if (!aiTime) {
      const wNoRel = w
        .replace(/(?:через|за)\s+\d+\s*(?:дн[іьейя]|день|дня|днів|хвилин(?:и)?|годин(?:и|)?|час(?:а|ів|ов)?)/gi, "")
        .replace(/in\s+\d+\s*(?:days?|hours?|minutes?|Tagen?|Stunden?|Minuten?)/gi, "")
        .replace(/dans\s+\d+\s*(?:jours?|heures?|minutes?)/gi, "")
        .replace(/en\s+\d+\s*(?:días?|horas?|minutos?)/gi, "")
        .replace(/za\s+\d+\s*(?:dni|godzin|minut)/gi, "")
        .trim();

      // HH:MM explicit + optional period (e.g. "10:00 утра", "8:00 pm", "22:00")
      let tm = wNoRel.match(/\b(\d{1,2}):(\d{2})\s*(утра|утром|ранку|вранці|дня|вечера|вечером|вечора|увечері|ночи|ночью|ночі|вночі|morning|afternoon|evening|night|am|pm|morgens|abends|nachmittags|du soir|de la tarde|de la noche)?\b/i);
      if (tm) {
        let h = +tm[1], m = +tm[2];
        const per = (tm[3]||"").toLowerCase();
        const eveW = ["вечера","вечером","вечора","увечері","evening","pm","abends","nachmittags","du soir","de la tarde","de la noche"];
        if (eveW.some(x=>per.includes(x)) && h < 12) h += 12;
        // morning/am: keep h as-is (already correct)
        aiTime = { h, m };
      }
      else {
        // digit + period word (optional "Uhr" between)
        tm = wNoRel.match(/(\d{1,2})h?\s*(?:uhr\s*)?(утра|утром|ранку|вранці|дня|вечера|вечером|вечора|увечері|ночи|ночью|ночі|вночі|morning|afternoon|evening|night|am|pm|morgens|abends|nachts|nachmittags|du soir|du matin|de la tarde|de la noche|de la mañana|wieczorem|rano)/i);
        if (tm) {
          const h24 = periodTo24h(+tm[1], tm[2]);
          aiTime = { h: h24, m: 0 };
        } else {
          // preposition + hour
          tm = wNoRel.match(/(?:^|\s)(?:в|во|о|at|um|à|a las|alle|o)\s+(\d{1,2})(?:[:.h](\d{2}))?(?!\s*(?:дн|day|Tag|jour|día|dni))/i);
          if (tm) aiTime = { h: +tm[1], m: tm[2] ? +tm[2] : 0 };
        }
      }
      // If raw HH:MM, still run period detection for safety (e.g. "21:00" is already 24h)
    }

    const taskText = aiText || cleanTask(input);

    // ── 4. Calculate final date ───────────────────────────────────────────────
    let baseDate = new Date(localNow);

    if (isDayAfter) {
      baseDate = addDays(localNow, 2);
    } else if (isTomorrow) {
      baseDate = addDays(localNow, 1);
    } else if (nDays > 0) {
      baseDate = addDays(localNow, nDays);
    } else if (weekdayTarget !== -1) {
      const todayDow = localNow.getDay(); // 0=Sun
      let diff = weekdayTarget - todayDow;
      if (diff <= 0) diff += 7; // always next occurrence (never today)
      baseDate = addDays(localNow, diff);
    }

    if (aiTime) {
      let dt = withTime(baseDate, aiTime.h, aiTime.m);
      // If no explicit date and result is in the past → push to tomorrow
      const noExplicitDate = !isDayAfter && !isTomorrow && nDays === 0 && weekdayTarget === -1;
      if (noExplicitDate && dt.getTime() <= localNow.getTime()) {
        dt = addDays(dt, 1);
      }
      console.log(`[OK] "${input}" → ${toIso(dt, offsetMinutes)}`);
      return res.json({ ok: true, text: taskText, datetime: toIso(dt, offsetMinutes), source: "hybrid" });
    }

    // No time at all — use 09:00 if date was specified
    if (isDayAfter || isTomorrow || nDays > 0 || weekdayTarget !== -1) {
      const dt = withTime(baseDate, 9, 0);
      console.log(`[OK/notime] "${input}" → ${toIso(dt, offsetMinutes)}`);
      return res.json({ ok: true, text: taskText, datetime: toIso(dt, offsetMinutes), source: "rule/notime" });
    }

    console.log(`[UNPARSED] "${input}"`);
    return res.json({ ok: true, text: taskText, datetime: "", source: "unparsed" });

  } catch (e) {
    console.error("PARSE ERROR:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SayDone parser v3 on port ${port}`));

