import { useEffect, useState } from 'react';
import { call } from '../api';
import { AudioButton, Modal } from '../components/common';
import { WordPopup } from '../components/WordPopup';
import { CharCard } from '../components/CharCard';

interface Hit {
  w: string;
  py: string;
  fr: string[];
  en: string[];
  hsk: number | null;
}

export function Dictionary(props: { q?: string }) {
  const [q, setQ] = useState(props.q ?? '');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim()) call<Hit[]>('core:searchDict', q).then(setHits);
      else setHits([]);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Dictionnaire</div>
          <div className="page-sub">CFDICT (chinois-français) + CC-CEDICT. Cherche en caractères, en pinyin (sans tons) ou en français.</div>
        </div>
      </div>
      <input autoFocus style={{ width: '100%', fontSize: 18, padding: 12 }} placeholder="ex. 朋友, pengyou, ami" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list" style={{ marginTop: 14 }}>
        {hits.map((h) => (
          <div key={h.w} className="list-item clickable" onClick={() => setOpen(h.w)}>
            <span className="hanzi" style={{ fontSize: 26, minWidth: 90 }}>{h.w}</span>
            <span className="pinyin" style={{ minWidth: 120, fontSize: 15 }}>{h.py}</span>
            <span style={{ flex: 1 }}>{h.fr.slice(0, 3).join(' ; ') || <span className="muted">{h.en.slice(0, 2).join(' ; ')}</span>}</span>
            {h.hsk && h.hsk < 9 && <span className="tag">HSK {h.hsk}</span>}
            {[...h.w].length === 1 && /\p{Script=Han}/u.test(h.w) && (
              <button className="btn btn-sm btn-ghost" onClick={(e) => (e.stopPropagation(), setOrigin(h.w))} title="Fiche du caractère : origine, composants, dessin">
                Origine
              </button>
            )}
            <span onClick={(e) => e.stopPropagation()}><AudioButton text={h.w} size="sm" /></span>
          </div>
        ))}
        {q && hits.length === 0 && <div className="empty">Aucun résultat.</div>}
      </div>
      {open && <WordPopup word={open} onClose={() => setOpen(null)} />}
      {origin && (
        <Modal onClose={() => setOrigin(null)}>
          <CharCard char={origin} onClose={() => setOrigin(null)} />
        </Modal>
      )}
    </div>
  );
}
