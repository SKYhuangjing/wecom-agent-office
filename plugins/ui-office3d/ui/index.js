// Page aggregation entry (kernel hosts this at /api/ui/ui-office3d/index.js;
// the shell dynamic-imports it and takes the default export as the page).
// window.WAO is contractually mounted before any page import (shell and
// harness both honor it); the optional chaining keeps a bare Node import
// (loader manifest discovery) side-effect free.
import office from './office.js';

globalThis.WAO?.registerPage?.(office);

export default office;
