// Fake requester and executor; both record what the node asked of them, in order.

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');

export function forgeRequest(method, path, body = null) {
  return {
    host: 'api.github.com', method, path, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? b64(body) : '',
  };
}

/// A task may reach what lies under its own item. `unsent` holds the path of each allowed
/// request it was told got no answer; `refuse(part, reason)` refuses every path holding
/// `part`; `broken` makes the forge unreachable.
export function fakeRequester({ kinds = ['review', 'fix'] } = {}) {
  const refusals = [];
  return {
    calls: [],
    unsent: [],
    broken: false,
    rulesAsked: 0,
    refuse: (part, reason) => refusals.push({ part, reason }),
    rulesFor({ forge, kind, item, identity }) {
      this.rulesAsked += 1;
      if (!kinds.includes(kind)) return null;
      return [{ host: 'api.github.com', method: 'GET', path: `/repos/o/r/${item}/**`, as: identity, forge }];
    },
    context: ({ pool, task, state, claim }) => ({ pool, task, state, claim }),
    authorize(rules, request, context) {
      context.state.asked = (context.state.asked ?? 0) + 1;
      const refusal = refusals.find((r) => request.path.includes(r.part));
      const rule = rules.find((r) => r.host === request.host && request.path.startsWith(r.path.replace('**', '')));
      this.calls.push({ op: 'authorize', path: request.path, asked: context.state.asked, rules: rules.length, task: context.task.taskId });
      if (refusal) return { ok: false, reason: refusal.reason };
      if (!rule) return { ok: false, reason: 'no rule covers this request' };
      return { ok: true, request: { ...request, headers: { ...request.headers, authorization: rule.as } } };
    },
    conclude(request) {
      this.unsent.push(request.path);
    },
    async perform(request, { forge, host }) {
      this.calls.push({ op: 'perform', path: request.path, forge, host, as: request.headers.authorization ?? null });
      if (this.broken) throw new Error('the forge is down');
      return { status: 200, headers: { 'Content-Type': 'application/json', 'x-count': 7 }, body: b64({ did: request.path }) };
    },
  };
}

/// Jobs run until the test ends them: `end(runId, outcome)` reports an outcome,
/// `die(runId)` makes a job vanish without a word.
export function fakeExecutor() {
  let report = () => {};
  const jobs = new Map();
  return {
    jobs,
    started: [],
    stopped: [],
    takes: () => true,
    failStart: false,
    wouldTake(task) {
      return this.takes(task);
    },
    start(args) {
      if (this.failStart) throw Object.assign(new Error('no docker'), this.failStart === 'local' ? { name: 'OwnFault' } : {});
      this.started.push(args);
      jobs.set(args.runId, { args, alive: true });
      return { container: `box-${args.runId}` };
    },
    stop(runId, reason) {
      this.stopped.push({ runId, reason });
      if (jobs.has(runId)) jobs.get(runId).alive = false;
    },
    alive: (runId) => jobs.get(runId)?.alive === true,
    onEnd(fn) {
      report = fn;
    },
    end(runId, outcome = {}) {
      jobs.get(runId).alive = false;
      const ok = outcome.ok !== false;
      report(runId, {
        ok, summary: ok ? 'all done' : 'it broke', usd: 0.25, tokens: 1200, runner: 'claude', model: 'fable', exit: ok ? 0 : 1,
        state: ok ? 'finished' : 'failed', ...outcome,
      });
    },
    die(runId) {
      jobs.get(runId).alive = false;
    },
    jobOf(taskId) {
      return [...jobs.values()].find((job) => job.alive && job.args.task.taskId === taskId)?.args;
    },
  };
}
