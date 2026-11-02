import { call } from '../api';
import { ErrorBox, Loading, ProgressBar, useAsync } from '../components/common';
import type { Progress } from '../../shared/types';
import { PHASE_TARGETS } from './phaseTargets';
import { Confusions } from '../components/Confusions';

export function ProgressScreen() {
  const { data: p, error } = useAsync(() => call<Progress>('core:progress'), []);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!p) return <div className="page"><Loading /></div>;
  const max = Math.max(1, ...p.heatmap.map((h) => h.minutes));
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Progression</div>
          <div className="page-sub">Semaine {p.week} · {p.phaseName}</div>
        </div>
      </div>
      <div className="grid-4">
        <div className="card stat"><span className="stat-value">{p.wordsIntroduced}</span><span className="stat-label">mots appris</span></div>
        <div className="card stat"><span className="stat-value">{p.wordsKnown}</span><span className="stat-label">mots solides (≥ 4 j)</span></div>
        <div className="card stat"><span className="stat-value">{p.charsIntroduced}</span><span className="stat-label">caractères ({p.charsKnown} solides)</span></div>
        <div className="card stat"><span className="stat-value">{p.grammarStarted}/{p.grammarTotal}</span><span className="stat-label">grammaire ({p.grammarMastered} maîtrisés)</span></div>
        <div className="card stat"><span className="stat-value">{Math.round(p.listeningMinutes / 6) / 10} h</span><span className="stat-label">d'écoute</span></div>
        <div className="card stat"><span className="stat-value">{Math.round(p.studyMinutes / 6) / 10} h</span><span className="stat-label">d'étude totale</span></div>
        <div className="card stat"><span className="stat-value">{p.reviewsTotal}</span><span className="stat-label">révisions</span></div>
        <div className="card stat"><span className="stat-value">{p.retention30d == null ? '—' : Math.round(p.retention30d * 100) + ' %'}</span><span className="stat-label">rétention (30 j)</span></div>
      </div>
      <div style={{ height: 16 }} />
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">Parcours</div>
          <div className="col">
            {PHASE_TARGETS.map((ph) => {
              const prev = ph.n === 0 ? 0 : PHASE_TARGETS[ph.n - 1].words;
              const v = Math.max(0, Math.min(1, (p.wordsIntroduced - prev) / (ph.words - prev)));
              return (
                <div key={ph.n}>
                  <div className="row small" style={{ justifyContent: 'space-between' }}>
                    <span className={p.phase === ph.n ? '' : 'muted'}>{ph.name} <span className="dim">(sem. {ph.weeks})</span></span>
                    <span className="dim">{ph.words} mots</span>
                  </div>
                  <ProgressBar value={v} ok={v >= 1} />
                </div>
              );
            })}
          </div>
          {p.projectedGoalDate && (
            <p className="small muted" style={{ marginBottom: 0 }}>
              À ton rythme actuel, objectif de {p.goalWords} mots atteint le{' '}
              <b>{new Date(p.projectedGoalDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</b>.
            </p>
          )}
        </div>
        <div className="card">
          <div className="card-title">Capacités opérationnelles</div>
          <div className="col" style={{ gap: 6 }}>
            {p.canDo.map((c) => (
              <div key={c.text} className="row small" style={{ gap: 8 }}>
                <span className={c.ok ? 'correct' : 'dim'}>{c.ok ? '✔' : '○'}</span>
                <span className={c.ok ? '' : 'muted'}>{c.text}</span>
              </div>
            ))}
          </div>
        </div>
        <Confusions />
        <div className="card">
          <div className="card-title">Activité (26 semaines)</div>
          <div className="heatmap">
            {p.heatmap.map((h) => (
              <div key={h.date} title={`${h.date} : ${h.minutes} min, ${h.reviews} révisions`} style={{ background: h.minutes ? `rgba(229,72,77,${0.2 + 0.8 * (h.minutes / max)})` : undefined }} />
            ))}
          </div>
          <div className="small dim" style={{ marginTop: 8 }}>Série actuelle : {p.streak} jour(s).</div>
        </div>
        <div className="card">
          <div className="card-title">Tests hebdomadaires</div>
          {p.weeklyTests.length === 0 ? (
            <div className="dim small">Aucun test pour l'instant.</div>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {p.weeklyTests.slice(-10).reverse().map((t, i) => (
                <div key={i} className="row small">
                  <span style={{ width: 90 }}>Semaine {t.week}</span>
                  <div style={{ flex: 1 }}><ProgressBar value={t.score} ok={t.passed} /></div>
                  <span style={{ width: 50, textAlign: 'right' }} className={t.passed ? 'correct' : 'wrong'}>{Math.round(t.score * 100)} %</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
