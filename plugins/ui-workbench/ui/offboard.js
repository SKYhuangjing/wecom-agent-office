// 离职面谈 (company-metaphor redesign P2): 删除一位同事前的确认层——后果清单
// （工作档案保留 / 物化配置将清理 / 可随时重新入职）逐条讲清，输入「姓名」
// 才能办结（误输即禁用），办结后 toast 送别。DELETE /api/bots/:id。
import { providerMeta, Avatar, ensurePageStyle } from './hr.js';

export const Offboard = ({ WAO, bot, onClose, onDone }) => {
  const { h, useState } = WAO;
  ensurePageStyle();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(null);
  const meta = providerMeta(bot.provider);

  const confirm = async () => {
    setBusy(true);
    setErrors(null);
    try {
      await WAO.api(`/api/bots/${encodeURIComponent(bot.id)}`, undefined, { method: 'DELETE' });
      onDone(bot);
    } catch (err) {
      setErrors(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const matched = text.trim() === (bot.name ?? '');
  const head = h('div', { className: 'wb-offboard-head' },
    h(Avatar, { WAO, seed: bot.id, size: 44, ring: meta.color, mood: 'sleep' }),
    h('div', null,
      h('h3', null, `确认删除：${bot.name ?? bot.id}`),
      h('p', { className: 'wb-hint' }, `${meta.label} · 机器人 ID `, h('span', { className: 'wb-mono' }, bot.id))));
  const list = h('ul', { className: 'wb-offboard-list' },
    h('li', null, h('b', null, '会话历史完整保留'), '——台账与原生会话文件不会删除，随时可回看。'),
    h('li', null, h('b', null, '物化配置将被清理'), '——provider 落在磁盘上的配置（如 dsh profile）会一并移除。'),
    h('li', null, h('b', null, '随时可以重新创建'), '——用同一机器人 ID 再创建一次即可，还是那副老面孔。'),
    h('li', { className: 'wb-field-error' }, '此操作不可撤销。'));
  const confirmField = h('div', { className: 'wb-field' },
    h('label', null, `输入它的姓名「${bot.name ?? bot.id}」确认`),
    h('input', {
      className: 'wb-input', value: text, placeholder: bot.name ?? bot.id,
      onChange: (e) => setText(e.target.value),
    }));
  const actions = h('div', { className: 'wb-toolbar' },
    h('button', {
      className: 'wb-btn wb-btn-danger', disabled: busy || !matched, onClick: () => void confirm(),
      title: matched ? undefined : '名称不一致——为防误删，按钮保持禁用',
    }, busy ? '删除中…' : '确认删除'),
    h('button', { className: 'wb-btn', disabled: busy, onClick: onClose }, '再想想'));

  return h('div', { className: 'wb-modal-wrap', onClick: () => { if (!busy) onClose(); } },
    h('div', { className: 'wb-modal wb-offboard', onClick: (e) => e.stopPropagation() },
      head,
      h('p', { className: 'wb-hint' }, '删除前，请确认你了解以下事项：'),
      list,
      confirmField,
      errors != null ? h('div', { className: 'wb-error-box' }, `删除失败：${errors}`) : null,
      actions));
};

export default Offboard;
