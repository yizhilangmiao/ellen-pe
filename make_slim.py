# -*- coding: utf-8 -*-
"""一条命令出「小补丁包」：自动挑最新包 → 瘦身 → 签名 → 落到 产出版。

为什么需要它
------------
全量包 573 MB，装一次要好几分钟，改一行文案再装一遍不值得。
这个脚本把跟「聊天 / 记忆 / 手记 / 导出」无关的大件剔掉，出来 130 MB 左右，
其余功能一模一样，用来快速验证改动。

剔什么（都是本地语音识别、通话识别、背景音乐、语音克隆的模型和原生库）
    assets/local-asr/            约 228 MB   本地语音识别
    assets/local-call-asr/       约 160 MB   通话本地识别
    assets/music/                约  28 MB   背景音乐
    assets/voice-clone/          约  19 MB   语音克隆参考音
    assets/local-vad/            约   1 MB
    lib/                         约 122 MB   onnxruntime / sherpa 原生库（只给上面那些用）

故意保留（和历史 b1「51MB 测试包」不同）
    assets/public/local-embeddings/   句向量模型
    assets/public/semantic-runtime/   onnx WASM 运行时
    assets/public/assets/ort-wasm-*   WASM 二进制
  原因：记忆的「检索」有语义通道，跑在 WASM（backend: vm），不依赖 lib/。
  剔了它就只剩关键词匹配，测不出记忆效果。要最瘦就加 --drop-embeddings。

副作用（会在结果里打印出来，记得转告）
    · 本地语音识别不可用（打字聊天不受影响）
    · 通话本地识别不可用
    · 背景音乐不可用
    · 语音克隆 / 参考音不可用
    --drop-embeddings 时另外：记忆检索退化为纯关键词

用法
    python make_slim.py                       # 挑 _build 里最新的包，出 130MB 轻量版
    python make_slim.py --src <apk>           # 指定源包
    python make_slim.py --drop-embeddings     # 最瘦，约 50MB
    python make_slim.py --no-sign             # 只出未签名包
    python make_slim.py --no-verify           # 跳过出包前的补丁自证
    python make_slim.py --to-release          # 出完顺带复制进 ..\\产出版\\

产物
    _build\\<原名>-轻量-unsigned.apk
    _build\\<原名>-轻量-aligned-debugSigned.apk   ← 可以直接 adb install
"""
import argparse
import glob
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, '_build')
RELEASE = os.path.abspath(os.path.join(HERE, '..', '产出版'))
SIGN_PS1 = os.path.join(HERE, '_dev_sign.ps1')
VERIFY = os.path.abspath(os.path.join(HERE, '..', '..', 'verify-all-patches.py'))

DROP_PREFIX = (
    'assets/local-asr/',
    'assets/local-call-asr/',
    'assets/music/',
    'assets/voice-clone/',
    'assets/local-vad/',
    'lib/',
)
DROP_EMB = (
    'assets/public/local-embeddings/',
    'assets/public/semantic-runtime/',
)
DROP_EMB_GLOB = (
    'assets/public/assets/ort-wasm-simd-threaded',
    'assets/public/assets/ort.wasm.bundle.min',
)

# 这些东西缺了 App 就起不来，瘦完必须还在
MUST_KEEP = (
    'classes.dex',
    'AndroidManifest.xml',
    'resources.arsc',
    'assets/public/index.html',
    'assets/public/assets/main-CFFhpb4h.js',
    'assets/public/assets/service-DGjhUELY.js',
    'assets/public/assets/storage-worker-C5hDp6Bk.js',
    'assets/public/assets/persona-CBp1pExX.js',
    'assets/public/ellen-startup-opening.js',
    'assets/public/ellen-proactive.js',
    'assets/public/ellen-proactive-ui.js',
)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def find_latest_src():
    """优先拿未签名包（省一次签名），没有再退到已签名包。"""
    cands = []
    for pat in ('*unsigned.apk', '*debugSigned.apk', '*.apk'):
        hits = [p for p in glob.glob(os.path.join(BUILD, pat)) if '轻量' not in os.path.basename(p)]
        if hits:
            cands = hits
            break
    if not cands:
        return None
    return max(cands, key=os.path.getmtime)


def run_verify():
    if not os.path.exists(VERIFY):
        print('[warn] 没找到 %s，跳过补丁自证' % VERIFY)
        return True
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    r = subprocess.run([sys.executable, VERIFY], capture_output=True, text=True, encoding='utf-8', env=env)
    tail = (r.stdout or '').strip().splitlines()
    print('  ' + (tail[-1] if tail else '(无输出)'))
    if r.returncode != 0:
        for line in tail:
            if 'FAIL' in line or 'MISS' in line:
                print('  ' + line.strip())
        return False
    return True


def slim(src, dst, drop_embeddings):
    drop_prefix = list(DROP_PREFIX) + (list(DROP_EMB) if drop_embeddings else [])
    drop_glob = list(DROP_EMB_GLOB) if drop_embeddings else []

    if os.path.exists(dst):
        os.remove(dst)

    zin = zipfile.ZipFile(src)
    kept = dropped = 0
    kept_b = dropped_b = 0
    big = []
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for zi in zin.infolist():
            n = zi.filename
            if n.startswith(tuple(drop_prefix)) or (drop_glob and n.startswith(tuple(drop_glob))):
                dropped += 1
                dropped_b += zi.file_size
                if zi.file_size > 1 << 20:
                    big.append((n, zi.file_size))
                continue
            nz = zipfile.ZipInfo(n, date_time=zi.date_time)
            nz.compress_type = zi.compress_type
            nz.external_attr = zi.external_attr
            nz.create_system = zi.create_system
            nz.internal_attr = zi.internal_attr
            with zin.open(zi) as f, zout.open(nz, 'w') as g:
                shutil.copyfileobj(f, g, 1 << 20)
            kept += 1
            kept_b += zi.file_size
    zin.close()
    return kept, kept_b, dropped, dropped_b, big


def check_kept(dst):
    names = set(zipfile.ZipFile(dst).namelist())
    miss = [n for n in MUST_KEEP if n not in names]
    return miss


def sign(unsigned_path):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    r = subprocess.run(
        ['pwsh', '-File', SIGN_PS1, '-Apk', unsigned_path],
        capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, cwd=HERE,
    )
    out = (r.stdout or '') + (r.stderr or '')
    for line in out.splitlines():
        if '已签名' in line or 'Successfully' in line or 'error' in line.lower():
            print('  ' + line.strip())
    if r.returncode != 0:
        return None
    # 签名脚本的产物命名规则：<原名>-aligned-debugSigned.apk
    base = unsigned_path[:-len('-unsigned.apk')] if unsigned_path.endswith('-unsigned.apk') else unsigned_path[:-4]
    return base + '-aligned-debugSigned.apk'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=None)
    ap.add_argument('--name', default=None, help='产物名（不含扩展名），默认沿用源包名 + -轻量')
    ap.add_argument('--drop-embeddings', action='store_true')
    ap.add_argument('--no-sign', action='store_true')
    ap.add_argument('--no-verify', action='store_true')
    ap.add_argument('--to-release', action='store_true')
    a = ap.parse_args()

    print('== 1/5 补丁自证 ==')
    if a.no_verify:
        print('  (跳过)')
    elif not run_verify():
        print('  补丁没全打上，先修再出包。要强行出加 --no-verify')
        return 2

    print('== 2/5 选源包 ==')
    src = a.src or find_latest_src()
    if not src or not os.path.exists(src):
        print('  _build 里没有找到包：%s' % BUILD)
        return 2
    print('  %s  %.1f MB' % (os.path.basename(src), os.path.getsize(src) / 1048576))

    print('== 3/5 瘦身 ==')
    stem = a.name or (os.path.splitext(os.path.basename(src))[0] + '-轻量')
    stem = stem.replace('-aligned-debugSigned', '').replace('-unsigned', '')
    dst = os.path.join(BUILD, stem + '-unsigned.apk')
    kept, kept_b, dropped, dropped_b, big = slim(src, dst, a.drop_embeddings)
    print('  保留 %d 条 / %.1f MB' % (kept, kept_b / 1048576))
    print('  剔除 %d 条 / %.1f MB' % (dropped, dropped_b / 1048576))
    for n, s in sorted(big, key=lambda x: -x[1])[:6]:
        print('    - %-52s %7.1f MB' % (n, s / 1048576))

    miss = check_kept(dst)
    if miss:
        print('  !! 关键文件丢了，包会起不来：')
        for m in miss:
            print('     - %s' % m)
        return 3
    print('  关键文件齐全（dex / manifest / web bundle / 三个注入脚本）')

    final = dst
    print('== 4/5 签名 ==')
    if a.no_sign:
        print('  (跳过)')
    else:
        signed = sign(dst)
        if not signed or not os.path.exists(signed):
            print('  签名失败')
            return 4
        final = signed

    print('== 5/5 结果 ==')
    size = os.path.getsize(final)
    digest = sha256_of(final)
    print('  %s' % final)
    print('  %.1f MB  (%s B)' % (size / 1048576, format(size, ',')))
    print('  sha256 %s' % digest)
    print()
    print('  这一版没有的：本地语音识别 / 通话本地识别 / 背景音乐 / 语音克隆参考音')
    if a.drop_embeddings:
        print('  另外没有的：记忆的语义检索（退化成纯关键词匹配）')
    else:
        print('  记忆的语义检索还在（embeddings + WASM 运行时都留着）')
    print('  占位路径、manifest 未动，覆盖安装会替换成这一版；装全量包能换回去。')

    if a.to_release:
        os.makedirs(RELEASE, exist_ok=True)
        tgt = os.path.join(RELEASE, os.path.basename(final))
        shutil.copyfile(final, tgt)
        print('  已复制到产出版: %s' % tgt)
    return 0


sys.exit(main())
