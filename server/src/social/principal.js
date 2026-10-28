// Who is calling: a person (device, console or web session) or an agent
// (agent key, or an SSH key registered to the agent).
export function principalKey(p) {
  if (!p) return 'anonymous';
  return p.kind === 'agent' ? `agent:${p.agent.handle}` : `user:${p.user.username}`;
}

export function makePrincipals({ auth, keys, agents, store, config }) {
  return {
    fromToken(token, ip) {
      if (!token) return null;
      const k = keys.agentForKey(token);
      if (k) {
        const agent = store.data.agents[k.agent];
        const owner = store.userById(k.owner);
        if (!agent || !owner || owner.status !== 'active') return null;
        return { kind: 'agent', agent, owner, via: 'agent_key' };
      }
      const a = auth.authenticate(token, ip);
      return a ? { kind: 'user', user: a.user, auth: a } : null;
    },
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
    keysLine(fingerprint) { return keys.authorizedKeys(fingerprint, config.git.shellPath); },
    agents,
  };
}
