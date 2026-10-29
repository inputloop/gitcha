// SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors
// SPDX-License-Identifier: GPL-3.0-or-later OR LGPL-3.0-or-later
// Who is calling. We call the caller a "principal". It is either a person
// (signed in with a device token, a console key or the web session) or an
// agent (using an agent key, or an SSH key registered to that agent). This
// file turns a bearer token or an SSH key fingerprint into a principal.
/** A short text name for a principal, like "user:alice" or "agent:alfred" ("anonymous" when nobody is signed in). Votes, media limits and task records use it. */
export function principalKey(p) {
  if (!p) return 'anonymous';
  return p.kind === 'agent' ? `agent:${p.agent.handle}` : `user:${p.user.username}`;
}

/** Builds the functions the HTTP, GraphQL and git code use to find out who is calling. */
export function makePrincipals({ auth, keys, agents, store, config }) {
  return {
    /**
     * Finds who a bearer token belongs to. An agent key (`gak_...`) is only for the
     * paid sandboxes. It works only for a caller (a "door") that passes
     * `{ purpose: 'sandbox' }`. GraphQL, media and git pass no purpose, so they
     * never accept one. Any other token is checked by auth.authenticate.
     * An agent whose owner is missing or not active gets null.
     */
    fromToken(token, ip, { purpose } = {}) {
      if (!token) return null;
      const k = keys.agentForKey(token, purpose);
      if (k) {
        const agent = store.data.agents[k.agent];
        const owner = store.userById(k.owner);
        if (!agent || !owner || owner.status !== 'active') return null;
        return { kind: 'agent', agent, owner, via: 'agent_key' };
      }
      if (token.startsWith('gak_')) return null;
      const a = auth.authenticate(token, ip);
      return a ? { kind: 'user', user: a.user, auth: a } : null;
    },
    /** Finds who an SSH key belongs to: the person, or the agent it was registered for. Notes when the key was last used. Null when the owner is not active. */
    fromSsh(fingerprint) {
      const r = keys.sshByFingerprint(fingerprint);
      if (!r) return null;
      r.lastUsed = Date.now();
      const owner = store.userById(r.owner);
      if (!owner || owner.status !== 'active') return null;
      if (r.holder.kind === 'agent') {
        const agent = store.data.agents[r.holder.name];
        return agent ? { kind: 'agent', agent, owner, via: 'ssh' } : null;
      }
      return { kind: 'user', user: owner, via: 'ssh' };
    },
    /** The authorized_keys line for this fingerprint (see KeyService.authorizedKeys). */
    keysLine(fingerprint) { return keys.authorizedKeys(fingerprint, config.git.shellPath); },
    agents,
  };
}
