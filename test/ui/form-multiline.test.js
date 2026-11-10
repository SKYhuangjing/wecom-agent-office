import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldsFromSchema, serializeSchema, SchemaFields } from '../../plugins/ui-workbench/ui/form.js';

test('fieldsFromSchema preserves multiline strings and defaults', () => {
  const schema = [
    { key: 'prompt', label: '人设（多行）', type: 'string', multiline: true },
    { key: 'cwd', label: '工作目录', type: 'string', default: 'C:\\Users' },
  ];
  const initial = fieldsFromSchema(schema, { prompt: 'line1\nline2' });
  assert.equal(initial.prompt, 'line1\nline2');
  assert.equal(initial.cwd, 'C:\\Users');
});

test('serializeSchema round-trips multiline text without trimming newlines inside', () => {
  const schema = [
    { key: 'prompt', label: '人设', type: 'string', multiline: true },
  ];
  const multiline = '你是智能助手。\n第一条指令：不要自称 Claude。\n第二条指令：用中文。';
  const { values, errors } = serializeSchema(schema, { prompt: multiline });
  assert.equal(errors.length, 0);
  assert.equal(values.prompt, multiline);
});

test('SchemaFields renders textarea for prompt or multiline schema items', () => {
  let createdTag = '';
  let createdProps = null;
  const fakeH = (tag, props, ...children) => {
    if (tag === 'textarea' || tag === 'input') {
      createdTag = tag;
      createdProps = props;
    }
    return { tag, props, children };
  };

  const WAO = { h: fakeH };
  const schema = [
    { key: 'prompt', label: '人设（多行，--append-system-prompt）', type: 'string' },
  ];

  SchemaFields({ WAO, schema, state: { prompt: 'test' }, onChange: () => {} });
  assert.equal(createdTag, 'textarea', 'prompt should be rendered as textarea');
  assert.equal(createdProps.className, 'wb-textarea');
  assert.equal(createdProps.rows, 5);

  // Normal single-line field renders input
  const singleSchema = [
    { key: 'name', label: '名称', type: 'string' },
  ];
  SchemaFields({ WAO, schema: singleSchema, state: { name: 'abc' }, onChange: () => {} });
  assert.equal(createdTag, 'input', 'normal string field renders as input');
  assert.equal(createdProps.className, 'wb-input');
});

// —— 结构化对象编辑器（2026-11-10 UI 治理）：schema 带 fields 的 object 按子字段
// 渲染独立输入框（model 不再逼运营手写 JSON）。表单态仍是 JSON 文本——子输入框
// 编辑 parsed 对象一键后整体重序列化；空值子键省略。
test('SchemaFields: object with fields renders structured sub-inputs, edits round-trip via JSON state', () => {
  const inputs = []; // {props, onChangeHandler}
  const texts = [];
  const fakeH = (tag, props, ...children) => {
    if (tag === 'input' && String(props?.className ?? '').includes('wb-input')) inputs.push(props);
    if (tag === 'span' && String(props?.className ?? '').includes('wb-hint')) texts.push(children.join(''));
    return { tag, props, children };
  };
  const schema = [
    { key: 'model', label: '模型', type: 'object',
      hint: '网关三项留空走默认',
      fields: [
        { key: 'model', label: '模型名', type: 'string', placeholder: '如 workbuddy' },
        { key: 'apiKey', label: '网关密钥（可选）', type: 'password' },
      ] },
  ];
  const state = { model: JSON.stringify({ model: 'workbuddy' }) };
  let lastState = state;
  SchemaFields({ WAO: { h: fakeH }, schema, state, onChange: (s) => { lastState = s; } });

  // 渲染面：两个子输入框（模型名=文本、密钥=password），值从 JSON 解析
  assert.equal(inputs.length, 2, 'two structured sub-inputs');
  assert.equal(inputs[0].value, 'workbuddy');
  assert.equal(inputs[1].type, 'password');
  assert.ok(texts.some((t) => t.includes('留空走默认')), 'item.hint rendered');

  // 编辑回路：改模型名 → onChange 收到重序列化的 JSON（其余键保留）
  inputs[0].onChange({ target: { value: 'glm-5.3' } });
  assert.deepEqual(JSON.parse(lastState.model), { model: 'glm-5.3' }, 'rename round-trips, other keys preserved');

  // 补一个键：填密钥 → JSON 里出现 apiKey
  const state2 = { model: JSON.stringify({ model: 'glm-5.3' }) };
  let last2 = state2;
  SchemaFields({ WAO: { h: fakeH }, schema, state: state2, onChange: (s) => { last2 = s; } });
  inputs[inputs.length - 1].onChange({ target: { value: 'sk-1' } });
  assert.deepEqual(JSON.parse(last2.model), { model: 'glm-5.3', apiKey: 'sk-1' }, 'filling a sub-key adds it');

  // 清空唯一键 → 整个对象省略（空串=absent，serialize 不提交）
  const state3 = { model: JSON.stringify({ model: 'x' }) };
  let last3 = state3;
  inputs.length = 0; // 只看本次渲染的子输入框
  SchemaFields({ WAO: { h: fakeH }, schema, state: state3, onChange: (s) => { last3 = s; } });
  inputs[0].onChange({ target: { value: '' } }); // 清「模型名」（唯一有值的键）
  assert.equal(last3.model, '', 'clearing the only key empties the object');

  // 无 fields 的 object 仍是 JSON textarea（env 等通用对象不受影响）
  let sawTextarea = false;
  const fakeH2 = (tag, props) => { if (tag === 'textarea') sawTextarea = true; return { tag, props }; };
  SchemaFields({ WAO: { h: fakeH2 }, schema: [{ key: 'env', label: '环境变量', type: 'object' }], state: {}, onChange: () => {} });
  assert.ok(sawTextarea, 'plain object keeps the JSON textarea');
});

test('serializeSchema: structured object state (JSON text) still round-trips identically', () => {
  const schema = [
    { key: 'model', label: '模型', type: 'object', fields: [{ key: 'model', label: '模型名', type: 'string' }] },
  ];
  const { values, errors } = serializeSchema(schema, { model: '{\n  "model": "workbuddy"\n}' });
  assert.equal(errors.length, 0);
  assert.deepEqual(values.model, { model: 'workbuddy' }, 'wire shape unchanged — schema fields are display-only');
});
