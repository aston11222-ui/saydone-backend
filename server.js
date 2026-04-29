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

function buildPrompt(nowIso, offsetStr, localNow, offsetMinutes, lang) {
  const dow = DOW_EN[localNow.getDay()];
  const todayStr = nowIso.slice(0, 10);
  const timeStr  = nowIso.slice(11, 16);
  const addD = n => { const d = new Date(localNow); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };
  const nextDow = i => { let diff = i - localNow.getDay(); if(diff<=0)diff+=7; const d=new Date(localNow); d.setDate(d.getDate()+diff); return d.toISOString().slice(0,10); };

  // Language-specific AM/PM words and trigger removal hints
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
    es: { am: 'de la mañana', pm: 'de la tarde(18h+)/de la noche', noon: 'de la tarde(12-17h)',
          triggers: 'recuérdame/ponme un recordatorio',
          days: 'lun, mar, mié, jue, vie, sáb, dom' },
    pl: { am: 'rano/z rana', pm: 'wieczorem/w nocy', noon: 'po południu',
          triggers: 'przypomnij mi/ustaw przypomnienie',
          days: 'pon=poniedziałek, wt=wtorek, śr=środa, czw=czwartek, pt=piątek, sob=sobota, nd=niedziela' },
    it: { am: 'di mattina/mattina', pm: 'di sera/di notte', noon: 'del pomeriggio',
          triggers: 'ricordami/imposta un promemoria',
          days: 'lun=lunedì, mar=martedì, mer=mercoledì, gio=giovedì, ven=venerdì, sab=sabato, dom=domenica' },
    pt: { am: 'da manhã', pm: 'da noite/da tarde(18h+)', noon: 'da tarde(12-17h)',
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


app.get("/",       (_, res) => res.send("SayDone AI-only parser v5"));
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

    // ── ASR normalization — fix voice recognition artifacts ──────────────────
    input = (function normalizeASR(s) {
      // Fix glued time: "в8" → "в 8", "at9" → "at 9"
      // Note: Cyrillic \b doesn't work — use lookahead/lookbehind
      s = s
        .replace(/(в|о|у|на)(\d{1,2})(?=\s|$)/gi, '$1 $2')
        .replace(/\b(at|on|um|à|a|às|alle|las)(\d{1,2})\b/gi, '$1 $2');

      // Fix spaced time after preposition: "в 8 30" → "в 8:30"
      s = s.replace(
        /(в|о|у|на|at|um|à|a|às|alle|las)\s+(\d{1,2})\s+(\d{2})(?=\s|$)/gi,
        '$1 $2:$3'
      );

      // ASR verb mistakes (voice recognition errors)
      s = s
        // RU
        .replace(/напамин(?=\s|$)/gi, 'напомни')
        .replace(/напомин(?=\s|$)/gi, 'напомни')
        // EN
        .replace(/\breminder\s+me\b/gi, 'remind me')
        .replace(/\bremind\s+to\b/gi, 'remind me to')
        // DE
        .replace(/\berinner\s+mich\b/gi, 'erinnere mich')
        // FR
        .replace(/\brappel\s+moi\b/gi, 'rappelle moi')
        // ES
        .replace(/\brecordame\b/gi, 'recuérdame')
        // PL
        .replace(/\bprzypomni\s+mi\b/gi, 'przypomnij mi')
        // IT
        .replace(/\bricorda\s+mi\b/gi, 'ricordami')
        // PT
        .replace(/\blembra\s+me\b/gi, 'lembra-me');

      // Filler/hesitation words
      s = s
        .replace(/(^|\s)(ну|типа|короче|ээ|эм)(?=\s|$)/gi, ' ')
        .replace(/\b(uh|um|eh|äh|euh)\b/gi, '');

      return s.replace(/\s+/g, ' ').trim();
    })(input);
    // ─────────────────────────────────────────────────────────────────────────


    function cleanTaskText(t) {
      return t
        // Leading connectors (FR d', ES que, PL że/żeby, IT di, PT de/da)
        // Note: 'do','al','co' removed — too risky ("do homework", "al dentist")
        .replace(/^d['\u2019\u0060\u00B4]\s*/i, '')
        .replace(/^(que|że|żeby|żebym|di|de|da|del)\s+/i, '')
        // Leading prepositions (RU/UK/EN/DE) — only unambiguous ones
        .replace(/^(на|в|о|у|um|to|for|le|la|el)\s+/i, '')
        // at/on only if followed by time/date context word, otherwise skip
        // (too risky: "on the road", "at the office" are valid tasks)
        // Leading à/às (FR/PT)
        .replace(/^(à|às|ao?)\s+/i, '')
        // Trailing prepositions/connectors (all languages)
        // Note: 'a','o' removed from trailing — too short, risk eating task words
        .replace(/\s+(в|на|о|у|at|on|to|for|um|à|às|al|alle|de|da|di|że)\s*$/i, '')
        // Trailing EN particles
        .replace(/\s+(and|or)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Normalize prefix-interval order so pre-parsers always find trigger first
    // "через 2 часа напомни купить молоко" → "напомни купить молоко через 2 часа"
    // "in 2 hours remind me to buy milk"   → "remind me to buy milk in 2 hours"
    {
      const _prefixIntervalRe = /^((?:через|за)\s+\d+[.,]?\d*\s*\S+|через\s+(?:полчаса|полтора\s+часа?)|(?:in|dans|en|za|tra|fra|em)\s+\d+[.,]?\d*\s*\S+|(?:daqui\s+a|dentro\s+de)\s+\d+[.,]?\d*\s*\S+|in\s+half\s+an\s+hour|in\s+an?\s+hour|in\s+(?:one\s+and\s+a\s+half|\d+\.5)\s+hours?)\s+((?:напомни|нагадай|поставь|постав|remind(?:\s+me)?|set\s+a\s+reminder|erinnere(?:\s+mich)?|rappelle(?:-moi)?|recu[eé]rdame|przypomnij(?:\s+mi)?|ricordami|lembra(?:-me)?|me\s+lembre)(?:\s|$).*)/i;
      const _pm = input.match(_prefixIntervalRe);
      if (_pm) {
        const reordered = _pm[2].trimEnd() + ' ' + _pm[1];
        if (DEBUG) console.log(`[REORDER] "${input}" → "${reordered}"`);
        input = reordered;
      }
    }

    // ── Deterministic pre-parser for relative intervals ───────────────────────
    // Handle "через N минут/часов" and equivalents in all languages
    // This runs BEFORE the AI to avoid hallucinations for any N value

      // Word numbers → digits for RU/UK/EN
    function normalizeWordNums(s) {
        // Accentless → accented normalization (handles voice/typo input without diacritics)
        s = s
          // ES weekdays/modifiers
          .replace(/\bmiercoles\b/gi, 'miércoles')
          .replace(/\bsabado\b/gi, 'sábado')
          .replace(/\bproximo\b/gi, 'próximo').replace(/\bproxima\b/gi, 'próxima')
          .replace(/\bmanana\b/gi, 'mañana')
          // IT weekdays
          .replace(/\blunedi\b/gi, 'lunedì').replace(/\bmartedi\b/gi, 'martedì')
          .replace(/\bmercoledi\b/gi, 'mercoledì').replace(/\bgiovedi\b/gi, 'giovedì')
          .replace(/\bvenerdi\b/gi, 'venerdì')
          // PL weekdays
          .replace(/\bsrode\b/gi, 'środę').replace(/\bsroda\b/gi, 'środa')
          .replace(/\bpiatek\b/gi, 'piątek').replace(/\bsrody\b/gi, 'środy')
          .replace(/\bniedziele\b/gi, 'niedzielę').replace(/\bsobote\b/gi, 'sobotę')
          // PT
          .replace(/\bamanha\b/gi, 'amanhã')
          .replace(/\bpróximo\b/gi, 'próximo').replace(/\bpróxima\b/gi, 'próxima');
        // Compound numbers (ES/FR/IT/PT/DE)
        s = s
          .replace(/cuarenta\s+y\s+cinco/gi,'45').replace(/cuarenta\s+y\s+seis/gi,'46')
          .replace(/treinta\s+y\s+cinco/gi,'35').replace(/treinta\s+y\s+seis/gi,'36')
          .replace(/veinte\s+y\s+cinco/gi,'25').replace(/veinte\s+y\s+uno/gi,'21')
          .replace(/vingt\s+et\s+un/gi,'21').replace(/vingt-cinq/gi,'25').replace(/trente\s+et\s+un/gi,'31')
          .replace(/venticinque/gi,'25').replace(/ventuno/gi,'21').replace(/quarantacinque/gi,'45').replace(/trentacinque/gi,'35')
          .replace(/vinte\s+e\s+cinco/gi,'25').replace(/vinte\s+e\s+um/gi,'21').replace(/quarenta\s+e\s+cinco/gi,'45').replace(/trinta\s+e\s+cinco/gi,'35')
          .replace(/fünfundvierzig/gi,'45').replace(/fünfunddreißig/gi,'35').replace(/fünfundzwanzig/gi,'25').replace(/einundzwanzig/gi,'21')
          // Half-numbers: полтора / пів / half etc → keep as special tokens handled by halfHour/oneAndHalf matchers
          ;
        const map = {
        // RU
        'один':'1','два':'2','три':'3','четыре':'4','пять':'5',
        'шесть':'6','семь':'7','восемь':'8','девять':'9','десять':'10',
        'одного':'1','двух':'2','трёх':'3','четырёх':'4','две':'2',
        'тридцать':'30','двадцать':'20','пятнадцать':'15',
        // UK
        'одна':'1','один':'1','дві':'2','два':'2','три':'3','чотири':'4',
        'п’ять':'5','шість':'6','сім':'7','вісім':'8','дев’ять':'9','десять':'10',
        'тридцять':'30','двадцять':'20','п’ятнадцять':'15',
        // EN
        'one':'1','two':'2','three':'3','four':'4','five':'5',
        'six':'6','seven':'7','eight':'8','nine':'9','ten':'10',
        'eleven':'11','twelve':'12','fifteen':'15','twenty':'20','thirty':'30','forty':'40','fifty':'50',
        // DE
        'ein':'1','eine':'1','zwei':'2','drei':'3','vier':'4','fünf':'5',
        'sechs':'6','sieben':'7','acht':'8','neun':'9','zehn':'10',
        'elf':'11','zwölf':'12','fünfzehn':'15','zwanzig':'20','dreißig':'30','vierzig':'40','fünfzig':'50',
        // FR
        'un':'1','une':'1','deux':'2','trois':'3','quatre':'4','cinq':'5',
        'six':'6','sept':'7','huit':'8','neuf':'9','dix':'10',
        'onze':'11','douze':'12','quinze':'15','vingt':'20','trente':'30','quarante':'40','cinquante':'50',
        // ES
        'uno':'1','una':'1','dos':'2','tres':'3','cuatro':'4','cinco':'5',
        'seis':'6','siete':'7','ocho':'8','nueve':'9','diez':'10',
        'once':'11','doce':'12','quince':'15','veinte':'20','treinta':'30','cuarenta':'40','cincuenta':'50',
        // PL
        'jeden':'1','jedna':'1','jedno':'1','dwa':'2','dwie':'2','trzy':'3',
        'cztery':'4','pięć':'5','sześć':'6','siedem':'7','osiem':'8',
        'dziewięć':'9','dziesięć':'10','piętnaście':'15','dwadzieścia':'20','trzydzieści':'30',
        // IT
        'uno':'1','una':'1','due':'2','tre':'3','quattro':'4','cinque':'5',
        'sei':'6','sette':'7','otto':'8','nove':'9','dieci':'10',
        'undici':'11','dodici':'12','quindici':'15','venti':'20','trenta':'30','quaranta':'40','cinquanta':'50',
        // PT
        'um':'1','uma':'1','dois':'2','duas':'2','três':'3','quatro':'4',
        'cinco':'5','seis':'6','sete':'7','oito':'8','nove':'9','dez':'10',
        'onze':'11','doze':'12','quinze':'15','vinte':'20','trinta':'30','quarenta':'40','cinquenta':'50',
      };
      for (const [w, d] of Object.entries(map)) {
        s = s.replace(new RegExp('(?:^|\\s)' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'gi'), m => m.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'), d));
      }
      return s;
      }
    const normInputGlobal = normalizeWordNums(input);

    // Helper: remove trigger words from input
    const _triggers = [
      // Wake words — all languages (strip before anything else)
      'ok(?:ay)?\\s+google', 'hey\\s+google', 'ok\\s+гугл', 'окей\\s+гугл',
      'hey\\s+siri', 'ehi\\s+siri', 'dis\\s+siri', 'ей\\s+сір[иі]', 'эй\\s+сір[иі]',
      // RU — longest first
      'поставь\\s+пожалуйста', 'поставь\\s+напоминание', 'создай\\s+напоминание', 'добавь\\s+напоминание', 'поставь\\s+будильник',
      'напомни\\s+пожалуйста', 'напомни\\s+мне', 'напомню(?=\\s|$)', 'напомни(?=\\s|$)', 'напоминание', 'поставь',
      // UK — longest first
      'постав\\s+будь\\s+ласка', 'постав\\s+нагадування', 'створи\\s+нагадування', 'додай\\s+нагадування', 'постав\\s+будильник',
      'нагадаю(?=\\s|$)', 'нагадай\\s+будь\\s+ласка', 'нагадай\\s+мені', 'нагадай(?=\\s|$)', 'нагадування', 'постав(?=\\s|$)',
      // EN — longest first
      'set\\s+a\\s+reminder\\s+for', 'set\\s+a\\s+reminder', 'set\\s+reminder', 'create\\s+reminder', 'add\\s+reminder', 'set\\s+alarm',
      'remind\\s+me\\s+to', 'please\\s+remind\\s+me', 'remind\\s+me', 'remind(?=\\s|$)', 'remember',
      'alert\\s+me\\s+to', 'alert\\s+me',
      // DE
      'bitte\\s+erinnere\\s+mich', 'erinnere\\s+mich', 'erinner\\s+mich',
      'erinnerung\\s+setzen', 'erinnerung\\s+hinzuf[uü]gen', 'wecker\\s+stellen', 'erinnere',
      // FR
      'mets\\s+un\\s+rappel', 'ajoute\\s+un\\s+rappel', 'cr[eé][eé]\\s+un\\s+rappel',
      'rappelle-moi\\s+de', 'rappelle-moi', 'rappelle\\s+moi', 'rappelle',
      // ES
      'ponme\\s+un\\s+recordatorio', 'agrega\\s+un\\s+recordatorio', 'crea\\s+un\\s+recordatorio',
      'recu[eé]rdame\\s+que', 'recu[eé]rdame',
      // PL
      'ustaw\\s+przypomnienie', 'dodaj\\s+przypomnienie', 'utw[oó]rz\\s+przypomnienie',
      'przypomnij\\s+mi\\s+[żz]eby', 'przypomnij\\s+mi', 'przypomnij',
      // IT
      'imposta\\s+un\\s+promemoria', 'aggiungi\\s+promemoria', 'crea\\s+promemoria',
      'ricordami\\s+che', 'ricordami\\s+di', 'ricordami\\s+tra', 'ricordami', 'ricorda(?=\\s|$)',
      // PT (PT-PT + PT-BR)
      'me\\s+lembre\\s+de', 'me\\s+lembre\\s+que', 'me\\s+lembre',
      'define\\s+um\\s+lembrete', 'adicione\\s+um\\s+lembrete', 'criar\\s+lembrete',
      'lembra-me\\s+que', 'lembra-me\\s+de', 'lembra-me', 'lembra(?=\\s|$)',
    ];
    const _leftoverRe = /^(мне|мені|me|mich|mi|moi|por\s+favor|pls|please|bitte|s'il\s+te\s+pla[iî]t|per\s+favore|proszę|будь\s+ласка|пожалуйста)\s+/i;
    function removeTriggerWords(t) {
      for (const tr of _triggers) {
        t = t.replace(new RegExp('^' + tr + '\\s*', 'i'), '');
        t = t.replace(new RegExp('\\s+' + tr + '(\\s|$)', 'gi'), ' ');
      }
      return t.replace(_leftoverRe, '').replace(/\s+/g, ' ').trim();
    }

    {
      // ── Combined "N hour(s) M minute(s)" pattern — all 9 languages ──────────
      const combinedHMMatch = normInputGlobal.match(
        /(?:in|dans|en|za|tra|fra|em|daqui\s+a|dentro\s+de|через|за)\s+(\d+)\s*(?:hours?|Stunden?|heures?|horas?|ora[e]?|ore\b|год[ину]+|годин[аиу]?|час[аов]?)\s*(?:and\s+|und\s+|et\s+|y\s+|e\s+|і\s+|та\s+|и\s+)?(\d+)\s*(?:min(?:ute)?s?|Minuten?|minutes?|minutos?|minut[oiа]?|хвилин[аиу]?|мин[утаы]*)/i
      );
      if (combinedHMMatch) {
        const totalMins = parseInt(combinedHMMatch[1]) * 60 + parseInt(combinedHMMatch[2]);
        const d = new Date(localNow);
        d.setMinutes(d.getMinutes() + totalMins);
        const datetime = toIso(d, offsetMinutes);
        let taskText = removeTriggerWords(normInputGlobal)
          .replace(/(?:in|dans|en|za|tra|fra|em|daqui\s+a|dentro\s+de|через|за)\s+\d+\s*\S+\s*(?:and\s+|und\s+|et\s+|y\s+|e\s+|і\s+|та\s+)?\d+\s*\S+/gi, '')
          .replace(/(сьогодні|сегодня|today|heute)/gi, '')
          .replace(/(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)/gi, '')
          .replace(/^(d['\u2019]|que\s+|że\s+|di\s+|de\s+)/i, '')
          .replace(/^(на|в|о|у|o|a)\s+/i, '')
          .replace(/\s+/g, ' ').trim();
        taskText = cleanTaskText(taskText);
        if (DEBUG) console.log(`[PRE-HM] "${input}" → ${datetime} (task: "${taskText}")`);
        return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
      }
      // ─────────────────────────────────────────────────────────────────────────

      const relMatch = normInputGlobal.match(
        /(?:через|за)\s+(\d+(?:[.,]\d+)?)\s*(?:минут[аыу]?|минут\b|хвилин[аиу]?|хвилин\b|хв\.?|мин\.?)/i
      ) || normInputGlobal.match(
        /\bin\s+(\d+(?:[.,]\d+)?)\s*(?:min(?:ute)?s?)\b/i
      ) || normInputGlobal.match(
        /\bdans\s+(\d+(?:[.,]\d+)?)\s*(?:min(?:ute)?s?)\b/i
      ) || normInputGlobal.match(
        /\bin\s+(\d+(?:[.,]\d+)?)\s*(?:Minute[n]?)\b/i
      ) || normInputGlobal.match(
        /\ben\s+(\d+(?:[.,]\d+)?)\s*(?:min(?:uto)?s?)\b/i
      ) || normInputGlobal.match(
        /\bza\s+(\d+(?:[.,]\d+)?)\s*(?:minut[aey]?|min)\b/i
      ) || normInputGlobal.match(
        /\btra\s+(\d+(?:[.,]\d+)?)\s*(?:minut[oi]|min)\b/i
      ) || normInputGlobal.match(
        /\bfra\s+(\d+(?:[.,]\d+)?)\s*(?:minut[oi]|min)\b/i
      ) || normInputGlobal.match(
        /\bem\s+(\d+(?:[.,]\d+)?)\s*(?:minuto?s?)\b/i
      ) || normInputGlobal.match(
        /\bdentro\s+de\s+(\d+(?:[.,]\d+)?)\s*(?:minutos?|min)\b/i
      ) || normInputGlobal.match(
        /\bdaqui\s+a\s+(\d+(?:[.,]\d+)?)\s*(?:minutos?|min)\b/i
      ) || normInputGlobal.match(
        /\bpara\s+(\d+(?:[.,]\d+)?)\s*(?:minutos?|min)\b/i
      ) || normInputGlobal.match(
        /\bpara\s+(\d+(?:[.,]\d+)?)\s*(?:horas?)\b/i
      );

      const hourMatch = normInputGlobal.match(
        /(?:через|за)\s+(\d+(?:[.,]\d+)?)\s*(?:час[аов]?|час\b|годин[аиу]?|годин\b|год\.?)/i
      ) || normInputGlobal.match(
        /\bin\s+(\d+(?:[.,]\d+)?)\s*(?:hours?|h)\b/i
      ) || normInputGlobal.match(
        /\bin\s+(\d+(?:[.,]\d+)?)\s*(?:Stunden?)\b/i
      ) || normInputGlobal.match(
        /\bdans\s+(\d+(?:[.,]\d+)?)\s*(?:heures?|h)\b/i
      ) || normInputGlobal.match(
        /\ben\s+(\d+(?:[.,]\d+)?)\s*(?:horas?|h)\b/i
      ) || normInputGlobal.match(
        /\bza\s+(\d+(?:[.,]\d+)?)\s*(?:godzin[aey]?|godz)\b/i
      ) || normInputGlobal.match(
        /\btra\s+(\d+(?:[.,]\d+)?)\s*(?:ora[e]?|ore)\b/i
      ) || normInputGlobal.match(
        /\bfra\s+(\d+(?:[.,]\d+)?)\s*(?:ora[e]?|ore)\b/i
      ) || normInputGlobal.match(
        /\bem\s+(\d+(?:[.,]\d+)?)\s*(?:horas?)\b/i
      ) || normInputGlobal.match(
        /\bdentro\s+de\s+(\d+(?:[.,]\d+)?)\s*horas?\b/i
      ) || normInputGlobal.match(
        /\bdaqui\s+a\s+(\d+(?:[.,]\d+)?)\s*horas?\b/i
      ) || normInputGlobal.match(
        /\bpara\s+(\d+(?:[.,]\d+)?)\s*horas?\b/i
      );

      // Special: через полчаса / через пів години / in half an hour
      const halfHourMatch = /через\s+полчаса|через\s+пів\s+год|in\s+half\s+an\s+hour|dans\s+une\s+demi[-\s]heure|en\s+media\s+hora|za\s+p[oó][łl]\s+godziny|tra\s+mezz[''\u2019]ora|fra\s+mezz[''\u2019]ora|em\s+meia\s+hora|dentro\s+de\s+media\s+hora|daqui\s+a\s+meia\s+hora|in\s+einer\s+halben\s+Stunde|in\s+einer\s+halbe\s+Stunde|dans\s+une\s+demi\s+heure/i.test(normInputGlobal);
      // Special: через полтора часа / через півтори години / in one and a half hours
      const oneAndHalfHourMatch = !halfHourMatch && (
        /через\s+полтора\s+час|через\s+півтор[иі]\s+год/i.test(normInputGlobal) ||
        /\bin\s+(?:one\s+and\s+a\s+half|1\.5|1,5)\s+hours?\b/i.test(normInputGlobal) ||
        /\bin\s+anderthalb\s+Stunden?\b/i.test(normInputGlobal) ||
        /\bdans\s+une\s+heure\s+et\s+demie\b/i.test(normInputGlobal) ||
        /\ben\s+una\s+hora\s+y\s+media\b/i.test(normInputGlobal) ||
        /\bza\s+p[oó][łl]torej\s+godziny\b/i.test(normInputGlobal) ||
        /\btra\s+un[''\u2019]ora\s+e\s+mezza\b/i.test(normInputGlobal) ||
        /\bfra\s+un[''\u2019]ora\s+e\s+mezza\b/i.test(normInputGlobal) ||
        /\bem\s+uma\s+hora\s+e\s+meia\b/i.test(normInputGlobal)
      );
      // через час / через годину / in an hour — anywhere in string, all languages
      const oneHourMatch = !halfHourMatch && (
        /(?:через|за)\s+(?:один\s+)?час(?!\S)/i.test(normInputGlobal) ||
        /(?:через|за)\s+годину/i.test(normInputGlobal) ||
        /\bin\s+an?\s+hour\b/i.test(input) ||
        /\bin\s+einer\s+Stunde\b/i.test(input) ||
        /\bdans\s+une\s+heure\b/i.test(input) ||
        /\ben\s+una\s+hora\b/i.test(input) ||
        /\bza\s+godzin[ęe]/i.test(input) ||
        /\btra\s+un['']?ora\b/i.test(input) ||
        /\bfra\s+un['']?ora\b/i.test(input) ||
        /\bem\s+(?:uma?|1)\s+hora\b/i.test(normInputGlobal) ||
        /\bdentro\s+de\s+(?:una?|1)\s+hora\b/i.test(normInputGlobal) ||
        /\bdaqui\s+a\s+(?:uma?|1)\s+hora\b/i.test(normInputGlobal) ||
        /\bpara\s+(?:uma?|1)\s+hora\b/i.test(normInputGlobal)
      );

      let preResult = null;

      if (halfHourMatch) {
        const d = new Date(localNow); d.setMinutes(d.getMinutes() + 30);
        preResult = { minutes: 30, dt: d };
      } else if (oneAndHalfHourMatch) {
        const d = new Date(localNow); d.setMinutes(d.getMinutes() + 90);
        preResult = { minutes: 90, dt: d };
      } else if (oneHourMatch) {
        const d = new Date(localNow); d.setHours(d.getHours() + 1);
        preResult = { hours: 1, dt: d };
      } else if (relMatch) {
        const n = parseFloat(relMatch[1].replace(',', '.'));
        if (!isNaN(n) && n > 0 && n <= 1440) {
          const d = new Date(localNow); d.setMinutes(d.getMinutes() + Math.round(n));
          preResult = { minutes: Math.round(n), dt: d };
        }
      } else if (hourMatch) {
        const n = parseFloat(hourMatch[1].replace(',', '.'));
        if (!isNaN(n) && n > 0 && n <= 168) {
          const d = new Date(localNow); d.setMinutes(d.getMinutes() + Math.round(n * 60));
          preResult = { hours: n, dt: d };
        }
      }

      if (preResult) {
        // ── Extract task: remove triggers + intervals (all 9 languages) ─────
        const triggers = [
          // RU — longest patterns first
          'поставь\\s+пожалуйста', 'поставь\\s+напоминание', 'создай\\s+напоминание', 'добавь\\s+напоминание', 'поставь\\s+будильник',
          'напомни\\s+пожалуйста', 'напомни\\s+мне', 'напомню(?=\\s|$)', 'напомни(?=\\s|$)', 'напоминание', 'поставь',
          // UK
          'постав\\s+будь\\s+ласка', 'постав\\s+нагадування', 'створи\\s+нагадування', 'додай\\s+нагадування', 'постав\\s+будильник',
          'нагадаю(?=\\s|$)', 'нагадай\\s+будь\\s+ласка', 'нагадай\\s+мені', 'нагадай(?=\\s|$)', 'нагадування', 'постав(?=\\s|$)',
          // EN
          'set\\s+a\\s+reminder\\s+for', 'set\\s+a\\s+reminder', 'set\\s+reminder', 'create\\s+reminder', 'add\\s+reminder', 'set\\s+alarm',
          'remind\\s+me\\s+to', 'please\\s+remind\\s+me', 'remind\\s+me', 'remind', 'remember',
          'alert\\s+me\\s+to', 'alert\\s+me',
          // DE
          'bitte\\s+erinnere\\s+mich', 'erinnere\\s+mich', 'erinner\\s+mich',
          'erinnerung\\s+setzen', 'erinnerung\\s+hinzuf[uü]gen', 'wecker\\s+stellen', 'erinnere',
          // FR
          'mets\\s+un\\s+rappel', 'ajoute\\s+un\\s+rappel', 'cr[eé][eé]\\s+un\\s+rappel',
          'rappelle-moi\\s+de', 'rappelle-moi', 'rappelle\\s+moi', 'rappelle',
          // ES
          'ponme\\s+un\\s+recordatorio', 'agrega\\s+un\\s+recordatorio', 'crea\\s+un\\s+recordatorio',
          'recu[eé]rdame\\s+que', 'recu[eé]rdame',
          // PL
          'ustaw\\s+przypomnienie', 'dodaj\\s+przypomnienie', 'utw[oó]rz\\s+przypomnienie',
          'przypomnij\\s+mi\\s+[żz]eby', 'przypomnij\\s+mi', 'przypomnij',
          // IT
          'imposta\\s+un\\s+promemoria', 'aggiungi\\s+promemoria', 'crea\\s+promemoria',
          'ricordami\\s+che', 'ricordami\\s+di', 'ricordami\\s+tra', 'ricordami', 'ricorda',
          // PT (PT-PT + PT-BR)
          'me\\s+lembre\\s+de', 'me\\s+lembre\\s+que', 'me\\s+lembre',
          'define\\s+um\\s+lembrete', 'adicione\\s+um\\s+lembrete', 'criar\\s+lembrete',
          'lembra-me\\s+que', 'lembra-me\\s+de', 'lembra-me', 'lembra',
        ];

        // Leftover particles left after trigger removal (мне/мені/me/mich/mi/moi)
        const leftoverRe = /^(мне|мені|me|mich|mi|moi)\s+/i;

        function removeTriggers(t) {
          for (const tr of triggers) {
            t = t.replace(new RegExp('^' + tr + '\\s*', 'i'), '');
            t = t.replace(new RegExp('\\s+' + tr + '(\\s|$)', 'gi'), ' ');
          }
          t = t.replace(leftoverRe, '');
          return t.replace(/\s+/g, ' ').trim();
        }

        let taskText = input
          // Special short forms (no \b needed — use context)
          .replace(/через\s+полчаса/i, '')
          .replace(/через\s+полтора\s+час\S*/i, '')
          .replace(/через\s+пів\s+год\S*/i, '')
          .replace(/через\s+півтор\S+\s+год\S*/i, '')
          .replace(/через\s+(?:один\s+)?час(?!\S)/i, '')
          .replace(/через\s+годину/i, '')
          .replace(/in\s+half\s+an\s+hour/i, '').replace(/in\s+an?\s+hour/i, '')
          .replace(/in\s+(?:one\s+and\s+a\s+half|1\.5|1,5)\s+hours?/i, '')
          .replace(/in\s+einer\s+halben\s+Stunde/i, '').replace(/in\s+einer\s+Stunde/i, '')
          .replace(/in\s+anderthalb\s+Stunden?/i, '')
          .replace(/dans\s+une\s+demi[-\s]heure/i, '').replace(/dans\s+une\s+heure/i, '')
          .replace(/dans\s+une\s+heure\s+et\s+demie/i, '')
          .replace(/en\s+media\s+hora/i, '').replace(/en\s+una\s+hora/i, '')
          .replace(/en\s+una\s+hora\s+y\s+media/i, '')
          .replace(/za\s+p[oó][łl]\s+godziny/i, '').replace(/za\s+godzin[ęe]/i, '')
          .replace(/za\s+p[oó][łl]torej\s+godziny/i, '')
          .replace(/tra\s+mezz[''\u2019]ora/i, '').replace(/tra\s+un[''\u2019]ora/i, '')
          .replace(/tra\s+un[''\u2019]ora\s+e\s+mezza/i, '')
          .replace(/fra\s+mezz[''\u2019]ora/i, '').replace(/fra\s+un[''\u2019]ora/i, '')
          .replace(/fra\s+un[''\u2019]ora\s+e\s+mezza/i, '')
          .replace(/em\s+meia\s+hora/i, '').replace(/em\s+uma\s+hora/i, '')
          .replace(/em\s+uma\s+hora\s+e\s+meia/i, '')
          .replace(/daqui\s+a\s+meia\s+hora/i, '')
          // Precision words (ровно/рівно/exactly/sharp/genau/pile/en punto etc.) — remove
          .replace(/\b(ровно|рівно|exactly|sharp|genau|exakt|exactement|pile|exactamente|en\s+punto|dokładnie|równo|esattamente|in\s+punto|exatamente|em\s+ponto)\b/gi, '')
          // N minutes/hours all languages
          .replace(/через\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/за\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/in\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/dans\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/en\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/za\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/tra\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/fra\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/em\s+\d+[.,]?\d*\s*\S+/i, '')
          .replace(/daqui\s+a\s+\d+[.,]?\d*\s*\S*/i, '');

        taskText = removeTriggers(taskText);
        // Remove single-letter particles/pronouns at start (Я, я etc.)
        taskText = taskText.replace(/^[а-яіїєА-ЯІЇЄ]\s+/u, '').trim();
        // Remove "через час/годину/hour" and half-hour expressions that may now be exposed
        taskText = taskText
          .replace(/(?:через|за)\s+(?:один\s+)?час(?!\S)/gi, '')
          .replace(/(?:через|за)\s+годину/gi, '')
          .replace(/\bin\s+an?\s+hour\b/gi, '')
          .replace(/\bin\s+einer\s+Stunde\b/gi, '')
          .replace(/\bdans\s+une\s+heure\b/gi, '')
          .replace(/\ben\s+una\s+hora\b/gi, '')
          .replace(/через\s+полчаса/gi, '')
          .replace(/через\s+пів\s+год\S*/gi, '')
          .replace(/\s+/g, ' ').trim();
        // Remove connector words at start (FR d', ES que, PL że/żeby, IT di, PT de/da)
        taskText = taskText
          .replace(/^(d['\u2019]|que\s+|co\s+|\u017ce\s+|\u017ceby\s+|\u017cebym\s+|di\s+|de\s+|da\s+|do\s+)/i, '')
          .trim();
        // Remove today/tomorrow date words that might remain
        taskText = taskText
          .replace(/(сьогодні|сегодня|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/gi, '')
          .replace(/\s+/g, ' ').trim();
        // Remove ES/PT interval expressions
        taskText = taskText
          .replace(/dentro\s+de\s+(?:una?|\d+)\s+hora\S*/gi, '')
          .replace(/dentro\s+de\s+\d+\s*\S+/gi, '')
          .replace(/daqui\s+a\s+(?:uma?|\d+)\s+hora\S*/gi, '')
          .replace(/daqui\s+a\s+\d+\s*\S+/gi, '')
          .replace(/para\s+\d+\s*\S+/gi, '')
          // Remove "que/co" connectors from ES/PL at start
          .replace(/^(que|co)\s+/i, '')
          .replace(/\s+/g, ' ').trim();
        // Remove word-number interval expressions that survived (second pass after letter removal)
        taskText = taskText
          .replace(/(?:через|за)\s+\d+\s*\S+/gi, '')
          .replace(/(?:через|за)\s+(?:один|два|дві|две|три|чотири|четыре|п['’]ять|пять|шість|шесть|сім|семь|вісім|восемь|дев['’]ять|девять|десять|one|two|three|four|five|six|seven|eight|nine|ten|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|deux|trois|quatre|cinq|sept|huit|neuf|dix|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|dwa|dwie|trzy|cztery|due|tre|quattro|cinque|dois|duas|três|quatro)\s*\S+/gi, '')
          .replace(/^(на|в|о|у|a)\s+/i, '')
          .replace(/\s+/g, ' ').trim();

        const datetime = toIso(preResult.dt, offsetMinutes);
        taskText = cleanTaskText(taskText);
        if (DEBUG) console.log(`[PRE] "${input}" → ${datetime} (task: "${taskText}")`);
        return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Noon / полдень deterministic handler ─────────────────────────────────
    {
      const noonRe = /(в\s+полдень|о\s+полудні|опівдні|\bat\s+noon\b|\bnoon\b|\bzu\s+Mittag\b|\bMittag\b|\bà\s+midi\b|\bmidi\b|\bal\s+mediod[ií]a\b|\bmediod[ií]a\b|\ba\s+mezzogiorno\b|\bmezzogiorno\b|\bao?\s+meio-?dia\b|\bmeio-?dia\b|\bw\s+południe\b|\bpołudnie\b)/i;
      const midnightRe = /(в\s+полночь|опівночі|о\s+полуночі|\bat\s+midnight\b|\bmidnight\b|\bzu\s+Mitternacht\b|\bMitternacht\b|\bà\s+minuit\b|\bminuit\b|\ba\s+medianoche\b|\bmedianoche\b|\ba\s+mezzanotte\b|\bmezzanotte\b|\bà\s+meia-?noite\b|\bmeia-?noite\b|\bo\s+północy\b|\bpółnoc\b)/i;

      const isNoon = noonRe.test(normInputGlobal);
      const isMidnight = !isNoon && midnightRe.test(normInputGlobal);

      if (isNoon || isMidnight) {
        const targetHour = isNoon ? 12 : 0;
        // Check for tomorrow/day-after modifier
        const hasTomNoon = /(завтра|tomorrow|morgen|demain|ma[nñ]ana|jutro|domani|amanh[aã])/i.test(normInputGlobal);
        const hasDayAfterNoon = /(послезавтра|після\s*завтра|позавтра|day\s*after\s*tomorrow|übermorgen|après-demain|pasado\s*ma[nñ]ana|pojutrze|dopodomani|depois\s*de\s*amanh[aã])/i.test(normInputGlobal);
        const d = new Date(localNow);
        d.setHours(targetHour, 0, 0, 0);
        if (hasDayAfterNoon) {
          d.setDate(d.getDate() + 2);
        } else if (hasTomNoon) {
          d.setDate(d.getDate() + 1);
        } else if (d <= localNow) {
          // already passed today → tomorrow
          d.setDate(d.getDate() + 1);
        }
        const datetime = toIso(d, offsetMinutes);
        let taskText = removeTriggerWords(normInputGlobal)
          .replace(noonRe, '').replace(midnightRe, '')
          .replace(/(завтра|tomorrow|morgen|demain|ma[nñ]ana|jutro|domani|amanh[aã])/gi, '')
          .replace(/(послезавтра|після\s*завтра|позавтра|übermorgen|après-demain|pojutrze|dopodomani|depois\s*de\s*amanh[aã])/gi, '')
          .replace(/(сьогодні|сегодня|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/gi, '')
          .replace(/(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)/gi, '')
          .replace(/\b(ровно|рівно|exactly|sharp|genau|exactement|pile|exactamente|en\s+punto|dokładnie|esattamente|exatamente)\b/gi, '')
          .replace(/^(на|в|о|у|o|a|au?)\s+/i, '')
          .replace(/\s+/g, ' ').trim();
        taskText = cleanTaskText(taskText);
        if (DEBUG) console.log(`[PRE-NOON] "${input}" → ${datetime} (task: "${taskText}")`);
        return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Deterministic N days/weeks parser ────────────────────────────────────
    // Handles: "через 3 дня", "in 3 days", "dans 3 jours", "za 3 dni" etc.
    {
      // normalizeWordNums defined above as shared helper

      const normInput = normInputGlobal;

      const daysMatch = normInput.match(/(?:через|за)\s+(\d+)\s*(?:день|дня|дней|дні|днів|днів)/i) ||
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
        normInput.match(/(?:через|за)\s+(\d+)\s*(?:тижн[іьея]|тижнів|неділь|тижде?нь)/i) ||
        normInput.match(/(?:через|за)\s+(\d+)\s*(?:недел[иьюя]|недель)/i) ||
        normInput.match(/\bin\s+(\d+)\s*weeks?\b/i) ||
        normInput.match(/\bin\s+(\d+)\s*Wochen?\b/i) ||
        normInput.match(/\bdans\s+(\d+)\s*semaines?\b/i) ||
        normInput.match(/\ben\s+(\d+)\s*semanas?\b/i) ||
        normInput.match(/\bza\s+(\d+)\s*tygodni[aey]?\b/i) ||
        normInput.match(/\btra\s+(\d+)\s*settimane?\b/i) ||
        normInput.match(/\bfra\s+(\d+)\s*settimane?\b/i) ||
        normInput.match(/\bem\s+(\d+)\s*semanas?\b/i) ||
        normInput.match(/\bdaqui\s+a\s+(\d+)\s*semanas?\b/i)
      );

      const nMatch = daysMatch || weeksMatch;
      if (nMatch) {
        const n = parseInt(nMatch[1]);
        const days = daysMatch ? n : n * 7;
        if (days > 0 && days <= 365) {
          const targetDate = new Date(localNow);
          targetDate.setDate(localNow.getDate() + days);

          // Check if there's also a time specified
          const timeInInput = normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) ||
                              normInputGlobal.match(/\b(\d{1,2})\s*Uhr\b/i) ||
                              normInputGlobal.match(/(\d{1,2})-[а-яіїєА-ЯІЇЄa-z]+/) ||
                              normInputGlobal.match(/в\s+(\d{1,2})\s+(?:вечера|вечора|ранку|утра|ночи|ночі)/i) ||
                              normInputGlobal.match(/о\s+(\d{1,2})\s+(?:вечора|вечера|ранку|утра)/i) ||
                              normInputGlobal.match(/на\s+(\d{1,2})\s+(?:годин[иу]?\s+)?(?:вечора|вечера|ранку|утра|ночи|ночі)/i) ||
                          normInputGlobal.match(/о\s+(\d{1,2})\s+годин[иі]\s+(?:вечора|ранку|ночі)/i) ||
                              normInputGlobal.match(/\bat\s+(\d{1,2})\s*(pm|am)\b/i) ||
                              normInputGlobal.match(/\bat\s+(\d{1,2})\s*(?:a\.m\.|p\.m\.)(?=\s|$)/i) ||
                              // RU/UK bare 'в 8' / 'на 8' / 'о 8' without period word
                              normInputGlobal.match(/(?:^|\s)(?:в|на|о|у)\s+(\d{1,2})(?:\s|$)/i) ||
                              normInputGlobal.match(/\b(\d{1,2})\s*(?:a\.m\.|p\.m\.)(?=\s|$)/i) ||
                              normInputGlobal.match(/\balle\s+(\d{1,2})\b/i) ||
                              normInputGlobal.match(/(?:à|a)\s+(\d{1,2})h\b/i) ||
                              normInputGlobal.match(/(?:^|\s)à\s+(\d{1,2})\b/i) ||
                              normInputGlobal.match(/(?:^|\s)às\s+(\d{1,2})\b/i) ||
                              normInputGlobal.match(/às\s+(\d{1,2})\s+horas?\b/i) ||
                              normInputGlobal.match(/alle?\s+(\d{1,2})\s+(?:horas?|Uhr)\b/i) ||
                              normInputGlobal.match(/\ba\s+las\s+(\d{1,2})\b/i);
          let h = 0, m = 0, hasTime = false;
          if (timeInInput) {
            h = parseInt(timeInInput[1]);
            m = timeInInput[2] ? parseInt(timeInInput[2]) : 0;
            const hasPMd = /(вечора|вечера|вечором|увечері|ввечері|дня|після\s+обіду|после\s+обеда|abends|nachmittags|du\s+soir|de\s+la\s+(?:tarde|noche)|por\s+la\s+(?:tarde|noche)|di\s+sera|del\s+pomeriggio|da\s+(?:tarde|noite)|wieczorem?|\d(?:pm)|\bpm\b|p\.m\.)/i.test(input);
            const hasAMd = /(ранку|вранці|зранку|утра|утром|ночи|ночі|вночі|ночью|morgens|du\s+matin|de\s+la\s+mañana|di\s+mattina|da\s+manhã|rano|\bam\b|a\.m\.)/i.test(input);
            if (hasPMd && h < 12) h += 12;
            if (hasAMd && h === 12) h = 0;
            hasTime = true;
          }

          const dateStr = targetDate.toISOString().slice(0, 10);
          const datetime = hasTime
            ? `${dateStr}T${p2(h)}:${p2(m)}:00${offStr(offsetMinutes)}`
            : `${dateStr}T00:00:00${offStr(offsetMinutes)}`;

          // Extract task
          let taskText = removeTriggerWords(normInput)
            // Remove "на/в/о HH:MM period" time expressions
            .replace(/(?:на|в|о|у)\s+\d{1,2}:\d{2}(?:\s+(?:вечора|вечера|ранку|утра|вечером|ночи))?/gi, '')
            .replace(/(?:на|в|о|у)\s+\d{1,2}\s+(?:годин[иу]?\s+)?(?:вечора|вечера|ранку|утра|ночи|ночі)/gi, '')
            // Remove interval expressions (digits after normalization)
            .replace(/(?:через|за)\s+\d+\s*\S+/gi, '')
            .replace(/\bin\s+\d+\s*\S+/gi, '')
            .replace(/\bdans\s+\d+\s*\S+/gi, '')
            .replace(/\ben\s+\d+\s*\S+/gi, '')
            .replace(/\bza\s+\d+\s*\S+/gi, '')
            .replace(/\btra\s+\d+\s*\S+/gi, '')
            .replace(/\bfra\s+\d+\s*\S+/gi, '')
            .replace(/\bem\s+\d+\s*\S+/gi, '')
            .replace(/\bdaqui\s+a\s+\d+\s*\S+/gi, '')
            .replace(/\bdentro\s+de\s+\d+\s*\S+/gi, '')
            // Remove time parts
            .replace(/\d{1,2}:\d{2}/g, '')
            .replace(/\b\d{1,2}h\b/gi, '')
            .replace(/\b(Uhr|pm|am)\b/gi, '')
            .replace(/(вечора|вечера|ранку|утра|ночи|ночі)/gi, '')
            // Remove period phrases (FR/ES/IT/PT)
            .replace(/\b(de\s+la\s+(?:mañana|tarde|noche)|du\s+(?:soir|matin)|di\s+(?:sera|mattina)|da\s+(?:manhã|noite|tarde))\b/gi, '')
            .replace(/\b(horas?|heures?|Stunden?|hours?|ore\b)/gi, '')
            // Remove connector words (all languages)
            .replace(/\b(que|di|de|al|że|żeby|żebym|co)\b/gi, '')
            // Remove standalone prepositions at end
            .replace(/\s+(o|we|à|às|al|di|del|d)\s*$/i, '')
            .replace(/\bo\s*$/i, '')
            // Remove bare number+h leftovers (à 20h → "20" or "h" remains)
            .replace(/\b\d{1,2}h\b/gi, '')
            .replace(/(?:^|\s)\d{1,2}\s*$/g, '')
            // Remove "del mattino/sera" leftovers
            .replace(/\b(mattino|sera|matin|soir|mañana|noche|manhã|noite|rano|horas?)\b/gi, '')
            // Remove leftover time parts (FR/PT/IT bare hour remnants)
            .replace(/(?:^|\s)(à|às|alle)\s+\d+\s*/gi, ' ')
            .replace(/\b(horas?|heures?|Stunden?|Uhr)\b/gi, '')
            .replace(/[ap]\.m\./gi, '')
            // Remove leftover prepositions at start
            .replace(/^(на|в|о|у|a|le|o|à|às|de|da|lembro-me)\s+/i, '')
            .replace(/\s+/g, ' ').trim();

          // If no time → return empty datetime so user picks time
          if (!hasTime) {
            taskText = cleanTaskText(taskText);
          if (DEBUG) console.log(`[PRE-DAYS] "${input}" → task:"${taskText}" date:${dateStr} (no time → picker)`);
            return res.json({ ok: true, text: taskText, datetime: '', source: 'unparsed' });
          }

          if (DEBUG) console.log(`[PRE-DAYS] "${input}" → ${datetime} (task: "${taskText}")`);
          return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Deterministic weekday + time parser ──────────────────────────────────
    // Handles: "on Friday at 21:00", "am Freitag um 21 Uhr", "vendredi à 21h" etc.
    // Only fires when BOTH weekday AND unambiguous time are present
    {
      // Weekday detection — all 9 languages → index 0(Sun)..6(Sat)
      const dowPatterns = [
        [0, /(sunday|dimanche|domingo|niedziela|niedziel[ęą]|domenica|воскресенье|(?<![а-яіїєА-ЯІЇЄa-z])неділ[юяі]?(?![а-яіїєА-ЯІЇЄa-z])|sonntag)/i],
        [1, /(monday|lundi|lunes|poniedzia[łl]ek|lunedì|segunda-?feira|segunda\b|понедельник|понеділо?к|montag)/i],
        [2, /(tuesday|mardi|martes|wtorek|martedì|ter[çc]a-?feira|terça\b|вторник|вівторо?к|dienstag)/i],
        [3, /(wednesday|mercredi|miércoles|[sś]rod[ęa]|mercoledì|quarta-?feira|quarta\b|среду?|середу?|середа|mittwoch)/i],
        [4, /(thursday|jeudi|jueves|czwartek|giovedì|quinta-?feira|quinta\b|четверг|четвер|donnerstag)/i],
        [5, /(friday|vendredi|viernes|pi[aą]tek|venerdì|sexta-?feira|sexta\b|пятниц[ую]?|п['’]ятниц[юя]|freitag)/i],
        [6, /(saturday|samedi|s[aá]bado|sobot[ęa]|sabato|суббот[ау]?|субот[ую]?|samstag)/i],
      ];

      // Exact time: HH:MM or H Uhr or Hh or bare H + pm/am or ordinal (9-ту, 8-му etc.)
      const timeMatch24 = normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) ||
                          normInputGlobal.match(/\b(\d{1,2})\s*Uhr\b/i) ||
                          normInputGlobal.match(/\b(\d{1,2})h\b(?!eure)/i) ||
                          normInputGlobal.match(/\bat\s+(\d{1,2})\s*(pm|am)\b/i) ||
                          normInputGlobal.match(/\bat\s+(\d{1,2})\s*(?:a\.m\.|p\.m\.)(?=\s|$)/i) ||
                          normInputGlobal.match(/\bo\s+(\d{1,2})\s*(pm|am)?\b/i) ||
                          // Ordinal: 9-ту, 8-му etc. (UK/RU)
                          normInputGlobal.match(/(\d{1,2})-[а-яіїєА-ЯІЇЄa-z]+/) ||
                          // FR "8h45" format
                          normInputGlobal.match(/(?:à|a)\s+(\d{1,2})h(\d{2})\b/i) ||
                          // Bare hour + Cyrillic period word
                          normInputGlobal.match(/на\s+(\d{1,2})\s+(?:вечора|вечера|ранку|утра|ночи|ночі)/i) ||
                          normInputGlobal.match(/о\s+(\d{1,2})\s+(?:вечора|вечера|ранку|утра)/i) ||
                          // Bare hour + Latin period/preposition
                          normInputGlobal.match(/\balle\s+(\d{1,2})\b/i) ||
                          normInputGlobal.match(/(?:^|\s)à\s+(\d{1,2})\b/i) ||
                          normInputGlobal.match(/(?:^|\s)às\s+(\d{1,2})\b/i) ||
                          normInputGlobal.match(/\ba\s+las\s+(\d{1,2})\b/i);
      // PM words
      const hasPM = /(\d(pm)\b|p\.m\.(?=\s|$)|вечера|вечора|увечері|ввечері|\babends\b|\bdu\s+soir\b|\bde\s+la\s+noche\b|\bdi\s+sera\b|\bda\s+noite\b|wieczore?m?\b|\bsera\b|\bnoche\b)/i.test(input);
      const hasAM = /(\d(am)\b|a\.m\.(?=\s|$)|утра|ранку|вранці|зранку|\bmorgens\b|\bdu\s+matin\b|\bde\s+la\s+mañana\b|\bdi\s+mattina\b|\bda\s+manhã\b|\brano\b|\bmattina\b|\bmatin\b|\bmorning\b)/i.test(input);

      if (timeMatch24) {
        let h = parseInt(timeMatch24[1]);
        const g2 = timeMatch24[2]?.toLowerCase();
        const m = (g2 && g2 !== 'pm' && g2 !== 'am') ? parseInt(g2) : 0;
        const pmInMatch = g2 === 'pm';
        // Apply PM/AM if needed
        if ((hasPM || pmInMatch) && h < 12) h += 12;
        if (hasAM && h === 12) h = 0;

        // Find weekday
        let targetDow = -1;
        for (const [idx, re] of dowPatterns) {
          if (re.test(input)) { targetDow = idx; break; }
        }

        if (targetDow >= 0 && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
          // Calculate next occurrence — if diff < 0 → already passed, add 7; if diff === 0 → same weekday today, use next week
          let diff = targetDow - localNow.getDay();
          if (diff < 0) diff += 7;   // past day this week → next week
          if (diff === 0) diff = 7;  // same weekday today → next week
          const targetDate = new Date(localNow);
          targetDate.setDate(localNow.getDate() + diff);
          const dateStr = targetDate.toISOString().slice(0, 10);
          const datetime = `${dateStr}T${p2(h)}:${p2(m)}:00${offStr(offsetMinutes)}`;

          let taskText = removeTriggerWords(input)
            .replace(new RegExp(dowPatterns.map(([,re]) => re.source).join('|'), 'gi'), '')
            // Remove precision words
            .replace(/\b(ровно|рівно|exactly|sharp|genau|exakt|exactement|pile|exactamente|en\s+punto|dok\u0142adnie|r\xf3wno|esattamente|in\s+punto|exatamente|em\s+ponto)\b/gi, '')
            // Remove next/следующий/наступний modifiers
            .replace(/\b(следующ(?:ий|ую|его)|ближайш(?:ий|ую)|наступн(?:ий|ого|ій|у)|найближч(?:ий|у))\b/gi, '')
            .replace(/\b(next|upcoming|this\s+coming|n\xe4chsten?|n\xe4chste[rn]?|kommenden?|prochain[e]?|pr[o\xf3]xim[ao]|nast\u0119pn(?:y|a)|najbli\u017cszych?|prossim[ao])\b/gi, '')
            .replace(/(?:на|в|о|у|at|on|um|à|às|aos|alle|a\s+las|o\s+godzinie)\s+\d{1,2}(:\d{2})?(\s*Uhr)?/gi, '')
            .replace(/\d{1,2}:\d{2}/g, '')
            .replace(/\d{1,2}\s*Uhr\b/gi, '').replace(/\d{1,2}h\b/gi, '')
            .replace(/(pm|p\.m\.|am\b|a\.m\.|abends|morgens|Uhr)/gi, '')
            // Cyrillic period words (no \b needed)
            .replace(/(вечера|вечора|вечером|увечері|ввечері|ранку|вранці|зранку|утра|ночи|дня)/gi, '')
            // Latin period words
            .replace(/\b(evening|morning|night|afternoon|noon|midnight|soir|matin|noche|ma\xf1ana|tarde|sera|mattina|manh\xe3|noite|rano|wieczorem?|wieczor)\b/gi, '')
            // Time unit words that might remain after hour extraction
            .replace(/\b(horas?|heures?|Stunden?|hours?)\b/gi, '')
            // Connector words (FR de/d', ES que/de, IT di/al/il/mio/la, PT de/da/do)
            .replace(/\bde\s+la\b/gi, '').replace(/\bde\b/gi, '')
            .replace(/\bque\b/gi, '').replace(/\bal\b/gi, '').replace(/\bdi\b/gi, '')
            .replace(/\b(daran|zur\xfcck)\b/gi, '')
            // Remove ordinal suffixes like -ту, -му, -ій
            .replace(/^-[\u0400-\u04ff]+\s*/i, '')
            .replace(/\s+-[\u0400-\u04ff]+/gi, '')
            // Remove leftover prepositions at start AND as isolated tokens
            .replace(/^(на|в|о|у|o|a|le|el)\s+/i, '')
            // Remove isolated single Cyrillic prepositions left after DOW removal
            .replace(/(?:^|\s)(у|о|в|на|по)(?=\s|$)/gi, ' ')
            .replace(/\s+/g, ' ').trim();

          taskText = cleanTaskText(taskText);
          if (DEBUG) console.log(`[PRE-DOW] "${input}" → ${datetime} (task: "${taskText}")`);
          return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Deterministic weekday-only parser (no time → show picker) ───────────
    // Intercepts "на пятницу", "on Friday", "am Freitag" etc. without time info
    // Returns datetime:'' so app shows time picker with cleaned task text
    {
      const dowPatternsSimple = [
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
        let targetDow2 = -1;
        for (const [idx, re] of dowPatternsSimple) {
          if (re.test(input)) { targetDow2 = idx; break; }
        }
        if (targetDow2 >= 0) {
          let diff = targetDow2 - localNow.getDay();
          if (diff < 0) diff += 7;
          if (diff === 0) diff = 7;
          const targetDate = new Date(localNow);
          targetDate.setDate(localNow.getDate() + diff);
          const dateStr = targetDate.toISOString().slice(0, 10);
          let taskText = removeTriggerWords(input)
            .replace(new RegExp(dowPatternsSimple.map(([,re]) => re.source).join('|'), 'gi'), '')
            .replace(/\b(следующ(?:ий|ую|его)|ближайш(?:ий|ую)|наступн(?:ий|ого|ій|у)|найближч(?:ий|у))\b/gi, '')
            .replace(/\b(next|upcoming|this\s+coming|nächsten?|nächste[rn]?|kommenden?|prochain[e]?|pr[oó]xim[ao]|następn(?:y|a)|najbliższ(?:y|a)|prossim[ao])\b/gi, '')
            .replace(/\b(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)\b/gi, '')
            .replace(/^(на|в|о|у|on|am|le|el|w|il|la|no|na|a|o)\s+/i, '')
            .replace(/\s+(на|в|о|у)\s*$/i, '')
            .replace(/\s+/g, ' ').trim();
          taskText = cleanTaskText(taskText);
          if (DEBUG) console.log(`[PRE-DOW-NOTIME] "${input}" → date:${dateStr} no time → picker (task: "${taskText}")`);
          return res.json({ ok: true, text: taskText, datetime: '', source: 'unparsed' });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

        // ── Safe deterministic parser for exact HH:MM time + simple date ─────────
    // Only handles 100% unambiguous patterns to avoid AI cost
    // SKIP if input has relative days/weeks — those are handled by PRE-DAYS
    {
      const hasRelativeDays = /(?:через|за|in|dans|en|za|tra|fra|em|dentro\s+de|daqui\s+a)\s+(\d+|один|два|три|чотир|п.ять|шість|сім|вісім|дев.ять|десять|one|two|three|four|five|six|seven|eight|nine|ten|ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|deux|trois|quatre|cinq|sept|huit|neuf|dix|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|dwa|dwie|trzy|cztery|due|tre|quattro|cinque|sei|sette|otto|nove|dois|duas|três|quatro)\s*(?:день|дня|дней|дні|днів|тижн|недел|days?|weeks?|Tagen?|Wochen?|jours?|semaines?|días?|semanas?|dni|tygodni|giorni|settimane|dias?)/i.test(input);

      // Extract exact time: HH:MM or H:MM (24h) or 8-30 or 8.30 or 8h30
      const timeMatch = !hasRelativeDays && (
        normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) ||
        normInputGlobal.match(/\b(\d{1,2})-(\d{2})\b/) ||
        normInputGlobal.match(/\b(\d{1,2})\.(\d{2})\b/) ||
        normInputGlobal.match(/\b(\d{1,2})h(\d{2})\b(?!eure)/i) ||
        // Bare hour + period word (RU/UK)
        normInputGlobal.match(/в\s+(\d{1,2})\s+(?:вечера|вечора|ночи|ночі)/i) ||
        normInputGlobal.match(/о\s+(\d{1,2})\s+(?:вечора|вечера|ранку|утра)/i) ||
        // ES bare hour
        normInputGlobal.match(/a\s+las\s+(\d{1,2})\s+de\s+la/i) ||
        // FR bare hour
        normInputGlobal.match(/à\s+(\d{1,2})\s+heures?\b/i) ||
        // IT bare hour
        normInputGlobal.match(/alle\s+(\d{1,2})\s+(?:di\s+sera|di\s+mattina)/i) ||
        // PT bare hour
        normInputGlobal.match(/às\s+(\d{1,2})\s+horas?\b/i)
      );

      if (timeMatch) {
        const h = parseInt(timeMatch[1]);
        const m = parseInt(timeMatch[2]);

        // Determine if AM/PM word present
        const hasPRE24AM = /(ранку|вранці|зранку|до\s+обіду|утра|утром|с\s+утра|до\s+обеда|ночи|ночі|вночі|уночі|ночью|\bmorning\b|in\s+the\s+morning|\bam\b|a\.m\.|morgens|fr[uü]h|vormittags|du\s+matin|le\s+matin|de\s+la\s+ma[nñ]ana|por\s+la\s+ma[nñ]ana|\bdi\s+mattina\b|\bmattina\b|da\s+manh[ãa]|de\s+manh[ãa]|\brano\b|z\s+rana|przed\s+po[łl]udniem)/i.test(input);
        const hasPRE24PM = /(вечора|вечера|увечері|ввечері|дня|після\s+обіду|вечером|после\s+обеда|\bevening\b|in\s+the\s+evening|\bnight\b|at\s+night|\bpm\b|p\.m\.|\bafternoon\b|in\s+the\s+afternoon|\babends\b|\bnachts\b|du\s+soir|le\s+soir|de\s+nuit|la\s+nuit|de\s+la\s+(?:tarde|noche)|por\s+la\s+(?:tarde|noche)|\bdi\s+sera\b|\bdi\s+notte\b|\bsera\b|\bnotte\b|da\s+(?:tarde|noite)|[�xa0]\s+noite|wieczore?m?|w\s+nocy|noc[ąa])/i.test(normInputGlobal);
        let adjH = h;
        if (hasPRE24PM && h < 12) adjH = h + 12;
        if (hasPRE24AM && h === 12) adjH = 0;

        // Handle 24h times OR 12h with explicit AM/PM word
        // HH:MM with colon is always unambiguous 24h format (9:00 = 09:00, not noon)
        const hasExplicitColon = !!(normInputGlobal.match(/\b(\d{1,2}):(\d{2})\b/) || normInputGlobal.match(/\b(\d{1,2})-(\d{2})\b/));
        if ((adjH >= 13 || hasPRE24AM || hasPRE24PM || hasExplicitColon) && adjH >= 0 && adjH <= 23 && m >= 0 && m <= 59) {
          const finalH = adjH;
          // Clear 24h time — determine date
          const statedMinutes = finalH * 60 + m;  // use finalH (post AM/PM correction)
          const nowMinutes = localNow.getHours() * 60 + localNow.getMinutes();

          // Check for tomorrow/послезавтра/day-after words
          const hasTomorrow = /(завтра|tomorrow|morgen|demain|ma[nñ]ana|jutro|domani|amanh[aã])/i.test(input);
          const hasDayAfter = /(послезавтра|після\s*завтра|позавтра|day\s*after\s*tomorrow|übermorgen|après-demain|pasado\s*ma[nñ]ana|pojutrze|dopodomani|depois\s*de\s*amanh[aã])/i.test(input);
          const hasToday = /(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/i.test(input);

          let dateStr;
          if (hasDayAfter) {
            const d = new Date(localNow); d.setDate(d.getDate() + 2);
            dateStr = d.toISOString().slice(0, 10);
          } else if (hasTomorrow) {
            const d = new Date(localNow); d.setDate(d.getDate() + 1);
            dateStr = d.toISOString().slice(0, 10);
          } else if (hasToday) {
            dateStr = localNow.toISOString().slice(0, 10);
          } else {
            // No date word — use today if future, tomorrow if past
            const d = new Date(localNow);
            if (statedMinutes <= nowMinutes) d.setDate(d.getDate() + 1);
            dateStr = d.toISOString().slice(0, 10);
          }

          const datetime = `${dateStr}T${p2(finalH)}:${p2(m)}:00${offStr(offsetMinutes)}`;

          // Extract task text
          let taskText = removeTriggerWords(input)
            // Remove time with preceding preposition (all languages)
            .replace(/(?:на|в|о|у|at|on|um|à|às|aos|alle|a\s+las|o\s+godzinie)\s+\d{1,2}[:\-\.h]\d{2}/gi, '')
            .replace(/(?:на|в|о|у|at|on|um|à|às|aos|alle|a\s+las|o\s+godzinie)\s+\d{1,2}:\d{2}/gi, '')
            .replace(/\d{1,2}[:\-\.]\d{2}/g, '')
            .replace(/\b\d{1,2}h\d{2}\b/gi, '')
            // Remove precision words
            .replace(/\b(ровно|рівно|exactly|sharp|genau|exakt|exactement|pile|exactamente|en\s+punto|dokładnie|równo|esattamente|in\s+punto|exatamente|em\s+ponto)\b/gi, '')
            // Remove "next/следующий/наступний" modifiers
            .replace(/\b(следующ(?:ий|ую|его)|ближайш(?:ий|ую)|наступн(?:ий|ого|ій|у)|найближч(?:ий|у))\b/gi, '')
            .replace(/\b(next|upcoming|this\s+coming|nächsten?|nächste[rn]?|kommenden?|prochain[e]?|pr[oó]xim[ao]|następn(?:y|a)|najbliższ(?:y|a)|prossim[ao])\b/gi, '')
            // Remove date words (all 9 languages)
            .replace(/(завтра|tomorrow|morgen|demain|ma[nñ]ana|jutro|domani|amanh[aã])/gi, '')
            .replace(/(послезавтра|після\s*завтра|позавтра|übermorgen|après-demain|pojutrze|dopodomani|depois\s*de\s*amanh[aã])/gi, '')
            .replace(/(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi|hoje)/gi, '')
            // Remove period words (all languages)
            .replace(/(вечора|вечера|вечором|увечері|ввечері|ранку|вранці|зранку|утра|ночи|дня)/gi, '')
            .replace(/\b(evening|morning|night|afternoon|noon|pm|am|abends|morgens|soir|matin|noche|tarde|sera|mattina|manhã|noite|rano|wieczorem?)\b/gi, '')
            .replace(/[ap]\.m\./gi, '')
            .replace(/\b(horas?|heures?|Stunden?|hours?|ore\b)\b/gi, '')
            .replace(/(?:^|\s)(à|às)\s+\d+\s*/gi, ' ')
            // Remove connector words at start (FR d', ES que, PL że, IT di, PT de)
            .replace(/^(d['\u2019]|que\s+|\u017ce\s+|\u017ceby\s+|di\s+|de\s+|da\s+)/i, '')
            // Remove leftover single prepositions at start
            .replace(/^(на|в|о|у|o)\s+/i, '')
            .replace(/\s+/g, ' ').trim();

          taskText = cleanTaskText(taskText);
          if (DEBUG) console.log(`[PRE24] "${input}" → ${datetime} (task: "${taskText}")`);
          return res.json({ ok: true, text: taskText, datetime, source: 'pre' });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Whitelist: medical/everyday words that trigger false positives
    const medicalWhitelist = /таблетк|таблет|пігулк|пілюл|ліки|лікарств|лекарств|препарат|вітамін|витамин|аспірин|аспирин|ібупрофен|ибупрофен|парацетамол|антибіотик|антибиотик|краплі|капли|сироп|укол|укол|ін'єкц|инъекц|мазь|порошок|микстур|настойк|настоянк|\bpill|\btablet|\bmedicine|\bmedication|\bvitamin|\baspirin|\bibuprofen|\bparacetamol|\bantibiotic|\bdrops|\bsyrup|\bdrug\b|\bdose\b|\bTablette|\bMedikament|\bVitamin|\bPille|\bKapsel|\bSalbe|\bTropfen|\bmédicament|\bcomprimé|\bvitamine|\bgélule|\bsirop|\bmedicamento|\bpastilla|\bvitamina|\bcápsula|\bjarabe|\btabletk|\bwitamin|\blek\b|\bleku\b|\bleki\b|\bleków\b|\bmaść\b|\bkrople\b|\bmedicin|\bcompress|\bvitamin|\bcapsul|\bsciroppo|\bpastiglie|\bfiala|\bremédio|\bcomprimido|\bvitamina|\bcápsula|\bxarope|\bdose\b/i;
    const isMedicalContext = medicalWhitelist.test(input);

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
        // Skip self-harm flag if input contains medical/medication words (false positive)
        const onlySelfHarm = cats.split(',').map(s=>s.trim())
          .every(c => c.startsWith('self-harm') || c.startsWith('self_harm'));
        if (isMedicalContext && onlySelfHarm) {
          if (DEBUG) console.log(`[MODERATION] False positive skipped for medical context: "${input}"`);
        } else {
          console.warn(`[MODERATION] Flagged: "${input}" — categories: ${cats}`);
          return res.status(200).json({ ok: false, error: "moderated", categories: cats });
        }
      }
    } catch (modErr) {
      // Если модерация недоступна — продолжаем без неё
      console.warn("[MODERATION] skipped:", modErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const systemPrompt = buildPrompt(nowIso, offStr(offsetMinutes), localNow, offsetMinutes, lang);

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
      if (DEBUG) console.log(`[AI RAW] "${input}" → ${raw}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.datetime) {
          const dt = new Date(parsed.datetime);
          if (!isNaN(dt.getTime())) result = parsed;
        } else if (parsed.text !== undefined && parsed.datetime === '') {
          // AI returned task with no time — will show time picker with cleaned text
          if (DEBUG) console.log(`[NO TIME] "${input}" → task: "${parsed.text}"`);
          return res.json({ ok: true, text: parsed.text || input, datetime: '', source: 'unparsed' });
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
            if (DEBUG) console.log(`[AFTERNOON FIX] ${p2(rHour)}:${p2(rMin2)} + afternoon word → ${p2(correctedH)}:${p2(rMin2)}: ${correctedIso}`);
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
        // Weekdays UK — all forms (у/в + nominative/accusative)
        'у\\s*понеділок','у\\s*понедiлок','у\\s*вівторок','у\\s*вiвторок',
        'у\\s*середу','у\\s*четвер','у\\s*п\'ятницю','у\\s*п.ятницю',
        'у\\s*суботу','у\\s*неділю','у\\s*недiлю',
        'в\\s*понеділок','в\\s*понедiлок','в\\s*вівторок','в\\s*вiвторок',
        'в\\s*середу','в\\s*четвер','в\\s*п\'ятницю',
        'в\\s*суботу','в\\s*неділю',
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
        'w\\s*poniedzia[lł]ek','we?\\s*wtorek','w\\s*[sś]rod[ęae]','w\\s*czwartek','w\\s*pi[aą]tek','w\\s*sobot[ęae]','w\\s*niedziel[ęae]',
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
              if (DEBUG) console.log(`[FIX] ${p2(rH)}:${p2(rMin)} > ${p2(nowH)}:${p2(nowMin)}, no explicit tomorrow → today: ${todayIso}`);
              result = { ...result, datetime: todayIso };
            }
          } else if (diffDays === 0) {
            // AI returned today but time has already passed → move to tomorrow
            const nowH = localNow.getHours(), nowMin = localNow.getMinutes();
            const statedMinutes  = rH * 60 + rMin;
            const currentMinutes = nowH * 60 + nowMin;
            if (statedMinutes <= currentMinutes) {
              // Check if input had explicit "today" word — if so still move to tomorrow (time passed)
              const tomorrowDt = new Date(localNow);
              tomorrowDt.setDate(tomorrowDt.getDate() + 1);
              const tomorrowIso = `${String(tomorrowDt.getFullYear()).padStart(4,'0')}-${p2(tomorrowDt.getMonth()+1)}-${p2(tomorrowDt.getDate())}T${p2(rH)}:${p2(rMin)}:00${offStr(offsetMinutes)}`;
              if (DEBUG) console.log(`[FIX] ${p2(rH)}:${p2(rMin)} ≤ ${p2(nowH)}:${p2(nowMin)}, today but past → tomorrow: ${tomorrowIso}`);
              result = { ...result, datetime: tomorrowIso };
            }
          }
        } else if (hasExplicitDate) {
          if (DEBUG) console.log(`[FIX] skipped — explicit date word detected in: "${input}"`);
          // But still check: if AI returned a PAST date with weekday → fix to future
          try {
            const resultDt2 = new Date(result.datetime);
            const nowDateOnly2 = new Date(Date.UTC(localNow.getFullYear(), localNow.getMonth(), localNow.getDate()));
            const resultDateOnly2 = new Date(Date.UTC(resultDt2.getFullYear(), resultDt2.getMonth(), resultDt2.getDate()));
            if (resultDateOnly2 < nowDateOnly2) {
              // Past date — add 7 days to make it future
              const fixedDt = new Date(resultDt2);
              fixedDt.setDate(fixedDt.getDate() + 7);
              const fixedIso = fixedDt.toISOString().replace('Z', offStr(offsetMinutes)).slice(0, 19) + offStr(offsetMinutes);
              if (DEBUG) console.log(`[FIX] Past weekday date ${result.datetime} → ${fixedIso}`);
              result = { ...result, datetime: fixedIso };
            }
          } catch(e) { console.warn('[FIX weekday] error:', e.message); }
        }
      } catch (fixErr) {
        console.warn("[FIX] error:", fixErr.message);
      }
      // ─────────────────────────────────────────────────────────────────────────

      if (DEBUG) console.log(`[OK] "${input}" → ${result.datetime}`);

      // Clean AI result text from leftover prepositions/date words
      if (result.text) {
        result = { ...result, text: result.text
          .replace(/\b(вчора|вчера|yesterday|gestern|hier|ayer|wczoraj|ieri|ontem)\b/gi, '')
          .replace(/^(на|в|о|у|on|am|le|el|a|o)\s+/i, '')
          .replace(/\s+(на|в|о|у)\s*$/i, '')
          .replace(/\s+/g, ' ').trim()
        };
      }

      // If AI returned empty text (only trigger words, no real task) → ok:false
      // App will show "Almost ready" sheet to pick time
      const resultText = (result.text || '').trim();
      if (!resultText || resultText === input.trim()) {
        // Only skip if input has NO time references at all
        const hasTimeRefTrigger = (
          /\d{1,2}[:h]\d{2}/.test(normInputGlobal) ||
          /\d+\s*(мин|час|хв|годин|min|hour|heure|hora|minuto|ora|Minute|Stunde|minut[aey]?|godzin)/i.test(normInputGlobal) ||
          /(утра|вечера|ночи|дня|утром|вечером|ранку|вечора)/i.test(normInputGlobal) ||
        /(годину|години|годин|години)/i.test(normInputGlobal) ||  // UK hours word form
          /\b(morning|evening|night|afternoon|midnight|noon)\b/i.test(normInputGlobal) ||
          /\b(matin|soir|après-midi|minuit|midi)\b/i.test(normInputGlobal) ||
          /\b(mañana|tarde|noche|mediodía|medianoche)\b/i.test(normInputGlobal) ||
          /\b(rano|wieczor|południe|północ)\b/i.test(normInputGlobal) ||
          /\b(mattina|sera|pomeriggio|mezzanotte|mezzogiorno)\b/i.test(normInputGlobal) ||
          /\b(manhã|tarde|noite|madrugada|meia-noite|meio-dia)\b/i.test(normInputGlobal) ||
          /\bdaqui\s+a\s+\d/i.test(normInputGlobal) ||
          /\bdentro\s+de\s+\d/i.test(normInputGlobal) ||
          /\b(morgens|abends|nachts|mittags|Uhr)\b/i.test(normInputGlobal) ||
          /(?:in|dans|en|tra|fra|em|za|через|за)\s+\d+\s*(?:h\b|heures?|horas?|ore?\b|godzin)/i.test(normInputGlobal) ||
          /(?:^|\s)(?:à|às|alle)\s+\d{1,2}h\b/i.test(normInputGlobal) ||    // FR/IT bare Nh
          /\bam\b/i.test(normInputGlobal) || /\bpm\b/i.test(normInputGlobal) || /[ap]\.m\./i.test(normInputGlobal) ||
          /\bo\s+\d/i.test(normInputGlobal) || /\bo\s+godzinie\b/i.test(normInputGlobal) ||
          /(?:^|\s)à\s+\d/i.test(normInputGlobal) || /(?:^|\s)às\s+\d/i.test(normInputGlobal) ||
          /(?:^|\s)aos\s+\d/i.test(normInputGlobal) ||
          /\balle\s+\d/i.test(normInputGlobal) || /\bum\s+\d/i.test(normInputGlobal) ||
          /\ba\s+las\s+\d/i.test(normInputGlobal) || /\bat\s+\d/i.test(normInputGlobal) ||
          /\b(eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+Uhr\b/i.test(normInputGlobal)
        );
        const triggerOnly = !hasTimeRefTrigger && /^[\s\p{P}]*(поставь|напомни|нагадай|remind|set a reminder|erinnere|rappelle|recuérdame|przypomnij|ricordami|lembra)[\s\p{P}]*мне?[\s\p{P}]*$/iu.test(input.trim());
        if (triggerOnly) {
          if (DEBUG) console.log(`[SKIP] trigger-only input, no task: "${input}"`);
          return res.json({ ok: false, reason: 'no_task' });
        }
      }

      // If AI returned 09:00 but input had no explicit time → it's a default, show picker
      const hasTimeRef = (
        /\d{1,2}[:h]\d{2}/.test(normInputGlobal) ||                                          // 9:00 8h30
        /\d+\s*(мин|час|хв|годин|min|hour|heure|hora|minuto|ora|Minute|Stunde|minut[aey]?|godzin)/i.test(normInputGlobal) || // intervals
        /(утра|вечера|ночи|дня|утром|вечером|ранку|вечора)/i.test(normInputGlobal) ||
        /(годину|години|годин|години)/i.test(normInputGlobal) ||  // UK hours word form    // RU/UK period
        /\b(morning|evening|night|afternoon|midnight|noon)\b/i.test(normInputGlobal) ||       // EN period
        /\b(matin|soir|après-midi|minuit|midi)\b/i.test(normInputGlobal) ||                  // FR period
        /\b(mañana|tarde|noche|mediodía|medianoche)\b/i.test(normInputGlobal) ||             // ES period
        /\b(rano|wieczor|południe|północ|południu)\b/i.test(normInputGlobal) ||              // PL period
        /\b(mattina|sera|pomeriggio|mezzanotte|mezzogiorno)\b/i.test(normInputGlobal) ||     // IT period
        /\b(manhã|tarde|noite|madrugada|meia-noite|meio-dia)\b/i.test(normInputGlobal) ||    // PT period
        /\bdaqui\s+a\s+\d/i.test(normInputGlobal) ||                                           // PT daqui a N
        /\bdentro\s+de\s+\d/i.test(normInputGlobal) ||                                         // ES dentro de N
        /\bpara\s+\d+\s*(?:minutos?|horas?)/i.test(normInputGlobal) ||                         // PT para N min/h
        /\b(morgens|abends|nachts|mittags|Uhr)\b/i.test(normInputGlobal) ||                  // DE period
        /(?:in|dans|en|tra|fra|em|za|через|за)\s+\d+\s*(?:h\b|heures?|horas?|ore?\b|godzin)/i.test(normInputGlobal) ||  // Nh format
        /(?:^|\s)(?:à|às|alle)\s+\d{1,2}h\b/i.test(normInputGlobal) ||    // FR/IT à 20h
        /\bam\b/i.test(normInputGlobal) ||                                                    // EN am (word boundary)
        /\bpm\b/i.test(normInputGlobal) || /[ap]\.m\./i.test(normInputGlobal) ||                       // EN pm / p.m.
        /\bo\s+\d/i.test(normInputGlobal) ||                                                  // PL/IT "o 9"
        /\bo\s+godzinie\b/i.test(normInputGlobal) ||                                          // PL "o godzinie"
        /(?:^|\s)à\s+\d/i.test(normInputGlobal) ||                                           // FR "à 9h"
        /(?:^|\s)às\s+\d/i.test(normInputGlobal) ||                                          // PT "às 9h"
        /(?:^|\s)aos\s+\d/i.test(normInputGlobal) ||                                         // PT "aos 10"
        /\balle\s+\d/i.test(normInputGlobal) ||                                               // IT "alle 9"
        /\bum\s+\d/i.test(normInputGlobal) ||                                                 // DE "um 9 Uhr"
        /\ba\s+las\s+\d/i.test(normInputGlobal) ||                                            // ES "a las 9"
        /\bat\s+\d/i.test(normInputGlobal) ||                                                 // EN "at 9"
        /\b(eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+Uhr\b/i.test(normInputGlobal) // DE word hours
      );
      if (!hasTimeRef && result.datetime) {
        // No time reference in input → AI invented a time → show picker instead
        if (DEBUG) console.log(`[NO TIME] No time in input, AI invented time → returning empty datetime for: "${input}"`);
        return res.json({ ok: true, text: result.text || input, datetime: '', source: 'unparsed' });
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
