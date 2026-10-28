// Mirror Gitcha project tasks into NextTime-Dev (the Nextcloud "timebank" app,
// inputloop/NextTime-Dev, maintained by its partner). We only call its
// existing JSON API; nothing in that repository is changed.
//
//   create  POST /index.php/apps/timebank/api/requests
//           { title (5-200 chars), description (20+), categoryId, hoursBudget (0-1000], priority }
//   cancel  POST /index.php/apps/timebank/api/requests/{id}/cancel
//
// Completion is NOT mirrored: completing a NextTime request moves hours in its
// public ledger, which is a decision for NextTime's maintainer and the keepers.
// Auth is a Nextcloud app password over HTTP Basic, with OCS-APIRequest: true
// (required by Nextcloud 30+ for state-changing calls).
export class NextTimeClient {
  constructor({ url, user, appPassword, categoryId, hoursBudget = 1, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { user, appPassword, categoryId, hoursBudget, fetchImpl });
    this.base = url ? `${url.replace(/\/$/, '')}/index.php/apps/timebank/api` : null;
  }

  get configured() { return Boolean(this.base && this.user && this.appPassword && this.categoryId); }

  async call(method, path, body) {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.user}:${this.appPassword}`).toString('base64')}`,
        'OCS-APIRequest': 'true', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ?? j.message ?? `NextTime answered ${res.status}`);
    return j;
  }

  async createRequest(task, projectKey) {
    const title = `[${projectKey}] ${task.title}`.slice(0, 200).padEnd(5, '.');
    const description = `${task.body || task.title}\n\nGitcha task ${task.id}: ${task.url}`.padEnd(20, '.');
    const r = await this.call('POST', '/requests', { title, description, categoryId: this.categoryId, hoursBudget: this.hoursBudget, priority: 'normal' });
    return r.id ?? r.request?.id ?? null;
  }

  cancel(id) { return this.call('POST', `/requests/${Number(id)}/cancel`); }
}
