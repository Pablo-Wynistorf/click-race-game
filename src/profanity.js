import Filter from "bad-words";
import leo from "leo-profanity";

const badWords = new Filter();

// Load both English + German dictionaries
leo.clearList();
leo.loadDictionary("en");
leo.loadDictionary("de");

const L33T_MAP = {
  "0": "o",
  "1": "i",
  "2": "z",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  "$": "s",
  "@": "a",
  "!": "i",
  "|": "i",
  "+": "t",
  "¿": "i",
  "€": "e",
  "£": "l",
  "¥": "y",
  "ß": "ss",
  "ä": "ae",
  "ö": "oe",
  "ü": "ue",
  "§": "s",
  "¢": "c",
  "¶": "p",
  "∆": "d",
  "∑": "sum",
};


function normalize(str) {
  const lower = (str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, ""); // removes accents like ä → a

  return lower
    .replace(/[013457@$ß]/g, c => L33T_MAP[c] || c) // handle leetspeak + ß
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeName(input) {
  let raw = (input || "")
    .slice(0, 24) // max length 24
    .replace(/[\u0000-\u001f\u007f]/g, "") // strip control chars
    .trim();

  if (!raw) return null;

  const norm = normalize(raw);
  let clean = raw;

  if (leo.check(norm)) clean = leo.clean(raw, "*");
  if (badWords.isProfane(norm)) clean = badWords.clean(clean);

  // Second pass: if still bad, reject
  if (leo.check(normalize(clean)) || badWords.isProfane(normalize(clean))) {
    return null;
  }

  return clean;
}
