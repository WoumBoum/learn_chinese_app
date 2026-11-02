import { useState } from 'react';
import { call } from '../api';
import { ErrorBox, Loading, ProgressBar, useAsync } from '../components/common';
import { useNav, type ScreenId } from '../App';
import type { DayMode, DayPlan, PlanBlock, Progress } from '../../shared/types';
import { weekday } from '../../core/time';

const ICON: Record<string, string> = {
  reviews: '↻',
  briefing: '密',
  new: '新',
  grammar: '语',
  tones: '声',
  mission: '▶',
  writing: '笔',
  listening: '听',
  test: '考',
  catchup: '⚠',
};

const MODES: { id: DayMode; label: string; hint: string }[] = [
  { id: 'express', label: 'Express', hint: '15-20 min : révisions critiques, aucune nouveauté' },
  { id: 'standard', label: 'Standard', hint: 'Le temps prévu dans ton profil pour ce jour' },
  { id: 'marathon', label: 'Marathon', hint: 'Grosse journée : plan complet + séances bonus à volonté' },
];

export function Dashboard() {
  const { go, settings } = useNav();
  const [mode, setMode] = useState<DayMode | undefined>();
  const plan = useAsync(() => call<DayPlan>('core:plan', mode), [mode]);
  const prog = useAsync(() => call<Progress>('core:progress'), []);
  const extra = useAsync(() => call<number>('core:extraAllowance'), [mode]);

  const launch = (b: PlanBlock) => {
    const pl = b.payload ?? {};
    const map: Record<string, [ScreenId, Record<string, unknown>?]> = {
      // count = due reviews + new (never reviewed) cards, e.g. words introduced today
      reviews: ['review', { limit: b.count }],
      briefing: ['learn', { source: 'mission', count: b.count, missionId: pl.missionId }],
      new: ['learn', { source: 'curriculum', count: b.count }],
      grammar: ['grammar', { session: true, reviewsOnly: !!pl.reviewsOnly }],
      tones: ['tones', pl.tab ? { tab: pl.tab } : undefined],
      mission: ['mission', pl.missionId ? { missionId: pl.missionId } : {}],
      // study-day weekday of the plan (rolls over at 04:00), same as the planner's isWritingDay
      writing: ['writing', { long: !!settings && weekday(plan.data?.date ?? '') === settings.writingDay }],
      listening: ['library', { tab: 'listening' }],
      test: ['tests', { start: 'weekly' }],
    };
    const t = map[b.type];
    if (t) go(t[0], t[1]);
  };

  const markDone = async (b: PlanBlock) => {
    await call('core:markBlockDone', b.type);
    if (b.type === 'listening') await call('core:logActivity', 'listening', b.minutes);
    plan.reload();
  };

  if (plan.error) return <div className="page"><ErrorBox error={plan.error} /></div>;
  if (!plan.data) return <div className="page"><Loading /></div>;
  const p = plan.data;
  const doneMin = p.blocks.filter((b) => b.done).reduce((a, b) => a + b.minutes, 0);
  const plannedMin = p.blocks.filter((b) => !b.optional).reduce((a, b) => a + b.minutes, 0);
  const allDone = p.blocks.filter((b) => !b.optional && b.type !== 'catchup').every((b) => b.done);
  const pr = prog.data;
  const maxF = Math.max(1, ...p.forecast);
  const dateFr = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="dim small" style={{ textTransform: 'uppercase', letterSpacing: 1.5 }}>
            Ordre de mission — {dateFr}
          </div>
          <div className="page-title">
            Semaine {p.week} · {pr?.phaseName ?? ''}
          </div>
          <div className="page-sub">
            Temps prévu : {p.budgetMinutes >= 120 && p.mode === 'marathon' ? 'illimité' : `${p.budgetMinutes} min`} · plan : ~{plannedMin} min · fait : {doneMin} min
          </div>
        </div>
        <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
          <div className="mode-switch">
            {MODES.map((m) => (
              <button key={m.id} className={p.mode === m.id ? 'active' : ''} title={m.hint} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <span className="small dim">{MODES.find((m) => m.id === p.mode)?.hint}</span>
        </div>
      </div>

      {p.notes.map((n, i) => (
        <div key={i} className={'notice ' + (n.startsWith('Mode rattrapage') || n.startsWith('Semaine de consolidation') ? 'notice-warn' : '')} style={{ marginBottom: 10 }}>
          {n}
        </div>
      ))}

      <div className="grid-2" style={{ gridTemplateColumns: '1.6fr 1fr', alignItems: 'start' }}>
        <div className="col">
          {p.blocks.filter((b) => b.type !== 'catchup').map((b, i) => (
            <div key={i} className={'block' + (b.done ? ' done' : '') + (b.optional ? ' optional' : '')}>
              <div className="block-icon">{ICON[b.type]}</div>
              <div style={{ flex: 1 }}>
                <div className="block-title">
                  {b.title} {b.done && <span className="tag tag-ok">fait</span>} {b.optional && !b.done && <span className="tag">bonus</span>}
                </div>
                <div className="block-detail">{b.detail}</div>
              </div>
              <div className="block-min">{b.minutes ? `~${b.minutes} min` : ''}</div>
              {!b.done && (
                <>
                  <button className="btn btn-sm btn-primary" onClick={() => launch(b)}>Lancer</button>
                  {b.type === 'listening' && (
                    <button className="btn btn-sm btn-ghost" title="J'ai écouté en dehors de l'app" onClick={() => markDone(b)}>✓</button>
                  )}
                </>
              )}
            </div>
          ))}
          {p.blocks.length === 0 && <div className="empty">Rien de prévu — profite-en pour une mission vidéo ou une lecture.</div>}

          {(allDone || p.mode === 'marathon') && (
            <div className="card highlight" style={{ marginTop: 8 }}>
              <div className="card-title">{allDone ? 'Plan du jour terminé — continuer ?' : 'Séances bonus (Marathon)'}</div>
              <div className="small muted" style={{ marginBottom: 10 }}>
                {extra.data && extra.data > 0
                  ? `Ta charge de révisions future permet encore ~${extra.data} nouveaux mots sans surcharger les jours suivants.`
                  : 'Ta charge de révisions est au maximum raisonnable : privilégie l\'écoute, la lecture et la grammaire plutôt que de nouveaux mots.'}
              </div>
              <div className="row">
                {!!extra.data && extra.data > 0 && (
                  <button className="btn" onClick={() => go('learn', { source: 'curriculum', count: Math.min(10, extra.data!) })}>+ {Math.min(10, extra.data)} mots</button>
                )}
                <button className="btn" onClick={() => go('library')}>Mission vidéo bonus</button>
                <button className="btn" onClick={() => go('grammar')}>Grammaire</button>
                <button className="btn" onClick={() => go('reading')}>Lecture</button>
                <button className="btn" onClick={() => go('writing', { long: true })}>Écriture longue</button>
                <button className="btn" onClick={() => go('tones', { tab: 'shadow' })}>Shadowing</button>
                <button className="btn" onClick={() => go('roleplay')}>Jeu de rôle</button>
              </div>
            </div>
          )}
        </div>

        <div className="col">
          {pr && (
            <div className="card">
              <div className="card-title">Dossier de l'agent</div>
              <div className="grid-2">
                <div className="stat"><span className="stat-value">{pr.wordsIntroduced}</span><span className="stat-label">mots appris</span></div>
                <div className="stat"><span className="stat-value">{pr.wordsKnown}</span><span className="stat-label">mots solides</span></div>
                <div className="stat"><span className="stat-value">{pr.charsIntroduced}</span><span className="stat-label">caractères</span></div>
                <div className="stat"><span className="stat-value">{pr.grammarStarted}</span><span className="stat-label">points de grammaire</span></div>
                <div className="stat"><span className="stat-value">{Math.round(pr.listeningMinutes / 6) / 10} h</span><span className="stat-label">d'écoute</span></div>
                <div className="stat"><span className="stat-value">{pr.streak} j</span><span className="stat-label">série</span></div>
              </div>
              <div style={{ marginTop: 14 }}>
                <div className="row small" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Objectif {pr.goalWords} mots (HSK 3)</span>
                  <span>{Math.round((pr.wordsIntroduced / pr.goalWords) * 100)} %</span>
                </div>
                <ProgressBar value={pr.wordsIntroduced / pr.goalWords} />
                {pr.projectedGoalDate && (
                  <div className="small dim" style={{ marginTop: 6 }}>
                    Date projetée à ton rythme actuel : {new Date(pr.projectedGoalDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-title">Charge prévue (7 jours)</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80 }}>
              {p.forecast.map((n, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ width: '100%', height: `${(n / maxF) * 60}px`, minHeight: 2, background: i === 0 ? 'var(--accent)' : 'var(--panel-2)', borderRadius: 3 }} title={`${n} révisions`} />
                  <span className="small dim">{i === 0 ? 'auj.' : `J+${i}`}</span>
                </div>
              ))}
            </div>
            <div className="small dim" style={{ marginTop: 6 }}>
              Nouveaux mots autorisés aujourd'hui : {p.newCap}. Le système ajuste ce nombre pour que les révisions restent tenables les jours chargés.
            </div>
          </div>
          {pr && pr.canDo && (
            <div className="card">
              <div className="card-title">Capacités opérationnelles</div>
              <div className="col" style={{ gap: 6 }}>
                {pr.canDo.slice(0, 6).map((c) => (
                  <div key={c.text} className="row small" style={{ gap: 8 }}>
                    <span className={c.ok ? 'correct' : 'dim'}>{c.ok ? '✔' : '○'}</span>
                    <span className={c.ok ? '' : 'muted'}>{c.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
