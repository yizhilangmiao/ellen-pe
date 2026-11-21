// 设置 · 外观（二级页，排期 4a）。
//
// 这里只管「亮 / 暗 / 跟系统」这一档。真正的落地由 main.js 的 paintTheme 做：
// 它把档位算成 dark|light，挂到 #app 的 data-theme 上，顺手同步原生状态栏的
// 图标明暗。页面自己不碰 dataset —— 一份状态两个写入者最容易打架。
//
// 颜色自定义（4b）以后也挂这一页，所以现在就叫「外观」而不是「明暗」。
import { strings } from '../../../strings.zh.js';
import { THEME_MODES, readTheme, isSystemMode } from '../../../core/theme.js';
import {
  THEME_PRESETS,
  COLOR_SLOTS,
  findPreset,
  readThemeConfig,
  writeThemeConfig,
  ensureReadable,
  contrastRatio,
  normalizeColors,
  toHex6,
} from '../../../core/theme.js';
import {
  currentUserAvatar,
  onUserAvatarChange,
  pickUserAvatar,
  clearUserAvatar,
} from '../../../core/avatar.js';
import {
  WALL_FITS,
  WALL_BLURS,
  applyWallpaper,
  clearWallpaper,
  onWallpaperChange,
  pickWallpaper,
  readWallpaperMeta,
  writeWallpaperMeta,
} from '../../../core/wallpaper.js';
import { segmentField } from './settings-kit.js';
import './settings.css';

// 文案在 strings.settings 里（pages 只有 lore/welcome/call/vision 四个整页）。
// 4a 里这里写成 pages.settings 是个死 bug：pages.settings 是 undefined，整页 mount 直接抛错。
const T = strings.settings;

export function createAppearancePage({ onChange, onColors } = {}) {
  return {
    mount(el) {
      el.classList.add('el-scroll-page', 'el-settings-context');

      const title = document.createElement('h1');
      title.className = 'el-page-title';
      title.textContent = T.pageAppearance;
      const subtitle = document.createElement('p');
      subtitle.className = 'el-page-subtitle';
      subtitle.textContent = T.pageAppearanceHint;
      el.append(title, subtitle);

      const card = document.createElement('div');
      card.className = 'el-settings-card';

      const hint = document.createElement('p');
      hint.className = 'el-settings-hint';
      const paintHint = (mode) => {
        hint.textContent = isSystemMode(mode) ? T.themeModeSystemHint : '';
        hint.classList.toggle('is-hidden', !isSystemMode(mode));
      };

      const field = segmentField(
        T.themeModeTitle,
        THEME_MODES.map((m) => ({ value: m, label: T[`themeMode_${m}`] })),
        readTheme(),
        (mode) => {
          paintHint(mode);
          // onChange 由 main.js 注入：写存储 + 落 data-theme + 同步原生状态栏
          if (typeof onChange === 'function') onChange(mode);
        }
      );

      card.append(field, hint);
      el.append(card);
      paintHint(readTheme());

      // —— 配色（排期 4b） ——
      // 七个色位刷在根元素的内联样式上（见 main.js 的 applyColors）；预设只在自己
      // 有 colors 时覆盖，「默认」就是 null——直接吃 CSS 里那两套，不抄一份死值进来，
      // 以后调 tokens.css 选「默认」的人自动跟着变。
      //
      // 对比度是硬门：正文和背景太近时给提示 + 一键纠正。没这一层，用户把字调成
      // 跟背景一个色，第二天就会来问「艾莲怎么不说话了」。
      const appRoot = el.closest('.ellen-app') || document.documentElement;
      const computedColor = (slot) => {
        const v = getComputedStyle(appRoot).getPropertyValue(slot.cssVar).trim();
        return toHex6(v) || '#000000';
      };

      const cfg = readThemeConfig();
      let presetId = cfg.preset;
      let colors = cfg.colors ? { ...cfg.colors } : null;

      const colorCard = document.createElement('div');
      colorCard.className = 'el-settings-card';

      const colorHead = document.createElement('div');
      colorHead.className = 'el-settings-card-head';
      const colorTitle = document.createElement('div');
      colorTitle.className = 'el-settings-card-title';
      colorTitle.textContent = T.colorTitle;
      colorHead.append(colorTitle);

      const colorHint = document.createElement('p');
      colorHint.className = 'el-settings-card-hint';
      colorHint.textContent = T.colorHint;

      const presetLabel = document.createElement('div');
      presetLabel.className = 'el-settings-label';
      presetLabel.textContent = T.colorPresetTitle;

      const presetRow = document.createElement('div');
      presetRow.className = 'el-preset-row';

      const grid = document.createElement('div');
      grid.className = 'el-color-grid';
      const inputs = {};

      /** 写存储 + 刷根元素 + 重画。所有改动都走这里，避免两处各写一遍。 */
      const saveColors = (nextColors, nextPreset) => {
        presetId = nextPreset;
        colors = nextColors;
        const base = readThemeConfig();
        // colorsSource 是「谁说了算」的凭据：手改过就是 manual，
        // 之后即便换角色，角色包自带的配色也不会把他挑的色顶掉（排期 9 的优先级）。
        writeThemeConfig({
          mode: base.mode,
          preset: nextPreset,
          colors: nextColors,
          colorsSource: nextColors ? 'manual' : null,
          roleId: base.roleId,
        });
        if (typeof onColors === 'function') onColors(nextColors);
        paintAll();
      };

      const paintPresets = () => {
        presetRow.innerHTML = '';
        const items = THEME_PRESETS.map((p) => ({ id: p.id, label: p.label }));
        if (presetId === 'custom') items.push({ id: 'custom', label: T.colorCustom });
        for (const item of items) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `el-settings-segment${item.id === presetId ? ' is-active' : ''}`;
          btn.textContent = item.label;
          if (item.id === 'custom') {
            btn.disabled = true;
          } else {
            btn.addEventListener('click', () => {
              if (item.id === presetId) return;
              const preset = findPreset(item.id);
              saveColors(preset.colors ? { ...preset.colors } : null, item.id);
            });
          }
          presetRow.append(btn);
        }
      };

      // —— 对比度提示 ——
      const warn = document.createElement('div');
      warn.className = 'el-color-warn is-hidden';
      const warnText = document.createElement('span');
      warnText.className = 'el-color-warn-text';
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'el-settings-segment is-active';
      fixBtn.textContent = T.colorContrastFix;
      fixBtn.addEventListener('click', () => {
        const fixed = ensureReadable(colors);
        if (!fixed.issues.length) return;
        saveColors(fixed.colors, 'custom');
      });
      warn.append(warnText, fixBtn);

      const paintContrast = () => {
        if (!colors) {
          warn.classList.add('is-hidden');
          return;
        }
        const fg = colors.text || computedColor(COLOR_SLOTS[2]);
        const bg = colors.bg || computedColor(COLOR_SLOTS[0]);
        const ratio = contrastRatio(fg, bg);
        const bad = ratio !== null && ratio < 4.5;
        warn.classList.toggle('is-hidden', !bad);
        if (bad) warnText.textContent = `${T.colorContrastWarn}（${ratio.toFixed(1)}:1）`;
      };

      // —— 七个取色器 ——
      for (const slot of COLOR_SLOTS) {
        const row = document.createElement('label');
        row.className = 'el-color-row';
        const name = document.createElement('span');
        name.className = 'el-color-name';
        name.textContent = slot.label;
        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'el-color-input';
        inputs[slot.key] = input;
        input.addEventListener('input', () => {
          const next = colors ? { ...colors } : {};
          // 从「默认」直接改一格时，先把当前实际生效的七色抓一遍再改这一格，
          // 否则其余六格会掉回 CSS 默认，用户会看到「我只动了背景，字怎么变了」。
          if (!colors) for (const s of COLOR_SLOTS) next[s.key] = computedColor(s);
          next[slot.key] = toHex6(input.value) || input.value;
          saveColors(next, 'custom');
        });
        row.append(name, input);
        grid.append(row);
      }

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'el-settings-segment el-color-reset';
      resetBtn.textContent = T.colorReset;
      resetBtn.addEventListener('click', () => saveColors(null, 'default'));

      const paintAll = () => {
        paintPresets();
        for (const slot of COLOR_SLOTS) {
          if (!inputs[slot.key]) continue;
          // 8 位带 alpha 的色（气泡/分隔线）必须先截成 6 位，否则取色器吞成纯黑
          inputs[slot.key].value = toHex6((colors && colors[slot.key]) || computedColor(slot)) || '#000000';
        }
        paintContrast();
      };

      colorCard.append(colorHead, colorHint, presetLabel, presetRow, grid, warn, resetBtn);
      el.append(colorCard);
      paintAll();

      // —— 我的头像 ——
      // 头像存在原生侧（filesDir/avatars/user.png），这里只负责触发与预览。
      // 预览用的也是 chat 页那一份 blob URL 缓存（core/avatar.js 里），
      // 所以在这里换完，聊天页那几条旧消息不用重进就跟着变。
      const avatarCard = document.createElement('div');
      avatarCard.className = 'el-settings-card';

      const avatarHead = document.createElement('div');
      avatarHead.className = 'el-settings-card-head';
      const avatarTitle = document.createElement('div');
      avatarTitle.className = 'el-settings-card-title';
      avatarTitle.textContent = T.avatarTitle;
      avatarHead.append(avatarTitle);

      const avatarHint = document.createElement('p');
      avatarHint.className = 'el-settings-hint';
      avatarHint.textContent = T.avatarHint;

      const avatarRow = document.createElement('div');
      avatarRow.className = 'el-avatar-row';

      const preview = document.createElement('div');
      preview.className = 'el-avatar-preview';

      const empty = document.createElement('span');
      empty.className = 'el-avatar-empty';
      empty.textContent = T.avatarEmpty;

      const paintPreview = () => {
        const url = currentUserAvatar();
        preview.style.backgroundImage = url ? `url("${url}")` : '';
        preview.classList.toggle('has-image', !!url);
        empty.hidden = !!url;
      };

      const btns = document.createElement('div');
      btns.className = 'el-avatar-actions';

      const pickBtn = document.createElement('button');
      pickBtn.type = 'button';
      pickBtn.className = 'el-settings-segment is-active';
      pickBtn.textContent = T.avatarPick;

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'el-settings-segment';
      clearBtn.textContent = T.avatarClear;

      let busy = false;
      pickBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          await pickUserAvatar();
        } catch (err) {
          console.warn('[appearance] 换头像失败', err);
        } finally {
          busy = false;
          paintPreview();
        }
      });

      clearBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          await clearUserAvatar();
        } catch (err) {
          console.warn('[appearance] 清头像失败', err);
        } finally {
          busy = false;
          paintPreview();
        }
      });

      btns.append(pickBtn, clearBtn);
      preview.append(empty);
      avatarRow.append(preview, btns);
      avatarCard.append(avatarHead, avatarHint, avatarRow);
      el.append(avatarCard);

      paintPreview();
      const offAvatar = onUserAvatarChange(() => paintPreview());

      // —— 聊天背景 ——
      // 图在原生侧（filesDir/wallpapers/wall.jpg），铺法与模糊在 localStorage。
      // 这里只调 applyWallpaper 把变量刷到 .ellen-app 上，聊天页那层 CSS 自己画。
      const wallCard = document.createElement('div');
      wallCard.className = 'el-settings-card';

      const wallHead = document.createElement('div');
      wallHead.className = 'el-settings-card-head';
      const wallTitle = document.createElement('div');
      wallTitle.className = 'el-settings-card-title';
      wallTitle.textContent = T.wallTitle;
      wallHead.append(wallTitle);

      const wallHint = document.createElement('p');
      wallHint.className = 'el-settings-hint';
      wallHint.textContent = T.wallHint;

      const wallRow = document.createElement('div');
      wallRow.className = 'el-avatar-row';

      const wallPreview = document.createElement('div');
      wallPreview.className = 'el-avatar-preview el-wall-preview';
      const wallEmpty = document.createElement('span');
      wallEmpty.className = 'el-avatar-empty';
      wallEmpty.textContent = T.wallEmpty;

      const paintWall = () => {
        const url = applyWallpaper();
        wallPreview.style.backgroundImage = url ? `url("${url}")` : '';
        wallPreview.style.backgroundSize = readWallpaperMeta().fit;
        wallPreview.classList.toggle('has-image', !!url);
        wallEmpty.hidden = !!url;
      };

      const wallBtns = document.createElement('div');
      wallBtns.className = 'el-avatar-actions';

      const wallPick = document.createElement('button');
      wallPick.type = 'button';
      wallPick.className = 'el-settings-segment is-active';
      wallPick.textContent = T.wallPick;

      const wallClear = document.createElement('button');
      wallClear.type = 'button';
      wallClear.className = 'el-settings-segment';
      wallClear.textContent = T.wallClear;

      let wallBusy = false;
      wallPick.addEventListener('click', async () => {
        if (wallBusy) return;
        wallBusy = true;
        try {
          const res = await pickWallpaper();
          if (!res.ok && res.reason && res.reason !== 'CANCELLED') {
            wallHint.textContent = T.wallFail;
            wallHint.classList.add('is-warn');
          }
        } catch (err) {
          console.warn('[appearance] 换背景失败', err);
        } finally {
          wallBusy = false;
          paintWall();
        }
      });

      wallClear.addEventListener('click', async () => {
        if (wallBusy) return;
        wallBusy = true;
        try {
          await clearWallpaper();
        } catch (err) {
          console.warn('[appearance] 清背景失败', err);
        } finally {
          wallBusy = false;
          paintWall();
        }
      });

      wallBtns.append(wallPick, wallClear);
      wallPreview.append(wallEmpty);
      wallRow.append(wallPreview, wallBtns);

      const fitField = segmentField(
        T.wallFitTitle,
        WALL_FITS.map((f) => ({ value: f, label: T[`wallFit_${f}`] })),
        readWallpaperMeta().fit,
        (fit) => {
          writeWallpaperMeta({ fit });
          paintWall();
        }
      );

      const blurField = segmentField(
        T.wallBlurTitle,
        WALL_BLURS.map((b) => ({ value: String(b), label: T[`wallBlur_${b}`] })),
        String(readWallpaperMeta().blur),
        (value) => {
          writeWallpaperMeta({ blur: Number(value) });
          paintWall();
        }
      );

      wallCard.append(wallHead, wallHint, wallRow, fitField, blurField);
      el.append(wallCard);

      paintWall();
      const offWall = onWallpaperChange(() => paintWall());

      // 路由切走时会调 destroy（router.js:55）。不摘监听的话，来回进出设置页
      // 会攒一堆回调，每次改头像都对着已经不在页面上的节点算一遍样式。
      return {
        destroy() {
          if (typeof offAvatar === 'function') offAvatar();
          if (typeof offWall === 'function') offWall();
        },
      };
    },
  };
}
