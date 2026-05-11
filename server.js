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
        // IT
        [/ventuno/gi,'21'],[/venticinque/gi,'25'],[/trentacinque/gi,'35'],[/quarantacinque/gi,'45'],
        // PT
        [/vinte\s+e\s+um[a]?/gi,'21'],[/vinte\s+e\s+cinco/gi,'25'],[/trinta\s+e\s+cinco/gi,'35'],[/quarenta\s+e\s+cinco/gi,'45'],
        // DE
        [/einundzwanzig/gi,'21'],[/fünfundzwanzig/gi,'25'],[/fünfunddreißig/gi,'35'],[/fünfundvierzig/gi,'45'],
        // RU compound
        [/двадцать\s+один/gi,'21'],[/двадцать\s+два/gi,'22'],[/двадцать\s+три/gi,'23'],
        [/двадцать\s+пять/gi,'25'],[/тридцать\s+пять/gi,'35'],[/сорок\s+пять/gi,'45'],
        // UK compound
        [/двадцять\s+один/gi,'21'],[/двадцять\s+дві/gi,'22'],[/тридцять\s+п'ять/gi,'35'],
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
      'recu[eé]rdame\\s+que','recu[eé]rdame',
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
    // PRE-PARSERS — deterministic, no AI needed
    // ════════════════════════════════════════════════════════════════════════════

    // ── PRE: Relative intervals HH+MM combined ──────────────────────────────────
    {
      const hmRe = /(?:in|dans|en|za|tra|fra|em|daqui\s+a|dentro\s+de|через|за)\s+(\d+)\s*(?:hours?|Stunden?|heures?|horas?|ora[e]?|ore\b|год[ину]+|годин[аиу]?|час[аов]?)\s*(?:and\s+|und\s+|et\s+|y\s+|e\s+|і\s+|та\s+|и\s+)?(\d+)\s*(?:min(?:ute)?s?|Minuten?|minutes?|minutos?|minut[oiа]?|хвилин[аиу]?|мин[утаы]*)/i;
      const hmMatch = normInputGlobal.match(hmRe);
      if (hmMatch) {
        const totalMins = parseInt(hmMatch[1]) * 60 + parseInt(hmMatch[2]);
        const d = new Date(localNow); d.setMinutes(d.getMinutes() + totalMins);
        const datetime = toIso(d, offsetMinutes);
        const taskText = cleanTaskText(removeTriggerWords(input));
        if (DEBUG) console.log(`[PRE-HM] "${input}" → ${datetime} (task: "${taskText}")`);
        return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
      }
    }

    // ── PRE: Relative intervals (minutes / hours) ───────────────────────────────
    {
      const relMatch =
        normInputGlobal.match(/(?:через|за)\s+(\d+(?:[.,]\d+)?)\s*(?:минут[аыу]?|минут\b|хвилин[аиу]?|хвилин\b|хв\.?|мин\.?)/i) ||
        normInputGlobal.match(/\b(?:in|after)\s+(\d+(?:[.,]\d+)?)\s*(?:min(?:ute)?s?)\b/i) ||
        normInputGlobal.match(/\bdans\s+(\d+(?:[.,]\d+)?)\s*(?:min(?:ute)?s?)\b/i) ||
        normInputGlobal.match(/\bin\s+(\d+(?:[.,]\d+)?)\s*(?:Minute[n]?)\b/i) ||
        normInputGlobal.match(/\ben\s+(\d+(?:[.,]\d+)?)\s*(?:min(?:uto)?s?)\b/i) ||
        normInputGlobal.match(/\bza\s+(\d+(?:[.,]\d+)?)\s*(?:minut[aey]?|min)\b/i) ||
        normInputGlobal.match(/\btra\s+(\d+(?:[.,]\d+)?)\s*(?:minut[oi]|min)\b/i) ||
        normInputGlobal.match(/\bfra\s+(\d+(?:[.,]\d+)?)\s*(?:minut[oi]|min)\b/i) ||
        normInputGlobal.match(/\bem\s+(\d+(?:[.,]\d+)?)\s*(?:minuto?s?)\b/i) ||
        normInputGlobal.match(/\bdentro\s+de\s+(\d+(?:[.,]\d+)?)\s*(?:minutos?|min)\b/i) ||
        normInputGlobal.match(/\bdaqui\s+a\s+(\d+(?:[.,]\d+)?)\s*(?:minutos?|min)\b/i) ||
        normInputGlobal.match(/\bpara\s+(\d+(?:[.,]\d+)?)\s*(?:minutos?|horas?)\b/i);

      const hourMatch =
        normInputGlobal.match(/(?:через|за)\s+(\d+(?:[.,]\d+)?)\s*(?:час[аов]?|час\b|годин[аиу]?|годин\b|год\.?)/i) ||
        normInputGlobal.match(/\b(?:in|after)\s+(\d+(?:[.,]\d+)?)\s*(?:hours?|h)\b/i) ||
        normInputGlobal.match(/\bin\s+(\d+(?:[.,]\d+)?)\s*(?:Stunden?)\b/i) ||
        normInputGlobal.match(/\bdans\s+(\d+(?:[.,]\d+)?)\s*(?:heures?|h)\b/i) ||
        normInputGlobal.match(/\ben\s+(\d+(?:[.,]\d+)?)\s*(?:horas?|h)\b/i) ||
        normInputGlobal.match(/\bza\s+(\d+(?:[.,]\d+)?)\s*(?:godzin[aey]?|godz)\b/i) ||
        normInputGlobal.match(/\btra\s+(\d+(?:[.,]\d+)?)\s*(?:ora[e]?|ore)\b/i) ||
        normInputGlobal.match(/\bfra\s+(\d+(?:[.,]\d+)?)\s*(?:ora[e]?|ore)\b/i) ||
        normInputGlobal.match(/\bem\s+(\d+(?:[.,]\d+)?)\s*(?:horas?)\b/i) ||
        normInputGlobal.match(/\bdentro\s+de\s+(\d+(?:[.,]\d+)?)\s*horas?\b/i) ||
        normInputGlobal.match(/\bdaqui\s+a\s+(\d+(?:[.,]\d+)?)\s*horas?\b/i);

      // Half / one-and-a-half / one hour
      const halfHourMatch = /через\s+полчаса|через\s+пів\s*год|через\s+півгодини|in\s+half\s+an\s+hour|dans\s+une?\s+demi[-\s]heure|dans\s+1\s+demi[-\s]heure|en\s+media\s+hora|za\s+p[oó][łl]\s+godziny|tra\s+mezz['''\u2019]ora|fra\s+mezz['''\u2019]ora|em\s+meia\s+hora|in\s+einer\s+halben?\s+Stunde/i.test(normInputGlobal);

      const oneAndHalfMatch = !halfHourMatch && (
        /через\s+полтора\s+час|через\s+півтор/i.test(normInputGlobal) ||
        /\bin\s+(?:one\s+and\s+a\s+half|1\.5)\s+hours?\b/i.test(normInputGlobal) ||
        /\bin\s+anderthalb\s+Stunden?\b/i.test(normInputGlobal) ||
        /\bdans\s+(?:une|1)\s+heure\s+et\s+demie\b/i.test(normInputGlobal) ||
        /\ben\s+una\s+hora\s+y\s+media\b/i.test(normInputGlobal) ||
        /\bza\s+p[oó][łl]torej\s+godziny\b/i.test(normInputGlobal) ||
        /\btra\s+un['''\u2019]ora\s+e\s+mezza\b/i.test(normInputGlobal) ||
        /\bem\s+uma\s+hora\s+e\s+meia\b/i.test(normInputGlobal)
      );

      const oneHourMatch = !halfHourMatch && !oneAndHalfMatch && (
        /через\s+(?:один\s+)?час(?!\S)|через\s+годину/i.test(normInputGlobal) ||
        /\bin\s+(?:one\s+)?hour\b/i.test(normInputGlobal) ||
        /\bin\s+einer\s+Stunde\b/i.test(normInputGlobal) ||
        /\bdans\s+(?:une|1)\s+heure\b/i.test(normInputGlobal) ||
        /\ben\s+(?:una?|1)\s+hora\b/i.test(normInputGlobal) ||
        /\bza\s+godzin[ęe]\b/i.test(normInputGlobal) ||
        /\btra\s+un['''\u2019]ora\b/i.test(normInputGlobal) ||
        /\bem\s+(?:uma|1)\s+hora\b/i.test(normInputGlobal)
      );

      let preResult = null;
      if (halfHourMatch) {
        const d = new Date(localNow); d.setMinutes(d.getMinutes() + 30);
        preResult = { minutes: 30, dt: d };
      } else if (oneAndHalfMatch) {
        const d = new Date(localNow); d.setMinutes(d.getMinutes() + 90);
        preResult = { minutes: 90, dt: d };
      } else if (oneHourMatch) {
        const d = new Date(localNow); d.setMinutes(d.getMinutes() + 60);
        preResult = { minutes: 60, dt: d };
      } else if (relMatch) {
        const n = parseFloat(relMatch[1].replace(',', '.'));
        const d = new Date(localNow); d.setMinutes(d.getMinutes() + Math.round(n));
        preResult = { minutes: Math.round(n), dt: d };
      } else if (hourMatch) {
        const n = parseFloat(hourMatch[1].replace(',', '.'));
        const d = new Date(localNow); d.setMinutes(d.getMinutes() + Math.round(n * 60));
        preResult = { minutes: Math.round(n * 60), dt: d };
      }

      if (preResult) {
        const datetime = toIso(preResult.dt, offsetMinutes);

        // Build clean taskText from original input
        let taskText = removeTriggerWords(input)
          .replace(/в\s+полдень|о\s+полудні|опівдні/gi,'').replace(/at\s+noon|noon\b/gi,'')
          .replace(/через\s+полчаса|через\s+пів\s*год\S*|через\s+півгодини/gi,'')
          .replace(/через\s+полтора\s+час\S*/gi,'').replace(/через\s+(?:один\s+)?час(?!\S)/gi,'')
          .replace(/через\s+годину/gi,'').replace(/in\s+half\s+an\s+hour/gi,'')
          .replace(/in\s+(?:one\s+and\s+a\s+half|1\.5)\s+hours?/gi,'').replace(/in\s+an?\s+hour/gi,'')
          .replace(/dans\s+(?:une?|1)\s+(?:heure|demi[-\s]heure|heure\s+et\s+demie)/gi,'')
          .replace(/en\s+(?:una?\s+hora(?:\s+y\s+media)?|media\s+hora)/gi,'')
          .replace(/in\s+(?:einer?\s+halben?\s+)?Stunde\b/gi,'').replace(/in\s+anderthalb\s+Stunden?/gi,'')
          .replace(/em\s+(?:meia\s+hora|uma?\s+hora(?:\s+e\s+meia)?)/gi,'')
          .replace(/tra\s+mezz['''\u2019]ora|tra\s+un['''\u2019]ora(?:\s+e\s+mezza)?/gi,'')
          .replace(/za\s+p[oó][łl](?:torej\s+godziny|\s+godziny)|za\s+godzin[ęe]/gi,'')
          // Numeric intervals
          .replace(/(?:через|за)\s+\d+[.,]?\d*\s*\S+/gi,'')
          .replace(/(?:in|after)\s+\d+[.,]?\d*\s*\S+/gi,'')
          .replace(/dans\s+\d+[.,]?\d*\s*\S+/gi,'').replace(/en\s+\d+[.,]?\d*\s*\S+/gi,'')
          .replace(/za\s+\d+[.,]?\d*\s*\S+/gi,'').replace(/tra\s+\d+[.,]?\d*\s*\S+/gi,'')
          .replace(/fra\s+\d+[.,]?\d*\s*\S+/gi,'').replace(/em\s+\d+[.,]?\d*\s*\S+/gi,'')
          .replace(/daqui\s+a\s+\d+[.,]?\d*\s*\S*/gi,'')
          // Word-based intervals
          .replace(/en\s+(?:un[ao]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|diec\S+|veinte(?:\s+y\s+\S+)?|treinta(?:\s+y\s+\S+)?|cuarenta(?:\s+y\s+\S+)?|cincuenta(?:\s+y\s+\S+)?)\s+(?:minutos?|horas?)/gi,'')
          .replace(/dans\s+(?:un[e]?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|quinze|vingt|trente)\s+(?:minutes?|heures?)/gi,'')
          .replace(/in\s+(?:eine[mr]?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|fünfzehn|zwanzig|dreißig)\s+(?:Minuten?|Stunden?)/gi,'')
          .replace(/za\s+(?:jedn[ąa]|dwie|dwa|trzy|cztery|pięć|sześć|siedem|osiem|dziewięć|dziesięć|piętnaście)\s+(?:minutę?|godziny?|godzin)/gi,'')
          .replace(/tra\s+(?:un[ao]?|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|quindici|venti|trenta)\s+(?:minuti|ore|ora)/gi,'')
          .replace(/em\s+(?:um[a]?|dois|duas|três|quatro|cinco|seis|sete|oito|nove|dez|quinze|vinte|trinta)\s+(?:minutos?|horas?)/gi,'')
          .replace(/\ben\s+y\s+(?:minutos?|horas?)\b/gi,'')
          // Precision words
          .replace(/\b(ровно|рівно|exactly|sharp|genau|exakt|exactement|pile|exactamente|en\s+punto|dokładnie|równo|esattamente|in\s+punto|exatamente|em\s+ponto)\b/gi,'')
          // Yesterday words
          .replace(/\b(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)\b/gi,'');
        taskText = cleanTaskText(taskText);
        if (DEBUG) console.log(`[PRE] "${input}" → ${datetime} (task: "${taskText}")`);
        return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
      }
    }

    // ── PRE-NOON: Noon / Midnight ───────────────────────────────────────────────
    {
      const noonRe  = /(в\s+полдень|о\s+полудні|опівдні|\bat\s+noon\b|\bnoon\b|\bzu\s+Mittag\b|\bMittag\b|\bà\s+midi\b|\bmidi\b|\bal\s+mediod[ií]a\b|\bmediod[ií]a\b|\ba\s+mezzogiorno\b|\bmezzogiorno\b|\bao?\s+meio-?dia\b|\bmeio-?dia\b|\bw\s+południe\b|\bpołudnie\b)/i;
      const midRe   = /(в\s+полночь|опівночі|о\s+полуночі|\bat\s+midnight\b|\bmidnight\b|\bzu\s+Mitternacht\b|\bMitternacht\b|\bà\s+minuit\b|\bminuit\b|\ba\s+medianoche\b|\bmedianoche\b|\ba\s+mezzanotte\b|\bmezzanotte\b|\bà\s+meia-?noite\b|\bmeia-?noite\b|\ba\s+media\s+noche\b|\bo\s+północy\b|\bpółnoc\b)/i;

      const isNoon     = noonRe.test(normInputGlobal);
      const isMidnight = !isNoon && midRe.test(normInputGlobal);

      if (isNoon || isMidnight) {
        const h  = isNoon ? 12 : 0;
        const hasTomorrow  = /(завтра|tomorrow|morgen|demain|ma[nñ]ana|jutro|domani|amanh[aã])/i.test(normInputGlobal);
        const hasDayAfter  = /(послезавтра|після\s*завтра|позавтра|day\s*after\s*tomorrow|übermorgen|après-demain|pasado\s*ma[nñ]ana|pojutrze|dopodomani|depois\s*de\s*amanh[aã])/i.test(normInputGlobal);
        const d = new Date(localNow);
        d.setHours(h, 0, 0, 0);
        if (hasDayAfter) d.setDate(d.getDate() + 2);
        else if (hasTomorrow) d.setDate(d.getDate() + 1);
        else if (d <= localNow) d.setDate(d.getDate() + 1);
        const datetime = toIso(d, offsetMinutes);
        const taskText = cleanTaskText(removeTriggerWords(normInputGlobal)
          .replace(noonRe,'').replace(midRe,'')
          .replace(/(завтра|послезавтра|tomorrow|morgen|demain|ma[nñ]ana|jutro|domani|amanh[aã])/gi,'')
          .replace(/(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)/gi,'')
          .replace(/(сьогодні|сегодня|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/gi,''));
        if (DEBUG) console.log(`[PRE-NOON] "${input}" → ${datetime} (task: "${taskText}")`);
        return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
      }
    }

    // ── PRE-DAYS: In N days ─────────────────────────────────────────────────────
    {
      const normInput = normInputGlobal;
      const daysMatch =
        normInput.match(/(?:через|за)\s+(\d+)\s*(?:день|дня|дней|дні|днів)/i) ||
        normInput.match(/\bin\s+(\d+)\s*days?\b/i) ||
        normInput.match(/\bin\s+(\d+)\s*Tagen?\b/i) ||
        normInput.match(/\bdans\s+(\d+)\s*jours?\b/i) ||
        normInput.match(/\ben\s+(\d+)\s*d[íi]as?\b/i) ||
        normInput.match(/\bza\s+(\d+)\s*dni\b/i) ||
        normInput.match(/\bza\s+(\d+)\s*dzie[nń]\b/i) ||
        normInput.match(/\btra\s+(\d+)\s*giorni\b/i) ||
        normInput.match(/\bfra\s+(\d+)\s*giorni\b/i) ||
        normInput.match(/\bem\s+(\d+)\s*dias?\b/i) ||
        normInput.match(/\bdaqui\s+a\s+(\d+)\s*dias?\b/i);

      const weeksMatch = !daysMatch && (
        normInput.match(/(?:через|за)\s+(\d+)\s*(?:тижн|недел)/i) ||
        normInput.match(/\bin\s+(\d+)\s*weeks?\b/i) ||
        normInput.match(/\bin\s+(\d+)\s*Wochen?\b/i) ||
        normInput.match(/\bdans\s+(\d+)\s*semaines?\b/i) ||
        normInput.match(/\ben\s+(\d+)\s*semanas?\b/i) ||
        normInput.match(/\bza\s+(\d+)\s*tygodni\b/i) ||
        normInput.match(/\btra\s+(\d+)\s*settimane\b/i) ||
        normInput.match(/\bfra\s+(\d+)\s*settimane\b/i) ||
        normInput.match(/\bem\s+(\d+)\s*semanas?\b/i) ||
        normInput.match(/\bdaqui\s+a\s+(\d+)\s*semanas?\b/i)
      );

      if (daysMatch || weeksMatch) {
        const m = daysMatch || weeksMatch;
        const n = parseInt(m[1]) * (weeksMatch ? 7 : 1);
        const targetDate = new Date(localNow);
        targetDate.setDate(localNow.getDate() + n);
        const dateStr = targetDate.toISOString().slice(0,10);

        // Check for time within same phrase
        const hasTime = !!(
          normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) ||
          normInputGlobal.match(/\b(\d{1,2})h(\d{2})\b/i) ||
          normInputGlobal.match(/\b(\d{1,2})\s*Uhr\b/i) ||
          normInputGlobal.match(/\bat\s+(\d{1,2})\s*(pm|am)\b/i) ||
          normInputGlobal.match(/\bat\s+(\d{1,2})\s*(?:a\.m\.|p\.m\.)(?=\s|$)/i) ||
          normInputGlobal.match(/\balle\s+(\d{1,2})\b/i) ||
          normInputGlobal.match(/(?:^|\s)à\s+(\d{1,2})\b/i) ||
          normInputGlobal.match(/(?:^|\s)às\s+(\d{1,2})\b/i) ||
          normInputGlobal.match(/\ba\s+las\s+(\d{1,2})\b/i) ||
          normInputGlobal.match(/(?:в|на)\s+(\d{1,2})\s+(?:годин[иу]?\s+)?(?:вечера|вечора|ночи|ночі|утра|ранку|дня)/i) ||
          normInputGlobal.match(/\b(\d{1,2})h\b(?!eure)/i) ||
          /\b(am|pm)\b|[ap]\.m\./i.test(normInputGlobal)
        );

        if (!hasTime) {
          const taskText = cleanTaskText(removeTriggerWords(input)
            .replace(/(завтра|послезавтра|сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/gi,'')
            .replace(/(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)/gi,'')
            .replace(/(?:через|за)\s+\d+\s*\S+/gi,'').replace(/\bin\s+\d+\s*\S+/gi,'')
            .replace(/\bdans\s+\d+\s*\S+/gi,'').replace(/\ben\s+\d+\s*\S+/gi,'')
            .replace(/\bza\s+\d+\s*\S+/gi,'').replace(/\btra\s+\d+\s*\S+/gi,'')
            .replace(/\bfra\s+\d+\s*\S+/gi,'').replace(/\bem\s+\d+\s*\S+/gi,'')
            .replace(/\bdaqui\s+a\s+\d+\s*\S*/gi,''));
          if (DEBUG) console.log(`[PRE-DAYS] "${input}" → task:"${taskText}" date:${dateStr} (no time → picker)`);
          return res.json({ ok: true, text: taskText, datetime: '', source: 'unparsed' });
        }

        // Has time — extract it
        const timeMatch =
          normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) ||
          normInputGlobal.match(/\b(\d{1,2})h(\d{2})\b/i) ||
          normInputGlobal.match(/\b(\d{1,2})\s*Uhr\b/i) ||
          normInputGlobal.match(/\bat\s+(\d{1,2})\s*(pm|am)\b/i) ||
          normInputGlobal.match(/\bat\s+(\d{1,2})\s*(?:a\.m\.|p\.m\.)(?=\s|$)/i) ||
          normInputGlobal.match(/(?:в|на)\s+(\d{1,2})\s+(?:годин[иу]?\s+)?(?:вечера|вечора|ночи|ночі|утра|ранку|дня)/i) ||
          normInputGlobal.match(/\balle\s+(\d{1,2})\b/i) ||
          normInputGlobal.match(/(?:^|\s)à\s+(\d{1,2})\b/i) ||
          normInputGlobal.match(/(?:^|\s)às\s+(\d{1,2})\b/i) ||
          normInputGlobal.match(/\ba\s+las\s+(\d{1,2})\b/i);

        if (timeMatch) {
          let h = parseInt(timeMatch[1]);
          const mins2 = timeMatch[2] && /^\d+$/.test(timeMatch[2]) ? parseInt(timeMatch[2]) : 0;
          const period = detectPeriod(normInputGlobal);
          const g2 = timeMatch[2]?.toLowerCase();
          if (g2 === 'pm' || period === 'pm') { if (h < 12) h += 12; }
          if (g2 === 'am' || period === 'am') { if (h === 12) h = 0; }
          const datetime = `${dateStr}T${p2(h)}:${p2(mins2)}:00${offStr(offsetMinutes)}`;
          const taskText = cleanTaskText(removeTriggerWords(input)
            .replace(/(?:через|за)\s+\d+\s*\S+/gi,'').replace(/\bin\s+\d+\s*\S+/gi,'')
            .replace(/\bdans\s+\d+\s*\S+/gi,'').replace(/\ben\s+\d+\s*\S+/gi,'')
            .replace(/\bza\s+\d+\s*\S+/gi,'').replace(/\btra\s+\d+\s*\S+/gi,'')
            .replace(/\bfra\s+\d+\s*\S+/gi,'').replace(/\bem\s+\d+\s*\S+/gi,'')
            .replace(/\bdaqui\s+a\s+\d+\s*\S*/gi,'')
            .replace(/\d{1,2}[:h]\d{2}/g,'').replace(/\d{1,2}\s*Uhr\b/gi,'')
            .replace(/(вечора|вечера|ранку|утра|ночи|ночі|дня)/gi,'')
            .replace(/\b(evening|morning|night|afternoon|pm|am|abends|morgens|soir|matin|noche|tarde|sera|mattina|manhã|noite|rano|wieczorem?)\b/gi,'')
            .replace(/[ap]\.m\./gi,''));
          if (DEBUG) console.log(`[PRE-DAYS] "${input}" → ${datetime} (task: "${taskText}")`);
          return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
        }
      }
    }

    // ── PRE-DOW-NOTIME: Weekday without time → picker ───────────────────────────
    {
      const dowSimple = [
        [0, /(sunday|dimanche|domingo|niedziela|niedziel[ęą]|domenica|воскресенье|неділ[юяі]?|sonntag)/i],
        [1, /(monday|lundi|lunes|poniedzia[łl]ek|lunedì|segunda-?feira|segunda\b|понедельник|понеділо?к|montag)/i],
        [2, /(tuesday|mardi|martes|wtorek|martedì|ter[çc]a-?feira|terça\b|вторник|вівторо?к|dienstag)/i],
        [3, /(wednesday|mercredi|miércoles|[sś]rod[ęa]|mercoledì|quarta-?feira|quarta\b|среду?|середу?|середа|mittwoch)/i],
        [4, /(thursday|jeudi|jueves|czwartek|giovedì|quinta-?feira|quinta\b|четверг|четвер|donnerstag)/i],
        [5, /(friday|vendredi|viernes|pi[aą]tek|venerdì|sexta-?feira|sexta\b|пятниц[ую]?|п['']ятниц[юя]|freitag)/i],
        [6, /(saturday|samedi|s[aá]bado|sobot[ęa]|sabato|суббот[ау]?|субот[ую]?|samstag)/i],
      ];
      const hasTimeRef = /\d{1,2}[:\-\.]\d{2}|\d{1,2}h\d{2}|\b\d{1,2}\s*Uhr\b|\bat\s+\d|\balle\s+\d|\ba\s+las\s+\d|\bum\s+\d|(?:^|\s)à\s+\d|(?:^|\s)às\s+\d|\bam\b|\bpm\b|[ap]\.m\.|вечора|вечера|ночи|ночі|утра|ранку|вранці|зранку|дня|дні|після\s+обіду|годин[иіу]?|morning|evening|night|afternoon|abends|nachts|morgens|soir|matin|noche|tarde|manhã|noite|rano|wieczor/i.test(normInputGlobal);

      if (!hasTimeRef) {
        let targetDow = -1;
        for (const [idx, re] of dowSimple) {
          if (re.test(input)) { targetDow = idx; break; }
        }
        if (targetDow >= 0) {
          let diff = targetDow - localNow.getDay();
          if (diff < 0) diff += 7;
          if (diff === 0) diff = 7;
          const d = new Date(localNow);
          d.setDate(localNow.getDate() + diff);
          const dateStr = d.toISOString().slice(0, 10);
          const taskText = cleanTaskText(removeTriggerWords(input)
            .replace(new RegExp(dowSimple.map(([,re]) => re.source).join('|'), 'gi'), '')
            .replace(/\b(следующ(?:ий|ую|его)|ближайш(?:ий|ую)|наступн(?:ий|ого|ій|у)|найближч(?:ий|у))\b/gi,'')
            .replace(/\b(next|upcoming|this\s+coming|nächsten?|prochain[e]?|pr[oó]xim[ao]|następn(?:y|a)|prossim[ao])\b/gi,'')
            .replace(/\b(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)\b/gi,'')
            .replace(/^(на|в|о|у|on|am|le|el|w|il|la|no|na|a|o)\s+/i,'')
            .replace(/\s+(на|в|о|у)\s*$/i,''));
          if (DEBUG) console.log(`[PRE-DOW-NOTIME] "${input}" → date:${dateStr} (task: "${taskText}")`);
          return res.json({ ok: true, text: taskText, datetime: '', source: 'unparsed' });
        }
      }
    }

    // ── PRE-DOW: Weekday + time ─────────────────────────────────────────────────
    {
      const dowPatterns = [
        [0, /(sunday|dimanche|domingo|niedziela|niedziel[ęą]|domenica|воскресенье|неділ[юяі]?|sonntag)/i],
        [1, /(monday|lundi|lunes|poniedzia[łl]ek|lunedì|segunda-?feira|segunda\b|понедельник|понеділо?к|montag)/i],
        [2, /(tuesday|mardi|martes|wtorek|martedì|ter[çc]a-?feira|terça\b|вторник|вівторо?к|dienstag)/i],
        [3, /(wednesday|mercredi|miércoles|[sś]rod[ęa]|mercoledì|quarta-?feira|quarta\b|среду?|середу?|середа|mittwoch)/i],
        [4, /(thursday|jeudi|jueves|czwartek|giovedì|quinta-?feira|quinta\b|четверг|четвер|donnerstag)/i],
        [5, /(friday|vendredi|viernes|pi[aą]tek|venerdì|sexta-?feira|sexta\b|пятниц[ую]?|п['']ятниц[юя]|freitag)/i],
        [6, /(saturday|samedi|s[aá]bado|sobot[ęa]|sabato|суббот[ау]?|субот[ую]?|samstag)/i],
      ];

      const timeMatch24 =
        normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) ||
        normInputGlobal.match(/\b(\d{1,2})\s*Uhr\b/i) ||
        normInputGlobal.match(/\b(\d{1,2})h\b(?!eure)/i) ||
        normInputGlobal.match(/\bat\s+(\d{1,2})\s*(pm|am)\b/i) ||
        normInputGlobal.match(/\bat\s+(\d{1,2})\s*(?:a\.m\.|p\.m\.)(?=\s|$)/i) ||
        normInputGlobal.match(/\bo\s+(\d{1,2})\s*(pm|am)?\b/i) ||
        normInputGlobal.match(/(\d{1,2})-[а-яіїєА-ЯІЇЄa-z]+/) ||
        normInputGlobal.match(/(?:à|a)\s+(\d{1,2})h(\d{2})\b/i) ||
        normInputGlobal.match(/на\s+(\d{1,2})\s+(?:вечора|вечера|ранку|утра|ночи|ночі)/i) ||
        normInputGlobal.match(/о\s+(\d{1,2})\s+(?:вечора|вечера|ранку|утра)/i) ||
        normInputGlobal.match(/\balle\s+(\d{1,2})\b/i) ||
        normInputGlobal.match(/(?:^|\s)à\s+(\d{1,2})\b/i) ||
        normInputGlobal.match(/(?:^|\s)às\s+(\d{1,2})\b/i) ||
        normInputGlobal.match(/\ba\s+las\s+(\d{1,2})\b/i);

      const period = detectPeriod(input);

      let targetDow = -1;
      for (const [idx, re] of dowPatterns) {
        if (re.test(input)) { targetDow = idx; break; }
      }

      if (targetDow >= 0 && timeMatch24) {
        let h = parseInt(timeMatch24[1]);
        const g2 = timeMatch24[2]?.toLowerCase();
        const mins = g2 && /^\d+$/.test(g2) ? parseInt(g2) : 0;
        const pmInMatch = g2 === 'pm';
        const amInMatch = g2 === 'am';

        // hasPMd uses both period and explicit match
        const hasPMd = pmInMatch || period === 'pm' || /(дня|після\s+обіду|после\s+обеда|nachmittags|del\s+pomeriggio|pomeriggio|\d(?:pm))/i.test(input);
        const hasAMd = amInMatch || period === 'am';

        if (hasPMd && h < 12) h += 12;
        if (hasAMd && h === 12) h = 0;

        let diff = targetDow - localNow.getDay();
        if (diff < 0) diff += 7;
        if (diff === 0) diff = 7;
        const d = new Date(localNow);
        d.setDate(localNow.getDate() + diff);
        const dateStr = d.toISOString().slice(0, 10);
        const datetime = `${dateStr}T${p2(h)}:${p2(mins)}:00${offStr(offsetMinutes)}`;

        const taskText = cleanTaskText(removeTriggerWords(input)
          .replace(new RegExp(dowPatterns.map(([,re]) => re.source).join('|'), 'gi'), '')
          .replace(/\b(следующ(?:ий|ую|его)|ближайш(?:ий|ую)|наступн(?:ий|ого|ій|у)|найближч(?:ий|у))\b/gi,'')
          .replace(/\b(next|upcoming|nächsten?|prochain[e]?|pr[oó]xim[ao]|następn(?:y|a)|prossim[ao])\b/gi,'')
          .replace(/(?:на|в|о|у|at|on|um|à|às|aos|alle|a\s+las|o\s+godzinie)\s+\d{1,2}(:\d{2})?(\s*Uhr)?/gi,'')
          .replace(/\d{1,2}:\d{2}/g,'').replace(/\d{1,2}\s*Uhr\b/gi,'').replace(/\d{1,2}h\b/gi,'')
          .replace(/(pm|p\.m\.|am\b|a\.m\.|abends|morgens|Uhr)/gi,'')
          .replace(/\b(de\s+la\s+(?:mañana|tarde|noche)|du\s+(?:soir|matin)|di\s+(?:sera|mattina)|da\s+(?:manhã|noite|tarde))\b/gi,'')
          .replace(/\b(mattino|sera|matin|soir|mañana|noche|manhã|noite|rano|horas?)\b/gi,'')
          .replace(/\b(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)\b/gi,''));
        if (DEBUG) console.log(`[PRE-DOW] "${input}" → ${datetime} (task: "${taskText}")`);
        return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
      }
    }

    // ── PRE24: Explicit date (today/tomorrow/day-after) + time ──────────────────
    {
      const hasToday    = /(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/i.test(input);
      const hasTomorrow = /(завтра|tomorrow|morgen|demain|ma[nñ]ana|jutro|domani|amanh[aã])/i.test(input);
      const hasDayAfter = /(послезавтра|після\s*завтра|позавтра|day\s*after\s*tomorrow|übermorgen|après-demain|pasado\s*ma[nñ]ana|pojutrze|dopodomani|depois\s*de\s*amanh[aã])/i.test(normInputGlobal);
      const hasRelativeDays = /(?:через|за|in|dans|en|za|tra|fra|em|dentro\s+de|daqui\s+a)\s+(\d+|один|два|три|чотир|п.ять|шість|сім|вісім|дев.ять|десять|one|two|three|four|five|six|seven|eight|nine|ten|ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|deux|trois|quatre|cinq|sept|huit|neuf|dix|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|dwa|dwie|trzy|cztery|due|tre|quattro|cinque|sei|sette|otto|nove|dois|duas|três|quatro)\s*(?:день|дня|дней|дні|днів|тижн|недел|days?|weeks?|Tagen?|Wochen?|jours?|semaines?|días?|semanas?|dni|tygodni|giorni|settimane|dias?)/i.test(input);

      const timeMatch = !hasRelativeDays && (
        normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) ||
        normInputGlobal.match(/\b(\d{1,2})-(\d{2})\b/) ||
        normInputGlobal.match(/\b(\d{1,2})\.(\d{2})\b/) ||
        normInputGlobal.match(/\b(\d{1,2})h(\d{2})\b(?!eure)/i) ||
        normInputGlobal.match(/(?:в|на)\s+(\d{1,2})\s+(?:годин[иу]?\s+)?(?:вечера|вечора|ночи|ночі|утра|ранку|дня)/i) ||
        normInputGlobal.match(/о\s+(\d{1,2})\s+(?:годин[иу]?\s+)?(?:вечора|вечера|ранку|утра|ночі|ночи)/i) ||
        normInputGlobal.match(/а\s+las\s+(\d{1,2})\s+de\s+la/i) ||
        normInputGlobal.match(/à\s+(\d{1,2})\s+heures?\b/i) ||
        normInputGlobal.match(/alle\s+(\d{1,2})\s+(?:di\s+sera|di\s+mattina)/i) ||
        normInputGlobal.match(/às\s+(\d{1,2})\s+horas?\b/i) ||
        normInputGlobal.match(/\bat\s+(\d{1,2})\s*(pm|am)\b/i) ||
        normInputGlobal.match(/\bat\s+(\d{1,2})\s*(?:a\.m\.|p\.m\.)(?=\s|$)/i)
      );

      const hasExplicitColon = !!(normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) || normInputGlobal.match(/\b(\d{1,2})-(\d{2})\b/));
      const period = detectPeriod(input);

      if (timeMatch) {
        let h = parseInt(timeMatch[1]);
        const m = timeMatch[2] && /^\d+$/.test(timeMatch[2]) ? parseInt(timeMatch[2]) : 0;
        const g2 = timeMatch[2]?.toLowerCase();

        if (g2 === 'pm' || period === 'pm') { if (h < 12) h += 12; }
        if (g2 === 'am' || period === 'am') { if (h === 12) h = 0; }
        const finalH = h;

        if ((finalH >= 13 || period !== null || hasExplicitColon || g2 === 'am' || g2 === 'pm') && finalH >= 0 && finalH <= 23 && m >= 0 && m <= 59) {
          const statedMins = finalH * 60 + m;
          const nowMins    = localNow.getHours() * 60 + localNow.getMinutes();

          // Determine date
          let d = new Date(localNow);
          if (hasDayAfter) {
            d.setDate(d.getDate() + 2);
          } else if (hasTomorrow) {
            d.setDate(d.getDate() + 1);
          } else if (!hasToday && statedMins <= nowMins) {
            d.setDate(d.getDate() + 1);
          } else if (hasToday && statedMins <= nowMins) {
            if (DEBUG) console.log(`[FIX] ${p2(finalH)}:${p2(m)} ≤ ${p2(localNow.getHours())}:${p2(localNow.getMinutes())}, today but past → tomorrow`);
            d.setDate(d.getDate() + 1);
          }
          d.setHours(finalH, m, 0, 0);
          const datetime = toIso(d, offsetMinutes);

          const taskText = cleanTaskText(removeTriggerWords(normInputGlobal)
            .replace(/(?:на|в|о|у|at|on|um|à|às|aos|alle|a\s+las|o\s+godzinie)\s+\d{1,2}(:\d{2})?(\s*Uhr)?/gi,'')
            .replace(/\d{1,2}[:\-\.]\d{2}/g,'').replace(/\d{1,2}h\d{2}\b/gi,'')
            .replace(/\b(ровно|рівно|exactly|sharp|genau|exakt|exactement|pile|exactamente|en\s+punto|dokładnie|równo|esattamente|in\s+punto|exatamente|em\s+ponto)\b/gi,'')
            .replace(/\b(следующ(?:ий|ую|его)|ближайш(?:ий|ую)|наступн(?:ий|ого|ій|у)|найближч(?:ий|у))\b/gi,'')
            .replace(/\b(next|upcoming|this\s+coming|nächsten?|prochain[e]?|pr[oó]xim[ao]|następn(?:y|a)|prossim[ao])\b/gi,'')
            .replace(/(завтра|послезавтра|сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/gi,'')
            .replace(/(після\s*завтра|позавтра|übermorgen|après-demain|pojutrze|dopodomani|depois\s*de\s*amanh[aã])/gi,'')
            .replace(/(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)/gi,'')
            .replace(/(вечора|вечера|вечором|увечері|ввечері|ранку|вранці|зранку|утра|ночи|дня)/gi,'')
            .replace(/\b(evening|morning|night|afternoon|noon|midnight|soir|matin|noche|mañana|tarde|sera|mattina|manhã|noite|rano|wieczorem?)\b/gi,'')
            .replace(/[ap]\.m\./gi,'').replace(/\b(horas?|heures?|Stunden?|hours?)\b/gi,'')
            .replace(/(?:^|\s)(à|às)\s+\d+\s*/gi,' '));
          if (DEBUG) console.log(`[PRE24] "${input}" → ${datetime} (task: "${taskText}")`);
          return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
        }
      }
    }

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
      const medical = /\b(таблетк|лекарств|укол|доз[аеуи]|препарат|антибиотик|болеутоляющ|обезболивающ|аспирин|парацетамол|ибупрофен|рецепт|врач|больниц|аптек|ліки|таблетк|лікар|лікарн|аптек)\b/i.test(normInputGlobal);
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
      /\b(eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+Uhr\b/i.test(normInputGlobal)
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
          /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i.test(normInputGlobal);

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

    if (DEBUG) console.log(`[OK] "${input}" → ${result.datetime}`);
    return res.json({ ok: true, text: result.text || '', datetime: result.datetime || '', source: 'ai' });

  } catch(e) {
    console.error("ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`SayDone parser v6 on port ${port}`));
