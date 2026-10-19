import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/** Normalize a user-entered phone number to E.164 (+15125550123). Returns null if it can't be dialed. */
export function normalizePhone(raw: string | undefined | null, defaultCountry: CountryCode = "US"): string | null {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  if (!cleaned) return null;
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number;
}

/** "+15125550123" -> "(512) 555-0123" for display / SMS. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatNational() : e164;
}

/** Phone number written so text-to-speech reads it digit by digit with natural pauses. */
export function speakablePhone(e164: string | null | undefined): string {
  const national = formatPhone(e164).replace(/\D/g, "");
  if (national.length === 10) {
    return `${national.slice(0, 3).split("").join(" ")}, ${national.slice(3, 6).split("").join(" ")}, ${national
      .slice(6)
      .split("")
      .join(" ")}`;
  }
  return national.split("").join(" ");
}
