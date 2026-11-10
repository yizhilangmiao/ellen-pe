# -*- coding: utf-8 -*-
"""修：信匣阅读器点「回一句」会弹出「要离开了吗」

根因
----
replyInChat() -> closeReader() -> guardOff() -> window.history.back()
这条 history.back() 是为了撤掉 guardOn() 压的哨兵条目（必须撤，否则历史里留垃圾），
但它产生的 popstate 会被宿主的返回钩子收到 -> 宿主调 window.__ellenBack()
-> appBack() 在信匣页返回 false -> askQuit() 弹出「要离开了吗」。

也就是说「回一句」被当成了一次返回键。

修法
----
关信期间给返回钩子开一个短暂的抑制窗口（800ms），三个入口都挡：
  window.__ellenBack / document backbutton / appBack()
只挡我们自己制造的那一次，用户在 800ms 内真的按返回仍然有效（因为那时窗口已过，
或者 appBack 里会重新走正常路径）。

标记：/* ellen-letter-reply */
"""
import io
import shutil
import sys

SRC = r'E:\ailian\艾莲手机版\创作版\_phone-sync\inject-letter.js'
BAK = SRC + '.bak-letterreply'
MARK = '/* ellen-letter-reply */'


def main():
    s = io.open(SRC, encoding='utf-8').read()
    mode = sys.argv[1] if len(sys.argv) > 1 else ''

    if mode == '--check':
        print('mark', s.count(MARK))
        return

    if mode == '--revert':
        shutil.copyfile(BAK, SRC)
        t = io.open(SRC, encoding='utf-8').read()
        print('[revert] len', len(t))
        return

    if MARK in s:
        print('[already]')
        return

    before = len(s)

    # 1) 在 guardOff 之前插入抑制窗口的变量与判定
    old_guard = '''  var backGuard = false;
  function guardOn() {'''
    new_guard = '''  var backGuard = false;
  /* 回一句要关信，关信必然 history.back()，宿主会把那次 popstate 当成按返回键。
     这里开一个短窗口把它挡掉；只挡我们自己造出来的那一次，不挡用户真按返回。 */
  var suppressBackUntil = 0; ''' + MARK + '''
  function backSuppressed() {
    return suppressBackUntil !== 0 && Date.now() < suppressBackUntil;
  }
  function guardOn() {'''
    assert s.count(old_guard) == 1, 'guard anchor %d' % s.count(old_guard)
    s = s.replace(old_guard, new_guard, 1)

    # 2) replyInChat 里先开窗口
    old_reply = '''  function replyInChat() {
    closeReader();'''
    new_reply = '''  function replyInChat() {
    suppressBackUntil = Date.now() + 800; ''' + MARK + '''
    closeReader();'''
    assert s.count(old_reply) == 1, 'reply anchor %d' % s.count(old_reply)
    s = s.replace(old_reply, new_reply, 1)

    # 3) window.__ellenBack 开头挡
    old_hook = '''  window.__ellenBack = function () {
    if (appBack()) return true;'''
    new_hook = '''  window.__ellenBack = function () {
    if (backSuppressed()) return true; ''' + MARK + '''
    if (appBack()) return true;'''
    assert s.count(old_hook) == 1, 'ellenBack anchor %d' % s.count(old_hook)
    s = s.replace(old_hook, new_hook, 1)

    # 4) backbutton 开头挡
    old_btn = '''    function (e) {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      if (appBack()) return;'''
    new_btn = '''    function (e) {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      if (backSuppressed()) return; ''' + MARK + '''
      if (appBack()) return;'''
    assert s.count(old_btn) == 1, 'backbutton anchor %d' % s.count(old_btn)
    s = s.replace(old_btn, new_btn, 1)

    # 5) appBack 开头挡（兜底：宿主若直接调 appBack）
    old_ab = '''  function appBack() {
    mark("ellen-bk2", "enter reader="'''
    new_ab = '''  function appBack() {
    if (backSuppressed()) return true; ''' + MARK + '''
    mark("ellen-bk2", "enter reader="'''
    assert s.count(old_ab) == 1, 'appBack anchor %d' % s.count(old_ab)
    s = s.replace(old_ab, new_ab, 1)

    shutil.copyfile(SRC, BAK)
    io.open(SRC, 'w', encoding='utf-8', newline='').write(s)
    print('[applied] %d -> %d delta %+d' % (before, len(s), len(s) - before))

    chk = io.open(SRC, encoding='utf-8').read()
    assert chk.count(MARK) == 5, 'mark=%d' % chk.count(MARK)
    assert 'function backSuppressed()' in chk
    assert 'suppressBackUntil = Date.now() + 800' in chk
    print('  [self-check] ok')


main()
