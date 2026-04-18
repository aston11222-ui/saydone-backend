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
function checkRateLimit(ip) {
  const now = Date.now(), e = rateLimitMap.get(ip);
  if (!e || now > e.resetAt) { rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 }); return true; }
  if (e.count >= 30) return false;
  e.count++; return true;
}
setInterval(() => { const n = Date.now(); for (const [k,v] of rateLimitMap) if (n > v.resetAt) rateLimitMap.delete(k); }, 300_000);

const APP_SECRET = process.env.APP_SECRET || null;
function auth(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok:false, error:"rate_limit" });
  if (APP_SECRET && req.headers['x-app-key'] !== APP_SECRET) return res.status(403).json({ ok:false, error:"forbidden" });
  next();
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const p2 = n => String(n).padStart(2, "0");
const offStr = o => { const s = o>=0?"+":"-", a = Math.abs(o); return `${s}${p2(Math.floor(a/60))}:${p2(a%60)}`; };
const fmtDate = d => `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
const fmtTime = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const fmtIso  = (d, o) => `${fmtDate(d)}T${fmtTime(d)}:00${offStr(o)}`;
const addDays  = (d, n) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
const addMins  = (d, n) => { const r = new Date(d); r.setMinutes(r.getMinutes()+n); return r; };
const addHours = (d, n) => { const r = new Date(d); r.setHours(r.getHours()+n); return r; };

function parseNow(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0)) : null;
}
function getOffset(s) {
  const m = String(s).match(/([+-])(\d{2}):(\d{2})$/);
  return m ? (+m[2]*60 + +m[3]) * (m[1]==='+' ? 1 : -1) : 0;
}

const DOW_EN = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

// ── Build dynamic prompt ──────────────────────────────────────────────────────
function buildPrompt(now, off) {
  const tz = offStr(off);
  const today = fmtDate(now);
  const time  = fmtTime(now);
  const dow   = DOW_EN[now.getDay()];
  const todayIdx = now.getDay(); // 0=Sun

  const nextDay = (target) => {
    let diff = target - todayIdx;
    if (diff <= 0) diff += 7;
    return fmtDate(addDays(now, diff));
  };

  const d = n => fmtDate(addDays(now, n));
  const m = n => fmtTime(addMins(now, n));
  const h = n => fmtTime(addHours(now, n));

  // Is a given HH:MM in the past today?
  const isPast = (hh, mm) => hh * 60 + mm <= now.getHours() * 60 + now.getMinutes();
  const futureOrTomorrow = (hh, mm) => isPast(hh,mm) ? d(1) : today;

  return `You are a reminder datetime parser. Extract the task text and exact datetime from voice input.

CURRENT LOCAL TIME : ${today}T${time}:00${tz}  (${dow})
TIMEZONE OFFSET    : ${tz}

━━━━ OUTPUT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return ONLY a JSON object — no explanation, no markdown:
{"text":"task in same language as input","datetime":"YYYY-MM-DDTHH:MM:SS${tz}"}

If no task is clear, return {"text":"","datetime":"..."}.
If time cannot be determined at all, return {"text":"...","datetime":""}.

━━━━ TASK TEXT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Strip all date/time/weekday words. Keep only the action/task.
Use the SAME language as the input.

  "Поставь напоминание в пятницу в 10 утра купить молоко"  → "купить молоко"
  "Нагадай у п'ятницю о 10 ранку купити молоко"            → "купити молоко"
  "Remind me tomorrow at 9am to call mom"                   → "call mom"
  "Erinnere mich am Montag um 10 Uhr Arzt anrufen"         → "Arzt anrufen"
  "Rappelle-moi demain à 9h appeler maman"                  → "appeler maman"
  "Recuérdame el viernes a las 9 llamar a mamá"             → "llamar a mamá"
  "Przypomnij mi w poniedziałek o 10 zadzwonić"            → "zadzwonić"

━━━━ DATE RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─ TODAY = ${today} ─────────────────────────────────────────┐
│ RU: сегодня                                                 │
│ UK: сьогодні / сьогодня                                    │
│ EN: today                                                   │
│ DE: heute                                                   │
│ FR: aujourd'hui                                             │
│ ES: hoy                                                     │
│ PL: dzisiaj / dziś                                          │
└─────────────────────────────────────────────────────────────┘

┌─ TOMORROW = ${d(1)} ───────────────────────────────────────┐
│ RU: завтра                                                  │
│ UK: завтра                                                  │
│ EN: tomorrow                                                │
│ DE: morgen                                                  │
│ FR: demain                                                  │
│ ES: mañana                                                  │
│ PL: jutro                                                   │
└─────────────────────────────────────────────────────────────┘

┌─ DAY AFTER TOMORROW = ${d(2)} ─────────────────────────────┐
│ RU: послезавтра                                             │
│ UK: після завтра / позавтра / післязавтра                  │
│ EN: day after tomorrow                                      │
│ DE: übermorgen                                              │
│ FR: après-demain                                            │
│ ES: pasado mañana                                           │
│ PL: pojutrze                                                │
└─────────────────────────────────────────────────────────────┘

┌─ IN N DAYS — add N to today ${today} ──────────────────────┐
│ RU: через N день/дня/дней                                  │
│ UK: через N день/дня/дні/днів                              │
│     за N день/дня/дні/днів                                 │
│ EN: in N day/days                                           │
│ DE: in N Tag/Tagen                                          │
│ FR: dans N jour/jours                                       │
│ ES: en N día/días                                           │
│ PL: za N dzień/dni                                          │
│                                                             │
│ через 1 день    = за 1 день    = in 1 day    = ${d(1)}     │
│ через 2 дня     = за 2 дні     = in 2 days   = ${d(2)}     │
│ через 3 дня     = за 3 дні     = in 3 days   = ${d(3)}     │
│ через 5 дней    = за 5 днів    = in 5 days   = ${d(5)}     │
│ через 7 дней    = за 7 днів    = in 7 days   = ${d(7)}     │
│ через 10 дней   = за 10 днів   = in 10 days  = ${d(10)}    │
│ in 3 Tagen      = dans 3 jours = en 3 días   = ${d(3)}     │
│ za 3 dni        = za 3 dni     = in 3 days   = ${d(3)}     │
└─────────────────────────────────────────────────────────────┘

┌─ IN N WEEKS ────────────────────────────────────────────────┐
│ RU: через неделю / через N недели / через N недель         │
│ UK: через тиждень / через N тижні / через N тижнів         │
│     за тиждень / за N тижні / за N тижнів                  │
│ EN: in a week / in N weeks                                  │
│ DE: in einer Woche / in N Wochen                            │
│ FR: dans une semaine / dans N semaines                      │
│ ES: en una semana / en N semanas                            │
│ PL: za tydzień / za N tygodnie / za N tygodni              │
│                                                             │
│ через неделю  = за тиждень  = in a week  = ${d(7)}         │
│ через 2 недели = за 2 тижні = in 2 weeks = ${d(14)}        │
└─────────────────────────────────────────────────────────────┘

┌─ WEEKDAYS — ALWAYS NEXT occurrence (never today even if same day) ─┐
│ Today is ${dow} (${today}). Next occurrences:             │
│                                                                     │
│ Monday    / Понедельник / Понеділок   / Montag     / Lundi          │
│          / Lunes / Poniedziałek                                     │
│   → ${nextDay(1)}                                                   │
│                                                                     │
│ Tuesday   / Вторник     / Вівторок    / Dienstag   / Mardi          │
│          / Martes / Wtorek                                          │
│   → ${nextDay(2)}                                                   │
│                                                                     │
│ Wednesday / Среда       / Середа      / Mittwoch   / Mercredi       │
│          / Miércoles / Środa                                        │
│   → ${nextDay(3)}                                                   │
│                                                                     │
│ Thursday  / Четверг     / Четвер      / Donnerstag / Jeudi          │
│          / Jueves / Czwartek                                        │
│   → ${nextDay(4)}                                                   │
│                                                                     │
│ Friday    / Пятница     / П'ятниця    / Freitag    / Vendredi       │
│          / Viernes / Piątek                                         │
│   → ${nextDay(5)}                                                   │
│                                                                     │
│ Saturday  / Суббота     / Субота      / Samstag    / Samedi         │
│          / Sábado / Sobota                                          │
│   → ${nextDay(6)}                                                   │
│                                                                     │
│ Sunday    / Воскресенье / Неділя      / Sonntag    / Dimanche       │
│          / Domingo / Niedziela                                       │
│   → ${nextDay(0)}                                                   │
│                                                                     │
│ Declensions handled:                                                │
│ RU: понедельника, вторника, среду, четверга, пятницу,              │
│     субботу, воскресенья                                            │
│ UK: понеділка/понеділку, вівторка/вівторку, середу/середи,         │
│     четверга/четверу, п'ятницю/п'ятниці, суботу/суботи,           │
│     неділю/неділі                                                   │
│ DE: am Montag, am Dienstag, am Mittwoch, am Donnerstag,            │
│     am Freitag, am Samstag, am Sonntag                             │
│ FR: le lundi, le mardi, le mercredi, le jeudi,                     │
│     le vendredi, le samedi, le dimanche                            │
│ ES: el lunes, el martes, el miércoles, el jueves,                  │
│     el viernes, el sábado, el domingo                              │
│ PL: w poniedziałek, we wtorek, w środę, w czwartek,               │
│     w piątek, w sobotę, w niedzielę                                │
└─────────────────────────────────────────────────────────────────────┘

┌─ NO DATE GIVEN — use today/tomorrow based on time ─────────┐
│ Current time: ${time}                                       │
│ If stated time > ${time} → use TODAY (${today})            │
│ If stated time ≤ ${time} → use TOMORROW (${d(1)})          │
│                                                             │
│ Examples (now = ${time}):                                   │
│   "в 9 вечера" (21:00 > ${time}) → ${futureOrTomorrow(21,0)} T21:00│
│   "в 7 утра"   (07:00 ≤ ${time}) → ${futureOrTomorrow(7,0)}  T07:00│
│   "в 1 ночи"   (01:00 ≤ ${time}) → ${futureOrTomorrow(1,0)}  T01:00│
└─────────────────────────────────────────────────────────────┘

━━━━ TIME RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─ 24h FORMAT — use as-is ───────────────────────────────────┐
│ "21:00" → 21:00 │ "08:30" → 08:30 │ "00:00" → 00:00       │
│ "15:30" → 15:30 │ "13:45" → 13:45 │ "23:59" → 23:59       │
└─────────────────────────────────────────────────────────────┘

┌─ MORNING — keep hour as-is (1–11 unchanged, 12 → 0) ───────┐
│ RU: утра / утром / с утра / по утрам                       │
│ UK: ранку / вранці / зранку / вранці-рано / рано-вранці    │
│ EN: am / in the morning / morning / o'clock in the morning  │
│ DE: morgens / Uhr morgens / Uhr früh / früh morgens        │
│ FR: du matin / le matin / heures du matin                   │
│ ES: de la mañana / por la mañana                            │
│ PL: rano / z rana / rano                                    │
│                                                             │
│  1 утра  =  1 ранку  =  1am  =  1 morgens  = 01:00        │
│  2 утра  =  2 ранку  =  2am  =  2 morgens  = 02:00        │
│  3 утра  =  3 ранку  =  3am  =  3 du matin = 03:00        │
│  4 утра  =  4 ранку  =  4am                = 04:00        │
│  5 утра  =  5 ранку  =  5am                = 05:00        │
│  6 утра  =  6 ранку  =  6am  =  6 morgens  = 06:00        │
│  7 утра  =  7 ранку  =  7am  =  7 morgens  = 07:00        │
│  8 утра  =  8 ранку  =  8am  =  8 morgens  = 08:00        │
│  9 утра  =  9 ранку  =  9am  =  9 morgens  = 09:00        │
│ 10 утра  = 10 ранку  = 10am  = 10 morgens  = 10:00        │
│ 10:00 утра = 10:00 ранку = 10:00 am        = 10:00        │
│ 11 утра  = 11 ранку  = 11am  = 11 du matin = 11:00        │
│ 12 утра  = 12 ранку  = 12am  = midnight    = 00:00        │
└─────────────────────────────────────────────────────────────┘

┌─ AFTERNOON — add 12 if hour < 12 (12 stays 12) ────────────┐
│ RU: дня / после обеда / полудня                            │
│ UK: дня / по обіді / після обіду / пополудні               │
│ EN: in the afternoon / afternoon / pm (12–17)               │
│ DE: nachmittags / am Nachmittag / Uhr nachmittags          │
│ FR: de l'après-midi / l'après-midi / heures de l'après-midi│
│ ES: de la tarde (12:00–17:59)                               │
│ PL: po południu                                             │
│                                                             │
│  1 дня  =  1 дня(UK) =  1pm  = 13:00                      │
│  2 дня  =  2 дня(UK) =  2pm  = 14:00                      │
│  3 дня  =  3 дня(UK) =  3pm  = 15:00                      │
│  4 дня  =  4 дня(UK) =  4pm  = 16:00                      │
│  5 дня  =  5 дня(UK) =  5pm  = 17:00                      │
│ 12 дня  = 12 дня(UK) = 12pm  = 12:00 (noon)               │
└─────────────────────────────────────────────────────────────┘

┌─ EVENING/PM — add 12 if hour < 12 (12 stays 12) ───────────┐
│ RU: вечера / вечером / ввечері                             │
│ UK: вечора / увечері / ввечері / вечором / о вечорі        │
│     звечора / надвечір                                      │
│ EN: pm / in the evening / evening / tonight                 │
│ DE: abends / am Abend / Uhr abends / Uhr am Abend          │
│ FR: du soir / le soir / en soirée / heures du soir         │
│ ES: de la tarde (18:00+) / de la noche / por la noche      │
│ PL: wieczorem / po południu (18+) / z wieczora             │
│                                                             │
│  1 вечера  =  1 вечора  =  1pm   = 13:00                  │
│  2 вечера  =  2 вечора  =  2pm   = 14:00                  │
│  3 вечера  =  3 вечора  =  3pm   = 15:00                  │
│  4 вечера  =  4 вечора  =  4pm   = 16:00                  │
│  5 вечера  =  5 вечора  =  5pm   = 17:00                  │
│  6 вечера  =  6 вечора  =  6pm   = 18:00 = 6 abends       │
│  7 вечера  =  7 вечора  =  7pm   = 19:00 = 7 du soir      │
│  8 вечера  =  8 вечора  =  8pm   = 20:00 = 8 de la tarde  │
│  9 вечера  =  9 вечора  =  9pm   = 21:00 = 9 abends       │
│ 10 вечера  = 10 вечора  = 10pm   = 22:00 = 10 du soir     │
│ 11 вечера  = 11 вечора  = 11pm   = 23:00 = 11 wieczorem   │
│ 12 вечера  = 12 вечора  = 12pm   = 12:00 (noon)           │
│                                                             │
│ With minutes:                                               │
│  9:30 вечера = 9:30 вечора = 9:30pm = 21:30               │
│ 10:00 вечера = 10:00 вечора = 10pm  = 22:00               │
│  8:00 вечера = 8:00 вечора  = 8pm   = 20:00               │
└─────────────────────────────────────────────────────────────┘

┌─ NIGHT — late hours ────────────────────────────────────────┐
│ RU: ночи / ночью / в ночь / среди ночи                     │
│ UK: ночі / вночі / уночі / опівночі / серед ночі           │
│ EN: at night / in the night / overnight                     │
│ DE: nachts / in der Nacht / um Mitternacht                  │
│ FR: de nuit / la nuit / cette nuit                          │
│ ES: de la noche / a la noche / esta noche                   │
│ PL: w nocy / nocą / w środku nocy                           │
│                                                             │
│ Hours 1–5 "ночи/ночі" → keep as-is:                        │
│  1 ночи  = 1 ночі  = 01:00                                 │
│  2 ночи  = 2 ночі  = 02:00                                 │
│  3 ночи  = 3 ночі  = 03:00                                 │
│  4 ночи  = 4 ночі  = 04:00                                 │
│  5 ночи  = 5 ночі  = 05:00                                 │
│                                                             │
│ Hours 10–11 "ночи/ночі" → late night (add 12):             │
│ 10 ночи  = 10 ночі  = 22:00                                │
│ 11 ночи  = 11 ночі  = 23:00                                │
│ 12 ночи  = 12 ночі  = midnight = 00:00                     │
└─────────────────────────────────────────────────────────────┘

┌─ SPECIAL TIMES ─────────────────────────────────────────────┐
│ полдень   / полудень  / noon    / midi      / mediodía   / południe  → 12:00 │
│ полночь   / опівніч  / midnight / minuit    / medianoche / północ    → 00:00 │
│ обед/обід / lunch                                                    → 13:00 │
│ рассвет / світанок / dawn / Morgendämmerung / aube / alba / świt    → 06:00 │
│ сумерки / сутінки / dusk / Abenddämmerung / crépuscule              → 20:00 │
└───────────────────────────────────────────────────────────────────────────────┘

┌─ RELATIVE TIME — add to current time ${time} ──────────────┐
│                                                             │
│ MINUTES:                                                    │
│ RU: через N минуту/минуты/минут / через полминуты          │
│ UK: через N хвилину/хвилини/хвилин / через пів хвилини     │
│ EN: in N minute/minutes / in half a minute                  │
│ DE: in N Minute/Minuten / in einer halben Minute           │
│ FR: dans N minute/minutes                                   │
│ ES: en N minuto/minutos                                     │
│ PL: za N minutę/minuty/minut                                │
│                                                             │
│ через 5 хвилин    = за 5 хвилин   = in 5 minutes = ${m(5)}│
│ через 10 хвилин   = за 10 хвилин  = in 10 min    = ${m(10)}│
│ через 15 минут    = через 15 хвилин = in 15 min  = ${m(15)}│
│ через 20 минут    = через 20 хвилин = in 20 min  = ${m(20)}│
│ через 30 минут    = через пів години = in 30 min = ${m(30)}│
│ через 45 минут    = через 45 хвилин = in 45 min  = ${m(45)}│
│                                                             │
│ HOURS:                                                      │
│ RU: через N час/часа/часов / через полчаса                 │
│ UK: через N годину/години/годин / через пів години          │
│     за N годину/години/годин                                │
│ EN: in N hour/hours / in half an hour / in an hour          │
│ DE: in N Stunde/Stunden / in einer Stunde / in einer halben Stunde │
│ FR: dans N heure/heures / dans une heure / dans une demi-heure │
│ ES: en N hora/horas / en una hora / en media hora           │
│ PL: za N godzinę/godziny/godzin / za godzinę / za pół godziny │
│                                                             │
│ через полчаса   = через пів години = in half an hour = ${m(30)} │
│ через час       = через годину      = in an hour     = ${h(1)}  │
│ через 2 часа    = через 2 години    = in 2 hours     = ${h(2)}  │
│ через 3 часа    = через 3 години    = in 3 hours     = ${h(3)}  │
│ через 5 часов   = через 5 годин     = in 5 hours     = ${h(5)}  │
│ in 1 Stunde     = dans 1 heure      = en 1 hora      = ${h(1)}  │
│ za godzinę      = za 1 godzinę      = in an hour     = ${h(1)}  │
└─────────────────────────────────────────────────────────────┘

┌─ NO TIME STATED → default 09:00 ───────────────────────────┐
│ If the user doesn't mention any time → use 09:00           │
└─────────────────────────────────────────────────────────────┘

━━━━ FULL EXAMPLES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
(today=${today}, now=${time}, tz=${tz})

── Russian ──────────────────────────────────────────────────
"Напомни в пятницу в 10 утра купить молоко"
  → {"text":"купить молоко","datetime":"${nextDay(5)}T10:00:00${tz}"}
"Поставь напоминание на субботу на 8:00 утра позвонить маме"
  → {"text":"позвонить маме","datetime":"${nextDay(6)}T08:00:00${tz}"}
"Напомни завтра в 9 вечера поздравить друга"
  → {"text":"поздравить друга","datetime":"${d(1)}T21:00:00${tz}"}
"Напомни послезавтра в 10 утра встреча"
  → {"text":"встреча","datetime":"${d(2)}T10:00:00${tz}"}
"Напомни через 3 дня в 9 вечера позвонить маме"
  → {"text":"позвонить маме","datetime":"${d(3)}T21:00:00${tz}"}
"Напомни через 7 дней в 8 утра"
  → {"text":"","datetime":"${d(7)}T08:00:00${tz}"}
"Напомни в понедельник в 10 утра"
  → {"text":"","datetime":"${nextDay(1)}T10:00:00${tz}"}
"Напомни в пятницу в 18:30"
  → {"text":"","datetime":"${nextDay(5)}T18:30:00${tz}"}
"Напомни в 7 утра позвонить маме"
  → {"text":"позвонить маме","datetime":"${futureOrTomorrow(7,0)}T07:00:00${tz}"}
"Напомни в 1 ночи"
  → {"text":"","datetime":"${futureOrTomorrow(1,0)}T01:00:00${tz}"}
"Напомни в 9 вечера"
  → {"text":"","datetime":"${futureOrTomorrow(21,0)}T21:00:00${tz}"}
"Через 30 минут купить хлеб"
  → {"text":"купить хлеб","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}
"Через полчаса напомни"
  → {"text":"","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}
"Через 2 часа позвонить"
  → {"text":"позвонить","datetime":"${fmtDate(addHours(now,2))}T${h(2)}:00${tz}"}
"Через час встреча"
  → {"text":"встреча","datetime":"${fmtDate(addHours(now,1))}T${h(1)}:00${tz}"}
"Напомни в среду в 3 дня"
  → {"text":"","datetime":"${nextDay(3)}T15:00:00${tz}"}
"Напомни в воскресенье в полдень"
  → {"text":"","datetime":"${nextDay(0)}T12:00:00${tz}"}

── Ukrainian ─────────────────────────────────────────────────
"Нагадай у п'ятницю о 10 ранку купити молоко"
  → {"text":"купити молоко","datetime":"${nextDay(5)}T10:00:00${tz}"}
"Постав нагадування на суботу на 8:00 ранку зателефонувати мамі"
  → {"text":"зателефонувати мамі","datetime":"${nextDay(6)}T08:00:00${tz}"}
"Нагадай завтра о 9 вечора привітати друга"
  → {"text":"привітати друга","datetime":"${d(1)}T21:00:00${tz}"}
"Нагадай після завтра о 10 ранку зустріч"
  → {"text":"зустріч","datetime":"${d(2)}T10:00:00${tz}"}
"Нагадай через 3 дні о 9 вечора подзвонити мамі"
  → {"text":"подзвонити мамі","datetime":"${d(3)}T21:00:00${tz}"}
"Нагадай за 3 дні о 21:00 подзвонити мамі"
  → {"text":"подзвонити мамі","datetime":"${d(3)}T21:00:00${tz}"}
"Нагадай за 7 днів о 8 ранку"
  → {"text":"","datetime":"${d(7)}T08:00:00${tz}"}
"Нагадай у понеділок о 10 ранку"
  → {"text":"","datetime":"${nextDay(1)}T10:00:00${tz}"}
"Нагадай у вівторок о 15:00"
  → {"text":"","datetime":"${nextDay(2)}T15:00:00${tz}"}
"Нагадай у п'ятницю о 18:30"
  → {"text":"","datetime":"${nextDay(5)}T18:30:00${tz}"}
"Нагадай о 7 ранку зателефонувати мамі"
  → {"text":"зателефонувати мамі","datetime":"${futureOrTomorrow(7,0)}T07:00:00${tz}"}
"Нагадай о 1 ночі"
  → {"text":"","datetime":"${futureOrTomorrow(1,0)}T01:00:00${tz}"}
"Нагадай о 9 вечора"
  → {"text":"","datetime":"${futureOrTomorrow(21,0)}T21:00:00${tz}"}
"Через 30 хвилин купити хліб"
  → {"text":"купити хліб","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}
"Через пів години нагадай"
  → {"text":"","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}
"Через 2 години подзвонити"
  → {"text":"подзвонити","datetime":"${fmtDate(addHours(now,2))}T${h(2)}:00${tz}"}
"За годину зустріч"
  → {"text":"зустріч","datetime":"${fmtDate(addHours(now,1))}T${h(1)}:00${tz}"}
"Нагадай у середу о 3 дня"
  → {"text":"","datetime":"${nextDay(3)}T15:00:00${tz}"}
"Нагадай у неділю опівдні"
  → {"text":"","datetime":"${nextDay(0)}T12:00:00${tz}"}
"Нагадай у суботу на 10:00 ранку"
  → {"text":"","datetime":"${nextDay(6)}T10:00:00${tz}"}

── English ───────────────────────────────────────────────────
"Remind me on Friday at 10am to buy milk"
  → {"text":"buy milk","datetime":"${nextDay(5)}T10:00:00${tz}"}
"Remind me on Saturday at 8am to call mom"
  → {"text":"call mom","datetime":"${nextDay(6)}T08:00:00${tz}"}
"Remind me tomorrow at 9pm to congratulate a friend"
  → {"text":"congratulate a friend","datetime":"${d(1)}T21:00:00${tz}"}
"Remind me in 3 days at 9pm to call mom"
  → {"text":"call mom","datetime":"${d(3)}T21:00:00${tz}"}
"Remind me on Monday at 10am"
  → {"text":"","datetime":"${nextDay(1)}T10:00:00${tz}"}
"Remind me at 7am to call mom"
  → {"text":"call mom","datetime":"${futureOrTomorrow(7,0)}T07:00:00${tz}"}
"Remind me at 9pm"
  → {"text":"","datetime":"${futureOrTomorrow(21,0)}T21:00:00${tz}"}
"In 30 minutes buy bread"
  → {"text":"buy bread","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}
"In 2 hours call"
  → {"text":"call","datetime":"${fmtDate(addHours(now,2))}T${h(2)}:00${tz}"}

── German ────────────────────────────────────────────────────
"Erinnere mich am Freitag um 10 Uhr morgens Milch kaufen"
  → {"text":"Milch kaufen","datetime":"${nextDay(5)}T10:00:00${tz}"}
"Erinnere mich am Samstag um 8 Uhr morgens Mama anrufen"
  → {"text":"Mama anrufen","datetime":"${nextDay(6)}T08:00:00${tz}"}
"Erinnere mich morgen um 21 Uhr"
  → {"text":"","datetime":"${d(1)}T21:00:00${tz}"}
"Erinnere mich in 3 Tagen um 9 Uhr abends"
  → {"text":"","datetime":"${d(3)}T21:00:00${tz}"}
"Erinnere mich am Montag um 10 Uhr"
  → {"text":"","datetime":"${nextDay(1)}T10:00:00${tz}"}
"In 30 Minuten Brot kaufen"
  → {"text":"Brot kaufen","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}
"In 2 Stunden anrufen"
  → {"text":"anrufen","datetime":"${fmtDate(addHours(now,2))}T${h(2)}:00${tz}"}

── French ────────────────────────────────────────────────────
"Rappelle-moi vendredi à 10h du matin acheter du lait"
  → {"text":"acheter du lait","datetime":"${nextDay(5)}T10:00:00${tz}"}
"Rappelle-moi demain à 21h féliciter un ami"
  → {"text":"féliciter un ami","datetime":"${d(1)}T21:00:00${tz}"}
"Rappelle-moi dans 3 jours à 9h du soir appeler maman"
  → {"text":"appeler maman","datetime":"${d(3)}T21:00:00${tz}"}
"Rappelle-moi lundi à 10h"
  → {"text":"","datetime":"${nextDay(1)}T10:00:00${tz}"}
"Dans 30 minutes acheter du pain"
  → {"text":"acheter du pain","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}

── Spanish ───────────────────────────────────────────────────
"Recuérdame el viernes a las 10 de la mañana comprar leche"
  → {"text":"comprar leche","datetime":"${nextDay(5)}T10:00:00${tz}"}
"Recuérdame mañana a las 9 de la noche felicitar a un amigo"
  → {"text":"felicitar a un amigo","datetime":"${d(1)}T21:00:00${tz}"}
"Recuérdame en 3 días a las 9 de la noche llamar a mamá"
  → {"text":"llamar a mamá","datetime":"${d(3)}T21:00:00${tz}"}
"Recuérdame el lunes a las 10"
  → {"text":"","datetime":"${nextDay(1)}T10:00:00${tz}"}
"En 30 minutos comprar pan"
  → {"text":"comprar pan","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}

── Polish ────────────────────────────────────────────────────
"Przypomnij mi w piątek o 10 rano kupić mleko"
  → {"text":"kupić mleko","datetime":"${nextDay(5)}T10:00:00${tz}"}
"Przypomnij mi jutro o 21:00 pogratulować przyjacielowi"
  → {"text":"pogratulować przyjacielowi","datetime":"${d(1)}T21:00:00${tz}"}
"Przypomnij mi za 3 dni o 21:00 zadzwonić do mamy"
  → {"text":"zadzwonić do mamy","datetime":"${d(3)}T21:00:00${tz}"}
"Przypomnij mi w poniedziałek o 10"
  → {"text":"","datetime":"${nextDay(1)}T10:00:00${tz}"}
"Za 30 minut kupić chleb"
  → {"text":"kupić chleb","datetime":"${fmtDate(addMins(now,30))}T${m(30)}:00${tz}"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REMEMBER: output ONLY the JSON. No extra text.`;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/",       (_, res) => res.send("SayDone AI-pure parser v4"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/parse", auth, async (req, res) => {
  try {
    const { text, locale } = req.body ?? {};
    if (!text || !req.body.now) return res.status(400).json({ ok: false, error: "Missing text or now" });

    const localNow = parseNow(req.body.now);
    if (!localNow) return res.status(400).json({ ok: false, error: "Invalid now" });

    const off    = getOffset(req.body.now);
    const input  = String(text).replace(/\s+/g, " ").trim();
    const prompt = buildPrompt(localNow, off);

    let result = null;
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          { role: "user",   content: `Locale: ${locale || "unknown"}\nVoice input: "${input}"` },
        ],
        max_tokens: 150,
      });

      const raw = response.choices?.[0]?.message?.content;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.datetime && !isNaN(new Date(parsed.datetime).getTime())) {
          result = parsed;
        }
      }
    } catch (err) {
      console.warn("[AI] error:", err.message);
    }

    if (result) {
      console.log(`[OK] "${input}" → ${result.datetime}`);
      return res.json({ ok: true, text: result.text ?? input, datetime: result.datetime, source: "ai" });
    }

    console.warn(`[FAIL] "${input}"`);
    return res.json({ ok: true, text: input, datetime: "", source: "unparsed" });

  } catch (e) {
    console.error("ERROR:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SayDone AI-pure v4 on port ${port}`));

