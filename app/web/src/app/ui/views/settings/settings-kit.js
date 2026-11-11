// 设置页共用的两个小控件。聊天偏好和自动备份都要「一排分段按钮」，
// 拆页之后谁也别去 require 对方，放这里最省事。
export function markSegments(field, value) {
  for (const b of field.querySelectorAll('.el-settings-segment')) {
    b.classList.toggle('is-active', b.dataset.value === String(value));
  }
}

export function segmentField(labelText, items, current, onPick) {
  const field = document.createElement('div');
  field.className = 'el-settings-field';
  const label = document.createElement('span');
  label.className = 'el-settings-label';
  label.textContent = labelText;
  const segs = document.createElement('div');
  segs.className = 'el-settings-segments';
  const buttons = items.map((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'el-settings-segment';
    b.dataset.value = String(it.value);
    b.textContent = it.label;
    b.classList.toggle('is-active', String(it.value) === String(current));
    b.addEventListener('click', () => {
      for (const x of buttons) x.classList.toggle('is-active', x === b);
      onPick(it.value);
    });
    segs.append(b);
    return b;
  });
  field.append(label, segs);
  return field;
}
