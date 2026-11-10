// 页面栈。只有一个入口负责"哪个页面是活的"，视图自己不抢显隐
// （§6.5 第 7 条；否则半年后每个 view 里都有一份 display 逻辑）。
//
// 两种导航：
//   show(name)      切底栏 tab —— 换根页面，栈清空
//   push(name, p)   压一个全屏页（历史 / 设置子页），返回键 pop()
//   pop()           出栈回上一层；栈底时返回 false（交给系统返回键）
// 视图契约：mount(el, props) → 可返回 { destroy() }，切换时自动调用。

const views = new Map();
const stack = [];
let hostEl = null;
let onChange = null;
let activeNode = null;

export function defineView(name, factory) {
  views.set(name, factory);
}

export function mountRouter(host, { onNavigate } = {}) {
  hostEl = host;
  onChange = onNavigate || null;
}

function build(name, params) {
  const factory = views.get(name);
  if (!factory) throw new Error(`未注册的视图: ${name}`);
  const el = document.createElement('section');
  el.className = 'el-page';
  el.dataset.view = name;
  hostEl.appendChild(el);
  const instance = factory() || {};
  let handle = null;
  if (typeof instance.mount === 'function') {
    handle = instance.mount(el, params || {});
  } else if (typeof instance === 'function') {
    handle = instance(el, params || {});
  }
  return { el, params, handle, name };
}

function teardown(node) {
  if (!node) return;
  if (node.handle && typeof node.handle.destroy === 'function') {
    try {
      node.handle.destroy();
    } catch (err) {
      console.error('[router] destroy 失败', err);
    }
  }
  node.el.remove();
}

function activate(node) {
  if (activeNode === node) return;
  if (activeNode) {
    activeNode.el.classList.remove('is-active');
    // 全屏页不留在 DOM 里，tab 页面留在 DOM（保住滚动位置与草稿）
    if (activeNode.fromStack) teardown(activeNode);
  }
  activeNode = node;
  node.el.classList.add('is-active');
  if (activeNode.handle && typeof activeNode.handle.resume === 'function') {
    try {
      activeNode.handle.resume();
    } catch (err) {
      console.error('[router] resume 失败', err);
    }
  }
  if (onChange) onChange(current());
}

/** 切底栏 tab：清空整栈。 */
export function show(name, params) {
  for (const node of stack.splice(0)) teardown(node);
  const node = build(name, params);
  stack.push(node);
  activate(node);
  return node;
}

/** 压一个全屏页。 */
export function push(name, params) {
  const node = build(name, params);
  node.fromStack = true;
  stack.push(node);
  activate(node);
  return node;
}

/** 出栈。返回 false 表示已经到最底层。 */
export function pop() {
  if (stack.length <= 1) return false;
  const node = stack.pop();
  node.el.classList.remove('is-active');
  teardown(node);
  activeNode = null;
  activate(stack[stack.length - 1]);
  return true;
}

export function current() {
  const node = stack[stack.length - 1];
  return node ? { name: node.name, params: node.params, depth: stack.length } : null;
}

export function currentName() {
  const node = stack[stack.length - 1];
  return node ? node.name : null;
}
