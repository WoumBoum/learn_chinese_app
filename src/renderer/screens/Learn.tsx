import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import { AudioButton, ErrorBox, Loading, ProgressBar, shuffle, speak, useKeys } from '../components/common';
import { CharCard, CharChip } from '../components/CharCard';
import { WordVideo } from '../components/WordVideo';
import { useNav } from '../App';
import type { CharInfo, DayPlan, Sentence, Word } from '../../shared/types';

interface BatchItem {
  word: Word;
  chars: (CharInfo & { isNew: boolean })[];
  comps: { c: string; fr: string[]; en: string }[];
  examples: Sentence[];
}

type Step = { kind: 'present'; idx: number } | { kind: 'quiz'; q: Quiz } | { kind: 'done' };
interface Quiz {
  type: 'meaning' | 'listen';
  item: BatchItem;
  options: string[];
  answer: string;
}

function buildQuiz(items: BatchItem[]): Quiz[] {
  const qs: Quiz[] = [];
  for (const it of items) {
    const others = shuffle(items.filter((x) => x !== it));
    const meaning = (x: BatchItem) => x.word.fr[0] ?? x.word.en[0] ?? '?';
    qs.push({ type: 'meaning', item: it, answer: meaning(it), options: shuffle([meaning(it), ...others.slice(0, 3).map(meaning)]) });
  }
  for (const it of shuffle(items)) {
    const others = shuffle(items.filter((x) => x !== it));
    qs.push({ type: 'listen', item: it, answer: it.word.w, options: shuffle([it.word.w, ...others.slice(0, 3).map((x) => x.word.w)]) });
  }
  return qs;
}

export function Learn(props: { source?: 'curriculum' | 'mission'; missionId?: string; count?: number }) {
  const { go } = useNav();
  const source = props.source ?? 'curriculum';
  const [items, setItems] = useState<BatchItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [step, setStep] = useState<Step>({ kind: 'present', idx: 0 });
  const [queue, setQueue] = useState<Quiz[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const [result, setResult] = useState<{ newChars: string[] } | null>(null);
  const [expressDay, setExpressDay] = useState(false);
  const start = useRef(Date.now());

  const load = async (mode?: 'standard') => {
    let count = props.count;
    if (!count) {
      // mode given = the learner switched the day to Standard (core:plan(mode) stores it)
      const plan = await call<DayPlan>('core:plan', mode);
      const block = plan.blocks.find((b) => b.type === (source === 'mission' ? 'briefing' : 'new'));
      count = block?.count ?? (plan.mode === 'express' ? 0 : Math.max(3, plan.newCap));
      if (!count && plan.mode === 'express') {
        // Express day: no new words unless the learner explicitly says they have time
        setExpressDay(true);
        setItems([]);
        return;
      }
    }
    setExpressDay(false);
    const batch = await call<BatchItem[]>('study:newBatch', { count: Math.max(1, count), source, missionId: props.missionId });
    start.current = Date.now();
    setItems(batch);
    // vidéos (mot + caractères) absentes de l'index : recherche en arrière-plan, sans bloquer l'écran
    if (batch.length) call('video:prefetch', batch.map((x) => x.word.w)).catch(() => undefined);
  };

  useEffect(() => {
    load().catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchToStandard = () => {
    setItems(null);
    load('standard').catch(setError);
  };

  const current = step.kind === 'present' && items ? items[step.idx] : null;
  useEffect(() => {
    if (current) speak(current.word.w);
  }, [current]);

  const nextFromPresent = () => {
    if (!items || step.kind !== 'present') return;
    if (step.idx + 1 < items.length) setStep({ kind: 'present', idx: step.idx + 1 });
    else {
      const q = buildQuiz(items);
      setQueue(q.slice(1));
      setStep({ kind: 'quiz', q: q[0] });
    }
  };

  const answerQuiz = (opt: string) => {
    if (step.kind !== 'quiz' || picked) return;
    setPicked(opt);
    if (opt !== step.q.answer) {
      setMistakes((m) => m + 1);
      // wrong answer: the question comes back at the end
      setQueue((q) => [...q, { ...step.q, options: shuffle(step.q.options) }]);
    }
    speak(step.q.item.word.w);
  };

  const nextQuiz = async () => {
    if (step.kind !== 'quiz' || !picked) return;
    setPicked(null);
    if (queue.length) {
      setStep({ kind: 'quiz', q: queue[0] });
      setQueue(queue.slice(1));
    } else {
      const r = await call<{ newChars: string[] }>('study:introduce', items!.map((x) => x.word.w), source, props.missionId);
      setResult(r);
      await call('core:logActivity', source === 'mission' ? 'briefing' : 'new', (Date.now() - start.current) / 60000, { words: items!.length });
      await call('core:markBlockDone', source === 'mission' ? 'briefing' : 'new');
      setStep({ kind: 'done' });
    }
  };

  useKeys(
    {
      Enter: () => (step.kind === 'present' ? nextFromPresent() : step.kind === 'quiz' && picked ? nextQuiz() : undefined),
      ArrowRight: () => step.kind === 'present' && nextFromPresent(),
      r: () => (current ? speak(current.word.w) : step.kind === 'quiz' ? speak(step.q.item.word.w) : undefined),
      '1': () => step.kind === 'quiz' && answerQuiz(step.q.options[0]),
      '2': () => step.kind === 'quiz' && answerQuiz(step.q.options[1]),
      '3': () => step.kind === 'quiz' && answerQuiz(step.q.options[2]),
      '4': () => step.kind === 'quiz' && answerQuiz(step.q.options[3]),
    },
    [step, picked, queue, items],
  );

  const total = useMemo(() => (items ? items.length * 3 : 1), [items]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!items) return <div className="page"><Loading /></div>;
  if (items.length === 0 && expressDay)
    return (
      <div className="page">
        <div className="empty">
          Jour Express : aucune nouveauté aujourd'hui, le système reste stable. Les nouveaux mots se rattrapent les jours où tu as plus de temps.
          <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
            <button className="btn" onClick={switchToStandard}>J'ai quand même du temps</button>
            <button className="btn btn-ghost" onClick={() => go('dashboard')}>Retour au QG</button>
          </div>
        </div>
      </div>
    );
  if (items.length === 0)
    return (
      <div className="page">
        <div className="empty">
          {source === 'mission' ? 'Tous les mots de la mission sont déjà appris. Tu peux lancer la mission !' : 'Aucun nouveau mot disponible.'}
          <div style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => go('dashboard')}>Retour au QG</button>
          </div>
        </div>
      </div>
    );

  const progressValue = step.kind === 'present' ? step.idx / total : step.kind === 'quiz' ? (items.length + (items.length * 2 - queue.length)) / total : 1;

  return (
    <div className="page study">
      <div className="page-header">
        <div>
          <div className="page-title">{source === 'mission' ? 'Briefing de mission' : 'Nouveaux mots'}</div>
          <div className="page-sub">
            {step.kind === 'present' ? `Présentation ${step.idx + 1}/${items.length} — écoute, répète à voix haute, observe les caractères.` : step.kind === 'quiz' ? 'Vérification rapide — sans pinyin.' : 'Terminé'}
          </div>
        </div>
      </div>
      <ProgressBar value={progressValue} />
      <div style={{ height: 14 }} />

      {current && <Presentation item={current} onNext={nextFromPresent} />}

      {step.kind === 'quiz' && (
        <div className="card study-card">
          <div className="study-prompt-label">{step.q.type === 'meaning' ? 'Que signifie ce mot ?' : 'Quel mot entends-tu ?'}</div>
          {step.q.type === 'meaning' ? (
            <div className="hanzi-xl">{step.q.item.word.w}</div>
          ) : (
            <button className="btn btn-lg" onClick={() => speak(step.q.item.word.w)} style={{ fontSize: 28 }}>
              🔊
            </button>
          )}
          <div className="grid-2" style={{ width: '100%', marginTop: 10 }}>
            {step.q.options.map((o, k) => {
              const cls = picked ? (o === step.q.answer ? ' r3' : o === picked ? ' r1' : '') : '';
              return (
                <button key={o + k} className={'btn btn-lg' + cls} onClick={() => answerQuiz(o)}>
                  <span className="kbd">{k + 1}</span>
                  <span className={step.q.type === 'listen' ? 'hanzi' : ''} style={step.q.type === 'listen' ? { fontSize: 26 } : {}}>
                    {o}
                  </span>
                </button>
              );
            })}
          </div>
          {picked && (
            <div className="answer">
              <div className="row">
                {/* Verification is "sans pinyin": hanzi + meaning + audio only (pinyin was shown at presentation). */}
                <span className="hanzi-md">{step.q.item.word.w}</span>
                <AudioButton text={step.q.item.word.w} size="sm" />
                <span className="fr">{step.q.item.word.fr.slice(0, 2).join(' ; ')}</span>
              </div>
              <button className="btn btn-primary" onClick={nextQuiz}>
                Suivant <span className="kbd">Entrée</span>
              </button>
            </div>
          )}
        </div>
      )}

      {step.kind === 'done' && result && (
        <div className="card center" style={{ padding: 40 }}>
          <div className="hanzi-lg" style={{ color: 'var(--ok)' }}>好</div>
          <h2>{items.length} mot(s) ajoutés à ta mémoire</h2>
          <p className="muted">
            {mistakes === 0 ? 'Sans faute !' : `${mistakes} erreur(s) corrigée(s) pendant la vérification.`} Les cartes entrent maintenant dans FSRS : leur première révision
            arrive tout de suite, puis à intervalles croissants.
          </p>
          {result.newChars.length > 0 && (
            <p>
              Nouveaux caractères à écrire : <span className="hanzi" style={{ fontSize: 24 }}>{result.newChars.join(' ')}</span>
            </p>
          )}
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={() => go('review')}>Première révision</button>
            {result.newChars.length > 0 && <button className="btn" onClick={() => go('writing')}>Écrire les caractères</button>}
            <button className="btn btn-ghost" onClick={() => go('dashboard')}>QG</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Presentation({ item, onNext }: { item: BatchItem; onNext: () => void }) {
  const w = item.word;
  // vidéo d'usage : ouverte d'office pour un mot d'un seul caractère, repliée sinon
  const single = [...w.w].length === 1;
  const [videoOpen, setVideoOpen] = useState(single);
  useEffect(() => setVideoOpen(single), [w.w, single]);
  const firstNew = item.chars.find((c) => c.isNew)?.c;
  return (
    <div className="card" style={{ padding: 28 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 28 }}>
        <div className="col" style={{ alignItems: 'center', minWidth: 220 }}>
          <div className="hanzi-xl">{w.w}</div>
          {/* Pinyin is shown once, at first presentation, to learn the sound. */}
          <div className="pinyin" style={{ fontSize: 24 }}>{w.py}</div>
          <div className="row">
            <AudioButton text={w.w} label="Écouter" />
            <AudioButton text={w.w} rate={0.7} label="Lent" size="sm" />
          </div>
        </div>
        <div className="col" style={{ flex: 1 }}>
          <div className="fr" style={{ fontSize: 22 }}>{w.fr.slice(0, 3).join(' ; ') || w.en.slice(0, 2).join(' ; ')}</div>
          <div className="row small muted">
            {w.band < 9 && <span className="tag">HSK {w.band}</span>}
            {w.cl.length > 0 && (
              <span>
                Classificateur : <span className="hanzi">{w.cl.join('、')}</span>
              </span>
            )}
          </div>
          {item.examples.length > 0 && (
            <div className="col" style={{ marginTop: 10 }}>
              <div className="card-title" style={{ margin: 0 }}>Exemples</div>
              {item.examples.map((s) => (
                <div key={s.id} className="row">
                  <AudioButton text={s.zh} size="sm" />
                  <span className="hanzi" style={{ fontSize: 20 }}>{s.zh}</span>
                  <span className="small muted">{s.fr[0]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {item.chars.length > 0 && (
        <div className="col" style={{ marginTop: 18, gap: 8 }}>
          <div className="card-title" style={{ margin: 0 }}>
            {item.chars.length > 1 ? 'Les caractères' : 'Le caractère'}
          </div>
          {/* premier nouveau caractère : fiche dépliée ; nouveaux suivants et déjà vus : puce qui se déplie à la demande
              (plusieurs fiches complètes empilées repoussaient « Suivant » très loin) */}
          {item.chars.map((c) =>
            c.isNew && c.c === firstNew ? (
              <CharCard key={c.c} char={c.c} />
            ) : (
              <CharChip key={c.c} char={c.c} gloss={`${c.fr[0] ?? c.en.split(/[;,]/)[0]} · ${c.isNew ? 'nouveau' : 'déjà vu'}`} compact={false} />
            ),
          )}
        </div>
      )}
      <div className="col" style={{ marginTop: 14, gap: 8 }}>
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={(e) => (e.currentTarget.blur(), setVideoOpen((v) => !v))} aria-expanded={videoOpen}>
          {videoOpen ? '▾' : '▸'} Le mot en contexte (vidéo)
        </button>
        {/* « ouvert » = vignette seulement, jamais de lecture automatique */}
        {videoOpen && <WordVideo key={w.w} target={w.w} slot="usage" />}
      </div>
      {/* collée en bas de la zone de défilement : consigne et « Suivant » visibles quelle que soit la hauteur de la fiche */}
      <div className="row present-actions">
        <span className="small dim">Répète le mot 3 fois à voix haute avant de passer au suivant.</span>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={onNext}>
          Suivant <span className="kbd">Entrée</span>
        </button>
      </div>
    </div>
  );
}
