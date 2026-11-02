// Fiche caractère illustrée : dessin de ce que représente le caractère EN FOND, caractère par-dessus, type, évolution
// (oracle → bronze → sceau → moderne, Wikimedia Commons à la demande), origine, composants cliquables (fiche imbriquée),
// moyen mnémotechnique (aide-mémoire, pas étymologie), mots qui le contiennent, vidéo « origine du caractère ».
// Pinyin autorisé : fiche consultée à la demande ou à la première présentation.
import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { speak } from './common';
import { WordVideo } from './WordVideo';
import './CharCard.css';

type Role = 'sens' | 'son' | 'forme';
export interface CharCardData {
  c: string;
  py: string[];
  fr: string[];
  story?: {
    type: string;
    origin: string;
    components: { c: string; role: Role; fr: string; py?: string }[];
    mnemonic: string;
    scene: string;
    svg: string;
    source: 'curated' | 'mmah';
  };
  dec: string;
  rad: string;
  strokes: number;
  words: { w: string; py: string; fr: string }[];
  inCurriculum: boolean;
}
type FormName = 'oracle' | 'bronze' | 'bigseal' | 'seal';
interface AncientForm {
  form: FormName;
  svg: string;
  license: string;
  author: string;
  url: string;
  src?: string;
}
interface AncientResult {
  forms: AncientForm[];
  status: 'ok' | 'none' | 'offline' | 'pending';
}

export interface CharCardProps {
  char: string;
  compact?: boolean;
  /** section « Vidéo : origine du caractère » (par défaut : oui sauf en compact) */
  showVideo?: boolean;
  onClose?: () => void;
}

const TYPE_LABEL: Record<string, { label: string; tip: string }> = {
  pictogramme: { label: 'Pictogramme', tip: 'Dessin stylisé de la chose elle-même.' },
  idéogramme: { label: 'Idéogramme', tip: 'Signe abstrait qui indique une idée (position, quantité…).' },
  'idéogramme composé': { label: 'Idéogramme', tip: 'Idéogramme composé : plusieurs éléments dont les sens se combinent.' },
  'idéo-phonétique': { label: 'Idéo-phonétique', tip: 'Une partie donne le sens, une autre donne le son.' },
  'emprunt phonétique': { label: 'Emprunt', tip: 'Emprunt phonétique : caractère pris pour son son, pour écrire un autre mot.' },
  'forme altérée': { label: 'Forme altérée', tip: "Le dessin d'origine a été déformé ou simplifié au point de ne plus se reconnaître." },
  incertain: { label: 'Origine incertaine', tip: 'Les spécialistes ne sont pas d’accord sur l’origine.' },
};
const ROLE_TIP: Record<Role, string> = { sens: 'donne le sens', son: 'donne le son', forme: 'élément de forme' };
const FORM_LABEL: Record<FormName, { fr: string; zh: string }> = {
  oracle: { fr: 'Oracle', zh: '甲骨文' },
  bronze: { fr: 'Bronze', zh: '金文' },
  bigseal: { fr: 'Grand sceau', zh: '大篆' },
  seal: { fr: 'Sceau', zh: '小篆' },
};
const FORM_ORDER: FormName[] = ['oracle', 'bronze', 'bigseal', 'seal'];
/** lien « source » : uniquement une page de fichier Commons (déjà vérifié dans le processus principal) */
const COMMONS_PAGE = /^https:\/\/commons\.wikimedia\.org\/wiki\/[^\s"'<>\\]+$/;

/** Les SVG viennent de char-stories.json (validé au build) ou de chars:ancient (assaini dans le processus principal) ;
 *  dernier garde-fou côté interface. */
const unsafe = (svg: string) => /<(?!\/?(svg|g|path|circle|ellipse|line|polyline|polygon|rect)[\s>/])|\son\w+\s*=|href|url\(|javascript:/i.test(svg);
function SvgArt({ svg, className }: { svg: string; className: string }) {
  if (!svg || unsafe(svg)) return null;
  return <div className={className} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}

// caches de session (les fiches sont statiques ; formes anciennes : seulement les résultats définitifs)
const cardCache = new Map<string, Promise<CharCardData>>();
const ancientCache = new Map<string, AncientResult>();
function loadCard(c: string): Promise<CharCardData> {
  let p = cardCache.get(c);
  if (!p) {
    p = call<CharCardData>('chars:card', c);
    p.catch(() => cardCache.delete(c));
    cardCache.set(c, p);
  }
  return p;
}

function useAncient(c: string): AncientResult | null {
  const [res, setRes] = useState<AncientResult | null>(() => ancientCache.get(c) ?? null);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cached = ancientCache.get(c);
    setRes(cached ?? null);
    if (cached) return;
    const ask = () => {
      call<AncientResult>('chars:ancient', c)
        .then((r) => {
          if (!alive) return;
          if (r.status === 'pending' && ++tries < 8) {
            setRes(r);
            timer = setTimeout(ask, 3000);
            return;
          }
          if (r.status === 'ok' || r.status === 'none') ancientCache.set(c, r);
          setRes(r.status === 'pending' ? { status: 'offline', forms: [] } : r);
        })
        .catch(() => alive && setRes({ status: 'offline', forms: [] }));
    };
    ask();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [c]);
  return res;
}

export function CharCard({ char, compact = false, showVideo, onClose }: CharCardProps) {
  // pile de navigation : clic sur un composant → sa fiche, « retour » → la précédente
  const [stack, setStack] = useState<string[]>([]);
  useEffect(() => setStack([]), [char]);
  const c = stack.length ? stack[stack.length - 1] : char;
  const [data, setData] = useState<CharCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    setVideoOpen(false);
    loadCard(c)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [c]);
  const ancient = useAncient(c);
  const withVideo = showVideo ?? !compact;

  const open = (k: string) => {
    setStack((s) => [...s, k]);
    top.current?.scrollIntoView({ block: 'nearest' });
  };
  const back = () => setStack((s) => s.slice(0, -1));

  const cls = 'cc' + (compact ? ' cc-compact' : '');
  if (error)
    return (
      <div className={cls} ref={top}>
        <div className="small dim">Fiche indisponible : {error}</div>
      </div>
    );
  if (!data || data.c !== c)
    return (
      <div className={cls} ref={top}>
        <div className="cc-loading small dim">Chargement de la fiche « {c} »…</div>
      </div>
    );

  const st = data.story;
  const type = st?.type ? TYPE_LABEL[st.type] ?? { label: st.type, tip: '' } : null;
  const forms = (ancient?.forms ?? []).slice().sort((a, b) => FORM_ORDER.indexOf(a.form) - FORM_ORDER.indexOf(b.form));
  const srcs = [...new Set(forms.map((f) => f.src).filter(Boolean))] as string[];
  const credit = forms.map((f) => `${FORM_LABEL[f.form].fr} : ${f.author || 'auteur inconnu'} — ${f.license}`).join('\n');
  const meaning = data.fr.slice(0, compact ? 2 : 3).join(' ; ');

  return (
    <div className={cls} ref={top}>
      {stack.length === 0 && onClose && (
        <button className="btn btn-sm btn-ghost cc-close" onClick={onClose} title="Fermer">
          ✕
        </button>
      )}
      {stack.length > 0 && (
        <div className="cc-nav">
          {stack.length > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={back} title="Revenir à la fiche précédente">
              ← <span className="hanzi">{stack.length > 1 ? stack[stack.length - 2] : char}</span>
            </button>
          )}
          <div className="spacer" />
          {onClose && (
            <button className="btn btn-sm btn-ghost" onClick={onClose} title="Fermer">
              ✕
            </button>
          )}
        </div>
      )}

      <div className={'cc-head' + (stack.length === 0 && onClose ? ' cc-head-x' : '')}>
        <div className="cc-hero" title={st?.scene ? `Dessin : ${st.scene}` : undefined}>
          {st?.svg && <SvgArt svg={st.svg} className="cc-art" />}
          <span className="cc-glyph">{data.c}</span>
        </div>
        <div className="cc-meta">
          <div className="cc-line">
            {data.py.length > 0 && <span className="pinyin cc-py">{data.py.slice(0, 3).join(' / ')}</span>}
            <button className="btn btn-sm cc-audio" onClick={(e) => (e.currentTarget.blur(), speak(data.c))} title="Écouter">
              🔊
            </button>
            {type && (
              <span className={'cc-type cc-type-' + (st!.type.split(/\s|-/)[0] || 'x').normalize('NFD').replace(/[^\w]/g, '')} title={type.tip}>
                {type.label}
              </span>
            )}
          </div>
          {meaning && <div className="cc-fr">{meaning}</div>}
          <div className="cc-facts small dim">
            {data.strokes > 0 && <span>{data.strokes} traits</span>}
            {data.rad && data.rad !== data.c && (
              <span>
                clé <span className="hanzi">{data.rad}</span>
              </span>
            )}
            {!data.inCurriculum && <span>composant</span>}
          </div>
          {data.words.length > 0 && (
            <div className="cc-words">
              {data.words.slice(0, compact ? 3 : 4).map((w) => (
                <button key={w.w} className="cc-word" onClick={(e) => (e.currentTarget.blur(), speak(w.w))} title={`${w.py} — écouter`}>
                  <span className="hanzi">{w.w}</span>
                  <span className="cc-word-fr">{w.fr}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* évolution : seulement si des formes anciennes existent */}
      {ancient === null || ancient.status === 'pending' ? (
        <div className="cc-evo-state small dim">
          <span className="cc-spin" aria-hidden /> chargement des formes anciennes…
        </div>
      ) : forms.length > 0 ? (
        <div className="cc-evo-wrap">
          <div className="cc-evo">
            {forms.map((f, i) => (
              <div key={f.form} className="cc-evo-step">
                {i > 0 && <span className="cc-evo-arrow">→</span>}
                <figure className="cc-evo-tile" title={`${FORM_LABEL[f.form].zh} — ${f.author || ''} (${f.license})`}>
                  <SvgArt svg={f.svg} className="cc-evo-svg" />
                  <figcaption>{FORM_LABEL[f.form].fr}</figcaption>
                </figure>
              </div>
            ))}
            <div className="cc-evo-step">
              <span className="cc-evo-arrow">→</span>
              <figure className="cc-evo-tile cc-evo-modern">
                <span className="hanzi">{data.c}</span>
                <figcaption>Moderne</figcaption>
              </figure>
            </div>
          </div>
          <div className="cc-credit" title={credit}>
            {srcs.length > 0 && (
              <>
                formes anciennes de <span className="hanzi">{srcs.join('、')}</span> (traditionnel) ·{' '}
              </>
            )}
            Wikimedia Commons, Ancient Chinese characters project ·{' '}
            {[...new Set(forms.map((f) => f.license))].join(', ')}
            {COMMONS_PAGE.test(forms[0]?.url ?? '') && (
              <>
                {' · '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    call('core:openExternal', forms[0].url).catch(() => undefined);
                  }}
                >
                  source
                </a>
              </>
            )}
          </div>
        </div>
      ) : ancient.status === 'offline' && !compact ? (
        <div className="cc-evo-state small dim">Formes anciennes indisponibles (hors ligne ou service saturé) — réessaie plus tard.</div>
      ) : null}

      {st?.origin && (
        <div className="cc-sec">
          <div className="cc-label">Origine{st.source === 'mmah' ? ' (Make Me a Hanzi, en anglais)' : ''}</div>
          <p className="cc-text">{st.origin}</p>
        </div>
      )}

      {st && st.components.length > 0 && (
        <div className="cc-sec">
          <div className="cc-label">Composants</div>
          <div className="cc-comps">
            {st.components.map((k, i) => {
              const body = (
                <>
                  <span className="hanzi cc-comp-c">{k.c}</span>
                  <span className="cc-comp-body">
                    <span className="cc-role">{k.role}</span>
                    <span className="cc-comp-fr">
                      {k.fr}
                      {k.py && !k.fr.includes(k.py) ? <span className="cc-comp-py"> {k.py}</span> : null}
                    </span>
                  </span>
                </>
              );
              // le caractère lui-même décrit comme « forme » (气, 牛, 心…) : rien à ouvrir
              return k.c === data.c ? (
                <span key={k.c + i} className={'cc-comp cc-comp-self cc-role-' + k.role} title={ROLE_TIP[k.role]}>
                  {body}
                </span>
              ) : (
                <button key={k.c + i} className={'cc-comp cc-role-' + k.role} onClick={(e) => (e.currentTarget.blur(), open(k.c))} title={`${ROLE_TIP[k.role]} — ouvrir la fiche de ${k.c}`}>
                  {body}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {st?.mnemonic && (
        <div className="cc-sec cc-mnemo">
          <div className="cc-label">
            Moyen mnémotechnique <span className="cc-label-note">aide-mémoire inventé, pas l’étymologie</span>
          </div>
          <p className="cc-text">{st.mnemonic}</p>
        </div>
      )}

      {!st && <div className="small dim">Pas encore de fiche détaillée pour ce caractère.</div>}

      {withVideo && (
        <div className="cc-sec cc-video">
          <button className="cc-toggle" onClick={(e) => (e.currentTarget.blur(), setVideoOpen((v) => !v))} aria-expanded={videoOpen}>
            <span className="cc-caret">{videoOpen ? '▾' : '▸'}</span> Vidéo : origine du caractère
          </button>
          {videoOpen && <WordVideo target={data.c} slot="etymology" compact />}
        </div>
      )}
    </div>
  );
}

/** Puce repliée (caractère déjà connu) qui se déplie en fiche. */
export function CharChip({ char, gloss, defaultOpen = false, compact = true, showVideo }: { char: string; gloss?: string; defaultOpen?: boolean; compact?: boolean; showVideo?: boolean }) {
  const [openCard, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [char, defaultOpen]);
  if (openCard) return <CharCard char={char} compact={compact} showVideo={showVideo} onClose={() => setOpen(false)} />;
  return (
    <button className="cc-chip" onClick={(e) => (e.currentTarget.blur(), setOpen(true))} title="Afficher la fiche du caractère">
      <span className="hanzi">{char}</span>
      {gloss && <span className="cc-chip-fr">{gloss}</span>}
      <span className="cc-chip-more">origine ▸</span>
    </button>
  );
}
