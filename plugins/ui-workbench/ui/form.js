// Schema-driven form kit (M3 T2) for PLUGIN-DEV §8 schema items:
//   { key, label, type: string|password|enum|bool|list|object, required?, default?, options? }
// The same schema drives three things: initial form state (fieldsFromSchema),
// rendering (SchemaFields), and submission (serializeSchema → {values, errors}).
// Form-state conventions: text-ish types (string/password/enum/list/object)
// live as strings (list = newline-joined, object = JSON text), bool as real
// booleans — textareas need strings and JSON needs round-tripping anyway.

const jsonOf = (value, pretty = true) => {
  try { return JSON.stringify(value, null, pretty ? 2 : 0) ?? ''; } catch { return ''; }
};

// Initial form state for a schema block. `values` is the loaded (sanitized)
// record block — absent password keys stay '' and the server's
// keep-blank-password rule preserves the stored secret on PATCH.
export function fieldsFromSchema(schema, values = {}) {
  const state = {};
  for (const item of Array.isArray(schema) ? schema : []) {
    if (item == null || typeof item.key !== 'string') continue;
    const v = values?.[item.key];
    switch (item.type) {
      case 'bool':
        state[item.key] = typeof v === 'boolean' ? v : Boolean(item.default ?? false);
        break;
      case 'list':
        state[item.key] = Array.isArray(v) ? v.join('\n')
          : (Array.isArray(item.default) ? item.default.join('\n') : '');
        break;
      case 'object':
        state[item.key] = v != null && typeof v === 'object' ? jsonOf(v)
          : (item.default != null ? jsonOf(item.default) : '');
        break;
      default: // string / password / enum / untyped
        state[item.key] = v != null ? String(v) : (item.default != null ? String(item.default) : '');
    }
  }
  return state;
}

// One field per schema item. `editingExisting` switches the password hint to
// the keep-blank copy (the loaded block has no secret to show — by design).
export function SchemaFields({ WAO, schema, state, onChange, editingExisting }) {
  const { h } = WAO;
  return h('div', { className: 'wb-form' },
    (Array.isArray(schema) ? schema : []).map((item) => {
      if (item == null || typeof item.key !== 'string') return null;
      const key = item.key;
      const label = item.label ?? key;
      const value = state?.[key] ?? '';
      const set = (v) => onChange({ ...state, [key]: v });
      const labelEl = h('label', null, label, item.required === true ? h('span', { className: 'wb-req' }, ' *') : null);

      let control;
      let hint = null;
      switch (item.type) {
        case 'bool':
          control = h('div', { className: 'wb-check' },
            h('input', {
              type: 'checkbox', checked: value === true,
              onChange: (e) => set(e.target.checked),
            }),
            h('span', null, value === true ? '已开启' : '已关闭'),
          );
          break;
        case 'enum': {
          const options = Array.isArray(item.options) ? item.options : [];
          control = h('select', { className: 'wb-select', value, onChange: (e) => set(e.target.value) },
            h('option', { value: '' }, '（未设置）'),
            options.map((opt) => h('option', { key: String(opt), value: String(opt) }, String(opt))),
          );
          break;
        }
        case 'list':
          control = h('textarea', {
            className: 'wb-textarea', rows: 3, value, placeholder: '每行一项',
            onChange: (e) => set(e.target.value),
          });
          break;
        case 'object': {
          const parsed = parseJsonObject(value);
          control = h('textarea', {
            className: 'wb-textarea', rows: 4, value, placeholder: '{\n  "key": "value"\n}',
            onChange: (e) => set(e.target.value),
          });
          if (value.trim() !== '' && parsed.error != null) {
            hint = h('span', { className: 'wb-field-error' }, `JSON 解析失败：${parsed.error}（修正后才能保存）`);
          }
          break;
        }
        case 'password':
          control = h('input', {
            type: 'password', className: 'wb-input', value,
            autoComplete: 'new-password',
            placeholder: editingExisting ? '不回显——留空保持不变' : '输入密码',
            onChange: (e) => set(e.target.value),
          });
          break;
        default: // string / untyped
          control = h('input', {
            type: 'text', className: 'wb-input', value,
            onChange: (e) => set(e.target.value),
          });
      }
      return h('div', { key, className: 'wb-field' }, labelEl, control,
        hint ?? (item.type === 'password' && editingExisting
          ? h('span', { className: 'wb-hint' }, '安全起见不再显示已保存的密码；仅在需要更换时填写')
          : null));
    }));
}

const parseJsonObject = (text) => {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return { value: undefined, error: null };
  try {
    const value = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { value: null, error: '需要 JSON 对象（{}），不是数组或 null' };
    }
    return { value, error: null };
  } catch (err) {
    return { value: null, error: err?.message ?? String(err) };
  }
};

// Form state → the block to submit. Empty optional fields are OMITTED (never
// silently blanked); invalid JSON is an error that blocks the whole save.
export function serializeSchema(schema, state) {
  const values = {};
  const errors = [];
  for (const item of Array.isArray(schema) ? schema : []) {
    if (item == null || typeof item.key !== 'string') continue;
    const key = item.key;
    const raw = state?.[key];
    const label = item.label ?? key;
    switch (item.type) {
      case 'bool':
        values[key] = raw === true;
        break;
      case 'list': {
        const lines = String(raw ?? '').split('\n').map((s) => s.trim()).filter((s) => s !== '');
        if (lines.length > 0) values[key] = lines;
        break;
      }
      case 'object': {
        const trimmed = String(raw ?? '').trim();
        if (trimmed === '') break; // absent
        const parsed = parseJsonObject(trimmed);
        if (parsed.error != null) { errors.push(`${label}：JSON 解析失败 —— ${parsed.error}`); break; }
        values[key] = parsed.value;
        break;
      }
      default: { // string / password / enum
        const text = raw ?? '';
        if (text !== '') values[key] = text;
        break;
      }
    }
  }
  return { values, errors };
}
