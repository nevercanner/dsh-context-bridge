#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""修复「surface 头部不是 system/message」的 v4 会话日志。

病灶（dsh-session-format-v3-to-v4/lib/index.js:599）：
  foldSurface 只允许 system/message 成为受保护的首个 surface 节点。
  dsh-context-bridge 过去把交接文档当 seed（user/message, surfaceOp=append）
  写成了本地第一个 surface 事件，于是后面第一条 system/message 一进来就抛
  SessionFormatError: system/message requires a protected first surface head。

修法：删掉 system/message 之前的那几个 surface 事件，整体重排 seq（v4 要求
seq == 数组下标），并把所有事件坐标引用（surfaceOp.startSeq/endSeq、
sourceEventSeqs、data.headerSeq、session/title 的 messageSeqs…）同步重写。
被删的交接文档如果还有一条同内容的 user/message 在 surface 上（inbox 投递的
那一份），引用就重指过去；没有就丢掉该引用。

用法:
  python fix-surface-head.py <会话目录|session.v4.jsonl.zstd> [--out DIR] [--apply]
"""
import io
import json
import os
import shutil
import sys
import time

import zstandard as zstd

SURFACE_TYPES = {"system/message", "user/message", "developer/message",
                 "assistant/message", "tool/result"}
SEQ_LIST_KEYS = {"messageseqs", "shadowedseqs", "sourceeventseqs"}


def split_frames(buf):
    out, pos = [], 0
    while pos < len(buf):
        obj = zstd.ZstdDecompressor().decompressobj()
        try:
            plain = obj.decompress(buf[pos:])
        except Exception as e:
            raise SystemExit("frame decode failed at byte %d: %s" % (pos, e))
        used = len(buf) - pos - len(obj.unused_data)
        if used <= 0:
            break
        out.append((buf[pos:pos + used], plain))
        pos += used
    return out


def load(path):
    frames = split_frames(open(path, "rb").read())
    header_raw, header_plain = frames[0]
    header = json.loads(header_plain.decode("utf-8", "replace").strip())
    events = []
    for _, plain in frames[1:]:
        for ln in plain.decode("utf-8", "replace").split("\n"):
            if ln.strip():
                events.append(json.loads(ln))
    return header_raw, header, events


def fold_error(events):
    surface, protected = [], None
    for ev in events:
        t = ev.get("type")
        if t not in SURFACE_TYPES:
            continue
        if t == "system/message" and surface and protected is None:
            return "system/message requires a protected first surface head (seq %s)" % ev.get("seq")
        op = ev.get("surfaceOp")
        if op == "append":
            if t == "system/message" and not surface:
                protected = ev.get("seq")
            surface.append(ev.get("seq"))
        elif not isinstance(op, dict):
            return "%s surfaceOp is not an object (seq %s)" % (t, ev.get("seq"))
        else:
            s, e = op.get("startSeq"), op.get("endSeq")
            try:
                first = surface.index(s)
                last = surface.index(e)
            except ValueError:
                return "%s replacement range not on surface (seq %s)" % (t, ev.get("seq"))
            if last < first:
                return "%s replacement range inverted (seq %s)" % (t, ev.get("seq"))
            removed = surface[first:last + 1]
            sources = ev.get("sourceEventSeqs") or []
            miss = [x for x in removed if x not in sources]
            if miss:
                return "%s sourceEventSeqs omit shadowed node %s (seq %s)" % (t, miss[0], ev.get("seq"))
            if protected is not None and protected in removed:
                if t != "system/message" or len(removed) != 1:
                    return "surface replacement shadows protected head (seq %s)" % ev.get("seq")
                protected = ev.get("seq")
            surface[first:first + len(removed)] = [ev.get("seq")]
    return None


def remap(obj, mapping, skip=()):
    """重写事件坐标。mapping[old] = new 或 None（表示该事件被删，引用应丢弃）。"""
    drop = False
    if isinstance(obj, dict):
        for k in list(obj.keys()):
            if k in skip:
                continue
            v = obj[k]
            lk = k.lower()
            is_key = lk.endswith("seq") or lk in SEQ_LIST_KEYS
            if is_key and isinstance(v, int) and not isinstance(v, bool):
                if v in mapping:
                    new = mapping[v]
                    if new is None:
                        del obj[k]
                    else:
                        obj[k] = new
            elif is_key and isinstance(v, list) and all(isinstance(x, int) for x in v):
                out = []
                for x in v:
                    if x in mapping:
                        nx = mapping[x]
                        if nx is None:
                            continue
                        out.append(nx)
                    else:
                        out.append(x)
                obj[k] = out
            else:
                remap(v, mapping)
    elif isinstance(obj, list):
        for v in obj:
            remap(v, mapping)
    return drop


def key_of(ev):
    return json.dumps(ev.get("data", {}).get("content"), ensure_ascii=False, sort_keys=True)


def repair(path, out_dir, apply):
    name = os.path.basename(os.path.dirname(path)) or os.path.basename(path)
    header_raw, header, events = load(path)
    if not events or any(ev.get("seq") != i for i, ev in enumerate(events)):
        return dict(name=name, path=path, status="skip", detail="seq 不连续，不敢动")
    before = fold_error(events)
    first_sys = next((i for i, ev in enumerate(events) if ev.get("type") == "system/message"), None)
    force = "--force" in sys.argv
    latent = (force and first_sys is None and events
              and events[0].get("type") in SURFACE_TYPES)
    if before is None and not latent:
        return dict(name=name, path=path, status="ok", detail="surface 头部正常")
    before = before or "latent: 首个 surface 节点是 %s@0，等第一条 system/message 就会炸" % events[0].get("type")

    if first_sys is None:
        if not force:
            return dict(name=name, path=path, status="latent",
                        detail="还没有 system/message（模型一轮都没跑过）；加 --force 预修")
        risky = [i for i, ev in enumerate(events)
                 if ev.get("type") in ("assistant/message", "tool/result")]
        if risky:
            return dict(name=name, path=path, status="skip",
                        detail="没有 system/message 但有 assistant/tool 事件，不敢预修")
        drop_idx = [i for i, ev in enumerate(events) if ev.get("type") in SURFACE_TYPES]
    else:
        drop_idx = [i for i in range(first_sys) if events[i].get("type") in SURFACE_TYPES]
    if not drop_idx:
        return dict(name=name, path=path, status="skip", detail="首个 surface 已是 system/message，但仍有别的折叠错误：" + before)

    kept = [ev for i, ev in enumerate(events) if i not in drop_idx]
    new_of_old = {}
    for i in range(len(events)):
        if i in drop_idx:
            new_of_old[i] = None
        else:
            new_of_old[i] = i - sum(1 for d in drop_idx if d < i)

    # 被删事件若有同内容幸存者，引用重指过去
    for d in drop_idx:
        dead = events[d]
        if dead.get("type") != "user/message":
            continue
        k = key_of(dead)
        for j, ev in enumerate(kept):
            if ev.get("type") == "user/message" and key_of(ev) == k:
                new_of_old[d] = j
                break

    for i, ev in enumerate(kept):
        ev["seq"] = i
        remap(ev, new_of_old, skip=("seq",))

    # session/title 的规则：source.kind == "user" 时 messageSeqs 必须为空，反之必须非空。
    # 引用的那条 seed 被删掉后引用会变空，此时把来源标成 user（标题本来就是从用户
    # 那条交接文档里截出来的），避免整条日志卡在 "messageSeqs must be empty exactly
    # for a user title"。
    for ev in kept:
        if ev.get("type") != "session/title":
            continue
        data = ev.get("data") or {}
        src = data.get("source") if isinstance(data.get("source"), dict) else None
        if src is not None and data.get("messageSeqs") == [] and src.get("kind") != "user":
            src["kind"] = "user"
            print("     note: seq %s 标题引用已空，source.kind 标为 user" % ev.get("seq"))

    after = fold_error(kept)
    cut = 0
    for ev in kept:
        if ev.get("type") == "session/end-seed" and (ev.get("data") or {}).get("inherited") is True:
            cut = ev["seq"]

    blob = io.BytesIO()
    blob.write(header_raw)
    cctx = zstd.ZstdCompressor()
    for ev in kept:
        blob.write(cctx.compress((json.dumps(ev, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")))
    blob = blob.getvalue()

    base = os.path.join(out_dir, name)
    cand_z = base + ".candidate.zstd"
    cand_j = base + ".candidate.jsonl"
    open(cand_z, "wb").write(blob)
    plain = io.BytesIO()
    for _, p in split_frames(blob):
        plain.write(p)
    open(cand_j, "wb").write(plain.getvalue())

    info = dict(name=name, path=path, status="candidate", detail=after or "fold OK",
                dropped=len(drop_idx), events=len(kept), cut=cut,
                candidate_z=cand_z, candidate_j=cand_j, before=before)
    if after is not None:
        info["status"] = "fail"
        return info

    if apply:
        bak = path + ".bak-headfix-" + time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, bak)
        tmp = path + ".tmp-repair"
        open(tmp, "wb").write(blob)
        back = split_frames(open(tmp, "rb").read())
        n = sum(1 for _, p in back[1:] for ln in p.decode("utf-8", "replace").split("\n") if ln.strip())
        if n != len(kept):
            os.remove(tmp)
            info["status"] = "fail"
            info["detail"] = "回读行数不符 %d vs %d" % (n, len(kept))
            return info
        os.replace(tmp, path)
        info["backup"] = bak
        info["status"] = "installed"
    return info


def main():
    args = [a for a in sys.argv[1:]]
    apply = "--apply" in args
    out_dir = None
    if "--out" in args:
        out_dir = args[args.index("--out") + 1]
    targets = [a for a in args if not a.startswith("--") and a != out_dir]
    if not targets:
        print("用法: python fix-surface-head.py <文件|目录> [...] [--out DIR] [--apply]")
        return 2
    files = []
    for t in targets:
        if os.path.isdir(t):
            f = os.path.join(t, "session.v4.jsonl.zstd")
            if os.path.isfile(f):
                files.append(f)
        elif os.path.isfile(t):
            files.append(t)
    out_dir = out_dir or os.path.dirname(os.path.abspath(files[0]))
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for f in files:
        try:
            rows.append(repair(f, out_dir, apply))
        except Exception as e:
            rows.append(dict(name=os.path.basename(os.path.dirname(f)), path=f,
                             status="error", detail=str(e)))
    for r in rows:
        print("%-46s %-10s %s" % (r["name"], r["status"], r.get("detail", "")))
        if r.get("before"):
            print("     before: %s" % r["before"])
        if r.get("dropped") is not None:
            print("     dropped=%s events=%s cut=%s" % (r["dropped"], r["events"], r["cut"]))
        if r.get("candidate_j"):
            print("     candidate: %s" % r["candidate_j"])
        if r.get("backup"):
            print("     backup: %s" % r["backup"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
