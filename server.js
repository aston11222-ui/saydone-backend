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

function buildPrompt(nowIso, offsetStr, localNow, offsetMinutes) {
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
  const addM = n => { const d = new Date(localNow); d.setMinutes(d.getMinutes()+n); return toIso(d, offsetMinutes); };
  const addH = n => { const d = new Date(localNow); d.setHours(d.getHours()+n); return toIso(d, offsetMinutes); };
  // Display-only: just HH:MM for showing in examples
  const addHStr = n => { const d = new Date(localNow); d.setHours(d.getHours()+n); return d.toTimeString().slice(0,5); };
  const addMStr = n => { const d = new Date(localNow); d.setMinutes(d.getMinutes()+n); return d.toTimeString().slice(0,5); };

  return `You are a multilingual voice reminder parser. Your ONLY job: extract the task and exact datetime.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT TIME: ${nowIso}  (${dow})
TIMEZONE: ${offsetStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OUTPUT — ONLY valid JSON, nothing else:
{"text":"task in input language","datetime":"YYYY-MM-DDTHH:MM:SS${offsetStr}"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§1. TASK TEXT
Remove ALL time/date/weekday/interval words. Keep ONLY the actual reminder task.
Use the same language as the voice input.

STEP 1 — Remove these trigger words (they are NEVER part of the task):
  RU: поставь, напомни, поставь напоминание, напоминание, напомни мне, поставь будильник, поставь на, напомни на
  UK: нагадай, постав, постав нагадування, нагадування, нагадай мені, постав на, нагадай на
  EN: remind me, set a reminder, set reminder, remember, alert me, set a reminder for, remind me at, remind me in
  DE: erinnere mich, erinnerung setzen, erinnere, stell eine erinnerung, erinnere mich um, erinnere mich in
  FR: rappelle-moi, rappel, mets un rappel, rappelle-moi à, rappelle-moi dans
  ES: recuérdame, ponme un recordatorio, recordatorio, ponme recordatorio, recuérdame a, recuérdame en
  PL: przypomnij mi, ustaw przypomnienie, przypomnij, przypomnij mi o, przypomnij mi za
  IT: ricordami, imposta un promemoria, ricorda, ricordami di, ricordami tra
  PT: lembra-me, define um lembrete, lembra, lembra-me de, lembra-me em

STEP 2 — Remove ALL time/date/interval words:
  Intervals: через 30 минут, через час, через N минут/часов, in 30 minutes, in an hour, in N minutes, за N хвилин/годин, dans N minutes, en N minutos, za N minut, tra N minuti/ore, em N minutos/horas
  Dates: сегодня, завтра, послезавтра, today, tomorrow, сьогодні, завтра, nach X Tagen, oggi, domani, dopodomani, hoje, amanhã, depois de amanhã
  Times: в 9 утра, в 20:00, at 9am, um 9 Uhr, à 9h, a las 9, o 9 rano, о 9 ранку, alle 9 del mattino, às 9 da manhã
  Weekdays: понедельник, вторник, monday, tuesday, Montag, lundi, lunes, poniedziałek, lunedì, martedì, segunda-feira, terça-feira

STEP 3 — What remains is "text". If nothing remains → text = ""

CRITICAL RULE: "text" MUST be empty "" when input contains ONLY trigger+time words with NO actual task.
  RU: "Поставь напоминание через 30 минут" → text: ""
  RU: "Напомни через час 25" → text: ""
  RU: "Поставь напоминание на 11:00 вечера" → text: ""
  RU: "Напомни на 9 утра" → text: ""
  RU: "Поставь на завтра в 8" → text: ""
  RU: "Напомни завтра в 8" → text: ""
  UK: "Постав нагадування через 30 хвилин" → text: ""
  UK: "Нагадай через годину" → text: ""
  UK: "Постав нагадування на 11:00 вечора" → text: ""
  UK: "Нагадай о 9 ранку" → text: ""
  UK: "Постав на завтра о 8" → text: ""
  EN: "Remind me in 30 minutes" → text: ""
  EN: "Remind me at 11pm" → text: ""
  EN: "Set a reminder for 9am" → text: ""
  EN: "Set reminder for tomorrow at 8" → text: ""
  EN: "Remind me tomorrow at 8am" → text: ""
  DE: "Erinnere mich in 30 Minuten" → text: ""
  DE: "Erinnere mich um 11 Uhr abends" → text: ""
  DE: "Stell eine Erinnerung für 9 Uhr morgens" → text: ""
  DE: "Erinnere mich morgen um 8" → text: ""
  FR: "Rappelle-moi dans 30 minutes" → text: ""
  FR: "Rappelle-moi à 11h du soir" → text: ""
  FR: "Mets un rappel pour 9h du matin" → text: ""
  FR: "Rappelle-moi demain à 9h" → text: ""
  ES: "Recuérdame en 30 minutos" → text: ""
  ES: "Ponme un recordatorio a las 11 de la noche" → text: ""
  ES: "Recuérdame a las 9 de la mañana" → text: ""
  ES: "Recuérdame mañana a las 8" → text: ""
  PL: "Przypomnij mi za 30 minut" → text: ""
  PL: "Przypomnij mi o 11 wieczorem" → text: ""
  PL: "Ustaw przypomnienie na 9 rano" → text: ""
  PL: "Przypomnij mi jutro o 8" → text: ""
  IT: "Ricordami tra 30 minuti" → text: ""
  IT: "Ricordami alle 11 di sera" → text: ""
  IT: "Imposta un promemoria per le 9 del mattino" → text: ""
  IT: "Ricordami domani alle 8" → text: ""
  PT: "Lembra-me em 30 minutos" → text: ""
  PT: "Lembra-me às 11 da noite" → text: ""
  PT: "Define um lembrete para as 9 da manhã" → text: ""
  PT: "Lembra-me amanhã às 8" → text: ""
  RU: "Поставь напоминание на 11:00 вечера 45 минут" → text: "" (time=23:45)
  RU: "Поставь напоминание на 1:00 ночи 4 минуты" → text: "" (time=01:04)
  RU: "Поставь на 2 ночи" → text: ""
  RU: "Напомни в полночь" → text: ""
  UK: "Постав нагадування на 11:00 вечора 45 хвилин" → text: "" (time=23:45)
  UK: "Постав на 1:00 ночі 4 хвилини" → text: "" (time=01:04)
  EN: "Remind me at 11pm 45 minutes" → text: "" (time=23:45)
  EN: "Remind me at 1am" → text: ""
  EN: "Set reminder for midnight" → text: ""
  DE: "Erinnere mich um 11 Uhr abends 45 Minuten" → text: "" (time=23:45)
  DE: "Erinnere mich um 1 Uhr nachts" → text: ""
  FR: "Rappelle-moi à 1h du matin" → text: ""
  ES: "Recuérdame a la 1 de la madrugada" → text: ""
  PL: "Przypomnij mi o 1 w nocy" → text: ""

Good examples WITH real task:
  Input RU: "Поставь напоминание в пятницу в 10 утра купить молоко"
  Output:   "купить молоко"    ← task is "купить молоко"

  Input RU: "Напомни через час позвонить маме"
  Output:   "позвонить маме"   ← task is "позвонить маме"

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
  IT:  tra N giorno / tra N giorni / fra N giorno / fra N giorni
  PT:  em N dia / em N dias / daqui a N dia / daqui a N dias

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
  "tra 2 giorni"   → ${addD(2)}
  "fra 5 giorni"   → ${addD(5)}
  "em 2 dias"      → ${addD(2)}
  "daqui a 5 dias" → ${addD(5)}

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
  IT:  tra una settimana / tra N settimane / fra una settimana / fra N settimane
  PT:  em uma semana / em N semanas / daqui a uma semana / daqui a N semanas

Examples:
  "через неделю"   → ${addD(7)}
  "через тиждень"  → ${addD(7)}
  "за тиждень"     → ${addD(7)}
  "in a week"      → ${addD(7)}
  "in 2 weeks"     → ${addD(14)}
  "tra una settimana" → ${addD(7)}
  "fra 2 settimane"   → ${addD(14)}
  "em uma semana"     → ${addD(7)}
  "em 2 semanas"      → ${addD(14)}

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
  IT: domani
  PT: amanhã

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
  IT: dopodomani
  PT: depois de amanhã

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
  IT: oggi
  PT: hoje

──────────────────────────────────────── 
2F. WEEKDAYS — use the NEXT occurrence of that day
Today is ${dow} (index ${todayDow}). 
IMPORTANT: if the user says today's weekday name → use NEXT week, NOT today.

Monday    / Понедельник / Понеділок / Montag     / Lundi    / Lunes     / Poniedziałek / Lunedì    / Segunda-feira → ${nextDow(1)}
Tuesday   / Вторник     / Вівторок  / Dienstag   / Mardi    / Martes    / Wtorek       / Martedì   / Terça-feira   → ${nextDow(2)}
Wednesday / Среда       / Середа    / Mittwoch   / Mercredi / Miércoles / Środa        / Mercoledì / Quarta-feira  → ${nextDow(3)}
Thursday  / Четверг     / Четвер    / Donnerstag / Jeudi    / Jueves    / Czwartek     / Giovedì   / Quinta-feira  → ${nextDow(4)}
Friday    / Пятница     / П'ятниця  / Freitag    / Vendredi / Viernes   / Piątek       / Venerdì   / Sexta-feira   → ${nextDow(5)}
Saturday  / Суббота     / Субота    / Samstag    / Samedi   / Sábado    / Sobota       / Sabato    / Sábado        → ${nextDow(6)}
Sunday    / Воскресенье / Неділя    / Sonntag    / Dimanche / Domingo   / Niedziela    / Domenica  / Domingo       → ${nextDow(0)}

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
  IT: lunedì/il lunedì, martedì/il martedì, mercoledì/il mercoledì, giovedì/il giovedì,
      venerdì/il venerdì, sabato/il sabato, domenica/la domenica
  PT: segunda-feira/na segunda, terça-feira/na terça, quarta-feira/na quarta,
      quinta-feira/na quinta, sexta-feira/na sexta, sábado/no sábado, domingo/no domingo

──────────────────────────────────────── 
2G. NO DATE STATED — CRITICAL RULE
If no date word is given, compare the stated time to current time ${timeStr}:

  RULE: if stated_time > ${timeStr} → use TODAY (${todayStr})
        if stated_time ≤ ${timeStr} → use TOMORROW (${addD(1)})

  Current time is ${timeStr}. Apply this rule to ALL hours including night hours 00:00–05:59.

  Concrete examples at CURRENT TIME ${timeStr}:

  PAST → TOMORROW (stated_time ≤ ${timeStr}):
    \"в 9 утра\"  (09:00 ≤ ${timeStr}) → ${addD(1)}T09:00:00${offsetStr}
    \"в 10 утра\" (10:00 ≤ ${timeStr}) → ${addD(1)}T10:00:00${offsetStr}
    \"в 11 утра\" (11:00 ≤ ${timeStr}) → ${addD(1)}T11:00:00${offsetStr}
    \"в 12:00\"   (12:00 ≤ ${timeStr}) → ${addD(1)}T12:00:00${offsetStr}
    \"в 9 ранку\" (09:00 ≤ ${timeStr}) → ${addD(1)}T09:00:00${offsetStr}
    \"at 9am\"    (09:00 ≤ ${timeStr}) → ${addD(1)}T09:00:00${offsetStr}
    \"um 9 Uhr\"  (09:00 ≤ ${timeStr}) → ${addD(1)}T09:00:00${offsetStr}
    \"à 10h\"     (10:00 ≤ ${timeStr}) → ${addD(1)}T10:00:00${offsetStr}

  FUTURE → TODAY (stated_time > ${timeStr}):
    \"в ${addHStr(1)}\"  (${addHStr(1)} > ${timeStr}) → ${todayStr}T${addHStr(1)}:00${offsetStr}
    \"в ${addHStr(2)}\"  (${addHStr(2)} > ${timeStr}) → ${todayStr}T${addHStr(2)}:00${offsetStr}
    \"в ${addHStr(3)}\"  (${addHStr(3)} > ${timeStr}) → ${todayStr}T${addHStr(3)}:00${offsetStr}
    \"at ${addHStr(1)}\" (${addHStr(1)} > ${timeStr}) → ${todayStr}T${addHStr(1)}:00${offsetStr}
    \"um ${addHStr(2)}\" (${addHStr(2)} > ${timeStr}) → ${todayStr}T${addHStr(2)}:00${offsetStr}

  NIGHT HOURS — same rule, no exceptions:
${["01","02","03","04","05"].map(h => {
  const hhmm = `${h}:00`;
  const isPast = hhmm <= timeStr;
  const date = isPast ? addD(1) : todayStr;
  const label = isPast ? `≤ ${timeStr} → TOMORROW` : `> ${timeStr} → TODAY`;
  return `    "в ${h}:00 ночи/ночі/${h}am/${h}h du matin" (${hhmm} ${label}) → ${date}T${hhmm}:00${offsetStr}`;
}).join("\n")}
  Minutes work the same — "в 1:45 ночи" → time=01:45, compare 01:45 vs ${timeStr}:
    → ${"01:45" > timeStr ? `01:45 > ${timeStr} → TODAY ${todayStr}T01:45:00${offsetStr}` : `01:45 ≤ ${timeStr} → TOMORROW ${addD(1)}T01:45:00${offsetStr}`}
  "в 2:30 ночи" → time=02:30, compare 02:30 vs ${timeStr}:
    → ${"02:30" > timeStr ? `02:30 > ${timeStr} → TODAY ${todayStr}T02:30:00${offsetStr}` : `02:30 ≤ ${timeStr} → TOMORROW ${addD(1)}T02:30:00${offsetStr}`}

  !! CRITICAL: \"на 9:45 утра\" when 09:45>${timeStr} → ${todayStr}T09:45:00${offsetStr} (TODAY!)
  !! CRITICAL: \"в 15:00\" when 15:00>${timeStr} → ${todayStr}T15:00:00${offsetStr} (TODAY!)

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
  IT: del mattino / di mattina / la mattina
  PT: da manhã / de manhã

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
  IT: del pomeriggio / nel pomeriggio
  PT: da tarde (12-17h)

Examples:
  "1 дня"   → 13:00    "2 дня"   → 14:00    "3 дня"  → 15:00
  "4 дня"   → 16:00    "5 дня"   → 17:00    "12 дня" → 12:00
  "3 дня"   UK → 15:00  "2 дня"  UK → 14:00
  "3pm"     → 15:00    "3 nachmittags" → 15:00

  !! WITH MINUTES — afternoon word means +12h to hour if hour < 12:
  "1:43 дня"  → 13:43   "2:30 дня"  → 14:30   "3:15 дня"  → 15:15
  "1:43 дня"  UK → 13:43  "2:30 дня" UK → 14:30
  "1:43pm"    → 13:43   "2:30pm"    → 14:30   "3:15pm"    → 15:15
  "1:43 de la tarde" → 13:43  "2:30 de l'après-midi" → 14:30
  "1:43 del pomeriggio" → 13:43  "1:43 da tarde" → 13:43
  "1:43 po południu" → 13:43  "1:43 nachmittags" → 13:43
  RULE: ANY time X:MM + afternoon word → if X < 12 then result = (X+12):MM

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
  IT: di sera / la sera / del pomeriggio (18h+)
  PT: da tarde (18h+) / da noite / à noite

Examples:
  "6 вечера"   → 18:00    "6 вечора"   → 18:00    "6pm"        → 18:00
  "7 вечера"   → 19:00    "7 вечора"   → 19:00    "7 abends"   → 19:00
  "8 вечера"   → 20:00    "8 вечора"   → 20:00    "8 du soir"  → 20:00
  "9 вечера"   → 21:00    "9 вечора"   → 21:00    "9pm"        → 21:00
  "10 вечера"  → 22:00    "10 вечора"  → 22:00    "10 abends"  → 22:00
  "11 вечера"  → 23:00    "11 вечора"  → 23:00    "11pm"       → 23:00
  "12 вечера"  → 12:00
  "10:00 вечера" → 22:00   "9:30 вечора" → 21:30   "8:00 pm"  → 20:00
  "11:00 вечера" → 23:00   "11:30 вечора" → 23:30   "11:00 pm" → 23:00
  "7:30 вечера"  → 19:30   "6:45 вечора"  → 18:45   "10:30 pm" → 22:30

RULE for HH:MM + evening word: if HH < 12 → add 12 to get 24h time
  RU: 11:00 + вечера → 23:00  |  10:00 + вечера → 22:00  |  9:00 + вечера → 21:00
  UK: 11:00 + вечора → 23:00  |  10:00 + вечора → 22:00  |  9:30 + вечора → 21:30
  EN: 11:00 + pm     → 23:00  |  10:00 + pm     → 22:00  |  9:30 + pm     → 21:30
  DE: 11:00 + abends → 23:00  |  10:00 + abends → 22:00  |  9:00 + abends → 21:00
  FR: 11:00 + du soir→ 23:00  |  10:00 + du soir→ 22:00  |  9:30 + soir   → 21:30
  ES: 11:00 + de la noche → 23:00  |  10:00 + de la noche → 22:00
  PL: 11:00 + wieczorem   → 23:00  |  10:00 + wieczorem   → 22:00  |  9:00 + wieczór → 21:00

SPECIAL: "H:MM вечера N минут" or "H часов вечера N минут" — N минут is the minutes part:
  "11:00 вечера 45 минут" → 23:45  (11+12=23, minutes=45)
  "10:00 вечера 30 минут" → 22:30  (10+12=22, minutes=30)
  "9 вечера 15 минут"     → 21:15  (9+12=21,  minutes=15)
  "11:00 вечора 45 хвилин"→ 23:45
  "11pm 45 minutes"       → 23:45
  "11h du soir 45 minutes"→ 23:45
  "11 de la noche 45 minutos" → 23:45
  "11 Uhr abends 45 Minuten"  → 23:45
  "11 wieczorem 45 minut"     → 23:45

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
  IT: di notte / la notte / della notte
  PT: da madrugada / de madrugada / à noite (late)

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
  IT: tra N minuto/minuti / fra N minuto/minuti
  PT: em N minuto/minutos / daqui a N minuto/minutos

Words meaning "in N hours":
  RU: через N час/часа/часов
  UK: через N годину/години/годин
  EN: in N hour/hours
  DE: in N Stunde/Stunden
  FR: dans N heure/heures
  ES: en N hora/horas
  PL: za N godzinę/godziny/godzin
  IT: tra N ora/ore / fra N ora/ore
  PT: em N hora/horas / daqui a N hora/horas

Special short forms:
  RU/UK: через полчаса / через пів години → +30 min
  RU:    через час → +1 hour
  UK:    через годину → +1 hour
  EN:    in half an hour → +30 min | in an hour → +1 hour
  DE:    in einer halben Stunde → +30 min | in einer Stunde → +1 hour
  FR:    dans une demi-heure → +30 min | dans une heure → +1 hour
  ES:    en media hora → +30 min | en una hora → +1 hour
  PL:    za pół godziny → +30 min | za godzinę → +1 hour
  IT:    tra mezz'ora → +30 min | tra un'ora → +1 hour | fra mezz'ora → +30 min
  PT:    em meia hora → +30 min | em uma hora → +1 hour | daqui a meia hora → +30 min

Examples (current time ${timeStr}):
  "через 15 минут"    → ${addMStr(15)}    "через 30 хвилин" → ${addMStr(30)}
  "через полчаса"     → ${addMStr(30)}    "через пів години"→ ${addMStr(30)}
  "through 1 hour"    → ${addHStr(1)}     "in 2 hours"      → ${addHStr(2)}
  "в 1 Stunde"        → ${addHStr(1)}     "dans 30 minutes" → ${addMStr(30)}

──────────────────────────────────────── 
3H. NO TIME STATED
  If no time is mentioned AND there IS a real task → default to 09:00 tomorrow
  If no time is mentioned AND there is NO real task (only trigger words) → return {"ok":false}

  !! IMPORTANT: "через 10 минут", "in 10 minutes", "tra 10 minuti" etc. ARE time references.
  !! "Поставь напоминание через 10 минут" has NO task but HAS time → datetime=<now+10min>, text=""
  !! "Remind me in 5 minutes" → datetime=<now+5min>, text=""
  !! "Erinnere mich in 10 Minuten" → datetime=<now+10min>, text=""
  !! "Rappelle-moi dans 5 minutes" → datetime=<now+5min>, text=""
  !! "Ricordami tra 10 minuti" → datetime=<now+10min>, text=""
  !! "Lembra-me em 5 minutos" → datetime=<now+5min>, text=""
  !! NEVER return {"ok":false} when there is a time reference (even relative)
  
  Examples:
  "купить кота" (no time, has task) → {"text":"купить кота","datetime":"${addD(1)}T09:00:00${offsetStr}"}
  "поставь напоминание" (no time, no task) → {"ok":false}
  "remind me" (no time, no task) → {"ok":false}
  "set a reminder" (no time, no task) → {"ok":false}
  "erinnere mich" (no time, no task) → {"ok":false}
  "rappelle-moi" (no time, no task) → {"ok":false}
  "recuérdame" (no time, no task) → {"ok":false}
  "przypomnij mi" (no time, no task) → {"ok":false}
  "ricordami" (no time, no task) → {"ok":false}
  "lembra-me" (no time, no task) → {"ok":false}

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

"Поставь напоминание через 10 минут"
→ {"text":"","datetime":"${addM(10)}"}

"Напомни через час"
→ {"text":"","datetime":"${addH(1)}"}

"Remind me in 10 minutes"
→ {"text":"","datetime":"${addM(10)}"}

"Erinnere mich in 30 Minuten"
→ {"text":"","datetime":"${addM(30)}"}

"Rappelle-moi dans 10 minutes"
→ {"text":"","datetime":"${addM(10)}"}

"Recuérdame en 10 minutos"
→ {"text":"","datetime":"${addM(10)}"}

"Przypomnij mi za 10 minut"
→ {"text":"","datetime":"${addM(10)}"}

"Ricordami tra 10 minuti"
→ {"text":"","datetime":"${addM(10)}"}

"Lembra-me em 10 minutos"
→ {"text":"","datetime":"${addM(10)}"}

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

"Ricordami tra 3 giorni alle 21 chiamare la mamma"
→ {"text":"chiamare la mamma","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Lembra-me em 3 dias às 21h ligar para a mãe"
→ {"text":"ligar para a mãe","datetime":"${addD(3)}T21:00:00${offsetStr}"}

"Ricordami domani alle 8 di mattina salutare l'amico"
→ {"text":"salutare l'amico","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Lembra-me amanhã às 8 da manhã cumprimentar o amigo"
→ {"text":"cumprimentar o amigo","datetime":"${addD(1)}T08:00:00${offsetStr}"}

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
→ {"text":"купить хлеб","datetime":"${addM(30)}"}
NOTE: "купить хлеб" comes from the input above — extract task from the ACTUAL user input, not from this example.

"Через пів години нагадай купити хліб"
→ {"text":"купити хліб","datetime":"${addM(30)}"}

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

"Ustaw przypomnienie na 9 rano" (PL, no task → text="")
→ {"text":"","datetime":"${addD(1)}T09:00:00${offsetStr}"}

"Przypomnij mi o 23:00" (PL, no task → text="")
→ {"text":"","datetime":"${todayStr}T23:00:00${offsetStr}"}

"Przypomnij mi w sobotę o 21:00"
→ {"text":"","datetime":"${nextDow(6)}T21:00:00${offsetStr}"}

"Поставь напоминание на 1:00 ночи 4 минуты" (RU, no task → text="", time=01:04)
→ {"text":"","datetime":"${addD(1)}T01:04:00${offsetStr}"}

"Поставь напоминание на 11:00 вечера 45 минут" (RU, no task, 11:00+12=23 + 45min=23:45)
→ {"text":"","datetime":"${todayStr}T23:45:00${offsetStr}"}

"Поставь напоминание на 11:00 вечера" (RU, no task → text="", 11:00+вечера=23:00)
→ {"text":"","datetime":"${todayStr}T23:00:00${offsetStr}"}

"Постав нагадування на 11:00 вечора" (UK, no task → text="", 23:00)
→ {"text":"","datetime":"${todayStr}T23:00:00${offsetStr}"}

"Set a reminder for 11pm" (EN, no task → text="", 23:00)
→ {"text":"","datetime":"${todayStr}T23:00:00${offsetStr}"}

"Stell eine Erinnerung für 11 Uhr abends" (DE, no task → text="", 23:00)
→ {"text":"","datetime":"${todayStr}T23:00:00${offsetStr}"}

"Mets un rappel à 11h du soir" (FR, no task → text="", 23:00)
→ {"text":"","datetime":"${todayStr}T23:00:00${offsetStr}"}

"Ponme un recordatorio a las 11 de la noche" (ES, no task → text="", 23:00)
→ {"text":"","datetime":"${todayStr}T23:00:00${offsetStr}"}

"Przypomnij mi o 23:00" (PL, no task → text="", 23:00)
→ {"text":"","datetime":"${todayStr}T23:00:00${offsetStr}"}

"Поставь напоминание через 30 минут" (no task in input → text is empty)
→ {"text":"","datetime":"${addM(30)}"}

"Remind me in 30 minutes" (no task → text is empty)
→ {"text":"","datetime":"${addM(30)}"}

"Через 2 години зустріч"
→ {"text":"зустріч","datetime":"${addH(2)}"}

"Нагадай о 6 ранку" (06:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T06:00:00${offsetStr}"}

"Remind me at 8am" (08:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Erinnere mich um 7 Uhr morgens" (07:00 ≤ ${timeStr} → tomorrow)
→ {"text":"","datetime":"${addD(1)}T07:00:00${offsetStr}"}

── Завтра + утро (all languages) ──
"Напомни завтра в 8 утра"
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Remind me tomorrow at 8am"
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Erinnere mich morgen um 8 Uhr morgens"
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Rappelle-moi demain à 8h du matin"
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Recuérdame mañana a las 8 de la mañana"
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

"Przypomnij mi jutro o 8 rano"
→ {"text":"","datetime":"${addD(1)}T08:00:00${offsetStr}"}

── Послезавтра (all languages) ──
"Напомни послезавтра в 10 утра"
→ {"text":"","datetime":"${addD(2)}T10:00:00${offsetStr}"}

"Remind me the day after tomorrow at 10am"
→ {"text":"","datetime":"${addD(2)}T10:00:00${offsetStr}"}

── Дни недели — понедельник (EN, DE, FR) ──
"Remind me on Monday at 10am"
→ {"text":"","datetime":"${nextDow(1)}T10:00:00${offsetStr}"}

"Erinnere mich am Montag um 10 Uhr"
→ {"text":"","datetime":"${nextDow(1)}T10:00:00${offsetStr}"}

"Rappelle-moi lundi à 10h"
→ {"text":"","datetime":"${nextDow(1)}T10:00:00${offsetStr}"}

── Через N минут/часов (all languages) ──
"In 30 minutes buy bread"
→ {"text":"buy bread","datetime":"${addM(30)}"}

"In 2 hours call"
→ {"text":"call","datetime":"${addH(2)}"}

"In 2 Stunden anrufen"
→ {"text":"anrufen","datetime":"${addH(2)}"}

"Dans 30 minutes acheter du pain"
→ {"text":"acheter du pain","datetime":"${addM(30)}"}

"En 30 minutos comprar pan"
→ {"text":"comprar pan","datetime":"${addM(30)}"}

"Za 30 minut kupić chleb"
→ {"text":"kupić chleb","datetime":"${addM(30)}"}

"Через 2 часа позвонить"
→ {"text":"позвонить","datetime":"${addH(2)}"}

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

    // ── Moderation check ──────────────────────────────────────────────────────
    try {
      const modResponse = await Promise.race([
        client.moderations.create({ input: input }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("moderation timeout")), 3000))
      ]);
      const modResult = modResponse.results?.[0];
      if (modResult?.flagged) {
        const cats = Object.entries(modResult.categories || {})
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ');
        console.warn(`[MODERATION] Flagged: "${input}" — categories: ${cats}`);
        return res.status(200).json({ ok: false, error: "moderated", categories: cats });
      }
    } catch (modErr) {
      // Если модерация недоступна — продолжаем без неё
      console.warn("[MODERATION] skipped:", modErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const systemPrompt = buildPrompt(nowIso, offStr(offsetMinutes), localNow, offsetMinutes);

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
      // ── Post-processing: fix next-day datetime when same time today is still future ──
      // Skip fix if user explicitly said "tomorrow/завтра/morgen/demain/mañana/jutro/domani/amanhã"
      // ── Pre-fix: correct AM time when afternoon word is present ─────────────
      // "1:43 дня" → AI may return 01:43 instead of 13:43
      const afternoonWords = /\b(дня|дні|de\s*la\s*tarde|de\s*l[''']après-midi|del\s*pomeriggio|da\s*tarde|po\s*południu|nachmittags|am\s*nachmittag|in\s*the\s*afternoon|de\s*la\s*soir[ée]e?)\b/i;
      if (afternoonWords.test(input) && result) {
        try {
          const rDt = new Date(result.datetime);
          const offsetMs2 = offsetMinutes * 60000;
          const rLocal = new Date(rDt.getTime() + offsetMs2);
          const rHour = rLocal.getUTCHours();
          if (rHour >= 1 && rHour <= 5) {
            // Clearly wrong — afternoon hour should be 13-17, not 1-5
            const correctedH = rHour + 12;
            const rMin2 = rLocal.getUTCMinutes();
            const nYear2 = localNow.getFullYear(), nMonth2 = localNow.getMonth(), nDay2 = localNow.getDate();
            const rYear2 = rLocal.getUTCFullYear(), rMonth2 = rLocal.getUTCMonth(), rDay2 = rLocal.getUTCDate();
            // Use the AI's date but correct the hour
            const correctedIso = `${String(rYear2).padStart(4,'0')}-${p2(rMonth2+1)}-${p2(rDay2)}T${p2(correctedH)}:${p2(rMin2)}:00${offStr(offsetMinutes)}`;
            console.log(`[AFTERNOON FIX] ${p2(rHour)}:${p2(rMin2)} + afternoon word → ${p2(correctedH)}:${p2(rMin2)}: ${correctedIso}`);
            result = { ...result, datetime: correctedIso };
          }
        } catch (e) { console.warn('[AFTERNOON FIX] error:', e.message); }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Explicit date/day words in all 9 app languages — if present, skip the "today" fix
      const _ew = [
        // Tomorrow
        'завтра','tomorrow','morgen','demain','ma[nñ]ana','jutro','domani','amanh[aã]',
        // Day after tomorrow
        'послезавтра','після\\s*завтра','позавтра','післязавтра',
        'day\\s*after\\s*tomorrow','übermorgen','uebermorgen',
        'après-demain','apres-demain','pasado\\s*ma[nñ]ana',
        'pojutrze','dopodomani','depois\\s*de\\s*amanh[aã]',
        // Weekdays RU
        'в\\s*понедельник','в\\s*вторник','в\\s*среду','в\\s*четверг','в\\s*пятницу','в\\s*субботу','в\\s*воскресенье',
        // Weekdays UK
        'у\\s*понедiлок','у\\s*вiвторок','у\\s*середу','у\\s*четвер','у\\s*п.ятницю','у\\s*суботу','у\\s*недiлю',
        'в\\s*понедiлок','в\\s*вiвторок',
        // Weekdays EN
        'on\\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)',
        '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)',
        // Weekdays DE
        'am\\s*(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)',
        // Weekdays FR
        'lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche',
        // Weekdays ES
        'el\\s*(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)',
        // Weekdays PL
        'w\\s*poniedzia[lł]ek','we\\s*wtorek','w\\s*[sś]rod[eę]','w\\s*czwartek','w\\s*pi[aą]tek','w\\s*sobot[eę]','w\\s*niedziel[eę]',
        // Weekdays IT
        'il\\s*(luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato)','la\\s*domenica',
        'luned[iì]','marted[iì]','mercoled[iì]','gioved[iì]','venerd[iì]',
        // Weekdays PT
        'na\\s*segunda','na\\s*ter[cç]a','na\\s*quarta','na\\s*quinta','na\\s*sexta','no\\s*s[aá]bado','no\\s*domingo',
        // In N days/weeks
        'через\\s*\\d+\\s*(день|дня|дней|тиждень|тижнi|тижнiв|неделю|недели|недель)',
        'за\\s*\\d+\\s*(день|дня|днiв|тиждень)',
        'in\\s*\\d+\\s*(day|days|week|weeks)',
        'in\\s*\\d+\\s*(tag|tagen|woche|wochen)',
        'dans\\s*\\d+\\s*(jour|jours|semaine|semaines)',
        'en\\s*\\d+\\s*(d[ií]a|d[ií]as|semana|semanas)',
        'za\\s*\\d+\\s*(dzie[nń]|dni|tydzie[nń]|tygodnie|tygodni)',
        'tra\\s*\\d+\\s*(giorn[oi]|settiman[ae])','fra\\s*\\d+\\s*(giorn[oi]|settiman[ae])',
        'em\\s*\\d+\\s*(dia|dias|semana|semanas)','daqui\\s*a\\s*\\d+',
      ];
      const explicitDateRe = new RegExp('(^|\\s|\\b)(' + _ew.join('|') + ')(\\s|\\b|$)', 'iu');
      const hasExplicitDate = explicitDateRe.test(input);

      try {
        const resultDt = new Date(result.datetime);
        if (!isNaN(resultDt.getTime()) && !hasExplicitDate) {
          const offsetMs = offsetMinutes * 60000;
          const resultLocalMs = resultDt.getTime() + offsetMs;
          const resultLocalDate = new Date(resultLocalMs);
          const rH = resultLocalDate.getUTCHours();
          const rMin = resultLocalDate.getUTCMinutes();

          const rDay = resultLocalDate.getUTCDate(), rMonth = resultLocalDate.getUTCMonth(), rYear = resultLocalDate.getUTCFullYear();
          const nDay = localNow.getDate(), nMonth = localNow.getMonth(), nYear = localNow.getFullYear();
          const resultDateOnly = new Date(Date.UTC(rYear, rMonth, rDay));
          const nowDateOnly    = new Date(Date.UTC(nYear, nMonth, nDay));
          const diffDays = Math.round((resultDateOnly - nowDateOnly) / 86400000);

          if (diffDays === 1) {
            const nowH = localNow.getHours(), nowMin = localNow.getMinutes();
            const statedMinutes  = rH * 60 + rMin;
            const currentMinutes = nowH * 60 + nowMin;
            if (statedMinutes > currentMinutes) {
              const todayIso = `${String(nYear).padStart(4,'0')}-${p2(nMonth+1)}-${p2(nDay)}T${p2(rH)}:${p2(rMin)}:00${offStr(offsetMinutes)}`;
              console.log(`[FIX] ${p2(rH)}:${p2(rMin)} > ${p2(nowH)}:${p2(nowMin)}, no explicit tomorrow → today: ${todayIso}`);
              result = { ...result, datetime: todayIso };
            }
          }
        } else if (hasExplicitDate) {
          console.log(`[FIX] skipped — explicit date word detected in: "${input}"`);
        }
      } catch (fixErr) {
        console.warn("[FIX] error:", fixErr.message);
      }
      // ─────────────────────────────────────────────────────────────────────────

      console.log(`[OK] "${input}" → ${result.datetime}`);

      // If AI returned empty text (only trigger words, no real task) → ok:false
      // App will show "Almost ready" sheet to pick time
      const resultText = (result.text || '').trim();
      if (!resultText || resultText === input.trim()) {
        // Only skip if input has NO time references at all
        const hasTimeRef = /(\d{1,2}[:h]\d{0,2}|\d+\s*(мин|час|хв|min|hour|heure|hora|minuto|ora)|утра|вечера|ночи|дня|утром|вечером|ранку|вечора|am|pm|morning|evening|night|après-midi|matin|mañana\s+\d|tarde|noche|rano|wieczor|mattina|sera|manhã|tarde)/i.test(input);
        const triggerOnly = !hasTimeRef && /^[\s\p{P}]*(поставь|напомни|нагадай|remind|set a reminder|erinnere|rappelle|recuérdame|przypomnij|ricordami|lembra)[\s\p{P}]*мне?[\s\p{P}]*$/iu.test(input.trim());
        if (triggerOnly) {
          console.log(`[SKIP] trigger-only input, no task: "${input}"`);
          return res.json({ ok: false, reason: 'no_task' });
        }
      }

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
