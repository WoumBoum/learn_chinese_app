#!/usr/bin/env python3
"""Évaluation des enregistrements natifs audio-cmn (cf. docs/native-audio.md). Python 3 + numpy.

  python3 scripts/eval-native-audio.py coverage <audio-cmn>
      couverture des mots de resources/data/words.json (par caractères simplifiés) et des syllabes
  python3 scripts/eval-native-audio.py readings <tones.json>
      <tones.json> = sortie de scripts/check-audio-tones.mjs sur les mots d'UN caractère (étiquette « mot|pn|… »)
      → kNN « adapté au locuteur » (leave-one-out, k = 9) ; un désaccord net (≥ 7/9 voisins) dont le ton prédit
        correspond à une autre lecture CEDICT du caractère = lecture enregistrée ≠ lecture du programme.
"""
import collections, gzip, json, math, os, re, sys

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORDS = json.load(open(f'{APP}/resources/data/words.json', encoding='utf-8'))


def norm(s):
    return s.lower().replace('ü', 'v').replace('u:', 'v')


def coverage(src):
    rec = {f[4:-4] for f in os.listdir(f'{src}/64k/hsk') if f.endswith('.mp3')}
    syl = {f[4:-4] for f in os.listdir(f'{src}/64k/syllabs') if f.endswith('.mp3')}
    def erhua(w):
        alt = w[:-1] if w.endswith('儿') else w + '儿'
        return alt in rec
    out = {}
    groups = [('all', WORDS), ('rank<1700', [x for x in WORDS if x['rank'] < 1700])]
    groups += [(f'band {b}', [x for x in WORDS if x['band'] == b]) for b in sorted({x['band'] for x in WORDS})]
    for name, sel in groups:
        ex = sum(x['w'] in rec for x in sel)
        er = sum(x['w'] not in rec and erhua(x['w']) for x in sel)
        out[name] = dict(n=len(sel), exact=ex, erhua=er, pct_exact=round(100 * ex / len(sel), 1), pct_with_erhua=round(100 * (ex + er) / len(sel), 1))
    # syllabes : jv4 = ju4 (erreur de nommage) ; préfixe « _ » = interjections (hm, hng, m, n, ng…)
    have = {norm(s.lstrip('_')).replace('jv4', 'ju4') for s in syl}
    toned = {s for s in have if s[-1] in '1234'}
    cur = collections.Counter(norm(s) for x in WORDS for s in re.findall(r"[A-Za-zü:]+[1-5]", x['pn']))
    c4 = {s for s in cur if s[-1] != '5'}
    tok = sum(cur.values())
    out['syllables'] = dict(
        files=len(syl), toned_1_4=len(toned), tone5_files=len(have) - len(toned),
        curriculum_distinct_1_4=len(c4), curriculum_covered_1_4=len(c4 & have),
        curriculum_distinct_tone5=len(set(cur) - c4), curriculum_tone5_covered=len((set(cur) - c4) & have),
        curriculum_tokens=tok, tokens_covered_pct=round(100 * sum(n for s, n in cur.items() if s in have and s[-1] != '5') / tok, 1),
        missing_1_4=sorted(c4 - have),
    )
    print(json.dumps(out, ensure_ascii=False, indent=1))


def readings(path):
    import numpy as np
    ced = collections.defaultdict(set)
    cedict = f'{APP}/data-raw/cedict.txt.gz'
    if os.path.exists(cedict):
        for l in gzip.open(cedict, 'rt', encoding='utf-8'):
            m = re.match(r'(\S+) (\S+) \[([^\]]+)\]', l)
            if m and len(m.group(2)) == 1 and re.fullmatch(r'[a-z:]+[1-5]', m.group(3).lower()):
                ced[m.group(2)].add(m.group(3).lower().replace('u:', 'ü'))
    d = json.load(open(path))
    ref = d['summary']['refHz']
    it = [i for i in d['items'] if (i['f0med'] or 0) > 0 and len(i['contour']) == 10]
    X = np.array([[c + 12 * math.log2(i['f0med'] / ref) for c in i['contour']] + [i['voicedMs'] / 100] for i in it])
    y = np.array([i['expected'] for i in it])
    D = np.abs(X[:, None, :] - X[None, :, :]).mean(-1)
    np.fill_diagonal(D, np.inf)
    pred, flags = [], []
    for r, i in enumerate(it):
        nn = np.argsort(D[r])[:9]
        t, n = collections.Counter(y[nn]).most_common(1)[0]
        pred.append(t)
        if t != i['expected'] and n >= 7:
            ch = i['label'].split('|')[0]
            alt = sorted(p for p in ced[ch] if p[-1] == str(t))
            flags.append(dict(item=i['label'], expected=int(i['expected']), predicted=int(t), votes=f'{n}/9', other_reading=alt))
    acc = float(np.mean(np.array(pred) == y))
    print(json.dumps(dict(n=len(it), knn_loo_accuracy=round(100 * acc, 1), flagged=flags), ensure_ascii=False, indent=1))


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('coverage', 'readings'):
        sys.exit(__doc__)
    (coverage if sys.argv[1] == 'coverage' else readings)(sys.argv[2])
