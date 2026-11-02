// AI analysis of recent review failures: confusable pairs + targeted cloze drills.
import { useState } from 'react';
import { call } from '../api';
import { AudioButton, ErrorBox, useAsync } from './common';

interface Report {
  summary: string;
  pairs: { a: string; b: string; explanation: string }[];
  drills: { type: 'cloze'; zh: string; options: string[]; answer: string; fr: string }[];
}

export function Confusions() {
  const status = useAsync(() => call<{ configured: boolean }>('ai:status'), []);
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  if (!status.data?.configured) return null;
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRep(await call<Report>('ai:confusions'));
      setAnswers({});
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="card-title">Analyse de tes confusions (IA)</div>
      {!rep && (
        <>
          <p className="small muted">L'IA lit tes erreurs de révision des 30 derniers jours, repère les mots que tu confonds et te prépare des exercices ciblés.</p>
          <button className="btn" disabled={busy} onClick={run}>{busy ? 'Analyse…' : 'Analyser mes erreurs'}</button>
        </>
      )}
      {!!err && <ErrorBox error={err} />}
      {rep && (
        <div className="stack">
          <p className="small">{rep.summary}</p>
          {rep.pairs.map((p, i) => (
            <div key={i} className="list-item">
              <span className="hanzi" style={{ fontSize: 22 }}>{p.a} / {p.b}</span>
              <span className="small muted">{p.explanation}</span>
            </div>
          ))}
          {rep.drills.map((d, i) => {
            const picked = answers[i];
            return (
              <div key={i} className="list-item" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                <div className="row">
                  <span className="hanzi" style={{ fontSize: 20 }}>{picked ? d.zh.replace(/＿＿|___/, picked) : d.zh}</span>
                  {picked && <AudioButton text={d.zh.replace(/＿＿|___/, d.answer)} size="sm" />}
                </div>
                <div className="row">
                  {d.options.map((o) => (
                    <button key={o} className={'btn btn-sm hanzi' + (picked ? (o === d.answer ? ' r3' : o === picked ? ' r1' : '') : '')} onClick={() => !picked && setAnswers({ ...answers, [i]: o })}>
                      {o}
                    </button>
                  ))}
                  {picked && <span className="small muted">{d.fr}</span>}
                </div>
              </div>
            );
          })}
          <button className="btn btn-sm btn-ghost" onClick={run}>Relancer l'analyse</button>
        </div>
      )}
    </div>
  );
}
