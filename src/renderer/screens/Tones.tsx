// Écran « Tons & oral » : les 4 tons et le sandhi, le pinyin (initiales/finales, pièges des francophones),
// exercices d'écoute (ton d'une syllabe, paires de tons, paires minimales) et shadowing avec courbe mélodique.
// Ici le pinyin est voulu : c'est l'objet même de l'apprentissage (cf. ARCHITECTURE.md, principe 1).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { convert, pinyin } from 'pinyin-pro';
import { call } from '../api';
import { ErrorBox, Loading, playFile, toast, useKeys, type SpokenAudio } from '../components/common';
import { PitchCompare } from '../components/PitchCompare';
import { useNav } from '../App';

type TabId = 'tons' | 'pinyin' | 'ecoute' | 'shadow';

interface DrillWord {
  w: string;
  py: string;
  pn?: string;
  tones: number[];
  heard: number[];
  fr: string;
  introduced: boolean;
}
interface MinimalPair {
  kind: 'ton' | 'initiale' | 'finale';
  contrast: string;
  a: { w: string; py: string; fr: string };
  b: { w: string; py: string; fr: string };
}
interface ShadowItem {
  id: number;
  zh: string;
  fr: string;
  unknown: string[];
}

// ---------- audio ----------
let playing = Promise.resolve();
const SLOW_RATE = 0.75;
interface SayOpts {
  slow?: boolean;
  /** pinyin numérique (lecture voulue ; syllabe native) */
  pn?: string;
  /** caractère seul : enregistrement de la syllabe isolée */
  syllable?: boolean;
}
/** Prononce `text` (voix native si disponible, sinon synthèse locale). Lent = lecture ralentie (hauteur conservée) :
 *  la synthèse ralentie dégrade l'intelligibilité (docs/tts-bench.md). */
async function say(text: string, o: boolean | SayOpts = false): Promise<void> {
  const { slow = false, ...rest } = typeof o === 'boolean' ? { slow: o } : o;
  const r = await call<SpokenAudio | null>('tts:speak', text, rest.pn || rest.syllable ? rest : undefined).catch(() => null);
  if (r) await playFile(r.path, slow ? SLOW_RATE : 1);
}
/** Joue une suite de syllabes avec une courte pause. */
function sayAll(items: string[], gapMs = 350): Promise<void> {
  playing = playing
    .then(async () => {
      for (const t of items) {
        await say(t);
        await new Promise((r) => setTimeout(r, gapMs));
      }
    })
    .catch(() => {});
  return playing;
}

function Say({ zh, py, fr, size = 'md', slow }: { zh: string; py?: string; fr?: string; size?: 'sm' | 'md'; slow?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={'btn' + (size === 'sm' ? ' btn-sm' : '')}
      disabled={busy}
      title={fr ? `${py ?? ''} — ${fr}` : 'Écouter'}
      onClick={async () => {
        setBusy(true);
        try {
          await say(zh, slow);
        } finally {
          setBusy(false);
        }
      }}
      style={{ flexDirection: 'column', gap: 0, lineHeight: 1.2, minWidth: size === 'sm' ? 0 : 64 }}
    >
      <span className="hanzi" style={{ fontSize: size === 'sm' ? 18 : 24 }}>
        {zh}
      </span>
      {py && <span style={{ color: 'var(--gold)', fontSize: 13 }}>{py}</span>}
      {fr && size !== 'sm' && <span className="dim" style={{ fontSize: 11 }}>{fr}</span>}
    </button>
  );
}

// ---------- pinyin ----------
const MARK = ['', 'ā', 'á', 'ǎ', 'à', 'a'];
const TONE_NAMES = ['', '1er ton', '2e ton', '3e ton', '4e ton', 'neutre'];
/** Change les tons d'un pinyin accentué : setTones('nǐ hǎo', [2,3]) → 'ní hǎo'. */
function setTones(py: string, tones: number[]): string {
  const num = convert(py, { format: 'symbolToNum' }) as string;
  const syl = num.split(/\s+/);
  return convert(syl.map((s, i) => s.replace(/[1-5]?$/, String(tones[i] ?? 5))).join(' ')) as string;
}

// ---------- visuels ----------
const CHAO: Record<number, number[]> = { 1: [5, 5], 2: [3, 5], 3: [2, 1, 4], 4: [5, 1], 5: [3] };
const TONE_COLORS = ['', '#e5484d', '#e2a33a', '#3fb47a', '#4a9eed', '#a9b6c2'];

function ToneShape({ tone, w = 90, h = 70, grid = true, label = true }: { tone: number; w?: number; h?: number; grid?: boolean; label?: boolean }) {
  const pad = 8;
  const y = (lvl: number) => pad + ((5 - lvl) / 4) * (h - 2 * pad);
  const pts = CHAO[tone];
  const xs = pts.length === 1 ? [w / 2] : pts.map((_, i) => pad + 10 + (i / (pts.length - 1)) * (w - 2 * pad - 20));
  const d = pts.length === 3 ? `M${xs[0]},${y(pts[0])} Q${xs[1]},${y(0.2)} ${xs[2]},${y(pts[2])}` : pts.length === 2 ? `M${xs[0]},${y(pts[0])} L${xs[1]},${y(pts[1])}` : '';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label={TONE_NAMES[tone]}>
      {grid && [1, 2, 3, 4, 5].map((l) => <line key={l} x1={pad} x2={w - pad} y1={y(l)} y2={y(l)} stroke="var(--line)" strokeDasharray={l === 3 ? '' : '2 3'} />)}
      {label && [1, 3, 5].map((l) => <text key={l} x={0} y={y(l) + 3} fontSize={8} fill="var(--text-3)">{l}</text>)}
      {pts.length === 1 ? <circle cx={xs[0]} cy={y(pts[0])} r={5} fill={TONE_COLORS[tone]} /> : <path d={d} stroke={TONE_COLORS[tone]} strokeWidth={4} fill="none" strokeLinecap="round" />}
    </svg>
  );
}

function AllTonesChart() {
  const w = 300;
  const h = 150;
  const pad = 20;
  const y = (lvl: number) => pad + ((5 - lvl) / 4) * (h - 2 * pad);
  const x0 = 40;
  const x1 = w - 20;
  const xm = (x0 + x1) / 2;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ maxWidth: 420 }}>
      {[1, 2, 3, 4, 5].map((l) => (
        <g key={l}>
          <line x1={x0} x2={x1} y1={y(l)} y2={y(l)} stroke="var(--line)" strokeDasharray={l === 3 ? '' : '2 3'} />
          <text x={x0 - 8} y={y(l) + 4} fontSize={10} textAnchor="end" fill="var(--text-3)">{l}</text>
        </g>
      ))}
      <text x={4} y={y(5) + 4} fontSize={9} fill="var(--text-3)">aigu</text>
      <text x={4} y={y(1) + 4} fontSize={9} fill="var(--text-3)">grave</text>
      <path d={`M${x0},${y(5)} L${x1},${y(5)}`} stroke={TONE_COLORS[1]} strokeWidth={4} fill="none" />
      <path d={`M${x0},${y(3)} L${x1},${y(5) + 3}`} stroke={TONE_COLORS[2]} strokeWidth={4} fill="none" />
      <path d={`M${x0},${y(2)} Q${xm},${y(0.1)} ${x1},${y(4)}`} stroke={TONE_COLORS[3]} strokeWidth={4} fill="none" />
      <path d={`M${x0},${y(5) - 3} L${x1},${y(1)}`} stroke={TONE_COLORS[4]} strokeWidth={4} fill="none" />
      {[1, 2, 3, 4].map((t, i) => (
        <text key={t} x={x1 + 4} y={[y(5) - 4, y(5) + 12, y(4) + 4, y(1) + 4][i]} fontSize={11} fill={TONE_COLORS[t]} fontWeight={700}>
          {t}
        </text>
      ))}
    </svg>
  );
}

// ---------- suivi du temps (minutes réellement actives) ----------
function useActivityClock() {
  const buckets = useRef<Record<string, number>>({});
  const kind = useRef<string>('tones');
  const last = useRef(Date.now());
  useEffect(() => {
    const poke = () => (last.current = Date.now());
    window.addEventListener('pointerdown', poke);
    window.addEventListener('keydown', poke);
    const iv = window.setInterval(() => {
      if (Date.now() - last.current < 120_000) buckets.current[kind.current] = (buckets.current[kind.current] ?? 0) + 15;
    }, 15_000);
    return () => {
      window.removeEventListener('pointerdown', poke);
      window.removeEventListener('keydown', poke);
      clearInterval(iv);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const flush = useCallback(async () => {
    const b = buckets.current;
    buckets.current = {};
    for (const [type, sec] of Object.entries(b)) if (sec >= 30) await call('core:logActivity', type, Math.round((sec / 60) * 10) / 10).catch(() => {});
  }, []);
  return {
    setKind: (k: string) => (kind.current = k),
    flush,
  };
}

// ======================================================================
export function Tones(props: Record<string, unknown>) {
  const { go } = useNav();
  const [tab, setTab] = useState<TabId>((props.tab as TabId) ?? 'tons');
  const clock = useActivityClock();
  const [status, setStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  useEffect(() => {
    call<{ ok: boolean; detail: string }>('tts:status').then(setStatus, () => setStatus({ ok: false, detail: 'Service vocal indisponible' }));
  }, []);
  useEffect(() => {
    clock.setKind(tab === 'shadow' ? 'shadowing' : 'tones');
  }, [tab, clock]);

  const finish = async () => {
    await clock.flush();
    await call('core:markBlockDone', 'tones');
    toast('Séance « Tons & oral » validée. Beau travail, agent.');
    go('dashboard');
  };

  const TABS: [TabId, string][] = [
    ['tons', 'Les 4 tons'],
    ['pinyin', 'Pinyin'],
    ['ecoute', "Exercices d'écoute"],
    ['shadow', 'Shadowing'],
  ];
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Tons & oral</div>
          <div className="page-sub">Installer les sons du mandarin : tons, pinyin, oreille et prononciation.</div>
        </div>
        <button className="btn btn-primary" onClick={finish}>
          ✓ Terminer la séance
        </button>
      </div>
      {status && !status.ok && <div className="notice notice-warn" style={{ marginBottom: 16 }}>Voix de synthèse indisponible : {status.detail}</div>}
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'tons' && <TonesLesson />}
      {tab === 'pinyin' && <PinyinLesson />}
      {tab === 'ecoute' && <ListeningDrills />}
      {tab === 'shadow' && <Shadowing />}
    </div>
  );
}

// ======================================================================
// Onglet 1 : les 4 tons
const TONES_INFO: { t: number; name: string; chao: string; desc: ReactNode; tip: string; ex: [string, string, string][] }[] = [
  {
    t: 1,
    name: '1er ton — haut et plat',
    chao: '55',
    desc: <>La voix reste <strong>en haut</strong> de ta tessiture, sans bouger, comme une note chantée tenue (« laaa ») ou le « bip » d’un appareil.</>,
    tip: 'Plus haut que tu ne le crois, et bien stable jusqu’au bout.',
    ex: [
      ['妈', 'mā', 'maman'],
      ['书', 'shū', 'livre'],
      ['天', 'tiān', 'ciel, jour'],
      ['喝', 'hē', 'boire'],
    ],
  },
  {
    t: 2,
    name: '2e ton — montant',
    chao: '35',
    desc: <>Part du <strong>médium</strong> et <strong>monte</strong> franchement vers l’aigu, comme une question étonnée en français : « Hein ? », « Ah bon ? ».</>,
    tip: 'Monte jusqu’en haut, sans fléchir à la fin.',
    ex: [
      ['麻', 'má', 'chanvre'],
      ['人', 'rén', 'personne'],
      ['茶', 'chá', 'thé'],
      ['来', 'lái', 'venir'],
    ],
  },
  {
    t: 3,
    name: '3e ton — grave (creux)',
    chao: '214',
    desc: (
      <>
        Isolé ou en fin de phrase : descend <strong>dans le grave</strong> puis remonte (2-1-4). Dans la phrase, il reste presque toujours <strong>grave</strong> sans remonter (« demi-3e ton », 21) : pense
        « grave, un peu grinçant », comme un « bof… » dubitatif.
      </>
    ),
    tip: 'L’essentiel est d’aller très bas ; la remontée est secondaire.',
    ex: [
      ['马', 'mǎ', 'cheval'],
      ['好', 'hǎo', 'bien'],
      ['我', 'wǒ', 'je, moi'],
      ['水', 'shuǐ', 'eau'],
    ],
  },
  {
    t: 4,
    name: '4e ton — tombant',
    chao: '51',
    desc: <>Tombe <strong>brutalement de l’aigu au grave</strong>, court et net, comme un ordre sec : « Non ! », « Stop ! », ou un « Ah ! » de découverte.</>,
    tip: 'Commence bien haut ; la chute fait toute la différence avec le 1er ton.',
    ex: [
      ['骂', 'mà', 'gronder'],
      ['是', 'shì', 'être'],
      ['大', 'dà', 'grand'],
      ['去', 'qù', 'aller'],
    ],
  },
];

const SERIES: [string, string[], string[]][] = [
  ['ma', ['妈', '麻', '马', '骂'], ['mā maman', 'má chanvre', 'mǎ cheval', 'mà gronder']],
  ['ba', ['八', '拔', '把', '爸'], ['bā huit', 'bá arracher', 'bǎ tenir', 'bà papa']],
  ['yi', ['衣', '姨', '椅', '意'], ['yī vêtement', 'yí tante', 'yǐ chaise', 'yì sens']],
  ['tang', ['汤', '糖', '躺', '烫'], ['tāng soupe', 'táng sucre', 'tǎng s’allonger', 'tàng brûlant']],
  ['shi', ['诗', '十', '使', '是'], ['shī poème', 'shí dix', 'shǐ employer', 'shì être']],
];

function TonesLesson() {
  const [serie, setSerie] = useState(0);
  return (
    <div className="stack">
      <div className="card">
        <div className="grid-2" style={{ alignItems: 'center' }}>
          <div className="md">
            <p>
              Le mandarin est une <strong>langue à tons</strong> : la <strong>mélodie</strong> d’une syllabe fait partie du mot, au même titre que ses consonnes. <em>ma</em> avec 4 mélodies donne 4 mots
              sans rapport : <strong>mā</strong> maman, <strong>má</strong> chanvre, <strong>mǎ</strong> cheval, <strong>mà</strong> gronder.
            </p>
            <p>
              On note la hauteur sur une échelle de <strong>1 (grave) à 5 (aigu)</strong>, relative à <em>ta</em> voix. En français, la mélodie porte l’émotion de la phrase ; en chinois, elle est fixée
              pour chaque syllabe : il faut la produire même quand on n’est pas « expressif ».
            </p>
          </div>
          <div className="center">
            <AllTonesChart />
          </div>
        </div>
      </div>

      <div className="grid-2">
        {TONES_INFO.map((t) => (
          <div className="card" key={t.t}>
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <ToneShape tone={t.t} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: TONE_COLORS[t.t] }}>
                  {t.name} <span className="dim small">({t.chao})</span>
                </div>
                <div className="small" style={{ marginTop: 4 }}>{t.desc}</div>
                <div className="small dim" style={{ marginTop: 4 }}>Astuce : {t.tip}</div>
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              {t.ex.map(([zh, py, fr]) => <Say key={zh} zh={zh} py={py} fr={fr} />)}
            </div>
          </div>
        ))}
        <div className="card">
          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <ToneShape tone={5} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>Ton neutre — léger</div>
              <div className="small" style={{ marginTop: 4 }}>
                Syllabe <strong>courte et atone</strong>, sans marque en pinyin. Sa hauteur dépend du ton précédent : plutôt <strong>haute après un 3e ton</strong>, basse après un 4e. Particules (吗 ma,
                的 de, 了 le), 2e syllabe des redoublements et de nombreux mots courants.
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {(
              [
                ['妈妈', 'māma', 'maman'],
                ['谢谢', 'xièxie', 'merci'],
                ['我的', 'wǒ de', 'mon, à moi'],
                ['好吗', 'hǎo ma', 'ça va ?'],
              ] as const
            ).map(([zh, py, fr]) => (
              <Say key={zh} zh={zh} py={py} fr={fr} />
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title">Écouter les 4 tons à la suite</div>
          <div className="row">
            {SERIES.map(([k], i) => (
              <button key={k} className={'btn btn-sm' + (serie === i ? ' selected' : '')} onClick={() => setSerie(i)}>
                {k}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {SERIES[serie][1].map((zh, i) => {
              const [py, fr] = SERIES[serie][2][i].split(' ');
              return <Say key={zh} zh={zh} py={py} fr={fr} />;
            })}
          </div>
          <button className="btn" style={{ marginTop: 10 }} onClick={() => sayAll(SERIES[serie][1])}>
            ▶ 1 → 2 → 3 → 4
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Les changements de ton (sandhi)</div>
        <div className="md small">
          <p>Le pinyin des dictionnaires note le ton « de base ». À l’oral, quelques règles régulières le modifient — elles sont automatiques chez les natifs, apprends-les tôt :</p>
        </div>
        <div className="grid-2">
          <Rule
            title="3e + 3e → 2e + 3e"
            text="Deux 3e tons de suite : le premier devient un 2e ton. Le pinyin écrit ne change pas."
            ex={[
              ['你好', 'nǐ hǎo → ní hǎo'],
              ['可以', 'kěyǐ → kéyǐ'],
              ['水果', 'shuǐguǒ → shuíguǒ'],
              ['很好', 'hěn hǎo → hén hǎo'],
            ]}
          />
          <Rule
            title="3e ton devant 1, 2, 4 ou neutre → demi-3e"
            text="Il descend dans le grave (21) et ne remonte pas : c’est la forme la plus fréquente du 3e ton."
            ex={[
              ['老师', 'lǎoshī'],
              ['很忙', 'hěn máng'],
              ['可是', 'kěshì'],
              ['我们', 'wǒmen'],
            ]}
          />
          <Rule
            title="不 bù → bú devant un 4e ton"
            text="不 se prononce bú devant un 4e ton, bù partout ailleurs."
            ex={[
              ['不是', 'bù shì → bú shì'],
              ['不要', 'bù yào → bú yào'],
              ['不好', 'bù hǎo (inchangé)'],
              ['不来', 'bù lái (inchangé)'],
            ]}
          />
          <Rule
            title="一 yī : yí / yì selon le ton suivant"
            text="Seul, en fin de mot, pour compter ou dans un ordinal : yī. Devant un 4e ton : yí. Devant un 1er, 2e ou 3e ton : yì."
            ex={[
              ['第一', 'dì yī'],
              ['一个', 'yī ge → yí ge'],
              ['一样', 'yīyàng → yíyàng'],
              ['一起', 'yīqǐ → yìqǐ'],
            ]}
          />
        </div>
      </div>

      <div className="card md small">
        <div className="card-title">Placer la marque du ton</div>
        <p>
          La marque va sur <strong>a</strong> s’il y en a un (hǎo, tiān), sinon sur <strong>e</strong> (xiè, mén), sinon sur le <strong>o</strong> de <strong>ou</strong> (gǒu) ; sinon sur la{' '}
          <strong>dernière voyelle</strong> : guō, duì, liù. Le ton neutre ne porte pas de marque (ma, de).
        </p>
        <div className="card-title" style={{ marginTop: 10 }}>Méthode d’entraînement</div>
        <ul>
          <li>Exagère les contours au début (surtout la chute du 4e et le grave du 3e) ; la voix se « calibre » ensuite toute seule.</li>
          <li>Accompagne d’un geste de la main : plat, montée, creux, chute.</li>
          <li>Entraîne d’abord l’<strong>oreille</strong> (onglet Exercices d’écoute), puis la <strong>bouche</strong> (Shadowing, avec ta courbe comparée à la référence).</li>
          <li>Apprends chaque nouveau mot <strong>avec</strong> son ton : un ton faux est un autre mot.</li>
        </ul>
      </div>
    </div>
  );
}

function Rule({ title, text, ex }: { title: string; text: string; ex: [string, string][] }) {
  return (
    <div className="list-item" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
      <div style={{ fontWeight: 600, color: 'var(--gold)' }}>{title}</div>
      <div className="small muted">{text}</div>
      <div className="row" style={{ marginTop: 4 }}>
        {ex.map(([zh, py]) => (
          <Say key={zh} zh={zh} py={py} size="sm" />
        ))}
      </div>
    </div>
  );
}

// ======================================================================
// Onglet 2 : pinyin
const INITIALS: { group: string; items: [string, string, string, string][] }[] = [
  {
    group: 'Lèvres',
    items: [
      ['b', '八', 'bā', '« p » non soufflé (ce n’est pas un vrai « b » vibrant)'],
      ['p', '怕', 'pà', '« p » avec un fort souffle'],
      ['m', '妈', 'mā', 'comme en français'],
      ['f', '飞', 'fēi', 'comme en français'],
    ],
  },
  {
    group: 'Pointe de la langue',
    items: [
      ['d', '大', 'dà', '« t » non soufflé'],
      ['t', '他', 'tā', '« t » avec un fort souffle'],
      ['n', '你', 'nǐ', 'comme en français'],
      ['l', '来', 'lái', 'comme en français'],
    ],
  },
  {
    group: 'Fond de la bouche',
    items: [
      ['g', '哥', 'gē', '« k » non soufflé (jamais « j » : ge ≠ « je »)'],
      ['k', '开', 'kāi', '« k » avec un fort souffle'],
      ['h', '喝', 'hē', 'raclé, comme la jota espagnole — jamais muet'],
    ],
  },
  {
    group: 'Langue à plat (palatales)',
    items: [
      ['j', '鸡', 'jī', '« dj » très doux, pointe de langue derrière les dents du bas, lèvres étirées'],
      ['q', '七', 'qī', '« tch » doux et soufflé, langue à plat (jamais « k » !)'],
      ['x', '西', 'xī', 'entre « s » et « ch », langue à plat, sourire'],
    ],
  },
  {
    group: 'Langue retroussée (rétroflexes)',
    items: [
      ['zh', '知', 'zhī', '« dj » pointe de langue retroussée vers le palais, non soufflé'],
      ['ch', '吃', 'chī', '« tch » langue retroussée, soufflé'],
      ['sh', '诗', 'shī', '« ch » langue retroussée'],
      ['r', '日', 'rì', 'proche du « j » de « jour », langue retroussée ; jamais le « r » français'],
    ],
  },
  {
    group: 'Contre les dents (dentales)',
    items: [
      ['z', '字', 'zì', '« dz » non soufflé'],
      ['c', '次', 'cì', '« ts » soufflé (jamais « k » ni « s » !)'],
      ['s', '四', 'sì', '« s » toujours sourd (jamais « z »)'],
    ],
  },
  {
    group: 'Semi-voyelles',
    items: [
      ['y', '一', 'yī', '« y » de « yeux » (yi = « i »)'],
      ['w', '我', 'wǒ', '« ou » de « oui » (wu = « ou »)'],
    ],
  },
];

const FINALS: { group: string; items: [string, string, string, string][] }[] = [
  {
    group: 'Simples',
    items: [
      ['a', '他', 'tā', '« a » bien ouvert'],
      ['o', '波', 'bō', '« o » suivi d’un léger « ou » (bo ≈ « bouo »)'],
      ['e', '喝', 'hē', 'ni é ni è : « eu » relâché, venu de la gorge'],
      ['i', '你', 'nǐ', '« i » (mais voir le piège après z, c, s, zh, ch, sh, r)'],
      ['u', '书', 'shū', '« ou »'],
      ['ü', '女', 'nǚ', '« u » français (lune) ; écrit u après j, q, x, y'],
    ],
  },
  {
    group: 'Diphtongues',
    items: [
      ['ai', '爱', 'ài', '« aï »'],
      ['ei', '飞', 'fēi', '« eï » (comme « hey »)'],
      ['ao', '好', 'hǎo', '« a-o » (pas « o »)'],
      ['ou', '狗', 'gǒu', '« o-ou » (pas « ou » !)'],
    ],
  },
  {
    group: 'Nasales',
    items: [
      ['an', '三', 'sān', '« a » + « n » bien prononcé (pas le « an » nasal français)'],
      ['en', '门', 'mén', '« eu » + « n »'],
      ['ang', '忙', 'máng', '« a » ouvert + « ng » de « parking »'],
      ['eng', '冷', 'lěng', '« eu » + « ng »'],
      ['ong', '红', 'hóng', '« ou » + « ng »'],
    ],
  },
  {
    group: 'En i-',
    items: [
      ['ia', '家', 'jiā', '« ya »'],
      ['ie', '谢', 'xiè', '« yè »'],
      ['iao', '小', 'xiǎo', '« yao »'],
      ['iu (iou)', '六', 'liù', '« yo-ou »'],
      ['ian', '天', 'tiān', '« yèn » : le a se ferme en è !'],
      ['in', '心', 'xīn', '« i » + « n »'],
      ['iang', '想', 'xiǎng', '« ya » + « ng »'],
      ['ing', '听', 'tīng', '« i » + « ng »'],
      ['iong', '用', 'yòng', '« yong » (iong s’écrit yong sans initiale)'],
    ],
  },
  {
    group: 'En u-',
    items: [
      ['ua', '花', 'huā', '« oua »'],
      ['uo', '国', 'guó', '« ouo »'],
      ['uai', '快', 'kuài', '« ouaï »'],
      ['ui (uei)', '对', 'duì', '« oueï »'],
      ['uan', '晚', 'wǎn', '« ouan » (n final)'],
      ['un (uen)', '春', 'chūn', '« oueun »'],
      ['uang', '黄', 'huáng', '« ouang »'],
    ],
  },
  {
    group: 'En ü- et er',
    items: [
      ['üe', '学', 'xué', '« uè »'],
      ['üan', '远', 'yuǎn', '« uèn »'],
      ['ün', '云', 'yún', '« un » (u français + n)'],
      ['er', '二', 'èr', '« eur » avec la langue retroussée'],
    ],
  },
];

const TRAPS: { title: string; text: string; pairs: [string, string][] }[] = [
  {
    title: 'zh · ch · sh · r — langue retroussée',
    text: 'La pointe de la langue se relève vers le palais (derrière les alvéoles). Compare avec z · c · s, langue contre les dents.',
    pairs: [
      ['知', 'zhī'],
      ['资', 'zī'],
      ['吃', 'chī'],
      ['次', 'cì'],
      ['是', 'shì'],
      ['四', 'sì'],
      ['日', 'rì'],
      ['力', 'lì'],
    ],
  },
  {
    title: 'j · q · x — langue à plat',
    text: 'Pointe de langue derrière les dents du bas, dos de la langue contre le palais, lèvres étirées. Toujours suivies de i ou ü. Ne pas confondre avec zh · ch · sh.',
    pairs: [
      ['鸡', 'jī'],
      ['知', 'zhī'],
      ['七', 'qī'],
      ['吃', 'chī'],
      ['西', 'xī'],
      ['诗', 'shī'],
    ],
  },
  {
    title: 'Aspiration : b/p, d/t, g/k, z/c, zh/ch, j/q',
    text: 'En chinois, la différence n’est pas « vibré / non vibré » comme en français, mais « sans souffle / avec souffle ». Tiens une feuille devant ta bouche : elle doit bouger pour p, t, k, c, ch, q — et pas pour b, d, g, z, zh, j.',
    pairs: [
      ['八', 'bā'],
      ['怕', 'pà'],
      ['大', 'dà'],
      ['他', 'tā'],
      ['哥', 'gē'],
      ['渴', 'kě'],
    ],
  },
  {
    title: 'ü — le « u » français',
    text: 'Le ü est notre « u ». Après j, q, x, y on l’écrit u (去 qù = qü, 鱼 yú = yü), mais il se prononce toujours « u ». Le u chinois ordinaire, lui, est « ou ».',
    pairs: [
      ['女', 'nǚ'],
      ['怒', 'nù'],
      ['绿', 'lǜ'],
      ['路', 'lù'],
      ['去', 'qù'],
      ['鱼', 'yú'],
    ],
  },
  {
    title: '-n / -ng — pas de voyelle nasale',
    text: '-n : la langue touche les dents en fin de syllabe. -ng : fond de la bouche, comme « parking ». Le « an », « in », « on » nasals du français n’existent pas.',
    pairs: [
      ['心', 'xīn'],
      ['星', 'xīng'],
      ['前', 'qián'],
      ['墙', 'qiáng'],
      ['人', 'rén'],
      ['冷', 'lěng'],
    ],
  },
  {
    title: 'e — ni « é » ni « è »',
    text: 'Seul ou après consonne, e est un « eu » relâché venu de la gorge (喝 hē, 饿 è, 车 chē). Mais dans ie, üe, ei, il vaut « è / é » (谢 xiè, 学 xué, 飞 fēi).',
    pairs: [
      ['喝', 'hē'],
      ['饿', 'è'],
      ['车', 'chē'],
      ['谢', 'xiè'],
      ['学', 'xué'],
      ['飞', 'fēi'],
    ],
  },
  {
    title: 'i après z, c, s, zh, ch, sh, r — pas un « i »',
    text: 'Dans zi, ci, si, zhi, chi, shi, ri, le i n’est pas prononcé « i » : on prolonge simplement la consonne en la faisant vibrer (zi ≈ « dzz », shi ≈ « chrr »). Ailleurs (ni, qi, li…), c’est un vrai « i ».',
    pairs: [
      ['字', 'zì'],
      ['四', 'sì'],
      ['是', 'shì'],
      ['日', 'rì'],
      ['你', 'nǐ'],
      ['七', 'qī'],
    ],
  },
  {
    title: 'h, ou, ian — trois classiques',
    text: 'h est toujours prononcé (raclé). ou se dit « o-ou » (狗 gǒu), pas « ou ». ian se dit « yèn » (天 tiān), pas « yan ».',
    pairs: [
      ['好', 'hǎo'],
      ['狗', 'gǒu'],
      ['天', 'tiān'],
      ['钱', 'qián'],
    ],
  },
];

function PinyinLesson() {
  return (
    <div className="stack">
      <div className="notice small">
        Le <strong>pinyin</strong> est l’alphabet phonétique officiel du chinois. Attention : ses lettres <strong>ne se lisent pas comme en français</strong> (q, x, c, zh, e, u…). Une syllabe = une{' '}
        <strong>initiale</strong> (consonne) + une <strong>finale</strong> (voyelle(s), éventuellement -n/-ng) + un <strong>ton</strong>. Clique sur un exemple pour l’écouter.
      </div>
      <div className="card">
        <div className="card-title">Initiales (21 + y, w)</div>
        <div className="stack">
          {INITIALS.map((g) => (
            <div key={g.group}>
              <div className="small dim" style={{ marginBottom: 4 }}>{g.group}</div>
              <div className="grid-4" style={{ gap: 8 }}>
                {g.items.map(([ini, zh, py, note]) => (
                  <PySound key={ini} label={ini} zh={zh} py={py} note={note} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-title">Finales</div>
        <div className="stack">
          {FINALS.map((g) => (
            <div key={g.group}>
              <div className="small dim" style={{ marginBottom: 4 }}>{g.group}</div>
              <div className="grid-4" style={{ gap: 8 }}>
                {g.items.map(([fin, zh, py, note]) => (
                  <PySound key={fin} label={fin} zh={zh} py={py} note={note} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-title">Pièges pour francophones</div>
        <div className="grid-2">
          {TRAPS.map((t) => (
            <div key={t.title} className="list-item" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <div style={{ fontWeight: 600, color: 'var(--gold)' }}>{t.title}</div>
              <div className="small muted">{t.text}</div>
              <div className="row" style={{ marginTop: 4, gap: 6 }}>
                {t.pairs.map(([zh, py]) => (
                  <Say key={zh + py} zh={zh} py={py} size="sm" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PySound({ label, zh, py, note }: { label: string; zh: string; py: string; note: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="list-item clickable"
      style={{ alignItems: 'flex-start', textAlign: 'left', cursor: 'pointer', gap: 10 }}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await say(zh);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span style={{ fontSize: 20, fontWeight: 700, minWidth: 38, color: 'var(--text)' }}>{label}</span>
      <span style={{ flex: 1 }}>
        <span className="hanzi" style={{ fontSize: 18 }}>{zh}</span> <span style={{ color: 'var(--gold)' }}>{py}</span> {busy ? '♪' : '🔊'}
        <span className="small muted" style={{ display: 'block' }}>{note}</span>
      </span>
    </button>
  );
}

// ======================================================================
// Onglet 3 : exercices d'écoute
type DrillMode = 'single' | 'pairs' | 'minimal';
interface Stats {
  ok: number;
  total: number;
  streak: number;
  best: number;
}

function ListeningDrills() {
  const [mode, setMode] = useState<DrillMode>('single');
  const [stats, setStats] = useState<Stats>({ ok: 0, total: 0, streak: 0, best: 0 });
  const record = useCallback((ok: boolean) => {
    setStats((s) => {
      const streak = ok ? s.streak + 1 : 0;
      return { ok: s.ok + (ok ? 1 : 0), total: s.total + 1, streak, best: Math.max(s.best, streak) };
    });
  }, []);
  return (
    <div className="stack">
      <div className="row">
        <div className="mode-switch">
          {(
            [
              ['single', 'Ton d’une syllabe'],
              ['pairs', 'Paires de tons'],
              ['minimal', 'Paires minimales'],
            ] as [DrillMode, string][]
          ).map(([m, l]) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {l}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <div className="stat" style={{ alignItems: 'flex-end' }}>
          <span className="stat-value" style={{ fontSize: 20 }}>
            {stats.ok}/{stats.total}
          </span>
          <span className="stat-label">score</span>
        </div>
        <div className="stat" style={{ alignItems: 'flex-end' }}>
          <span className="stat-value" style={{ fontSize: 20, color: stats.streak >= 5 ? 'var(--gold)' : undefined }}>
            {stats.streak}
          </span>
          <span className="stat-label">série (max {stats.best})</span>
        </div>
      </div>
      {mode === 'single' && <SingleToneDrill onAnswer={record} />}
      {mode === 'pairs' && <TonePairDrill onAnswer={record} />}
      {mode === 'minimal' && <MinimalPairDrill onAnswer={record} />}
    </div>
  );
}

function useDrill<T>(channel: string, ...args: unknown[]) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    setItems(null);
    setI(0);
    call<T[]>(channel, ...args).then(setItems, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, n]);
  return { items, error, i, next: () => setI((x) => x + 1), restart: () => setN((x) => x + 1) };
}

function DrillEnd({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="card center" style={{ padding: 30 }}>
      <div style={{ fontSize: 18, fontWeight: 600 }}>Série terminée.</div>
      <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onRestart}>
        Nouvelle série
      </button>
    </div>
  );
}

function ToneButtons({ choices, picked, answer, onPick, keys }: { choices: number[]; picked: number | null; answer: number[]; onPick: (t: number) => void; keys?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'center' }}>
      {choices.map((t, k) => {
        const cls = picked == null ? '' : answer.includes(t) ? ' r3' : picked === t ? ' r1' : '';
        return (
          <button key={t} className={'btn btn-lg' + cls} style={{ flexDirection: 'column', gap: 2, minWidth: 96 }} onClick={() => picked == null && onPick(t)}>
            <ToneShape tone={t} w={60} h={34} grid={false} label={false} />
            <span>
              {MARK[t]} <span className="small dim">{TONE_NAMES[t]}</span>
            </span>
            {keys && <span className="kbd">{k + 1}</span>}
          </button>
        );
      })}
    </div>
  );
}

function SingleToneDrill({ onAnswer }: { onAnswer: (ok: boolean) => void }) {
  const d = useDrill<DrillWord>('tts:toneDrill', 15, { syllables: 1 });
  const [picked, setPicked] = useState<number | null>(null);
  const it = d.items?.[d.i];
  useEffect(() => {
    setPicked(null);
    if (it) say(it.w, syl(it));
  }, [it]);
  const pick = (t: number) => {
    if (!it || picked != null) return;
    setPicked(t);
    onAnswer(it.heard[0] === t);
  };
  useKeys({ '1': () => pick(1), '2': () => pick(2), '3': () => pick(3), '4': () => pick(4), r: () => it && say(it.w, syl(it)), Enter: () => picked != null && d.next(), Space: () => picked != null && d.next() }, [it, picked]);
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.items) return <Loading text="Préparation des syllabes…" />;
  if (!d.items.length) return <div className="empty">Aucune syllabe disponible.</div>;
  if (!it) return <DrillEnd onRestart={d.restart} />;
  return (
    <div className="card study-card" style={{ minHeight: 320 }}>
      <div className="study-prompt-label">
        Syllabe {d.i + 1}/{d.items.length} — quel ton entends-tu ?
      </div>
      <div className="row">
        <button className="btn btn-lg" onClick={() => say(it.w, syl(it))}>🔊 Réécouter <span className="kbd">R</span></button>
        <button className="btn" onClick={() => say(it.w, { ...syl(it), slow: true })}>🐢 Lent</button>
      </div>
      <ToneButtons choices={[1, 2, 3, 4]} picked={picked} answer={[it.heard[0]]} onPick={pick} keys />
      {picked != null && (
        <div className="answer">
          <div className={picked === it.heard[0] ? 'correct' : 'wrong'} style={{ fontWeight: 600 }}>
            {picked === it.heard[0] ? 'Exact !' : `Non : c’était le ${TONE_NAMES[it.heard[0]]}.`}
          </div>
          <div className="row">
            <span className="hanzi-lg">{it.w}</span>
            <span className="pinyin">{it.py}</span>
            <span className="muted">{it.fr}</span>
          </div>
          <div className="small dim">À toi : répète la syllabe et compare ta courbe à celle de la voix native.</div>
          <PitchCompare key={it.w} text={it.w} pn={it.pn} syllable compact />
          <button className="btn btn-primary" onClick={d.next}>
            Suivant <span className="kbd">Entrée</span>
          </button>
        </div>
      )}
    </div>
  );
}
/** Référence d'un exercice d'une syllabe : l'enregistrement natif de la syllabe (pinyin du programme). */
const syl = (it: DrillWord): SayOpts => (it.pn ? { pn: it.pn, syllable: true } : {});

const COMBOS_2 = [1, 2, 3, 4, 5];
function TonePairDrill({ onAnswer }: { onAnswer: (ok: boolean) => void }) {
  const d = useDrill<DrillWord>('tts:toneDrill', 20, { syllables: 2 });
  const [t1, setT1] = useState<number | null>(null);
  const [t2, setT2] = useState<number | null>(null);
  const [done, setDone] = useState<boolean>(false);
  const [matrix, setMatrix] = useState<Record<string, boolean>>({});
  const it = d.items?.[d.i];
  useEffect(() => {
    setT1(null);
    setT2(null);
    setDone(false);
    if (it) say(it.w);
  }, [it]);
  const correctFor = (a: number, b: number) => !!it && ((a === it.tones[0] && b === it.tones[1]) || (a === it.heard[0] && b === it.heard[1]));
  useEffect(() => {
    if (!it || done || t1 == null || t2 == null) return;
    const ok = correctFor(t1, t2);
    setDone(true);
    onAnswer(ok);
    const k = `${it.tones[0]}${it.tones[1]}`;
    setMatrix((m) => ({ ...m, [k]: m[k] || ok }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t1, t2]);
  useKeys({ r: () => it && say(it.w), Enter: () => done && d.next(), Space: () => done && d.next() }, [it, done]);
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.items) return <Loading text="Sélection des mots (combinaisons de tons)…" />;
  if (!d.items.length) return <div className="empty">Aucun mot disponible.</div>;
  const sandhi = it && (it.tones[0] !== it.heard[0] || it.tones[1] !== it.heard[1]);
  return (
    <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
      {!it ? (
        <DrillEnd onRestart={d.restart} />
      ) : (
        <div className="card study-card" style={{ minHeight: 360 }}>
          <div className="study-prompt-label">
            Mot {d.i + 1}/{d.items.length} — quels sont les deux tons ?
          </div>
          <div className="row">
            <button className="btn btn-lg" onClick={() => say(it.w)}>🔊 Réécouter <span className="kbd">R</span></button>
            <button className="btn" onClick={() => say(it.w, true)}>🐢 Lent</button>
          </div>
          <div className="small dim">1re syllabe</div>
          <ToneButtons choices={[1, 2, 3, 4]} picked={t1} answer={done ? [it.tones[0], it.heard[0]] : []} onPick={setT1} />
          <div className="small dim">2e syllabe</div>
          <ToneButtons choices={COMBOS_2} picked={t2} answer={done ? [it.tones[1], it.heard[1]] : []} onPick={(t) => t1 != null && setT2(t)} />
          {done && (
            <div className="answer">
              <div className={correctFor(t1!, t2!) ? 'correct' : 'wrong'} style={{ fontWeight: 600 }}>
                {correctFor(t1!, t2!) ? 'Exact !' : `Non : ${TONE_NAMES[it.tones[0]]} + ${TONE_NAMES[it.tones[1]]}.`}
              </div>
              <div className="row">
                <span className="hanzi-lg">{it.w}</span>
                <span className="pinyin">{it.py}</span>
                <span className="muted">{it.fr}</span>
              </div>
              {sandhi && (
                <div className="small notice">
                  Sandhi : on écrit <strong>{it.py}</strong> mais on prononce <strong>{setTones(it.py, it.heard)}</strong> (3e + 3e → 2e + 3e). Les deux réponses sont acceptées.
                </div>
              )}
              <PitchCompare key={it.w} text={it.w} compact />
              <button className="btn btn-primary" onClick={d.next}>
                Suivant <span className="kbd">Entrée</span>
              </button>
            </div>
          )}
        </div>
      )}
      <div className="card">
        <div className="card-title">Les 20 combinaisons</div>
        <table style={{ borderCollapse: 'separate', borderSpacing: 4, width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th />
              {COMBOS_2.map((b) => (
                <th key={b} className="dim" style={{ fontWeight: 500 }}>
                  {b === 5 ? '0' : b}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4].map((a) => (
              <tr key={a}>
                <th className="dim" style={{ fontWeight: 500 }}>{a}</th>
                {COMBOS_2.map((b) => {
                  const k = `${a}${b}`;
                  return (
                    <td key={b} style={{ height: 26, borderRadius: 6, textAlign: 'center', background: matrix[k] ? 'rgba(63,180,122,.35)' : k in matrix ? 'rgba(229,72,77,.25)' : 'var(--bg-2)' }}>
                      {matrix[k] ? '✓' : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small dim" style={{ marginTop: 8 }}>
          Ligne = ton de la 1re syllabe, colonne = 2e syllabe (0 = neutre). Vert = combinaison reconnue au moins une fois.
        </div>
      </div>
    </div>
  );
}

const CONTRAST_TIPS: Record<string, string> = {
  ton: 'Seule la mélodie change : concentre-toi sur la forme (plat, montée, creux, chute).',
  initiale: 'Écoute l’attaque de la syllabe : souffle (aspiration) et position de la langue.',
  finale: 'Écoute la fin de la syllabe : -n (langue aux dents) ou -ng (fond de la bouche), u ou ü…',
};

function MinimalPairDrill({ onAnswer }: { onAnswer: (ok: boolean) => void }) {
  const d = useDrill<MinimalPair>('tts:minimalPairs', 12);
  const [target, setTarget] = useState<0 | 1>(0);
  const [picked, setPicked] = useState<0 | 1 | null>(null);
  const it = d.items?.[d.i];
  const opts = useMemo(() => (it ? [it.a, it.b] : []), [it]);
  useEffect(() => {
    setPicked(null);
    if (!it) return;
    const t = Math.random() < 0.5 ? 0 : 1;
    setTarget(t);
    say((t === 0 ? it.a : it.b).w);
  }, [it]);
  const pick = (k: 0 | 1) => {
    if (picked != null || !it) return;
    setPicked(k);
    onAnswer(k === target);
  };
  useKeys({ '1': () => pick(0), '2': () => pick(1), r: () => it && say(opts[target].w), Enter: () => picked != null && d.next(), Space: () => picked != null && d.next() }, [it, picked, target]);
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.items) return <Loading text="Recherche de paires minimales…" />;
  if (!d.items.length) return <div className="empty">Aucune paire disponible.</div>;
  if (!it) return <DrillEnd onRestart={d.restart} />;
  return (
    <div className="card study-card" style={{ minHeight: 340 }}>
      <div className="study-prompt-label">
        Paire {d.i + 1}/{d.items.length} — <span className="tag">{it.kind}</span> <span className="tag tag-info">{it.contrast}</span> — lequel entends-tu ?
      </div>
      <button className="btn btn-lg" onClick={() => say(opts[target].w)}>🔊 Réécouter <span className="kbd">R</span></button>
      <div className="row" style={{ justifyContent: 'center', gap: 16 }}>
        {opts.map((o, k) => {
          const cls = picked == null ? '' : k === target ? ' r3' : picked === k ? ' r1' : '';
          return (
            <button key={o.w} className={'btn btn-lg' + cls} style={{ flexDirection: 'column', minWidth: 160 }} onClick={() => pick(k as 0 | 1)}>
              <span className="pinyin" style={{ fontSize: 24 }}>{o.py}</span>
              {picked != null && <span className="hanzi" style={{ fontSize: 26 }}>{o.w}</span>}
              {picked != null && <span className="small muted">{o.fr}</span>}
              <span className="kbd">{k + 1}</span>
            </button>
          );
        })}
      </div>
      {picked != null && (
        <div className="answer">
          <div className={picked === target ? 'correct' : 'wrong'} style={{ fontWeight: 600 }}>
            {picked === target ? 'Exact !' : `Non : c’était ${opts[target].py}.`}
          </div>
          <div className="small muted">{CONTRAST_TIPS[it.kind]}</div>
          <div className="row">
            {opts.map((o) => (
              <Say key={o.w} zh={o.w} py={o.py} size="sm" />
            ))}
            <button className="btn btn-sm" onClick={() => sayAll([it.a.w, it.b.w, it.a.w, it.b.w], 250)}>▶ alterner</button>
          </div>
          <button className="btn btn-primary" onClick={d.next}>
            Suivant <span className="kbd">Entrée</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ======================================================================
// Onglet 4 : shadowing
function Shadowing() {
  const d = useDrill<ShadowItem>('tts:shadowSet', 8);
  const [showPy, setShowPy] = useState(false);
  const [showFr, setShowFr] = useState(false);
  const [best, setBest] = useState<Record<number, number>>({});
  const it = d.items?.[d.i];
  useEffect(() => setShowFr(false), [it]);
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.items) return <Loading text="Choix des phrases…" />;
  if (!d.items.length) return <div className="empty">Aucune phrase disponible.</div>;
  const scores = Object.values(best);
  return (
    <div className="stack">
      <div className="notice small">
        <strong>Méthode :</strong> 1. écoute la phrase 2-3 fois (lent puis normal) ; 2. répète <em>en même temps</em> que la voix, à mi-voix, en imitant la mélodie ; 3. enregistre-toi et compare ta courbe
        (bleu) à la référence (or). Vise la <strong>forme</strong> de la courbe, pas la hauteur absolue.
      </div>
      {!it ? (
        <div className="card center" style={{ padding: 30 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Série terminée.</div>
          {scores.length > 0 && <div className="muted">Score moyen : {Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}/100</div>}
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={d.restart}>
            Nouvelles phrases
          </button>
        </div>
      ) : (
        <div className="card">
          <div className="row">
            <span className="study-prompt-label">
              Phrase {d.i + 1}/{d.items.length}
            </span>
            {it.unknown.length > 0 && <span className="tag tag-warn">caractères nouveaux : {it.unknown.join(' ')}</span>}
            <div className="spacer" />
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={showPy} onChange={(e) => setShowPy(e.target.checked)} /> pinyin
            </label>
          </div>
          <div className="center" style={{ margin: '14px 0' }}>
            <div className="zh-line" style={{ fontSize: 34 }}>{it.zh}</div>
            {showPy && <div className="pinyin">{pinyin(it.zh)}</div>}
            {showFr ? (
              <div className="fr muted">{it.fr}</div>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowFr(true)}>
                Voir la traduction
              </button>
            )}
          </div>
          <div className="row" style={{ justifyContent: 'center', marginBottom: 12 }}>
            <button className="btn" onClick={() => say(it.zh, true)}>🐢 Lent</button>
            <button className="btn" onClick={() => say(it.zh)}>🔊 Normal</button>
          </div>
          <PitchCompare key={it.id} text={it.zh} onScore={(s) => setBest((b) => ({ ...b, [it.id]: Math.max(b[it.id] ?? 0, s) }))} />
          <div className="row" style={{ marginTop: 12 }}>
            {best[it.id] != null && <span className="muted small">Meilleur essai : {best[it.id]}/100</span>}
            <div className="spacer" />
            <button className="btn btn-primary" onClick={d.next}>
              Phrase suivante →
            </button>
          </div>
        </div>
      )}
      <div className="list">
        {d.items.map((s, k) => (
          <div key={s.id} className={'list-item' + (k === d.i ? ' highlight' : '')} style={{ opacity: k === d.i ? 1 : 0.7, borderColor: k === d.i ? 'var(--accent)' : undefined }}>
            <span className="hanzi" style={{ fontSize: 18 }}>{s.zh}</span>
            <div className="spacer" />
            {best[s.id] != null && <span className={'tag ' + (best[s.id] >= 62 ? 'tag-ok' : 'tag-warn')}>{best[s.id]}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
