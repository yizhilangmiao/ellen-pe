# -*- coding: utf-8 -*-
"""把 companion2 新写的两个原生插件补进 contract/native-plugins.json。

只做文本级插入：整份 dump 是 _tools/dump_plugins.py 从 smali 生成的（478 KB），
用 json.load/dump 整篇重写会改动它的排版与既有条目，所以这里只
  1) 在 plugins 数组末尾插两条（字段结构与现有条目完全一致）；
  2) 改几个顶层汇总数。
方法条目的 line 取 Kotlin 源码里真实的 fun 行号（smaliBytes 记 0，表示不是 smali 来源）。
"""
import json
import re
from pathlib import Path

ROOT = Path(r"E:\ailian\艾莲手机版\创作版")
JSON_PATH = ROOT / "contract" / "native-plugins.json"
MEDIA_KT = ROOT / "app/app/src/main/java/cn/ellen/companion2/plugin/EllenMediaPlugin.kt"
VOLUME_KT = ROOT / "app/app/src/main/java/cn/ellen/companion2/plugin/EllenVolumePlugin.kt"


def method(m):
    return {
        "name": m["name"],
        "params": m["params"],
        "isStatic": False,
        "annotated": m["annotated"],
        "returnType": None,
        "options": m["options"],
        "messages": m["messages"],
        "events": [],
        "putKeys": m["putKeys"],
        "calls": m["calls"],
        "constStrings": m["constStrings"],
        "line": m["line"],
    }


def line_of(path, name):
    for i, text in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if re.search(r"\bfun\s+" + re.escape(name) + r"\s*\(", text):
            return i
    return 0


def entry(plugin, cls, path, ms):
    return {
        "plugin": plugin,
        "class": cls,
        "file": str(path).replace("/", "\\"),
        "smaliBytes": 0,
        "methodCount": len(ms),
        "pluginMethodCount": sum(1 for m in ms if m["annotated"]),
        "events": [],
        "staticStrings": {},
        "methods": [method(m) for m in ms],
    }


media_methods = [
    dict(name="<init>", params="()V", annotated=False, options=[], messages=[], putKeys=[],
         calls=[], constStrings=[], line=line_of(MEDIA_KT, "EllenMediaPlugin")),
    dict(name="pickImage", params="(Lcom/getcapacitor/PluginCall;)V", annotated=True,
         options=[{"api": "getDouble", "key": "maxSide"},
                  {"api": "getDouble", "key": "maxBytes"}],
         messages=[{"api": "reject", "key": "MEDIA_BUSY"},
                   {"api": "reject", "key": "MEDIA_UNAVAILABLE"},
                   {"api": "reject", "key": "MEDIA_DECODE_FAILED"}],
         putKeys=["picked", "name", "uri", "mimeType", "bytes", "width", "height"],
         calls=["startActivityForResult"], constStrings=["image/*", "photos", "IMG_", "image/jpeg"],
         line=line_of(MEDIA_KT, "pickImage")),
    dict(name="pickedImage", params="(Lcom/getcapacitor/PluginCall;Landroidx/activity/result/ActivityResult;)V",
         annotated=False, options=[], messages=[{"api": "reject", "key": "MEDIA_DECODE_FAILED"}],
         putKeys=["picked"], calls=["compressToPhoto"], constStrings=[], line=line_of(MEDIA_KT, "pickedImage")),
    dict(name="saveToAlbum", params="(Lcom/getcapacitor/PluginCall;)V", annotated=True,
         options=[{"api": "getString", "key": "name"},
                  {"api": "getString", "key": "mimeType"},
                  {"api": "getString", "key": "path"}],
         messages=[{"api": "reject", "key": "MEDIA_NOT_FOUND"},
                   {"api": "reject", "key": "MEDIA_PERMISSION"},
                   {"api": "reject", "key": "MEDIA_WRITE_FAILED"}],
         putKeys=["saved"], calls=["insertWithMediaStore", "insertLegacy", "requestPermissionForAlias"],
         constStrings=["Pictures/艾莲", "image/jpeg", "image/"], line=line_of(MEDIA_KT, "saveToAlbum")),
    dict(name="storageResult", params="(Lcom/getcapacitor/PluginCall;)V", annotated=False,
         options=[], messages=[{"api": "reject", "key": "MEDIA_PERMISSION"},
                               {"api": "reject", "key": "MEDIA_NOT_FOUND"}],
         putKeys=["saved"], calls=["insertLegacy"], constStrings=[], line=line_of(MEDIA_KT, "storageResult")),
]

volume_methods = [
    dict(name="<init>", params="()V", annotated=False, options=[], messages=[], putKeys=[],
         calls=[], constStrings=[], line=line_of(VOLUME_KT, "EllenVolumePlugin")),
    dict(name="get", params="(Lcom/getcapacitor/PluginCall;)V", annotated=True, options=[],
         messages=[{"api": "reject", "key": "VOLUME_UNAVAILABLE"}],
         putKeys=["volume", "max"], calls=["getStreamVolume", "getStreamMaxVolume"], constStrings=[],
         line=line_of(VOLUME_KT, "fun get") if False else line_of(VOLUME_KT, "get")),
    dict(name="set", params="(Lcom/getcapacitor/PluginCall;)V", annotated=True,
         options=[{"api": "getDouble", "key": "volume"}, {"api": "getInt", "key": "volume"}],
         messages=[{"api": "reject", "key": "VOLUME_UNAVAILABLE"},
                   {"api": "reject", "key": "VOLUME_PERMISSION"},
                   {"api": "reject", "key": "VOLUME_SET_FAILED"}],
         putKeys=["volume"], calls=["setStreamVolume"], constStrings=[], line=line_of(VOLUME_KT, "set")),
]

new_entries = [
    entry("EllenMedia", "cn.ellen.companion2.plugin.EllenMediaPlugin", MEDIA_KT, media_methods),
    entry("EllenVolume", "cn.ellen.companion2.plugin.EllenVolumePlugin", VOLUME_KT, volume_methods),
]

text = JSON_PATH.read_text(encoding="utf-8")
before = json.loads(text)

frag = ""
for e in new_entries:
    body = json.dumps(e, ensure_ascii=True, indent=1)
    frag += ",\n" + "\n".join("  " + ln for ln in body.splitlines())

tail = "\n ]\n}"
assert text.endswith(tail), "文件尾部形状变了，先别盲插"
text = text[: -len(tail)] + frag + tail

added_methods = sum(e["methodCount"] for e in new_entries)
added_plugin_methods = sum(e["pluginMethodCount"] for e in new_entries)
added_with_options = sum(1 for e in new_entries for m in e["methods"] if m["options"])
added_with_messages = sum(1 for e in new_entries for m in e["methods"] if m["messages"])
new_keys = {"maxSide", "maxBytes"}

pairs = [
    ('"pluginCount": %d' % before["pluginCount"], '"pluginCount": %d' % (before["pluginCount"] + len(new_entries))),
    ('"totalMethods": %d' % before["totalMethods"], '"totalMethods": %d' % (before["totalMethods"] + added_methods)),
    ('"totalPluginMethods": %d' % before["totalPluginMethods"],
     '"totalPluginMethods": %d' % (before["totalPluginMethods"] + added_plugin_methods)),
    ('"pluginMethods": %d' % before["coverage"]["pluginMethods"],
     '"pluginMethods": %d' % (before["coverage"]["pluginMethods"] + added_plugin_methods)),
    ('"withOptions": %d' % before["coverage"]["withOptions"],
     '"withOptions": %d' % (before["coverage"]["withOptions"] + added_with_options)),
    ('"withMessages": %d' % before["coverage"]["withMessages"],
     '"withMessages": %d' % (before["coverage"]["withMessages"] + added_with_messages)),
    ('"optionKeys": %d' % before["coverage"]["optionKeys"],
     '"optionKeys": %d' % (before["coverage"]["optionKeys"] + len(new_keys))),
]
for old, new in pairs:
    assert text.count(old) == 1, "计数锚点不唯一: " + old
    text = text.replace(old, new)

JSON_PATH.write_text(text, encoding="utf-8")

after = json.loads(JSON_PATH.read_text(encoding="utf-8"))
names = [p["plugin"] for p in after["plugins"]]
print("plugins", after["pluginCount"], "len", len(after["plugins"]))
print("新增:", names[-2], names[-1])
print("总方法", after["totalMethods"], "插件方法", after["totalPluginMethods"])
for p in after["plugins"][-2:]:
    print(p["plugin"], p["class"], "methods", p["methodCount"], "pluginMethods", p["pluginMethodCount"],
          [m["name"] for m in p["methods"]])
# 既有条目没被碰过：和插入前的快照逐项比对
same = json.dumps(before["plugins"], sort_keys=True) == json.dumps(after["plugins"][:-2], sort_keys=True)
print("既有 28 条逐字节未变:", same)
