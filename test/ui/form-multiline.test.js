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
