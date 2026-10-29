// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Copies ("mirrors") Gitcha project tasks into NextTime-Dev (the Nextcloud
// "timebank" app, inputloop/NextTime-Dev, kept by its partner). We only call
// its existing JSON API. Nothing in that repository is changed. The app makes
// one client at start-up, and TaskService (tasks.js) calls it.
//
// The three calls we make:
//   create  POST /index.php/apps/timebank/api/requests
//           { title (5-200 chars), description (20+), categoryId, hoursBudget (0-1000], priority }
//   cancel    POST /index.php/apps/timebank/api/requests/{id}/cancel
//   complete  POST /index.php/apps/timebank/api/requests/{id}/complete
//
// When a task is closed as done, Gitcha also marks its request complete,
// unless NEXTTIME_COMPLETE=no. (The keepers' word, 2026-10-28: a toggle, on by
// default.) NextTime completes a request only after its requester accepted a
// volunteer. It then credits those volunteers' hours in its public ledger.
// When NextTime refuses, Gitcha keeps the reason on the task, and the task
// still closes.
// To sign in we send a Nextcloud app password with HTTP Basic auth (the user
// name and password in a header). We also send OCS-APIRequest: true, which
// Nextcloud 30 and later require for any call that changes data.
export class NextTimeClient {
  constructor({ url, user, appPassword, categoryId, hoursBudget = 1, complete = true, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { user, appPassword, categoryId, hoursBudget, completeOnDone: complete !== false, fetchImpl });
    this.base = url ? `${url.replace(/\/$/, '')}/index.php/apps/timebank/api` : null;
  }

  /** True when the URL, user, app password and category are all set. Without them nothing is mirrored. */
  get configured() { return Boolean(this.base && this.user && this.appPassword && this.categoryId); }

  /** Sends one JSON request to the timebank API. Throws NextTime's own error text when the answer is not OK. */
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

  /**
   * Creates a NextTime request for a task and returns its id (or null). The title is cut
   * to 200 characters. The title and description are padded with dots to reach NextTime's
   * minimum lengths (5 and 20 characters).
   */
  async createRequest(task, projectKey) {
    const title = `[${projectKey}] ${task.title}`.slice(0, 200).padEnd(5, '.');
    const description = `${task.body || task.title}\n\nGitcha task ${task.id}: ${task.url}`.padEnd(20, '.');
    const r = await this.call('POST', '/requests', { title, description, categoryId: this.categoryId, hoursBudget: this.hoursBudget, priority: 'normal' });
    return r.id ?? r.request?.id ?? null;
  }

  /** Cancels a request. `Number(id)` keeps anything but a number out of the URL path. */
  cancel(id) { return this.call('POST', `/requests/${Number(id)}/cancel`); }

  /** Marks a request complete. NextTime may refuse (see the top of this file). */
  complete(id) { return this.call('POST', `/requests/${Number(id)}/complete`); }
}
