import json, re, sys, collections, hashlib
P = json.load(open(sys.argv[1]))
NP = len(P)
SH = '\xad'
def clean(t): return t.replace(SH, '').replace('\x08', '').replace(' ', ' ').replace('\xa0', ' ')
def top_header(p): return ''.join(s['t'] for s in p['spans'] if s['b'][1] < 32 and s['z'] >= 8.9).strip()

keyleft = [p['i'] for p in P if 'Bestimmungsschlüssel' in top_header(p)]
keypages = sorted(set(keyleft) | {i + 1 for i in keyleft})

# ---------------- species ----------------
def headers(p):
    out = []
    sp = p['spans']
    for k, s in enumerate(sp):
        if 'BlackCn' in s['f'] and 9 <= s['z'] <= 10.5 and re.fullmatch(r'\d+\s*\t?', s['t']) and s['b'][0] < 34 and 35 < s['b'][1] < 520:
            y0 = s['b'][1]
            names = sorted([t for t in sp if 'BlackCn' in t['f'] and 10 <= t['z'] <= 10.5 and t['b'][0] >= 44 and y0 - 3 <= t['b'][1] <= y0 + 26 and t['t'].strip()], key=lambda t: t['b'][1])
            keep = []
            for t in names:
                if keep and t['b'][1] - max(x['b'][3] for x in keep) > 3: break
                keep.append(t)
            if keep:
                out.append((int(s['t'].strip()), s, keep))
    return out

species = []
textpages = {}
for p in P:
    if p['i'] in keypages or p['i'] < 34 or p['i'] > 725: continue
    hs = headers(p)
    if hs: textpages[p['i']] = hs

def plate_labels(p):
    return [(int(s['t'].strip()), s) for s in p['spans'] if 'BlackCn' in s['f'] and 9 <= s['z'] <= 10.5 and re.fullmatch(r'\d+\s*\t?', s['t'])]

BOTTOM = 516
for pi, hs in sorted(textpages.items()):
    p = P[pi]
    # plate page: neighbour without headers but with labels
    plate = pi + 1 if pi + 1 not in keypages and plate_labels(P[pi + 1]) else None
    pl_labels = dict()
    if plate is not None:
        imgs = [b for b in P[plate]['imgs'] if (b[2] - b[0]) * (b[3] - b[1]) > 2500 and b[3] - b[1] < 500]
        labs = plate_labels(P[plate])
        assign = collections.defaultdict(list)
        for b in imgs:
            def dist(s):
                lx, ly = s['b'][0], s['b'][1]
                dx = 0 if b[0] <= lx <= b[2] else min(abs(lx - b[0]), abs(lx - b[2]))
                dy = 0 if b[1] <= ly <= b[3] else min(abs(ly - b[1]), abs(ly - b[3]))
                return dx * dx + dy * dy
            n, s = min(labs, key=lambda ns: dist(ns[1]))
            assign[n].append(b)
        for n, s0 in labs:
            if n not in assign:
                near = [b for b in P[plate]['imgs'] if (b[2] - b[0]) * (b[3] - b[1]) > 400 and b[3] - b[1] < 500]
                if near:
                    lx, ly = s0['b'][0], s0['b'][1]
                    b = min(near, key=lambda b: (max(b[0] - lx, 0, lx - b[2]) ** 2 + max(b[1] - ly, 0, ly - b[3]) ** 2))
                    assign[n].append(b)
        for n, bs in assign.items():
            pl_labels[n] = [round(min(b[0] for b in bs), 1), round(min(b[1] for b in bs), 1), round(max(b[2] for b in bs), 1), round(max(b[3] for b in bs), 1)]
    hs_sorted = sorted(hs, key=lambda h: h[1]['b'][1])
    for k, (n, s, names) in enumerate(hs_sorted):
        y0 = s['b'][1]
        y1 = hs_sorted[k + 1][1]['b'][1] - 1 if k + 1 < len(hs_sorted) else BOTTOM
        de = re.sub(r'\s+', ' ', clean(''.join(t['t'] for t in names)).replace('\x07', '')).strip()
        # latin line: spans just below header
        hb = max(t['b'][3] for t in names)
        line_sp = [t for t in p['spans'] if hb - 1 <= t['b'][1] <= hb + 6 and t['b'][0] >= 45 and t['z'] < 7]
        badge = clean(' '.join(t['t'] for t in line_sp if t['b'][0] >= 240)).strip()
        hline = clean(' '.join(t['t'] for t in p['spans'] if abs(t['b'][1] - y0) < 14 and t['b'][0] >= 240))
        rl = re.findall(r'RL-?\s*([0-9GRVD*]+)', badge + ' ' + hline)
        prot = '§' in badge + hline
        lat_sp = [t for t in line_sp if t['b'][0] < 240 and not re.search(r'RL-|§', t['t'])]
        lat_full = clean(''.join(t['t'] for t in sorted(lat_sp, key=lambda t: t['b'][0]))).strip()
        lat = clean(''.join(t['t'] for t in sorted(lat_sp, key=lambda t: t['b'][0]) if 'Italic' in t['f'] or 'Ita' in t['f'])).strip()
        lat_main = re.split(r'\s*\(', lat_full)[0].strip()
        syn = re.findall(r'Syn\.\s*([^)]+)\)', lat_full)
        body_top = max(hb, max([t['b'][3] for t in lat_sp], default=hb)) + 0.5
        species.append(dict(p=pi, n=n, de=de, lat=lat_main, syn=syn, hdr=[30, round(y0 - 1, 1), 346, round(body_top, 1)],
                            body=[round(body_top, 1), round(y1, 1)], rl=rl[0] if rl else None, prot=prot, plate=[plate, pl_labels.get(n)] if plate is not None and pl_labels.get(n) else None,
                            sec=clean(top_header(p))))

for i, s in enumerate(species): s['id'] = i
print('species', len(species), 'no plate', sum(1 for s in species if not s['plate']), file=sys.stderr)

# ---------------- keys ----------------
LAB = re.compile(r'^(\d+)([a-f])$')
leads = []
for pi in keypages:
    p = P[pi]
    labs = [s for s in p['spans'] if LAB.match(s['t'].strip()) and 'Bold' in s['f'] and s['z'] <= 7]
    for s in labs:
        col = 0 if s['b'][0] < 185 else 1
        leads.append(dict(p=pi, col=col, s=s, y=s['b'][1]))
leads.sort(key=lambda l: (l['p'], l['col'], l['y']))
# lead regions
for k, l in enumerate(leads):
    p = P[l['p']]
    nxt = next((m for m in leads[k + 1:] if m['p'] == l['p'] and m['col'] == l['col']), None)
    ytop = l['y'] - 2.5
    ybot = nxt['y'] - 2.5 if nxt else BOTTOM
    x0, x1 = (30, 186) if l['col'] == 0 else (186, 346)
    xs = l['s']['b'][2] + 1
    sp = [s for s in p['spans'] if x0 <= s['b'][0] < x1 and s['b'][0] >= xs - 0.5 and ytop <= (s['b'][1] + s['b'][3]) / 2 < ybot and s['z'] <= 8.1 and s['t'].strip()
          and not re.fullmatch(r'\(\d+\)', s['t'].strip())]
    # stop at a gap (intro text after the last lead in column)
    sp.sort(key=lambda s: s['b'][1])
    kept = []
    for s in sp:
        if kept and s['b'][1] - max(t['b'][3] for t in kept) > 9: break
        kept.append(s)
    l['spans'] = kept
    l['box'] = [round(min(s['b'][0] for s in kept) - 1, 1), round(min(s['b'][1] for s in kept) - 1, 1), round(max(s['b'][2] for s in kept) + 1, 1), round(max(s['b'][3] for s in kept) + 1, 1)] if kept else None
    m = LAB.match(l['s']['t'].strip()); l['num'] = int(m.group(1)); l['let'] = m.group(2)
    # reading order: cluster lines by vertical centre
    rows = []
    for sp_ in sorted(kept, key=lambda s: (s['b'][1] + s['b'][3]) / 2):
        yc = (sp_['b'][1] + sp_['b'][3]) / 2
        if rows and abs(rows[-1][0] - yc) < 3.5: rows[-1][1].append(sp_)
        else: rows.append([yc, [sp_]])
    ordered = [x for _, r in rows for x in sorted(r, key=lambda s: s['b'][0])]
    kept[:] = ordered
    tg = []
    arrow_idx = [i for i, s in enumerate(kept) if 'Dingbats' in s['f']]
    for ai in arrow_idx:
        after = []
        for s in kept[ai + 1:]:
            if 'Dingbats' in s['f']: break
            if not clean(s['t']).strip(): continue
            if 'Bold' in s['f']: after.append(s)
            elif after: break
        txt = re.sub(r'\s+', ' ', clean(''.join(s['t'] for s in after))).strip()
        refs = re.findall(r'S\.\s*(\d+)', txt)
        m = re.search(r'(\d+)\s*$', txt)
        if refs:
            tg.append({'pages': [int(x) for x in refs], 'name': re.split(r',?\s*S\.\s*\d', txt)[0].strip(' ,')})
        elif m:
            tg.append({'step': int(m.group(1)), 'name': txt[:m.start()].strip()})
        else:
            tg.append({'leaf': txt})
    l['targets'] = tg
    l['plain'] = clean(' '.join(s['t'] for s in kept))

# headings (key titles)
def headings(pi):
    return [(s['b'][1], clean(s['t']).strip()) for s in P[pi]['spans'] if 'BlackCn' in s['f'] and s['z'] >= 11 and s['t'].strip()]
keys = []
cur = None
for l in leads:
    if l['num'] == 1 and l['let'] == 'a':
        hd = [h for h in headings(l['p']) if h[0] < l['y']]
        if not hd and l['col'] == 1: hd = headings(l['p'])
        if not hd: hd = headings(l['p'] - 1) or headings(l['p'] + 1)
        title = hd[-1][1] if hd else '?'
        cur = dict(id=len(keys), title=title, p=l['p'], steps=collections.OrderedDict())
        keys.append(cur)
    if cur is None: continue
    cur['steps'].setdefault(l['num'], []).append(l)
print('keys', len(keys), file=sys.stderr)
for k in keys: print(' ', k['id'], k['p'], k['title'], len(k['steps']), file=sys.stderr)
json.dump(dict(species=species, keys=[dict(id=k['id'], title=k['title'], p=k['p'], steps={n: [dict(p=l['p'], let=l['let'], box=l['box'], targets=l['targets'], plain=l['plain']) for l in ls] for n, ls in k['steps'].items()}) for k in keys]), open(sys.argv[2], 'w'), ensure_ascii=False)
