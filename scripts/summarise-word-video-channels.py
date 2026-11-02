#!/usr/bin/env python3
"""Evaluation helper (word-videos): summarises channel listings fetched by verify-word-video-channels.sh.

    python3 -I scripts/summarise-word-video-channels.py OUT_DIR [--json summary.json]

Per channel: name, channel_id, number of uploads listed (capped by MAX), median duration, share of Shorts (<60 s),
share of titles that contain exactly 1-2 distinct Han characters next to a delimiter ("per-character" titles),
and how many of the curriculum's first 300 / 1000 words (and of the first 300 / 1000 characters of chars.json,
ordered by `i`) appear as an isolated token in a title — simplified or CEDICT traditional spelling.
"""
import json, os, re, sys, statistics

HAN = re.compile(r'[㐀-鿿]')
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
words = json.load(open(os.path.join(root, 'resources/data/words.json'), encoding='utf-8'))
by_rank = sorted(words, key=lambda x: x['rank'])
w300 = [x['w'] for x in by_rank[:300]]
w1000 = [x['w'] for x in by_rank[:1000]]
_chars = json.load(open(os.path.join(root, 'resources/data/chars.json'), encoding='utf-8'))['chars']
c300 = [c for c, v in sorted(_chars.items(), key=lambda kv: kv[1]['i'])][:300]
c1000 = [c for c, v in sorted(_chars.items(), key=lambda kv: kv[1]['i'])][:1000]
# Traditional spellings (CEDICT): many etymology channels (Taiwan) title their videos in traditional characters.
import gzip
TRAD = {}
_ced = os.path.join(root, 'data-raw/cedict.txt.gz')
if os.path.exists(_ced):
    for line in gzip.open(_ced, 'rt', encoding='utf-8'):
        m = re.match(r'^(\S+) (\S+) \[', line)
        if m and m.group(1) != m.group(2):
            TRAD.setdefault(m.group(2), []).append(m.group(1))


def isolated(w, t):
    for m in re.finditer(re.escape(w), t):
        b = t[m.start() - 1] if m.start() > 0 else ' '
        a = t[m.end()] if m.end() < len(t) else ' '
        if not HAN.match(b) and not HAN.match(a):
            return True
    return False


def summarise(path):
    d = json.load(open(path, encoding='utf-8'))
    es = [e for e in d.get('entries', []) if e]
    titles = [e.get('title') or '' for e in es]
    durs = [e.get('duration') for e in es if e.get('duration')]
    per_char = sum(1 for t in titles if 1 <= len(set(HAN.findall(t))) <= 3)
    # isolated(w, t) ⇔ w is a maximal Han run of t → set membership (fast).
    runs = [set(re.findall(r'[\u3400-\u9fff]+', t)) for t in titles]
    allruns = set().union(*runs) if runs else set()
    hit_any = lambda w: any(f in allruns for f in [w] + TRAD.get(w, []))
    cov300 = [w for w in w300 if hit_any(w)]
    cov1000 = [w for w in w1000 if hit_any(w)]
    chars300 = sum(1 for c in c300 if hit_any(c))
    chars1000 = sum(1 for c in c1000 if hit_any(c))
    trad_only = sum(1 for w in cov1000 if w not in allruns)
    return {
        'key': os.path.basename(path)[:-5],
        'name': d.get('channel') or d.get('uploader') or d.get('title'),
        'channelId': d.get('channel_id') or d.get('id'),
        'listed': len(es),
        'medianDur': int(statistics.median(durs)) if durs else None,
        'shorts': round(sum(1 for x in durs if x < 60) / len(durs), 2) if durs else None,
        'perCharTitles': round(per_char / len(titles), 2) if titles else 0,
        'cov300': len(cov300), 'cov1000': len(cov1000), 'cov1000TradOnly': trad_only, 'chars300': chars300, 'chars1000': chars1000,
        'sample': titles[:4],
    }


def main():
    out = sys.argv[1]
    rows = [summarise(os.path.join(out, f)) for f in sorted(os.listdir(out)) if f.endswith('.json')]
    rows.sort(key=lambda r: -r['cov1000'])
    for r in rows:
        print(f"{r['key'][:28]:28} {str(r['channelId']):26} n={r['listed']:<4} med={r['medianDur']}s shorts={r['shorts']} perChar={r['perCharTitles']} cov300={r['cov300']} cov1000={r['cov1000']} (trad-only {r['cov1000TradOnly']}) chars300={r['chars300']} chars1000={r['chars1000']} | {r['sample'][0][:60] if r['sample'] else ''}")
    if '--json' in sys.argv:
        json.dump(rows, open(sys.argv[sys.argv.index('--json') + 1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
