import json, re, sys, collections, unicodedata, hashlib
R = json.load(open(sys.argv[1])); P = json.load(open(sys.argv[2]))
S, K = R['species'], R['keys']
def norm(t):
    t = unicodedata.normalize('NFKD', t.lower()); t = ''.join(c for c in t if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', ' ', t).strip()
spread = collections.defaultdict(list)
for s in S: spread[s['p']].append(s['id'])
keyspread = {}
for k in K: keyspread.setdefault(k['p'], []).append(k['id'])
keypages = set()
for k in K:
    for ls in k['steps'].values():
        for l in ls: keypages.add(l['p'])
textpages = sorted(spread)
def species_on(page):
    t = page if page % 2 == 0 else page - 1
    return t
def names_of(s):
    alts = [a.strip() for a in re.split(r',|/', s['de']) if a.strip()]
    return [norm(a) for a in alts] + [norm(s['lat'])]
unres = 0
def resolve(key, tgt, allpages):
    global unres
    out = []
    nm = norm(tgt.get('name', ''))
    nm = re.sub(r'^(artengruppe|gattung|untergattung) ', '', nm)
    for pg in tgt['pages']:
        # key?
        ks = [kid for kp, kids in keyspread.items() if kp in (pg, pg - 1) for kid in kids if kid != key['id']]
        if ks:
            best = max(ks, key=lambda kid: (norm(K[kid]['title']).startswith(nm[:6]) if nm else 0, -abs(K[kid]['p'] - pg)))
            out.append({'k': best}); continue
        t = species_on(pg)
        if t not in spread:
            # maybe group intro page: take next text page
            nxt = [x for x in textpages if x >= pg]
            if not nxt: unres += 1; continue
            t = nxt[0]
        cands = [S[i] for i in spread[t]]
        nz = nm.replace(' ', '')
        hit = [s for s in cands if nm and any(n.replace(' ', '') == nz for n in names_of(s))]
        gen = re.search(r'\(([A-Z][a-z]+)\)', tgt.get('name', ''))
        if not hit and gen:
            g0 = gen.group(1)
            near = [S[i] for tp in textpages if species_on(pg) - 2 <= tp <= species_on(pg) + 30 for i in spread[tp]]
            hit = [s for s in near if s['lat'].startswith(g0 + ' ')]
        if not hit and nm:
            hit = [s for s in cands if any(n and (n.replace(' ', '') in nz or nz in n.replace(' ', '')) for n in names_of(s))]
        if hit:
            out.append({'sp': [s['id'] for s in hit]}); continue
        # group: from t up to next target page of this key (exclusive), max 6 spreads
        later = sorted(p for p in allpages if species_on(p) > t)
        end = species_on(later[0]) if later else t + 12
        end = min(end, t + 12)
        ids = [i for tp in textpages if t <= tp < max(end, t + 1) for i in spread[tp]]
        out.append({'sp': ids, 'grp': 1})
    return out
for k in K:
    allpages = sorted({p for ls in k['steps'].values() for l in ls for t in l['targets'] if 'pages' in t for p in t['pages']})
    for n, ls in k['steps'].items():
        for l in ls:
            go = []
            for t in l['targets']:
                if 'step' in t:
                    if str(t['step']) in k['steps']: go.append({'s': t['step']})
                    elif t['step'] > 30: go += resolve(k, {'pages': [t['step']], 'name': t.get('name', '')}, allpages)
                elif 'pages' in t: go += resolve(k, t, allpages)
                else: go.append({'leaf': 1})
            l['go'] = go
# reachable species per lead
memo = {}
def reach_key(kid, depth=0):
    if kid in memo: return memo[kid]
    memo[kid] = []
    res = []
    for ls in K[kid]['steps'].values():
        for l in ls:
            for g in l['go']:
                if 'sp' in g: res += g['sp']
    # include subkeys
    for ls in K[kid]['steps'].values():
        for l in ls:
            for g in l['go']:
                if 'k' in g and depth < 3: res += reach_key(g['k'], depth + 1)
    memo[kid] = list(dict.fromkeys(res)); return memo[kid]
def reach_lead(k, l, seen):
    res = []
    for g in l['go']:
        if 'sp' in g: res += g['sp']
        elif 'k' in g: res += reach_key(g['k'])
        elif 's' in g and g['s'] not in seen:
            seen.add(g['s'])
            for l2 in k['steps'][str(g['s'])]: res += reach_lead(k, l2, seen)
    return res
for k in K:
    for n, ls in k['steps'].items():
        for l in ls:
            r = list(dict.fromkeys(reach_lead(k, l, {int(n)})))
            l['cnt'] = len(r)
            step = max(1, len(r) // 6)
            l['ex'] = [x for x in r[::step] if S[x]['plate']][:6]
print('unresolved', unres, file=sys.stderr)
# glossary (page 758)
gp = P[758]
labels = [s for s in gp['spans'] if s['f'].endswith('LightCn') and s['z'] == 8.0 and s['t'].strip()]
heads = [s for s in gp['spans'] if s['f'].endswith('BoldCn') and s['z'] == 9.0]
# merge multi-line labels
labels.sort(key=lambda s: (s['b'][1], s['b'][0]))
groups = []
for s in labels:
    cx = (s['b'][0] + s['b'][2]) / 2
    g = next((g for g in groups if abs(g['cx'] - cx) < 18 and -2.5 <= s['b'][1] - g['b'][3] < 3), None)
    if g:
        g['t'] += ('' if re.search(r'[\xad-]\s*$', g['t']) else ' ') + s['t']; g['b'] = [min(g['b'][0], s['b'][0]), g['b'][1], max(g['b'][2], s['b'][2]), s['b'][3]]
    else: groups.append(dict(t=s['t'], b=list(s['b']), cx=cx))
imgs = gp['imgs']
gloss = []
used = collections.Counter()
for g in groups:
    t = re.sub(r'\s+', ' ', re.sub(r'[\xad-]\s*\n', '', g['t']).replace('\xad', '').replace('\n', ' ')).strip()
    lb = g['b']; cx = (lb[0] + lb[2]) / 2
    above = [im for im in imgs if lb[1] - 16 <= im[3] <= lb[1] + 6 and im[0] - 4 <= cx <= im[2] + 4 and im[3] - im[1] < 60]
    hd = [h for h in heads if h['b'][1] < lb[1] and ((h['b'][0] < 150) == (lb[0] < 200) or h['b'][0] < 150)]
    hd = [h for h in heads if h['b'][1] < lb[1] and (h['b'][0] < 150 or (lb[0] > 200 and h['b'][0] > 200))]
    cat = max(hd, key=lambda h: h['b'][1])['t'].replace('-\n', '').replace('\n', '').strip() if hd else ''
    if above:
        im = min(above, key=lambda im: abs((im[0] + im[2]) / 2 - cx))
        w = min(max(lb[2] - lb[0] + 6, im[2] - im[0], 40), 72)
        box = [round(cx - w / 2, 1), round(im[1] - 1, 1), round(cx + w / 2, 1), round(lb[3] + 1, 1)]
    else:
        im = min(imgs, key=lambda b: max(b[0] - cx, 0, cx - b[2]) ** 2 + max(b[1] - lb[1], 0, lb[1] - b[3]) ** 2)
        box = [round(min(im[0], lb[0]) - 1, 1), round(min(im[1], lb[1]) - 1, 1), round(max(im[2], lb[2]) + 1, 1), round(max(im[3], lb[3]) + 1, 1)]
    gloss.append(dict(t=t, cat=cat, box=box))
print('gloss', len(gloss), [g['t'] for g in gloss], file=sys.stderr)
# fingerprint: hash of a few structural numbers (no book text)
fp = dict(pages=len(P), spans100=len(P[100]['spans']), spans318=len(P[318]['spans']))
GROUPS = ['Röhrlinge', 'Nichtblätterpilze', 'Blätterpilze', 'Porlinge', 'Rindenpilze', 'Bauchpilze', 'Schlauchpilze', 'Phytoparasiten']
def group_of(sec):
    l = sec.lower()
    for g in GROUPS:
        if g.lower() in l: return g
    return sec.split('—')[0].strip().title()
out = dict(v=1, book='Das Kosmos Handbuch Pilze (Gminder/Karasch, 2023, eBook-PDF)', fp=fp,
    species=[dict(id=s['id'], p=s['p'], n=s['n'], de=s['de'], lat=s['lat'], syn=s['syn'], rl=s['rl'], prot=s['prot'], sec=group_of(s['sec']), sub=s['sec'].split('|')[-1].strip() if '|' in s['sec'] else '', hdr=s['hdr'], body=s['body'], plate=s['plate']) for s in S],
    keys=[dict(id=k['id'], title=k['title'], p=k['p'], steps={n: [dict(l=l['let'], p=l['p'], box=l['box'], go=l['go'], cnt=l['cnt'], ex=l['ex']) for l in ls] for n, ls in k['steps'].items()}) for k in K],
    gloss=gloss)
json.dump(out, open(sys.argv[3], 'w'), ensure_ascii=False, separators=(',', ':'))
