// Jeu de rôle : missions d'agent en situation, dialogue avec un personnage joué par l'IA (optionnelle).
import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { useNav } from '../App';
import { AudioButton, ErrorBox, Loading, useAsync } from '../components/common';
import { WordPopup } from '../components/WordPopup';
import { TokenText, useActivityLog, type RToken } from './Reading';

interface Scenario {
  id: string;
  icon: string;
  title: string;
  minPhase: number;
  brief: string; // briefing affiché à l'agent
  setting: string;
  character: string;
  goal: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'cafe',
    icon: '茶',
    title: 'Au café',
    minPhase: 0,
    brief: 'Couverture : touriste. Commande une boisson, demande le prix et paie.',
    setting: 'un petit café à Pékin, le matin',
    character: 'un serveur souriant et patient, 30 ans',
    goal: 'commander une boisson, demander le prix et payer',
  },
  {
    id: 'contact',
    icon: '友',
    title: "Rencontre d'un contact",
    minPhase: 1,
    brief: 'Ton contact « 老王 » t’attend dans un parc. Présente-toi (nom, nationalité, métier de couverture) et fixe un rendez-vous pour demain.',
    setting: 'un banc dans un parc de Shanghai',
    character: "老王, un agent local d'une cinquantaine d'années, méfiant au début puis chaleureux",
    goal: "se présenter (nom, pays, métier) et convenir d'une heure de rendez-vous pour le lendemain",
  },
  {
    id: 'market',
    icon: '买',
    title: 'Au marché',
    minPhase: 1,
    brief: 'Achète des fruits pour ta planque : demande les prix, choisis une quantité, négocie un peu.',
    setting: 'un marché de quartier animé',
    character: 'une marchande de fruits bavarde',
    goal: 'acheter au moins deux sortes de fruits en demandant le prix et la quantité',
  },
  {
    id: 'restaurant',
    icon: '吃',
    title: 'Au restaurant',
    minPhase: 1,
    brief: "Dîner d'observation : commande deux plats et une boisson, puis demande l'addition.",
    setting: 'un restaurant familial',
    character: 'une serveuse efficace et pressée',
    goal: "commander deux plats et une boisson, puis demander l'addition",
  },
  {
    id: 'directions',
    icon: '路',
    title: 'Demander son chemin',
    minPhase: 1,
    brief: 'Tu dois rejoindre la station de métro la plus proche sans carte. Demande ton chemin à un passant.',
    setting: 'une rue commerçante, près d’un carrefour',
    character: 'un étudiant serviable',
    goal: 'comprendre comment aller à la station de métro (direction, distance)',
  },
  {
    id: 'station',
    icon: '车',
    title: 'À la gare',
    minPhase: 2,
    brief: 'Exfiltration : achète un billet de train pour Shanghai pour demain matin et vérifie l’heure de départ.',
    setting: 'le guichet de la gare de Pékin-Sud',
    character: 'un guichetier un peu bourru',
    goal: "acheter un billet pour Shanghai pour le lendemain matin et connaître l'heure de départ et le prix",
  },
  {
    id: 'hotel',
    icon: '住',
    title: "À l'hôtel",
    minPhase: 2,
    brief: 'Installe-toi : réservation au nom de ta couverture, combien de nuits, petit-déjeuner, wifi.',
    setting: "la réception d'un hôtel moderne",
    character: 'une réceptionniste polie',
    goal: 'faire son check-in (nom, nombre de nuits) et poser deux questions sur les services',
  },
  {
    id: 'phone',
    icon: '话',
    title: 'Appel téléphonique',
    minPhase: 2,
    brief: 'Appelle ton officier traitant pour déplacer le rendez-vous : propose un autre jour et une autre heure.',
    setting: 'au téléphone',
    character: 'ta supérieure, 李经理, directe et exigeante',
    goal: 'déplacer un rendez-vous en proposant un nouveau jour et une nouvelle heure, et expliquer pourquoi',
  },
  {
    id: 'doctor',
    icon: '医',
    title: 'Chez le médecin',
    minPhase: 2,
    brief: 'Blessé en mission (rien de grave) : décris tes symptômes, depuis quand, et comprends le traitement.',
    setting: 'le cabinet d’un médecin de quartier',
    character: 'un médecin calme qui pose beaucoup de questions',
    goal: 'décrire ses symptômes et depuis quand, puis comprendre ce que le médecin conseille',
  },
  {
    id: 'border',
    icon: '关',
    title: 'Poste-frontière',
    minPhase: 2,
    brief: 'Interrogatoire au contrôle des passeports : justifie ton voyage sans te contredire (raison, durée, hôtel, métier).',
    setting: "le contrôle des passeports à l'aéroport",
    character: 'un douanier soupçonneux qui enchaîne les questions',
    goal: 'répondre de façon cohérente à 5 questions (raison du voyage, durée, lieu de séjour, métier, bagages)',
  },
  {
    id: 'debrief',
    icon: '报',
    title: 'Rapport de mission',
    minPhase: 3,
    brief: 'Raconte à ta cheffe ce que tu as fait hier (au passé avec 了 / 过) et ce que tu prévois demain.',
    setting: 'le bureau secret de la cheffe',
    character: 'la cheffe de mission, exigeante, qui demande des détails',
    goal: 'raconter sa journée d’hier et son plan pour demain',
  },
];

interface Correction {
  yourText: string;
  better: string;
  explanation: string;
}
interface Reply {
  reply: string;
  fr: string;
  corrections: Correction[];
  tiles: string[];
  goalReached: boolean;
  hint: string;
}
interface Turn {
  role: 'user' | 'assistant';
  zh: string;
  fr?: string;
  corrections?: Correction[];
  checked?: boolean;
}

const PUNCT = ['，', '。', '？', '！'];

export function Roleplay(_props: Record<string, unknown>) {
  const { go } = useNav();
  const status = useAsync(() => call<{ configured: boolean; model: string }>('ai:status').catch(() => ({ configured: false, model: '' })), []);
  const prog = useAsync(() => call<{ phase: number }>('core:progress').catch(() => ({ phase: 0 })), []);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [custom, setCustom] = useState('');

  if (status.loading) return <div className="page"><Loading /></div>;
  if (!status.data?.configured)
    return (
      <div className="page" style={{ maxWidth: 760 }}>
        <div className="page-header">
          <div>
            <div className="page-title">Jeu de rôle</div>
            <div className="page-sub">Missions d'agent en situation réelle, en chinois.</div>
          </div>
        </div>
        <div className="card stack">
          <p style={{ margin: 0 }}>
            Ici, un personnage (serveur, douanier, contact…) te parle en chinois simple, limité à <strong>ton</strong> vocabulaire. Tu réponds en tapant (clavier chinois) ou en assemblant des tuiles de mots que tu connais ; chaque réplique est corrigée
            et expliquée en français.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Ce module a besoin de l'IA (optionnelle) : ajoute une clé API Anthropic dans les Réglages. Tout le reste de l'application fonctionne sans.
          </p>
          <div>
            <button className="btn btn-primary" onClick={() => go('settings')}>
              Configurer l'IA dans les Réglages
            </button>
          </div>
        </div>
      </div>
    );

  if (scenario) return <Chat scenario={scenario} onExit={() => setScenario(null)} />;

  const phase = prog.data?.phase ?? 0;
  const startCustom = () => {
    const t = custom.trim();
    if (!t) return;
    setScenario({ id: 'custom', icon: '自', title: 'Scène libre', minPhase: 0, brief: t, setting: t, character: 'le personnage le plus naturel pour cette scène', goal: 'mener la conversation à son terme (6 à 8 répliques)' });
  };
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Jeu de rôle</div>
          <div className="page-sub">Choisis ta mission. Le personnage s'adapte à ton niveau (phase {phase}).</div>
        </div>
      </div>
      <div className="grid-3">
        {SCENARIOS.map((s) => {
          const early = s.minPhase > Math.max(phase, 0);
          return (
            <div key={s.id} className="card list-item clickable" style={{ flexDirection: 'column', alignItems: 'flex-start', opacity: early ? 0.65 : 1 }} onClick={() => setScenario(s)}>
              <div className="row" style={{ width: '100%' }}>
                <span className="block-icon">{s.icon}</span>
                <strong>{s.title}</strong>
                <div className="spacer" />
                {early ? <span className="tag tag-warn">conseillé dès phase {s.minPhase}</span> : <span className="tag tag-ok">à ton niveau</span>}
              </div>
              <div className="small muted">{s.brief}</div>
            </div>
          );
        })}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">Scène libre</div>
        <div className="row">
          <input style={{ flex: 1 }} placeholder="Décris la situation en français (ex. « j'achète un billet de cinéma »)" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && startCustom()} />
          <button className="btn" onClick={startCustom} disabled={!custom.trim()}>
            Commencer
          </button>
        </div>
      </div>
    </div>
  );
}

function Chat({ scenario, onExit }: { scenario: Scenario; onExit: () => void }) {
  useActivityLog('roleplay');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [tiles, setTiles] = useState<string[]>([]);
  const [hint, setHint] = useState('');
  const [showHint, setShowHint] = useState(false);
  const [goal, setGoal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState('');
  const [replyTokens, setReplyTokens] = useState<string[]>([]);
  const [popup, setPopup] = useState<{ w: string; context: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const ask = async (history: Turn[]) => {
    setBusy(true);
    setError(null);
    try {
      const sc = { id: scenario.id, title: scenario.title, setting: scenario.setting, character: scenario.character, goal: scenario.goal };
      const r = await call<Reply>('ai:roleplay', { scenario: sc, messages: history.map((t) => ({ role: t.role, zh: t.zh })) });
      const next = [...history];
      const last = next[next.length - 1];
      if (last?.role === 'user') next[next.length - 1] = { ...last, corrections: r.corrections, checked: true };
      next.push({ role: 'assistant', zh: r.reply, fr: r.fr });
      setTurns(next);
      setTiles(r.tiles);
      setHint(r.hint);
      setShowHint(false);
      if (r.goalReached) setGoal(true);
      const toks = await call<RToken[]>('core:segment', r.reply).catch(() => [] as RToken[]);
      setReplyTokens([...new Set(toks.filter((t) => t.han).map((t) => t.t))]);
    } catch (e) {
      setError(e);
      setTurns(history);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    ask([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, busy]);

  const send = (text = draft) => {
    const t = text.trim();
    if (!t || busy) return;
    const history: Turn[] = [...turns, { role: 'user', zh: t }];
    setTurns(history);
    setDraft('');
    ask(history);
  };
  const retry = () => ask(turns);
  const backspace = () => {
    const all = [...tiles, ...replyTokens, ...PUNCT].sort((a, b) => b.length - a.length);
    const hit = all.find((x) => draft.endsWith(x));
    setDraft(hit ? draft.slice(0, -hit.length) : [...draft].slice(0, -1).join(''));
  };

  const tileList = [...new Set([...tiles, ...replyTokens])];
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={onExit}>
            ← Missions
          </button>
          <div className="page-title" style={{ marginTop: 6 }}>
            {scenario.title}
          </div>
          <div className="page-sub">
            <strong>Objectif :</strong> {scenario.goal}
          </div>
        </div>
        {goal && <span className="tag tag-ok">Objectif atteint ✓</span>}
      </div>
      <div className="notice small" style={{ marginBottom: 14 }}>
        Briefing : {scenario.brief}
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '52vh', overflowY: 'auto' }}>
        {turns.map((t, i) => (t.role === 'assistant' ? <AssistantBubble key={i} turn={t} autoPlay={t === lastAssistant} onWord={(w) => setPopup({ w, context: t.zh })} /> : <UserBubble key={i} turn={t} />))}
        {busy && <div className="dim small">Le personnage réfléchit…</div>}
        {error != null && (
          <div className="col">
            <ErrorBox error={error} />
            <div>
              <button className="btn btn-sm" onClick={retry}>
                Réessayer
              </button>
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      {goal ? (
        <div className="notice notice-ok" style={{ marginTop: 14 }}>
          <div className="row">
            <span>Mission accomplie, agent. Tu peux continuer la conversation ou terminer.</span>
            <div className="spacer" />
            <button className="btn btn-primary btn-sm" onClick={onExit}>
              Terminer la mission
            </button>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            className="hanzi"
            style={{ flex: 1, fontSize: 22 }}
            placeholder="Réponds en chinois (clavier chinois) ou avec les tuiles ci-dessous"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) send();
            }}
            disabled={busy}
          />
          <button className="btn" onClick={backspace} disabled={!draft || busy} title="Effacer le dernier mot">
            ⌫
          </button>
          <button className="btn btn-primary" onClick={() => send()} disabled={!draft.trim() || busy}>
            Envoyer
          </button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {tileList.map((w) => (
            <span key={w} className="tile" onClick={() => !busy && setDraft((d) => d + w)}>
              {w}
            </span>
          ))}
          {PUNCT.map((p) => (
            <span key={p} className="tile" style={{ minWidth: 36, justifyContent: 'center' }} onClick={() => !busy && setDraft((d) => d + p)}>
              {p}
            </span>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {hint && (
            <button className="btn btn-sm btn-ghost" onClick={() => setShowHint(!showHint)}>
              {showHint ? 'Masquer l’indice' : 'Indice'}
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => send('我不懂。')} disabled={busy} title="Le personnage reformulera plus simplement">
            Je ne comprends pas (我不懂)
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => send('请再说一遍。')} disabled={busy}>
            Répète (请再说一遍)
          </button>
        </div>
        {showHint && hint && <div className="small muted" style={{ marginTop: 6 }}>💡 {hint}</div>}
      </div>
      {popup && <WordPopup word={popup.w} context={popup.context} onClose={() => setPopup(null)} />}
    </div>
  );
}

function AssistantBubble({ turn, autoPlay, onWord }: { turn: Turn; autoPlay: boolean; onWord: (w: string) => void }) {
  const [showFr, setShowFr] = useState(false);
  const toks = useAsync(() => call<RToken[]>('core:segment', turn.zh), [turn.zh]);
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '82%', background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px' }}>
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <AudioButton text={turn.zh} size="sm" autoPlay={autoPlay} />
        <div className="hanzi" style={{ fontSize: 24, lineHeight: 1.5 }}>
          {toks.data ? <TokenText tokens={toks.data} onWord={onWord} /> : turn.zh}
        </div>
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <AudioButton text={turn.zh} size="sm" rate={0.7} label="Lent" />
        {turn.fr && (
          <button className="btn btn-sm btn-ghost" onClick={() => setShowFr(!showFr)}>
            {showFr ? 'Masquer la traduction' : 'Traduction'}
          </button>
        )}
      </div>
      {showFr && <div className="muted" style={{ marginTop: 4 }}>{turn.fr}</div>}
    </div>
  );
}

function UserBubble({ turn }: { turn: Turn }) {
  const corr = turn.corrections ?? [];
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '82%' }}>
      <div style={{ background: 'rgba(74, 158, 237, .15)', border: '1px solid rgba(74, 158, 237, .35)', borderRadius: 12, padding: '10px 14px' }}>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <span className="hanzi" style={{ fontSize: 22 }}>{turn.zh}</span>
          {turn.checked && corr.length === 0 && <span className="tag tag-ok">✓</span>}
        </div>
      </div>
      {corr.map((c, i) => (
        <div key={i} className="notice notice-warn small" style={{ marginTop: 6 }}>
          <div>
            {c.yourText && (
              <>
                <span className="hanzi wrong" style={{ textDecoration: 'line-through' }}>{c.yourText}</span> →{' '}
              </>
            )}
            <span className="hanzi correct" style={{ fontSize: 18 }}>{c.better}</span> <AudioButton text={c.better} size="sm" />
          </div>
          <div className="muted" style={{ marginTop: 4 }}>{c.explanation}</div>
        </div>
      ))}
    </div>
  );
}
