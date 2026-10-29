// Ordnet Merkmalsbegriffe in Schlüsseltexten den Zeichnungen der Innenklappe zu (Index = Position in IDX.gloss).
const N = s => ' ' + String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const E = '(?:e|er|en|es|em|n)?'; // Beugungsendungen
// [Muster (auf normalisiertem Text), Zeichnung, Bedingung im Umfeld (optional)]
const RULES = [
  ['halbkugelig' + E, 10], ['kugelig' + E, 0], ['walzenformig' + E, 1], ['eiformig' + E, 2], ['glockig' + E, 3],
  ['(?:kegelig|konisch|kegelformig)' + E, 4], ['spitz gebuckelt' + E, 6], ['(?:spitz|zitzenformig|spitzem) (?:buckel)', 6],
  ['(?:stumpf )?gebuckelt' + E, 5], ['buckel(?:ig)?' + E, 5], ['(?:gewolbt|konvex)' + E, 7], ['ausgebreitet' + E, 8],
  ['(?:niedergedruckt|vertieft|eingedellt)' + E, 9], ['(?:trichterig|trichterformig|trichter)' + E, 11], ['durchbohrt' + E, 12],
  ['(?:genabelt|nabel|nabelig)' + E, 13],
  ['velumflock' + E, 14], ['(?:flocken|flockig|warzen) (?:auf dem hut|auf der huthaut)', 14], ['(?:hut|huthaut)[a-z ]{0,25}(?:flockig|warzig)', 14],
  ['(?:gezont|zoniert|konzentrisch gezont|zonierung)' + E, 15], ['(?:feldrig|felderig) (?:aufgerissen|aufreissend|rissig)?', 16],
  ['radialfaserig' + E, 18], ['eingewachsen faserig' + E, 18],
  ['[a-z]{0,8}schuppig' + E, 19, /hut|oberflache/],
  ['velumrest' + E, 20], ['behangen' + E, 20],
  ['(?:gerieft|gestreift|geriefelt)' + E, 21, /rand|hut/, /ring|manschette/], ['radialrissig' + E, 22], ['rand[a-z ]{0,20}rissig', 22], ['kraus' + E, 23, /rand/],
  ['untermischt' + E, 24], ['lamelletten', 24], ['entfernt' + E, 24, /lamell| l /], ['(?:gedrangt|eng stehend|engstehend|dicht stehend)' + E, 25],
  ['schmal' + E, 26, /lamell| l /], ['breit' + E, 27, /lamell| l /, /breit angewachsen|breit elliptisch|breitelliptisch/],
  ['(?:queraderig|anastomosierend|aderig verbunden|querverbunden)' + E, 28], ['(?:gegabelt|gabelig|gabelnd)' + E, 29],
  ['gesagt' + E, 31], ['gekerbt' + E, 32], ['(?:schneide|schneiden)[a-z ]{0,15}(?:gekerbt|gesagt|gezahnelt|bewimpert)', 31],
  ['(?:gerade|breit) angewachsen' + E, 33], ['(?:ausgebuchtet|buchtig)' + E, 34], ['mit zahn' + E, 35], ['(?:zahnchen|zahn) herablaufend' + E, 35],
  ['frei' + E, 36, /lamell| l /], ['herablaufend' + E, 37],
  ['wurzel(?:nd|ig|artig)' + E, 38], ['wurzelnd' + E, 38], ['gekniet' + E, 39], ['zylindrisch' + E, 40], ['bauchig' + E, 41],
  ['(?:spitze|oben) verjungt' + E, 42], ['basis zugespitzt' + E, 43], ['(?:spindelig|zugespitzt)' + E, 43, /stiel|basis/],
  ['[a-z]{0,6}knollig' + E, 44, null, /sporen/], ['knolle', 44], ['(?:keulig|keulenformig)' + E, 45, /stiel|basis/],
  ['raufaserig' + E, 46], ['(?:geschuppt|schuppchen)' + E, 46, /stiel/], ['(?:wattig|ausgestopft)' + E, 47],
  ['(?:netzig|genetzt|netz)' + E, 48, /stiel/, /sporen|spp|ornament/], ['(?:flockig|beflockt|flocken)' + E, 49, /stiel/],
  ['(?:genattert|natterung)' + E, 50], ['langsfaserig' + E, 51], ['hohl' + E, 52, /stiel/], ['gekammert' + E, 53],
  ['aufsteigend' + E, 54, /ring|manschette/], ['(?:schleierreste|cortina|schleier)' + E, 55],
  ['(?:volva|scheide|scheidenartig|lappig)' + E, 56, null, /scheidenstreifling|scheidling/], ['eingepfropft' + E, 57],
  ['(?:zwiebelig|gerandet|abgesetzt)' + E, 58, /knoll|basis/], ['gegurtelt' + E, 59], ['warzig' + E, 59, /knoll|basis/, /sporen|spp|ornament/],
  ['(?:herabhangend|hangend|beringt)' + E, 61], ['(?:ring|manschette)', 61], ['doppelt' + E, 62, /ring/]
].map(([re, g, need, not]) => ({re: new RegExp(' ' + re + ' ', 'g'), g, need, not, wide: g === 58 || g === 59}));
const SUPERSEDES = {6: [5], 10: [0], 35: [37]}; // genauere Zeichnung verdrängt gröbere

const ADJ = /(end|ig|isch|lich|ert|elt|t)(e|er|en|es|em)?$/;
export function glossMatches(text, max = 4) {
  const t = N(text);
  const orig = String(text || '').split(/[^A-Za-zÄÖÜäöüß0-9]+/).filter(Boolean);
  const hits = [];
  for (const r of RULES) {
    if (hits.includes(r.g)) continue;
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 30), m.index + 1), around = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 25);
      const after = t.slice(m.index + m[0].length - 1, m.index + m[0].length + 22);
      r.re.lastIndex = m.index + 1;
      const wi = (t.slice(0, m.index + 1).match(/ /g) || []).length - 1, ow = orig[wi] || '';
      if (wi > 0 && /^[A-ZÄÖÜ]/.test(ow) && ADJ.test(ow)) continue; // Teil eines Artnamens, z. B. „Wurzelnder Rübling“
      if (/^ (weitgehend |vollig |ganz )?(fehlend|fehlen|abwesend)/.test(after)) continue;
      if (/ (nicht|ohne|kein|keine|weder)( [a-z]+){0,2} $/.test(before)) continue;
      if (/ (sporen|spp|sp) /.test(before.slice(-22))) continue;
      const ctx = r.wide ? around : t.slice(Math.max(0, m.index - 45), m.index + m[0].length);
      if (r.need && !r.need.test(ctx)) continue;
      if (r.not && r.not.test(around)) continue;
      hits.push(r.g); break;
    }
    if (hits.length >= max) break;
  }
  return hits.filter(g => !hits.some(h => (SUPERSEDES[h] || []).includes(g)));
}
