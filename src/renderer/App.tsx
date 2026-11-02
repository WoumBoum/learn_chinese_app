import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { call } from './api';
import type { Settings } from '../shared/types';
import { Dashboard } from './screens/Dashboard';
import { Review } from './screens/Review';
import { Learn } from './screens/Learn';
import { Writing } from './screens/Writing';
import { GrammarHome } from './screens/Grammar';
import { Tests } from './screens/Tests';
import { Library } from './screens/Library';
import { MissionScreen } from './screens/Mission';
import { Tones } from './screens/Tones';
import { Reading } from './screens/Reading';
import { Roleplay } from './screens/Roleplay';
import { ProgressScreen } from './screens/Progress';
import { SettingsScreen } from './screens/Settings';
import { Onboarding } from './screens/Onboarding';
import { Dictionary } from './screens/Dictionary';
import { ToastHost } from './components/common';

export type ScreenId =
  | 'dashboard'
  | 'review'
  | 'learn'
  | 'writing'
  | 'grammar'
  | 'tests'
  | 'library'
  | 'mission'
  | 'tones'
  | 'reading'
  | 'roleplay'
  | 'dictionary'
  | 'progress'
  | 'settings';

export interface Route {
  screen: ScreenId;
  params?: Record<string, unknown>;
}

interface NavCtx {
  route: Route;
  go: (screen: ScreenId, params?: Record<string, unknown>) => void;
  back: () => void;
  settings: Settings | null;
  reloadSettings: () => Promise<void>;
}

const Nav = createContext<NavCtx>(null as unknown as NavCtx);
export const useNav = () => useContext(Nav);

const NAV: { id: ScreenId; label: string; icon: string; group: string }[] = [
  { id: 'dashboard', label: 'QG', icon: '◆', group: 'Mission' },
  { id: 'review', label: 'Révisions', icon: '↻', group: 'Mission' },
  { id: 'learn', label: 'Nouveaux mots', icon: '+', group: 'Mission' },
  { id: 'library', label: 'Missions vidéo', icon: '▶', group: 'Terrain' },
  { id: 'tones', label: 'Tons & oral', icon: '〜', group: 'Terrain' },
  { id: 'reading', label: 'Lecture', icon: '文', group: 'Terrain' },
  { id: 'roleplay', label: 'Jeu de rôle', icon: '☏', group: 'Terrain' },
  { id: 'grammar', label: 'Grammaire', icon: '语', group: 'Formation' },
  { id: 'writing', label: 'Écriture', icon: '笔', group: 'Formation' },
  { id: 'tests', label: 'Examens', icon: '✓', group: 'Formation' },
  { id: 'dictionary', label: 'Dictionnaire', icon: '典', group: 'Outils' },
  { id: 'progress', label: 'Progression', icon: '▲', group: 'Outils' },
  { id: 'settings', label: 'Réglages', icon: '⚙', group: 'Outils' },
];

function renderScreen(r: Route): ReactNode {
  const p = r.params ?? {};
  switch (r.screen) {
    case 'dashboard':
      return <Dashboard />;
    case 'review':
      return <Review {...p} />;
    case 'learn':
      return <Learn {...p} />;
    case 'writing':
      return <Writing {...p} />;
    case 'grammar':
      return <GrammarHome {...p} />;
    case 'tests':
      return <Tests {...p} />;
    case 'library':
      return <Library {...p} />;
    case 'mission':
      return <MissionScreen {...p} />;
    case 'tones':
      return <Tones {...p} />;
    case 'reading':
      return <Reading {...p} />;
    case 'roleplay':
      return <Roleplay {...p} />;
    case 'dictionary':
      return <Dictionary {...p} />;
    case 'progress':
      return <ProgressScreen />;
    case 'settings':
      return <SettingsScreen />;
  }
}

export function App() {
  const [route, setRoute] = useState<Route>({ screen: 'dashboard' });
  const [history, setHistory] = useState<Route[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  const reloadSettings = useCallback(async () => {
    setSettings(await call<Settings>('core:getSettings'));
  }, []);

  useEffect(() => {
    reloadSettings().finally(() => setLoading(false));
  }, [reloadSettings]);

  const go = useCallback((screen: ScreenId, params?: Record<string, unknown>) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setHistory((h) => [...h.slice(-20), route]);
    setRoute({ screen, params });
  }, [route]);
  const back = useCallback(() => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      setRoute(prev ?? { screen: 'dashboard' });
      return h.slice(0, -1);
    });
  }, []);

  if (loading) return <div className="splash">Chargement…</div>;
  const ctx: NavCtx = { route, go, back, settings, reloadSettings };

  if (settings && !settings.onboarded)
    return (
      <Nav.Provider value={ctx}>
        <Onboarding />
      </Nav.Provider>
    );

  let lastGroup = '';
  return (
    <Nav.Provider value={ctx}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-zh">特工中文</span>
            <span className="brand-fr">Opération Mandarin</span>
          </div>
          <nav>
            {NAV.map((n) => {
              const header = n.group !== lastGroup ? <div className="nav-group">{n.group}</div> : null;
              lastGroup = n.group;
              return (
                <div key={n.id}>
                  {header}
                  <button className={'nav-item' + (route.screen === n.id ? ' active' : '')} onClick={() => go(n.id)}>
                    <span className="nav-icon">{n.icon}</span>
                    {n.label}
                  </button>
                </div>
              );
            })}
          </nav>
        </aside>
        <main className="content" key={route.screen + JSON.stringify(route.params ?? {})}>
          {renderScreen(route)}
        </main>
      </div>
      <ToastHost />
    </Nav.Provider>
  );
}
