import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanTokens,
  expectedAnswers,
  keyPoints,
  lessonOrder,
  matchesAnswer,
  pickDistractors,
  reviewGrade,
  selectExercises,
  shuffleTiles,
  normZh,
} from '../src/core/grammar';
import { normZh as nlpNormZh } from '../src/core/nlp';
import { composition, isQuizzable, makeMcq, pickSentenceDistractors, pickWordDistractors, scoreItems, shortGloss, skillAdvice } from '../src/core/exam';
import type { GrammarExercise, GrammarPoint, Word } from '../src/shared/types';
import { Db, initSql } from '../src/core/db';
import { Srs } from '../src/core/srs';
import { Curriculum } from '../src/core/curriculum';
import { Content } from '../src/core/content';

function rng(seed = 42) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ex = {
  order: (a: string): GrammarExercise => ({ type: 'order', tokens: [...a], answer: a, fr: 'x' }),
  cloze: (): GrammarExercise => ({ type: 'cloze', zh: '我___学生。', options: ['是', '在', '有'], answer: '是', fr: 'Je suis étudiant.' }),
  translate: (a: string): GrammarExercise => ({ type: 'translate', fr: 'x', answers: [a] }),
  choice: (): GrammarExercise => ({ type: 'choice', question: '?', options: ['a', 'b'], answer: 1 }),
};

describe('reviewGrade (résultats → note FSRS)', () => {
  it('tout juste et rapide avec ≥4 exercices → Facile', () => {
    expect(reviewGrade([true, true, true, true], 4 * 10_000)).toBe(4);
  });
  it('tout juste mais lent, ou moins de 4 exercices → Bien', () => {
    expect(reviewGrade([true, true, true, true], 4 * 60_000)).toBe(3);
    expect(reviewGrade([true, true, true], 3_000)).toBe(3);
    expect(reviewGrade([true, true, true, true], 0)).toBe(3);
  });
  it('une erreur → Difficile', () => {
    expect(reviewGrade([true, false, true, true], 1000)).toBe(2);
    expect(reviewGrade([true, true, true, true, true, true, true, true, true, false], 1000)).toBe(2);
  });
  it('≥2 erreurs ou >40 % faux → À revoir', () => {
    expect(reviewGrade([false, false, true, true], 1000)).toBe(1);
    expect(reviewGrade([true, false], 1000)).toBe(1); // 50 % faux
    expect(reviewGrade([], 0)).toBe(1);
  });
});

describe('selectExercises (exercices non vus récemment, types mélangés)', () => {
  const pool: GrammarExercise[] = [ex.order('我是'), ex.order('他是'), ex.cloze(), ex.cloze(), ex.translate('我是学生。'), ex.translate('他是老师。'), ex.choice(), ex.choice()];
  it('renvoie n indices distincts', () => {
    const s = selectExercises(pool, new Map(), 4, { rng: rng() });
    expect(s).toHaveLength(4);
    expect(new Set(s).size).toBe(4);
  });
  it('mélange les types', () => {
    const s = selectExercises(pool, new Map(), 4, { rng: rng(7) });
    expect(new Set(s.map((i) => pool[i].type)).size).toBe(4);
  });
  it('évite les exercices vus lors des dernières révisions', () => {
    const seen = new Map<number, number>();
    for (let round = 0; round < 2; round++) {
      const s = selectExercises(pool, seen, 4, { rng: rng(round + 1) });
      for (const i of s) expect(seen.has(i)).toBe(false);
      for (const i of s) seen.set(i, 1000 + round);
    }
    // all seen now: the least recently seen batch comes back first
    const third = selectExercises(pool, seen, 4, { rng: rng(9) });
    for (const i of third) expect(seen.get(i)).toBe(1000);
  });
  it('gère n ≥ taille du pool et le filtre de types', () => {
    expect(selectExercises(pool, new Map(), 50).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const onlyChoice = selectExercises(pool, new Map(), 5, { types: ['choice'] });
    expect(onlyChoice.sort()).toEqual([6, 7]);
    expect(selectExercises([], new Map(), 4)).toEqual([]);
  });
  it('ordre de leçon : reconnaissance puis production', () => {
    const o = lessonOrder([ex.translate('a'), ex.order('ab'), ex.choice(), ex.cloze()]).map((e) => e.type);
    expect(o).toEqual(['choice', 'cloze', 'order', 'translate']);
  });
});

describe('réponses et tuiles', () => {
  it('normZh identique à celui de core/nlp', () => {
    for (const t of ['我是学生。', ' 你好，世界！', '“他”说：（好）《书》…—', 'a, b. c? d! e; f: "g" \'h\' (i) j-k']) expect(normZh(t)).toBe(nlpNormZh(t));
  });
  it('compare sans ponctuation ni espaces', () => {
    expect(matchesAnswer('我没有书', ['我没有书。'])).toBe(true);
    expect(matchesAnswer(' 我 没有 书 ！', ['我没有书。'])).toBe(true);
    expect(matchesAnswer('我不有书', ['我没有书。'])).toBe(false);
    expect(matchesAnswer('', ['。'])).toBe(false);
  });
  it('réponses attendues par type', () => {
    expect(expectedAnswers(ex.cloze())).toEqual(['我是学生。']);
    expect(expectedAnswers({ type: 'order', tokens: ['我', '是'], answer: '我是', fr: '', answers: ['是我'] } as GrammarExercise)).toEqual(['我是', '是我']);
    expect(expectedAnswers(ex.choice())).toEqual([]);
  });
  it('distracteurs : mots de la phrase fautive d\'abord, jamais un mot de la réponse', () => {
    const d = pickDistractors({ answerTokens: ['我', '没有', '书'], sourceTokens: ['我', '不', '有', '书'], pool: ['是', '的'], n: 3, rng: rng() });
    expect(d).toHaveLength(3);
    expect(d).toContain('不');
    for (const t of d) expect(['我', '没有', '书']).not.toContain(t);
    expect(new Set(d).size).toBe(3);
  });
  it('distracteurs : repli sur les mots grammaticaux', () => {
    const d = pickDistractors({ answerTokens: ['他', '是', '老师'], n: 2, rng: rng(3) });
    expect(d).toHaveLength(2);
    for (const t of d) expect(['他', '是', '老师']).not.toContain(t);
  });
  it('tuiles mélangées, jamais dans l\'ordre de la solution', () => {
    for (let k = 0; k < 20; k++) {
      const t = shuffleTiles(['我', '是', '学生'], rng(k));
      expect([...t].sort()).toEqual(['学生', '我', '是'].sort());
      expect(t.join('')).not.toBe('我是学生');
    }
    expect(cleanTokens(['我', '，', ' ', '好', '。'])).toEqual(['我', '好']);
  });
  it('À retenir : phrases contenant du gras', () => {
    const k = keyPoints('Intro sans gras.\n\n**Le verbe ne se conjugue jamais.** Il n\'y a ni temps ni personnes.\n\n- Piège : **le pronom** reste après le verbe.');
    expect(k[0]).toBe('**Le verbe ne se conjugue jamais.**');
    expect(k[1]).toContain('**le pronom**');
    expect(k).toHaveLength(2);
  });
});

const W = (w: string, fr: string[], pos: string[], pn: string, rank: number): Word => ({ w, py: '', pn, fr, en: [], band: 1, old: 1, freq: 1, pos, cl: [], rank });

describe('examens', () => {
  const target = W('苹果', ['pomme'], ['n'], 'ping2 guo3', 300);
  const pool = [
    W('香蕉', ['banane'], ['n'], 'xiang1 jiao1', 310),
    W('米饭', ['riz cuit'], ['n'], 'mi3 fan4', 320),
    W('吃', ['manger'], ['v'], 'chi1', 20),
    W('苹果', ['pomme'], ['n'], 'ping2 guo3', 300),
    W('平果', ['pomme (variante)'], ['n'], 'ping2 guo3', 900), // homophone
    W('果子', ['pomme', 'fruit'], ['n'], 'guo3 zi5', 800), // même sens
    W('的', ['(particule)'], ['u'], 'de5', 0), // non lexical
    W('桌子', ['table'], ['n'], 'zhuo1 zi5', 330),
  ];
  it('distracteurs : même catégorie, pas de synonyme, pas d\'homophone à l\'écoute', () => {
    const d = pickWordDistractors(target, pool, 3, { rng: rng(), listening: true });
    expect(d).toHaveLength(3);
    const ws = d.map((x) => x.w);
    expect(ws).not.toContain('苹果');
    expect(ws).not.toContain('平果');
    expect(ws).not.toContain('果子');
    expect(ws).not.toContain('的');
    expect(ws).toEqual(expect.arrayContaining(['香蕉', '米饭', '桌子']));
  });
  it('gloses courtes et mots interrogeables', () => {
    expect(shortGloss(['(utilisé après un verbe)', 'fois'])).toBe('fois');
    expect(shortGloss(['maison', 'famille'])).toBe('maison ; famille');
    expect(isQuizzable(pool[6])).toBe(false);
    expect(isQuizzable(target)).toBe(true);
  });
  it('QCM : la bonne réponse est à l\'index annoncé', () => {
    for (let k = 0; k < 10; k++) {
      const m = makeMcq('pomme', ['banane', 'riz', 'table'], rng(k));
      expect(m.options).toHaveLength(4);
      expect(m.options[m.answer]).toBe('pomme');
    }
  });
  it('distracteurs de phrases : distincts et différents de la bonne traduction', () => {
    const d = pickSentenceDistractors('Je bois du thé.', ['Je bois du thé !', 'Il mange du riz.', 'Il mange du riz.', 'Nous regardons un film.', 'Où est la gare ?'], 3, rng());
    expect(d).toHaveLength(3);
    expect(new Set(d).size).toBe(3);
    expect(d).not.toContain('Je bois du thé !');
  });
  it('composition : ~25 questions (hebdo), ~40 (blanc), selon la matière disponible', () => {
    const w = composition('weekly', { words: 100, sentences: 5, grammar: 99 });
    expect(w.wordListen + w.wordRead + w.sentences + w.grammar).toBe(25);
    const m = composition('mock', { words: 300, sentences: 10, grammar: 99 });
    expect(m.wordListen + m.wordRead + m.sentences + m.grammar).toBe(40);
    const few = composition('weekly', { words: 3, sentences: 0, grammar: 0 });
    expect(few).toEqual({ wordListen: 3, wordRead: 3, sentences: 0, grammar: 0 });
  });
  it('score par compétence et recommandations', () => {
    const r = scoreItems([
      { skill: 'listening', correct: true },
      { skill: 'listening', correct: false },
      { skill: 'grammar', correct: true },
      { skill: 'reading', correct: true },
    ]);
    expect(r.score).toBe(0.75);
    expect(r.bySkill.listening).toEqual({ n: 2, ok: 1, score: 0.5 });
    expect(skillAdvice('listening', 0.5)).toMatch(/priorité/);
    expect(skillAdvice('grammar', 0.95)).toMatch(/solide/);
  });
});

// ---------- mastery gate on a real (in-memory) database ----------
describe('déblocage de la grammaire (gate 80 %)', () => {
  const mk = (id: string): GrammarPoint => ({ id, phase: 1, title: id, pattern: 'A', hsk: 1, explanation: '', examples: [], exercises: [ex.cloze()] });
  async function setup() {
    const SQL = await initSql(path.join(__dirname, '../node_modules/sql.js/dist'));
    const db = new Db(SQL, null);
    const content = new Content('', '');
    content.grammar = [mk('p1-01'), mk('p1-02'), mk('p1-03')];
    content.grammarMap = new Map(content.grammar.map((g) => [g.id, g]));
    const srs = new Srs(db);
    return { db, srs, cur: new Curriculum(db, content, srs) };
  }
  it('premier point disponible, les suivants verrouillés', async () => {
    const { cur } = await setup();
    expect(cur.grammarStatus().map((g) => g.state)).toEqual(['available', 'locked', 'locked']);
  });
  it('< 60 % : leçon non validée, pas de carte FSRS', async () => {
    const { cur, srs } = await setup();
    cur.completeGrammarLesson('p1-01', 0.5);
    const s = cur.grammarStatus();
    expect(s[0].state).toBe('available');
    expect(s[0].bestScore).toBe(0.5);
    expect(s[1].state).toBe('locked');
    expect(srs.getCard('grammar:rule:p1-01')).toBeUndefined();
  });
  it('60-80 % : en cours (carte FSRS) mais le suivant reste verrouillé ; ≥ 80 % le débloque', async () => {
    const { cur, srs } = await setup();
    cur.completeGrammarLesson('p1-01', 0.7);
    let s = cur.grammarStatus();
    expect(s[0].state).toBe('learning');
    expect(s[1].state).toBe('locked');
    expect(srs.getCard('grammar:rule:p1-01')?.state).toBeGreaterThan(0);
    cur.completeGrammarLesson('p1-01', 0.8);
    s = cur.grammarStatus();
    expect(s[0].bestScore).toBe(0.8);
    expect(s[1].state).toBe('available');
    expect(s[2].state).toBe('locked');
  });
  it('un mauvais nouvel essai ne fait pas baisser le meilleur score', async () => {
    const { cur } = await setup();
    cur.completeGrammarLesson('p1-01', 0.9);
    cur.completeGrammarLesson('p1-01', 0.3);
    const s = cur.grammarStatus();
    expect(s[0].bestScore).toBe(0.9);
    expect(s[1].state).toBe('available');
  });
});

// ---------- content contract (content/grammar/SCHEMA.md) ----------
describe('contenu de grammaire valide', () => {
  const dir = path.join(__dirname, '../content/grammar');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^phase\d+\.json$/.test(f)) : [];
  for (const f of files) {
    it(f, () => {
      const pts = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as GrammarPoint[];
      const ids = new Set<string>();
      for (const p of pts) {
        expect(ids.has(p.id), `id dupliqué ${p.id}`).toBe(false);
        ids.add(p.id);
        expect(p.exercises.length, p.id).toBeGreaterThan(0);
        for (const e of p.exercises) {
          const where = `${p.id} ${e.type}`;
          if (e.type === 'order') expect(e.tokens.join(''), where).toBe(e.answer);
          if (e.type === 'cloze') {
            expect(e.zh.split('___').length, where).toBe(2);
            expect(e.options, where).toContain(e.answer);
          }
          if (e.type === 'choice' || e.type === 'listen') expect(e.answer >= 0 && e.answer < e.options.length, where).toBe(true);
          if (e.type === 'transform' || e.type === 'error' || e.type === 'translate') expect(e.answers.length, where).toBeGreaterThan(0);
        }
      }
    });
  }
});
