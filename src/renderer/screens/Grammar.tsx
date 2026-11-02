// Grammar: overview by phase, lessons (cours + ~10 exercices, gate 80 %), FSRS reviews, « Séance du jour ».
import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { useNav } from '../App';
import type { GrammarExercise as Exercise, GrammarPoint, GrammarStatus, Grade } from '../../shared/types';
import { AudioButton, ErrorBox, Loading, Markdown, ProgressBar, fmtInterval, toast, useAsync, useKeys } from '../components/common';
import { GrammarExercise } from '../components/GrammarExercise';
import { GRAMMAR_MIN, GRAMMAR_PASS, gradeLabel, keyPoints, lessonOrder } from '../../core/grammar';

interface SessionPlan {
  due: { id: string; title: string; pattern: string }[];
  next: { id: string; title: string; pattern: string; reason: 'new' | 'retry'; bestScore: number | null } | null;
  totalDue: number;
}
interface CompleteResult {
  status: GrammarStatus;
  unlocked: { id: string; title: string } | null;
  nextDue: number | null;
  hasNext: boolean;
}
interface ReviewResult {
  grade: Grade;
  due: number;
  intervalMs: number;
  correct: number;
  total: number;
}

const LESSON_SIZE = 10;
const REVIEW_SIZE = 4;
const PHASE_NAMES: Record<number, string> = { 1: 'Phase 1 — Fondations', 2: 'Phase 2 — Consolidation', 3: 'Phase 3 — Autonomie' };
const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)} %`);

type View = { k: 'home' } | { k: 'lesson'; id: string } | { k: 'review'; ids: string[] } | { k: 'session'; reviewsOnly?: boolean };

export function GrammarHome(props: Record<string, unknown>) {
  const initial: View = props.session ? { k: 'session', reviewsOnly: !!props.reviewsOnly } : typeof props.id === 'string' ? { k: 'lesson', id: props.id } : { k: 'home' };
  const [view, setView] = useState<View>(initial);
  const [n, setN] = useState(0); // remount key for the home view
  const home = () => {
    setView({ k: 'home' });
    setN((x) => x + 1);
  };
  if (view.k === 'lesson') return <LessonRunner key={view.id} id={view.id} onExit={home} onOpen={(id) => setView({ k: 'lesson', id })} />;
  if (view.k === 'review') return <ReviewStandalone ids={view.ids} onExit={home} />;
  if (view.k === 'session') return <SessionRunner reviewsOnly={view.reviewsOnly} onExit={home} />;
  return <Overview key={n} onLesson={(id) => setView({ k: 'lesson', id })} onReview={(ids) => setView({ k: 'review', ids })} onSession={() => setView({ k: 'session' })} />;
}

// ======================================================================= overview
function Overview({ onLesson, onReview, onSession }: { onLesson: (id: string) => void; onReview: (ids: string[]) => void; onSession: () => void }) {
  const list = useAsync(() => call<GrammarStatus[]>('grammar:list'), []);
  const plan = useAsync(() => call<SessionPlan>('grammar:session'), []);
  if (list.error) return <div className="page"><ErrorBox error={list.error} /></div>;
  if (list.loading || !list.data) return <div className="page"><Loading /></div>;
  const gs = list.data;
  const phases = [...new Set(gs.map((g) => g.phase))].sort();
  const mastered = gs.filter((g) => g.state === 'mastered').length;
  const learning = gs.filter((g) => g.state === 'learning').length;
  const dueIds = gs.filter((g) => g.due).map((g) => g.id);
  const p = plan.data;
  const sessionEmpty = p && p.due.length === 0 && !p.next;

  const lockReason = (i: number): string => {
    const prev = gs[i - 1];
    if (prev && !(prev.lessonDone && ((prev.bestScore ?? 0) >= GRAMMAR_PASS || prev.state === 'mastered'))) return 'Termine le point précédent avec au moins 80 %.';
    return `Se débloque à la phase ${gs[i].phase} du vocabulaire.`;
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Grammaire</div>
          <div className="page-sub">Cours, exercices interactifs et révisions espacées (FSRS) de chaque règle.</div>
        </div>
        <div className="row">
          <div className="stat"><span className="stat-value">{mastered}</span><span className="stat-label">maîtrisés</span></div>
          <div className="stat"><span className="stat-value">{learning}</span><span className="stat-label">en cours</span></div>
          <div className="stat"><span className="stat-value">{gs.length}</span><span className="stat-label">points</span></div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 22 }}>
        <div className="card highlight">
          <div className="card-title">Séance du jour</div>
          {!p ? (
            <Loading />
          ) : sessionEmpty ? (
            <div className="muted">Rien d'urgent : aucune révision due et aucun nouveau point disponible pour l'instant.</div>
          ) : (
            <div className="stack">
              <div>
                {p.due.length > 0 ? (
                  <div>
                    <strong>{p.due.length}</strong> point(s) à réviser{p.totalDue > p.due.length ? ` (sur ${p.totalDue} dus)` : ''} — {REVIEW_SIZE} exercices chacun.
                  </div>
                ) : (
                  <div className="muted">Aucune révision due.</div>
                )}
                {p.next && (
                  <div>
                    {p.next.reason === 'new' ? 'Nouvelle leçon : ' : 'À refaire (80 % requis) : '}
                    <strong>{p.next.title}</strong>
                  </div>
                )}
              </div>
              <button className="btn btn-primary btn-lg" onClick={onSession}>
                Lancer la séance du jour
              </button>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title">Comment ça marche</div>
          <div className="small muted stack">
            <div>Chaque point = un cours + ~{LESSON_SIZE} exercices. <strong>80 %</strong> débloquent le point suivant ; sous 60 %, la leçon est à refaire.</div>
            <div>Une fois la leçon validée, la règle entre dans le SRS : à chaque révision, {REVIEW_SIZE} exercices jamais vus récemment, notés automatiquement (tout juste et rapide = Facile, une erreur = Difficile, deux = À revoir).</div>
            <div>Un point est « maîtrisé » quand sa stabilité FSRS dépasse 3 semaines.</div>
          </div>
          {dueIds.length > 0 && (
            <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => onReview(dueIds)}>
              Réviser seulement les {dueIds.length} point(s) dus
            </button>
          )}
        </div>
      </div>

      {gs.length === 0 && <div className="empty">Aucune leçon de grammaire trouvée (content/grammar/phaseN.json).</div>}
      {phases.map((ph) => (
        <div key={ph} style={{ marginBottom: 24 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <h3>{PHASE_NAMES[ph] ?? `Phase ${ph}`}</h3>
            <span className="tag">
              {gs.filter((g) => g.phase === ph && g.state === 'mastered').length}/{gs.filter((g) => g.phase === ph).length} maîtrisés
            </span>
          </div>
          <div className="list">
            {gs.map((g, i) =>
              g.phase !== ph ? null : (
                <div
                  key={g.id}
                  className={'list-item' + (g.state !== 'locked' ? ' clickable' : '')}
                  style={g.state === 'locked' ? { opacity: 0.5 } : undefined}
                  onClick={() => g.state !== 'locked' && onLesson(g.id)}
                  title={g.state === 'locked' ? lockReason(i) : undefined}
                >
                  <span className="dim small" style={{ width: 44 }}>{g.id}</span>
                  <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{g.title}</div>
                    <div className="hanzi small muted" style={{ whiteSpace: 'pre-line' }}>{g.pattern}</div>
                    {g.state === 'locked' && <div className="small dim">🔒 {lockReason(i)}</div>}
                    {g.state === 'learning' && (g.bestScore ?? 0) < GRAMMAR_PASS && (
                      <div className="small" style={{ color: 'var(--warn)' }}>Meilleur score {pct(g.bestScore)} : refais la leçon pour atteindre 80 % et débloquer la suite.</div>
                    )}
                  </div>
                  {g.bestScore != null && <span className="small muted">{pct(g.bestScore)}</span>}
                  {g.due && <span className="tag tag-warn">à réviser</span>}
                  <StateTag s={g} />
                  {g.due && (
                    <button
                      className="btn btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onReview([g.id]);
                      }}
                    >
                      Réviser
                    </button>
                  )}
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StateTag({ s }: { s: GrammarStatus }) {
  if (s.state === 'mastered') return <span className="tag tag-ok">maîtrisé</span>;
  if (s.state === 'learning') return <span className="tag tag-info">en cours</span>;
  if (s.state === 'available') return <span className="tag tag-warn">{s.bestScore != null ? 'à refaire' : 'disponible'}</span>;
  return <span className="tag">verrouillé</span>;
}

// ======================================================================= shared bits
function PatternBox({ pattern }: { pattern: string }) {
  return (
    <div className="card" style={{ background: 'var(--bg-2)', borderColor: 'var(--gold)' }}>
      <div className="card-title">Structure</div>
      <div className="hanzi-md" style={{ whiteSpace: 'pre-line' }}>{pattern}</div>
    </div>
  );
}

function Remember({ p }: { p: GrammarPoint }) {
  const pts = keyPoints(p.explanation, 5);
  return (
    <div className="card">
      <div className="card-title">À retenir</div>
      <div className="hanzi-md" style={{ whiteSpace: 'pre-line', marginBottom: 8, color: 'var(--gold)' }}>{p.pattern}</div>
      {pts.length > 0 && <Markdown text={pts.map((x) => '- ' + x).join('\n')} />}
      <div className="list">
        {p.examples.slice(0, 2).map((e, i) => (
          <div key={i} className="row">
            <AudioButton text={e.zh} size="sm" />
            <span className="hanzi" style={{ fontSize: 20 }}>{e.zh}</span>
            <span className="muted small">{e.fr}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Runs a list of exercises one by one; reports the boolean results and the elapsed time. */
function ExerciseRun({ exercises, onFinish, title }: { exercises: Exercise[]; onFinish: (results: boolean[], ms: number) => void; title?: string }) {
  const [i, setI] = useState(0);
  const results = useRef<boolean[]>([]);
  const t0 = useRef(Date.now());
  const done = (ok: boolean) => {
    results.current = [...results.current, ok];
    if (i + 1 >= exercises.length) onFinish(results.current, Date.now() - t0.current);
    else setI(i + 1);
  };
  const ok = results.current.filter(Boolean).length;
  return (
    <div className="stack">
      <div className="row">
        <span className="small muted">{title}</span>
        <span className="spacer" />
        <span className="small muted">
          Exercice {i + 1}/{exercises.length} · {ok} juste(s)
        </span>
      </div>
      <ProgressBar value={i / exercises.length} />
      <GrammarExercise key={i} ex={exercises[i]} onDone={done} />
    </div>
  );
}

// ======================================================================= lesson
function LessonRunner({ id, onExit, onOpen, onFinish, inSession }: { id: string; onExit: () => void; onOpen?: (id: string) => void; onFinish?: (score: number) => void; inSession?: boolean }) {
  const { data: p, error, loading } = useAsync(() => call<GrammarPoint>('grammar:get', id), [id]);
  const [stage, setStage] = useState<'learn' | 'ex' | 'result'>('learn');
  const [exs, setExs] = useState<Exercise[] | null>(null);
  const [score, setScore] = useState(0);
  const [res, setRes] = useState<CompleteResult | null>(null);
  const t0 = useRef(Date.now());
  const [attempt, setAttempt] = useState(0);

  const start = async () => {
    try {
      const set = await call<Exercise[]>('grammar:reviewSet', id, LESSON_SIZE);
      setExs(lessonOrder(set));
      setAttempt((a) => a + 1);
      setStage('ex');
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e));
    }
  };
  const finish = async (results: boolean[]) => {
    const s = results.length ? results.filter(Boolean).length / results.length : 0;
    setScore(s);
    setStage('result');
    try {
      setRes(await call<CompleteResult>('grammar:complete', id, s, Date.now() - t0.current));
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e));
    }
    t0.current = Date.now();
  };

  useKeys(stage === 'learn' ? { Enter: () => void start() } : {}, [stage]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (loading || !p) return <div className="page"><Loading /></div>;

  const header = (
    <div className="page-header">
      <div>
        <div className="page-sub">
          {inSession ? 'Séance du jour · ' : ''}Leçon {p.id} · HSK {p.hsk}
        </div>
        <div className="page-title">{p.title}</div>
      </div>
      {!inSession && (
        <button className="btn btn-ghost" onClick={onExit}>
          ← Grammaire
        </button>
      )}
    </div>
  );

  if (stage === 'learn')
    return (
      <div className="page study">
        {header}
        <div className="stack">
          <PatternBox pattern={p.pattern} />
          <div className="card">
            <div className="card-title">Le cours</div>
            <Markdown text={p.explanation} />
          </div>
          <div className="card">
            <div className="card-title">Exemples</div>
            <div className="list">
              {p.examples.map((e, i) => (
                <div key={i} className="list-item">
                  <AudioButton text={e.zh} size="sm" />
                  <div className="col" style={{ gap: 0 }}>
                    <span className="hanzi" style={{ fontSize: 22 }}>{e.zh}</span>
                    <span className="muted small">{e.fr}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary btn-lg" onClick={() => void start()}>
              Passer aux exercices <span className="kbd">Entrée</span>
            </button>
          </div>
        </div>
      </div>
    );

  if (stage === 'ex' && exs)
    return (
      <div className="page study">
        {header}
        <ExerciseRun key={attempt} exercises={exs} title={p.pattern.split('\n')[0]} onFinish={(r) => void finish(r)} />
      </div>
    );

  // result
  const passed = score >= GRAMMAR_PASS;
  const validated = score >= GRAMMAR_MIN;
  return (
    <div className="page study">
      {header}
      <div className="stack">
        <div className={'card center'} style={{ padding: 28 }}>
          <div className="stat-label">Score</div>
          <div className="stat-value" style={{ fontSize: 48, color: passed ? 'var(--ok)' : validated ? 'var(--warn)' : 'var(--bad)' }}>{pct(score)}</div>
          <div style={{ width: 280, marginTop: 8 }}>
            <ProgressBar value={score} ok={passed} />
          </div>
          <div style={{ marginTop: 14, maxWidth: 560 }}>
            {passed ? (
              <div className="notice notice-ok">
                Point validé ! La règle entre dans tes révisions espacées.
                {res?.unlocked ? ` Point suivant débloqué : « ${res.unlocked.title} ».` : ''}
                {res?.nextDue ? ` Première révision dans ${fmtInterval(res.nextDue - Date.now())}.` : ''}
              </div>
            ) : validated ? (
              <div className="notice notice-warn">
                Leçon validée et ajoutée aux révisions, mais il faut <strong>80 %</strong> pour débloquer le point suivant (meilleur score : {pct(res?.status.bestScore ?? score)}). Refais les exercices quand tu veux.
              </div>
            ) : (
              <div className="notice notice-bad">
                Moins de 60 % : je te recommande de <strong>relire le cours</strong> et ses exemples, puis de refaire les exercices. La règle n'entre pas encore dans les révisions.
              </div>
            )}
          </div>
        </div>
        <Remember p={p} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {!validated && (
            <button
              className="btn"
              onClick={() => {
                t0.current = Date.now();
                setStage('learn');
              }}
            >
              Relire le cours
            </button>
          )}
          {!passed && (
            <button className="btn" onClick={() => void start()}>
              Refaire les exercices
            </button>
          )}
          {inSession ? (
            <button className="btn btn-primary" onClick={() => onFinish?.(score)}>
              Terminer la séance
            </button>
          ) : (
            <>
              {res?.unlocked && onOpen && (
                <button className="btn" onClick={() => onOpen(res.unlocked!.id)}>
                  Leçon suivante →
                </button>
              )}
              <button className="btn btn-primary" onClick={onExit}>
                Retour à la grammaire
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ======================================================================= reviews
interface ReviewOutcome {
  id: string;
  title: string;
  grade: Grade;
  intervalMs: number;
  correct: number;
  total: number;
}

/** Reviews a queue of due points: compact rule reminder (hidden), 4 exercises, automatic FSRS grade, next point. */
function ReviewRunner({ ids, onFinish, inSession }: { ids: string[]; onFinish: (out: ReviewOutcome[]) => void; inSession?: boolean }) {
  const [k, setK] = useState(0);
  const [p, setP] = useState<GrammarPoint | null>(null);
  const [exs, setExs] = useState<Exercise[] | null>(null);
  const [showRule, setShowRule] = useState(false);
  const [graded, setGraded] = useState<ReviewOutcome | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const outs = useRef<ReviewOutcome[]>([]);

  useEffect(() => {
    let alive = true;
    setP(null);
    setExs(null);
    setGraded(null);
    setShowRule(false);
    (async () => {
      try {
        const [pt, set] = await Promise.all([call<GrammarPoint>('grammar:get', ids[k]), call<Exercise[]>('grammar:reviewSet', ids[k], REVIEW_SIZE)]);
        if (alive) {
          setP(pt);
          setExs(set);
        }
      } catch (e) {
        if (alive) setErr(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ids, k]);

  const finishPoint = async (results: boolean[], ms: number) => {
    try {
      const r = await call<ReviewResult>('grammar:review', ids[k], results, ms);
      const o: ReviewOutcome = { id: ids[k], title: p?.title ?? ids[k], grade: r.grade, intervalMs: r.intervalMs, correct: r.correct, total: r.total };
      outs.current = [...outs.current, o];
      setGraded(o);
    } catch (e) {
      setErr(e);
    }
  };
  const nextPoint = () => {
    if (k + 1 >= ids.length) onFinish(outs.current);
    else setK(k + 1);
  };
  useKeys(graded ? { Enter: nextPoint } : {}, [graded, k]);

  if (err) return <ErrorBox error={err} />;
  if (!p || !exs) return <Loading />;
  return (
    <div className="stack">
      <div className="row">
        <span className="tag tag-warn">Révision {k + 1}/{ids.length}</span>
        <strong>{p.title}</strong>
        <span className="spacer" />
        {!graded && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowRule((s) => !s)}>
            {showRule ? 'Masquer la règle' : 'Voir la règle'}
          </button>
        )}
      </div>
      {showRule && !graded && (
        <div className="card" style={{ background: 'var(--bg-2)' }}>
          <div className="hanzi-md" style={{ whiteSpace: 'pre-line', color: 'var(--gold)' }}>{p.pattern}</div>
          <Markdown text={keyPoints(p.explanation, 3).map((x) => '- ' + x).join('\n')} />
        </div>
      )}
      {!graded ? (
        <ExerciseRun key={ids[k]} exercises={exs} onFinish={(r, ms) => void finishPoint(r, ms)} title={inSession ? 'Séance du jour — révisions' : 'Révision'} />
      ) : (
        <div className="card center" style={{ padding: 28 }}>
          <div className="stat-label">Note FSRS automatique</div>
          <div className="stat-value" style={{ color: `var(--${['again', 'hard', 'good', 'easy'][graded.grade - 1]})` }}>{gradeLabel(graded.grade)}</div>
          <div className="muted">
            {graded.correct}/{graded.total} juste(s) · prochaine révision dans {fmtInterval(graded.intervalMs)}
          </div>
          {graded.grade === 1 && <div className="small muted" style={{ marginTop: 8 }}>Ce point revient très bientôt. Relis la règle :</div>}
          {graded.grade <= 2 && (
            <div style={{ marginTop: 8, width: '100%' }}>
              <PatternBox pattern={p.pattern} />
            </div>
          )}
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={nextPoint}>
            {k + 1 >= ids.length ? 'Terminer' : 'Point suivant'} <span className="kbd">Entrée</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewSummary({ outs }: { outs: ReviewOutcome[] }) {
  if (!outs.length) return null;
  return (
    <div className="list">
      {outs.map((o) => (
        <div key={o.id} className="list-item">
          <span style={{ flex: 1 }}>{o.title}</span>
          <span className="small muted">
            {o.correct}/{o.total}
          </span>
          <span className={'tag ' + (o.grade >= 3 ? 'tag-ok' : o.grade === 2 ? 'tag-warn' : 'tag-bad')}>{gradeLabel(o.grade)}</span>
          <span className="small dim">dans {fmtInterval(o.intervalMs)}</span>
        </div>
      ))}
    </div>
  );
}

function ReviewStandalone({ ids, onExit }: { ids: string[]; onExit: () => void }) {
  const [outs, setOuts] = useState<ReviewOutcome[] | null>(null);
  return (
    <div className="page study">
      <div className="page-header">
        <div className="page-title">Révisions de grammaire</div>
        <button className="btn btn-ghost" onClick={onExit}>
          ← Grammaire
        </button>
      </div>
      {!outs ? (
        <ReviewRunner ids={ids} onFinish={setOuts} />
      ) : (
        <div className="stack">
          <div className="notice notice-ok">Révisions terminées.</div>
          <ReviewSummary outs={outs} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={onExit}>
              Retour à la grammaire
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ======================================================================= daily session
function SessionRunner({ reviewsOnly, onExit }: { reviewsOnly?: boolean; onExit: () => void }) {
  const nav = useNav();
  const { data: plan, error, loading } = useAsync(() => call<SessionPlan>('grammar:session'), []);
  const [step, setStep] = useState<'intro' | 'reviews' | 'lesson' | 'done'>('intro');
  const [outs, setOuts] = useState<ReviewOutcome[]>([]);
  const [lessonScore, setLessonScore] = useState<number | null>(null);
  const marked = useRef(false);

  const next = plan && !reviewsOnly ? plan.next : null;
  const begin = () => {
    if (!plan) return;
    if (plan.due.length) setStep('reviews');
    else if (next) setStep('lesson');
    else setStep('done');
  };
  useEffect(() => {
    if (step !== 'done' || marked.current) return;
    marked.current = true;
    call('core:markBlockDone', 'grammar').catch(() => undefined);
  }, [step]);
  useKeys(step === 'intro' ? { Enter: begin } : {}, [step, plan]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (loading || !plan) return <div className="page"><Loading /></div>;

  const header = (
    <div className="page-header">
      <div>
        <div className="page-sub">Grammaire</div>
        <div className="page-title">Séance du jour</div>
      </div>
      <button className="btn btn-ghost" onClick={onExit}>
        Quitter
      </button>
    </div>
  );

  if (step === 'intro')
    return (
      <div className="page study">
        {header}
        <div className="card stack">
          {plan.due.length === 0 && !next ? (
            <div className="muted">Rien à faire aujourd'hui en grammaire : aucune révision due, et aucun nouveau point disponible.</div>
          ) : (
            <>
              <div>
                <div className="card-title">1. Révisions ({plan.due.length})</div>
                {plan.due.length ? (
                  <div className="list">
                    {plan.due.map((d) => (
                      <div key={d.id} className="list-item">
                        <span>{d.title}</span>
                        <span className="spacer" />
                        <span className="small dim">{REVIEW_SIZE} exercices</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted small">Aucune révision due.</div>
                )}
              </div>
              <div>
                <div className="card-title">2. {next?.reason === 'retry' ? 'Leçon à refaire' : 'Nouvelle leçon'}</div>
                {next ? (
                  <div className="list-item">
                    <span>{next.title}</span>
                    <span className="spacer" />
                    {next.reason === 'retry' && <span className="small" style={{ color: 'var(--warn)' }}>meilleur score {pct(next.bestScore)} — 80 % requis</span>}
                    <span className="small dim">cours + {LESSON_SIZE} exercices</span>
                  </div>
                ) : (
                  <div className="muted small">{reviewsOnly ? 'Révisions seulement aujourd\'hui.' : 'Aucun nouveau point disponible pour l\'instant (vocabulaire de la phase suivante requis, ou tout est fait).'}</div>
                )}
              </div>
            </>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary btn-lg" onClick={begin}>
              {plan.due.length === 0 && !next ? 'Terminer' : 'Commencer'} <span className="kbd">Entrée</span>
            </button>
          </div>
        </div>
      </div>
    );

  if (step === 'reviews')
    return (
      <div className="page study">
        {header}
        <ReviewRunner
          ids={plan.due.map((d) => d.id)}
          inSession
          onFinish={(o) => {
            setOuts(o);
            setStep(next ? 'lesson' : 'done');
          }}
        />
      </div>
    );

  if (step === 'lesson' && next)
    return (
      <LessonRunner
        id={next.id}
        inSession
        onExit={onExit}
        onFinish={(s) => {
          setLessonScore(s);
          setStep('done');
        }}
      />
    );

  return (
    <div className="page study">
      {header}
      <div className="stack">
        <div className="notice notice-ok">Séance de grammaire terminée. Bloc du plan du jour validé.</div>
        {outs.length > 0 && (
          <div className="card">
            <div className="card-title">Révisions</div>
            <ReviewSummary outs={outs} />
          </div>
        )}
        {next && lessonScore != null && (
          <div className="card">
            <div className="card-title">Leçon</div>
            <div className="row">
              <span>{next.title}</span>
              <span className="spacer" />
              <span className={'tag ' + (lessonScore >= GRAMMAR_PASS ? 'tag-ok' : lessonScore >= GRAMMAR_MIN ? 'tag-warn' : 'tag-bad')}>{pct(lessonScore)}</span>
            </div>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onExit}>
            Vue d'ensemble
          </button>
          <button className="btn btn-primary" onClick={() => nav.go('dashboard')}>
            Retour au QG
          </button>
        </div>
      </div>
    </div>
  );
}
