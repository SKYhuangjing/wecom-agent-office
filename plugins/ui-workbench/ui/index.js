// Page aggregation entry (kernel hosts this at /api/ui/ui-workbench/index.js;
// the shell dynamic-imports it). The shell auto-registers ONLY this module's
// default export under the plugin entry, so sibling pages register through
// the shared WAO collector at import time — window.WAO is contractually
// mounted before any page import (shell and harness both honor it), and the
// optional chaining keeps a bare Node import (loader manifest discovery)
// side-effect free. Later tasks append pages to PAGES; nothing else changes.
import list from './list.js';
import bots from './bots.js';
import session from './session.js';
import push from './push.js';
import plugins from './plugins.js';
import timeline from './timeline.js';

const PAGES = [list, bots, session, push, plugins, timeline];

for (const page of PAGES) globalThis.WAO?.registerPage?.(page);

// Default = the first page: the shell's own registerPage({...mod.default, id})
// lands on the same registry key ('workbench'), so no duplicate nav entry.
export default list;
