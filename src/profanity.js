import Filter from "bad-words";
import leo from "leo-profanity";

const badWords = new Filter();
leo.loadDictionary();

const L33T_MAP = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a" };

function normalize(str) {
  const lower = (str || "").toLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "");
  return lower
    .replace(/[013457@$]/g, c => L33T_MAP[c] || c)
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeName(input) {
  let raw = (input || "")
    .slice(0, 24)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!raw) return null;

  const norm = normalize(raw);
  let clean = raw;

  if (leo.check(norm)) clean = leo.clean(raw, "*");
  if (badWords.isProfane(norm)) clean = badWords.clean(clean);

  if (leo.check(normalize(clean)) || badWords.isProfane(normalize(clean))) return null;
  return clean;
}
