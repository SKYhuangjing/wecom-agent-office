// Kernel event bus: the failure-isolation boundary for plugin callbacks (spec §2.1).
// A throwing subscriber is caught, attributed to its registering plugin, and skipped,
// so one broken plugin can never take down dispatch for the others — emit never throws.
export function createEventBus({ log }) {
  const topics = new Map(); // topic -> [{ fn, owner }]
  return {
    on(topic, fn, owner) {
      const entry = { fn, owner };
      if (!topics.has(topic)) topics.set(topic, []);
      topics.get(topic).push(entry); // push preserves registration order = dispatch order
      return () => {
        const list = topics.get(topic);
        if (!list) return;
        const i = list.indexOf(entry); // identity match: duplicate registrations each remove only their own
        if (i !== -1) list.splice(i, 1);
        if (list.length === 0) topics.delete(topic); // dead topics must not accumulate in the Map
      };
    },
    emit(topic, payload) {
      const list = topics.get(topic);
      if (!list) return; // no subscribers is a normal state, not an error
      // Snapshot: a subscriber calling on/off mid-emit must not mutate the loop below.
      // The result is inspected, not discarded: an async subscriber rejects on a
      // later tick, outside this loop's sync catch — uncaught it becomes an
      // unhandled rejection and kills the process, so the thenable gets the
      // same attributed catch a sync throw gets.
      for (const { fn, owner } of [...list]) {
        try {
          const result = fn(payload);
          if (result && typeof result.catch === 'function') {
            result.catch((err) => log.error(`events: ${owner} handler failed`, topic, err));
          }
        } catch (err) {
          log.error(`events: ${owner} handler failed`, topic, err);
        }
      }
    },
  };
}
