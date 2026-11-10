# 旧包 UI 令牌实测（b17 运行时 · 双主题）

来源：CDP 注入，遍历 35 张样式表读 `--el-*` / `--jr-*` 自定义属性 + `getComputedStyle` 取值。
主题挂载方式：`.ellen-app[data-theme="dark"|"light"]`（`<main id="app" class="ellen-app ellen-ui-root">`）。
基准屏 **432×936 CSS**（= 真机 864 物理 / dpr 2），dpr 2.5 时 1080×2400 物理。

## 一、颜色变量（暗 / 浅 对照）

| 变量 | 暗色（data-theme=dark） | 浅色（data-theme=light） |
|---|---|---|
| `--el-bg` | `#17191f` | `#f8f7f5` |
| `--el-chat-action` | `#c5c0c7` | `#827a83` |
| `--el-companion-border` | `color-mix(in srgb,var(--el-pink) 23%,var(--el-line))` | （继承暗色） |
| `--el-companion-card` | `color-mix(in srgb,var(--el-surface) 85%,var(--el-bg))` | （继承暗色） |
| `--el-companion-glow` | `color-mix(in srgb,var(--el-pink) 13%,var(--el-bg))` | （继承暗色） |
| `--el-error` | `#f2becf` | `#963451` |
| `--el-error-bg` | `#30272d` | `#f4e2e9` |
| `--el-font-family` | `EllenKuaiLe,"Microsoft YaHei",sans-serif` | （继承暗色） |
| `--el-ink` | `#39363c` | `#3e3540` |
| `--el-line` | `#ffffff14` | `#30263519` |
| `--el-muted` | `#a9adb7` | `#78727d` |
| `--el-paper` | `#f4eee5` | `#fffaf1` |
| `--el-paper-muted` | `#817780` | `#7d737b` |
| `--el-pink` | `#e4b8cd` | `#976276` |
| `--el-primary` | `#e4cad7` | `#514754` |
| `--el-primary-ink` | `#332c36` | `#fff9fc` |
| `--el-raised` | `#2c3039` | `#e8e5ea` |
| `--el-self` | `#e9d4e0` | `#514754` |
| `--el-self-ink` | `#332934` | `#fff9fc` |
| `--el-settings-accent` | `#e9b7d0` | `#8d4969` |
| `--el-settings-control-line` | `#967e95` | `#96748c` |
| `--el-settings-disabled` | `#b6a3b3` | `#6e596b` |
| `--el-settings-error` | `#ffc1cc` | `#a03750` |
| `--el-settings-error-bg` | `#412632` | `#f5dfe6` |
| `--el-settings-focus` | `#d3afe7` | `#86518c` |
| `--el-settings-ink` | `#f7edf5` | `#3e2f43` |
| `--el-settings-input` | `#201b26` | `#fff8fc` |
| `--el-settings-line` | `#645064` | `#c5afc1` |
| `--el-settings-muted` | `#c3b1c0` | `#705b70` |
| `--el-settings-page` | `#1b1820` | `#f8f1f5` |
| `--el-settings-primary` | `#e5bad0` | `#74455f` |
| `--el-settings-primary-ink` | `#30202e` | `#fff7fc` |
| `--el-settings-radius` | `18px` | （继承暗色） |
| `--el-settings-raised` | `#322936` | `#e8d9e5` |
| `--el-settings-readonly` | `#2d2532` | `#ede2eb` |
| `--el-settings-shadow` | `0 8px 28px #00000019` | `0 8px 28px #63465709` |
| `--el-settings-success` | `#b4ddc6` | `#32694d` |
| `--el-settings-surface` | `#27212d` | `#f0e5ed` |
| `--el-stats-outline` | `color-mix(in srgb,var(--el-pink) 65%,var(--el-text))` | （继承暗色） |
| `--el-success` | `#bcdcc8` | `#306347` |
| `--el-surface` | `#23262e` | `#efedf0` |
| `--el-text` | `#f0edf1` | `#343039` |
| `--el-warning` | `#eed6b6` | `#714719` |
| `--el-warning-bg` | `#342b22` | `#fbefdc` |
| `--jr-line` | `#cfafbe` | （继承暗色） |
| `--jr-muted` | `#6f5869` | （继承暗色） |
| `--jr-rose` | `#955571` | （继承暗色） |
| `--jr-soft` | `#f0d4e1` | （继承暗色） |

## 二、关键元素计算样式（暗色主题下实测）

- `root` rect=[0,0,432,936]  color=rgb(245, 244, 242) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=16px · font-weight=400 · opacity=1 · border=0px none rgb(245, 244, 242)
- `title` rect=[0,0,0,0]  color=rgb(52, 48, 57) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=26px · font-weight=400 · line-height=37.7px · letter-spacing=0.78px · opacity=1 · border=0px none rgb(52, 48, 57)
- `subtitle` rect=[0,0,0,0]  color=rgb(100, 93, 105) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=12px · font-weight=400 · line-height=22.8px · opacity=1 · border=0px none rgb(100, 93, 105)
- `segment` rect=[0,0,0,0]  color=rgb(255, 249, 252) · background-color=rgb(81, 71, 84) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=13px · font-weight=400 · line-height=22.75px · padding=8px 0px · opacity=1
- `segmentIdle` rect=[0,0,0,0]  color=rgb(100, 93, 105) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=13px · font-weight=400 · line-height=22.75px · padding=8px 0px · opacity=1 · border=0px none rgb(100, 93, 105)
- `headerTool` rect=[192,7,44,44]  color=rgb(52, 48, 57) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=16px · font-weight=400 · line-height=28px · border-radius=10px · padding=2px 0px · gap=2px · opacity=1 · border=0px none rgb(52, 48, 57)
- `chatChip` rect=[18,60,98,44]  color=rgb(151, 98, 118) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=12px · font-weight=400 · line-height=21px · border-radius=13px · padding=5px 11px · gap=7px · opacity=1 · border=0px none rgb(151, 98, 118)
- `journalDay` rect=[0,0,0,0]  color=rgb(62, 53, 64) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=17px · font-weight=400 · line-height=20.4px · border-radius=12px · padding=3px 0px · gap=3px · opacity=1 · border=0.8px solid rgba(0, 0, 0, 0)
- `journalActive` rect=[0,0,0,0]  color=rgb(62, 53, 64) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=17px · font-weight=400 · line-height=20.4px · border-radius=12px · padding=3px 0px · gap=3px · opacity=1 · border=0.8px solid rgba(0, 0, 0, 0)
- `preview` rect=[0,0,0,0]  color=rgb(62, 53, 64) · background-color=rgba(255, 250, 241, 0.77) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=16px · font-weight=400 · line-height=28px · border-radius=4px 15px 15px · padding=14px 16px 12px · box-shadow=rgba(201, 174, 212, 0.11) 3px 4px 0px 0px · opacity=1 · border=0.8px solid rgba(207, 175, 190, 0.5)
- `primary` rect=[0,0,0,0]  color=rgb(255, 249, 252) · background-color=rgb(81, 71, 84) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=14px · font-weight=400 · line-height=24.5px · border-radius=12px · padding=10px 14px · gap=9px · opacity=1 · border=0px none rgb(255, 249, 252)
- `secondary` rect=[0,0,0,0]  color=rgb(52, 48, 57) · background-color=rgb(239, 237, 240) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=13px · font-weight=400 · line-height=22.75px · border-radius=10px · padding=8px 12px · gap=9px · opacity=1 · border=0.8px solid rgba(199, 178, 197, 0.26)
- `scrollPage` rect=[0,0,0,0]  color=rgb(52, 48, 57) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=16px · font-weight=400 · line-height=28px · padding=23px 20px 24px · opacity=1 · border=0px none rgb(52, 48, 57)
- `chatPage` rect=[0,107,432,697]  color=rgb(52, 48, 57) · background-color=rgb(248, 247, 245) · font-family=EllenKuaiLe, "Microsoft YaHei", sans-serif · font-size=16px · font-weight=400 · line-height=28px · opacity=1 · border=0px none rgb(52, 48, 57)
- `fab` rect=[372,690,46,46]  color=rgb(242, 233, 236) · background-color=rgba(28, 32, 38, 0.92) · font-family=Arial · font-size=13.3333px · font-weight=400 · border-radius=50% · padding=1px 6px · box-shadow=rgba(0, 0, 0, 0.38) 0px 6.00048px 18.0014px 0px · backdrop-filter=blur(6.00048px) · opacity=0.55 · border=0.8px solid rgba(214, 160, 180, 0.5)
- `journalSelected`：cls=`el-journal-day` color=rgb(255, 244, 249) bg=rgb(149, 85, 113) radius=12px

## 三、换算规则（M3 起硬执行）

旧包全部尺寸写在 432 CSS 宽基准屏上，单位就是 px。新 web 层**不写裸 px**，统一乘标尺：

```css
/* 1 单位 = 旧包的 1px，随屏缩放（432 宽时恰为 1px） */
:root { --u: clamp(0.84px, 0.2315vmin, 1.16px); }
/* 用法：旧包 26px → calc(26 * var(--u)) */
```

- 只有 `1px` 细线、`0`、`box-shadow` 的模糊半径可保留原值。
- 纵向尺寸用 `vmin`（基准就是 vmin），**不要用 vw**（横屏 vw 会放大 4 倍）。
- 字体族统一 `EllenKuaiLe, "Microsoft YaHei", sans-serif`（字体文件在旧包 assets 里，M3 复制过来）。