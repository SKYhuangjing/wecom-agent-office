// No-build page entry (DESIGN §9), hosted by the kernel at /api/ui/<id>/ in
// M3. Browser-side contract (window.WAO — mount/update APIs provided by the
// workbench shell) is NOT final yet: component stays null so this module
// evaluates harmlessly today, and M3 defines the real component shape here.
// No bundler, no framework import — plain ES Modules only.
export const id = 'template-page';
export const title = '模板页';
export const icon = '▤';
export const order = 50;
export const component = null;
