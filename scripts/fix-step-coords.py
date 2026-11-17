#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""修复 v4 会话日志里「turn/step 坐标错乱」的问题。

典型病灶（dsh-session-format-v3-to-v4 Relationships.accept:759）：
  step/start 的 step 必须等于 nextStep。宿主在一次 step 被中断/结束后重跑该 step 时，
  会把 step 号**重复**写一遍（同一 turn 里出现两个 step/start{step:1}），
  读回来就抛：
      SessionFormatError: step/start does not match the open turn and next step

修法：按状态机重放，遇到 step/start 的 step 号不连续时，把它及它这一段
（到配对的 step/end 为止）里的 turn/step 坐标整体改写成状态机认可的编号。
只动坐标数字，不动任何消息内容与顺序。

用法:
  python fix-step-coords.py <会话目录|session.v4.jsonl.zstd> [...] [--out DIR] [--apply]
"""
import io
import json
import os
import shutil
import sys
import time

import zstandard as zstd

PARAMS = zstd.ZstdCompressionParameters.from_level(3, write_checksum=1, write_content_size=0, window_log=21)
CCTX = zstd.ZstdCompressor(compression_params=PARAMS)


def split_frames(buf):
    out, pos = [], 0
    while pos < len(buf):
        o = zstd.ZstdDecompressor().decompressobj()
        plain = o.decompress(buf[pos:])
        used = len(buf) - pos - len(o.unused_data)
        out.append((buf[pos:pos + used], plain))
        if used <= 0:
            break
        pos += used
    return out


def load(path):
    frames = split_frames(open(path, "rb").read())
    lines = []
    for _, plain in frames:
        for ln in plain.decode("utf-8", "replace").split("\n"):
            if ln.strip():
                lines.append(ln)
    return lines


def analyze(events):
    """重放状态机，返回需要改写的段：[(start_idx, end_idx, old_step, new_step)]"""
    turn = None
    next_turn = 1
    step = None
    next_step = 1
    segments = []
    for i, ev in enumerate(events):
        t = ev.get("type")
        d = ev.get("data") or {}
        if t == "turn/start":
            turn = next_turn
            next_step = 1
        elif t == "turn/end":
            turn = None
            next_turn += 1
        elif t == "step/start":
            old = d.get("step")
            if step is None and turn is not None and d.get("turn") == turn and old != next_step:
                # 找配对的 step/end（同 turn、同旧编号）
                j = i
                while j < len(events):
                    e2 = events[j]
                    d2 = e2.get("data") or {}
                    if e2.get("type") == "step/end" and d2.get("turn") == turn and d2.get("step") == old:
                        break
                    j += 1
                segments.append((i, min(j, len(events) - 1), turn, old, next_step))
            step = next_step
        elif t == "step/end":
            step = None
            next_step += 1
    return segments


def main():
    args = [a for a in sys.argv[1:]]
    apply = "--apply" in args
    out_dir = None
    if "--out" in args:
        out_dir = args[args.index("--out") + 1]
    targets = [a for a in args if not a.startswith("--") and a != out_dir]
    files = []
    for t in targets:
        if os.path.isdir(t):
            f = os.path.join(t, "session.v4.jsonl.zstd")
            if os.path.isfile(f):
                files.append(f)
        elif os.path.isfile(t):
            files.append(t)
    if not files:
        print("用法: python fix-step-coords.py <会话目录|文件> [...] [--out DIR] [--apply]")
        return 2
    out_dir = out_dir or os.path.dirname(os.path.abspath(files[0]))
    os.makedirs(out_dir, exist_ok=True)

    for path in files:
        name = os.path.basename(os.path.dirname(path))
        lines = load(path)
        events = [json.loads(ln) for ln in lines]
        segs = analyze(events)
        if not segs:
            print("%-46s ok       turn/step 坐标本来就连续" % name)
            continue
        changed = 0
        for (a, b, tno, old, new) in segs:
            for k in range(a, b + 1):
                d = events[k].get("data") or {}
                if d.get("turn") == tno and d.get("step") == old:
                    d["step"] = new
                    lines[k] = json.dumps(events[k], ensure_ascii=False, separators=(",", ":"))
                    changed += 1
            print("     seg idx %d..%d turn=%s step %s→%s（%d 条事件）" % (a, b, tno, old, new, changed))
        left = analyze(events)
        print("%-46s %-9s 改 %d 条，剩余异常段 %d" % (name, "rewritten", changed, len(left)))
        if left:
            print("     !! 还有异常段，不写")
            continue
        blob = io.BytesIO()
        for ln in lines:
            blob.write(CCTX.compress((ln + "\n").encode("utf-8")))
        blob = blob.getvalue()
        base = os.path.join(out_dir, name + ".stepfix")
        open(base + ".jsonl", "wb").write(("\n".join(lines) + "\n").encode("utf-8"))
        open(base + ".zstd", "wb").write(blob)
        print("     candidate: %s.zstd" % base)
        if apply:
            bak = path + ".bak-stepfix-" + time.strftime("%Y%m%d-%H%M%S")
            shutil.copy2(path, bak)
            tmp = path + ".tmp-repair"
            open(tmp, "wb").write(blob)
            n = len([1 for _, p in split_frames(open(tmp, "rb").read())
                     for ln in p.decode("utf-8", "replace").split("\n") if ln.strip()])
            if n != len(lines):
                os.remove(tmp)
                print("     !! 回读行数不符 %d vs %d，中止" % (n, len(lines)))
                continue
            os.replace(tmp, path)
            print("     installed, backup: %s" % os.path.basename(bak))
    return 0


if __name__ == "__main__":
    sys.exit(main())
