import pymupdf as fitz, re, json, collections, sys
d=fitz.open(sys.argv[1])
pages=[]
for i,p in enumerate(d):
    spans=[]
    for b in p.get_text('dict')['blocks']:
        for l in b.get('lines',[]):
            for s in l['spans']:
                spans.append(dict(t=s['text'],f=s['font'],z=round(s['size'],1),b=[round(x,1) for x in s['bbox']]))
    imgs=[[round(x,1) for x in im['bbox']] for im in p.get_image_info()]
    pages.append(dict(i=i,spans=spans,imgs=imgs))
json.dump(pages,open(sys.argv[2],'w'))
