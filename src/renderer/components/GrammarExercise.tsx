// Renders any grammar exercise type with immediate feedback. Chinese answers are built from clickable tiles (no IME needed);
// an optional free-text field (« J'ai un clavier chinois ») is checked against the accepted answers, then by the AI if configured.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GrammarExercise as Exercise } from '../../shared/types';
import { call } from '../api';
import { AudioButton, useKeys } from './common';
import { cleanTokens, expectedAnswers, matchesAnswer, pickDistractors, shuffleTiles } from '../../core/grammar';

type Props = { ex: Exercise; onDone: (correct: boolean) => void };
type Extra = { _pool?: string[] };

const TYPE_LABEL: Record<Exercise['type'], string> = {
  order: 'Remets les mots dans l\'ordre',
  cloze: 'Complète la phrase',
  transform: 'Transforme la phrase',
  error: 'Corrige l\'erreur',
  translate: 'Traduis en chinois',
  choice: 'Choisis la bonne réponse',
  listen: 'Écoute et réponds',
};

const hasHan = (s: string) => /\p{Script=Han}/u.test(s);

// ---- AI availability (cached for a minute: the key can be added in the settings meanwhile) ----
let aiCache: { at: number; p: Promise<boolean> } | null = null;
function aiConfigured(): Promise<boolean> {
  if (!aiCache || Date.now() - aiCache.at > 60_000)
    aiCache = {
      at: Date.now(),
      p: call<{ configured: boolean }>('ai:status')
        .then((r) => !!r?.configured)
        .catch(() => false),
    };
  return aiCache.p;
}

// A fresh inner component per exercise object, so that state never leaks from one exercise to the next.
const keys = new WeakMap<object, number>();
let seq = 0;
export function GrammarExercise(props: { ex: Exercise; onDone: (correct: boolean) => void }) {
  let k = keys.get(props.ex);
  if (k == null) {
    k = ++seq;
    keys.set(props.ex, k);
  }
  return <ExerciseInner key={k} {...props} />;
}

interface Feedback {
  correct: boolean;
  chosen?: string; // the learner's answer (text)
  ai?: string; // AI explanation
  aiCorrected?: string;
}

function ExerciseInner({ ex, onDone }: Props) {
  const [fb, setFb] = useState<Feedback | null>(null);
  const isBuild = ex.type === 'order' || ex.type === 'transform' || ex.type === 'error' || ex.type === 'translate';
  const isChoice = ex.type === 'cloze' || ex.type === 'choice' || ex.type === 'listen';
  const options: string[] = ex.type === 'cloze' || ex.type === 'choice' || ex.type === 'listen' ? ex.options : [];
  const answers = useMemo(() => expectedAnswers(ex), [ex]);

  // ---------- tiles ----------
  const [tiles, setTiles] = useState<string[] | null>(ex.type === 'order' ? shuffleTiles(ex.tokens) : null);
  const [placed, setPlaced] = useState<number[]>([]);
  const [tileError, setTileError] = useState<string | null>(null);
  useEffect(() => {
    if (ex.type !== 'transform' && ex.type !== 'error' && ex.type !== 'translate') return;
    let alive = true;
    (async () => {
      try {
        const seg = async (s: string) => cleanTokens((await call<{ t: string }[]>('core:segment', s)).map((t) => t.t));
        const answerTokens = await seg(ex.answers[0] ?? '');
        const sourceTokens = ex.type === 'translate' ? [] : await seg(ex.zh);
        const d = pickDistractors({ answerTokens, sourceTokens, pool: (ex as Extra)._pool, n: answerTokens.length > 6 ? 3 : 2 + (Math.random() < 0.5 ? 1 : 0) });
        if (alive) setTiles(shuffleTiles([...answerTokens, ...d]));
      } catch (e) {
        if (alive) {
          // fallback: one tile per character (still no IME needed)
          const chars = [...(ex.answers[0] ?? '')].filter((c) => hasHan(c));
          setTiles(shuffleTiles(chars));
          setTileError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [ex]);

  const built = placed.map((i) => tiles?.[i] ?? '').join('');
  const addTile = (i: number) => !fb && !placed.includes(i) && setPlaced((p) => [...p, i]);
  const removeTile = (pos: number) => !fb && setPlaced((p) => p.filter((_, k) => k !== pos));

  // ---------- free text ----------
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  const checkTiles = () => {
    if (fb || !placed.length) return;
    setFb({ correct: matchesAnswer(built, answers), chosen: built });
  };

  const aiPrompt = (): string => {
    if (ex.type === 'translate') return ex.fr;
    if (ex.type === 'transform') return `${ex.instruction} Phrase de départ : ${ex.zh}`;
    if (ex.type === 'error') return `Corriger l'erreur grammaticale dans : ${ex.zh}`;
    if (ex.type === 'order') return ex.fr;
    return '';
  };

  const checkText = async () => {
    if (fb || checking || !text.trim()) return;
    if (matchesAnswer(text, answers)) {
      setFb({ correct: true, chosen: text.trim() });
      return;
    }
    setChecking(true);
    try {
      if (await aiConfigured()) {
        const r = await call<{ correct: boolean; explanation: string; corrected?: string }>('ai:correct', { fr: aiPrompt(), userZh: text.trim(), answers });
        setFb({ correct: !!r.correct, chosen: text.trim(), ai: r.explanation, aiCorrected: r.corrected });
      } else setFb({ correct: false, chosen: text.trim() });
    } catch (e) {
      setFb({ correct: false, chosen: text.trim(), ai: `Correction automatique indisponible (${e instanceof Error ? e.message : String(e)}). Compare avec la réponse attendue.` });
    } finally {
      setChecking(false);
    }
  };

  // ---------- options ----------
  const choose = (i: number) => {
    if (fb || i < 0 || i >= options.length) return;
    let correct = false;
    if (ex.type === 'cloze') correct = options[i] === ex.answer;
    else if (ex.type === 'choice' || ex.type === 'listen') correct = i === ex.answer;
    setFb({ correct, chosen: options[i] });
  };

  const next = () => fb && onDone(fb.correct);

  useKeys({
    Enter: () => (fb ? next() : isBuild && !typing ? checkTiles() : undefined),
    Backspace: () => !fb && isBuild && setPlaced((p) => p.slice(0, -1)),
    '1': () => isChoice && choose(0),
    '2': () => isChoice && choose(1),
    '3': () => isChoice && choose(2),
    '4': () => isChoice && choose(3),
  });

  // ---------- prompt ----------
  let prompt: ReactNode = null;
  switch (ex.type) {
    case 'order':
      prompt = <div className="fr">« {ex.fr} »</div>;
      break;
    case 'cloze': {
      const [a, b] = ex.zh.split('___');
      const fill = fb ? <span className="correct" style={{ borderBottom: '2px solid currentColor', padding: '0 4px' }}>{ex.answer}</span> : <span style={{ display: 'inline-block', minWidth: '2.2em', borderBottom: '2px solid var(--info)', margin: '0 4px' }}>&nbsp;</span>;
      prompt = (
        <>
          <div className="zh-line">
            {a}
            {fill}
            {b ?? ''}
          </div>
          <div className="small dim">{ex.fr}</div>
        </>
      );
      break;
    }
    case 'transform':
      prompt = (
        <>
          <div className="muted">{ex.instruction}</div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <span className="zh-line">{ex.zh}</span>
            <AudioButton text={ex.zh} size="sm" />
          </div>
        </>
      );
      break;
    case 'error':
      prompt = (
        <>
          <div className="muted">Cette phrase contient une faute. Écris la phrase correcte.</div>
          <div className="zh-line" style={{ textDecoration: 'line-through', textDecorationColor: 'rgba(229,72,77,.6)' }}>
            {ex.zh}
          </div>
        </>
      );
      break;
    case 'translate':
      prompt = <div className="fr">« {ex.fr} »</div>;
      break;
    case 'choice':
      prompt = <div className="fr">{ex.question}</div>;
      break;
    case 'listen':
      prompt = (
        <>
          <div className="row" style={{ justifyContent: 'center' }}>
            <AudioButton text={ex.zh} autoPlay size="lg" label="Écouter" />
            <AudioButton text={ex.zh} rate={0.75} size="sm" label="Lent" />
          </div>
          {fb && <div className="zh-line">{ex.zh}</div>}
          <div className="fr">{ex.question}</div>
        </>
      );
      break;
  }

  // ---------- answer area ----------
  let area: ReactNode = null;
  if (isChoice) {
    area = (
      <div className="col" style={{ width: '100%', maxWidth: 560 }}>
        {options.map((o, i) => {
          let cls = 'btn';
          if (fb) {
            const right = ex.type === 'cloze' ? o === ex.answer : i === (ex as { answer: number }).answer;
            if (right) cls += ' selected';
            else if (fb.chosen === o) cls += ' btn-danger';
          }
          return (
            <button key={i} className={cls} style={{ justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => choose(i)} disabled={!!fb && fb.chosen !== o && !cls.includes('selected')}>
              <span className="kbd">{i + 1}</span>
              <span className={hasHan(o) ? 'hanzi' : ''} style={hasHan(o) ? { fontSize: 22 } : undefined}>
                {o}
              </span>
              {fb && cls.includes('selected') && <span className="correct">✓</span>}
            </button>
          );
        })}
      </div>
    );
  } else if (isBuild) {
    area = (
      <div className="col" style={{ width: '100%', maxWidth: 640 }}>
        {!typing && (
          <>
            <div className="dropzone" style={fb ? { borderColor: fb.correct ? 'var(--ok)' : 'var(--bad)', borderStyle: 'solid' } : undefined}>
              {placed.length === 0 && <span className="dim small">Clique sur les mots ci-dessous pour construire la phrase.</span>}
              {placed.map((ti, pos) => (
                <span key={pos} className="tile" onClick={() => removeTile(pos)} title="Retirer">
                  {tiles?.[ti]}
                </span>
              ))}
            </div>
            {tiles ? (
              <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
                {tiles.map((t, i) => (
                  <span key={i} className={'tile' + (placed.includes(i) || fb ? ' used' : '')} onClick={() => addTile(i)}>
                    {t}
                  </span>
                ))}
              </div>
            ) : (
              <div className="dim small">Préparation des mots…</div>
            )}
            {tileError && <div className="dim small">(découpage en caractères : {tileError})</div>}
          </>
        )}
        {typing && (
          <input
            ref={inputRef}
            className="hanzi"
            style={{ fontSize: 22, width: '100%' }}
            value={text}
            disabled={!!fb || checking}
            placeholder="Tape ta réponse en chinois…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (fb) next();
                else void checkText();
              }
            }}
          />
        )}
        {!fb && (
          <div className="row" style={{ justifyContent: 'center' }}>
            {!typing && (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setPlaced([])} disabled={!placed.length}>
                  Effacer
                </button>
                <button className="btn btn-primary" onClick={checkTiles} disabled={!placed.length}>
                  Vérifier <span className="kbd">Entrée</span>
                </button>
              </>
            )}
            {typing && (
              <button className="btn btn-primary" onClick={() => void checkText()} disabled={!text.trim() || checking}>
                {checking ? 'Correction…' : 'Vérifier'}
              </button>
            )}
            {ex.type !== 'order' && (
              <button className="btn btn-ghost btn-sm" onClick={() => setTyping((t) => !t)}>
                {typing ? 'Utiliser les tuiles' : 'J\'ai un clavier chinois'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---------- feedback ----------
  let feedback: ReactNode = null;
  if (fb) {
    const main = answers[0];
    const others = answers.slice(1).filter((a) => a !== main);
    const explanation = ex.type === 'error' || ex.type === 'choice' ? ex.explanation : undefined;
    const reveal = ex.type === 'listen' ? ex.zh : main;
    feedback = (
      <div className={'notice ' + (fb.correct ? 'notice-ok' : 'notice-bad')} style={{ width: '100%', maxWidth: 640, textAlign: 'left' }}>
        <div className="row">
          <strong className={fb.correct ? 'correct' : 'wrong'}>{fb.correct ? '✓ Correct' : '✗ Incorrect'}</strong>
          <span className="spacer" />
          {reveal && <AudioButton text={reveal} size="sm" autoPlay={isBuild || ex.type === 'cloze'} label="Écouter" />}
        </div>
        {!fb.correct && fb.chosen && (
          <div className="small muted" style={{ marginTop: 6 }}>
            Ta réponse : <span className={hasHan(fb.chosen) ? 'hanzi' : ''}>{fb.chosen}</span>
          </div>
        )}
        {main && (isBuild || ex.type === 'cloze') && (
          <div style={{ marginTop: 6 }}>
            <span className="small muted">{fb.correct ? 'Réponse : ' : 'Bonne réponse : '}</span>
            <span className="hanzi" style={{ fontSize: 22 }}>
              {main}
            </span>
            {others.length > 0 && (
              <div className="small dim">
                Aussi accepté : <span className="hanzi">{others.join(' ／ ')}</span>
              </div>
            )}
          </div>
        )}
        {!fb.correct && (ex.type === 'choice' || ex.type === 'listen') && (
          <div style={{ marginTop: 6 }}>
            <span className="small muted">Bonne réponse : </span>
            <span className={hasHan(options[ex.answer] ?? '') ? 'hanzi' : ''}>{options[ex.answer]}</span>
          </div>
        )}
        {explanation && <div className="small" style={{ marginTop: 8 }}>{explanation}</div>}
        {fb.ai && (
          <div className="small" style={{ marginTop: 8 }}>
            <span className="tag tag-info">Correcteur IA</span> {fb.ai}
            {fb.aiCorrected && !fb.correct && <div className="hanzi" style={{ fontSize: 20, marginTop: 4 }}>{fb.aiCorrected}</div>}
          </div>
        )}
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={next} autoFocus>
            Suivant <span className="kbd">Entrée</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card study-card" style={{ minHeight: 320 }}>
      <div className="study-prompt-label">{TYPE_LABEL[ex.type]}</div>
      {prompt}
      {area}
      {feedback}
    </div>
  );
}
