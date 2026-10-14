/* 轻量 DOM 工具：元素构造、模态框、表单、提示。无任何依赖。 */

export function append(parent, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    children.forEach(function (child) { append(parent, child); });
    return;
  }
  if (children instanceof Node) { parent.appendChild(children); return; }
  parent.appendChild(document.createTextNode(String(children)));
}

export function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (key) {
      const value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'value') node.value = value;
      else if (key === 'checked') node.checked = !!value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    });
  }
  append(node, children);
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
export function $(id) { return document.getElementById(id); }

export function chip(text, cls) { return el('span', { class: 'chip ' + (cls || '') }, text); }

export function row(children, cls) { return el('div', { class: 'row ' + (cls || '') }, children); }

export function field(labelText, node, hint) {
  return el('div', { class: 'field' }, [
    el('label', {}, labelText),
    node,
    hint ? el('div', { class: 'small muted' }, hint) : null
  ]);
}

export function stars(level) {
  const value = Number(level) || 0;
  if (!value) return el('span', { class: 'muted small' }, '未标记');
  return el('span', { class: 'stars' }, '★'.repeat(value) + '☆'.repeat(5 - value));
}

export function formatTime(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').replace('Z', '').slice(0, 16);
}

/* ------------------------------------------------------------------ 提示条 */

export function toast(message, type, timeout) {
  const box = $('toasts');
  // 最多同时显示两条，避免连续操作时把内容整片盖住
  while (box.children.length >= 2) box.removeChild(box.firstChild);
  const node = el('div', { class: 'toast ' + (type || '') }, String(message));
  box.appendChild(node);
  window.setTimeout(function () {
    if (node.parentNode) node.parentNode.removeChild(node);
  }, timeout || (type === 'error' ? 6000 : 3000));
  return node;
}

export function emptyState(title, hint) {
  return el('div', { class: 'empty' }, [
    el('div', { style: { fontWeight: '600', color: 'var(--text-dim)' } }, title),
    hint ? el('div', { class: 'small', style: { marginTop: '3px' } }, hint) : null
  ]);
}

/* ------------------------------------------------------------------ 模态框 */

export function showModal(options) {
  const root = $('modal-root');
  const body = el('div', {}, []);
  const actions = el('div', { class: 'modal-actions' }, []);
  const header = el('div', { class: 'modal-header' }, [
    el('h2', {}, options.title || ''),
    el('button', { class: 'ghost small', onclick: function () { close(); } }, '关闭 ✕')
  ]);
  const modal = el('div', { class: 'modal' }, [header, body, actions]);
  const backdrop = el('div', { class: 'modal-backdrop' }, [modal]);
  backdrop.addEventListener('mousedown', function (event) {
    if (event.target === backdrop) close();
  });
  root.appendChild(backdrop);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    if (typeof options.onClose === 'function') options.onClose();
  }

  if (options.footer !== false) {
    (options.actions || []).forEach(function (item) {
      actions.appendChild(el('button', { class: item.class || '', onclick: function () { item.onClick(close); } },
        item.label));
    });
    actions.appendChild(el('button', { class: 'ghost', onclick: function () { close(); } }, options.closeLabel || '关闭'));
  }
  append(body, options.body);
  return { close: close, body: body, modal: modal };
}

export function openForm(title, fields, options) {
  const opts = options || {};
  return new Promise(function (resolve) {
    let settled = false;
    function finish(value) { if (settled) return; settled = true; resolve(value); }
    const inputs = {};
    const body = el('div', {}, []);

    fields.forEach(function (item) {
      let input;
      if (item.type === 'textarea') {
        input = el('textarea', { rows: item.rows || 4, placeholder: item.placeholder || '' });
        input.value = item.value || '';
      } else if (item.type === 'select') {
        input = el('select', {}, (item.options || []).map(function (option) {
          return el('option', { value: option.value }, option.label);
        }));
        input.value = item.value === undefined || item.value === null ? '' : String(item.value);
      } else if (item.type === 'checkbox') {
        input = el('input', { type: 'checkbox' });
        input.checked = !!item.value;
      } else {
        input = el('input', { type: item.type || 'text', placeholder: item.placeholder || '' });
        input.value = item.value === undefined || item.value === null ? '' : item.value;
      }
      inputs[item.name] = input;
      body.appendChild(field(item.label + (item.required ? ' *' : ''), input, item.hint));
    });

    showModal({
      title: title,
      body: body,
      actions: [{
        label: opts.submitLabel || '确定',
        class: 'primary',
        onClick: function (close) {
          const values = {};
          let missing = null;
          fields.forEach(function (item) {
            const input = inputs[item.name];
            if (item.type === 'checkbox') values[item.name] = input.checked;
            else if (item.type === 'number') values[item.name] = Number(input.value || 0);
            else values[item.name] = input.value;
            if (item.required && !values[item.name]) missing = item.label;
          });
          if (missing) { toast('请填写：' + missing, 'error'); return; }
          close();
          finish(values);
        }
      }],
      closeLabel: '取消',
      onClose: function () { finish(null); }
    });
    const first = body.querySelector('input, textarea, select');
    if (first) first.focus();
  });
}

export function confirmDialog(message, confirmLabel) {
  return new Promise(function (resolve) {
    let settled = false;
    function finish(value) { if (settled) return; settled = true; resolve(value); }
    showModal({
      title: '请确认',
      body: el('div', { class: 'notice' }, message),
      actions: [{
        label: confirmLabel || '确定',
        class: 'danger',
        onClick: function (close) { close(); finish(true); }
      }],
      closeLabel: '取消',
      onClose: function () { finish(false); }
    });
  });
}
