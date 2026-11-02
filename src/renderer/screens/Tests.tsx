// Exams: weekly debriefing (gate 85 %), end-of-phase mock exam, history and detailed results.
import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { useNav } from '../App';
import type { GrammarExercise as Exercise } from '../../shared/types';
import { AudioButton, ErrorBox, Loading, ProgressBar, toast, useAsync, useKeys } from '../components/common';
import { GrammarExercise } from '../components/GrammarExercise';
import { KIND_SKILL, SKILL_LABEL, scoreItems, skillAdvice, type Skill, type SkillScore, type TestItemResult, type TestKind, type TestPaper, type TestQuestion, type TestRow } from '../../core/exam';

interface Status {
  week: number;
  passMark: number;
  isTestDay: boolean;
  testDay: number;
  passedThisWeek: boolean;
  takenThisWeek: boolean;
  consolidation: boolean;
  lastWeekly: { week: number; score: number; ts: number } | null;
  lastMock: { week: number; score: number; ts: number } | null;
  phase: number;
  phaseName: string;
  wordsIntroduced: number;
}
interface SubmitResult {
  id: number;
  score: number;
  passed: boolean;
  week: number;
  relearned: number;
  bySkill: Partial<Record<Skill, SkillScore>>;
  consolidation: boolean;
}

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const SKILLS: Skill[] = ['listening', 'reading', 'grammar'];
const pct = (x: number) => `${Math.round(x * 100)} %`;
const hasHan = (s: string) => /\p{Script=Han}/u.test(s);
const SECTION: Record<TestQuestion['kind'], string> = {
  'word-listen': 'Compréhension orale — mots',
  'word-read': 'Lecture — caractères',
  'sentence-listen': 'Compréhension orale — phrases',
  grammar: 'Grammaire',
};

type View =
  | { k: 'home' }
  | { k: 'loading'; kind: TestKind }
  | { k: 'run'; paper: TestPaper }
  | { k: 'result'; paper: TestPaper; items: TestItemResult[]; res: SubmitResult | null }
  | { k: 'detail'; id: number };

export function Tests(props: Record<string, unknown>) {
  const [view, setView] = useState<View>({ k: 'home' });
  const [n, setN] = useState(0);
  const startedRef = useRef(false);

  const start = async (kind: TestKind) => {
    setView({ k: 'loading', kind });
    try {
      const paper = await call<TestPaper>(kind === 'weekly' ? 'tests:weekly' : 'tests:mock');
      if (!paper.questions.length) {
        toast(paper.notes[0] ?? 'Pas encore assez de matière pour un test.');
        setView({ k: 'home' });
        return;
      }
      setView({ k: 'run', paper });
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e));
      setView({ k: 'home' });
    }
  };
  useEffect(() => {
    // Tests({start:'weekly'}) from the daily plan: launch directly.
    if (startedRef.current || (props.start !== 'weekly' && props.start !== 'mock')) return;
    startedRef.current = true;
    void start(props.start as TestKind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const home = () => {
    setView({ k: 'home' });
    setN((x) => x + 1);
  };

  if (view.k === 'loading') return <div className="page"><Loading text="Préparation du test…" /></div>;
  if (view.k === 'run')
    return (
      <Runner
        paper={view.paper}
        onAbort={home}
        onDone={async (items, durationMs) => {
          setView({ k: 'result', paper: view.paper, items, res: null });
          try {
            const { score, bySkill } = scoreItems(items);
            const res = await call<SubmitResult>('tests:submit', { kind: view.paper.kind, score, details: { items, bySkill, durationMs } });
            if (view.paper.kind === 'weekly' && res.passed) await call('core:markBlockDone', 'test').catch(() => undefined);
            setView({ k: 'result', paper: view.paper, items, res });
          } catch (e) {
            toast('Enregistrement impossible : ' + String(e instanceof Error ? e.message : e));
          }
        }}
      />
    );
  if (view.k === 'result') return <Results kind={view.paper.kind} items={view.items} res={view.res} onBack={home} onRetry={() => void start(view.paper.kind)} />;
  if (view.k === 'detail') return <Detail id={view.id} onBack={home} />;
  return <Home key={n} onStart={(k) => void start(k)} onDetail={(id) => setView({ k: 'detail', id })} />;
}

// ======================================================================= home
function Home({ onStart, onDetail }: { onStart: (k: TestKind) => void; onDetail: (id: number) => void }) {
  const st = useAsync(() => call<Status>('tests:status'), []);
  const hist = useAsync(() => call<TestRow[]>('tests:history'), []);
  if (st.error) return <div className="page"><ErrorBox error={st.error} /></div>;
  if (st.loading || !st.data) return <div className="page"><Loading /></div>;
  const s = st.data;
  let weeklyTag = <span className="tag tag-warn">Dû cette semaine{s.isTestDay ? ' — aujourd\'hui' : ''}</span>;
  if (s.passedThisWeek) weeklyTag = <span className="tag tag-ok">Réussi cette semaine ✓</span>;
  else if (s.consolidation) weeklyTag = <span className="tag tag-bad">Consolidation — retest à faire</span>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Examens</div>
          <div className="page-sub">Débriefing hebdomadaire et examens blancs — sans pinyin, comme le jour J.</div>
        </div>
        <span className="tag">Semaine {s.week} · {s.phaseName}</span>
      </div>

      <div className="grid-2" style={{ marginBottom: 22 }}>
        <div className={'card' + (s.passedThisWeek ? '' : ' highlight')}>
          <div className="card-title">Test hebdomadaire</div>
          <div className="stack">
            <div>{weeklyTag}</div>
            <div className="small muted">
              ~25 questions, 15 min : mots entendus et lus (priorité aux mots de la semaine), phrases à l'oral, grammaire des points étudiés. Jour prévu : {DAYS[s.testDay]}.
            </div>
            {s.lastWeekly && (
              <div className="small">
                Dernier : semaine {s.lastWeekly.week} — <strong className={s.lastWeekly.score >= s.passMark ? 'correct' : 'wrong'}>{pct(s.lastWeekly.score)}</strong>
              </div>
            )}
            <button className="btn btn-primary btn-lg" onClick={() => onStart('weekly')} disabled={s.wordsIntroduced === 0}>
              {s.passedThisWeek ? 'Repasser le test (entraînement)' : 'Lancer le test hebdomadaire'}
            </button>
            {s.wordsIntroduced === 0 && <div className="small dim">Apprends tes premiers mots avant de passer un test.</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-title">Examen blanc de phase</div>
          <div className="stack">
            <div className="small muted">
              ~40 questions sur toute la phase en cours ({s.phaseName}) : plus de phrases, score et recommandation par compétence (écoute, lecture, grammaire). À passer avant de changer de phase.
            </div>
            {s.lastMock && (
              <div className="small">
                Dernier : semaine {s.lastMock.week} — <strong>{pct(s.lastMock.score)}</strong>
              </div>
            )}
            <button className="btn btn-lg" onClick={() => onStart('mock')} disabled={s.wordsIntroduced === 0}>
              Lancer l'examen blanc
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card-title">Le système de validation</div>
        <div className="small muted stack">
          <div>
            Chaque semaine, le débriefing vérifie que ce qui a été appris tient vraiment. Seuil : <strong>{pct(s.passMark)}</strong>.
          </div>
          <div>
            <strong>Réussi</strong> → la progression continue à plein régime (nouveaux mots au rythme prévu).
          </div>
          <div>
            <strong>Échoué</strong> → <em>semaine de consolidation</em> : moins de nouveaux mots, plus de révisions, et tu refais le test (dans quelques jours) jusqu'à le réussir.
          </div>
          <div>Chaque mot raté pendant un test est remis en révision immédiate dans le SRS (note « À revoir »).</div>
        </div>
      </div>

      <h3 style={{ marginBottom: 10 }}>Historique</h3>
      {hist.loading ? (
        <Loading />
      ) : !hist.data?.length ? (
        <div className="empty">Aucun test passé pour l'instant.</div>
      ) : (
        <div className="list">
          {hist.data.map((t) => (
            <div key={t.id} className="list-item clickable" onClick={() => onDetail(t.id)}>
              <span className="small muted" style={{ width: 90 }}>{t.date}</span>
              <span style={{ width: 130 }}>{t.kind === 'weekly' ? 'Hebdomadaire' : 'Examen blanc'}</span>
              <span className="small muted" style={{ width: 90 }}>Semaine {t.week}</span>
              <span className="row small muted" style={{ flex: 1 }}>
                {SKILLS.filter((k) => t.bySkill[k]).map((k) => (
                  <span key={k}>
                    {SKILL_LABEL[k]} {pct(t.bySkill[k]!.score)}
                  </span>
                ))}
              </span>
              <strong>{pct(t.score)}</strong>
              <span className={'tag ' + (t.passed ? 'tag-ok' : 'tag-bad')}>{t.passed ? 'réussi' : 'échoué'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ======================================================================= runner
function grammarItem(ex: Exercise): { zh?: string; fr?: string } {
  switch (ex.type) {
    case 'order':
      return { zh: ex.answer, fr: ex.fr };
    case 'cloze':
      return { zh: ex.zh.replace('___', ex.answer), fr: ex.fr };
    case 'choice': {
      const o = ex.options[ex.answer] ?? '';
      return hasHan(o) ? { zh: o, fr: ex.question } : { fr: `${ex.question} → ${o}` };
    }
    case 'listen':
      return { zh: ex.zh, fr: `${ex.question} → ${ex.options[ex.answer] ?? ''}` };
    case 'translate':
      return { zh: ex.answers[0], fr: ex.fr };
    default:
      return { zh: ex.answers[0] };
  }
}

function Runner({ paper, onDone, onAbort }: { paper: TestPaper; onDone: (items: TestItemResult[], durationMs: number) => void; onAbort: () => void }) {
  const [i, setI] = useState(0);
  const items = useRef<TestItemResult[]>([]);
  const t0 = useRef(Date.now());
  const q = paper.questions[i];

  const record = (correct: boolean, chosen: string | null) => {
    const base: TestItemResult = { id: q.id, kind: q.kind, skill: q.skill ?? KIND_SKILL[q.kind], correct, chosen, word: q.word, grammarId: q.grammarId, grammarTitle: q.grammarTitle };
    const extra = q.ex ? grammarItem(q.ex) : { zh: q.zh, fr: q.fr };
    items.current = [...items.current, { ...base, ...extra }];
    if (i + 1 >= paper.questions.length) onDone(items.current, Date.now() - t0.current);
    else setI(i + 1);
  };

  const sectionChanged = i === 0 || paper.questions[i - 1].kind !== q.kind;
  return (
    <div className="page study">
      <div className="page-header">
        <div>
          <div className="page-sub">{paper.kind === 'weekly' ? `Débriefing hebdomadaire — semaine ${paper.week}` : 'Examen blanc de phase'}</div>
          <div className="page-title">{SECTION[q.kind]}</div>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (window.confirm('Abandonner le test ? Les réponses ne seront pas enregistrées.')) onAbort();
          }}
        >
          Abandonner
        </button>
      </div>
      <div className="stack">
        <div className="row">
          <span className="small muted">
            Question {i + 1}/{paper.questions.length}
          </span>
          <span className="spacer" />
          {sectionChanged && <span className="tag tag-info">Nouvelle section</span>}
        </div>
        <ProgressBar value={i / paper.questions.length} />
        {q.kind === 'grammar' && q.ex ? (
          <>
            <div className="small dim">Point : {q.grammarTitle}</div>
            <GrammarExercise key={q.id} ex={q.ex} onDone={(ok) => record(ok, null)} />
          </>
        ) : (
          <Mcq key={q.id} q={q} onAnswer={(k) => record(k === q.answer, q.options?.[k] ?? null)} />
        )}
      </div>
    </div>
  );
}

/** Multiple-choice question without feedback (exam conditions); the correction comes at the end. */
function Mcq({ q, onAnswer }: { q: TestQuestion; onAnswer: (k: number) => void }) {
  const audio = q.kind === 'word-listen' || q.kind === 'sentence-listen';
  const opts = q.options ?? [];
  const [replay, setReplay] = useState(0);
  useKeys({
    '1': () => opts.length > 0 && onAnswer(0),
    '2': () => opts.length > 1 && onAnswer(1),
    '3': () => opts.length > 2 && onAnswer(2),
    '4': () => opts.length > 3 && onAnswer(3),
    Space: () => audio && setReplay((r) => r + 1),
  });
  return (
    <div className="card study-card" style={{ minHeight: 320 }}>
      <div className="study-prompt-label">{q.prompt}</div>
      {audio && q.zh ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <AudioButton key={replay} text={q.zh} autoPlay size="lg" label="Écouter" />
          <AudioButton text={q.zh} rate={0.75} size="sm" label="Lent" />
          <span className="small dim">
            <span className="kbd">Espace</span> réécouter
          </span>
        </div>
      ) : (
        <div className="hanzi-xl">{q.zh}</div>
      )}
      <div className="col" style={{ width: '100%', maxWidth: 560 }}>
        {opts.map((o, k) => (
          <button key={k} className="btn" style={{ justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => onAnswer(k)}>
            <span className="kbd">{k + 1}</span> {o}
          </button>
        ))}
      </div>
    </div>
  );
}

// ======================================================================= results
function SkillBars({ bySkill, advice }: { bySkill: Partial<Record<Skill, SkillScore>>; advice?: boolean }) {
  return (
    <div className="stack">
      {SKILLS.filter((k) => bySkill[k]).map((k) => {
        const s = bySkill[k]!;
        return (
          <div key={k}>
            <div className="row">
              <strong>{SKILL_LABEL[k]}</strong>
              <span className="spacer" />
              <span className="small muted">
                {s.ok}/{s.n}
              </span>
              <strong>{pct(s.score)}</strong>
            </div>
            <ProgressBar value={s.score} ok={s.score >= 0.85} />
            {advice && <div className="small muted" style={{ marginTop: 4 }}>{skillAdvice(k, s.score)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function ErrorList({ items }: { items: TestItemResult[] }) {
  const errs = items.filter((x) => !x.correct);
  if (!errs.length) return <div className="notice notice-ok">Aucune erreur. Impeccable, agent.</div>;
  return (
    <div className="list">
      {errs.map((e) => (
        <div key={e.id} className="list-item">
          {e.zh ? <AudioButton text={e.zh} size="sm" /> : <span style={{ width: 38 }} />}
          <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <div className="row">
              {e.zh && <span className="hanzi" style={{ fontSize: 22 }}>{e.zh}</span>}
              <span className="tag">{e.kind === 'grammar' ? e.grammarTitle ?? 'Grammaire' : SKILL_LABEL[e.skill]}</span>
            </div>
            {e.fr && <div className="small">{e.fr}</div>}
            {e.chosen && (
              <div className="small wrong">
                Ta réponse : <span className={hasHan(e.chosen) ? 'hanzi' : ''}>{e.chosen}</span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Results({ kind, items, res, onBack, onRetry }: { kind: TestKind; items: TestItemResult[]; res: SubmitResult | null; onBack: () => void; onRetry: () => void }) {
  const nav = useNav();
  const local = scoreItems(items);
  const score = res?.score ?? local.score;
  const bySkill = res?.bySkill ?? local.bySkill;
  const passed = score >= 0.85;
  const weak = SKILLS.filter((k) => bySkill[k] && bySkill[k]!.score < 0.85);
  return (
    <div className="page study">
      <div className="page-header">
        <div>
          <div className="page-sub">{kind === 'weekly' ? 'Débriefing hebdomadaire' : 'Examen blanc de phase'}</div>
          <div className="page-title">Résultats</div>
        </div>
        <button className="btn btn-ghost" onClick={onBack}>
          ← Examens
        </button>
      </div>
      <div className="stack">
        <div className="card center" style={{ padding: 28 }}>
          <div className="stat-label">Score global</div>
          <div className="stat-value" style={{ fontSize: 52, color: passed ? 'var(--ok)' : 'var(--bad)' }}>{pct(score)}</div>
          <div className="muted">
            {items.filter((x) => x.correct).length}/{items.length} bonnes réponses · seuil 85 %
          </div>
          <div style={{ marginTop: 14, maxWidth: 600 }}>
            {kind === 'weekly' ? (
              passed ? (
                <div className="notice notice-ok">Test réussi : la progression continue à plein régime cette semaine.</div>
              ) : (
                <div className="notice notice-bad">
                  Sous 85 % : <strong>semaine de consolidation</strong>. Le plan du jour réduit les nouveaux mots et renforce les révisions. Refais ce test dans quelques jours pour repasser à plein régime.
                </div>
              )
            ) : passed ? (
              <div className="notice notice-ok">Niveau de la phase acquis : tu es prêt pour la suite.</div>
            ) : (
              <div className="notice notice-warn">Pas encore au niveau de fin de phase sur : {weak.map((k) => SKILL_LABEL[k]).join(', ') || 'l\'ensemble'}. Suis les recommandations ci-dessous, puis repasse l'examen blanc.</div>
            )}
          </div>
          {res && res.relearned > 0 && <div className="small muted" style={{ marginTop: 8 }}>{res.relearned} carte(s) de mots ratés remise(s) en révision immédiate.</div>}
          {!res && <div className="small dim" style={{ marginTop: 8 }}>Enregistrement…</div>}
        </div>
        <div className="card">
          <div className="card-title">Par compétence</div>
          <SkillBars bySkill={bySkill} advice />
        </div>
        <div className="card">
          <div className="card-title">Erreurs à revoir</div>
          <ErrorList items={items} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {!passed && (
            <button className="btn" onClick={onRetry}>
              Repasser un test
            </button>
          )}
          <button className="btn" onClick={onBack}>
            Examens
          </button>
          <button className="btn btn-primary" onClick={() => nav.go('dashboard')}>
            Retour au QG
          </button>
        </div>
      </div>
    </div>
  );
}

function Detail({ id, onBack }: { id: number; onBack: () => void }) {
  const { data, error, loading } = useAsync(() => call<TestRow & { items: TestItemResult[] }>('tests:get', id), [id]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (loading || !data) return <div className="page"><Loading /></div>;
  return (
    <div className="page study">
      <div className="page-header">
        <div>
          <div className="page-sub">
            {data.kind === 'weekly' ? 'Test hebdomadaire' : 'Examen blanc'} · semaine {data.week} · {data.date}
          </div>
          <div className="page-title">
            {pct(data.score)} <span className={'tag ' + (data.passed ? 'tag-ok' : 'tag-bad')}>{data.passed ? 'réussi' : 'échoué'}</span>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={onBack}>
          ← Examens
        </button>
      </div>
      <div className="stack">
        <div className="card">
          <div className="card-title">Par compétence</div>
          <SkillBars bySkill={data.bySkill} advice />
        </div>
        <div className="card">
          <div className="card-title">Erreurs</div>
          <ErrorList items={data.items} />
        </div>
      </div>
    </div>
  );
}
