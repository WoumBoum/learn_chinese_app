// Lecture : histoires graduées i+1 (IA) + lecture extensive de phrases Tatoeba (sans IA).
import { Fragment, useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { useNav } from '../App';
import { AudioButton, ErrorBox, Loading, toast, useAsync, useKeys } from '../components/common';
import { WordPopup } from '../components/WordPopup';
import type { Token } from '../../shared/types';

// ---------- shared types & helpers (also used by Roleplay) ----------
export type RToken = Token & { py?: string };
interface AiStatus {
  configured: boolean;
  model: string;
}
interface StoryRow {
  id: string;
  title: string;
  theme: string | null;
  created: number;
  read: number;
  chars: number;
}
interface StoryFull extends StoryRow {
  paragraphs: { zh: string; fr: string; tokens: RToken[] }[];
  titleTokens: RToken[];
  newWords: { w: string; py: string; fr: string[]; status: 'new' | 'learning' }[];
  coverage: number;
}
interface StoryResult {
  id: string;
  coverage: number;
  unknownWords: string[];
  targetWords: { w: string }[];
}
interface ReadingSentence {
  id: number;
  zh: string;
  fr: string[];
  audio: boolean;
  tokens: RToken[];
  unknown: { w: string; py: string; fr: string[] }[];
}

/** Log active minutes (idle gaps > 2 min are not counted) when the screen is left. */
export function useActivityLog(type: string) {
  useEffect(() => {
    let last = Date.now();
    let ms = 0;
    const tick = () => {
      const now = Date.now();
      ms += Math.min(now - last, 120_000);
      last = now;
    };
    window.addEventListener('pointerdown', tick);
    window.addEventListener('keydown', tick);
    return () => {
      tick();
      window.removeEventListener('pointerdown', tick);
      window.removeEventListener('keydown', tick);
      const min = Math.round((ms / 60000) * 10) / 10;
      if (min >= 0.5) call('core:logActivity', type, min).catch(() => undefined);
    };
  }, [type]);
}

/** Chinese text as clickable tokens. Pinyin (ruby) only on non-known words, only when asked. */
export function TokenText({ tokens, pinyin, onWord }: { tokens: RToken[]; pinyin?: boolean; onWord: (w: string) => void }) {
  return (
    <span className="hanzi">
      {tokens.map((t, i) =>
        t.han ? (
          <span key={i} className={'word-tok' + (t.status === 'new' ? ' new' : t.status === 'learning' ? ' learning' : '')} onClick={() => onWord(t.t)}>
            {pinyin && t.py && t.status !== 'known' && t.status !== 'ignored' ? (
              <ruby>
                {t.t}
                <rt>{t.py}</rt>
              </ruby>
            ) : (
              t.t
            )}
          </span>
        ) : (
          <Fragment key={i}>{t.t}</Fragment>
        ),
      )}
    </span>
  );
}

/** Split tokens into sentences (after 。！？…). */
export function splitSentences(tokens: RToken[]): RToken[][] {
  const out: RToken[][] = [];
  let cur: RToken[] = [];
  for (const t of tokens) {
    // closing quotes stay with the previous sentence
    if (!t.han && /^[」』”"）)]+$/.test(t.t) && !cur.length && out.length) {
      out[out.length - 1].push(t);
      continue;
    }
    cur.push(t);
    if (!t.han && /[。！？!?…]/.test(t.t)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.some((t) => t.t.trim())) out.push(cur);
  return out;
}

const joinTokens = (ts: RToken[]) => ts.map((t) => t.t).join('');
const pct = (x: number) => `${Math.round(x * 100)} %`;

// ---------- screen ----------
export function Reading(props: { tab?: string; storyId?: string }) {
  useActivityLog('reading');
  const [tab, setTab] = useState<'stories' | 'sentences'>(props.tab === 'sentences' ? 'sentences' : 'stories');
  const [storyId, setStoryId] = useState<string | null>(typeof props.storyId === 'string' ? props.storyId : null);

  if (storyId) return <StoryReader id={storyId} onBack={() => setStoryId(null)} />;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Lecture</div>
          <div className="page-sub">Lire beaucoup de textes faciles : c'est là que le vocabulaire se consolide.</div>
        </div>
      </div>
      <div className="tabs">
        <button className={'tab' + (tab === 'stories' ? ' active' : '')} onClick={() => setTab('stories')}>
          Histoires graduées
        </button>
        <button className={'tab' + (tab === 'sentences' ? ' active' : '')} onClick={() => setTab('sentences')}>
          Phrases (sans IA)
        </button>
      </div>
      {tab === 'stories' ? <StoriesTab onOpen={setStoryId} /> : <SentencesTab />}
    </div>
  );
}

// ---------- stories list + generator ----------
function StoriesTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { settings, go } = useNav();
  const status = useAsync(() => call<AiStatus>('ai:status').catch(() => ({ configured: false, model: '' })), []);
  const list = useAsync(() => call<StoryRow[]>('reading:stories'), []);
  const interests = settings?.interests?.length ? settings.interests : ['vie quotidienne', 'nourriture', 'voyage', 'famille'];
  const [theme, setTheme] = useState('');
  const [custom, setCustom] = useState('');
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('short');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<StoryResult>('ai:story', { theme: theme === '__custom' ? custom.trim() || undefined : theme || undefined, length });
      if (r.coverage < 0.9) toast(`Couverture ${pct(r.coverage)} : quelques mots sortent de ton vocabulaire (${r.unknownWords.slice(0, 5).join('、')}).`);
      else toast(`Histoire prête — ${r.targetWords.length} mots nouveaux, couverture ${pct(r.coverage)}`);
      onOpen(r.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Supprimer cette histoire ?')) return;
    await call('reading:deleteStory', id);
    list.reload();
  };

  return (
    <div className="stack">
      {status.data?.configured ? (
        <div className="card">
          <div className="card-title">Nouvelle histoire graduée</div>
          <p className="muted small" style={{ marginTop: 0 }}>
            Écrite uniquement avec tes mots connus, plus 2 à 5 % de mots nouveaux tirés de ton cursus (principe i+1) : tu les découvres par le contexte.
          </p>
          <div className="row">
            <select value={theme} onChange={(e) => setTheme(e.target.value)} disabled={busy}>
              <option value="">Thème surprise (parmi tes centres d'intérêt)</option>
              {interests.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              <option value="__custom">Autre thème…</option>
            </select>
            {theme === '__custom' && <input placeholder="ex. une filature dans le métro" value={custom} onChange={(e) => setCustom(e.target.value)} disabled={busy} style={{ minWidth: 260 }} />}
            <div className="mode-switch">
              {(
                [
                  ['short', 'Courte'],
                  ['medium', 'Moyenne'],
                  ['long', 'Longue'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={length === k ? 'active' : ''} onClick={() => setLength(k)} disabled={busy}>
                  {l}
                </button>
              ))}
            </div>
            <div className="spacer" />
            <button className="btn btn-primary" onClick={generate} disabled={busy || (theme === '__custom' && !custom.trim())}>
              {busy ? 'Rédaction en cours…' : 'Générer une histoire'}
            </button>
          </div>
          {busy && <div className="small dim" style={{ marginTop: 8 }}>L'IA écrit puis la couverture est vérifiée mot à mot (jusqu'à deux essais) — 20 à 60 secondes.</div>}
          {error != null && <div style={{ marginTop: 10 }}><ErrorBox error={error} /></div>}
        </div>
      ) : status.loading ? null : (
        <div className="notice">
          Les histoires graduées sont générées par l'IA (optionnelle) à partir de ton vocabulaire exact. Ajoute une clé API dans les Réglages pour les activer — en attendant, l'onglet « Phrases » fonctionne sans IA.{' '}
          <button className="btn btn-sm" onClick={() => go('settings')}>
            Ouvrir les Réglages
          </button>
        </div>
      )}

      {list.error != null && <ErrorBox error={list.error} />}
      {list.loading && !list.data ? (
        <Loading />
      ) : list.data && list.data.length ? (
        <div className="list">
          {list.data.map((s) => (
            <div key={s.id} className="list-item clickable" onClick={() => onOpen(s.id)}>
              <span className="hanzi" style={{ fontSize: 20 }}>
                {s.title}
              </span>
              {s.theme && <span className="tag">{s.theme}</span>}
              <span className="small dim">{s.chars} caractères · {new Date(s.created).toLocaleDateString('fr-FR')}</span>
              <div className="spacer" />
              {s.read > 0 ? <span className="tag tag-ok">lue{s.read > 1 ? ` ×${s.read}` : ''}</span> : <span className="tag tag-info">nouvelle</span>}
              <button
                className="btn btn-sm btn-ghost"
                title="Supprimer"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(s.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">Aucune histoire pour l'instant.</div>
      )}
    </div>
  );
}

// ---------- story reader ----------
function StoryReader({ id, onBack }: { id: string; onBack: () => void }) {
  const { settings } = useNav();
  const story = useAsync(() => call<StoryFull>('reading:story', id), [id]);
  const [pinyin, setPinyin] = useState(!!settings?.pinyinOnUnknownInPlayer);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [popup, setPopup] = useState<{ w: string; context?: string } | null>(null);
  const [showNew, setShowNew] = useState(true);

  const finish = async () => {
    await call('reading:markRead', id).catch(() => undefined);
    toast('Histoire marquée comme lue');
    onBack();
  };
  const toggle = (i: number) =>
    setRevealed((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  if (story.error) return <div className="page"><button className="btn btn-ghost" onClick={onBack}>← Retour</button><ErrorBox error={story.error} /></div>;
  if (!story.data) return <div className="page"><Loading /></div>;
  const s = story.data;
  const allShown = revealed.size === s.paragraphs.length;

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            ← Histoires
          </button>
          <div className="hanzi-md" style={{ marginTop: 8 }}>
            <TokenText tokens={s.titleTokens} pinyin={pinyin} onWord={(w) => setPopup({ w, context: s.title })} />
          </div>
          <div className="row small" style={{ marginTop: 4 }}>
            {s.theme && <span className="tag">{s.theme}</span>}
            <span className={'tag ' + (s.coverage >= 0.95 ? 'tag-ok' : s.coverage >= 0.9 ? 'tag-info' : 'tag-warn')}>Couverture {pct(s.coverage)}</span>
          </div>
        </div>
        <div className="row">
          <label className="row small muted" style={{ gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={pinyin} onChange={(e) => setPinyin(e.target.checked)} />
            Pinyin sur les mots inconnus
          </label>
          <button className="btn btn-sm" onClick={() => setRevealed(allShown ? new Set() : new Set(s.paragraphs.map((_, i) => i)))}>
            {allShown ? 'Masquer les traductions' : 'Tout traduire'}
          </button>
        </div>
      </div>

      {s.newWords.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row">
            <div className="card-title" style={{ margin: 0 }}>Mots nouveaux dans ce texte ({s.newWords.length})</div>
            <div className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => setShowNew(!showNew)}>{showNew ? 'Masquer' : 'Afficher'}</button>
          </div>
          {showNew && (
            <>
              <div className="small muted" style={{ margin: '6px 0 10px' }}>Devine leur sens grâce au contexte, puis clique pour vérifier (et les ajouter à tes révisions).</div>
              <div className="row">
                {s.newWords.map((w) => (
                  <button key={w.w} className="btn btn-sm" onClick={() => setPopup({ w: w.w })}>
                    <span className="hanzi" style={{ fontSize: 18 }}>{w.w}</span>
                    {w.status === 'learning' && <span className="tag tag-warn">en cours</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="stack">
        {s.paragraphs.map((p, i) => (
          <div key={i} className="card">
            <div className="col" style={{ gap: 6 }}>
              {splitSentences(p.tokens).map((sent, j) => {
                const text = joinTokens(sent);
                return (
                  <div key={j} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ paddingTop: 8 }}>
                      <AudioButton text={text} size="sm" />
                    </div>
                    <div className="zh-line" style={{ lineHeight: pinyin ? 2.1 : 1.6 }}>
                      <TokenText tokens={sent} pinyin={pinyin} onWord={(w) => setPopup({ w, context: text })} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <AudioButton text={p.zh} size="sm" label="Paragraphe" />
              <AudioButton text={p.zh} size="sm" rate={0.75} label="Lent" />
              <div className="spacer" />
              {p.fr && (
                <button className="btn btn-sm btn-ghost" onClick={() => toggle(i)}>
                  {revealed.has(i) ? 'Masquer la traduction' : 'Révéler la traduction'}
                </button>
              )}
            </div>
            {revealed.has(i) && <div className="fr" style={{ marginTop: 8, fontSize: 16, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>{p.fr}</div>}
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 20 }}>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={finish}>
          Lecture terminée ✓
        </button>
      </div>

      {popup && (
        <WordPopup
          word={popup.w}
          context={popup.context}
          onClose={() => {
            setPopup(null);
            story.reload();
          }}
        />
      )}
    </div>
  );
}

// ---------- extensive reading of known sentences (no AI) ----------
function SentencesTab() {
  const [mode, setMode] = useState<'known' | 'i+1'>('known');
  const [queue, setQueue] = useState<ReadingSentence[] | null>(null);
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState({ ok: 0, ko: 0 });
  const [error, setError] = useState<unknown>(null);
  const [popup, setPopup] = useState<{ w: string; context: string } | null>(null);
  const [learned, setLearned] = useState<Set<string>>(new Set());
  const seen = useRef<number[]>([]);

  const load = async (m: 'known' | 'i+1') => {
    setQueue(null);
    setError(null);
    try {
      const r = await call<ReadingSentence[]>('reading:sentences', { n: 12, mode: m, exclude: seen.current.slice(-500) });
      setQueue(r);
      setI(0);
      setRevealed(false);
    } catch (e) {
      setError(e);
      setQueue([]);
    }
  };
  useEffect(() => {
    load(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const cur = queue?.[i];
  const answer = (ok: boolean) => {
    if (!cur || !revealed) return;
    seen.current.push(cur.id);
    setScore((s) => (ok ? { ...s, ok: s.ok + 1 } : { ...s, ko: s.ko + 1 }));
    if (queue && i + 1 < queue.length) {
      setI(i + 1);
      setRevealed(false);
    } else load(mode);
  };
  const learn = async (w: string) => {
    try {
      await call('study:addWord', w, 'reading');
      setLearned((s) => new Set(s).add(w));
      toast(`« ${w} » ajouté à tes révisions`);
    } catch (e) {
      toast('Erreur : ' + (e instanceof Error ? e.message : String(e)));
    }
  };
  useKeys(
    {
      Space: () => !revealed && setRevealed(true),
      Enter: () => !revealed && setRevealed(true),
      '1': () => answer(false),
      '2': () => answer(true),
    },
    [revealed, cur, queue, i, mode],
  );

  const total = score.ok + score.ko;
  return (
    <div className="stack" style={{ maxWidth: 820, margin: '0 auto' }}>
      <div className="row">
        <div className="mode-switch">
          <button className={mode === 'known' ? 'active' : ''} onClick={() => setMode('known')}>
            100 % connu
          </button>
          <button className={mode === 'i+1' ? 'active' : ''} onClick={() => setMode('i+1')}>
            i+1 (un mot nouveau)
          </button>
        </div>
        <div className="spacer" />
        {total > 0 && (
          <span className="muted small">
            Compris : <strong className="correct">{score.ok}</strong> / {total} ({pct(score.ok / total)})
          </span>
        )}
      </div>
      <div className="small dim">
        {mode === 'known'
          ? 'Phrases réelles (Tatoeba) écrites uniquement avec tes mots : lis, comprends, puis vérifie. Le volume compte plus que la difficulté.'
          : 'Chaque phrase contient exactement un mot que tu ne connais pas (souligné) : devine-le grâce au reste de la phrase.'}
      </div>
      {error != null && <ErrorBox error={error} />}
      {queue === null ? (
        <Loading text="Recherche de phrases à ton niveau…" />
      ) : !cur ? (
        <div className="empty">
          {mode === 'known'
            ? "Pas encore de phrase entièrement couverte par ton vocabulaire (il faut une cinquantaine de mots connus). Essaie le mode i+1 ou continue les « Nouveaux mots »."
            : 'Aucune phrase avec un seul mot inconnu trouvée pour le moment. Apprends quelques mots de plus et reviens !'}
        </div>
      ) : (
        <div className="card study-card" style={{ minHeight: 300 }}>
          <div className="study-prompt-label">Phrase {i + 1} / {queue.length}</div>
          <div className="hanzi-md" style={{ fontSize: 34, lineHeight: 1.6 }}>
            <TokenText tokens={cur.tokens} onWord={(w) => setPopup({ w, context: cur.zh })} />
          </div>
          <AudioButton text={cur.zh} />
          {!revealed ? (
            <button className="btn btn-primary" onClick={() => setRevealed(true)}>
              Révéler la traduction <span className="kbd">Espace</span>
            </button>
          ) : (
            <div className="answer">
              {cur.fr.slice(0, 2).map((f, k) => (
                <div key={k} className={k === 0 ? 'fr' : 'muted'}>
                  {f}
                </div>
              ))}
              {cur.unknown.map((u) => (
                <div key={u.w} className="row" style={{ marginTop: 6 }}>
                  <span className="hanzi" style={{ fontSize: 24 }}>{u.w}</span>
                  <span className="pinyin">{u.py}</span>
                  <span className="muted">{u.fr.slice(0, 2).join(' ; ')}</span>
                  {!learned.has(u.w) && (
                    <button className="btn btn-sm" onClick={() => learn(u.w)}>
                      + Apprendre
                    </button>
                  )}
                </div>
              ))}
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn r1" onClick={() => answer(false)}>
                  ✗ Pas compris <span className="kbd">1</span>
                </button>
                <button className="btn r3" onClick={() => answer(true)}>
                  ✓ Compris <span className="kbd">2</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {popup && <WordPopup word={popup.w} context={popup.context} onClose={() => setPopup(null)} />}
    </div>
  );
}
