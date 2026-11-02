// Paper handwriting sessions: the app gives repetition instructions, shows the model,
// the learner writes on paper, compares, and self-grades (FSRS "write" face).
import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { AudioButton, ErrorBox, Loading, ProgressBar, speak, useKeys } from '../components/common';
import { StrokeAnimator, type StrokeAnimatorHandle } from '../components/StrokeAnimator';
import { CharNotes } from '../components/WordPopup';
import { CharCard } from '../components/CharCard';
import { useNav } from '../App';
import type { CharInfo, Grade } from '../../shared/types';

interface CharItem {
  cardId: string;
  isNew: boolean;
  char: CharInfo;
  words: { w: string; fr: string[] }[];
}
interface Session {
  chars: CharItem[];
  words: { w: string; fr: string[] }[];
  copy: { zh: string; fr: string }[];
  recall: { zh: string; fr: string }[];
  dictation: { zh: string; fr: string }[];
}

const BASIC_STROKES = [
  { name: '横 héng', desc: 'trait horizontal, de gauche à droite', ex: '一' },
  { name: '竖 shù', desc: 'trait vertical, de haut en bas', ex: '十' },
  { name: '撇 piě', desc: 'trait tombant vers la gauche', ex: '八' },
  { name: '捺 nà', desc: 'trait tombant vers la droite, qui s\'élargit', ex: '人' },
  { name: '点 diǎn', desc: 'point, court et appuyé', ex: '六' },
  { name: '折 zhé', desc: 'trait qui tourne (horizontal puis vertical)', ex: '口' },
];

type Phase = 'observe' | 'copy' | 'memory' | 'compare' | 'recopy';

export function Writing(props: { long?: boolean }) {
  const { go } = useNav();
  const [long, setLong] = useState(!!props.long);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [section, setSection] = useState<'intro' | 'basics' | 'chars' | 'words' | 'copy' | 'recall' | 'dictation' | 'done'>('intro');
  const start = useRef(Date.now());

  const load = (l: boolean) => {
    setSession(null);
    call<Session>('study:writingSession', { long: l }).then(setSession).catch(setError);
  };
  useEffect(() => load(long), [long]);

  const finish = async () => {
    await call('core:logActivity', 'writing', (Date.now() - start.current) / 60000);
    await call('core:markBlockDone', 'writing');
    setSection('done');
  };

  const nextSection = (from: typeof section) => {
    const order: (typeof section)[] = ['chars', 'words', 'copy', 'recall', 'dictation'];
    let idx = order.indexOf(from as never) + 1;
    while (idx < order.length) {
      const s = order[idx];
      const has = s === 'chars' ? session!.chars.length : (session as unknown as Record<string, unknown[]>)[s]?.length;
      if (has) return setSection(s);
      idx++;
    }
    finish();
  };

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!session) return <div className="page"><Loading /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Écriture — sur papier</div>
          <div className="page-sub">L'app donne la consigne et le modèle ; tu écris sur ta feuille (idéalement quadrillée 田字格), puis tu compares.</div>
        </div>
        {section === 'intro' && (
          <div className="mode-switch">
            <button className={!long ? 'active' : ''} onClick={() => setLong(false)}>Quotidienne</button>
            <button className={long ? 'active' : ''} onClick={() => setLong(true)}>Séance longue</button>
          </div>
        )}
      </div>

      {section === 'intro' && (
        <div className="stack">
          <div className="card">
            <div className="card-title">Protocole (inspiré des écoles militaires : répétition + rappel actif)</div>
            <ol className="muted" style={{ margin: 0, paddingLeft: 20 }}>
              <li><b>Observer</b> l'ordre des traits (animation, puis trait par trait avec Espace).</li>
              <li><b>Copier en regardant</b> : remplis le nombre de cases demandé.</li>
              <li><b>Écrire de mémoire</b> : modèle caché, à partir du sens et du son.</li>
              <li><b>Comparer</b> avec le modèle numéroté, puis t'auto-évaluer honnêtement : la note part dans FSRS.</li>
            </ol>
            <p className="small dim" style={{ marginBottom: 0 }}>Les caractères déjà connus sautent directement à l'étape 3 (rappel), c'est ce qui ancre la mémoire. Une erreur → on recopie 5 fois.</p>
          </div>
          <div className="grid-3">
            <div className="stat card"><span className="stat-value">{session.chars.filter((c) => c.isNew).length}</span><span className="stat-label">nouveaux caractères</span></div>
            <div className="stat card"><span className="stat-value">{session.chars.filter((c) => !c.isNew).length}</span><span className="stat-label">à réviser</span></div>
            <div className="stat card"><span className="stat-value">{session.copy.length + session.recall.length + session.dictation.length}</span><span className="stat-label">phrases</span></div>
          </div>
          <div className="row">
            <button className="btn btn-primary btn-lg" disabled={!session.chars.length && !session.copy.length} onClick={() => nextSection('intro' as never)}>
              Commencer
            </button>
            <button className="btn" onClick={() => setSection('basics')}>Traits de base (échauffement)</button>
            {!session.chars.length && !long && <span className="muted">Rien à écrire aujourd'hui — essaie la séance longue ou l'échauffement.</span>}
          </div>
        </div>
      )}

      {section === 'basics' && <Basics onDone={() => setSection('intro')} />}
      {section === 'chars' && <CharDrill items={session.chars} onDone={() => nextSection('chars')} />}
      {section === 'words' && <WordDrill items={session.words} onDone={() => nextSection('words')} />}
      {section === 'copy' && <SentenceDrill mode="copy" items={session.copy} onDone={() => nextSection('copy')} />}
      {section === 'recall' && <SentenceDrill mode="recall" items={session.recall} onDone={() => nextSection('recall')} />}
      {section === 'dictation' && <SentenceDrill mode="dictation" items={session.dictation} onDone={() => nextSection('dictation')} />}
      {section === 'done' && (
        <div className="card center" style={{ padding: 40 }}>
          <div className="hanzi-lg" style={{ color: 'var(--ok)' }}>写完了</div>
          <h2>Séance d'écriture terminée</h2>
          <p className="muted">Tes auto-évaluations ont été envoyées à FSRS : les caractères ratés reviendront vite.</p>
          <button className="btn btn-primary" onClick={() => go('dashboard')}>Retour au QG</button>
        </div>
      )}
    </div>
  );
}

function Counter({ target, label, onComplete }: { target: number; label: string; onComplete: () => void }) {
  const [n, setN] = useState(0);
  useEffect(() => setN(0), [target, label]);
  useKeys({ '+': () => setN((x) => Math.min(target, x + 1)), '=': () => setN((x) => Math.min(target, x + 1)) }, []);
  return (
    <div className="col" style={{ alignItems: 'center' }}>
      <div className="fr">{label}</div>
      <div className="row">
        {Array.from({ length: target }, (_, i) => (
          <span key={i} style={{ width: 16, height: 16, borderRadius: 4, background: i < n ? 'var(--ok)' : 'var(--bg-2)', border: '1px solid var(--line)' }} />
        ))}
      </div>
      <div className="row">
        <button className="btn" onClick={() => setN((x) => Math.min(target, x + 1))}>
          +1 écrit <span className="kbd">+</span>
        </button>
        <button className="btn btn-primary" onClick={onComplete}>
          {n >= target ? 'Fait — suivant' : 'Passer à la suite'} <span className="kbd">Entrée</span>
        </button>
      </div>
    </div>
  );
}

function CharDrill({ items, onDone }: { items: CharItem[]; onDone: () => void }) {
  const [idx, setIdx] = useState(0);
  const item = items[idx];
  const [phase, setPhase] = useState<Phase>(item?.isNew ? 'observe' : 'memory');
  const anim = useRef<StrokeAnimatorHandle>(null);
  const shown = useRef(Date.now());
  const busy = useRef(false);

  useEffect(() => {
    if (!item) return;
    setPhase(item.isNew ? 'observe' : 'memory');
    shown.current = Date.now();
    const w = item.words[0]?.w ?? item.char.c;
    speak(w);
  }, [idx, item]);

  const next = () => (idx + 1 < items.length ? setIdx(idx + 1) : onDone());
  const grade = async (g: Grade) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await call('study:answer', item.cardId, g, Date.now() - shown.current);
      if (g === 1) setPhase('recopy');
      else next();
    } finally {
      busy.current = false;
    }
  };

  useKeys(
    {
      Space: () => (phase === 'observe' ? anim.current?.nextStroke() : undefined),
      Enter: () => {
        if (phase === 'observe') setPhase('copy');
        else if (phase === 'copy') setPhase('memory');
        else if (phase === 'memory') setPhase('compare');
        else if (phase === 'recopy') next();
      },
      '1': () => phase === 'compare' && grade(1),
      '2': () => phase === 'compare' && grade(2),
      '3': () => phase === 'compare' && grade(3),
      '4': () => phase === 'compare' && grade(4),
      // réécouter le mot (la fiche du caractère a aussi son propre bouton 🔊 en phase « observe »)
      r: () => item && speak(item.words[0]?.w ?? item.char.c),
    },
    [phase, idx],
  );

  if (!item) return null;
  const c = item.char;
  const hintWord = item.words[0];
  const meaning = c.fr.slice(0, 2).join(' ; ') || c.en;
  return (
    <div className="stack">
      <div className="row">
        <span className="muted small">Caractère {idx + 1}/{items.length}</span>
        <div style={{ flex: 1 }}><ProgressBar value={idx / items.length} /></div>
        <span className={'tag ' + (item.isNew ? 'tag-info' : '')}>{item.isNew ? 'Nouveau' : 'Révision'}</span>
      </div>
      <div className="card" style={{ padding: 28 }}>
        {(phase === 'observe' || phase === 'copy' || phase === 'recopy') && (
          <div className="row" style={{ alignItems: 'flex-start', gap: 30 }}>
            <div className="col" style={{ alignItems: 'center' }}>
              <StrokeAnimator key={c.c} ref={anim} char={c.c} size={260} numbered={phase !== 'observe'} />
              <div className="row">
                <button className="btn btn-sm" onClick={() => anim.current?.animate()}>Rejouer</button>
                <button className="btn btn-sm" onClick={() => anim.current?.nextStroke()}>Trait suivant <span className="kbd">Espace</span></button>
              </div>
            </div>
            <div className="col" style={{ flex: 1, minWidth: 0 }}>
              {phase === 'observe' ? (
                // fiche illustrée (dessin derrière le caractère, origine, composants) à côté de l'animation
                <CharCard char={c.c} compact showVideo={false} />
              ) : (
                <>
                  <CharNotes c={c} />
                  <div className="small muted">{c.n} traits</div>
                  {item.words.length > 0 && (
                    <div className="small">
                      Dans : {item.words.map((w) => <span key={w.w} className="hanzi" style={{ marginRight: 10, fontSize: 18 }}>{w.w}</span>)}
                    </div>
                  )}
                </>
              )}
              {/* en phase « observe », la CharCard porte déjà le bouton audio : pas de doublon orphelin */}
              {phase !== 'observe' && <div className="row"><AudioButton text={hintWord?.w ?? c.c} size="sm" /></div>}
              <div style={{ height: 10 }} />
              {phase === 'observe' && (
                <div className="col">
                  <div className="notice">Observe l'animation. Puis trace-le <b>dans l'air avec ton doigt</b> en suivant l'ordre, trait par trait (Espace).</div>
                  <button className="btn btn-primary" onClick={() => setPhase('copy')}>J'ai compris l'ordre <span className="kbd">Entrée</span></button>
                </div>
              )}
              {phase === 'copy' && <Counter target={8} label={`Recopie « ${c.c} » 8 fois en regardant le modèle (dis son sens à chaque fois).`} onComplete={() => setPhase('memory')} />}
              {phase === 'recopy' && <Counter target={5} label={`Erreur notée. Recopie « ${c.c} » 5 fois en suivant l'ordre numéroté.`} onComplete={next} />}
            </div>
          </div>
        )}
        {phase === 'memory' && (
          <div className="center" style={{ minHeight: 300, gap: 14 }}>
            <div className="study-prompt-label">De mémoire — modèle caché</div>
            <div className="fr" style={{ fontSize: 26 }}>{meaning}</div>
            {hintWord && hintWord.w.length > 1 && (
              <div className="muted">
                comme dans <span className="hanzi" style={{ fontSize: 22 }}>{hintWord.w.replace(c.c, '＿')}</span> ({hintWord.fr[0]})
              </div>
            )}
            <AudioButton text={hintWord?.w ?? c.c} />
            <div className="notice">Écris-le <b>{item.isNew ? 3 : 2} fois</b> sur ta feuille sans regarder, puis compare.</div>
            <button className="btn btn-primary" onClick={() => setPhase('compare')}>Comparer avec le modèle <span className="kbd">Entrée</span></button>
          </div>
        )}
        {phase === 'compare' && (
          <div className="row" style={{ gap: 30, alignItems: 'center' }}>
            <StrokeAnimator key={c.c + '-cmp'} char={c.c} size={260} numbered autoAnimate={false} />
            <div className="col" style={{ flex: 1 }}>
              <div className="fr">Compare : forme, proportions, <b>ordre et sens des traits</b>.</div>
              <div className="small muted">Juste = identique, ordre correct. Hésitant = juste mais lent ou un trait douteux. Faux = trait manquant/en trop ou ordre faux.</div>
              <div className="rating-bar" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <button className="btn r1" onClick={() => grade(1)}>Faux <span className="kbd">1</span></button>
                <button className="btn r2" onClick={() => grade(2)}>Hésitant <span className="kbd">2</span></button>
                <button className="btn r3" onClick={() => grade(3)}>Juste <span className="kbd">3</span></button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WordDrill({ items, onDone }: { items: { w: string; fr: string[] }[]; onDone: () => void }) {
  const [idx, setIdx] = useState(0);
  const [stage, setStage] = useState<'copy' | 'memory' | 'check'>('copy');
  const it = items[idx];
  useEffect(() => {
    setStage('copy');
    if (it) speak(it.w);
  }, [idx, it]);
  const next = () => (idx + 1 < items.length ? setIdx(idx + 1) : onDone());
  useKeys({ Enter: () => (stage === 'copy' ? setStage('memory') : stage === 'memory' ? setStage('check') : next()) }, [stage, idx]);
  if (!it) return null;
  return (
    <div className="card center" style={{ minHeight: 340, gap: 14 }}>
      <div className="study-prompt-label">Mots — {idx + 1}/{items.length}</div>
      {stage === 'copy' && (
        <>
          <div className="hanzi-xl">{it.w}</div>
          <div className="fr">{it.fr.join(' ; ')}</div>
          <Counter target={5} label="Écris le mot entier 5 fois en regardant." onComplete={() => setStage('memory')} />
        </>
      )}
      {stage === 'memory' && (
        <>
          <div className="fr" style={{ fontSize: 26 }}>{it.fr.join(' ; ')}</div>
          <AudioButton text={it.w} />
          <div className="notice">Cache ta feuille et écris-le 2 fois de mémoire.</div>
          <button className="btn btn-primary" onClick={() => setStage('check')}>Vérifier <span className="kbd">Entrée</span></button>
        </>
      )}
      {stage === 'check' && (
        <>
          <div className="hanzi-xl">{it.w}</div>
          <button className="btn btn-primary" onClick={next}>Suivant <span className="kbd">Entrée</span></button>
        </>
      )}
    </div>
  );
}

function SentenceDrill({ mode, items, onDone }: { mode: 'copy' | 'recall' | 'dictation'; items: { zh: string; fr: string }[]; onDone: () => void }) {
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState(0);
  const it = items[idx];
  useEffect(() => {
    setRevealed(mode === 'copy');
    if (it && mode === 'dictation') speak(it.zh, 0.85);
  }, [idx, it, mode]);
  const next = (ok?: boolean) => {
    if (ok) setScore((s) => s + 1);
    if (idx + 1 < items.length) setIdx(idx + 1);
    else {
      call('core:logActivity', 'writing', 0, { mode, score: score + (ok ? 1 : 0), total: items.length });
      onDone();
    }
  };
  useKeys({ Enter: () => (!revealed ? setRevealed(true) : mode === 'copy' ? next(true) : undefined), r: () => it && speak(it.zh, 0.85) }, [revealed, idx]);
  if (!it) return null;
  const title = mode === 'copy' ? 'Phrases — copie' : mode === 'recall' ? 'Phrases — de mémoire' : 'Dictée';
  const instr =
    mode === 'copy'
      ? 'Recopie la phrase 2 fois, en lisant chaque caractère à voix haute.'
      : mode === 'recall'
        ? 'Écris cette phrase en chinois de mémoire, puis compare.'
        : 'Écoute (R pour réécouter) et écris ce que tu entends.';
  return (
    <div className="card center" style={{ minHeight: 340, gap: 16 }}>
      <div className="study-prompt-label">{title} — {idx + 1}/{items.length}</div>
      <div className="notice">{instr}</div>
      {mode !== 'dictation' && <div className="fr" style={{ fontSize: 22 }}>{it.fr}</div>}
      {mode === 'dictation' && <AudioButton text={it.zh} rate={0.85} label="Réécouter" />}
      {revealed ? (
        <>
          <div className="hanzi-lg" style={{ letterSpacing: 4 }}>{it.zh}</div>
          {mode === 'dictation' && <div className="small muted">{it.fr}</div>}
          {mode === 'copy' ? (
            <button className="btn btn-primary" onClick={() => next(true)}>Recopiée — suivante <span className="kbd">Entrée</span></button>
          ) : (
            <div className="row">
              <button className="btn r1" onClick={() => next(false)}>Erreurs</button>
              <button className="btn r3" onClick={() => next(true)}>Correct</button>
            </div>
          )}
        </>
      ) : (
        <button className="btn btn-primary" onClick={() => setRevealed(true)}>Voir la correction <span className="kbd">Entrée</span></button>
      )}
    </div>
  );
}

function Basics({ onDone }: { onDone: () => void }) {
  return (
    <div className="stack">
      <div className="notice">Échauffement de la main : pour chaque trait, remplis <b>une ligne entière</b> (10 cases) sur ta feuille. Garde le poignet souple, respecte la direction.</div>
      <div className="grid-3">
        {BASIC_STROKES.map((s) => (
          <div key={s.name} className="card col" style={{ alignItems: 'center' }}>
            <StrokeAnimator char={s.ex} size={130} speed={0.8} />
            <div style={{ fontWeight: 600 }}>{s.name}</div>
            <div className="small muted" style={{ textAlign: 'center' }}>{s.desc}</div>
            <div className="small dim">Exemple : <span className="hanzi">{s.ex}</span> — puis 5× le caractère</div>
          </div>
        ))}
      </div>
      <div className="card small muted">
        Règles d'ordre des traits : de haut en bas, de gauche à droite ; horizontal avant vertical (十) ; gauche-tombant avant droite-tombant (人) ; l'extérieur avant l'intérieur, on ferme la boîte en dernier (国) ; le centre avant les côtés quand symétrique (小).
      </div>
      <button className="btn btn-primary" onClick={onDone}>Terminé</button>
    </div>
  );
}
