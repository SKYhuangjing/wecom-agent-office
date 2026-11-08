// 迷你 Markdown 渲染（会话历史用，走查 L16）：bot 回复是 Markdown 源文本，
// 原样平铺阅读噪音大（**、##、| 表格 | 全裸奔）。这里只做行级结构（标题/
// 列表/表格/围栏代码块）+ 行内 **粗体** 与 `代码`，全部走 vdom 文本节点
// （框架自转义、无 innerHTML，XSS 免疫）；不认识的语法照原文显示——不求
// 完整 CommonMark，只求去掉最大的阅读噪音。

// 行内 **bold** / `code` 切分；无匹配整段原文。返回数组（调用方展开为
// children，不用数组直传避免 key 警告）。
const inline = (h, text) => {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (let m = re.exec(text); m != null; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(h('strong', null, tok.slice(2, -2)));
    else out.push(h('code', { className: 'wb-mono' }, tok.slice(1, -1)));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

// | a | b | 与 |---|---|（分隔行：只含 :、-、空格和竖线）
const isTableSep = (line) => /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-');
const rowCells = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());

export const MdText = ({ h, text }) => {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }
    // 围栏代码块：``` 开到 ``` 收（未闭合则到末尾，内容不丢）
    if (line.trim().startsWith('```')) {
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(h('pre', { key: out.length, className: 'wb-md-code' }, buf.join('\n')));
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm != null) {
      out.push(h('div', { key: out.length, className: `wb-md-h wb-md-h${hm[1].length}` }, ...inline(h, hm[2])));
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, '')); i += 1; }
      out.push(h('ul', { key: out.length, className: 'wb-md-list' },
        ...items.map((it, k) => h('li', { key: k }, ...inline(h, it)))));
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = rowCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(rowCells(lines[i]));
        i += 1;
      }
      out.push(h('table', { key: out.length, className: 'wb-table wb-md-table' },
        h('thead', null, h('tr', null, ...head.map((c, k) => h('th', { key: k }, ...inline(h, c))))),
        h('tbody', null, ...rows.map((r, rk) => h('tr', { key: rk }, ...r.map((c, k) => h('td', { key: k }, ...inline(h, c))))))));
      continue;
    }
    out.push(h('div', { key: out.length, className: 'wb-md-p' }, ...inline(h, line)));
    i += 1;
  }
  return h('div', { className: 'wb-md' }, out);
};

export default { MdText };
