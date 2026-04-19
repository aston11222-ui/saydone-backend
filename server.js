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
setInterval(() => { const n = Date.now(); for (const [k, v] of rateLimitMap) if (n > v.resetAt) rateLimitMap.delete(k); }, 300_000);

const APP_SECRET = process.env.APP_SECRET || null;
function auth(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: "rate_limit" });
  if (APP_SECRET && req.headers['x-app-key'] !== APP_SECRET) return res.status(403).json({ ok: false, error: "forbidden" });
  next();
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const p2 = n => String(n).padStart(2, "0");
const offStr = o => { const s = o >= 0 ? "+" : "-", a = Math.abs(o); return `${s}${p2(Math.floor(a/60))}:${p2(a%60)}`; };
const toIso = (d, o) => `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00${offStr(o)}`;

function parseNow(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0)) : null;
}
function getOffset(s) {
  const m = String(s).match(/([+-])(\d{2}):(\d{2})$/);
  return m ? (+m[2]*60 + +m[3]) * (m[1]==='+' ? 1 : -1) : 0;
}

const DOW_EN = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function buildPrompt(nowIso, offsetStr, localNow) {
  const dow = DOW_EN[localNow.getDay()];
  const todayStr = nowIso.slice(0, 10);
  const timeStr  = nowIso.slice(11, 16);
  const todayDow = localNow.getDay();

  // Pre-calculate next weekday dates
  const nextDow = i => {
    let diff = i - todayDow;
    if (diff <= 0) diff += 7;
    const d = new Date(localNow);
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  };
  const addD = n => { const d = new Date(localNow); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };
  const addM = n => { const d = new Date(localNow); d.setMinutes(d.getMinutes()+n); return d.toTimeString().slice(0,5); };
  const addH = n => { const d = new Date(localNow); d.setHours(d.getHours()+n); return d.toTimeString().slice(0,5); };

  return `You are a multilingual voice reminder parser. Your ONLY job: extract the task and exact datetime.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT TIME: ${nowIso}  (${dow})
TIMEZONE: ${offsetStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OUTPUT — ONLY valid JSON, nothing else:
{"text":"task in input language","datetime":"YYYY-MM-DDTHH:MM:SS${offsetStr}"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§1. TASK TEXT
Remove ALL time/date/weekday words. Keep only the reminder task.
Use the same language as the voice input.

Good examples:
  Input RU: "Поставь напоминание в пятницу в 10 утра купить молоко"
  Output:   "купить молоко"

  Input UK: "Нагадай у п'ятницю о 10 ранку купити молоко"
  Output:   "купити молоко"

  Input EN: "Remind me tomorrow at 9am to call mom"
  Output:   "call mom"

  Input DE: "Erinnere mich am Montag um 10 Uhr Arzt anrufen"
  Output:   "Arzt anrufen"

  Input FR: "Rappelle-moi demain à 9h appeler maman"
  Output:   "appeler maman"

  Input ES: "Recuérdame el viernes a las 9 llamar a mamá"
  Output:   "llamar a mamá"

  Input PL: "Przypomnij mi w poniedziałek o 10 zadzwonić do mamy"
  Output:   "zadzwonić do mamy"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§2. DATE RULES

──────────────────────────────────────── 
2A. RELATIVE DAYS — add N days to today (${todayStr})

All phrases meaning "in N days":
  RU:  через N день / через N дня / через N дней
  UK:  через N день / через N дня / через N дні / через N днів
       за N день / за N дня / за N дні / за N днів
  EN:  in N day / in N days
  DE:  in N Tag / in N Tagen
  FR:  dans N jour / dans N jours
  ES:  en N día / en N días
  PL:  za N dzień / za N dni

Examples (today=${todayStr}):
  "через 1 день"  → ${addD(1)}
  "через 2 дня"   → ${addD(2)}
  "через 3 дні"   → ${addD(3)}
  "через 5 днів"  → ${addD(5)}
  "за 3 дні"      → ${addD(3)}
  "за 7 днів"     → ${addD(7)}
  "in 1 day"      → ${addD(1)}
  "in 3 days"     → ${addD(3)}
  "in 5 Tagen"    → ${addD(5)}
  "dans 3 jours"  → ${addD(3)}
  "en 2 días"     → ${addD(2)}
  "za 4 dni"      → ${addD(4)}

──────────────────────────────────────── 
2B. RELATIVE WEEKS — add N weeks

All phrases meaning "in N weeks":
  RU:  через неделю / через N недели / через N недель
  UK:  через тиждень / через N тижні / через N тижнів / за тиждень / за N тижні / за N тижнів
  EN:  in a week / in N weeks
  DE:  in einer Woche / in N Wochen
  FR:  dans une semaine / dans N semaines
  ES:  en una semana / en N semanas
  PL:  za tydzień / za N tygodnie / za N tygodni

Examples:
  "через неделю"   → ${addD(7)}
  "через тиждень"  → ${addD(7)}
  "за тиждень"     → ${addD(7)}
  "in a week"      → ${addD(7)}
  "in 2 weeks"     → ${addD(14)}

──────────────────────────────────────── 
2C. TOMORROW — today + 1 day = ${addD(1)}

All words meaning "tomorrow":
  RU: завтра
  UK: завтра  (identical in Ukrainian)
  EN: tomorrow
  DE: morgen
  FR: demain
  ES: mañana
  PL: jutro

──────────────────────────────────────── 
2D. DAY AFTER TOMORROW — today + 2 days = ${addD(2)}

All words meaning "day after tomorrow":
  RU: послезавтра
  UK: після завтра / позавтра / післязавтра
  EN: day after tomorrow
  DE: übermorgen
  FR: après-demain
  ES: pasado mañana
  PL: pojutrze

──────────────────────────────────────── 
2E. TODAY — ${todayStr}

All words meaning "today":
  RU: сегодня
  UK: сьогодні / сьогодня
  EN: today
  DE: heute
  FR: aujourd'hui
  ES: hoy
  PL: dzisiaj / dziś

──────────────────────────────────────── 
2F. WEEKDAYS — use the NEXT occurrence of that day
Today is ${dow} (index ${todayDow}). 
IMPORTANT: if the user says today's weekday name → use NEXT week, NOT today.

Monday    / Понедельник / Понеділок / Montag     / Lundi    / Lunes     / Poniedziałek → ${nextDow(1)}
Tuesday   / Вторник     / Вівторок  / Dienstag   / Mardi    / Martes    / Wtorek       → ${nextDow(2)}
Wednesday / Среда       / Середа    / Mittwoch   / Mercredi / Miércoles / Środa        → ${nextDow(3)}
Thursday  / Четверг     / Четвер    / Donnerstag / Jeudi    / Jueves    / Czwartek     → ${nextDow(4)}
Friday    / Пятница     / П'ятниця  / Freitag    / Vendredi / Viernes   / Piątek       → ${nextDow(5)}
Saturday  / Суббота     / Субота    / Samstag    / Samedi   / Sábado    / Sobota       → ${nextDow(6)}
Sunday    / Воскресенье / Неділя    / Sonntag    / Dimanche / Domingo   / Niedziela    → ${nextDow(0)}

Also handle declensions:
  RU: понедельник/понедельника, вторник/вторника, среда/среду, четверг/четверга,
      пятница/пятницу, суббота/субботу, воскресенье/воскресенья
  UK: понеділок/понеділка/понеділку/у понеділок/в понеділок,
      вівторок/вівторка/вівторку/у вівторок/в вівторок,
      середа/середу/середи/у середу/в середу,
      четвер/четверга/четверу/у четвер/в четвер,
      п'ятниця/п'ятницю/п'ятниці/у п'ятницю/в п'ятницю,
      субота/суботу/суботи/у суботу/в суботу,
      неділя/неділю/неділі/у неділю/в неділю
  DE: Montag/am Montag, Dienstag/am Dienstag, Mittwoch/am Mittwoch,
      Donnerstag/am Donnerstag, Freitag/am Freitag, Samstag/am Samstag, Sonntag/am Sonntag
  FR: lundi, mardi, mercredi, jeudi, vendredi, samedi, dimanche
  ES: el lunes, el martes, el miércoles, el jueves, el viernes, el sábado, el domingo
  PL: poniedziałek/w poniedziałek, wtorek/we wtorek, środa/w środę, czwartek/w czwartek,
      piątek/w piątek, sobota/w sobotę, niedziela/w niedzielę

──────────────────────────────────────── 
2G. NO DATE STATED — CRITICAL RULE
If no date word is given, compare the stated time to current time ${timeStr}:

  RULE: if stated_time > ${timeStr} → use TODAY (${todayStr})
        if stated_time ≤ ${timeStr} → use TOMORROW (${addD(1)})

  This means ANY time that has already passed today goes to TOMORROW.
  Current time is ${timeStr}. Examples of what is past and what is future:
    00:00–${timeStr} → ALL PAST → use TOMORROW ${addD(1)}
    ${timeStr}–23:59 → FUTURE   → use TODAY   ${todayStr}

  Concrete examples at current time ${timeStr}:
    "в 9 утра"  (09:00 ≤ ${timeStr}) → ${addD(1)}T09:00:00${offsetStr}
    "в 10 утра" (10:00 ≤ ${timeStr}) → ${addD(1)}T10:00:00${offsetStr}
    "в 11 утра" (11:00 ≤ ${timeStr}) → ${addD(1)}T11:00:00${offsetStr}
    "в 12:00"   (12:00 ≤ ${timeStr}) → ${addD(1)}T12:00:00${offsetStr}
    "в 14:00"   (14:00 ≤ ${timeStr}) → ${addD(1)}T14:00:00${offsetStr}
    "в 9 ранку" (09:00 ≤ ${timeStr}) → ${addD(1)}T09:00:00${offsetStr}
    "at 9am"    (09:00 ≤ ${timeStr}) → ${addD(1)}T09:00:00${offsetStr}
    "at 10am"   (10:00 ≤ ${timeStr}) → ${addD(1)}T10:00:00${offsetStr}
    "at 11am"   (11:00 ≤ ${timeStr}) → ${addD(1)}T11:00:00${offsetStr}
    "um 9 Uhr"  (09:00 ≤ ${timeStr}) → ${addD(1)}T09:00:00${offsetStr}
    "à 10h"     (10:00 ≤ ${timeStr}) → ${addD(1)}T10:00:00${offsetStr}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§3. TIME RULES (convert all to 24h HH:MM)

──────────────────────────────────────── 
3A. EXPLICIT 24h — use as-is
  "21:00" → 21:00
  "08:30" → 08:30
  "00:00" → 00:00

──────────────────────────────────────── 
3B. MORNING — keep hour as-is (1-11 → same, 12 → 0)
Words meaning "morning / am":
  RU: утра / утром / с утра
  UK: ранку / вранці / зранку / вранці-рано / рано-вранці / зрана
  EN: am / in the morning / morning
  DE: morgens / Uhr morgens / Uhr früh / früh / morgens um X Uhr
  FR: du matin / le matin
  ES: de la mañana / por la mañana
  PL: rano / z rana / rano o / godzinie rano

Examples:
  "7 утра"    → 07:00    "7 ранку"    → 07:00    "7am"       → 07:00
  "8 утром"   → 08:00    "8 вранці"   → 08:00    "8 morgens" → 08:00
  "9 утра"    → 09:00    "9 ранку"    → 09:00    "9am"       → 09:00
  "10 утра"   → 10:00    "10 ранку"   → 10:00    "10 morning"→ 10:00
  "10:00 утра"→ 10:00    "10:00 ранку"→ 10:00    "10:00 am"  → 10:00
  "11 утра"   → 11:00    "6 du matin" → 06:00    "7 rano"    → 07:00

──────────────────────────────────────── 
3C. AFTERNOON — add 12 if hour < 12 (12 stays 12)
Words meaning "afternoon" (roughly 12:00–17:59):
  RU: дня / после обеда
  UK: дня / по обіді / після обіду
  EN: in the afternoon / afternoon
  DE: nachmittags / am Nachmittag
  FR: de l'après-midi / l'après-midi
  ES: de la tarde (12-17h)
  PL: po południu

Examples:
  "1 дня"   → 13:00    "2 дня"   → 14:00    "3 дня"  → 15:00
  "4 дня"   → 16:00    "5 дня"   → 17:00    "12 дня" → 12:00
  "3 дня"   UK → 15:00  "2 дня"  UK → 14:00
  "3pm"     → 15:00    "3 nachmittags" → 15:00

──────────────────────────────────────── 
3D. EVENING / PM — add 12 if hour < 12 (12 stays 12)
Words meaning "evening / pm":
  RU: вечера / вечером / ввечері
  UK: вечора / увечері / ввечері / вечором / о вечорі / звечора / надвечір / вечірнього
  EN: pm / in the evening / evening
  DE: abends / am Abend / Uhr abends / Uhr am Abend / abends um X Uhr
  NOTE DE: "um X Uhr" without period = 24h as stated (e.g. "um 10 Uhr" = 10:00, "um 21 Uhr" = 21:00)
  FR: du soir / le soir / en soirée
  ES: de la tarde (18h+) / de la noche / por la noche
  PL: wieczorem / po południu (18h+) / wieczór / w wieczór

Examples:
  "6 вечера"   → 18:00    "6 вечора"   → 18:00    "6pm"        → 18:00
  "7 вечера"   → 19:00    "7 вечора"   → 19:00    "7 abends"   → 19:00
  "8 вечера"   → 20:00    "8 вечора"   → 20:00    "8 du soir"  → 20:00
  "9 вечера"   → 21:00    "9 вечора"   → 21:00    "9pm"        → 21:00
  "10 вечера"  → 22:00    "10 вечора"  → 22:00    "10 abends"  → 22:00
  "11 вечера"  → 23:00    "11 вечора"  → 23:00    "11pm"       → 23:00
  "12 вечера"  → 12:00
  "10:00 вечера" → 22:00   "9:30 вечора" → 21:30   "8:00 pm"  → 20:00

──────────────────────────────────────── 
3E. NIGHT — context-dependent
Words meaning "night":
  RU: ночи / ночью / в ночь
  UK: ночі / вночі / уночі / ніч / опівночі / серед ночі
  EN: at night / tonight (late)
  DE: nachts / in der Nacht
  FR: de nuit / la nuit
  ES: de la noche (late, 22h+)
  PL: w nocy / nocą

Rules:
  Hours 1-5 "ночи/ночі/at night" → keep as-is (01:00–05:00)
  Hours 10-11 "ночи" → rare, treat as late night = 22:00–23:00 (add 12)
  Hour 12 "ночи" → midnight = 00:00

Examples:
  "1 ночи"  → 01:00    "1 ночі"  → 01:00    "2am"     → 02:00
  "2 ночи"  → 02:00    "3 ночі"  → 03:00    "4 ночи"  → 04:00
  "5 ночи"  → 05:00    "11 ночи" → 23:00    "12 ночи" → 00:00

──────────────────────────────────────── 
3F. SPECIAL TIMES
  полдень / полудень / полуденна / noon / midi / mediodía / południe → 12:00
  полночь / опівніч / midnight / minuit / medianoche / północ      → 00:00
  обед / обід / lunch → 13:00 (default lunch time)
  утренняя / вечерняя → keep context

──────────────────────────────────────── 
3G. RELATIVE TIME — add to current time (${timeStr})
Words meaning "in N minutes":
  RU: через N минуту/минуты/минут
  UK: через N хвилину/хвилини/хвилин
  EN: in N minute/minutes
  DE: in N Minute/Minuten
  FR: dans N minute/minutes
  ES: en N minuto/minutos
  PL: za N minutę/minuty/minut

Words meaning "in N hours":
  RU: через N час/часа/часов
  UK: через N годину/години/годин
  EN: in N hour/hours
  DE: in N Stunde/Stunden
  FR: dans N heure/heures
  ES: en N hora/horas
  PL: za N godzinę/godziny/godzin

Special short forms:
  RU/UK: через полчаса / через пів години → +30 min
  RU:    через час → +1 hour
  UK:    через годину → +1 hour
  EN:    in half an hour → +30 min | in an hour → +1 hour
  DE:    in einer halben Stunde → +30 min | in einer Stunde → +1 hour
  FR:    dans une demi-heure → +30 min | dans une heure → +1 hour
  ES:    en media hora → +30 min | en una hora → +1 hour
  PL:    za pół godziny → +30 min | za godzinę → +1 hour

Examples (current time ${timeStr}):
  "через 15 минут"    → ${addM(15)}    "через 30 хвилин" → ${addM(30)}
  "через полчаса"     → ${addM(30)}    "через пів години"→ ${addM(30)}
  "through 1 hour"    → ${addH(1)}     "in 2 hours"      → ${addH(2)}
  "в 1 Stunde"        → ${addH(1)}     "dans 30 minutes" → ${addM(30)}

──────────────────────────────────────── 
3H. NO TIME STATED
  If no time is mentioned → default to 09:00

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§4. COMPLETE EXAMPLES (today=${todayStr}, now=${timeStr})

"Поставь напоминание в пятницу в 10 утра купить молоко"
→ {"text":"купить молоко","datetime":"${nextDow(5)}T10:00:00${offsetStr}"}

"Нагадай у п'ятницю о 10 ранку купити молоко"
→ {"text":"купити молоко","datetime":"${nextDow(5)}T10:00:00${offsetStr}"}

"Поставь напоминание на субботу на 8:00 утра позвонить"
→ {"text":"позвонить","datetime":"${nextDow(6)}T08:00:00${offsetStr}"}

"Нагадай у суботу о 8:00 ранку зателефонувати"
→ {"text":"зателефонувати","datetime":"${nextDow(6)}T08:00:00${offsetStr}"}

"Напомни через 3 дня в 9 вечера позвонить маме"
→ {"text":"позвонить маме","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Нагадай через 3 дні о 9 вечора подзвонити мамі"
→ {"text":"подзвонити мамі","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Нагадай за 3 дні о 21:00 подзвонити мамі"
→ {"text":"подзвонити мамі","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Remind me in 3 days at 9 pm to call mom"
→ {"text":"call mom","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Erinnere mich in 3 Tagen um 9 Uhr abends Mama anrufen"
→ {"text":"Mama anrufen","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Rappelle-moi dans 3 jours à 21h appeler maman"
→ {"text":"appeler maman","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Recuérdame en 3 días a las 9 de la noche llamar a mamá"
→ {"text":"llamar a mamá","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Przypomnij mi za 3 dni o 21:00 zadzwonić do mamy"
→ {"text":"zadzwonić do mamy","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Нагадай завтра в 8 ранку привітати друга"
→ {"text":"привітати друга","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Нагадай після завтра о 9 вечора"
→ {"text":"","datetime":"${addD(2)}T21:00:00${offsetStr}"}

"Напомни в понедельник в 10 утра"
→ {"text":"","datetime":"${nextDow(1)}T10:00:00${offsetStr}"}

"Нагадай у понеділок о 10 ранку"
→ {"text":"","datetime":"${nextDow(1)}T10:00:00${offsetStr}"}

"Нагадай у вівторок о 15:00"
→ {"text":"","datetime":"${nextDow(2)}T15:00:00${offsetStr}"}

"Remind me on friday at 9 pm"
→ {"text":"","datetime":"${nextDow(5)}T21:00:00${offsetStr}"}

"Erinnere mich am Samstag um 10 Uhr"
→ {"text":"","datetime":"${nextDow(6)}T10:00:00${offsetStr}"}

"Samedi à 14h"
→ {"text":"","datetime":"${nextDow(6)}T14:00:00${offsetStr}"}

"El lunes a las 9 de la mañana"
→ {"text":"","datetime":"${nextDow(1)}T09:00:00${offsetStr}"}

"W poniedziałek o 9 rano"
→ {"text":"","datetime":"${nextDow(1)}T09:00:00${offsetStr}"}

"Напомни в 7 утра позвонить маме" (07:00 ≤ ${timeStr} → tomorrow)
→ {"text":"позвонить маме","datetime":"${addD(1)}T07:00:00${offsetStr}"}

"Напомни в 9 утра" (09:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Напомни в 10 утра" (10:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T10:00:00${offsetStr}"}

"Поставь на 9 утра" (09:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Поставь на 10 утра" (10:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T10:00:00${offsetStr}"}

"Нагадай о 9 ранку" (09:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Нагадай о 10 ранку" (10:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T10:00:00${offsetStr}"}

"Нагадай о 1 ночі зателефонувати" (01:00 ≤ ${timeStr} → tomorrow)
→ {"text":"зателефонувати","datetime":"${addD(1)}T01:00:00${offsetStr}"}

"Напомни в 9 вечера" (21:00 > ${timeStr} → today)
→ {"text":"","datetime":"${todayStr}T21:00:00${offsetStr}"}

"Нагадай о 6 ранку" (06:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T06:00:00${offsetStr}"}

"Remind me at 9am" (09:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Remind me at 10am" (10:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T10:00:00${offsetStr}"}

"Remind me at 8am" (08:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Erinnere mich um 9 Uhr morgens" (09:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Erinnere mich um 7 Uhr morgens" (07:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T07:00:00${offsetStr}"}

"Rappelle-moi à 9h du matin" (09:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Rappelle-moi à 10h du matin" (10:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T10:00:00${offsetStr}"}

"Recuérdame a las 9 de la mañana" (09:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Recuérdame a las 10 de la mañana" (10:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T10:00:00${offsetStr}"}

"Przypomnij mi o 9 rano" (09:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Przypomnij mi o 10 rano" (10:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T10:00:00${offsetStr}"}

"Через 30 минут напомни купить хлеб"
→ {"text":"купить хлеб","datetime":"${(() => { const d=new Date(localNow); d.setMinutes(d.getMinutes()+30); return toIso(d, getOffset(nowIso)); })().slice(0,-6)}:00${offsetStr}"}

"Через пів години нагадай купити хліб"
→ {"text":"купити хліб","datetime":"${(() => { const d=new Date(localNow); d.setMinutes(d.getMinutes()+30); return toIso(d, getOffset(nowIso)); })().slice(0,-6)}:00${offsetStr}"}

"Нагадай у середу о 15:00"
→ {"text":"","datetime":"${nextDow(3)}T15:00:00${offsetStr}"}

"Нагадай у четвер о 9 вечора"
→ {"text":"","datetime":"${nextDow(4)}T21:00:00${offsetStr}"}

"Нагадай у неділю о 12:00"
→ {"text":"","datetime":"${nextDow(0)}T12:00:00${offsetStr}"}

"Нагадай у суботу на 10:00 ранку"
→ {"text":"","datetime":"${nextDow(6)}T10:00:00${offsetStr}"}

"Нагадай за тиждень о 9 ранку"
→ {"text":"","datetime":"${addD(7)}T09:00:00${offsetStr}"}

"Erinnere mich übermorgen um 10 Uhr"
→ {"text":"","datetime":"${addD(2)}T10:00:00${offsetStr}"}

"Rappelle-moi après-demain à 10h"
→ {"text":"","datetime":"${addD(2)}T10:00:00${offsetStr}"}

"Recuérdame pasado mañana a las 10"
→ {"text":"","datetime":"${addD(2)}T10:00:00${offsetStr}"}

"Przypomnij mi w sobotę o 21:00"
→ {"text":"","datetime":"${nextDow(6)}T21:00:00${offsetStr}"}

"Через 2 години зустріч"
→ {"text":"зустріч","datetime":"${(() => { const d=new Date(localNow); d.setHours(d.getHours()+2); return toIso(d, getOffset(nowIso)); })().slice(0,-6)}:00${offsetStr}"}

"Нагадай о 6 ранку" (06:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T06:00:00${offsetStr}"}

"Remind me at 8am" (08:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Erinnere mich um 7 Uhr morgens" (07:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T07:00:00${offsetStr}"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Remember: output ONLY the JSON object. No explanation, no markdown.`;
}

app.get("/",       (_, res) => res.send("SayDone AI-only parser v5"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/parse", auth, async (req, res) => {
  try {
    const { text, locale } = req.body ?? {};
    if (!text || !req.body.now) return res.status(400).json({ ok: false, error: "Missing text or now" });

    const localNow = parseNow(req.body.now);
    if (!localNow) return res.status(400).json({ ok: false, error: "Invalid now" });
    const offsetMinutes = getOffset(req.body.now);
    const nowIso = toIso(localNow, offsetMinutes);

    const input = String(text).replace(/\s+/g, " ").trim();
    const systemPrompt = buildPrompt(nowIso, offStr(offsetMinutes), localNow);

    let result = null;
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4.1-nano",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: `Locale: ${locale || "unknown"}\nVoice input: "${input}"` },
        ],
        max_tokens: 120,
      });
      const raw = response.choices?.[0]?.message?.content;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.datetime) {
          const dt = new Date(parsed.datetime);
          if (!isNaN(dt.getTime())) result = parsed;
        }
      }
    } catch (err) {
      console.warn("[AI] error:", err.message);
    }

    if (result) {
      console.log(`[OK] "${input}" → ${result.datetime}`);
      return res.json({ ok: true, text: result.text || input, datetime: result.datetime, source: "ai" });
    }

    // AI failed completely — return empty datetime so app shows manual picker
    console.warn(`[FAIL] "${input}"`);
    return res.json({ ok: true, text: input, datetime: "", source: "unparsed" });

  } catch (e) {
    console.error("ERROR:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SayDone parser v5 on port ${port}`));


