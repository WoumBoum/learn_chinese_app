import { useState } from 'react';
import { call } from '../api';
import { useNav } from '../App';
import type { Settings } from '../../shared/types';
import { AvailabilityEditor, InterestPicker, WEEKDAYS } from './Settings';

export function Onboarding() {
  const { settings, reloadSettings } = useNav();
  const [s, setS] = useState<Settings>(settings!);
  const [step, setStep] = useState(0);
  const set = (p: Partial<Settings>) => setS((x) => ({ ...x, ...p }));
  const weekly = s.availability.minutes.reduce((a, b) => a + b, 0);
  const days = Math.ceil(1400 / Math.max(1, s.newWordsPerDay)) + 14;

  const finish = async () => {
    await call('core:saveSettings', { ...s, onboarded: true });
    await reloadSettings();
  };

  return (
    <div className="content" style={{ height: '100%' }}>
      <div className="page" style={{ maxWidth: 820 }}>
        <div className="center" style={{ margin: '20px 0 26px' }}>
          <div className="brand-zh" style={{ fontSize: 40 }}>特工中文</div>
          <div className="brand-fr">Opération Mandarin — centre de formation</div>
        </div>

        {step === 0 && (
          <div className="card stack" style={{ padding: 28 }}>
            <h2>Briefing initial</h2>
            <p className="muted">
              Ce programme s'inspire des écoles de langues du gouvernement américain (FSI pour les diplomates, DLI pour l'armée et le renseignement) : <b>beaucoup de
              volume, de la répétition, des tests réguliers et des objectifs mesurables</b>. On y ajoute ce que la recherche a validé :
            </p>
            <ul className="muted">
              <li><b>Répétition espacée (FSRS)</b> : chaque mot, caractère, phrase et règle de grammaire revient juste avant que tu l'oublies.</li>
              <li><b>Input compréhensible</b> : des vidéos et podcasts dont tu comprends ~95 %, grâce au <b>pré-enseignement</b> du vocabulaire quelques jours avant.</li>
              <li><b>Shadowing</b> et analyse des tons au micro, <b>écriture sur papier</b> guidée, <b>grammaire</b> en séances complètes.</li>
              <li>Le pinyin n'apparaît que pour apprendre le son : tu lies directement <b>caractère ↔ sens</b>.</li>
            </ul>
            <p className="muted">Objectif : <b>HSK 3 (~1 500 mots, ~650 caractères) en 6 mois</b>. Le plan s'adapte chaque jour au temps dont tu disposes.</p>
            <button className="btn btn-primary btn-lg" onClick={() => setStep(1)}>Configurer mon programme</button>
          </div>
        )}

        {step === 1 && (
          <div className="card stack" style={{ padding: 28 }}>
            <h2>Ton temps disponible</h2>
            <p className="muted">Indique le temps réaliste pour chaque jour. Les jours courts, le système se contente de l'essentiel ; les jours longs absorbent plus de nouveautés. Tu pourras aussi choisir chaque matin Express / Standard / Marathon.</p>
            <AvailabilityEditor value={s.availability.minutes} onChange={(m) => set({ availability: { minutes: m } })} />
            <div className="small dim">Total : {Math.round(weekly / 6) / 10} h par semaine (le DLI fait ~35 h… on vise la régularité).</div>
            <div className="row">
              <button className="btn btn-ghost" onClick={() => setStep(0)}>Retour</button>
              <div className="spacer" />
              <button className="btn btn-primary" onClick={() => setStep(2)}>Suivant</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="card stack" style={{ padding: 28 }}>
            <h2>Rythme et emploi du temps</h2>
            <div className="col">
              <span>Nouveaux mots par jour standard</span>
              <div className="row">
                {[6, 8, 10, 12, 15].map((n) => (
                  <button key={n} className={'btn' + (s.newWordsPerDay === n ? ' selected' : '')} onClick={() => set({ newWordsPerDay: n })}>
                    {n}
                  </button>
                ))}
              </div>
              <span className="small dim">
                {s.newWordsPerDay} mots/jour → ~1 500 mots en ~{Math.round(days / 7)} semaines si tu tiens le rythme. Recommandé : 12 pour HSK 3 en 6 mois (les jours courts en font moins, le week-end plus) ; 8 = rythme confortable.
              </span>
            </div>
            <div className="grid-3">
              <div className="col">
                <span>Séances de grammaire</span>
                <div className="row">
                  {WEEKDAYS.map((d, i) => (
                    <button key={i} className={'btn btn-sm' + (s.grammarDays.includes(i) ? ' selected' : '')} onClick={() => set({ grammarDays: s.grammarDays.includes(i) ? s.grammarDays.filter((x) => x !== i) : [...s.grammarDays, i] })}>
                      {d.slice(0, 2)}
                    </button>
                  ))}
                </div>
              </div>
              <label className="col">
                <span>Séance d'écriture longue</span>
                <select value={s.writingDay} onChange={(e) => set({ writingDay: +e.target.value })}>
                  {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </label>
              <label className="col">
                <span>Débriefing hebdo (test)</span>
                <select value={s.testDay} onChange={(e) => set({ testDay: +e.target.value })}>
                  {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </label>
            </div>
            <div className="row">
              <button className="btn btn-ghost" onClick={() => setStep(1)}>Retour</button>
              <div className="spacer" />
              <button className="btn btn-primary" onClick={() => setStep(3)}>Suivant</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="card stack" style={{ padding: 28 }}>
            <h2>Tes centres d'intérêt</h2>
            <p className="muted">Servent à choisir les vidéos, podcasts et histoires qu'on te propose.</p>
            <InterestPicker value={s.interests} onChange={(v) => set({ interests: v })} />
            <h3 style={{ marginTop: 10 }}>IA (optionnelle)</h3>
            <p className="small muted">
              Avec une clé API Claude : sélection fine des mots à pré-enseigner selon le contexte de la vidéo, choix des vidéos par thème, correction de tes phrases,
              histoires écrites avec tes mots, jeux de rôle. Sans clé, tout le reste fonctionne.
            </p>
            <input type="password" placeholder="sk-ant-… (facultatif)" value={s.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
            <div className="row">
              <button className="btn btn-ghost" onClick={() => setStep(2)}>Retour</button>
              <div className="spacer" />
              <button className="btn btn-primary btn-lg" onClick={finish}>Commencer la formation</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
