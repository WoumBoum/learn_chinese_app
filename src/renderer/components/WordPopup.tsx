import { useState } from 'react';
import { call } from '../api';
import { AudioButton, Loading, Modal, toast, useAsync } from './common';
import { StrokeAnimator } from './StrokeAnimator';
import { CharCard } from './CharCard';
import { WordVideo } from './WordVideo';

interface Lookup {
  w: string;
  py: string;
  fr: string[];
  en: string[];
  status: 'known' | 'learning' | 'ignored' | null;
  hsk: number | null;
  inCurriculum: boolean;
  chars: { c: string; fr: string[]; en: string; dec: string; ety: { hint?: string } | null }[];
  cl: string[];
}

const STATUS_LABEL: Record<string, string> = { known: 'Connu', learning: 'En apprentissage', ignored: 'Ignoré' };

/** Word details: shown on demand (click), so pinyin is visible here — the learner explicitly asked for help. */
export function WordPopup({ word, onClose, context }: { word: string; onClose: () => void; context?: string }) {
  const { data, loading, reload } = useAsync(() => call<Lookup>('core:lookup', word), [word]);
  const [showChar, setShowChar] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [video, setVideo] = useState(false);
  const learn = async () => {
    await call('study:addWord', word, 'lookup');
    toast(`« ${word} » ajouté à tes révisions`);
    reload();
  };
  const setStatus = async (s: 'known' | 'ignored' | null) => {
    await call('core:setWordStatus', word, s);
    reload();
  };
  return (
    <Modal onClose={onClose}>
      {loading || !data ? (
        <Loading />
      ) : (
        <div className="stack">
          <div className="row">
            <span className="hanzi-lg">{data.w}</span>
            <div className="col" style={{ gap: 2 }}>
              <span className="pinyin">{data.py}</span>
              <div className="row">
                {data.hsk && data.hsk < 9 && <span className="tag">HSK {data.hsk}</span>}
                {data.status && <span className={'tag ' + (data.status === 'known' ? 'tag-ok' : 'tag-warn')}>{STATUS_LABEL[data.status]}</span>}
              </div>
            </div>
            <div className="spacer" />
            <AudioButton text={data.w} autoPlay />
          </div>
          <div className="fr">{data.fr.length ? data.fr.slice(0, 4).join(' ; ') : <span className="muted">{data.en.slice(0, 3).join(' ; ') || 'Pas de définition'}</span>}</div>
          {data.cl.length > 0 && <div className="small muted">Classificateur : <span className="hanzi">{data.cl.join('、')}</span></div>}
          {context && <div className="small muted">Contexte : <span className="hanzi">{context}</span></div>}
          {data.chars.length > 0 && (
            <div className="row">
              {data.chars.map((c) => (
                <button key={c.c} className={'btn btn-sm' + (showChar === c.c ? ' selected' : '')} onClick={() => setShowChar(showChar === c.c ? null : c.c)}>
                  <span className="hanzi" style={{ fontSize: 20 }}>{c.c}</span>
                  <span className="small muted">{c.fr[0] ?? c.en.split(';')[0]}</span>
                </button>
              ))}
            </div>
          )}
          {showChar && (
            <div className="card" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <StrokeAnimator key={showChar} char={showChar} size={140} />
              <div className="col" style={{ gap: 8 }}>
                <CharNotes c={data.chars.find((x) => x.c === showChar)!} />
                <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOrigin(showChar)}>
                  Origine du caractère ▸
                </button>
              </div>
            </div>
          )}
          <div className="col" style={{ gap: 6 }}>
            <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={(e) => (e.currentTarget.blur(), setVideo((v) => !v))} aria-expanded={video}>
              {video ? '▾' : '▸'} Vidéo : le mot en contexte
            </button>
            {video && <WordVideo target={data.w} slot="usage" compact />}
          </div>
          <div className="row">
            {!data.status && (
              <button className="btn btn-primary" onClick={learn}>
                + Apprendre ce mot
              </button>
            )}
            {data.status !== 'known' && (
              <button className="btn btn-sm" onClick={() => setStatus('known')}>
                Je le connais déjà
              </button>
            )}
            {data.status !== 'ignored' && !data.status && (
              <button className="btn btn-sm btn-ghost" onClick={() => setStatus('ignored')}>
                Ignorer (nom propre…)
              </button>
            )}
            {(data.status === 'ignored' || data.status === 'known') && (
              <button className="btn btn-sm btn-ghost" onClick={() => setStatus(null)}>
                Annuler le statut
              </button>
            )}
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
      )}
      {origin && (
        <Modal onClose={() => setOrigin(null)}>
          <CharCard char={origin} onClose={() => setOrigin(null)} />
        </Modal>
      )}
    </Modal>
  );
}

export function CharNotes({ c }: { c: { c: string; fr: string[]; en: string; dec: string; ety: { hint?: string; type?: string } | null } }) {
  const parts = [...(c.dec || '')].filter((k) => !/[⿰-⿻？]/.test(k));
  return (
    <div className="col small" style={{ gap: 4 }}>
      <div>
        <span className="hanzi" style={{ fontSize: 22 }}>{c.c}</span> — {c.fr.slice(0, 2).join(' ; ') || c.en}
      </div>
      {parts.length > 1 && (
        <div className="muted">
          Composants : <span className="hanzi">{parts.join(' + ')}</span>
        </div>
      )}
      {/* l'origine (en français) est sur la fiche caractère (CharCard) : l'indice anglais de Make Me a Hanzi la contredisait parfois */}
    </div>
  );
}
