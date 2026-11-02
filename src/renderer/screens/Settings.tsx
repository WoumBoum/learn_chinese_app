import { useState } from 'react';
import { call } from '../api';
import { toast, useAsync } from '../components/common';
import { useNav } from '../App';
import type { Settings } from '../../shared/types';

export const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export const INTERESTS = [
  'vie quotidienne', 'nourriture', 'voyage', 'famille', 'école', 'travail', 'culture', 'histoire', 'technologie', 'sport',
  'humour', 'enfants/dessin animé', 'nature', 'santé', 'sentiments', 'société', 'musique', 'cinéma', 'jeux vidéo', 'business',
];

export function AvailabilityEditor({ value, onChange }: { value: number[]; onChange: (v: Settings['availability']['minutes']) => void }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      {ORDER.map((d) => (
        <div key={d} className="row">
          <span style={{ width: 90 }}>{WEEKDAYS[d]}</span>
          <input type="range" min={0} max={240} step={5} value={value[d]} style={{ flex: 1 }} onChange={(e) => {
            const v = [...value] as Settings['availability']['minutes'];
            v[d] = +e.target.value;
            onChange(v);
          }} />
          <span style={{ width: 70, textAlign: 'right' }} className="muted">{value[d]} min</span>
        </div>
      ))}
    </div>
  );
}

export function InterestPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chip-input">
      {INTERESTS.map((t) => (
        <button key={t} className={'btn btn-sm' + (value.includes(t) ? ' selected' : '')} onClick={() => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t])}>
          {t}
        </button>
      ))}
    </div>
  );
}

export function SettingsScreen() {
  const { settings, reloadSettings } = useNav();
  const [s, setS] = useState<Settings>(settings!);
  const [testing, setTesting] = useState(false);
  const tts = useAsync(() => call<{ ok: boolean; engine: string; detail: string }>('tts:status').catch(() => ({ ok: false, engine: '-', detail: 'module indisponible' })), []);
  const set = (p: Partial<Settings>) => setS((x) => ({ ...x, ...p }));
  const save = async () => {
    await call('core:saveSettings', s);
    await reloadSettings();
    toast('Réglages enregistrés');
  };
  const testAi = async () => {
    setTesting(true);
    try {
      await call('core:saveSettings', s);
      await reloadSettings();
      const r = await call<{ ok: boolean; error?: string }>('ai:test');
      toast(r.ok ? 'Clé API valide ✔' : `Échec : ${r.error}`);
    } catch (e) {
      toast(`Échec : ${e instanceof Error ? e.message : e}`);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Réglages</div>
          <div className="page-sub">Ton profil d'entraînement. Le planificateur recalcule tout chaque jour.</div>
        </div>
        <button className="btn btn-primary" onClick={save}>Enregistrer</button>
      </div>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card stack">
          <div className="card-title">Temps disponible par jour</div>
          <AvailabilityEditor value={s.availability.minutes} onChange={(m) => set({ availability: { minutes: m } })} />
        </div>
        <div className="card stack">
          <div className="card-title">Rythme</div>
          <label className="col">
            <span>Nouveaux mots / jour standard : {s.newWordsPerDay}</span>
            <input type="range" min={3} max={20} value={s.newWordsPerDay} onChange={(e) => set({ newWordsPerDay: +e.target.value })} />
          </label>
          <label className="col">
            <span>Rétention visée (FSRS) : {Math.round(s.desiredRetention * 100)} %</span>
            <input type="range" min={0.8} max={0.95} step={0.01} value={s.desiredRetention} onChange={(e) => set({ desiredRetention: +e.target.value })} />
            <span className="small dim">Plus haut = plus de révisions. 90 % est le meilleur compromis.</span>
          </label>
          <label className="col">
            <span>Objectif (mots)</span>
            <input type="number" value={s.goalWords} onChange={(e) => set({ goalWords: +e.target.value })} />
          </label>
          <div className="grid-2">
            <label className="col">
              <span>Écriture longue</span>
              <select value={s.writingDay} onChange={(e) => set({ writingDay: +e.target.value })}>
                {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </label>
            <label className="col">
              <span>Test hebdo</span>
              <select value={s.testDay} onChange={(e) => set({ testDay: +e.target.value })}>
                {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </label>
          </div>
          <div className="col">
            <span>Séances de grammaire</span>
            <div className="row">
              {ORDER.map((i) => (
                <button key={i} className={'btn btn-sm' + (s.grammarDays.includes(i) ? ' selected' : '')} onClick={() => set({ grammarDays: s.grammarDays.includes(i) ? s.grammarDays.filter((x) => x !== i) : [...s.grammarDays, i] })}>
                  {WEEKDAYS[i].slice(0, 3)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="card stack">
          <div className="card-title">Lecteur et pinyin</div>
          <label className="row">
            <input type="checkbox" checked={s.pinyinOnUnknownInPlayer} onChange={(e) => set({ pinyinOnUnknownInPlayer: e.target.checked })} />
            <span>Pinyin au-dessus des mots <b>inconnus</b> dans le lecteur vidéo et la lecture</span>
          </label>
          <span className="small dim">Désactivé par défaut : le pinyin n'apparaît jamais sur les cartes de sens ni dans les traductions. Clique un mot pour voir son pinyin.</span>
          <div className="card-title" style={{ marginTop: 12 }}>Centres d'intérêt</div>
          <InterestPicker value={s.interests} onChange={(v) => set({ interests: v })} />
        </div>
        <div className="card stack">
          <div className="card-title">IA (optionnelle)</div>
          <input type="password" placeholder="Clé API Anthropic (sk-ant-…)" value={s.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
          <label className="col">
            <span>Modèle</span>
            <select value={s.aiModel} onChange={(e) => set({ aiModel: e.target.value })}>
              <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (recommandé)</option>
              <option value="claude-opus-5-5">Claude Opus 5.5 (meilleur, plus cher)</option>
              <option value="claude-haiku-5-5">Claude Haiku 5.5 (rapide, économique)</option>
            </select>
          </label>
          <button className="btn" disabled={!s.apiKey || testing} onClick={testAi}>{testing ? 'Test…' : 'Tester la clé'}</button>
          <span className="small dim">La clé est stockée localement dans ta base. Les résultats sont mis en cache pour limiter le coût.</span>
          <div className="card-title" style={{ marginTop: 12 }}>Voix</div>
          <span className="small">{tts.data ? (tts.data.ok ? `✔ ${tts.data.engine} — ${tts.data.detail}` : `✖ ${tts.data.detail}`) : '…'}</span>
          <div className="card-title" style={{ marginTop: 12 }}>Programme</div>
          <label className="col">
            <span>Date de début</span>
            <input type="date" value={s.startDate} onChange={(e) => set({ startDate: e.target.value })} />
          </label>
        </div>
      </div>
    </div>
  );
}
