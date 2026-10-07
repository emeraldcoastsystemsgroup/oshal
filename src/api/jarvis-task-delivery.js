/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Announce saved replies only and bound durable receipts, deduplicating pending work and retrying failures on a later shelf poll.
 */
(function attachTaskDelivery(root) {
  'use strict';

  function hasReply(task) {
    return task.status === 'done' && typeof task.result === 'string' && task.result.trim().length > 0;
  }

  function create(onDelivered) {
    const states = new Map();
    const waiting = [];
    let active = 0;

    async function send(id) {
      try {
        const response = await fetch('/api/jarvis/tasks/' + encodeURIComponent(id) + '/delivered', {
          method: 'POST', credentials: 'include', signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('Delivery receipt unavailable');
        states.set(id, 'delivered');
        onDelivered(id);
      } catch (_) {
        states.set(id, 'failed');
      } finally {
        active -= 1;
        drain();
      }
    }

    function drain() {
      while (active < 3 && waiting.length) {
        active += 1;
        void send(waiting.shift());
      }
    }

    function enqueue(id) {
      if (states.has(id) && states.get(id) !== 'failed') return;
      states.set(id, 'pending');
      waiting.push(id);
      drain();
    }

    function shouldAnnounce(task) {
      if (task.delivered || !hasReply(task)) return false;
      const previous = states.get(task.id);
      if (previous === 'failed') enqueue(task.id);
      return previous === undefined;
    }

    return { enqueue, shouldAnnounce };
  }

  root.JarvisTaskDelivery = { create, hasReply };
})(window);
