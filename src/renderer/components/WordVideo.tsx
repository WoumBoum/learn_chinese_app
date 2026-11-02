// Vidéo YouTube d'un mot (slot « usage ») ou d'un caractère (slot « etymology »). STUB — implémenté par le workflow B.
export interface WordVideoProps {
  /** mot (slot usage) ou caractère unique (slot etymology) */
  target: string;
  slot: 'usage' | 'etymology';
  /** affichage réduit (popup, fiche caractère) */
  compact?: boolean;
}

export function WordVideo(_props: WordVideoProps) {
  return null;
}
