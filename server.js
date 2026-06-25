import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
 
dotenv.config();
const DEBUG = process.env.APP_DEBUG === 'true';
const app = express();
app.use(cors());
app.use(express.json());
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 
// ── Rate limiter ───────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now(), e = rateLimitMap.get(ip);
  if (!e || now > e.resetAt) { rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 }); return true; }
  if (e.count >= 30) return false;
  e.count++; return true;
}
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of rateLimitMap) if (n > v.resetAt) rateLimitMap.delete(k);
}, 300_000);
 
const APP_SECRET = process.env.APP_SECRET || null;
function auth(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, error: "rate_limit" });
  if (APP_SECRET && req.headers['x-app-key'] !== APP_SECRET) return res.status(403).json({ ok: false, error: "forbidden" });
  next();
}
 
// ── Utils ──────────────────────────────────────────────────────────────────────
const p2    = n => String(n).padStart(2, "0");
const offStr = o => { const s = o >= 0 ? "+" : "-", a = Math.abs(o); return `${s}${p2(Math.floor(a/60))}:${p2(a%60)}`; };
const toIso  = (d, o) => `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00${offStr(o)}`;
 
function parseNow(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0)) : null;
}
function getOffset(s) {
  const m = String(s).match(/([+-])(\d{2}):(\d{2})$/);
  return m ? (+m[2]*60 + +m[3]) * (m[1]==='+' ? 1 : -1) : 0;
}
 
const DOW_EN = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
 
// ── AI Prompt builder ──────────────────────────────────────────────────────────
function buildPrompt(nowIso, offsetStr, localNow, offsetMinutes, lang) {
  const dow     = DOW_EN[localNow.getDay()];
  const todayStr = nowIso.slice(0, 10);
  const timeStr  = nowIso.slice(11, 16);
  const addD = n => { const d = new Date(localNow); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };
  const nextDow = i => { let diff = i - localNow.getDay(); if(diff<=0) diff+=7; const d=new Date(localNow); d.setDate(d.getDate()+diff); return d.toISOString().slice(0,10); };
 
  const langHints = {
    ru: { am: 'утра/утром', pm: 'вечера/вечером/ночи', noon: 'дня/после обеда',
          triggers: 'поставь/напомни/поставь напоминание',
          days: 'пн=понедельник, вт=вторник, ср=среда, чт=четверг, пт=пятница, сб=суббота, вс=воскресенье' },
    uk: { am: 'ранку/вранці/зранку', pm: 'вечора/увечері/ввечері/ночі', noon: 'дня/по обіді',
          triggers: 'нагадай/постав/постав нагадування',
          days: 'пн=понеділок, вт=вівторок, ср=середа, чт=четвер, пт=п\'ятниця, сб=субота, нд=неділя' },
    en: { am: 'am/morning', pm: 'pm/evening/night', noon: 'afternoon/noon',
          triggers: 'remind me/set a reminder/remember',
          days: 'mon, tue, wed, thu, fri, sat, sun' },
    de: { am: 'morgens/früh', pm: 'abends/nachts', noon: 'nachmittags',
          triggers: 'erinnere mich/stell eine Erinnerung',
          days: 'Mo=Montag, Di=Dienstag, Mi=Mittwoch, Do=Donnerstag, Fr=Freitag, Sa=Samstag, So=Sonntag' },
    fr: { am: 'du matin', pm: 'du soir/de nuit', noon: 'de l\'après-midi',
          triggers: 'rappelle-moi/mets un rappel',
          days: 'lun, mar, mer, jeu, ven, sam, dim' },
    es: { am: 'de la mañana/madrugada', pm: 'de la tarde(18h+)/de la noche', noon: 'de la tarde(12-17h)',
          triggers: 'recuérdame/ponme un recordatorio',
          days: 'lun, mar, mié, jue, vie, sáb, dom' },
    pl: { am: 'rano/z rana', pm: 'wieczorem', noon: 'po południu',
          triggers: 'przypomnij mi/ustaw przypomnienie',
          days: 'pon=poniedziałek, wt=wtorek, śr=środa, czw=czwartek, pt=piątek, sob=sobota, nd=niedziela' },
    it: { am: 'di mattina/mattina', pm: 'di sera/pomeriggio', noon: 'del pomeriggio',
          triggers: 'ricordami/imposta un promemoria',
          days: 'lun=lunedì, mar=martedì, mer=mercoledì, gio=giovedì, ven=venerdì, sab=sabato, dom=domenica' },
    pt: { am: 'da manhã/madrugada', pm: 'da noite/da tarde(18h+)', noon: 'da tarde(12-17h)',
          triggers: 'lembra-me/define um lembrete',
          days: 'seg=segunda, ter=terça, qua=quarta, qui=quinta, sex=sexta, sáb=sábado, dom=domingo' },
  };
  const h = langHints[lang] || langHints.en;
 
  return `You are a reminder time parser. Today is ${todayStr} (${dow}), time is ${timeStr}, UTC offset is ${offsetStr}.
 
TASK: Extract reminder text and datetime from voice input in ${lang.toUpperCase()} language.
 
OUTPUT: JSON only — {"text":"<task>","datetime":"<ISO8601 with offset>"}
- datetime format: ${todayStr}T15:00:00${offsetStr}
- CRITICAL: hours in datetime = LOCAL time (NOT UTC). If user says 9:00 → T09:00:00${offsetStr}, NOT T06:00:00${offsetStr}
- If NO time stated → {"text":"<task>","datetime":""}
- If ONLY trigger words, no task → {"ok":false}
 
RULES:
1. Remove trigger words from text: ${h.triggers}
2. AM words (keep hour as-is, 12→0): ${h.am}
3. PM words (add 12 if hour < 12): ${h.pm}
4. NOON/afternoon words (add 12 if hour < 12, max 17): ${h.noon}
5. Weekday names in this language: ${h.days}
6. If past time and no date word → move to tomorrow
7. Weekdays → next future occurrence (never today)
8. послезавтра/übermorgen/après-demain/pojutrze/dopodomani/depois de amanhã → ${addD(2)}
 
DATES (today=${todayStr}):
- tomorrow → ${addD(1)}
- day after tomorrow → ${addD(2)}
- next monday → ${nextDow(1)}, tuesday → ${nextDow(2)}, wednesday → ${nextDow(3)}
- thursday → ${nextDow(4)}, friday → ${nextDow(5)}, saturday → ${nextDow(6)}, sunday → ${nextDow(0)}
 
EXAMPLES:
{"text":"купить молоко","datetime":"${addD(1)}T21:00:00${offsetStr}"}  ← tomorrow at 9pm
{"text":"","datetime":"${addD(3)}T09:00:00${offsetStr}"}              ← in 3 days at 9am
{"text":"встреча","datetime":""}                                       ← no time stated
{"ok":false}                                                           ← only trigger words
 
Output ONLY the JSON. No explanation.`;
}
 
// ── Endpoints ──────────────────────────────────────────────────────────────────
app.get("/",       (_, res) => res.send("SayDone parser v6"));
app.get("/health", (_, res) => res.json({ ok: true }));
 
app.post("/parse", auth, async (req, res) => {
  try {
    const { text, locale } = req.body ?? {};
    const lang = (locale || 'ru').split(/[_-]/)[0].toLowerCase();
    if (!text || !req.body.now) return res.status(400).json({ ok: false, error: "Missing text or now" });
 
    const localNow = parseNow(req.body.now);
    if (!localNow) return res.status(400).json({ ok: false, error: "Invalid now" });
    const offsetMinutes = getOffset(req.body.now);
    const nowIso = toIso(localNow, offsetMinutes);
 
    let input = String(text).replace(/\s+/g, " ").trim();
 
    // ── ASR normalization ────────────────────────────────────────────────────────
    input = (function normalizeASR(s) {
      // Fix glued time: "в8" → "в 8"
      s = s
        .replace(/(в|о|у|на)(\d{1,2})(?=\s|$)/gi, '$1 $2')
        .replace(/\b(at|on|um|à|a|às|alle|las)(\d{1,2})\b/gi, '$1 $2');
      // Fix spaced time: "в 8 30" → "в 8:30"
      s = s.replace(/(в|о|у|на|at|um|à|a|às|alle|las)\s+(\d{1,2})\s+(\d{2})(?=\s|$)/gi, '$1 $2:$3');
      // Fix 4-digit military time: "at 1300" → "at 13:00"
      s = s.replace(/(?:^|\s)(at|um|à|às|alle|a\s+las)\s+([01]\d{3}|2[0-3]\d{2})\b/gi, (_, prep, num) => {
        if (parseInt(num.slice(-2)) > 59) return _;
        return ' ' + prep + ' ' + num.slice(0, num.length-2) + ':' + num.slice(-2);
      });
      s = s.replace(/(в|о|на)\s+([01]\d{3}|2[0-3]\d{2})(?=\s|$)/gi, (_, prep, num) => {
        if (parseInt(num.slice(-2)) > 59) return _;
        return prep + ' ' + num.slice(0, num.length-2) + ':' + num.slice(-2);
      });
      // ASR verb mistakes
      s = s
        .replace(/напамин(?=\s|$)/gi, 'напомни')
        .replace(/\breminder\s+me\b/gi, 'remind me')
        .replace(/\bremind\s+to\b/gi, 'remind me to')
        .replace(/\berinner\s+mich\b/gi, 'erinnere mich')
        .replace(/\brappel\s+moi\b/gi, 'rappelle moi')
        .replace(/\brecordame\b/gi, 'recuérdame')
        .replace(/\bprzypomni\s+mi\b/gi, 'przypomnij mi')
        .replace(/\bricorda\s+mi\b/gi, 'ricordami')
        .replace(/\blembra\s+me\b/gi, 'lembra-me');
      // Filler words
      s = s
        .replace(/(^|\s)(ну|типа|короче|ээ|эм)(?=\s|$)/gi, ' ')
        .replace(/\b(uh|um|eh|äh|euh)\b/gi, '');
      return s.replace(/\s+/g, ' ').trim();
    })(input);
 
    // ── Word numbers → digits ────────────────────────────────────────────────────
    function normalizeWordNums(s) {
      // Accentless → accented
      s = s
        .replace(/\bmiercoles\b/gi, 'miércoles').replace(/\bsabado\b/gi, 'sábado')
        .replace(/\bmanana\b/gi, 'mañana').replace(/\bproximo\b/gi, 'próximo').replace(/\bproxima\b/gi, 'próxima')
        .replace(/\blunedi\b/gi, 'lunedì').replace(/\bmartedi\b/gi, 'martedì')
        .replace(/\bmercoledi\b/gi, 'mercoledì').replace(/\bgiovedi\b/gi, 'giovedì').replace(/\bvenerdi\b/gi, 'venerdì')
        .replace(/\bsroda\b/gi, 'środa').replace(/\bsrode\b/gi, 'środę').replace(/\bpiatek\b/gi, 'piątek')
        .replace(/\bniedziele\b/gi, 'niedzielę').replace(/\bsobote\b/gi, 'sobotę')
        .replace(/\bamanha\b/gi, 'amanhã');
 
      // Compound numbers (longest first to avoid partial matches)
      const compounds = [
        // ES
        [/treinta\s+y\s+un[ao]?/gi,'31'],[/treinta\s+y\s+dos/gi,'32'],[/treinta\s+y\s+tres/gi,'33'],
        [/treinta\s+y\s+cuatro/gi,'34'],[/treinta\s+y\s+cinco/gi,'35'],[/treinta\s+y\s+seis/gi,'36'],
        [/treinta\s+y\s+siete/gi,'37'],[/treinta\s+y\s+ocho/gi,'38'],[/treinta\s+y\s+nueve/gi,'39'],
        [/cuarenta\s+y\s+un[ao]?/gi,'41'],[/cuarenta\s+y\s+cinco/gi,'45'],[/cuarenta\s+y\s+seis/gi,'46'],
        [/cuarenta\s+y\s+siete/gi,'47'],[/cuarenta\s+y\s+ocho/gi,'48'],[/cuarenta\s+y\s+nueve/gi,'49'],
        [/cincuenta\s+y\s+un[ao]?/gi,'51'],[/cincuenta\s+y\s+cinco/gi,'55'],[/cincuenta\s+y\s+seis/gi,'56'],
        [/veinte\s+y\s+un[ao]?/gi,'21'],[/veinte\s+y\s+dos/gi,'22'],[/veinte\s+y\s+tres/gi,'23'],
        [/veinte\s+y\s+cuatro/gi,'24'],[/veinte\s+y\s+cinco/gi,'25'],[/veinte\s+y\s+seis/gi,'26'],
        [/veinte\s+y\s+siete/gi,'27'],[/veinte\s+y\s+ocho/gi,'28'],[/veinte\s+y\s+nueve/gi,'29'],
        // FR
        [/vingt\s+et\s+un/gi,'21'],[/vingt-cinq/gi,'25'],[/trente\s+et\s+un/gi,'31'],[/quarante\s+et\s+un/gi,'41'],
        [/trente-cinq/gi,'35'],[/quarante-cinq/gi,'45'],[/cinquante-cinq/gi,'55'],
        // IT
        [/ventuno/gi,'21'],[/venticinque/gi,'25'],[/trentacinque/gi,'35'],[/quarantacinque/gi,'45'],[/cinquantacinque/gi,'55'],
        // PT
        [/vinte\s+e\s+um[a]?/gi,'21'],[/vinte\s+e\s+cinco/gi,'25'],[/trinta\s+e\s+cinco/gi,'35'],[/quarenta\s+e\s+cinco/gi,'45'],[/cinquenta\s+e\s+cinco/gi,'55'],
        // DE
        [/einundzwanzig/gi,'21'],[/fünfundzwanzig/gi,'25'],[/fünfunddreißig/gi,'35'],[/fünfundvierzig/gi,'45'],[/fünfundfünfzig/gi,'55'],
        // RU compound
        [/двадцать\s+один/gi,'21'],[/двадцать\s+два/gi,'22'],[/двадцать\s+три/gi,'23'],
        [/двадцать\s+пять/gi,'25'],[/тридцать\s+пять/gi,'35'],[/сорок\s+пять/gi,'45'],[/пятьдесят\s+пять/gi,'55'],
        // UK compound
        [/двадцять\s+один/gi,'21'],[/двадцять\s+дві/gi,'22'],[/тридцять\s+п'ять/gi,'35'],
        [/двадцять\s+п'ять/gi,'25'],[/сорок\s+п'ять/gi,'45'],[/п'ятдесят\s+п'ять/gi,'55'],
        // EN compound
        [/twenty-five/gi,'25'],[/thirty-five/gi,'35'],[/forty-five/gi,'45'],[/fifty-five/gi,'55'],
        [/twenty\s+five/gi,'25'],[/thirty\s+five/gi,'35'],[/forty\s+five/gi,'45'],[/fifty\s+five/gi,'55'],
        // PL compound
        [/dwadzieścia\s+pięć/gi,'25'],[/trzydzieści\s+pięć/gi,'35'],[/czterdzieści\s+pięć/gi,'45'],[/pięćdziesiąt\s+pięć/gi,'55'],
      ];
      for (const [re, val] of compounds) s = s.replace(re, val);
 
      // Single word numbers per language (NO shared map — avoids key collision)
      const singles = [
        // RU
        [/(?:^|\s)один(?=\s|$)/gi,'1'],[/(?:^|\s)одна(?=\s|$)/gi,'1'],[/(?:^|\s)два(?=\s|$)/gi,'2'],
        [/(?:^|\s)две(?=\s|$)/gi,'2'],[/(?:^|\s)три(?=\s|$)/gi,'3'],[/(?:^|\s)четыре(?=\s|$)/gi,'4'],
        [/(?:^|\s)пять(?=\s|$)/gi,'5'],[/(?:^|\s)шесть(?=\s|$)/gi,'6'],[/(?:^|\s)семь(?=\s|$)/gi,'7'],
        [/(?:^|\s)восемь(?=\s|$)/gi,'8'],[/(?:^|\s)девять(?=\s|$)/gi,'9'],[/(?:^|\s)десять(?=\s|$)/gi,'10'],
        [/(?:^|\s)одиннадцать(?=\s|$)/gi,'11'],[/(?:^|\s)двенадцать(?=\s|$)/gi,'12'],
        [/(?:^|\s)пятнадцать(?=\s|$)/gi,'15'],[/(?:^|\s)двадцать(?=\s|$)/gi,'20'],
        [/(?:^|\s)тридцать(?=\s|$)/gi,'30'],[/(?:^|\s)сорок(?=\s|$)/gi,'40'],[/(?:^|\s)пятьдесят(?=\s|$)/gi,'50'],
        // UK
        [/(?:^|\s)один(?=\s|$)/gi,'1'],[/(?:^|\s)одна(?=\s|$)/gi,'1'],[/(?:^|\s)два(?=\s|$)/gi,'2'],
        [/(?:^|\s)дві(?=\s|$)/gi,'2'],[/(?:^|\s)три(?=\s|$)/gi,'3'],[/(?:^|\s)чотири(?=\s|$)/gi,'4'],
        [/(?:^|\s)п'ять(?=\s|$)/gi,'5'],[/(?:^|\s)шість(?=\s|$)/gi,'6'],[/(?:^|\s)сім(?=\s|$)/gi,'7'],
        [/(?:^|\s)вісім(?=\s|$)/gi,'8'],[/(?:^|\s)дев'ять(?=\s|$)/gi,'9'],[/(?:^|\s)десять(?=\s|$)/gi,'10'],
        [/(?:^|\s)одинадцять(?=\s|$)/gi,'11'],[/(?:^|\s)дванадцять(?=\s|$)/gi,'12'],
        [/(?:^|\s)п'ятнадцять(?=\s|$)/gi,'15'],[/(?:^|\s)двадцять(?=\s|$)/gi,'20'],
        [/(?:^|\s)тридцять(?=\s|$)/gi,'30'],[/(?:^|\s)сорок(?=\s|$)/gi,'40'],
        // EN
        [/\bone\b/gi,'1'],[/\btwo\b/gi,'2'],[/\bthree\b/gi,'3'],[/\bfive\b/gi,'5'],
        [/\bsix\b/gi,'6'],[/\bseven\b/gi,'7'],[/\beight\b/gi,'8'],[/\bnine\b/gi,'9'],[/\bten\b/gi,'10'],
        [/\beleven\b/gi,'11'],[/\btwelve\b/gi,'12'],[/\bfifteen\b/gi,'15'],
        [/\btwenty\b/gi,'20'],[/\bthirty\b/gi,'30'],[/\bforty\b/gi,'40'],[/\bfifty\b/gi,'50'],
        // DE
        [/\bein\b/gi,'1'],[/\beine\b/gi,'1'],[/\beiner\b/gi,'1'],[/\bzwei\b/gi,'2'],[/\bdrei\b/gi,'3'],
        [/\bvier\b/gi,'4'],[/\bfünf\b/gi,'5'],[/\bsechs\b/gi,'6'],[/\bsieben\b/gi,'7'],
        [/\bacht\b/gi,'8'],[/\bneun\b/gi,'9'],[/\bzehn\b/gi,'10'],
        [/\belf\b/gi,'11'],[/\bzwölf\b/gi,'12'],[/\bfünfzehn\b/gi,'15'],
        [/\bzwanzig\b/gi,'20'],[/\bdreißig\b/gi,'30'],[/\bvierzig\b/gi,'40'],[/\bfünfzig\b/gi,'50'],
        // FR
        [/\bun\b/gi,'1'],[/\bune\b/gi,'1'],[/\bdeux\b/gi,'2'],[/\btrois\b/gi,'3'],
        [/\bquatre\b/gi,'4'],[/\bcinq\b/gi,'5'],[/\bsix\b/gi,'6'],[/\bsept\b/gi,'7'],
        [/\bhuit\b/gi,'8'],[/\bneuf\b/gi,'9'],[/\bdix\b/gi,'10'],
        [/\bonze\b/gi,'11'],[/\bdouze\b/gi,'12'],[/\bquinze\b/gi,'15'],
        [/\bvingt\b/gi,'20'],[/\btrente\b/gi,'30'],[/\bquarante\b/gi,'40'],[/\bcinguante\b/gi,'50'],
        // ES
        [/\buno\b/gi,'1'],[/\buna\b/gi,'1'],[/\bdos\b/gi,'2'],[/\btres\b/gi,'3'],
        [/\bcuatro\b/gi,'4'],[/\bcinco\b/gi,'5'],[/\bseis\b/gi,'6'],[/\bsiete\b/gi,'7'],
        [/\bocho\b/gi,'8'],[/\bnueve\b/gi,'9'],[/\bdiez\b/gi,'10'],
        [/\bonce\b/gi,'11'],[/\bdoce\b/gi,'12'],[/\btrece\b/gi,'13'],[/\bcatorce\b/gi,'14'],
        [/\bquince\b/gi,'15'],[/\bdiecis[eé]is\b/gi,'16'],[/\bdiecisiete\b/gi,'17'],
        [/\bdieciocho\b/gi,'18'],[/\bdiecinueve\b/gi,'19'],
        [/\bveinte\b/gi,'20'],[/\btreinta\b/gi,'30'],[/\bcuarenta\b/gi,'40'],
        [/\bcincuenta\b/gi,'50'],[/\bsesenta\b/gi,'60'],
        // PL
        [/\bjeden\b/gi,'1'],[/\bjedna\b/gi,'1'],[/\bjedno\b/gi,'1'],[/\bdwa\b/gi,'2'],[/\bdwie\b/gi,'2'],
        [/\btrzy\b/gi,'3'],[/\bcztery\b/gi,'4'],[/\bpięć\b/gi,'5'],[/\bsześć\b/gi,'6'],
        [/\bsiedem\b/gi,'7'],[/\bosiem\b/gi,'8'],[/\bdziewięć\b/gi,'9'],[/\bdziesięć\b/gi,'10'],
        [/\bpiętnaście\b/gi,'15'],[/\bdwadzieścia\b/gi,'20'],[/\btrzydzieści\b/gi,'30'],
        // IT
        [/\buno\b/gi,'1'],[/\buna\b/gi,'1'],[/\bdue\b/gi,'2'],[/\btre\b/gi,'3'],
        [/\bquattro\b/gi,'4'],[/\bcinque\b/gi,'5'],[/\bsei\b/gi,'6'],[/\bsette\b/gi,'7'],
        [/\botto\b/gi,'8'],[/\bnove\b/gi,'9'],[/\bdieci\b/gi,'10'],
        [/\bundici\b/gi,'11'],[/\bdodici\b/gi,'12'],[/\bquindici\b/gi,'15'],
        [/\bventi\b/gi,'20'],[/\btrenta\b/gi,'30'],[/\bquaranta\b/gi,'40'],[/\bcinguanta\b/gi,'50'],
        // PT
        [/\bum\b/gi,'1'],[/\buma\b/gi,'1'],[/\bdois\b/gi,'2'],[/\bduas\b/gi,'2'],
        [/\btrês\b/gi,'3'],[/\bquatro\b/gi,'4'],[/\bcinco\b/gi,'5'],[/\bseis\b/gi,'6'],
        [/\bsete\b/gi,'7'],[/\boito\b/gi,'8'],[/\bnove\b/gi,'9'],[/\bdez\b/gi,'10'],
        [/\bonze\b/gi,'11'],[/\bdoze\b/gi,'12'],[/\bquinze\b/gi,'15'],
        [/\bvinte\b/gi,'20'],[/\btrinta\b/gi,'30'],[/\bquarenta\b/gi,'40'],[/\bcinguenta\b/gi,'50'],
      ];
      for (const [re, val] of singles) s = s.replace(re, (m) => m.replace(/\S+/i, val));
      return s;
    }
    const normInputGlobal = normalizeWordNums(input);
 
    // ── Trigger words ──────────────────────────────────────────────────────────────
    const TRIGGERS = [
      // Wake words
      'ok(?:ay)?\\s+google','hey\\s+google','ok\\s+гугл','окей\\s+гугл',
      'hey\\s+siri','ehi\\s+siri','dis\\s+siri','ей\\s+сір[иі]','эй\\s+сір[иі]',
      // RU
      'поставь\\s+пожалуйста','поставь\\s+напоминание','создай\\s+напоминание','добавь\\s+напоминание','поставь\\s+будильник',
      'напомни\\s+пожалуйста','напомни\\s+мне','напомню(?=\\s|$)','напомни(?=\\s|$)','напоминание','поставь',
      // UK
      'постав\\s+будь\\s+ласка','постав\\s+нагадування','створи\\s+нагадування','додай\\s+нагадування','постав\\s+будильник',
      'нагадаю(?=\\s|$)','нагадай\\s+будь\\s+ласка','нагадай\\s+мені','нагадай(?=\\s|$)','нагадування','постав(?=\\s|$)',
      // EN
      'set\\s+a\\s+reminder\\s+for','set\\s+a\\s+reminder','set\\s+reminder','create\\s+reminder','add\\s+reminder','set\\s+alarm',
      'remind\\s+me\\s+to','please\\s+remind\\s+me','remind\\s+me','remind(?=\\s|$)','remember',
      'alert\\s+me\\s+to','alert\\s+me',
      // DE
      'bitte\\s+erinnere\\s+mich','erinnere\\s+mich','erinner\\s+mich',
      'erinnerung\\s+setzen','erinnerung\\s+hinzuf[uü]gen','wecker\\s+stellen','erinnere',
      // FR
      'mets\\s+un\\s+rappel','ajoute\\s+un\\s+rappel','cr[eé][eé]\\s+un\\s+rappel',
      'rappelle-moi\\s+de','rappelle-moi','rappelle\\s+moi','rappelle',
      // ES
      'ponme\\s+un\\s+recordatorio','agrega\\s+un\\s+recordatorio','crea\\s+un\\s+recordatorio',
      'recu[eé]rdame\\s+que','recu[eé]rdame','recordarme\\s+que','recordarme','acu[eé]rdame\\s+que','acu[eé]rdame',
      // PL
      'ustaw\\s+przypomnienie','dodaj\\s+przypomnienie','utw[oó]rz\\s+przypomnienie',
      'przypomnij\\s+mi\\s+[żz]eby','przypomnij\\s+mi','przypomnij',
      // IT
      'imposta\\s+un\\s+promemoria','aggiungi\\s+promemoria','crea\\s+promemoria',
      'ricordami\\s+che','ricordami\\s+di','ricordami\\s+tra','ricordami','ricorda(?=\\s|$)',
      // PT
      'me\\s+lembr(?:ar?|e)\\s+de','me\\s+lembr(?:ar?|e)\\s+que','me\\s+lembr(?:ar?|e)',
      'lembr(?:ar?|e)-me\\s+de','lembr(?:ar?|e)-me\\s+que','lembr(?:ar?|e)-me',
      'define\\s+um\\s+lembrete','adicione\\s+um\\s+lembrete','criar\\s+lembrete','lembra(?=\\s|$)',
    ];
    const LEFTOVER_RE = /^(мне|мені|me|mich|mi|moi|por\s+favor|pls|please|bitte|s'il\s+te\s+pla[iî]t|per\s+favore|proszę|будь\s+ласка|пожалуйста)\s+/i;
 
    function removeTriggerWords(t) {
      for (const tr of TRIGGERS) {
        t = t.replace(new RegExp('^' + tr + '\\s*', 'i'), '');
        t = t.replace(new RegExp('\\s+' + tr + '(\\s|$)', 'gi'), ' ');
      }
      return t.replace(LEFTOVER_RE, '').replace(/\s+/g, ' ').trim();
    }
 
    // ── AM/PM detection (single source of truth) ───────────────────────────────
    // Returns: 'am' | 'pm' | null
    function detectPeriod(s) {
      const norm = s.toLowerCase();
      // AM words
      if (/(ранку|вранці|зранку|до\s+обіду|утра|утром|с\s+утра|до\s+обеда|ночи|ночі|вночі|уночі|ночью|w\s+nocy|noc[ąa]|\bdi\s+notte\b|\bnotte\b|\bmorning\b|in\s+the\s+morning|\bam\b|a\.m\.|morgens|fr[uü]h|vormittags|du\s+matin|le\s+matin|de\s+la\s+ma[nñ]ana|por\s+la\s+ma[nñ]ana|\bdi\s+mattina\b|\bmattina\b|da\s+manh[ãa]|de\s+manh[ãa]|\brano\b|z\s+rana|przed\s+po[łl]udniem|madrugada)/i.test(norm)) return 'am';
      // PM words
      if (/(вечора|вечера|увечері|ввечері|дня|після\s+обіду|вечером|после\s+обеда|\bevening\b|in\s+the\s+evening|\bpm\b|p\.m\.|\bafternoon\b|in\s+the\s+afternoon|\babends\b|\bnachts\b|du\s+soir|le\s+soir|de\s+nuit|la\s+nuit|de\s+la\s+(?:tarde|noche)|por\s+la\s+(?:tarde|noche)|\bdi\s+sera\b|\bsera\b|da\s+(?:tarde|noite)|wieczore?m?)/i.test(norm)) return 'pm';
      return null;
    }
 
    function applyPeriod(h, period) {
      if (period === 'pm' && h < 12) return h + 12;
      if (period === 'am' && h === 12) return 0;
      return h;
    }
 
    // ── Task text cleaner ──────────────────────────────────────────────────────
    function cleanTaskText(t) {
      t = t
        // FR d'
        .replace(/^d['\u2019\u0060\u00B4]\s*/i, '')
        // Leading connectors
        .replace(/^(que|że|żeby|żebym|di|de|da|del)\s+/i, '')
        // Leading prepositions
        .replace(/^(на|в|о|у|um|to|for|le|la|el|na|po|at)\s+/i, '')
        // ES: el día / el lunes / la semana
        .replace(/^el\s+d[ií]a\s+/i, '').replace(/^el\s+/i, '').replace(/^la\s+/i, '')
        // PL w/o double strip
        .replace(/^[wo]\s+/i, '').replace(/^(о|o|na|at|h)\s+/i, '').replace(/^[wo]\s+/i, '')
        // FR/PT à/às
        .replace(/^(à|às|ao?)\s+/i, '')
        // Period words — PL
        .replace(/\b(w\s+nocy|w\s+rano|w\s+południe)\b/gi, '')
        .replace(/\b(rano|wieczorem|nocy)\b/gi, '')
        // Period words — UK/RU
        .replace(/(^|\s)(ночі|вночі|ранку|вранці|зранку|вечора|увечері|ввечері|дня|ночи|утра|вечера)(\s|$)/gi, ' ')
        // Period words — DE
        .replace(/\b(Uhr|nachts|morgens|abends|nachmittags|vormittags)\b/gi, '')
        // Period words — IT
        .replace(/\b(di\s+mattina|di\s+sera|di\s+notte|del\s+pomeriggio|mattina|sera|notte|pomeriggio)\b/gi, '')
        // Period words — FR
        .replace(/\b(du\s+matin|du\s+soir|de\s+l['']apr[eè]s-midi|et\s+demie?|demi-heure)\b/gi, '')
        // Period words — ES
        .replace(/\b(de\s+la\s+(?:mañana|tarde|noche|madrugada)|por\s+la\s+(?:mañana|tarde|noche)|madrugada|mediod[ií]a|medianoche)\b/gi, '')
        // Period words — PT
        .replace(/\b(da\s+manhã|da\s+noite|da\s+tarde|da\s+madrugada|de\s+manhã|de\s+noite)\b/gi, '')
        .replace(/^(manhã|madrugada)\s+/i, '').replace(/\s+(manhã|madrugada)\s*$/i, '')
        // PT structure cleanup
        .replace(/^depois\s+de\s*/i, '')
        .replace(/^(às?|as|no|na)\s+/i, '').replace(/\s+(às?|as|no|na)\s*$/i, '')
        .replace(/^(no|na)\s+(da|de|do)\s+/i, '')
        .replace(/^(da|de|do)\s+(manhã|noite|tarde|madrugada)?\s*/i, '')
        .replace(/^(manhã|madrugada)\s+/i, '')
        // IT structure cleanup
        .replace(/^(dopo|pasado)\s+/i, '')
        .replace(/\be\s+mez(?:za|ia)\b/gi, '')
        .replace(/^alle?\s+/i, '').replace(/\s+alle?\s*$/i, '')
        // EN period words
        .replace(/\b(tonight|this\s+morning|this\s+evening|this\s+afternoon)\b/gi, '')
        // ES word-numbers that leak
        .replace(/\b(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta)\b/gi, '')
        // FR word-numbers
        .replace(/\b(un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|quinze|vingt|trente|quarante|cinquante)\b/gi, '')
        // DE word-numbers
        .replace(/\b(ein[e]?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|fünfzehn|zwanzig|dreißig)\b/gi, '')
        // ES leftovers
        .replace(/\by\s+media\b/gi, '')
        .replace(/\ba\s+las?\s+\d+\s+de\s+la\b/gi, '').replace(/\blas?\s+\d+\s+de\s+la\b/gi, '')
        .replace(/\ba\s+las?\s+\d+\b/gi, '').replace(/\blas?\s+\d+\b/gi, '')
        // ES precision words
        .replace(/\b(exactamente|en\s+punto)\b/gi, '')
        // EN precision
        .replace(/\b(exactly|sharp)\b/gi, '')
        // RU/UK precision
        .replace(/(ровно|рівно)(\s|$)/gi, ' ')
        // Trailing prepositions
        .replace(/\s+(в|на|о|у|at|on|to|for|um|à|às|al|alle|de|da|di|że)\s*$/i, '')
        .replace(/\s+(and|or)\s*$/i, '')
        // Trailing isolated PL
        .replace(/\s+[won]\s*$/gi, '').replace(/\s+(na|po|o|w)\s*$/gi, '')
        // 'the day after' EN
        .replace(/\bthe\s+day\s+after\b/gi, '')
        .replace(/\s+/g, ' ').trim();
 
      // Single preposition → empty
      if (/^(на|в|о|у|o|w|na|no|po|at|on|to|for|um|à|às|as|a|le|la|las|los|el|de|da|do|di|du|al|alle|del|des|den|der|das|manhã|madrugada|ночі|ранку|вечора|дня|ночи|утра|вечера)$/i.test(t)) return '';
      return t;
    }
 
    // ── Prefix interval reorder ────────────────────────────────────────────────
    // "через 2 часа напомни X" → "напомни X через 2 часа"
    {
      const re = /^((?:через|за)\s+\d+[.,]?\d*\s*\S+|через\s+(?:полчаса|полтора\s+часа?)|(?:in|after|dans|en|za|tra|fra|em)\s+\d+[.,]?\d*\s*\S+|(?:daqui\s+a|dentro\s+de)\s+\d+[.,]?\d*\s*\S+|in\s+half\s+an\s+hour|in\s+an?\s+hour|in\s+(?:one\s+and\s+a\s+half|\d+\.5)\s+hours?)\s+((?:напомни|нагадай|поставь|постав|remind(?:\s+me)?|set\s+a\s+reminder|erinnere(?:\s+mich)?|rappelle(?:-moi)?|recu[eé]rdame|przypomnij(?:\s+mi)?|ricordami|lembra(?:-me)?|me\s+lembre)(?:\s|$).*)/i;
      const m = input.match(re);
      if (m) {
        input = (m[2].trimEnd() + ' ' + m[1]).replace(/\s+/g, ' ').trim();
        if (DEBUG) console.log(`[REORDER] "${text}" → "${input}"`);
      }
    }
 
    // ════════════════════════════════════════════════════════════════════════════
    // AI-ONLY MODE: all parsing delegated to OpenAI (no deterministic PRE blocks)
    // ════════════════════════════════════════════════════════════════════════════

    const hasAbsoluteDate = (
      /(?<![:\d])\d{1,2}\.(?:0?[1-9]|1[0-2])(?:\.\d{2,4})?(?!\d)/.test(normInputGlobal) ||
      (
        /\d{1,2}(?:[-\.\u00b0\u00ba]|\u0433\u043e|\u043e\u0433\u043e|th|st|nd|rd)?\s+(?:de\s+|of\s+|du\s+|del\s+|di\s+)?[\u0430-\u044f\u0451\u0410-\u042f\u0401\u0456\u0406\u0457\u0407a-zA-Z\u00C0-\u024F]{3,12}/u.test(normInputGlobal) &&
        /\d{1,2}(?:[-\.\u00b0\u00ba]|\u0433\u043e|\u043e\u0433\u043e|th|st|nd|rd)?\s+(?:de\s+|of\s+|du\s+|del\s+|di\s+)?(?:\u044f\u043d\u0432|\u0444\u0435\u0432|\u043c\u0430\u0440|\u0430\u043f\u0440|\u043c\u0430\u0439|\u043c\u0430\u044f|\u0438\u044e\u043d|\u0438\u044e\u043b|\u0430\u0432\u0433|\u0441\u0435\u043d|\u043e\u043a\u0442|\u043d\u043e\u044f|\u0434\u0435\u043a|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|januar|februar|m\u00e4rz|april|mai|juni|juli|august|september|oktober|november|dezember|janvier|f\u00e9vrier|mars|avril|juin|juillet|ao\u00fbt|octobre|d\u00e9cembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|novembre|dicembre|stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrze\u015bnia|pa\u017adziernika|listopada|grudnia|janeiro|fevereiro|mar\u00e7o|junho|julho|setembro|outubro|novembro|dezembro)/iu.test(normInputGlobal)
      )
    );

 
    // ════════════════════════════════════════════════════════════════════════════
    // Quick pre-check: no time signal → skip AI, show picker
    // ════════════════════════════════════════════════════════════════════════════
    const hasAnyTimeSignal = (
      /\d/.test(normInputGlobal) ||
      // RU/UK
      /(завтра|послезавтра|сегодня|вчера|сьогодні|вчора|через|утра|вечера|ночи|дня|ранку|вечора|ночі|годин|хвилин|понеділ|вівтор|серед|четвер|п.ятниц|субот|неділ|понедельник|вторник|среду|четверг|пятниц|суббот|воскресен)/i.test(normInputGlobal) ||
      // EN
      /\b(tomorrow|today|morning|evening|night|afternoon|noon|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|in\s+\d|after\s+\d|at\s+\d|next\s+week|half\s+an\s+hour)\b/i.test(normInputGlobal) ||
      // DE
      /\b(morgen|heute|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|abends|morgens|nachts|halb|uhr)\b/i.test(normInputGlobal) ||
      // FR
      /\b(demain|aujourd'hui|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|matin|soir|midi|minuit|moins)\b/i.test(normInputGlobal) ||
      // ES
      /\b(mañana|hoy|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|tarde|noche|mediodía|medianoche|dieciocho|diecisiete|dieciséis|dieciseis|diecinueve|quince|veinte|treinta|cuarenta|cincuenta|sesenta)\b/i.test(normInputGlobal) ||
      // PL
      /\b(jutro|dzisiaj|poniedziałek|wtorek|środa|czwartek|piątek|sobota|niedziela|rano|wieczor|południe|północ|za\s+\d|pół\s+godziny)\b/i.test(normInputGlobal) ||
      // IT
      /\b(domani|oggi|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|mattina|sera|mezzanotte|mezzogiorno|meno)\b/i.test(normInputGlobal) ||
      // PT
      /(amanhã|amanha|manh[aã]|hoje|ontem|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|tarde|noite|meia-noite|meio-dia)/i.test(normInputGlobal) ||
      // Time unit words (for word-based intervals)
      /\b(minutos?|horas?|minutes?|heures?|Minuten?|Stunden?|minutę|godzin|minuti|ore\b|хвилин|хвил\b)\b/i.test(normInputGlobal) ||
      // AM/PM
      /\b(am|pm)\b|[ap]\.m\./i.test(normInputGlobal)
    );
 
    if (!hasAnyTimeSignal) {
      const taskText = cleanTaskText(removeTriggerWords(normInputGlobal));
      if (DEBUG) console.log(`[SKIP-AI] No time signal in: "${input}" → task: "${taskText}"`);
      return res.json({ ok: true, text: taskText || input, datetime: '', source: 'unparsed' });
    }
 
    // ════════════════════════════════════════════════════════════════════════════
    // AI fallback
    // ════════════════════════════════════════════════════════════════════════════
 
    // Moderation check
    let flagged = false;
    try {
      const medical = (
        // RU
        /таблетк|лекарств|витамин|укол|доз[аеуи]|препарат|антибиотик|болеутоляющ|обезболивающ|аспирин|парацетамол|ибупрофен|рецепт|врач|больниц|аптек|капл[иею]|сироп|мазь|прививк|вакцин|процедур/i.test(normInputGlobal) ||
        // UK
        /ліки|таблетк|вітамін|лікар|лікарн|аптек|крапл|сироп|мазь|щеплен|вакцин|препарат/i.test(normInputGlobal) ||
        // EN
        /\b(tablet|pill|medicine|medication|vitamin|prescription|pharmacy|doctor|hospital|drug|capsule|injection|vaccine|dose|antibiotic|painkiller|aspirin|ibuprofen|paracetamol)s?\b/i.test(normInputGlobal) ||
        // DE
        /\b(tablette|pille|medikament|vitamin|arzt|ärztin|apotheke|krankenhaus|spritze|impfung|antibiotikum|kapsel|rezept|dosis)n?\b/i.test(normInputGlobal) ||
        // FR
        /\b(comprimé|médicament|vitamine|médecin|pharmacie|hôpital|pilule|injection|vaccin|antibiotique|capsule|ordonnance|dose)s?\b/i.test(normInputGlobal) ||
        // ES
        /\b(pastilla|medicamento|vitamina|médico|farmacia|hospital|píldora|inyección|vacuna|antibiótico|cápsula|receta|dosis)s?\b/i.test(normInputGlobal) ||
        // IT
        /\b(pillola|medicina|vitamina|medico|farmacia|ospedale|compressa|iniezione|vaccino|antibiotico|capsula|ricetta|dose)\b/i.test(normInputGlobal) ||
        // PL
        /\b(tabletka|lekarstwo|witamina|lekarz|apteka|szpital|zastrzyk|szczepionka|antybiotyk|kapsułka|recepta|dawka)\b/i.test(normInputGlobal) ||
        // PT
        /\b(comprimido|medicamento|vitamina|médico|farmácia|hospital|injeção|vacina|antibiótico|cápsula|receita|dose)s?\b/i.test(normInputGlobal)
      );
      if (!medical) {
        const modRes = await client.moderations.create({ input });
        const cats = modRes.results[0]?.categories || {};
        if (modRes.results[0]?.flagged && !cats['medical']) {
          const catList = Object.entries(cats).filter(([,v])=>v).map(([k])=>k).join(', ');
          if (catList) {
            console.warn(`[MODERATION] Flagged: "${input}" — categories: ${catList}`);
            flagged = true;
          } else {
            if (DEBUG) console.log(`[MODERATION] False positive skipped for: "${input}"`);
          }
        }
      }
    } catch(modErr) { console.warn("[MODERATION] skipped:", modErr.message); }
 
    if (flagged) return res.json({ ok: false, error: 'flagged' });
 
    // AI call
    let result = null;
    try {
      const systemPrompt = buildPrompt(nowIso, offStr(offsetMinutes), localNow, offsetMinutes, lang);
      const aiRes = await client.chat.completions.create({
        model: 'gpt-4.1-nano',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: `Locale: ${locale || 'unknown'}\nVoice input: "${input}"` },
        ],
        max_tokens: 120,
      });
      const raw = aiRes.choices[0]?.message?.content || '{}';
      if (DEBUG) console.log(`[AI RAW] "${input}" → ${raw}`);
      result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch(err) {
      console.warn("[AI] error:", err.message);
      return res.json({ ok: true, text: input, datetime: '', source: 'error' });
    }
 
    if (!result || result.ok === false) {
      if (DEBUG) console.log(`[FAIL] "${input}"`);
      return res.json({ ok: false, error: 'unparseable' });
    }
 
    // Handle no-time result
    if (result.text !== undefined && result.datetime === '') {
      if (DEBUG) console.log(`[NO TIME] "${input}" → task: "${result.text}"`);
      const taskText = cleanTaskText(removeTriggerWords(result.text || input));
      return res.json({ ok: true, text: taskText, datetime: '', source: 'unparsed' });
    }
 
    if (!result.datetime) return res.json({ ok: true, text: cleanTaskText(removeTriggerWords(result.text || input)), datetime: '', source: 'unparsed' });
 
    // Validate AI result has actual time reference
    const hasTimeRefTrigger = (
      /\d{1,2}[:\-\.]\d{2}|\d{1,2}h\d{2}|\b\d{1,2}\s*Uhr\b|\bat\s+\d|\balle\s+\d|\ba\s+las\s+\d|\bum\s+\d|(?:^|\s)à\s+\d|(?:^|\s)às\s+\d|\bam\b|\bpm\b|[ap]\.m\./i.test(normInputGlobal) ||
      /вечора|вечера|ночи|ночі|утра|ранку|вранці|зранку|дня|дні|після\s+обіду|годин[иіу]?/i.test(normInputGlobal) ||
      /morning|evening|night|afternoon|abends|nachts|morgens|soir|matin|noche|tarde|manhã|noite|rano|wieczor/i.test(normInputGlobal) ||
      /(завтра|послезавтра|сегодня|сьогодні|tomorrow|today|morgen|heute|demain|aujourd'hui|mañana|hoy|jutro|domani|amanhã)/i.test(normInputGlobal) ||
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i.test(normInputGlobal) ||
      /\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i.test(normInputGlobal) ||
      /\b(lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica)\b/i.test(normInputGlobal) ||
      /\b(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b/i.test(normInputGlobal) ||
      /\b(poniedziałek|wtorek|środa|czwartek|piątek|sobota|niedziela)\b/i.test(normInputGlobal) ||
      /\b(segunda|terça|quarta|quinta|sexta|sábado|domingo)\b/i.test(normInputGlobal) ||
      /(понедельник|вторник|среду|четверг|пятниц|суббот|воскресен|понеділ|вівтор|серед|четвер|п.ятниц|субот|неділ)/i.test(normInputGlobal) ||
      /\b(eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+Uhr\b/i.test(normInputGlobal) ||
      // relative time word without digit: "через минуту", "in a minute", etc (all 9 langs)
      /(через|за)\s+\w+\s*(?:минут[аыу]?|хвилин[уиі]?|хв\.|мин\.)/i.test(normInputGlobal) ||
      /(через|за)\s*(?:минут[аыу]?|хвилин[уиі]?)/i.test(normInputGlobal) ||
      /\b(in|within)\s+\w+\s*minutes?\b/i.test(normInputGlobal) ||
      /\bin\s+\w+\s*Minuten?\b/i.test(normInputGlobal) ||
      /\bdans\s+\w+\s*minutes?\b/i.test(normInputGlobal) ||
      /\ben\s+\w+\s*minutos?\b/i.test(normInputGlobal) ||
      /\btra\s+(?:\w+\s+)?minut[oi]?\b/i.test(normInputGlobal) ||
      /\bem\s+\w+\s*minutos?\b/i.test(normInputGlobal) ||
      /\bza\s+(?:\w+\s+)?minut[ęey]?/i.test(normInputGlobal)
    );
 
    if (!hasTimeRefTrigger && result.datetime) {
      if (DEBUG) console.log(`[NO TIME] No time in input, AI invented time → returning empty datetime for: "${input}"`);
      const taskText = cleanTaskText(removeTriggerWords(result.text || input));
      return res.json({ ok: true, text: taskText, datetime: '', source: 'unparsed' });
    }
 
    // Post-process AI datetime: fix today/tomorrow logic
    try {
      const dtMatch = result.datetime?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
      if (dtMatch) {
        const rH = parseInt(dtMatch[2]), rMin = parseInt(dtMatch[3]);
        const nowH = localNow.getHours(), nowMin = localNow.getMinutes();
        const resultDateOnly = new Date(dtMatch[1] + 'T12:00:00');
        const nowDateOnly    = new Date(`${nowIso.slice(0,10)}T12:00:00`);
        const diffDays = Math.round((resultDateOnly - nowDateOnly) / 86400000);
        const hasExplicitDateWord = /(завтра|послезавтра|tomorrow|day\s+after|morgen|demain|mañana|jutro|domani|amanhã|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/i.test(normInputGlobal) ||
          /(понедельник|вторник|среду|четверг|пятниц|суббот|воскресен|понеділ|вівтор|серед|четвер|п.ятниц|субот|неділ)/i.test(normInputGlobal) ||
          /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i.test(normInputGlobal) ||
          hasAbsoluteDate; // absolute date like "4 августа", "4.08", "4 agosto", etc.
 
        if (!hasExplicitDateWord) {
          if (diffDays === 0 && rH * 60 + rMin > nowH * 60 + nowMin) {
            if (DEBUG) console.log(`[FIX] ${p2(rH)}:${p2(rMin)} > ${p2(nowH)}:${p2(nowMin)}, no explicit tomorrow → today`);
          } else if (diffDays === 0 && rH * 60 + rMin <= nowH * 60 + nowMin) {
            const nYear = localNow.getFullYear(), nMonth = localNow.getMonth(), nDay = localNow.getDate();
            const tomorrowIso = `${String(nYear).padStart(4,'0')}-${p2(nMonth+1)}-${p2(nDay+1)}T${p2(rH)}:${p2(rMin)}:00${offStr(offsetMinutes)}`;
            if (DEBUG) console.log(`[FIX] ${p2(rH)}:${p2(rMin)} ≤ ${p2(nowH)}:${p2(nowMin)}, today but past → tomorrow`);
            result = { ...result, datetime: tomorrowIso };
          }
        } else {
          if (DEBUG) console.log(`[FIX] skipped — explicit date word detected in: "${input}"`);
        }
 
        // Fix past weekday
        if (hasExplicitDateWord && diffDays < 0) {
          const fixedDate = new Date(resultDateOnly);
          fixedDate.setDate(fixedDate.getDate() + 7);
          const fixedIso = `${fixedDate.toISOString().slice(0,10)}T${p2(rH)}:${p2(rMin)}:00${offStr(offsetMinutes)}`;
          if (DEBUG) console.log(`[FIX] Past weekday date ${result.datetime} → ${fixedIso}`);
          result = { ...result, datetime: fixedIso };
        }
 
        // Afternoon word fix
        try {
          const rHour = rH, rMin2 = rMin;
          const hasAfternoon = /\b(дня|після\s+обіду|после\s+обеда|nachmittags|de\s+la\s+tarde|du\s+soir|del\s+pomeriggio|da\s+tarde|po\s+południu|afternoon|pomeriggio)\b/i.test(normInputGlobal);
          if (hasAfternoon && rHour >= 12 && rHour < 18) {
            const correctedH = rHour < 12 ? rHour + 12 : rHour;
            if (correctedH !== rHour) {
              const correctedIso = result.datetime.replace(`T${p2(rHour)}:`, `T${p2(correctedH)}:`);
              if (DEBUG) console.log(`[AFTERNOON FIX] ${p2(rHour)}:${p2(rMin2)} → ${p2(correctedH)}:${p2(rMin2)}`);
              result = { ...result, datetime: correctedIso };
            }
          }
        } catch(e) { console.warn('[AFTERNOON FIX] error:', e.message); }
      }
    } catch(fixErr) { console.warn("[FIX] error:", fixErr.message); }
 
    // Clean AI result text
    if (result.text) {
      result = { ...result, text: cleanTaskText(removeTriggerWords(result.text)
        .replace(/\b(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)\b/gi,'')
        .replace(/^(на|в|о|у|on|am|le|el|a|o)\s+/i,'')
        .replace(/\s+(на|в|о|у)\s*$/i,''))
      };
    }
 
    if (DEBUG) console.log(`[OK] "${input}" → ${result.datetime} | task: "${result.text || ''}"`);
    return res.json({ ok: true, text: result.text || '', datetime: result.datetime || '', source: 'ai' });
 
  } catch(e) {
    console.error("ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
 
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SayDone parser v6 on port ${port}`));
