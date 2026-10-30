# 手机版 UI 单位规范（硬规矩）

> 起因：0.1.22 的情书 UI 全是写死的 px，只在 432 宽（老大的真机）上好看；
> 换台窄一点的机器就挤，换横屏就炸。0.1.23 把整套 CSS 改成相对单位。
> **以后手机版任何 UI 改动都按这份来，别再写像素。**

---

## 一、一条换算公式

基准屏 = **432 CSS px 宽**（老大真机：864 物理 ÷ DPR 2）。

```
1px @432  =  100/432 vmin  =  0.2315 vmin
Npx @432  →  clamp(N×0.84 px, N×0.2315 vmin, N×1.16 px)
```

写出来长这样：

```css
/* 原来 */
padding: 34px 22px 26px;
/* 现在 */
padding: clamp(28.56px,7.871vmin,39.44px) clamp(18.48px,5.093vmin,25.52px) clamp(21.84px,6.019vmin,30.16px);
```

公式的物理含义：**以 432 为基准 1:1，最窄缩到 84%，最宽放到 116%，两头用 px 兜死。**

- 下限兜死：小屏（360 宽）时不会缩成蚂蚁字。
- 上限兜死：大屏 / 横屏 / 平板时不会撑成巨型 UI。

## 二、为什么用 `vmin` 不用 `vw`

`vw` 只跟**宽度**走。竖屏时没问题，一旦横屏（1920 宽 / 1080 高），`vw` 会把纵向间距放大 4 倍——
`bottom:46.3vw` 能把按钮顶到屏幕中间去。0.1.22 转 vw 第一版就是这个症状。

`vmin` 取宽高较小值：

| 场景 | CSS 视口 | vmin | 表现 |
|---|---|---|---|
| 老大真机竖屏 | 432×960 | 432 | 与基准一致 |
| 模拟器横屏 | 1097×617 | 617 | 略放大，被上限 116% 压住 |
| 窄机竖屏 | 360×780 | 360 | 缩到下限 84% |

所以：**布局尺寸一律 `vmin`**。

## 三、字号必须拆开写

`clamp()` **不能出现在 `font:` 简写里**（CSS 规范不允许），下面这种写法整个属性会被浏览器丢掉：

```css
/* ✗ 错的，clamp 在简写里无效 */
font: 400 clamp(13.44px,3.11vmin,18.56px)/2 'Noto Serif SC',serif;

/* ✓ 对的，拆成四条 */
font-weight: 400;
font-size: clamp(13.44px,3.11vmin,18.56px);
line-height: 2;
font-family: 'Noto Serif SC',serif;
```

改 CSS 时先搜 `font:`，全部拆开。

## 四、负值必须包 calc

```css
/* ✗ 错的 -clamp(...) 不是合法值 */
top: -clamp(3.36px,0.926vmin,4.64px);

/* ✓ 对的 */
top: calc(-1*clamp(3.36px,0.926vmin,4.64px));
```

`margin: 0 0 -6px` 这类同理。

## 五、只有两种 px 可以留

1. **1px 细线**：`border:1px solid ...`、`box-shadow` 的 1px 描边、纸纹的 1px 渐变刻度。
   缩放会糊、会消失，必须钉死。
2. **0**。

其余一律 clamp。例外要在代码里写注释说明理由。

## 六、验证方法（两个模拟器实例，缺一不算验过）

| 实例 | 分辨率 | density | CSS 视口 | 用来验 |
|---|---|---|---|---|
| `0` 横屏 | 1080×2400 → 转 1920×1080 | 400 / 1.75 | 1097×617 | 上限是否兜住、纵向有没有炸 |
| `1` 竖屏 | 1080×2400 | 400 | **432×960** | 与老大真机 1:1 |

```powershell
# 竖屏实例（1）—— 和真机同尺寸
& 'E:\Program Files\Netease\MuMu\nx_main\MuMuManager.exe' info -v 1     # 拿 adb_port（当前 16416）
adb connect 127.0.0.1:16416
adb -s 127.0.0.1:16416 install -r -d <apk>
```

竖屏实例是干净环境（没聊天记录、没配模型），**顺便就是空消息态 + 首启弹窗的测试场**。

改完 CSS 必须两边各截一张图对照，看：

- 元素有没有跑出屏幕、有没有挤成一团
- 字号是不是还能读（下限 84% 是否够）
- 长文本折行有没有断在奇怪的地方（比如「字，」单独一行）

## 七、改 UI 之前先调技能

按 `E:\_ai\routing.md` 的 **S19**：

- `ai-ui-art-direction` —— 美术方向判断 + 空上下文评审闭环（改完让评审子 Agent 只贴截图打分，≥9 才收）
- `huashu-design` —— 要出原型/多方向时用
- `interaction-motion-design` —— 动效/过渡该用哪种交互模式

本项（单位适配）属于工程规范，走本文档即可；但凡涉及**观感判断**（颜色、层次、留白、看起来像不像 AI 做的），先 load skill 再动手。

## 八、做过的转换（0.1.23，可复查）

`inject-letter.js` 的 `CSS` 数组：

- `font:` 简写拆开 **20 处**
- `Npx → clamp(N×0.84px, N×0.2315vmin, N×1.16px)` **185 处**
- `-clamp(` → `calc(-1*clamp(...))` **12 处**（第一版漏了，浏览器直接丢值）
- 保留 1px / 0px 若干
- 备份在 `inject-letter.js.bak-0.1.22`（改坏了直接覆盖回来）

复查命令：

```bash
cd "E:/ailian/艾莲手机版/创作版/_phone-sync"
python -c "
import io,re
s=io.open('inject-letter.js',encoding='utf-8').read()
i=s.index('var CSS = ['); j=s.index('].join(\"\"', i)
css=s[i:j]
print('clamp 数', css.count('clamp('))
print('vmin 数', css.count('vmin'))
print('裸 font 简写', len(re.findall(r'font:\s*\d{3}', css)))
print('裸 -clamp(', css.count('-clamp('))
print('残留裸 px', [x for x in re.findall(r'(?<![\d.])\d+(?:\.\d+)?px', css) if x not in ('1px','0px')][:10])
"
```

四项分别应为：`clamp>150`、`vmin>150`、`0`、`0`、空列表（只剩 clamp 内部的上下限 px 属正常，上面这个正则会把它们也捞出来，
所以看的是它有没有捞到「不在 clamp 里」的裸 px —— 需要人眼扫一眼上下文确认）。
