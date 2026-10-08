//Phone numbers, in the one form Attio stores and matches on.
//
//This lives on its own because every provider needs it and none of them owns it. Aircall reports a number
//punctuated for display ("+1 949-735-4000"); Instantly stores whatever was uploaded; Attio stores and matches
//E.164 ("+19497354000"). A lookup keyed on any other spelling silently misses, and a miss creates a duplicate
//Person rather than matching the real one - which is why there is exactly one implementation of this.

//=============================================================================================================
//#region <types and globals>

//[LOGIC] E.164 allows 15 digits at most, and needs a country code plus a national number to be dialable. A
//shorter string is a fragment - an extension, a local number with the area code lost - and writing it to Attio
//would put a number in the CRM that is dialled once and then distrusted.
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <normalise phone numbers>

//#region <to e.164>
//---------------------------------------------------------------------------------------------------------
//[LOGIC] Any spelling of a phone number into E.164, or null when it is not one.
//FLOW: 1. no input -> null. 2. strip everything that is not a digit, which also discards a "+" wherever it sat.
//3. reject a digit count outside E.164's range. 4. put a single leading "+" back.
//Step 2 discards rather than preserves the "+": a number arriving as "555+123" would otherwise produce
//"+555+123", which is not a phone number in any format.
//USES: nothing. Pure.
//---------------------------------------------------------------------------------------------------------
export function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
  return `+${digits}`;
}
//#endregion

//#endregion
//=============================================================================================================
