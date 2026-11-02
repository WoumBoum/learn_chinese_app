// Sens en français des clés réduites et composants sans entrée de dictionnaire française (扌, 辶, 纟…). Sans cette
// table, leur fiche retombait sur le glossaire anglais de CC-CEDICT (« (en) hand », « (en) kwukyel ») ou sur rien,
// alors que la fiche parente venait de les nommer en français. Formes sans sens propre : « (forme : …) ».

export const RADICAL_FR: Readonly<Record<string, readonly string[]>> = {
  // clés réduites (forme latérale ou supérieure d'une clé du Kangxi)
  扌: ['main (clé réduite de 手)'],
  辶: ['marche, mouvement (clé 辵)'],
  纟: ['soie, fil (clé réduite de 糸)'],
  阝: ['colline (à gauche) ; ville (à droite)'],
  刂: ['couteau (clé réduite de 刀)'],
  忄: ['cœur, sentiment (clé réduite de 心)'],
  '⺼': ['chair, corps (clé réduite de 肉)'],
  钅: ['métal (clé réduite de 金)'],
  犭: ['chien, animal (clé réduite de 犬)'],
  衤: ['vêtement (clé réduite de 衣)'],
  饣: ['nourriture, manger (clé réduite de 食)'],
  礻: ['autel, esprit, culte (clé réduite de 示)'],
  爫: ['griffe, main qui saisit (clé réduite de 爪)'],
  丬: ['planche, lit (clé réduite de 爿)'],
  耂: ['vieillard (forme réduite de 老)'],
  罒: ['filet (clé réduite de 网)'],
  覀: ['couvercle (clé réduite de 襾)'],
  氺: ['eau (forme réduite de 水)'],
  '⺌': ['petit (forme de 小)'],
  '⺍': ['petit (forme de 小)'],
  '⺀': ['(forme : deux points)'],
  '⺊': ['divination (forme de 卜)'],
  '⺈': ['(forme : couteau ou homme penché)'],
  '⺧': ['bœuf (forme réduite de 牛)'],
  '⺗': ['cœur (forme réduite de 心)'],
  镸: ['long (forme réduite de 長)'],
  㔾: ['sceau, personne agenouillée'],
  // composants de forme
  丷: ['(forme : deux traits, « huit » renversé)'],
  乚: ['(forme : crochet)'],
  '𠂉': ['(forme : homme penché)'],
  '𠃌': ['(forme : trait coudé)'],
  '𠂇': ['main gauche (forme ancienne)'],
  丂: ['souffle qui bute'],
  咅: ['crachat ; (composant phonétique)'],
  喿: ['gazouillis d’oiseaux'],
  丩: ['entrelacer'],
  㠯: ['(forme : outil, charrue)'],
  龷: ['(forme : deux mains jointes)'],
  龶: ['(forme : plante, croissance)'],
  臤: ['solide, ferme'],
  畐: ['plein, abondant'],
  昜: ['soleil qui se lève, clarté'],
  尗: ['haricot'],
  皀: ['grain de céréale'],
  敫: ['éclatant, brillant'],
  並: ['côte à côte, ensemble'],
  '𢀖': ['(forme : fils de chaîne d’un métier à tisser, haut de 巠)'],
};

export function radicalFr(c: string): string[] | null {
  const r = RADICAL_FR[c];
  return r ? [...r] : null;
}
