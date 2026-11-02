#!/usr/bin/env python3
"""Builds content/catalog/word-video-channels.json from the curated list below + the yt-dlp verification
summary (scripts/summarise-word-video-channels.py --json). Evaluation step for docs/word-videos.md.

    python3 -I scripts/build-word-video-channels.py SUMMARY.json [SEARCH_DIR]

`verified` = the channel listing was fetched with yt-dlp --flat-playlist on the date below and the channel id matched;
`stats` = measured on the listed uploads (most recent 1000, or the full listing when `listingComplete`).
weight ∈ [0,1] = preference used by scripts/lib/word-video-score.mjs (0 = never show).
"""
import json, os, sys, datetime

C = [
    # handle, kind, language, level, weight, notes
    ('choumeizai', 'etymology', 'zh-Hant+en', 'débutant', 0.9,
     "« 漢字的故事 / The Story of Chinese Character : X » — 1 caractère par vidéo, ~1 min, animation de l'évolution (jiaguwen → kaishu). Taïwan : graphies traditionnelles à l'écran, à signaler quand la forme simplifiée diffère."),
    ('moomichinese8384', 'etymology', 'en+zh', 'débutant', 0.8,
     "« Chinese Character Evolution and Strokes 汉字演变+笔画 | X pinyin / sens » — ~40 s, évolution + ordre des traits, pinyin dans le titre (bon pour le score)."),
    ('alittlechineseword', 'etymology', 'zh (CC en)', 'intermédiaire', 0.75,
     "« [CC EN] X (sens) | 汉字趣谈 (Story of Chinese Characters) N » — ~5 min, narration chinoise avec sous-titres anglais ; >400 épisodes numérotés."),
    ('SkritterHQ', 'etymology', 'en', 'débutant', 0.75,
     "« The Origin and Meaning of the Chinese Character X » — série courte (~5 min)."),
    ('EDEO_LEGOOMANDARIN', 'etymology', 'en', 'débutant', 0.7,
     "« Origin of Chinese Characters - NNNN X pinyin sens » — série numérotée (>1000), 5-10 min, flashcards."),
    ('Chinese-learning', 'mixed', 'en', 'débutant', 0.85,
     "Mandarin-learning-Lynn : « Learn Chinese from the origin: X / sens / phrase exemple / HSK1 » — origine du caractère PUIS phrase en contexte : idéal pour le format visé."),
    ('LinlinTong-k8k', 'mixed', 'en', 'débutant', 0.7,
     "Decode Chinese Characters : « Learn the Chinese Character X | Stroke Order, Meaning & Origin Explained » (~2-3 min)."),
    ('HanziWhisper', 'etymology', 'zh+en', 'débutant', 0.65, "Hanzi Whisper 汉字墨语 : « 文字起源（X）The Origin of Chinese Characters: 'sens' » (~2 min)."),
    ('UC3x7FnFPBayEmJenwjJmSgg', 'etymology', 'en+zh', 'débutant', 0.6, "Hotpot Chinese 火锅中文 : « Learning Chinese Character \"X\" | 字源奇说 »."),
    ('owadcn', 'mixed', 'en', 'débutant', 0.6, "OWAD (One Word A Day) : « Water (水 shuǐ) in Chinese and its origin story » — un mot/jour, origine + usages, assez long (5-12 min)."),
    ('keershao318', 'etymology', 'zh+en', 'débutant', 0.5, "Chinese oracle bone inscriptions 图说汉字甲骨文 : ~40 s, forme oraculaire + lecture."),
    ('LitaoChinese', 'etymology', 'en', 'débutant', 0.55, "Learn Chinese with Litao : « What are the origins of Chinese character X & Y? »."),
    ('ShaoLanOfficial', 'etymology', 'en', 'débutant', 0.5, "ShaoLan / Chineasy : mnémotechnique par pictogrammes (pas toujours étymologiquement exact)."),
    ('808CJK', 'etymology', 'en', 'intermédiaire', 0.45, "« X: A Very Short History [808CJK #NNN] » — histoire détaillée, ton savant."),
    ('mandarinchinese8159', 'etymology', 'en+zh', 'débutant', 0.5, "Mandarin Chinese 普通话 : « The Story of Chinese Character X (sens) X字的由来 »."),
    ('MrSmile_181', 'etymology', 'en+zh', 'débutant', 0.45, "MrSmile Chinese Characters : « 【NN】Learn Chinese characters_X丨Origin of Chinese characters » — long (~15 min)."),
    ('user:theforeverastudent', 'etymology', 'en', 'débutant', 0.6,
     "« Understanding Chinese Characters » (UAB « 1001 tools ») : mini-cours façon Khan Academy sur les composants et séries phonétiques."),
    ('yoyotvebc', 'etymology', 'zh-Hant', 'débutant', 0.3, "YOYOTV « 漢字說故事 » (émission jeunesse taïwanaise, traditionnel, chinois seul)."),
    ('UncleHanzi', 'etymology', 'zh-Hant', 'avancé', 0.2, "漢字叔叔講漢字 (Richard Sears, chineseetymology.org) — conférences en chinois, rarement 1 caractère/vidéo."),
    ('ChineseCharacters', 'word', 'zh/en (narration non vérifiée)', 'débutant', 0.3,
     "« Chinese character X (pinyin, sens) [with stroke order and pronunciation] », « 汉字[X] », « 汉字[X]的笔顺 » — clips de 9-32 s (98 % < 60 s) : couverture énorme (542 des 1 000 premiers caractères dans les 1 000 dernières vidéos) mais pas d'explication d'origine vérifiée → repli seulement."),
    ('studyincla', 'mixed', 'en+zh+yue', 'débutant', 0.1,
     "Yale-China Chinese Language Academy (CUHK). Le projet TDG « Understanding Chinese Characters through Videos and Online Exercises » (10 vidéos Putonghua + 10 cantonais, 200 caractères HSK) devait être publié ici, mais **aucune de ces vidéos n'apparaît** parmi les 153 vidéos publiques ni dans les 31 playlists (vérifié le 2026-11-02 ; seule une série « 十二生肖 »). Gardé pour mémoire."),
    # word / usage
    ('MandarinChinesewithTaskpins', 'word', 'en+zh', 'débutant', 0.9,
     "« Pinyin X - Chinese Word of the Day 每日一词 » — un mot par vidéo (~2-3 min), sens + exemples en contexte."),
    ('trainchinese', 'word', 'en', 'débutant', 0.8,
     "« How to write X (pinyin) – sens – stroke order, radical, examples and spoken audio » (~1 min) — couverture très large (caractères HSK), exemples audio."),
    ('EsChineseClass', 'word', 'en+zh', 'débutant', 0.75,
     "« 【NEW HSK1】 X/pinyin/(sens) How to Pronounce & Write Chinese Vocabulary » (~1-2 min), mots HSK 3.0."),
    ('hanzikite', 'word', 'en', 'débutant', 0.7, "Hanzi Kite : « How to write | X (pinyin) | Stroke Order, Vocabulary, Example Sentences | HSK 1 » (~4 min)."),
    ('hsktips', 'word', 'en+zh', 'débutant', 0.6,
     "« Chinese HSK N vocabulary X (pinyin), ex.K » — ~30 s par PHRASE d'exemple (plusieurs par mot) : parfait pour « le mot en contexte », pas d'explication."),
    ('learnchineseonyoutube2685', 'word', 'en', 'débutant', 0.5, "« pinyin ( X ) - English meaning, Chinese ideograms and pronunciation » (~35 s)."),
    ('HskAcademy', 'word', 'en', 'débutant', 0.3, "« Pronunciation, strokes writing and meaning of X (pinyin: sens) » (~40 s)."),
    ('DANLIAOFreeToLearnChinese', 'word', 'en+zh', 'intermédiaire', 0.5,
     "每日中文课 : « How to use:【X pinyin】… | HSK N Vocab | NNNN » (~9 min) ; la chaîne publie aussi des compilations de 1-2 h (filtrées par la durée)."),
    ('JingleChinese', 'mixed', 'en+zh', 'débutant', 0.45, "« Learn to say and write Chinese character \"X/sens\" | 字的读音，意思，字源故事 » (~3 min)."),
    # French
    ('shuohanyu8377', 'etymology', 'fr+en', 'débutant', 0.75, "Shuo Han Yu : « Etymologie du caractère chinois X / Etymology of the Chinese character X » (~40 s) — FR."),
    ('chinois150mots4', 'mixed', 'fr', 'débutant', 0.65, "Chinois 150mots : « Apprendre le chinois - X (pinyin) sens » — FR."),
    ('parfumsdubois', 'etymology', 'fr', 'débutant', 0.4, "Tia Gao : « Apprendre le chinois : découvrez le caractère X (pinyin) » (~45 s) — FR."),
    ('Chineeze-Apprendrelechinois', 'mixed', 'fr', 'débutant', 0.6, "Chineeze : « Sens X (Mémoriser les caractères chinois) » — mnémotechnique, FR."),
    ('jojochinois7095', 'etymology', 'fr', 'débutant', 0.3, "Jojo Chinois : « Un caractère par jour N X » — FR, mais seulement 5 vidéos en ligne."),
    ('ginkgoacademy5871', 'etymology', 'fr', 'débutant', 0.45, "Ginkgo Academy : « L'origine des caractères chinois - X Y Z (vocabulaire HSK 1) » — plusieurs caractères par vidéo, FR."),
    ('HanziKid', 'etymology', 'zh', 'débutant', 0.5, "一起画汉字 HanziKid : « 1分钟，一起画汉字：“X” » — dessin du pictogramme pour enfants (~1 min), chinois seul, 380 vidéos."),
    ('ChineseInMinutes', 'mixed', 'en+zh', 'débutant', 0.35, "Chinese In Minutes : « Chinese Character X (pinyin) Explained No.N | … Vocabulary » + histoires lentes ; titres souvent des phrases."),
    ('ChineseCharacters3000', 'mixed', 'en', 'débutant', 0.45, "Chinese Characters 3000 : « The Chinese Radical “X” and Connected Vocabulary » (~5 min)."),
    ('FiveADayKanji', 'etymology', 'en (kanji)', 'débutant', 0.2, "FiveADay Kanji : chaîne de **kanji japonais** (quiz « KANJI LINK »), quelques titres avec pinyin ; à n'utiliser qu'en dernier repli."),
    ('chinoisauthentique', 'etymology', 'fr+en', 'débutant', 0.45, "Chinois Authentique : « Quickly memorize Chinese characters #N : X Y Z » — plusieurs caractères par vidéo."),
    ('weilicalligraphie', 'etymology', 'fr', 'débutant', 0.45, "« Calligraphie chinoise un caractère par jour n°N X » — **plus grande série francophone par caractère** (> 1 500 épisodes) ; calligraphie plus qu'étymologie, narration non vérifiée."),
    ('Apprendrelechinoisenvideo', 'word', 'fr+en', 'débutant', 0.5, "« Chinese Character #N X pinyin \"sens\" | HSK 1 »."),
]


def main():
    summ = {r['key']: r for r in json.load(open(sys.argv[1], encoding='utf-8'))}
    today = datetime.date.today().isoformat()
    out = []
    for key, kind, lang, level, weight, notes in C:
        k = key.split(':', 1)[1] if key.startswith('user:') else key
        s = summ.get(k)
        if key.startswith('UC'):
            url = f'https://www.youtube.com/channel/{key}'
        elif key.startswith('user:'):
            url = f'https://www.youtube.com/user/{k}'
        else:
            url = f'https://www.youtube.com/@{key}'
        cid = (s or {}).get('channelId')
        if cid and not str(cid).startswith('UC'):
            cid = None
        ok = bool(s and s['listed'] > 0 and cid)
        row = {
            'name': (s or {}).get('name') or k,
            'url': url,
            **({'channelId': cid} if cid else {}),
            'language': lang, 'kind': kind, 'level': level, 'weight': weight, 'notes': notes,
            'verified': ok,
        }
        if ok:
            row['stats'] = {'checked': today, 'uploadsListed': s['listed'], 'medianDurationSec': s['medianDur'],
                            'shortsShare': s['shorts'], 'perCharTitleShare': s['perCharTitles'],
                            'top300WordsInTitles': s['cov300'], 'top1000WordsInTitles': s['cov1000'],
                            'top300CharsInTitles': s.get('chars300'), 'top1000CharsInTitles': s.get('chars1000'),
                            # full listing (MAX 6000) or fewer uploads than the 1000 cap → complete
                            'listingComplete': bool(s.get('full')) or s['listed'] < 1000}
        out.append(row)
    out.sort(key=lambda r: (-r['weight'], r['name']))
    dst = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'content/catalog/word-video-channels.json')
    json.dump(out, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f"{len(out)} channels, {sum(r['verified'] for r in out)} verified → {dst}")


if __name__ == '__main__':
    main()
