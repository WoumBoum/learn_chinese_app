import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { AudioButton, fmtInterval, playFile, speak, useKeys, ProgressBar, Loading, ErrorBox } from '../components/common';
import { useNav } from '../App';
import type { Grade, StudyCard } from '../../shared/types';
import { WordPopup } from '../components/WordPopup';
import { CharCard } from '../components/CharCard';

const GRADES: { g: Grade; label: string; key: string }[] = [
  { g: 1, label: 'Raté', key: '1' },
  { g: 2, label: 'Difficile', key: '2' },
  { g: 3, label: 'Correct', key: '3' },
  { g: 4, label: 'Facile', key: '4' },
];

const FACE_LABEL: Record<string, string> = {
  meaning: 'Que signifie ce mot ? Prononce-le à voix haute.',
  listen: 'Écoute — que signifie ce mot ?',
  recall: 'Comment dit-on… ? Écris-le sur ta feuille ou dis-le.',
};

export function Review(props: { limit?: number; queue?: 'main' | 'grammar' }) {
  const { go } = useNav();
  const [cards, setCards] = useState<StudyCard[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [stats, setStats] = useState({ done: 0, again: 0 });
  const shownAt = useRef(Date.now());
  const sessionStart = useRef(Date.now());
  const [popup, setPopup] = useState<string | null>(null);
  const [originOpen, setOriginOpen] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (props.queue === 'grammar') {
      go('grammar', { session: true });
      return;
    }
    call<StudyCard[]>('study:queue', { queue: 'main', limit: props.limit ?? 400 })
      .then(setCards)
      .catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const card = cards?.[i];

  const playPrompt = () => {
    if (!card) return;
    if (card.sentence) {
      if (card.sentence.videoPath && card.sentence.start != null) playFile(card.sentence.videoPath, 1, Math.max(0, card.sentence.start - 0.15), (card.sentence.end ?? card.sentence.start + 4) + 0.2);
      else speak(card.sentence.zh);
    } else if (card.word) speak(card.word.w);
  };

  useEffect(() => {
    setRevealed(false);
    setOriginOpen(false);
    shownAt.current = Date.now();
    if (card && (card.card.face === 'listen')) playPrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.card.id, i]);

  const reveal = () => {
    if (!card || revealed) return;
    setRevealed(true);
    if (card.card.face !== 'listen') playPrompt();
  };

  const rate = async (g: Grade) => {
    if (!card || !revealed || busy.current) return;
    busy.current = true;
    try {
      const dur = Date.now() - shownAt.current;
      const updated = await call<StudyCard>('study:answer', card.card.id, g, dur);
      setStats((s) => ({ done: s.done + 1, again: s.again + (g === 1 ? 1 : 0) }));
      // Cards still in short-term learning come back later in this session.
      const pos = i;
      const dueSoon = updated.card.due - Date.now() < 20 * 60_000;
      setRevealed(false);
      setCards((prev) => {
        const next = [...(prev ?? [])];
        if (dueSoon) next.splice(Math.min(next.length, pos + 1 + 6), 0, updated);
        return next;
      });
      setI(pos + 1);
    } catch (e) {
      setError(e);
    } finally {
      busy.current = false;
    }
  };

  useKeys(
    {
      Space: () => (revealed ? rate(3) : reveal()),
      Enter: () => (revealed ? rate(3) : reveal()),
      '1': () => rate(1),
      '2': () => rate(2),
      '3': () => rate(3),
      '4': () => rate(4),
      r: playPrompt,
    },
    [card, revealed, i, cards],
  );

  const finished = cards && i >= cards.length;
  useEffect(() => {
    if (finished) {
      const minutes = (Date.now() - sessionStart.current) / 60000;
      if (stats.done > 0) call('core:logActivity', 'reviews', minutes, stats);
      call('core:markBlockDone', 'reviews');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!cards) return <div className="page"><Loading /></div>;

  if (finished)
    return (
      <div className="page study">
        <div className="card center" style={{ padding: 48 }}>
          <div className="hanzi-lg" style={{ color: 'var(--ok)' }}>完成</div>
          <h2 style={{ marginTop: 8 }}>Révisions terminées</h2>
          <p className="muted">
            {stats.done} carte(s) revue(s){stats.done ? `, ${Math.round(((stats.done - stats.again) / stats.done) * 100)} % de réussite` : ''}.
            {cards.length === 0 && ' Rien de dû pour le moment.'}
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={() => go('dashboard')}>Retour au QG</button>
          </div>
        </div>
      </div>
    );

  const c = card!;
  const face = c.card.kind === 'sentence' ? 'sentence' : c.card.face;
  const isNew = c.card.state === 0;
  // caractères (Han) de la carte mot / caractère, pour la fiche d'origine après la réponse
  const originChars = c.word ? [...new Set([...c.word.w].filter((k) => /\p{Script=Han}/u.test(k)))] : c.char ? [c.char.c] : [];
  return (
    <div className="page study">
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted small">
          {i + 1} / {cards.length}
        </span>
        <div style={{ flex: 1 }}>
          <ProgressBar value={i / Math.max(1, cards.length)} />
        </div>
        {isNew && <span className="tag tag-info">Première révision</span>}
      </div>
      <div className="card study-card">
        <div className="study-prompt-label">{face === 'sentence' ? 'Écoute la phrase — comprends-tu ?' : FACE_LABEL[face] ?? ''}</div>

        {/* ---- prompt ---- */}
        {face === 'meaning' && c.word && <div className="hanzi-xl">{c.word.w}</div>}
        {face === 'listen' && (
          <button className="btn btn-lg" onClick={playPrompt} style={{ fontSize: 28, padding: '20px 34px' }}>
            🔊
          </button>
        )}
        {face === 'recall' && c.word && <div className="fr" style={{ fontSize: 26 }}>{c.word.fr.slice(0, 2).join(' ; ')}</div>}
        {face === 'sentence' && (
          <button className="btn btn-lg" onClick={playPrompt}>
            🔊 Rejouer la phrase
          </button>
        )}

        {/* ---- answer ---- */}
        {revealed ? (
          <div className="answer">
            {c.word && (
              <>
                {face !== 'meaning' && (
                  <div className="hanzi-lg" onClick={() => setPopup(c.word!.w)} style={{ cursor: 'pointer' }}>
                    {c.word.w}
                  </div>
                )}
                {/* audio → sens : pas de pinyin (on lie le son au sens, pas à la romanisation) */}
                {face !== 'listen' && <div className="pinyin">{c.word.py}</div>}
                {face !== 'recall' && <div className="fr">{c.word.fr.slice(0, 3).join(' ; ') || c.word.en.slice(0, 2).join(' ; ')}</div>}
                <div className="row">
                  <AudioButton text={c.word.w} size="sm" />
                  <button className="btn btn-sm btn-ghost" onClick={() => setPopup(c.word!.w)}>
                    Détails
                  </button>
                </div>
              </>
            )}
            {/* fiche d'origine : uniquement après la réponse, à la demande */}
            {originChars.length > 0 && (
              <div className="col" style={{ width: '100%', gap: 8 }}>
                <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'center' }} onClick={(e) => (e.currentTarget.blur(), setOriginOpen((o) => !o))} aria-expanded={originOpen}>
                  {originOpen ? '▾' : '▸'} {originChars.length > 1 ? 'Origine des caractères' : 'Origine du caractère'}
                </button>
                {originOpen && (
                  <div className="col" style={{ width: '100%', textAlign: 'left' }}>
                    {originChars.map((ch) => (
                      <CharCard key={ch} char={ch} compact showVideo={false} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {c.sentence && (
              <>
                <div className="hanzi-md">{c.sentence.zh}</div>
                {c.sentence.fr && <div className="fr">{c.sentence.fr}</div>}
              </>
            )}
          </div>
        ) : (
          <button className="btn" onClick={reveal} style={{ marginTop: 18 }}>
            Afficher la réponse <span className="kbd">Espace</span>
          </button>
        )}
      </div>
      {revealed && (
        <div className="rating-bar">
          {GRADES.map((g) => (
            <button key={g.g} className={`btn r${g.g}`} onClick={() => rate(g.g)}>
              <span>
                {g.label} <span className="kbd">{g.key}</span>
              </span>
              <span className="ivl">{c.intervals ? fmtInterval(Number(c.intervals[g.g])) : ''}</span>
            </button>
          ))}
        </div>
      )}
      <p className="dim small" style={{ textAlign: 'center', marginTop: 14 }}>
        Sois honnête : « Correct » = trouvé sans hésiter (sens + prononciation). <span className="kbd">R</span> rejoue l'audio.
      </p>
      {popup && <WordPopup word={popup} onClose={() => setPopup(null)} />}
    </div>
  );
}
