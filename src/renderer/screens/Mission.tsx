// Mission vidéo en 3 temps : Briefing (vocabulaire pré-enseigné) → Terrain (lecteur) → Débriefing (quiz + auto-évaluation).
import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import { useNav } from '../App';
import { AudioButton, ErrorBox, Loading, playFile, shuffle, stopAudio, toast, useAsync, useKeys } from '../components/common';
import { WordPopup } from '../components/WordPopup';
import { Player } from '../components/Player';
import { dayKey } from '../../core/time';
import { aiConfigured, attempt, CoverageBars, fmtDate, fmtDuration, importSubs, JobProgress, MISSION_STATUS, pct, SUBS_LABEL, useMediaProgress } from '../components/media';
import type { MissionDetail, PlayerSegment, QuizQuestion, VideoInfo } from '../../shared/media';
import type { Mission, PreteachWord } from '../../shared/types';

type Step = 'briefing' | 'field' | 'debrief';
const STEPS: { id: Step; label: string; zh: string }[] = [
  { id: 'briefing', label: 'Briefing', zh: '1' },
  { id: 'field', label: 'Terrain', zh: '2' },
  { id: 'debrief', label: 'Débriefing', zh: '3' },
];

interface Loaded {
  detail: MissionDetail | null;
  video: VideoInfo;
}

export function MissionScreen(props: Record<string, unknown>) {
  const missionId = typeof props.missionId === 'string' ? props.missionId : undefined;
  const videoId = typeof props.videoId === 'string' ? props.videoId : undefined;
  const { go, settings } = useNav();
  const [rev, setRev] = useState(0);
  const reload = () => setRev((r) => r + 1);
  const { data, error, loading } = useAsync<Loaded | null>(async () => {
    if (missionId) {
      const d = await call<MissionDetail>('media:mission', missionId);
      return { detail: d, video: d.video };
    }
    if (!videoId) {
      const next = await call<MissionDetail | null>('media:nextMission');
      if (!next) return null;
      return { detail: next, video: next.video };
    }
    const d = await call<MissionDetail | null>('media:missionForVideo', videoId);
    return { detail: d, video: d ? d.video : await call<VideoInfo>('media:get', videoId) };
  }, [missionId, videoId, rev]);
  const initialStep = (props.step === 'field' || props.step === 'debrief' ? props.step : 'briefing') as Step;
  const [step, setStep] = useState<Step>(initialStep);
  const [ai, setAi] = useState(false);
  useEffect(() => {
    aiConfigured().then(setAi);
  }, []);

  // Time spent on the mission (logged on completion, or when leaving the screen).
  const t0 = useRef(Date.now());
  const logged = useRef(false);
  const idRef = useRef<{ missionId?: string; videoId?: string }>({});
  useEffect(() => {
    if (data) idRef.current = { missionId: data.detail?.mission.id, videoId: data.video.id };
  }, [data]);
  useEffect(
    () => () => {
      stopAudio();
      if (logged.current) return;
      const min = (Date.now() - t0.current) / 60000;
      if (min >= 1) call('core:logActivity', 'mission', Math.round(min * 10) / 10, { ...idRef.current, partial: true }).catch(() => {});
    },
    [],
  );
  const minutes = () => Math.round(((Date.now() - t0.current) / 60000) * 10) / 10;

  if (loading && !data) return <div className="page"><Loading text="Ouverture du dossier de mission…" /></div>;
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data)
    return (
      <div className="page">
        <div className="empty">
          Aucune mission en cours. Choisis une vidéo recommandée et prépare sa mission : le vocabulaire sera pré-enseigné dans tes prochaines séances.
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-primary" onClick={() => go('library')}>
              Voir les missions vidéo
            </button>
          </div>
        </div>
      </div>
    );
  const { detail, video } = data;
  const m = detail?.mission;

  const finish = async (comprehension: number) => {
    const min = minutes();
    const ok = await attempt(async () => {
      if (m) await call('media:completeMission', m.id, comprehension, min);
      else await call('media:markWatched', video.id, comprehension, min);
      await call('core:markBlockDone', 'mission');
    });
    if (ok) {
      logged.current = true;
      toast(`Mission accomplie — ${Math.round(comprehension * 100)} % de compréhension, ${Math.round(min)} min. Elle rejoint ta file d'écoute extensive.`);
      go('library', { tab: 'listening' });
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="small dim" style={{ textTransform: 'uppercase', letterSpacing: 1.5 }}>
            {m ? 'Dossier de mission' : 'Visionnage libre'}
          </div>
          <div className="page-title">{video.title}</div>
          <div className="row small" style={{ marginTop: 6 }}>
            <span className="tag">{fmtDuration(video.duration)}</span>
            {video.subs_source && <span className="tag tag-info">{SUBS_LABEL[video.subs_source]}</span>}
            {m && <span className={'tag ' + MISSION_STATUS[m.status].cls}>{MISSION_STATUS[m.status].label}</span>}
            {m && <span className="tag">Visionnage prévu {fmtDate(m.planned_date)}</span>}
            {video.segCount > 0 && <span className="tag">Couverture actuelle {pct(video.coverage)}</span>}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={() => go('library')}>
          ← Missions vidéo
        </button>
      </div>

      <div className="tabs">
        {STEPS.map((s) => (
          <button key={s.id} className={'tab' + (step === s.id ? ' active' : '')} onClick={() => setStep(s.id)}>
            <span className="hanzi" style={{ color: 'var(--accent)', marginRight: 6 }}>
              {s.zh}
            </span>
            {s.label}
          </button>
        ))}
      </div>

      {step === 'briefing' && <Briefing detail={detail} video={video} ai={ai} onChanged={reload} onField={() => setStep('field')} />}
      {step === 'field' && (
        <Field
          video={video}
          ai={ai}
          pinyinDefault={!!settings?.pinyinOnUnknownInPlayer}
          remaining={detail?.remaining ?? 0}
          onChanged={reload}
          onDone={() => setStep('debrief')}
          onBriefing={() => setStep('briefing')}
        />
      )}
      {step === 'debrief' && <Debrief video={video} mission={m} ai={ai} onFinish={finish} />}
    </div>
  );
}

// ------------------------------------------------------------------ briefing
function Briefing({ detail, video, ai, onChanged, onField }: { detail: MissionDetail | null; video: VideoInfo; ai: boolean; onChanged: () => void; onField: () => void }) {
  const { go } = useNav();
  const [busy, setBusy] = useState<string | null>(null);
  const [express, setExpress] = useState(false);
  const [popup, setPopup] = useState<string | null>(null);
  const cov = useAsync(() => (video.segCount ? call<{ projected: { days: number; coverage: number }[]; afterPreteach: number }>('media:coverage', video.id) : Promise.resolve(null)), [video.id, video.segCount]);

  if (!video.segCount)
    return (
      <div className="stack">
        <div className="notice notice-warn">Pas encore de transcription pour cette vidéo : impossible de calculer le vocabulaire à pré-enseigner.</div>
        <PrepareBox video={video} onChanged={onChanged} />
        <button className="btn" onClick={onField}>
          Regarder quand même →
        </button>
      </div>
    );

  if (!detail) {
    const plan = async () => {
      setBusy('plan');
      await attempt(async () => {
        const m = await call<Mission>('media:planMission', video.id);
        go('mission', { missionId: m.id });
      });
      setBusy(null);
    };
    return (
      <div className="stack">
        <div className="card">
          <div className="card-title">Aucune mission planifiée</div>
          <CoverageBars now={video.coverage} projected={video.projected3} />
          <p className="muted">
            {video.preteachCount
              ? `${video.preteachCount} mots fréquents de cette vidéo te sont inconnus. Prépare la mission : ils seront pré-enseignés dans tes séances « Nouveaux mots » des prochains jours, et la vidéo sera programmée le jour où ta couverture atteint ~95 %.`
              : 'Tu connais déjà presque tout le vocabulaire de cette vidéo : tu peux la regarder directement.'}
          </p>
          <div className="row">
            <button className="btn btn-primary" disabled={!!busy} onClick={plan}>
              Préparer la mission
            </button>
            <button className="btn" onClick={onField}>
              Regarder sans préparation →
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { mission, words, remaining } = detail;
  const newWords = words.filter((w) => w.status === 'new');
  const learningWords = words.filter((w) => w.status === 'learning');
  const refine = async () => {
    setBusy('ai');
    await attempt(async () => {
      const keepLearning = mission.preteach.filter((p) => p.status === 'learning');
      const refined = await call<PreteachWord[]>('ai:refinePreteach', video.id);
      if (Array.isArray(refined) && refined.length) await call('media:setPreteach', mission.id, [...refined.map((r) => ({ ...r, status: 'new' as const })), ...keepLearning]);
    }, 'Briefing affiné par l\'IA');
    setBusy(null);
    onChanged();
  };
  const replan = async () => {
    setBusy('replan');
    await attempt(() => call('media:planMission', video.id), 'Liste recalculée');
    setBusy(null);
    onChanged();
  };
  // Same rule as the planner: one night of consolidation after the last briefing word (study day rolls over at 4:00).
  const readiness = useAsync(() => call<{ ready: boolean; lastIntro: number | null }>('core:missionReadiness', mission.id), [mission.id, remaining]);
  const consolidating = remaining === 0 && readiness.data ? !readiness.data.ready : false;
  const early = consolidating || mission.planned_date > dayKey();

  return (
    <div className="stack">
      <div className="grid-2">
        <div className="card">
          <div className="card-title">Objectif</div>
          <CoverageBars now={video.coverage} projected={video.projected3} />
          {cov.data && (
            <div className="small muted" style={{ marginTop: 8 }}>
              Avec les {newWords.length} mots du briefing, la couverture passe à <strong>{pct(cov.data.afterPreteach)}</strong>.
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <span className="small">Visionnage prévu le</span>
            <input
              type="date"
              value={mission.planned_date}
              onChange={(e) => e.target.value && attempt(() => call('media:setMissionDate', mission.id, e.target.value), 'Date mise à jour').then(onChanged)}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-title">Ordres de mission</div>
          {remaining > 0 ? (
            <>
              <p style={{ marginTop: 0 }}>
                <strong>{remaining}</strong> mot{remaining > 1 ? 's' : ''} à apprendre avant le terrain. Ils passent avant le cursus dans tes séances « Nouveaux mots » ; laisse au moins une nuit avant de regarder.
              </p>
              <button className="btn btn-primary" onClick={() => go('learn', { source: 'mission', missionId: mission.id })}>
                Apprendre les mots du briefing ({remaining})
              </button>
            </>
          ) : (
            <p style={{ marginTop: 0 }}>
              {consolidating
                ? 'Vocabulaire appris aujourd\'hui : laisse-le se consolider une nuit, la mission terrain apparaîtra demain dans ton plan (tu peux quand même regarder maintenant).'
                : early
                  ? `Vocabulaire en place. Laisse-le se consolider : terrain prévu ${fmtDate(mission.planned_date)}.`
                  : 'Vocabulaire en place : tu es prêt pour le terrain.'}
            </p>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={!words.length} onClick={() => setExpress(true)}>
              Révision express
            </button>
            {ai && (
              <button className="btn" disabled={busy === 'ai'} onClick={refine} title="L'IA retire noms propres et interjections, garde les mots clés de l'intrigue et donne le sens en contexte">
                {busy === 'ai' ? 'Analyse IA…' : '✦ Affiner avec l\'IA'}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" disabled={busy === 'replan'} onClick={replan}>
              Recalculer
            </button>
            <span className="spacer" />
            <button className={'btn ' + (remaining === 0 ? 'btn-primary' : '')} onClick={onField}>
              Terrain →
            </button>
          </div>
        </div>
      </div>

      {express && <ExpressReview words={words} onClose={() => setExpress(false)} />}

      <div className="card">
        <div className="card-title">Vocabulaire pré-enseigné ({newWords.length})</div>
        {!newWords.length && <div className="muted small">Aucun mot nouveau nécessaire.</div>}
        <div className="grid-3">
          {newWords.map((w) => (
            <WordRow key={w.w} w={w} onOpen={() => setPopup(w.w)} />
          ))}
        </div>
      </div>
      {learningWords.length > 0 && (
        <div className="card">
          <div className="card-title">À consolider (déjà en cours d'apprentissage)</div>
          <div className="grid-3">
            {learningWords.map((w) => (
              <WordRow key={w.w} w={w} onOpen={() => setPopup(w.w)} />
            ))}
          </div>
        </div>
      )}
      {popup && <WordPopup word={popup} onClose={() => setPopup(null)} />}
    </div>
  );
}

function WordRow({ w, onOpen }: { w: MissionDetail['words'][number]; onOpen: () => void }) {
  const tag =
    w.current === 'known' ? (
      <span className="tag tag-ok">Connu</span>
    ) : w.introduced ? (
      <span className="tag tag-info">Appris</span>
    ) : (
      <span className="tag tag-warn">À apprendre</span>
    );
  return (
    <div className="list-item" style={{ alignItems: 'flex-start' }}>
      <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="hanzi word-tok" style={{ fontSize: 24 }} onClick={onOpen}>
            {w.w}
          </span>
          {w.key && (
            <span className="tag tag-bad" title="Mot clé pour comprendre l'intrigue">
              clé
            </span>
          )}
        </div>
        <div className="small">{w.contextFr ?? w.fr.slice(0, 2).join(', ')}</div>
        <div className="small dim">
          {w.count}× dans la vidéo {tag}
        </div>
      </div>
      <AudioButton text={w.w} size="sm" />
    </div>
  );
}

/** Quick warm-up before the field: see the word, hear it, recall its meaning. Not graded (no FSRS impact). */
function ExpressReview({ words, onClose }: { words: MissionDetail['words']; onClose: () => void }) {
  const deck = useMemo(() => shuffle(words.filter((w) => w.introduced || w.current !== 'new')), [words]);
  const [i, setI] = useState(0);
  const [show, setShow] = useState(false);
  const [miss, setMiss] = useState<string[]>([]);
  const w = deck[i];
  const next = (ok: boolean) => {
    if (!ok && w) setMiss((m) => [...m, w.w]);
    setShow(false);
    setI((x) => x + 1);
  };
  useKeys({ Space: () => (show ? next(true) : setShow(true)), '1': () => show && next(false), '2': () => show && next(true), Escape: onClose }, [show, i]);
  if (!deck.length)
    return (
      <div className="notice">
        Apprends d'abord les mots du briefing : la révision express porte sur les mots déjà vus.{' '}
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          Fermer
        </button>
      </div>
    );
  if (!w)
    return (
      <div className="card highlight">
        <div className="card-title">Révision express terminée</div>
        <p>
          {deck.length - miss.length}/{deck.length} reconnus.
          {miss.length > 0 && (
            <>
              {' '}
              À surveiller pendant le visionnage : <span className="hanzi">{miss.join('、')}</span>
            </>
          )}
        </p>
        <div className="row">
          <button className="btn" onClick={() => (setI(0), setMiss([]))}>
            Recommencer
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    );
  return (
    <div className="card highlight study-card" style={{ minHeight: 260 }}>
      <div className="study-prompt-label">
        Révision express {i + 1}/{deck.length} — que veut dire ce mot ?
      </div>
      <div className="hanzi-lg">{w.w}</div>
      <AudioButton text={w.w} autoPlay />
      {!show ? (
        <button className="btn btn-primary" onClick={() => setShow(true)}>
          Voir le sens <span className="kbd">Espace</span>
        </button>
      ) : (
        <div className="answer">
          {/* No pinyin here: character → meaning drill (ARCHITECTURE, principle 1). */}
          <div className="fr">{w.contextFr ?? w.fr.slice(0, 3).join(', ')}</div>
          <div className="row">
            <button className="btn r1" onClick={() => next(false)}>
              À revoir <span className="kbd">1</span>
            </button>
            <button className="btn r3" onClick={() => next(true)}>
              Je savais <span className="kbd">2</span>
            </button>
          </div>
        </div>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onClose}>
        Quitter
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ preparation (no file / no transcript)
function PrepareBox({ video, onChanged }: { video: VideoInfo; onChanged: () => void }) {
  const jobs = useMediaProgress();
  const job = jobs[video.id];
  const [busy, setBusy] = useState(false);
  const run = async (ch: string, ok: string) => {
    setBusy(true);
    await attempt(() => (ch === 'media:importSubs' ? importSubs(video.id) : call(ch, video.id)), ok);
    setBusy(false);
    onChanged();
  };
  const working = busy || !!job;
  return (
    <div className="card">
      <div className="card-title">Préparation de la vidéo</div>
      {video.error && !job && <div className="notice notice-warn small" style={{ marginBottom: 8 }}>{video.error}</div>}
      {job && <JobProgress p={job} onCancel={() => call('media:cancel', video.id)} />}
      <div className="row" style={{ marginTop: 8 }}>
        {!video.hasFile && video.kind !== 'local' && (
          <button className="btn" disabled={working} onClick={() => run('media:download', 'Téléchargement terminé')}>
            Télécharger (≤ 480p)
          </button>
        )}
        {!video.segCount && (video.kind === 'youtube' || video.kind === 'other') && (
          <button className="btn" disabled={working} onClick={() => run('media:fetchSubs', 'Sous-titres récupérés')}>
            Récupérer les sous-titres
          </button>
        )}
        {!video.segCount && (
          <button className="btn btn-primary" disabled={working} onClick={() => run('media:transcribe', 'Transcription terminée')} title="Transcription locale (whisper.cpp) ; le modèle est téléchargé à la première utilisation">
            Transcrire avec Whisper
          </button>
        )}
        {!video.segCount && (
          <button className="btn btn-ghost" disabled={working} onClick={() => run('media:importSubs', 'Sous-titres importés')}>
            Importer un .srt…
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ field
function Field({
  video,
  ai,
  pinyinDefault,
  remaining,
  onChanged,
  onDone,
  onBriefing,
}: {
  video: VideoInfo;
  ai: boolean;
  pinyinDefault: boolean;
  remaining: number;
  onChanged: () => void;
  onDone: () => void;
  onBriefing: () => void;
}) {
  const [segRev, setSegRev] = useState(0);
  const segs = useAsync(() => call<PlayerSegment[]>('media:segments', video.id), [video.id, video.segCount, segRev]);
  if (!video.hasFile)
    return (
      <div className="stack">
        <div className="notice notice-warn">La vidéo n'est pas encore téléchargée sur ton ordinateur.</div>
        <PrepareBox video={video} onChanged={onChanged} />
      </div>
    );
  if (segs.loading && !segs.data) return <Loading />;
  if (segs.error) return <ErrorBox error={segs.error} />;
  return (
    <div className="stack">
      {remaining > 0 && (
        <div className="notice notice-warn row">
          <span>
            {remaining} mot{remaining > 1 ? 's' : ''} du briefing pas encore appris : la vidéo risque d'être difficile.
          </span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={onBriefing}>
            Retour au briefing
          </button>
        </div>
      )}
      {!video.segCount && <PrepareBox video={video} onChanged={onChanged} />}
      <Player video={video} segments={segs.data ?? []} aiOn={ai} pinyinDefault={pinyinDefault} onSegmentsChanged={() => setSegRev((r) => r + 1)} />
      <div className="row">
        <span className="spacer" />
        <button className="btn btn-primary" onClick={onDone}>
          Débriefing →
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ debrief
interface AiQuizQ {
  question: string;
  options: string[];
  answer: number;
  lineIdx?: number;
  explanation?: string;
}

function Debrief({ video, mission, ai, onFinish }: { video: VideoInfo; mission?: Mission; ai: boolean; onFinish: (c: number) => void }) {
  const [mode, setMode] = useState<'ai' | 'local' | null>(null);
  const quiz = useAsync<{ qs: QuizQuestion[]; source: 'ai' | 'local' }>(async () => {
    if (!video.segCount) return { qs: [], source: 'local' };
    if (ai && mode !== 'local') {
      try {
        const raw = await call<AiQuizQ[] | { questions: AiQuizQ[] }>('ai:quiz', video.id);
        const list = Array.isArray(raw) ? raw : raw?.questions ?? [];
        if (list.length) {
          const segs = await call<PlayerSegment[]>('media:segments', video.id);
          const qs: QuizQuestion[] = list
            .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2)
            .map((q) => {
              const s = q.lineIdx != null ? segs.find((x) => x.idx === q.lineIdx) : undefined;
              return {
                question: q.question,
                options: q.options,
                answer: typeof q.answer === 'number' ? q.answer : Math.max(0, q.options.indexOf(String(q.answer))),
                explanation: q.explanation ?? (s ? `Réponse dans : ${s.text}${s.fr ? ' — ' + s.fr : ''}` : undefined),
                audio: s && video.path ? { path: video.path, start: Math.max(0, s.start - 0.2), end: s.end + 0.3 } : undefined,
              };
            });
          if (qs.length) return { qs, source: 'ai' };
        }
      } catch {
        /* repli déterministe */
      }
    }
    return { qs: await call<QuizQuestion[]>('media:quiz', video.id, 6), source: 'local' };
  }, [video.id, ai, mode]);
  const [i, setI] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [comp, setComp] = useState<number | null>(null);
  const qs = quiz.data?.qs ?? [];
  const q = qs[i];
  const doneQuiz = !q;
  useEffect(() => {
    if (doneQuiz && comp == null && qs.length) setComp(Math.round((score / qs.length) * 100));
  }, [doneQuiz]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (q?.audio) playFile(q.audio.path, 1, q.audio.start, q.audio.end);
  }, [i, quiz.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (k: number) => {
    if (chosen != null || !q) return;
    setChosen(k);
    if (k === q.answer) setScore((s) => s + 1);
  };
  const next = () => {
    setChosen(null);
    setI((x) => x + 1);
  };
  useKeys(
    {
      '1': () => pick(0),
      '2': () => pick(1),
      '3': () => pick(2),
      '4': () => pick(3),
      Enter: () => chosen != null && next(),
      r: () => q?.audio && playFile(q.audio.path, 1, q.audio.start, q.audio.end),
    },
    [q, chosen],
  );

  if (quiz.loading && !quiz.data) return <Loading text={ai ? 'Préparation du quiz par l\'IA…' : 'Préparation du quiz…'} />;
  if (quiz.error) return <ErrorBox error={quiz.error} />;

  return (
    <div className="stack">
      {!doneQuiz && q && (
        <div className="card study-card" style={{ minHeight: 320 }}>
          <div className="study-prompt-label">
            Question {i + 1}/{qs.length} · {quiz.data?.source === 'ai' ? 'quiz de compréhension (IA)' : 'écoute et sens des mots du briefing'}
          </div>
          {q.audio && (
            <button className="btn" onClick={() => playFile(q.audio!.path, 1, q.audio!.start, q.audio!.end)}>
              🔊 Réécouter l'extrait <span className="kbd">R</span>
            </button>
          )}
          {q.zh && <div className="hanzi-md">{q.zh}</div>}
          <div className="fr" style={{ maxWidth: 620 }}>
            {q.question}
          </div>
          <div className="grid-2" style={{ width: '100%', maxWidth: 620 }}>
            {q.options.map((o, k) => (
              <button
                key={k}
                className={'btn' + (chosen != null && k === q.answer ? ' r3' : chosen === k ? ' r1' : '')}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                onClick={() => pick(k)}
              >
                <span className="kbd">{k + 1}</span> {o}
              </button>
            ))}
          </div>
          {chosen != null && (
            <div className="answer">
              <div className={chosen === q.answer ? 'correct' : 'wrong'}>{chosen === q.answer ? 'Exact !' : `Non — réponse : ${q.options[q.answer]}`}</div>
              {q.explanation && <div className="small muted hanzi">{q.explanation}</div>}
              <button className="btn btn-primary" onClick={next}>
                Suivant <span className="kbd">Entrée</span>
              </button>
            </div>
          )}
          {quiz.data?.source === 'ai' && i === 0 && chosen == null && (
            <button className="btn btn-ghost btn-sm" onClick={() => setMode('local')}>
              Préférer le quiz d'écoute hors-ligne
            </button>
          )}
        </div>
      )}
      {(doneQuiz || !qs.length) && (
        <div className="card">
          <div className="card-title">Rapport de mission</div>
          {qs.length > 0 ? (
            <p>
              Quiz : <strong>{score}/{qs.length}</strong>
            </p>
          ) : (
            <p className="muted">{video.segCount ? 'Pas assez de mots du briefing dans la transcription pour un quiz : évalue directement ta compréhension.' : 'Pas de quiz disponible : la vidéo n\'a pas encore de transcription.'}</p>
          )}
          <div className="stack">
            <div>Quelle part de la vidéo as-tu comprise (sans traduction) ?</div>
            <div className="row">
              <input type="range" min={0} max={100} step={5} value={comp ?? 50} onChange={(e) => setComp(+e.target.value)} style={{ flex: 1 }} />
              <strong style={{ width: 56, textAlign: 'right' }}>{comp ?? 50} %</strong>
            </div>
            <div className="small dim">
              Repère : 90 %+ = tu suis l'histoire sans effort ; 60 % = l'idée générale ; 30 % = des bribes. Une vidéo à moins de 60 % mérite un second passage dans quelques jours.
            </div>
            <div className="row">
              <button className="btn btn-primary" onClick={() => onFinish((comp ?? 50) / 100)}>
                {mission ? 'Terminer la mission' : 'Marquer comme vue'}
              </button>
              {qs.length > 0 && (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setI(0);
                    setScore(0);
                    setChosen(null);
                    setComp(null);
                  }}
                >
                  Refaire le quiz
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
