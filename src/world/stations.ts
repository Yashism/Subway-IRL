/**
 * Mumbai Suburban Railway ("Mumbai local") stations for the three suburban lines, in running
 * order from the southern terminus. Station platforms in the world show these names.
 *
 * Sources (checked 2026-09-17):
 * - https://en.wikipedia.org/wiki/Western_line_(Mumbai_Suburban_Railway)  (station table: English, Marathi, code)
 * - https://en.wikipedia.org/wiki/Central_line_(Mumbai_Suburban_Railway)  (main line table, CSMT–Kalyan)
 * - https://en.wikipedia.org/wiki/Harbour_line_(Mumbai_Suburban_Railway)  (CSMT–Wadala Road and Wadala Road–Panvel tables)
 * - Marathi spellings cross-checked against the Marathi Wikipedia article titles
 *   (https://mr.wikipedia.org/, "<name> रेल्वे स्थानक") linked from each English station article.
 *   Sion has no Marathi article; its Marathi name शीव is from the Central line table.
 * Codes are the current Indian Railways codes where the tables list an old and a new one.
 */

export interface Station {
  en: string;
  /** Marathi, Devanagari script. */
  mr: string;
  code?: string;
}

export type LineId = 'western' | 'central' | 'harbour';
export const LINE_IDS: readonly LineId[] = ['western', 'central', 'harbour'];

export interface SuburbanLine {
  id: LineId;
  name: string;
  stations: readonly Station[];
  /** Destinations shown on train front boards. */
  termini: readonly string[];
}

const WESTERN: readonly Station[] = [
  { en: 'Churchgate', mr: 'चर्चगेट', code: 'CCG' },
  { en: 'Marine Lines', mr: 'मरीन लाइन्स', code: 'MEL' },
  { en: 'Charni Road', mr: 'चर्नी रोड', code: 'CYR' },
  { en: 'Grant Road', mr: 'ग्रँट रोड', code: 'GTR' },
  { en: 'Mumbai Central', mr: 'मुंबई सेंट्रल', code: 'MMCT' },
  { en: 'Mahalaxmi', mr: 'महालक्ष्मी', code: 'MX' },
  { en: 'Lower Parel', mr: 'लोअर परळ', code: 'PL' },
  { en: 'Prabhadevi', mr: 'प्रभादेवी', code: 'PBHD' },
  { en: 'Dadar', mr: 'दादर', code: 'DDR' },
  { en: 'Matunga Road', mr: 'माटुंगा रोड', code: 'MRU' },
  { en: 'Mahim Junction', mr: 'माहिम जंक्शन', code: 'MM' },
  { en: 'Bandra', mr: 'वांद्रे', code: 'BA' },
  { en: 'Khar Road', mr: 'खार रोड', code: 'KHAR' },
  { en: 'Santacruz', mr: 'सांताक्रुझ', code: 'STC' },
  { en: 'Vile Parle', mr: 'विलेपार्ले', code: 'VLP' },
  { en: 'Andheri', mr: 'अंधेरी', code: 'ADH' },
  { en: 'Jogeshwari', mr: 'जोगेश्वरी', code: 'JOS' },
  { en: 'Ram Mandir', mr: 'राम मंदिर', code: 'RMAR' },
  { en: 'Goregaon', mr: 'गोरेगाव', code: 'GMN' },
  { en: 'Malad', mr: 'मालाड', code: 'MDD' },
  { en: 'Kandivli', mr: 'कांदिवली', code: 'KILE' },
  { en: 'Borivali', mr: 'बोरीवली', code: 'BVI' },
  { en: 'Dahisar', mr: 'दहिसर', code: 'DIC' },
  { en: 'Mira Road', mr: 'मीरा रोड', code: 'MIRA' },
  { en: 'Bhayandar', mr: 'भाईंदर', code: 'BYR' },
  { en: 'Naigaon', mr: 'नायगाव', code: 'NIG' },
  { en: 'Vasai Road', mr: 'वसई रोड', code: 'BSR' },
  { en: 'Nallasopara', mr: 'नालासोपारा', code: 'NSP' },
  { en: 'Virar', mr: 'विरार', code: 'VR' },
];

const CENTRAL: readonly Station[] = [
  { en: 'Chhatrapati Shivaji Maharaj Terminus', mr: 'छत्रपती शिवाजी महाराज टर्मिनस', code: 'CSMT' },
  { en: 'Masjid', mr: 'मशीद', code: 'MSD' },
  { en: 'Sandhurst Road', mr: 'सँडहर्स्ट रोड', code: 'SNRD' },
  { en: 'Byculla', mr: 'भायखळा', code: 'BY' },
  { en: 'Chinchpokli', mr: 'चिंचपोकळी', code: 'CHP' },
  { en: 'Currey Road', mr: 'करी रोड', code: 'CRD' },
  { en: 'Parel', mr: 'परळ', code: 'PR' },
  { en: 'Dadar', mr: 'दादर', code: 'DR' },
  { en: 'Matunga', mr: 'माटुंगा', code: 'MTN' },
  { en: 'Sion', mr: 'शीव', code: 'SIN' },
  { en: 'Kurla', mr: 'कुर्ला', code: 'CLA' },
  { en: 'Vidyavihar', mr: 'विद्याविहार', code: 'VVH' },
  { en: 'Ghatkopar', mr: 'घाटकोपर', code: 'GC' },
  { en: 'Vikhroli', mr: 'विक्रोळी', code: 'VK' },
  { en: 'Kanjur Marg', mr: 'कांजुर मार्ग', code: 'KJRD' },
  { en: 'Bhandup', mr: 'भांडुप', code: 'BND' },
  { en: 'Nahur', mr: 'नाहूर', code: 'NHU' },
  { en: 'Mulund', mr: 'मुलुंड', code: 'MLND' },
  { en: 'Thane', mr: 'ठाणे', code: 'TNA' },
  { en: 'Kalwa', mr: 'कळवा', code: 'KLVA' },
  { en: 'Mumbra', mr: 'मुंब्रा', code: 'MBQ' },
  { en: 'Diva Junction', mr: 'दिवा जंक्शन', code: 'DIVA' },
  { en: 'Kopar', mr: 'कोपर', code: 'KOPR' },
  { en: 'Dombivli', mr: 'डोंबिवली', code: 'DI' },
  { en: 'Thakurli', mr: 'ठाकुर्ली', code: 'THK' },
  { en: 'Kalyan Junction', mr: 'कल्याण जंक्शन', code: 'KYN' },
];

const HARBOUR: readonly Station[] = [
  { en: 'Chhatrapati Shivaji Maharaj Terminus', mr: 'छत्रपती शिवाजी महाराज टर्मिनस', code: 'CSMT' },
  { en: 'Masjid', mr: 'मशीद', code: 'MSD' },
  { en: 'Sandhurst Road', mr: 'सँडहर्स्ट रोड', code: 'SNRD' },
  { en: 'Dockyard Road', mr: 'डॉकयार्ड रोड', code: 'DKRD' },
  { en: 'Reay Road', mr: 'रे रोड', code: 'RRD' },
  { en: 'Cotton Green', mr: 'कॉटन ग्रीन', code: 'CTGN' },
  { en: 'Sewri', mr: 'शिवडी', code: 'SVE' },
  { en: 'Wadala Road', mr: 'वडाळा रोड', code: 'VDLR' },
  { en: 'Guru Tegh Bahadur Nagar', mr: 'गुरू तेग बहादुर नगर', code: 'GTBN' },
  { en: 'Chunabhatti', mr: 'चुनाभट्टी', code: 'CHF' },
  { en: 'Kurla', mr: 'कुर्ला', code: 'CLA' },
  { en: 'Tilak Nagar', mr: 'टिळक नगर', code: 'TKNG' },
  { en: 'Chembur', mr: 'चेंबूर', code: 'CMBR' },
  { en: 'Govandi', mr: 'गोवंडी', code: 'GV' },
  { en: 'Mankhurd', mr: 'मानखुर्द', code: 'MNKD' },
  { en: 'Vashi', mr: 'वाशी', code: 'VSH' },
  { en: 'Sanpada', mr: 'सानपाडा', code: 'SNCR' },
  { en: 'Juinagar', mr: 'जुईनगर', code: 'JNJ' },
  { en: 'Nerul', mr: 'नेरूळ', code: 'NEU' },
  { en: 'Seawoods–Darave–Karave', mr: 'सीवूड्स-दारावे-करावे', code: 'SWDK' },
  { en: 'CBD Belapur', mr: 'सीबीडी बेलापूर', code: 'BEPR' },
  { en: 'Kharghar', mr: 'खारघर', code: 'KHAG' },
  { en: 'Mansarovar', mr: 'मानसरोवर', code: 'MANR' },
  { en: 'Khandeshwar', mr: 'खांदेश्वर', code: 'KNDS' },
  { en: 'Panvel', mr: 'पनवेल', code: 'PNVL' },
];

export const LINES: Readonly<Record<LineId, SuburbanLine>> = {
  western: { id: 'western', name: 'Western', stations: WESTERN, termini: ['CHURCHGATE', 'VIRAR', 'BORIVALI', 'ANDHERI'] },
  central: { id: 'central', name: 'Central', stations: CENTRAL, termini: ['CSMT', 'THANE', 'KALYAN'] },
  harbour: { id: 'harbour', name: 'Harbour', stations: HARBOUR, termini: ['CSMT', 'PANVEL', 'VASHI', 'ANDHERI'] },
};

export function isLineId(v: unknown): v is LineId {
  return v === 'western' || v === 'central' || v === 'harbour';
}

/** The line a run shows when none is chosen: deterministic from the world seed. */
export function lineForSeed(seed: number): LineId {
  const n = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 0;
  return LINE_IDS[n % LINE_IDS.length];
}

/** Index into a line's stations for the nth platform the runner meets (0-based), looping. */
export function stationIndex(count: number, n: number): number {
  return ((Math.floor(n) % count) + count) % count;
}

/** The station the nth platform (0-based, in running order) shows. */
export function stationForPlatform(line: LineId, n: number): Station {
  const list = LINES[line].stations;
  return list[stationIndex(list.length, n)];
}

/**
 * Running order number of platform `i` (index within one corridor period) in period repeat
 * `repeat`: the plan repeats every period, so numbering continues across repeats.
 */
export function platformNumber(repeat: number, i: number, perPeriod: number): number {
  return repeat * perPeriod + i;
}
