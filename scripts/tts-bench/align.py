#!/usr/bin/env python3
"""CTC forced alignment of Han characters (WeNet WenetSpeech conformer CTC, char vocabulary, via onnxruntime).

Model: https://huggingface.co/csukuangfj/sherpa-onnx-zh-wenet-wenetspeech (model.int8.onnx + tokens.txt).
Used only to cut synthesized audio into per-character (= per-syllable) spans for the tone metric,
and as a cheap second ASR (greedy CTC, no language model) for a secondary CER.

API: Aligner(model_dir).align(samples_16k, text) -> {"spans": [[t0, t1] per Han char], "greedy": str, "score": float}
"""
import re
import numpy as np
import onnxruntime as ort
import kaldi_native_fbank as knf

HAN = re.compile(r"[一-鿿]")
FRAME_S = 0.04  # 4x subsampling of 10 ms frames


class Aligner:
    def __init__(self, model_dir, threads=2):
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(f"{model_dir}/model.int8.onnx", so, providers=["CPUExecutionProvider"])
        self.tok = {}
        self.inv = {}
        for line in open(f"{model_dir}/tokens.txt", encoding="utf-8"):
            p = line.rstrip("\n").rsplit(" ", 1)
            if len(p) == 2:
                self.tok[p[0]] = int(p[1])
                self.inv[int(p[1])] = p[0]
        self.blank = self.tok.get("<blank>", 0)
        self.unk = self.tok.get("<unk>", 1)

    def logprobs(self, x16k):
        opts = knf.FbankOptions()
        opts.frame_opts.dither = 0
        opts.frame_opts.samp_freq = 16000
        opts.frame_opts.snip_edges = True
        opts.mel_opts.num_bins = 80
        fb = knf.OnlineFbank(opts)
        fb.accept_waveform(16000, (np.asarray(x16k, dtype=np.float32) * 32768).tolist())
        fb.input_finished()
        feats = np.stack([fb.get_frame(i) for i in range(fb.num_frames_ready)]).astype(np.float32)
        lp, ln = self.sess.run(None, {"x": feats[None], "x_lens": np.array([feats.shape[0]], dtype=np.int64)})
        return lp[0][: int(ln[0])]

    def greedy(self, lp):
        ids = lp.argmax(-1)
        out, prev = [], -1
        for i in ids:
            if i != prev and i != self.blank:
                out.append(self.inv.get(int(i), ""))
            prev = i
        return "".join(t for t in out if not t.startswith("<")).replace("▁", "")

    def align(self, x16k, text, pad_start=0.3, pad_end=0.6):
        """Short TTS clips often end right after the last syllable; the CTC spike of a character fires near the end of
        its syllable (or after it), so without trailing context the last character is dropped. Pad with silence and
        shift times back by pad_start."""
        chars = HAN.findall(text)
        x16k = np.concatenate([np.zeros(int(16000 * pad_start), np.float32), np.asarray(x16k, np.float32),
                               np.zeros(int(16000 * pad_end), np.float32)])
        lp = self.logprobs(x16k)
        T = lp.shape[0]
        res = {"greedy": self.greedy(lp), "spans": None, "score": None, "frames": T}
        if not chars:
            return res
        labels = [self.tok.get(c, self.unk) for c in chars]
        # CTC Viterbi over the extended label sequence (blank, l1, blank, l2, ..., blank)
        ext = [self.blank]
        for l in labels:
            ext += [l, self.blank]
        S = len(ext)
        if T < len(labels):
            return res
        NEG = -1e30
        dp = np.full((T, S), NEG, dtype=np.float64)
        bp = np.zeros((T, S), dtype=np.int8)
        dp[0, 0] = lp[0, ext[0]]
        dp[0, 1] = lp[0, ext[1]]
        e = np.array(ext)
        allow2 = np.zeros(S, dtype=bool)
        for s in range(2, S):
            allow2[s] = e[s] != self.blank and e[s] != e[s - 2]
        for t in range(1, T):
            p0 = dp[t - 1]
            p1 = np.concatenate([[NEG], p0[:-1]])
            p2 = np.concatenate([[NEG, NEG], p0[:-2]])
            p2 = np.where(allow2, p2, NEG)
            stack = np.stack([p0, p1, p2])
            arg = stack.argmax(0)
            dp[t] = stack[arg, np.arange(S)] + lp[t, e]
            bp[t] = arg
        s = S - 1 if dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
        path = [0] * T
        for t in range(T - 1, -1, -1):
            path[t] = s
            s -= bp[t, s]
        # emission frames of each char (odd states)
        first = [None] * len(chars)
        last = [None] * len(chars)
        for t, st in enumerate(path):
            if st % 2 == 1:
                k = st // 2
                if first[k] is None:
                    first[k] = t
                last[k] = t
        if any(f is None for f in first):
            return res
        # char k spans from its first emission to the next char's first emission; ends of the
        # utterance are refined later by voicing (the analyzer intersects spans with voiced frames).
        sh = pad_start
        spans = []
        for k in range(len(chars)):
            a = first[k] * FRAME_S - sh
            b = first[k + 1] * FRAME_S - sh if k + 1 < len(chars) else (T + 1) * FRAME_S - sh
            spans.append([round(a, 3), round(b, 3)])
        res["spans"] = spans
        res["emit"] = [[round(f * FRAME_S - sh, 3), round(l * FRAME_S - sh, 3)] for f, l in zip(first, last)]
        res["score"] = float(dp[T - 1, path[-1]] / T)
        return res
