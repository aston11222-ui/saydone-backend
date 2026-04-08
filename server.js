import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (_, res) => {
  res.send("Hybrid multilingual parser active");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function offsetMinutesToIso(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = pad2(Math.floor(abs / 60));
  const mm = pad2(abs % 60);
  return `${sign}${hh}:${mm}`;
}

function toIsoWithOffsetFromLocal(date, offsetMinutes) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    offsetMinutesToIso(offsetMinutes)
  );
}

function parseLocalNow(localNow) {
  const m = String(localNow).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) return null;

  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || "0"),
    0
  );
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

  if (/[іїєґ]/i.test(t)) return "uk";
  if (/[ыэёъ]/i.test(t)) return "ru";

  if (/\b(um|uhr|morgen|heute|abends|morgens|nachts|nachmittags|stunde|minuten|tagen?)\b/i.test(t)) {
    return "de";
  }
  if (/\b(demain|aujourd'hui|dans une heure|soir|matin|minutes?)\b/i.test(t)) {
    return "fr";
  }
  if (/\b(mañana|hoy|en una hora|de la noche|de la mañana|minutos?)\b/i.test(t)) {
    return "es";
  }
  if (/\b(jutro|dzisiaj|za godzinę|wieczorem|rano|minut)\b/i.test(t)) {
    return "pl";
  }
  if (/\b(domani|oggi|tra un'ora|sera|mattina|minuti?)\b/i.test(t)) {
    return "it";
  }
  if (/[a-z]/i.test(t)) return "en";

  return "unknown";
}

function cleanTaskText(text) {
  let t = normalizeWhitespace(text);

  t = t
    .replace(/^\s*(поставь напоминание|напомни|напомнить)\s+/i, "")
    .replace(/^\s*(поставити нагадування|нагадай|нагадати)\s+/i, "")
    .replace(/^\s*(remind me to|remind me)\s+/i, "")
    .replace(/^\s*(erinnere mich daran|erinnere mich)\s+/i, "")
    .replace(/^\s*(rappelle-moi de|rappelle-moi)\s+/i, "")
    .replace(/^\s*(recuérdame|recordarme|recuérdame que)\s+/i, "")
    .replace(/^\s*(przypomnij mi|przypomnij)\s+/i, "")
    .replace(/^\s*(ricordami di|ricordami)\s+/i, "");

  t = t
    .replace(/\b(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi)\b/gi, " ")
    .replace(/\b(завтра|tomorrow|morgen|demain|mañana|jutro|domani)\b/gi, " ");

  t = t
    .replace(/\bчерез\s+пол\s*часа\b/gi, " ")
    .replace(/\bчерез\s+полчаса\b/gi, " ")
    .replace(/\bчерез\s+час\b/gi, " ")
    .replace(/\bчерез\s+\d+\s*(минут[аы]?|минут|мин|час[аов]?|дн(?:я|ей)?|день)\b/gi, " ")
    .replace(/\bчерез\s+пів\s+години\b/gi, " ")
    .replace(/\bчерез\s+годину\b/gi, " ")
    .replace(/\bчерез\s+\d+\s*(хвилин|годин(?:и|)?|дн(?:і|ів))\b/gi, " ")
    .replace(/\bin\s+half\s+an\s+hour\b/gi, " ")
    .replace(/\bin\s+an\s+hour\b/gi, " ")
    .replace(/\bin\s+\d+\s*(minutes?|hours?|days?)\b/gi, " ")
    .replace(/\bin\s+einer\s+halben\s+stunde\b/gi, " ")
    .replace(/\bin\s+einer\s+stunde\b/gi, " ")
    .replace(/\bin\s+\d+\s*(minuten|stunden|tagen?)\b/gi, " ")
    .replace(/\bdans\s+une\s+demi-heure\b/gi, " ")
    .replace(/\bdans\s+une\s+heure\b/gi, " ")
    .replace(/\bdans\s+\d+\s*(minutes?|heures?|jours?)\b/gi, " ")
    .replace(/\ben\s+media\s+hora\b/gi, " ")
    .replace(/\ben\s+una\s+hora\b/gi, " ")
    .replace(/\ben\s+\d+\s*(minutos?|horas?|días?)\b/gi, " ")
    .replace(/\bza\s+pół\s+godziny\b/gi, " ")
    .replace(/\bza\s+godzinę\b/gi, " ")
    .replace(/\bza\s+\d+\s*(minut|minuty|godzin(?:ę|y)?|dni)\b/gi, " ")
    .replace(/\btra\s+mezz'?ora\b/gi, " ")
    .replace(/\btra\s+un'?ora\b/gi, " ")
    .replace(/\btra\s+\d+\s*(minuti?|ore|giorni)\b/gi, " ");

  t = t.replace(
    /\b(?:в|во|о|at|um|à|a las|o|alle)?\s*\d{1,2}(?:[:.\s]\d{2})?\s*(утра|утром|дня|вечера|вечером|ночи|ранку|вранці|вечора|увечері|ночі|morning|afternoon|evening|night|am|pm|morgens|nachmittags|abends|nachts|du matin|de l'après-midi|du soir|de la nuit|de la mañana|de la tarde|de la noche|rano|wieczorem|w nocy|di mattina|del pomeriggio|di sera|di notte)?\b/gi,
    " "
  );

  t = normalizeWhitespace(t);
  return t || normalizeWhitespace(text);
}

function parseRelative(text, now, offsetMinutes) {
  const src = text.toLowerCase();

  const patterns = [
    // RU
    { re: /\bчерез\s+пол\s*часа\b/i, amount: 30, unit: "minute" },
    { re: /\bчерез\s+полчаса\b/i, amount: 30, unit: "minute" },
    { re: /\bчерез\s+час\b/i, amount: 1, unit: "hour" },
    { re: /\bчерез\s+(\d+)\s*мин(?:ут[аы]?|ут|)\b/i, unit: "minute" },
    { re: /\bчерез\s+(\d+)\s*час(?:а|ов)?\b/i, unit: "hour" },
    { re: /\bчерез\s+(\d+)\s*дн(?:я|ей)?\b/i, unit: "day" },
    { re: /\bчерез\s+день\b/i, amount: 1, unit: "day" },

    // UA
    { re: /\bчерез\s+пів\s+години\b/i, amount: 30, unit: "minute" },
    { re: /\bчерез\s+годину\b/i, amount: 1, unit: "hour" },
    { re: /\bчерез\s+(\d+)\s*хвилин\b/i, unit: "minute" },
    { re: /\bчерез\s+(\d+)\s*годин(?:и|)?\b/i, unit: "hour" },
    { re: /\bчерез\s+(\d+)\s*дн(?:і|ів)\b/i, unit: "day" },

    // EN
    { re: /\bin\s+half\s+an\s+hour\b/i, amount: 30, unit: "minute" },
    { re: /\bin\s+an\s+hour\b/i, amount: 1, unit: "hour" },
    { re: /\bin\s+(\d+)\s*minutes?\b/i, unit: "minute" },
    { re: /\bin\s+(\d+)\s*hours?\b/i, unit: "hour" },
    { re: /\bin\s+(\d+)\s*days?\b/i, unit: "day" },

    // DE
    { re: /\bin\s+einer\s+halben\s+stunde\b/i, amount: 30, unit: "minute" },
    { re: /\bin\s+einer\s+stunde\b/i, amount: 1, unit: "hour" },
    { re: /\bin\s+(\d+)\s*minuten\b/i, unit: "minute" },
    { re: /\bin\s+(\d+)\s*stunden\b/i, unit: "hour" },
    { re: /\bin\s+(\d+)\s*tagen?\b/i, unit: "day" },

    // FR
    { re: /\bdans\s+une\s+demi-heure\b/i, amount: 30, unit: "minute" },
    { re: /\bdans\s+une\s+heure\b/i, amount: 1, unit: "hour" },
    { re: /\bdans\s+(\d+)\s*minutes?\b/i, unit: "minute" },
    { re: /\bdans\s+(\d+)\s*heures?\b/i, unit: "hour" },
    { re: /\bdans\s+(\d+)\s*jours?\b/i, unit: "day" },

    // ES
    { re: /\ben\s+media\s+hora\b/i, amount: 30, unit: "minute" },
    { re: /\ben\s+una\s+hora\b/i, amount: 1, unit: "hour" },
    { re: /\ben\s+(\d+)\s*minutos?\b/i, unit: "minute" },
    { re: /\ben\s+(\d+)\s*horas?\b/i, unit: "hour" },
    { re: /\ben\s+(\d+)\s*días?\b/i, unit: "day" },

    // PL
    { re: /\bza\s+pół\s+godziny\b/i, amount: 30, unit: "minute" },
    { re: /\bza\s+godzinę\b/i, amount: 1, unit: "hour" },
    { re: /\bza\s+(\d+)\s*minut(?:y)?\b/i, unit: "minute" },
    { re: /\bza\s+(\d+)\s*godzin(?:ę|y)?\b/i, unit: "hour" },
    { re: /\bza\s+(\d+)\s*dni\b/i, unit: "day" },

    // IT
    { re: /\btra\s+mezz'?ora\b/i, amount: 30, unit: "minute" },
    { re: /\btra\s+un'?ora\b/i, amount: 1, unit: "hour" },
    { re: /\btra\s+(\d+)\s*minuti?\b/i, unit: "minute" },
    { re: /\btra\s+(\d+)\s*ore\b/i, unit: "hour" },
    { re: /\btra\s+(\d+)\s*giorni\b/i, unit: "day" },
  ];

  for (const p of patterns) {
    const m = src.match(p.re);
    if (!m) continue;

    const amount = p.amount ?? Number(m[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const dt = new Date(now);
    if (p.unit === "minute") dt.setMinutes(dt.getMinutes() + amount);
    if (p.unit === "hour") dt.setHours(dt.getHours() + amount);
    if (p.unit === "day") dt.setDate(dt.getDate() + amount);

    return {
      text: cleanTaskText(text),
      datetime: toIsoWithOffsetFromLocal(dt, offsetMinutes),
    };
  }

  return null;
}

function periodTo24Hour(hour, period) {
  const h = Number(hour);
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  if (h > 12) return h;

  const p = (period || "").toLowerCase();

  const morning = [
    "утра", "утром", "ранку", "вранці", "morning", "am", "morgens",
    "du matin", "de la mañana", "rano", "di mattina"
  ];
  const afternoon = [
    "дня", "afternoon", "nachmittags", "de l'après-midi",
    "de la tarde", "del pomeriggio"
  ];
  const evening = [
    "вечера", "вечером", "вечора", "увечері", "evening", "pm", "abends",
    "du soir", "de la noche", "wieczorem", "di sera"
  ];
  const night = [
    "ночи", "ночью", "ночі", "вночі", "night", "nachts",
    "de la nuit", "w nocy", "di notte"
  ];

  if (morning.includes(p)) {
    if (h === 12) return 0;
    return h;
  }
  if (afternoon.includes(p)) {
    if (h === 12) return 12;
    return h + 12;
  }
  if (evening.includes(p)) {
    if (h === 12) return 12;
    return h + 12;
  }
  if (night.includes(p)) {
    if (h === 12) return 0;
    return h;
  }

  return h;
}

function parseAbsolute(text, now, offsetMinutes) {
  const src = text.toLowerCase();

  const hasTomorrow = /\b(завтра|tomorrow|morgen|demain|mañana|jutro|domani)\b/i.test(src);
  const hasToday = /\b(сегодня|сьогодні|today|heute|aujourd'hui|hoy|dzisiaj|oggi)\b/i.test(src);

  let m = src.match(/\b(?:в|во|о|at|um|à|a las|o|alle)?\s*(\d{1,2})[:.\s](\d{2})\b/i);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const dt = new Date(now);
      dt.setHours(hour, minute, 0, 0);

      if (hasTomorrow) dt.setDate(dt.getDate() + 1);
      else if (!hasToday && dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 1);

      return {
        text: cleanTaskText(text),
        datetime: toIsoWithOffsetFromLocal(dt, offsetMinutes),
      };
    }
  }

  m = src.match(
    /\b(?:в|во|о|at|um|à|a las|o|alle)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(утра|утром|дня|вечера|вечером|ночи|ранку|вранці|вечора|увечері|ночі|morning|afternoon|evening|night|am|pm|morgens|nachmittags|abends|nachts|du matin|de l'après-midi|du soir|de la nuit|de la mañana|de la tarde|de la noche|rano|wieczorem|w nocy|di mattina|del pomeriggio|di sera|di notte)\b/i
  );

  if (m) {
    const hour12 = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const period = m[3];
    const hour24 = periodTo24Hour(hour12, period);

    if (hour24 != null && minute >= 0 && minute <= 59) {
      const dt = new Date(now);
      dt.setHours(hour24, minute, 0, 0);

      if (hasTomorrow) dt.setDate(dt.getDate() + 1);
      else if (!hasToday && dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 1);

      return {
        text: cleanTaskText(text),
        datetime: toIsoWithOffsetFromLocal(dt, offsetMinutes),
      };
    }
  }

  return null;
}

app.post("/parse", async (req, res) => {
  try {
    const { text, locale, local_now, utc_offset_minutes } = req.body ?? {};

    if (!text || !local_now || typeof utc_offset_minutes !== "number") {
      return res.status(400).json({
        ok: false,
        error: "Missing text, local_now or utc_offset_minutes",
      });
    }

    const cleanedText = normalizeWhitespace(text);
    const localNow = parseLocalNow(local_now);

    if (!localNow) {
      return res.status(400).json({
        ok: false,
        error: "Invalid local_now format",
      });
    }

    const lang = detectLang(locale, cleanedText);

    const relative = parseRelative(cleanedText, localNow, utc_offset_minutes);
    if (relative) {
      return res.json({
        ok: true,
        text: relative.text,
        datetime: relative.datetime,
        lang,
        source: "relative_rule",
      });
    }

    const absolute = parseAbsolute(cleanedText, localNow, utc_offset_minutes);
    if (absolute) {
      return res.json({
        ok: true,
        text: absolute.text,
        datetime: absolute.datetime,
        lang,
        source: "absolute_rule",
      });
    }

    return res.json({
      ok: true,
      text: cleanedText,
      datetime: "",
      lang,
      source: "unparsed",
    });
  } catch (e) {
    console.error("PARSE ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "server_error",
    });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
