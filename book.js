// Liest Texte aus dem eigenen PDF des Kosmos-Handbuchs. Enthält selbst keinen Buchtext,
// nur die Logik, um anhand der Koordinaten aus kosmos-index.json die passenden Stellen zu finden.

const esc = s => s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

export async function pageItems(doc, p) {
  const page = await doc.getPage(p + 1);
  const H = page.view[3];
  const [tc] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  const fonts = {};
  const fontName = id => {
    if (!(id in fonts)) { let n = ''; try { n = page.commonObjs.get(id)?.name || ''; } catch {} fonts[id] = n; }
    return fonts[id];
  };
  const items = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const t = it.transform, size = Math.hypot(t[2], t[3]) || Math.abs(t[3]);
    const f = fontName(it.fontName);
    items.push({s: it.str, x: t[4], y: H - t[5], z: size, w: it.width,
      b: /Bold|Black/.test(f), blk: /Black/.test(f), i: /Ita/.test(f), arrow: /Dingbat/.test(f) && it.str.trim() === 'R'});
  }
  return items;
}

function lines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const it of sorted) {
    const mid = it.y - it.z * 0.35;
    const L = out.find(l => Math.abs(l.mid - mid) < 2.2);
    if (L) L.items.push(it); else out.push({mid, items: [it]});
  }
  out.sort((a, b) => a.mid - b.mid);
  for (const l of out) l.items.sort((a, b) => a.x - b.x);
  return out;
}

const NOSPACE_NEXT = /^(und|oder|bis|sowie|u\.)\b/;
// Baut aus Zeilen eine Folge von Text-Läufen {t, b, i, arrow, label}
function runs(lineList, {labels = false} = {}) {
  const out = [];
  let prevEnd = null;
  const push = (t, it) => {
    const last = out[out.length - 1];
    const style = {b: it.b, i: it.i, arrow: it.arrow, label: labels && it.blk && /^\s*[A-ZÄÖÜ][A-Za-zäöü]{0,3}\s*$/.test(it.s)};
    if (/^SP\s*$/.test(it.s.trim()) && it.b && labels) style.label = true;
    if (last && !style.label && !last.label && last.b === style.b && last.i === style.i && !last.arrow && !style.arrow) last.t += t;
    else out.push({t, ...style});
  };
  lineList.forEach((L, li) => {
    // Bindestriche: im Buch sind alle als U+00AD codiert. Innerhalb der Zeile echte Bindestriche.
    const n = L.items.length;
    L.items.forEach((it, k) => {
      let s = it.s;
      const isLast = k === n - 1 || L.items.slice(k + 1).every(x => !x.s.trim());
      s = isLast ? s.replace(/\u00ad(?=.)/g, '-') : s.replace(/\u00ad/g, '-');
      if (it.arrow) { out.push({t: '', arrow: true}); return; }
      if (k > 0) {
        const p = L.items[k - 1];
        if (it.x - (p.x + p.w) > 1.2 && !/\s$/.test(p.s) && !/^\s/.test(s)) s = ' ' + s;
      } else if (li > 0 && out.length) {
        const last = out[out.length - 1];
        const prevTxt = last.t, nxt = s.trim();
        if (/\u00ad\s*$/.test(prevTxt)) {
          const prevWord = (prevTxt.match(/([A-Za-zÄÖÜäöüß]+)\u00ad\s*$/) || [])[1] || '';
          const nextWord = (nxt.match(/^[a-zäöüß]+/) || [''])[0];
          const compound = /(ig|lich|isch|haft|los)$/.test(prevWord) && !/fleisch$/i.test(prevWord) && prevWord.length > 4 && nextWord.length >= 5 && !/^(keit|lich|ung|en\b)/.test(nextWord);
          if (/^[a-zäöüß]/.test(nxt) && !NOSPACE_NEXT.test(nxt) && !compound) last.t = prevTxt.replace(/\u00ad\s*$/, '');
          else { last.t = prevTxt.replace(/\u00ad\s*$/, '-'); if (NOSPACE_NEXT.test(nxt)) s = ' ' + s.replace(/^\s+/, ''); }
        } else if (!/\s$/.test(prevTxt) && !last.arrow) s = ' ' + s.replace(/^\s+/, '');
      }
      push(s, it);
    });
  });
  for (const r of out) r.t = r.t.replace(/­/g, '').replace(/[  ]/g, ' ');
  return out;
}

function runsToHtml(rs, {paragraphs = false} = {}) {
  let html = '';
  for (const r of rs) {
    if (r.arrow) { html += ' <span class="arr">→</span> '; continue; }
    if (!r.t.trim() && !r.label) { html += ' '; continue; }
    let t = esc(r.t);
    if (r.label && paragraphs) { html += `</p><p><b class="fl">${t.trim()}</b> `; continue; }
    if (r.i) t = `<i>${t}</i>`;
    if (r.b) t = `<b>${t}</b>`;
    html += t;
  }
  html = paragraphs ? `<p>${html}</p>`.replace(/<p>\s*<\/p>/g, '') : html;
  return html.replace(/ {2,}/g, ' ');
}

const plain = rs => rs.map(r => r.arrow ? ' → ' : r.t).join('').replace(/\s+/g, ' ').trim();

// Artbeschreibung: zwei Spalten im Bereich body=[y0,y1]
export function speciesText(items, sp) {
  const [y0, y1] = sp.body;
  const inBody = items.filter(it => { const m = it.y - it.z * 0.35; return m > y0 - 1 && m < y1 && it.x > 25 && it.x < 350; });
  const left = inBody.filter(it => it.x < 186), right = inBody.filter(it => it.x >= 186);
  const rs = runs([...lines(left), ...lines(right)], {labels: true});
  return {html: runsToHtml(rs, {paragraphs: true}), text: plain(rs)};
}

// Schlüsselpunkt: Kasten box=[x0,y0,x1,y1]
export function leadText(items, box) {
  const [x0, y0, x1, y1] = box;
  const sel = items.filter(it => { const m = it.y - it.z * 0.35; return it.x >= x0 - 0.5 && it.x < x1 && m >= y0 && m <= y1; });
  const rs = runs(lines(sel));
  return {html: runsToHtml(rs), text: plain(rs)};
}

// Text eines beliebigen Rechtecks (für Prüfungen)
export function boxText(items, box) {
  return leadText(items, box).text;
}
